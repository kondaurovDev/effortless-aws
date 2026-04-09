import { Command, Options, Prompt } from "@effect/cli";
import { Effect, Console, Option } from "effect";

import { Aws, listLayerVersions, deleteLayerVersion, listSchedulesByPrefix } from "../../aws";
import { getAllResourcesByTags, groupResourcesByHandler } from "~/aws/resource-lookup";
import { resourceTypeFromArn, type ResourceType } from "~/core";
import { deleteHandlerResources, HANDLER_RESOURCES, type HandlerType, type ResourceSpec } from "~/deploy/resource-registry";
import { findHandlerFiles } from "~/build/bundle";
import { discoverHandlers, flattenHandlers } from "~/discovery";
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
  mcp: "lambda",
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

// ============ Cleanup data (pure — no side effects) ============

type HandlerToDelete = { name: string; handlerType: HandlerType };

export type CleanupPreview = {
  project: string;
  stage: string;
  region: string;
  handlers: { name: string; handlerType: string; reason: string }[];
  staleResources: { handler: string; label: string; name: string }[];
  staleLayerVersions: { version: number; hash: string }[];
  totalResources: number;
};

/** Discover code/AWS handlers and build handler map. Shared between preview and execute. */
const loadCleanupContext = Effect.gen(function* () {
  const { project, stage, region, patterns, projectDir } = yield* CliContext;

  const codeHandlers = patterns
    ? flattenHandlers(yield* discoverHandlers(findHandlerFiles(patterns, projectDir)))
    : [];
  const codeHandlerMap = new Map(codeHandlers.map(h => [h.exportName, h.type]));

  const resources = yield* getAllResourcesByTags;
  const byHandler = groupResourcesByHandler(resources);

  const prefix = `${project}-${stage}-`;
  const schedules = yield* listSchedulesByPrefix(prefix).pipe(
    Effect.catchAll(() => Effect.succeed([] as { name: string; arn: string }[])),
  );
  for (const s of schedules) {
    const handlerName = s.name.slice(prefix.length);
    if (!handlerName) continue;
    const existing = byHandler.get(handlerName) ?? [];
    existing.push({ ResourceARN: s.arn, Tags: [{ Key: "effortless:handler", Value: handlerName }] });
    byHandler.set(handlerName, existing);
  }

  return { project, stage, region, patterns, projectDir, codeHandlers, codeHandlerMap, byHandler };
});

/** Get a preview of what cleanup would delete. No Console output, no deletion. */
export const getCleanupPreview = (mode: { handler?: string; stale?: boolean; all?: boolean }) =>
  Effect.gen(function* () {
    const { project, stage, region, patterns, codeHandlers, codeHandlerMap, byHandler } = yield* loadCleanupContext;
    const INTERNAL = new Set(["api", "platform"]);

    let handlersToDelete: HandlerToDelete[] = [];
    const staleResourceItems: CleanupPreview["staleResources"] = [];
    const staleLayerItems: CleanupPreview["staleLayerVersions"] = [];

    if (mode.stale) {
      if (!patterns) return yield* Effect.fail(new Error("No 'handlers' patterns in config"));
      const codeNames = new Set(codeHandlers.map(h => h.exportName));
      const { staleHandlers, staleResources } = findStaleResources(byHandler, codeNames, INTERNAL);

      handlersToDelete = staleHandlers.map(h => ({ ...h, reason: "not in code" }));

      for (const sr of staleResources) {
        const ctx = { project, stage, handler: sr.handler, region };
        staleResourceItems.push({ handler: sr.handler, label: sr.spec.label, name: sr.spec.deriveName(ctx) });
      }

      // Detect stale layer versions
      const layerName = `${project}-${stage}-deps`;
      const allVersions = yield* listLayerVersions(layerName);
      const usedVersions = new Set<number>();
      for (const [, handlerResources] of byHandler) {
        for (const r of handlerResources) {
          if (!r.ResourceARN?.startsWith("arn:aws:lambda:") || r.ResourceARN.includes(":layer:")) continue;
          const functionName = r.ResourceARN.split(":").pop()!;
          const config = yield* Aws.lambda.make("get_function_configuration", {
            FunctionName: functionName,
          }).pipe(Effect.catchAll(() => Effect.succeed({ Layers: undefined })));
          for (const layer of config.Layers ?? []) {
            const m = layer.Arn?.match(/:(\d+)$/);
            if (m) usedVersions.add(Number(m[1]));
          }
        }
      }
      for (const v of allVersions.filter(v => !usedVersions.has(v.version))) {
        staleLayerItems.push({ version: v.version, hash: v.description?.match(/hash:([a-f0-9]+)/)?.[1] ?? "unknown" });
      }
    } else if (mode.handler) {
      const codeType = codeHandlerMap.get(mode.handler);
      const handlerType = codeType ? CODE_TYPE_MAP[codeType] : undefined;
      if (!handlerType) {
        const hr = byHandler.get(mode.handler);
        if (!hr) return yield* Effect.fail(new Error(`Handler "${mode.handler}" not found`));
        const inferred = inferHandlerType(hr.map(r => r.ResourceARN!));
        if (!inferred) return yield* Effect.fail(new Error(`Cannot determine type for "${mode.handler}"`));
        handlersToDelete = [{ name: mode.handler, handlerType: inferred }];
      } else {
        handlersToDelete = [{ name: mode.handler, handlerType }];
      }
    } else if (mode.all) {
      const seen = new Set<string>();
      for (const h of codeHandlers) {
        const ht = CODE_TYPE_MAP[h.type];
        if (ht && !INTERNAL.has(h.exportName)) {
          handlersToDelete.push({ name: h.exportName, handlerType: ht });
          seen.add(h.exportName);
        }
      }
      for (const [name, hr] of byHandler) {
        if (seen.has(name) || INTERNAL.has(name)) continue;
        const inferred = inferHandlerType(hr.map(r => r.ResourceARN!));
        if (inferred) handlersToDelete.push({ name, handlerType: inferred });
      }
    }

    const skipShared = !mode.all;
    const handlerPreviews = handlersToDelete.map(h => ({
      name: h.name,
      handlerType: h.handlerType as string,
      reason: mode.stale ? "stale" : mode.all ? "all" : "targeted",
    }));

    const totalResources = handlersToDelete.reduce((sum, { handlerType }) =>
      sum + HANDLER_RESOURCES[handlerType].filter(s => !(skipShared && s.shared)).length, 0
    ) + staleResourceItems.length + staleLayerItems.length;

    return {
      project, stage, region,
      handlers: handlerPreviews,
      staleResources: staleResourceItems,
      staleLayerVersions: staleLayerItems,
      totalResources,
    } satisfies CleanupPreview;
  });

/** Execute cleanup — actually delete resources. No Console output. */
export const runCleanup = (mode: { handler?: string; stale?: boolean; all?: boolean }) =>
  Effect.gen(function* () {
    const { project, stage, region, patterns, codeHandlers, codeHandlerMap, byHandler } = yield* loadCleanupContext;
    const INTERNAL = new Set(["api", "platform"]);

    const handlersToDelete: HandlerToDelete[] = [];

    if (mode.stale) {
      if (!patterns) return yield* Effect.fail(new Error("No 'handlers' patterns in config"));
      const codeNames = new Set(codeHandlers.map(h => h.exportName));
      const { staleHandlers, staleResources } = findStaleResources(byHandler, codeNames, INTERNAL);

      for (const { name, handlerType } of staleHandlers) {
        yield* deleteHandlerResources(handlerType, { project, stage, handler: name, region }, { skipShared: true });
      }

      for (const { handler, spec } of staleResources) {
        const ctx = { project, stage, handler, region };
        yield* spec.cleanup(ctx).pipe(Effect.catchAll(() => Effect.void));
      }

      // Delete stale layer versions
      const layerName = `${project}-${stage}-deps`;
      const allVersions = yield* listLayerVersions(layerName);
      const usedVersions = new Set<number>();
      for (const [, handlerResources] of byHandler) {
        for (const r of handlerResources) {
          if (!r.ResourceARN?.startsWith("arn:aws:lambda:") || r.ResourceARN.includes(":layer:")) continue;
          const functionName = r.ResourceARN.split(":").pop()!;
          const config = yield* Aws.lambda.make("get_function_configuration", {
            FunctionName: functionName,
          }).pipe(Effect.catchAll(() => Effect.succeed({ Layers: undefined })));
          for (const layer of config.Layers ?? []) {
            const m = layer.Arn?.match(/:(\d+)$/);
            if (m) usedVersions.add(Number(m[1]));
          }
        }
      }
      for (const v of allVersions.filter(v => !usedVersions.has(v.version))) {
        yield* deleteLayerVersion(layerName, v.version).pipe(Effect.catchAll(() => Effect.void));
      }

      return { deleted: staleHandlers.length, staleResources: staleResources.length };
    }

    if (mode.handler) {
      const codeType = codeHandlerMap.get(mode.handler);
      const handlerType = codeType ? CODE_TYPE_MAP[codeType] : undefined;
      if (!handlerType) {
        const hr = byHandler.get(mode.handler);
        if (!hr) return yield* Effect.fail(new Error(`Handler "${mode.handler}" not found`));
        const inferred = inferHandlerType(hr.map(r => r.ResourceARN!));
        if (!inferred) return yield* Effect.fail(new Error(`Cannot determine type for "${mode.handler}"`));
        handlersToDelete.push({ name: mode.handler, handlerType: inferred });
      } else {
        handlersToDelete.push({ name: mode.handler, handlerType });
      }
    } else if (mode.all) {
      const seen = new Set<string>();
      for (const h of codeHandlers) {
        const ht = CODE_TYPE_MAP[h.type];
        if (ht && !INTERNAL.has(h.exportName)) {
          handlersToDelete.push({ name: h.exportName, handlerType: ht });
          seen.add(h.exportName);
        }
      }
      for (const [name, hr] of byHandler) {
        if (seen.has(name) || INTERNAL.has(name)) continue;
        const inferred = inferHandlerType(hr.map(r => r.ResourceARN!));
        if (inferred) handlersToDelete.push({ name, handlerType: inferred });
      }
    }

    const skipShared = !mode.all;
    for (const { name, handlerType } of handlersToDelete) {
      yield* deleteHandlerResources(handlerType, { project, stage, handler: name, region }, { skipShared });
    }

    return { deleted: handlersToDelete.length };
  });

// ============ Command ============

export const cleanupCommand = Command.make(
  "cleanup",
  { project: projectOption, stage: stageOption, region: regionOption, handler: handlerOption, stale: staleOption, all: cleanupAllOption, yes: yesOption, dryRun: dryRunOption, verbose: verboseOption },
  ({ handler: handlerOpt, stale: cleanupStale, all: deleteAll, yes, dryRun, ...opts }) =>
    Effect.gen(function* () {
      const { region } = yield* CliContext;
      const handlerFilter = Option.getOrUndefined(handlerOpt);

      if (!handlerFilter && !cleanupStale && !deleteAll) {
        yield* Console.error("Specify --stale, --all, or --handler <name>. See eff cleanup --help.");
        return;
      }

      const mode = { handler: handlerFilter, stale: cleanupStale, all: deleteAll };
      const clients = Aws.makeClients({
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
      });

      const preview = yield* getCleanupPreview(mode).pipe(Effect.provide(clients));

      if (preview.totalResources === 0) {
        yield* Console.log("No resources found to delete.");
        return;
      }

      yield* Console.log(`\nResources to delete in ${c.bold(preview.project + "/" + preview.stage)}:\n`);

      for (const h of preview.handlers) {
        yield* Console.log(`  ${c.bold(h.name)} ${c.dim(`(${h.handlerType} — ${h.reason})`)}`);
      }
      for (const sr of preview.staleResources) {
        yield* Console.log(`  ${c.dim(sr.handler)}  ${c.cyan(sr.label.padEnd(24))} ${c.dim(sr.name)}`);
      }
      for (const v of preview.staleLayerVersions) {
        yield* Console.log(`  ${c.cyan("Layer Version".padEnd(24))} ${c.dim(`v${v.version} (hash: ${v.hash})`)}`);
      }

      yield* Console.log(`\nTotal: ~${preview.totalResources} resource(s)`);

      if (dryRun) {
        yield* Console.log(`\n${c.yellow("[DRY RUN]")} No resources were deleted.`);
        return;
      }

      const confirmed = yield* confirmDelete(`Delete ${preview.totalResources} resource(s)?`, yes);
      if (!confirmed) return;

      yield* Console.log(c.red("\nDeleting resources..."));
      yield* runCleanup(mode).pipe(Effect.provide(clients));
      yield* Console.log(c.green("\nDone!"));
    }).pipe(
      withCliContext(opts),
    )
).pipe(Command.withDescription("Delete deployed resources (Lambda, API Gateway, DynamoDB, IAM roles, layers)"));
