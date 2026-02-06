import { Command, Options } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";

import {
  getResourcesByTags,
  groupResourcesByHandler,
  listEffortlessRoles,
  deleteRole,
  makeClients
} from "@effect-ak/effortless-aws";
import { deleteResources, type ResourceInfo } from "../../deploy/cleanup";
import { loadConfig, projectOption, stageOption, regionOption, verboseOption, dryRunOption } from "../config";

const handlerOption = Options.text("handler").pipe(
  Options.withAlias("h"),
  Options.withDescription("Handler name to delete (deletes all if not specified)"),
  Options.optional
);

const cleanupAllOption = Options.boolean("all").pipe(
  Options.withDescription("Delete all resources (required without --handler)")
);

export const cleanupCommand = Command.make(
  "cleanup",
  { project: projectOption, stage: stageOption, region: regionOption, handler: handlerOption, all: cleanupAllOption, dryRun: dryRunOption, verbose: verboseOption },
  ({ project: projectOpt, stage, region, handler: handlerOpt, all: deleteAll, dryRun, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);

      const project = Option.getOrElse(projectOpt, () => config?.name ?? "");
      const finalStage = config?.stage ?? stage;
      const finalRegion = config?.region ?? region;
      const handlerFilter = Option.getOrUndefined(handlerOpt);

      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return;
      }

      const clientsLayer = makeClients({
        lambda: { region: finalRegion },
        iam: { region: finalRegion },
        apigatewayv2: { region: finalRegion },
        dynamodb: { region: finalRegion },
        resource_groups_tagging_api: { region: finalRegion },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;

      yield* Effect.gen(function* () {
        yield* Console.log(`\nLooking for resources in ${project}/${finalStage}...\n`);

        const resources = yield* getResourcesByTags(project, finalStage);

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
          yield* Console.log(`${handler}:`);
          for (const resource of handlerResources) {
            const typeTag = resource.Tags?.find(t => t.Key === "effortless:type");
            const type = typeTag?.Value ?? "unknown";
            yield* Console.log(`  [${type}] ${resource.ResourceARN}`);
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
            yield* Console.log(`  [iam-role] ${roleName} (derived)`);
          }
        }

        const totalResources = resourcesToDelete.length + derivedRoles.length;
        yield* Console.log(`\nTotal: ${totalResources} resource(s) (${derivedRoles.length} derived)`);

        if (dryRun) {
          yield* Console.log("\n[DRY RUN] No resources were deleted.");
          return;
        }

        if (!handlerFilter && !deleteAll) {
          yield* Console.log("\nTo delete these resources, use one of:");
          yield* Console.log("  eff cleanup --all                    # Delete all resources");
          yield* Console.log("  eff cleanup --handler <name>         # Delete specific handler");
          yield* Console.log("  eff cleanup --dry-run                # Preview without deleting");
          return;
        }

        yield* Console.log("\nDeleting resources...");
        yield* deleteResources(resourcesToDelete);
        yield* Console.log("\nDone!");
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Delete deployed resources"));

export const cleanupRolesCommand = Command.make(
  "cleanup-roles",
  { project: projectOption, stage: stageOption, region: regionOption, all: cleanupAllOption, dryRun: dryRunOption, verbose: verboseOption },
  ({ project: projectOpt, stage, region, all: deleteAll, dryRun, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);

      const project = Option.getOrUndefined(projectOpt) ?? config?.name;
      const finalStage = config?.stage ?? stage;
      const finalRegion = config?.region ?? region;

      const clientsLayer = makeClients({
        iam: { region: finalRegion },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;

      yield* Effect.gen(function* () {
        yield* Console.log("\nSearching for effortless IAM roles...\n");

        const allRoles = yield* listEffortlessRoles();

        if (allRoles.length === 0) {
          yield* Console.log("No effortless IAM roles found.");
          return;
        }

        const roles = allRoles.filter(role => {
          if (project && role.project !== project) return false;
          if (finalStage !== "dev" && role.stage !== finalStage) return false;
          return true;
        });

        if (roles.length === 0) {
          yield* Console.log(`No IAM roles found for ${project ?? "any project"}/${finalStage}.`);
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

        if (dryRun) {
          yield* Console.log("\n[DRY RUN] No roles were deleted.");
          return;
        }

        if (!deleteAll) {
          yield* Console.log("\nTo delete these roles, use:");
          yield* Console.log("  eff cleanup-roles --all              # Delete all found roles");
          yield* Console.log("  eff cleanup-roles -p <name> --all    # Delete roles for specific project");
          yield* Console.log("  eff cleanup-roles --dry-run          # Preview without deleting");
          return;
        }

        yield* Console.log("\nDeleting roles...");
        for (const role of roles) {
          yield* deleteRole(role.name).pipe(
            Effect.catchAll(error =>
              Effect.logError(`Failed to delete ${role.name}: ${error}`)
            )
          );
        }
        yield* Console.log("\nDone!");
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Find and delete orphaned IAM roles"));
