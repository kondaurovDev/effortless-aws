import { Command, Options } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";

import {
  Aws,
  getAllResourcesByTags,
  groupResourcesByHandler,
  listEffortlessRoles,
  listLayerVersions,
  deleteAllLayerVersions,
  deleteRole
} from "../../aws";
import { deleteResources, type ResourceInfo } from "~/deploy/cleanup";
import { loadConfig, projectOption, stageOption, regionOption, verboseOption, dryRunOption } from "~/cli/config";
import { c } from "~/cli/colors";

const handlerOption = Options.text("handler").pipe(
  Options.withAlias("h"),
  Options.withDescription("Handler name to delete (deletes all if not specified)"),
  Options.optional
);

const cleanupAllOption = Options.boolean("all").pipe(
  Options.withDescription("Delete all resources (required without --handler)")
);

const layerOption = Options.boolean("layer").pipe(
  Options.withDescription("Clean up Lambda layer versions instead of handler resources")
);

const rolesOption = Options.boolean("roles").pipe(
  Options.withDescription("Clean up orphaned IAM roles instead of handler resources")
);

export const cleanupCommand = Command.make(
  "cleanup",
  { project: projectOption, stage: stageOption, region: regionOption, handler: handlerOption, layer: layerOption, roles: rolesOption, all: cleanupAllOption, dryRun: dryRunOption, verbose: verboseOption },
  ({ project: projectOpt, stage, region, handler: handlerOpt, layer: cleanupLayer, roles: cleanupRoles, all: deleteAll, dryRun, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);

      const project = Option.getOrElse(projectOpt, () => config?.name ?? "");
      const finalStage = config?.stage ?? stage;
      const finalRegion = config?.region ?? region;

      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return;
      }

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;

      if (cleanupLayer) {
        yield* cleanupLayerVersions({ project, region: finalRegion, deleteAll, dryRun }).pipe(
          Effect.provide(Aws.makeClients({ lambda: { region: finalRegion } })),
          Logger.withMinimumLogLevel(logLevel)
        );
        return;
      }

      if (cleanupRoles) {
        yield* cleanupIamRoles({ project, stage: finalStage, region: finalRegion, deleteAll, dryRun }).pipe(
          Effect.provide(Aws.makeClients({ iam: { region: finalRegion } })),
          Logger.withMinimumLogLevel(logLevel)
        );
        return;
      }

      const handlerFilter = Option.getOrUndefined(handlerOpt);

      const clientsLayer = Aws.makeClients({
        lambda: { region: finalRegion },
        iam: { region: finalRegion },
        apigatewayv2: { region: finalRegion },
        dynamodb: { region: finalRegion },
        resource_groups_tagging_api: { region: finalRegion },
        s3: { region: finalRegion },
        cloudfront: { region: "us-east-1" },
      });

      yield* Effect.gen(function* () {
        yield* Console.log(`\nLooking for resources in ${c.bold(project + "/" + finalStage)}...\n`);

        const resources = yield* getAllResourcesByTags(project, finalStage, finalRegion);

        if (resources.length === 0) {
          yield* Console.log("No resources found.");
          return;
        }

        const byHandler = groupResourcesByHandler(resources);

        const handlersToDelete = handlerFilter
          ? [[handlerFilter, byHandler.get(handlerFilter) ?? []] as const]
          : Array.from(byHandler.entries());

        if (handlerFilter && !byHandler.has(handlerFilter)) {
          yield* Console.error(`Handler "${handlerFilter}" not found.`);
          yield* Console.log("\nAvailable handlers:");
          for (const [h] of byHandler) {
            yield* Console.log(`  - ${h}`);
          }
          return;
        }

        const resourcesToDelete: ResourceInfo[] = [];
        const derivedRoles: string[] = [];

        for (const [handler, handlerResources] of handlersToDelete) {
          yield* Console.log(`${c.bold(handler)}:`);
          for (const resource of handlerResources) {
            const typeTag = resource.Tags?.find(t => t.Key === "effortless:type");
            const type = typeTag?.Value ?? "unknown";
            yield* Console.log(`  ${c.cyan(`[${type}]`)} ${c.dim(resource.ResourceARN ?? "")}`);
            resourcesToDelete.push({ arn: resource.ResourceARN!, type });

            if (type === "lambda") {
              const functionName = resource.ResourceARN!.split(":").pop()!;
              const roleName = `${functionName}-role`;
              if (!derivedRoles.includes(roleName)) {
                derivedRoles.push(roleName);
              }
            }
          }
          for (const roleName of derivedRoles.filter(r => r.includes(`-${handler}-`))) {
            yield* Console.log(`  ${c.cyan("[iam-role]")} ${c.dim(roleName)} (derived)`);
          }
        }

        const totalResources = resourcesToDelete.length + derivedRoles.length;
        yield* Console.log(`\nTotal: ${totalResources} resource(s) (${derivedRoles.length} derived)`);

        if (dryRun) {
          yield* Console.log(`\n${c.yellow("[DRY RUN]")} No resources were deleted.`);
          return;
        }

        if (!handlerFilter && !deleteAll) {
          yield* Console.log("\nTo delete these resources, use one of:");
          yield* Console.log(`  ${c.dim("eff cleanup --all")}                    # Delete all resources`);
          yield* Console.log(`  ${c.dim("eff cleanup --handler <name>")}         # Delete specific handler`);
          yield* Console.log(`  ${c.dim("eff cleanup --dry-run")}                # Preview without deleting`);
          return;
        }

        yield* Console.log(c.red("\nDeleting resources..."));
        yield* deleteResources(resourcesToDelete);
        yield* Console.log(c.green("\nDone!"));
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Delete deployed resources"));

const cleanupLayerVersions = (input: { project: string; region: string; deleteAll: boolean; dryRun: boolean }) =>
  Effect.gen(function* () {
    const layerName = `${input.project}-deps`;

    yield* Console.log(`\nSearching for layer versions: ${layerName}\n`);

    const versions = yield* listLayerVersions(layerName);

    if (versions.length === 0) {
      yield* Console.log("No layer versions found.");
      return;
    }

    yield* Console.log(`Found ${versions.length} version(s):\n`);

    for (const v of versions) {
      const hash = v.description?.match(/hash:([a-f0-9]+)/)?.[1] ?? "unknown";
      yield* Console.log(`  v${v.version} (hash: ${hash}) - ${v.createdDate ?? "unknown date"}`);
    }

    if (input.dryRun) {
      yield* Console.log(`\n${c.yellow("[DRY RUN]")} No layers were deleted.`);
      return;
    }

    if (!input.deleteAll) {
      yield* Console.log("\nTo delete these layers, use:");
      yield* Console.log(`  ${c.dim("eff cleanup --layer --all")}        # Delete all versions`);
      yield* Console.log(`  ${c.dim("eff cleanup --layer --dry-run")}    # Preview without deleting`);
      return;
    }

    yield* Console.log(c.red("\nDeleting layer versions..."));
    const deleted = yield* deleteAllLayerVersions(layerName);
    yield* Console.log(c.green(`\nDeleted ${deleted} layer version(s).`));
  });

const cleanupIamRoles = (input: { project: string; stage: string; region: string; deleteAll: boolean; dryRun: boolean }) =>
  Effect.gen(function* () {
    yield* Console.log("\nSearching for effortless IAM roles...\n");

    const allRoles = yield* listEffortlessRoles();

    if (allRoles.length === 0) {
      yield* Console.log("No effortless IAM roles found.");
      return;
    }

    const roles = allRoles.filter(role => {
      if (input.project && role.project !== input.project) return false;
      if (input.stage !== "dev" && role.stage !== input.stage) return false;
      return true;
    });

    if (roles.length === 0) {
      yield* Console.log(`No IAM roles found for ${input.project}/${input.stage}.`);
      yield* Console.log(`\nAll effortless roles (${allRoles.length}):`);
      for (const role of allRoles) {
        yield* Console.log(`  - ${role.name} (${role.project ?? "untagged"}/${role.stage ?? "untagged"})`);
      }
      return;
    }

    yield* Console.log(`Found ${roles.length} IAM role(s):\n`);

    const byProject = new Map<string, typeof roles>();
    for (const role of roles) {
      const key = `${role.project ?? "untagged"}/${role.stage ?? "untagged"}`;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(role);
    }

    for (const [key, projectRoles] of byProject) {
      yield* Console.log(`${key}:`);
      for (const role of projectRoles) {
        yield* Console.log(`  - ${role.name}`);
      }
    }

    if (input.dryRun) {
      yield* Console.log(`\n${c.yellow("[DRY RUN]")} No roles were deleted.`);
      return;
    }

    if (!input.deleteAll) {
      yield* Console.log("\nTo delete these roles, use:");
      yield* Console.log(`  ${c.dim("eff cleanup --roles --all")}        # Delete all found roles`);
      yield* Console.log(`  ${c.dim("eff cleanup --roles --dry-run")}    # Preview without deleting`);
      return;
    }

    yield* Console.log(c.red("\nDeleting roles..."));
    for (const role of roles) {
      yield* deleteRole(role.name).pipe(
        Effect.catchAll(error =>
          Effect.logError(`Failed to delete ${role.name}: ${error}`)
        )
      );
    }
    yield* Console.log(c.green("\nDone!"));
  });
