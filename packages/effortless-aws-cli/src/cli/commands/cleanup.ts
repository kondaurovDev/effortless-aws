import { Command, Options, Prompt } from "@effect/cli";
import { Effect, Console, Option } from "effect";

import {
  Aws,
  getAllResourcesByTags,
  groupResourcesByHandler,
  resourceTypeFromArn,
  listLayerVersions,
  deleteLayerVersion,
  listSchedulesByPrefix,
} from "../../aws";
import { deleteHandlerResources, HANDLER_RESOURCES, type HandlerType, type ResourceSpec } from "~/deploy/resource-registry";
import type { ResourceType } from "~/aws/tags";
import { findHandlerFiles, discoverHandlers, flattenHandlers } from "~/build/bundle";
import { projectOption, stageOption, regionOption, verboseOption, dryRunOption } from "~/cli/config";
import { CliContext, withCliContext } from "~/cli/cli-context";
import { c } from "~/cli/colors";

const handlerOption = Options.text("handler").pipe(
  Options.withAlias("h"),
  Options.withDescription("Handler name to delete (deletes all if not specified)"),
  Options.optional
);

const cleanupAllOption = Options.boolean("all").pipe(
  Options.withDescription("Delete all resources")
);

const yesOption = Options.boolean("yes").pipe(
  Options.withAlias("y"),
  Options.withDescription("Skip confirmation prompt")
);

const staleOption = Options.boolean("stale").pipe(
  Options.withDescription("Delete stale resources — handlers not in code, or leftover resources (e.g. IAM role without its Lambda)")
);

// ============ Handler type inference ============

const CODE_TYPE_MAP: Record<string, HandlerType> = {
  table: "table",
  api: "api",
  cron: "cron",
  fifoQueue: "fifoQueue",
  bucket: "bucket",
  mailer: "mailer",
  staticSite: "staticSite",
  app: "app",
  worker: "worker",
};

const inferHandlerType = (arns: string[]): HandlerType | undefined => {
  const types = new Set(arns.map(a => resourceTypeFromArn(a)).filter(Boolean));
  if (types.has("dynamodb")) return "table";
  if (types.has("ecs")) return "worker";
  if (types.has("scheduler")) return "cron";
  if (types.has("cloudfront-distribution") && arns.some(a => a.includes("-site"))) return "staticSite";
  if (types.has("cloudfront-distribution")) return "app";
  if (types.has("sqs")) return "fifoQueue";
  if (types.has("ses")) return "mailer";
  if (types.has("s3-bucket")) return "bucket";
  if (types.has("lambda")) return "api";
  return undefined;
};

// ============ Confirm helper ============

const confirmDelete = (message: string, skipConfirm: boolean) =>
  skipConfirm
    ? Effect.succeed(true)
    : Prompt.confirm({ message, initial: false }).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      );

// ============ Stale resource detection ============

/**
 * For each handler type, the "primary" resource type that must exist.
 * If the primary is gone but other resources remain, those are stale.
 */
const PRIMARY_RESOURCE: Record<HandlerType, ResourceType> = {
  table: "lambda",
  api: "lambda",
  cron: "lambda",
  fifoQueue: "lambda",
  bucket: "lambda",
  mailer: "ses",
  staticSite: "cloudfront-distribution",
  app: "lambda",
  worker: "ecs",
};

type StaleResource = { handler: string; handlerType: HandlerType; spec: ResourceSpec };

/**
 * Find stale resources: either entire handlers not in code,
 * or individual resources whose primary resource is missing.
 */
const findStaleResources = (
  byHandler: Map<string, import("@aws-sdk/client-resource-groups-tagging-api").ResourceTagMapping[]>,
  codeNames: Set<string>,
  internalHandlers: Set<string>,
): { staleHandlers: { name: string; handlerType: HandlerType }[]; staleResources: StaleResource[] } => {
  const staleHandlers: { name: string; handlerType: HandlerType }[] = [];
  const staleResources: StaleResource[] = [];

  for (const [name, handlerResources] of byHandler) {
    if (internalHandlers.has(name)) continue;

    const arns = handlerResources.map(r => r.ResourceARN!);
    const inferred = inferHandlerType(arns);
    if (!inferred) continue;

    // Handler not in code → entire handler is stale
    if (!codeNames.has(name)) {
      staleHandlers.push({ name, handlerType: inferred });
      continue;
    }

    // Handler is in code — check if primary resource exists
    const resourceTypes = new Set(arns.map(a => resourceTypeFromArn(a)).filter(Boolean));
    const primary = PRIMARY_RESOURCE[inferred];

    if (!resourceTypes.has(primary)) {
      // Primary missing, remaining resources are stale
      const specs = HANDLER_RESOURCES[inferred];
      for (const spec of specs) {
        if (spec.type !== primary && resourceTypes.has(spec.type)) {
          staleResources.push({ handler: name, handlerType: inferred, spec });
        }
      }
    }
  }

  return { staleHandlers, staleResources };
};

// ============ Main cleanup handler ============

const cleanupHandlers = (input: {
  handlerFilter: string | undefined;
  cleanupStale: boolean;
  deleteAll: boolean;
  dryRun: boolean;
  yes: boolean;
}) =>
  Effect.gen(function* () {
    // No mode specified — nothing to do
    if (!input.handlerFilter && !input.cleanupStale && !input.deleteAll) {
      yield* Console.error("Specify --stale, --all, or --handler <name>. See eff cleanup --help.");
      return;
    }

    const { project, stage, region, patterns, projectDir } = yield* CliContext;

    // Discover code handlers (for type info and stale detection)
    const codeHandlers = patterns
      ? flattenHandlers(yield* discoverHandlers(findHandlerFiles(patterns, projectDir), projectDir))
      : [];
    const codeHandlerMap = new Map(codeHandlers.map(h => [h.exportName, h.type]));

    yield* Console.log(`\nLooking for resources in ${c.bold(project + "/" + stage)}...\n`);
    const resources = yield* getAllResourcesByTags(project, stage, region);
    const byHandler = groupResourcesByHandler(resources);

    // Supplement with schedules (not indexed by Resource Groups Tagging API)
    const prefix = `${project}-${stage}-`;
    const schedules = yield* listSchedulesByPrefix(prefix).pipe(
      Effect.catchAll(() => Effect.succeed([] as { name: string; arn: string }[])),
    );
    for (const s of schedules) {
      const handlerName = s.name.slice(prefix.length);
      if (!handlerName) continue;
      const existing = byHandler.get(handlerName) ?? [];
      existing.push({ ResourceARN: s.arn, Tags: [
        { Key: "effortless:handler", Value: handlerName },
      ] });
      byHandler.set(handlerName, existing);
    }

    type HandlerToDelete = { name: string; handlerType: HandlerType };
    const INTERNAL_HANDLERS = new Set(["api", "platform"]);

    // --stale mode: detect stale handlers, individual resources, and layer versions
    if (input.cleanupStale) {
      if (!patterns) {
        yield* Console.error("Error: No 'handlers' patterns in config — cannot determine stale resources");
        return;
      }
      const codeNames = new Set(codeHandlers.map(h => h.exportName));
      const { staleHandlers, staleResources } = findStaleResources(byHandler, codeNames, INTERNAL_HANDLERS);

      // Detect stale layer versions — find which versions are actually used by Lambdas
      const layerName = `${project}-${stage}-deps`;
      const allVersions = yield* listLayerVersions(layerName);
      const usedLayerVersions = new Set<number>();
      for (const [, handlerResources] of byHandler) {
        for (const r of handlerResources) {
          if (!r.ResourceARN?.startsWith("arn:aws:lambda:") || r.ResourceARN.includes(":layer:")) continue;
          const functionName = r.ResourceARN.split(":").pop()!;
          const config = yield* Aws.lambda.make("get_function_configuration", {
            FunctionName: functionName,
          }).pipe(Effect.catchAll(() => Effect.succeed({ Layers: undefined })));
          for (const layer of config.Layers ?? []) {
            const versionMatch = layer.Arn?.match(/:(\d+)$/);
            if (versionMatch) usedLayerVersions.add(Number(versionMatch[1]));
          }
        }
      }
      const staleLayerVersions = allVersions.filter(v => !usedLayerVersions.has(v.version));

      if (staleHandlers.length === 0 && staleResources.length === 0 && staleLayerVersions.length === 0) {
        yield* Console.log("No stale resources found.");
        return;
      }

      // Display stale handlers (entire handler not in code)
      for (const { name, handlerType } of staleHandlers) {
        const specs = HANDLER_RESOURCES[handlerType];
        const ctx = { project, stage, handler: name, region };
        yield* Console.log(`${c.bold(name)} ${c.dim(`(${handlerType} — not in code)`)}:`);
        for (const s of specs.filter(s => !s.shared)) {
          yield* Console.log(`  ${c.cyan(s.label.padEnd(24))} ${c.dim(s.deriveName(ctx))}`);
        }
      }

      // Display stale individual resources (primary missing)
      const byStaleHandler = new Map<string, StaleResource[]>();
      for (const sr of staleResources) {
        if (!byStaleHandler.has(sr.handler)) byStaleHandler.set(sr.handler, []);
        byStaleHandler.get(sr.handler)!.push(sr);
      }
      for (const [handler, items] of byStaleHandler) {
        const ht = items[0]!.handlerType;
        const primary = PRIMARY_RESOURCE[ht];
        const ctx = { project, stage, handler, region };
        yield* Console.log(`${c.bold(handler)} ${c.dim(`(${ht} — ${primary} missing)`)}:`);
        for (const { spec } of items) {
          yield* Console.log(`  ${c.cyan(spec.label.padEnd(24))} ${c.dim(spec.deriveName(ctx))}`);
        }
      }

      // Display stale layer versions
      if (staleLayerVersions.length > 0) {
        yield* Console.log(`${c.bold("layer")} ${c.dim(`(${layerName} — ${staleLayerVersions.length} old version(s))`)}:`);
        for (const v of staleLayerVersions) {
          const hash = v.description?.match(/hash:([a-f0-9]+)/)?.[1] ?? "unknown";
          yield* Console.log(`  ${c.cyan("Layer Version".padEnd(24))} ${c.dim(`v${v.version} (hash: ${hash})`)}`);
        }
      }

      const totalResources = staleHandlers.reduce((sum, { handlerType }) =>
        sum + HANDLER_RESOURCES[handlerType].filter(s => !s.shared).length, 0
      ) + staleResources.length + staleLayerVersions.length;
      yield* Console.log(`\nFound ~${totalResources} stale resource(s)`);

      if (input.dryRun) {
        yield* Console.log(`\n${c.yellow("[DRY RUN]")} No resources were deleted.`);
        return;
      }

      const confirmed = yield* confirmDelete(`Delete ${totalResources} stale resource(s)?`, input.yes);
      if (!confirmed) return;

      yield* Console.log(c.red("\nDeleting stale resources..."));

      for (const { name, handlerType } of staleHandlers) {
        yield* Console.log(`\n${c.bold(name)}:`);
        yield* deleteHandlerResources(handlerType, { project, stage, handler: name, region }, { skipShared: true });
      }

      for (const { handler, spec } of staleResources) {
        const ctx = { project, stage, handler, region };
        const name = spec.deriveName(ctx);
        yield* Effect.logDebug(`Deleting ${spec.label}: ${name}`);
        yield* spec.cleanup(ctx).pipe(
          Effect.catchAll(error =>
            Effect.logDebug(`${spec.label} "${name}" not found or already deleted: ${error}`)
          )
        );
      }

      for (const v of staleLayerVersions) {
        yield* Effect.logDebug(`Deleting layer ${layerName} v${v.version}`);
        yield* deleteLayerVersion(layerName, v.version).pipe(
          Effect.catchAll(error =>
            Effect.logDebug(`Layer v${v.version} already deleted: ${error}`)
          )
        );
      }

      yield* Console.log(c.green("\nDone!"));
      return;
    }

    // Non-stale modes: --handler or --all (list everything)
    let handlersToDelete: HandlerToDelete[];

    if (input.handlerFilter) {
      const codeType = codeHandlerMap.get(input.handlerFilter);
      const handlerType = codeType ? CODE_TYPE_MAP[codeType] : undefined;

      if (!handlerType) {
        const handlerResources = byHandler.get(input.handlerFilter);
        if (!handlerResources) {
          yield* Console.error(`Handler "${input.handlerFilter}" not found in code or AWS.`);
          return;
        }
        const inferred = inferHandlerType(handlerResources.map(r => r.ResourceARN!));
        if (!inferred) {
          yield* Console.error(`Cannot determine type for handler "${input.handlerFilter}".`);
          return;
        }
        handlersToDelete = [{ name: input.handlerFilter, handlerType: inferred }];
      } else {
        handlersToDelete = [{ name: input.handlerFilter, handlerType }];
      }
    } else if (input.deleteAll) {
      const seen = new Set<string>();
      handlersToDelete = [];

      for (const h of codeHandlers) {
        const ht = CODE_TYPE_MAP[h.type];
        if (ht && !INTERNAL_HANDLERS.has(h.exportName)) {
          handlersToDelete.push({ name: h.exportName, handlerType: ht });
          seen.add(h.exportName);
        }
      }

      for (const [name, handlerResources] of byHandler) {
        if (seen.has(name) || INTERNAL_HANDLERS.has(name)) continue;
        const inferred = inferHandlerType(handlerResources.map(r => r.ResourceARN!));
        if (inferred) handlersToDelete.push({ name, handlerType: inferred });
      }
    } else {
      return; // unreachable — early return above handles this case
    }

    if (handlersToDelete.length === 0) {
      yield* Console.log("No resources found.");
      return;
    }

    // Display what will be deleted
    const skipShared = !input.deleteAll;
    for (const { name, handlerType } of handlersToDelete) {
      const specs = HANDLER_RESOURCES[handlerType];
      const ctx = { project, stage, handler: name, region };
      const items = specs
        .filter(s => !(skipShared && s.shared))
        .map(s => ({ label: s.label, name: s.deriveName(ctx) }))
        .filter(s => s.name);

      yield* Console.log(`${c.bold(name)} ${c.dim(`(${handlerType})`)}:`);
      for (const item of items) {
        yield* Console.log(`  ${c.cyan(item.label.padEnd(24))} ${c.dim(item.name)}`);
      }
    }

    const totalSpecs = handlersToDelete.reduce((sum, { handlerType }) => {
      const specs = HANDLER_RESOURCES[handlerType];
      return sum + specs.filter(s => !(skipShared && s.shared)).length;
    }, 0);
    yield* Console.log(`\nTotal: ${handlersToDelete.length} handler(s), ~${totalSpecs} resource(s)`);

    if (input.dryRun) {
      yield* Console.log(`\n${c.yellow("[DRY RUN]")} No resources were deleted.`);
      return;
    }

    const confirmed = yield* confirmDelete(`Delete ${totalSpecs} resource(s)?`, input.yes);
    if (!confirmed) return;

    yield* Console.log(c.red("\nDeleting resources..."));

    for (const { name, handlerType } of handlersToDelete) {
      yield* Console.log(`\n${c.bold(name)}:`);
      yield* deleteHandlerResources(handlerType, { project, stage, handler: name, region }, { skipShared });
    }

    yield* Console.log(c.green("\nDone!"));
  });

// ============ Command ============

export const cleanupCommand = Command.make(
  "cleanup",
  { project: projectOption, stage: stageOption, region: regionOption, handler: handlerOption, stale: staleOption, all: cleanupAllOption, yes: yesOption, dryRun: dryRunOption, verbose: verboseOption },
  ({ handler: handlerOpt, stale: cleanupStale, all: deleteAll, yes, dryRun, ...opts }) =>
    Effect.gen(function* () {
      const { region } = yield* CliContext;
      const handlerFilter = Option.getOrUndefined(handlerOpt);

      yield* cleanupHandlers({ handlerFilter, cleanupStale, deleteAll, dryRun, yes }).pipe(
        Effect.provide(Aws.makeClients({
          lambda: { region },
          iam: { region },
          apigatewayv2: { region },
          dynamodb: { region },
          resource_groups_tagging_api: { region },
          s3: { region },
          sqs: { region },
          ecs: { region },
          cloudwatch_logs: { region },
          scheduler: { region },
          sesv2: { region },
          cloudfront: { region: "us-east-1" },
        })),
      );
    }).pipe(
      withCliContext(opts),
    )
).pipe(Command.withDescription("Delete deployed resources (Lambda, API Gateway, DynamoDB, IAM roles, layers)"));
