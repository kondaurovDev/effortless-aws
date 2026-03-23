import { Command } from "@effect/cli";
import { Effect, Console } from "effect";

import {
  Aws,
  getAllResourcesByTags,
  groupResourcesByHandler,
  checkDependencyWarnings,
  resourceTypeFromArn,
} from "../../aws";
import { findHandlerFiles, discoverHandlers, flattenHandlers } from "~/build/bundle";
import { projectOption, stageOption, regionOption, verboseOption } from "~/cli/config";
import { CliContext, withCliContext } from "~/cli/cli-context";
import { c } from "~/cli/colors";

const { lambda, cloudfront } = Aws;

// ============ Types ============

type HandlerType = "table" | "app" | "site" | "queue" | "api";

type LambdaDetails = {
  lastModified?: string;
  memory?: number;
  timeout?: number;
};

type StatusEntry = {
  status: "new" | "deployed" | "stale";
  name: string;
  type: HandlerType | string;
  method?: string;
  path?: string;
  lambda?: LambdaDetails;
  distributionDomain?: string;
  customDomain?: string;
};

// ============ Helpers ============

const INTERNAL_HANDLERS = new Set(["api", "platform"]);

const extractFunctionName = (arn: string): string | undefined => {
  const match = arn.match(/:function:([^:]+)$/);
  return match?.[1];
};

const formatDate = (date: Date | string | undefined): string => {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const getLambdaDetails = (functionName: string) =>
  Effect.gen(function* () {
    const config = yield* lambda.make("get_function_configuration", {
      FunctionName: functionName,
    });
    return {
      lastModified: config.LastModified,
      memory: config.MemorySize,
      timeout: config.Timeout,
    } as LambdaDetails;
  }).pipe(
    Effect.catchAll(() => Effect.succeed({} as LambdaDetails))
  );

const getDistributionInfo = (distributionArn: string) =>
  Effect.gen(function* () {
    const distributionId = distributionArn.split("/").pop()!;
    const result = yield* cloudfront.make("get_distribution", { Id: distributionId });
    const dist = result.Distribution;
    return {
      domain: dist?.DomainName,
      customDomain: dist?.DistributionConfig?.Aliases?.Items?.[0],
    };
  }).pipe(
    Effect.catchAll(() => Effect.succeed({ domain: undefined, customDomain: undefined }))
  );

// ============ Code discovery ============

const discoverCodeHandlers = (projectDir: string, patterns: string[]) =>
  Effect.gen(function* () {
    const files = findHandlerFiles(patterns, projectDir);
    const discovered = yield* discoverHandlers(files, projectDir);
    return flattenHandlers(discovered).map(h => ({
      name: h.exportName,
      type: h.type as HandlerType,
    }));
  });

// ============ AWS discovery ============

type AwsHandler = {
  name: string;
  type: string;
  lambdaArn?: string;
  distributionArn?: string;
};

const discoverAwsHandlers = (
  resources: Awaited<ReturnType<typeof getAllResourcesByTags>> extends Effect.Effect<infer A, any, any> ? A : never
) => {
  const byHandler = groupResourcesByHandler(resources as any);
  const handlers: AwsHandler[] = [];

  for (const [name, handlerResources] of byHandler) {
    if (INTERNAL_HANDLERS.has(name)) continue;

    const lambdaResource = handlerResources.find(r =>
      r.ResourceARN && resourceTypeFromArn(r.ResourceARN) === "lambda"
    );
    const cfResource = handlerResources.find(r =>
      r.ResourceARN && resourceTypeFromArn(r.ResourceARN) === "cloudfront-distribution"
    );

    const resourceTypes = handlerResources
      .map(r => r.ResourceARN ? resourceTypeFromArn(r.ResourceARN) : undefined)
      .filter(Boolean) as string[];
    const type = resourceTypes.includes("dynamodb") ? "dynamodb"
      : resourceTypes.includes("cloudfront-distribution") ? "s3-bucket"
      : resourceTypes.includes("sqs") ? "sqs"
      : resourceTypes.includes("ses") ? "ses"
      : resourceTypes.includes("ecs") ? "ecs"
      : resourceTypes.includes("scheduler") ? "scheduler"
      : resourceTypes.includes("lambda") ? "lambda"
      : "unknown";

    handlers.push({
      name,
      type,
      lambdaArn: lambdaResource?.ResourceARN ?? undefined,
      distributionArn: cfResource?.ResourceARN ?? undefined,
    });
  }

  return handlers;
};

// ============ Formatting ============

const TYPE_LABELS: Record<string, string> = {
  table: "table",
  app: "app",
  api: "api",
  site: "site",
  queue: "queue",
  lambda: "lambda",
  dynamodb: "table",
  sqs: "queue",
  "s3-bucket": "site",
  "lambda-layer": "layer",
};

const formatType = (type: string): string => {
  const label = TYPE_LABELS[type] ?? type;
  return c.cyan(`[${label}]`.padEnd(8));
};

const STATUS_COLORS = {
  new: c.yellow,
  deployed: c.green,
  stale: c.red,
} as const;

const formatStatus = (status: "new" | "deployed" | "stale"): string => {
  return STATUS_COLORS[status](status.padEnd(10));
};

const formatRoute = (method?: string, path?: string): string => {
  if (method && path) return `${method.padEnd(5)} ${path}`;
  if (path) return path;
  return "";
};

const formatEntry = (entry: StatusEntry): string => {
  const status = formatStatus(entry.status);
  const type = formatType(entry.type);
  const route = formatRoute(entry.method, entry.path);
  const name = c.bold(entry.name);

  const parts = [status, type, name];
  if (route) parts.push(route);

  if (entry.customDomain) {
    parts.push(c.cyan(entry.customDomain));
  }
  if (entry.distributionDomain) {
    parts.push(c.dim(entry.distributionDomain));
  }

  if (entry.lambda?.lastModified) {
    const time = formatDate(entry.lambda.lastModified);
    const mem = entry.lambda.memory ? `${entry.lambda.memory}MB` : "";
    const timeout = entry.lambda.timeout ? `${entry.lambda.timeout}s` : "";
    const details = c.dim([time, mem, timeout].filter(Boolean).join("  "));
    parts.push(details);
  }

  return `  ${parts.join("  ")}`;
};

// ============ Status logic ============

const statusHandler = Effect.gen(function* () {
  const { project, stage, region, patterns, projectDir } = yield* CliContext;

  const codeHandlers = patterns ? yield* discoverCodeHandlers(projectDir, patterns) : [];
  const codeHandlerNames = new Set(codeHandlers.map(h => h.name));

  yield* Console.log(`\nStatus for ${c.bold(project + "/" + stage)}:\n`);

  const resources = yield* getAllResourcesByTags(project, stage, region);
  const awsHandlers = discoverAwsHandlers(resources);

  const entries: StatusEntry[] = [];

  // Deployed + New: iterate code handlers
  for (const handler of codeHandlers) {
    const inAws = awsHandlers.find(h => h.name === handler.name);

    if (inAws) {
      let lambdaDetails: LambdaDetails | undefined;
      if (inAws.lambdaArn) {
        const functionName = extractFunctionName(inAws.lambdaArn);
        if (functionName) {
          lambdaDetails = yield* getLambdaDetails(functionName);
        }
      }

      let distributionDomain: string | undefined;
      let customDomain: string | undefined;
      if (inAws.distributionArn) {
        const info = yield* getDistributionInfo(inAws.distributionArn);
        distributionDomain = info.domain;
        customDomain = info.customDomain;
      }

      entries.push({
        status: "deployed",
        name: handler.name,
        type: handler.type,
        lambda: lambdaDetails,
        distributionDomain,
        customDomain,
      });
    } else {
      entries.push({
        status: "new",
        name: handler.name,
        type: handler.type,
      });
    }
  }

  // Stale: in AWS but not in code
  for (const handler of awsHandlers) {
    if (!codeHandlerNames.has(handler.name)) {
      let lambdaDetails: LambdaDetails | undefined;
      if (handler.lambdaArn) {
        const functionName = extractFunctionName(handler.lambdaArn);
        if (functionName) {
          lambdaDetails = yield* getLambdaDetails(functionName);
        }
      }

      entries.push({
        status: "stale",
        name: handler.name,
        type: handler.type,
        lambda: lambdaDetails,
      });
    }
  }

  if (entries.length === 0 && codeHandlers.length === 0) {
    yield* Console.log("No handlers found in code or AWS.");
    return;
  }

  const order = { new: 0, deployed: 1, stale: 2 };
  entries.sort((a, b) => order[a.status] - order[b.status]);

  for (const entry of entries) {
    yield* Console.log(formatEntry(entry));
  }

  const counts = {
    new: entries.filter(e => e.status === "new").length,
    deployed: entries.filter(e => e.status === "deployed").length,
    stale: entries.filter(e => e.status === "stale").length,
  };

  const parts: string[] = [];
  if (counts.new > 0) parts.push(c.yellow(`${counts.new} new`));
  if (counts.deployed > 0) parts.push(c.green(`${counts.deployed} deployed`));
  if (counts.stale > 0) parts.push(c.red(`${counts.stale} stale`));

  yield* Console.log(`\nTotal: ${parts.join(", ")}`);

  const depWarnings = yield* checkDependencyWarnings(projectDir).pipe(
    Effect.catchAll(() => Effect.succeed([] as string[]))
  );
  if (depWarnings.length > 0) {
    yield* Console.log("");
    for (const w of depWarnings) {
      yield* Console.log(c.yellow(`  ⚠ ${w}`));
    }
  }
});

// ============ Command ============

export const statusCommand = Command.make(
  "status",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  (opts) =>
    statusHandler.pipe(
      withCliContext(opts, (region) => Aws.makeClients({
        lambda: { region },
        cloudfront: { region: "us-east-1" },
        resource_groups_tagging_api: { region },
      })),
    )
).pipe(Command.withDescription("Compare local handlers with deployed AWS resources. Shows new, deployed, and stale handlers."));
