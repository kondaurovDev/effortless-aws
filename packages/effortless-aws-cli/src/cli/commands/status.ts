import { Command } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";

import {
  Aws,
  getAllResourcesByTags,
  groupResourcesByHandler
} from "../../aws";
import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { loadConfig, projectOption, stageOption, regionOption, verboseOption, getPatternsFromConfig } from "~/cli/config";
import { c } from "~/cli/colors";

const { lambda, apigatewayv2: apigateway } = Aws;

// ============ Types ============

type HandlerType = "http" | "table" | "app" | "site" | "queue";

type CodeHandler = {
  name: string;
  type: HandlerType;
  method?: string;
  path?: string;
};

type LambdaDetails = {
  lastModified?: string;
  memory?: number;
  timeout?: number;
};

type StatusEntry = {
  status: "new" | "deployed" | "orphaned";
  name: string;
  type: HandlerType | string;
  method?: string;
  path?: string;
  lambda?: LambdaDetails;
};

// ============ Helpers ============

const INTERNAL_HANDLERS = new Set(["api", "platform"]);

const extractFunctionName = (arn: string): string | undefined => {
  const match = arn.match(/:function:([^:]+)$/);
  return match?.[1];
};

const extractApiId = (arn: string): string | undefined => {
  const match = arn.match(/\/apis\/([a-z0-9]+)$/);
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

const getApiUrl = (apiId: string) =>
  Effect.gen(function* () {
    const api = yield* apigateway.make("get_api", { ApiId: apiId });
    return api.ApiEndpoint;
  }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined))
  );

// ============ Code discovery ============

const discoverCodeHandlers = (projectDir: string, patterns: string[]): CodeHandler[] => {
  const files = findHandlerFiles(patterns, projectDir);
  const discovered = discoverHandlers(files);
  const handlers: CodeHandler[] = [];

  for (const { exports } of discovered.httpHandlers) {
    for (const fn of exports) {
      handlers.push({
        name: fn.exportName,
        type: "http",
        method: fn.config.method,
        path: fn.config.path,
      });
    }
  }

  for (const { exports } of discovered.tableHandlers) {
    for (const fn of exports) {
      handlers.push({
        name: fn.exportName,
        type: "table",
      });
    }
  }

  for (const { exports } of discovered.appHandlers) {
    for (const fn of exports) {
      handlers.push({
        name: fn.exportName,
        type: "app",
        path: fn.config.path,
      });
    }
  }

  for (const { exports } of discovered.staticSiteHandlers) {
    for (const fn of exports) {
      handlers.push({
        name: fn.exportName,
        type: "site",
      });
    }
  }

  for (const { exports } of discovered.fifoQueueHandlers) {
    for (const fn of exports) {
      handlers.push({
        name: fn.exportName,
        type: "queue",
      });
    }
  }

  return handlers;
};

// ============ AWS discovery ============

type AwsHandler = {
  name: string;
  type: string;
  lambdaArn?: string;
  apiArn?: string;
};

const discoverAwsHandlers = (
  resources: Awaited<ReturnType<typeof getAllResourcesByTags>> extends Effect.Effect<infer A, any, any> ? A : never
) => {
  const byHandler = groupResourcesByHandler(resources as any);
  const handlers: AwsHandler[] = [];

  for (const [name, handlerResources] of byHandler) {
    if (INTERNAL_HANDLERS.has(name)) continue;

    const lambdaResource = handlerResources.find(r =>
      r.Tags?.find(t => t.Key === "effortless:type" && t.Value === "lambda")
    );
    const apiResource = handlerResources.find(r =>
      r.Tags?.find(t => t.Key === "effortless:type" && t.Value === "api-gateway")
    );
    const typeTag = handlerResources[0]?.Tags?.find(t => t.Key === "effortless:type");
    const type = typeTag?.Value ?? "unknown";

    handlers.push({
      name,
      type,
      lambdaArn: lambdaResource?.ResourceARN ?? undefined,
      apiArn: apiResource?.ResourceARN ?? undefined,
    });
  }

  return handlers;
};

// ============ Formatting ============

const TYPE_LABELS: Record<string, string> = {
  http: "http",
  table: "table",
  app: "app",
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
  orphaned: c.red,
} as const;

const formatStatus = (status: "new" | "deployed" | "orphaned"): string => {
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

  if (entry.lambda?.lastModified) {
    const time = formatDate(entry.lambda.lastModified);
    const mem = entry.lambda.memory ? `${entry.lambda.memory}MB` : "";
    const timeout = entry.lambda.timeout ? `${entry.lambda.timeout}s` : "";
    const details = c.dim([time, mem, timeout].filter(Boolean).join("  "));
    parts.push(details);
  }

  return `  ${parts.join("  ")}`;
};

// ============ Command ============

export const statusCommand = Command.make(
  "status",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  ({ project: projectOpt, stage, region, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);

      const project = Option.getOrElse(projectOpt, () => config?.name ?? "");
      const finalStage = config?.stage ?? stage;
      const finalRegion = config?.region ?? region;

      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return;
      }

      const clientsLayer = Aws.makeClients({
        lambda: { region: finalRegion },
        apigatewayv2: { region: finalRegion },
        resource_groups_tagging_api: { region: finalRegion },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;
      const projectDir = process.cwd();

      // Discover handlers from code
      const patterns = getPatternsFromConfig(config);
      const codeHandlers = patterns ? discoverCodeHandlers(projectDir, patterns) : [];
      const codeHandlerNames = new Set(codeHandlers.map(h => h.name));

      yield* Effect.gen(function* () {
        yield* Console.log(`\nStatus for ${c.bold(project + "/" + finalStage)}:\n`);

        // Query AWS resources
        const resources = yield* getAllResourcesByTags(project, finalStage, finalRegion);
        const awsHandlers = discoverAwsHandlers(resources);
        const awsHandlerNames = new Set(awsHandlers.map(h => h.name));

        // Find API URL
        let apiUrl: string | undefined;
        for (const handler of awsHandlers) {
          if (handler.apiArn) {
            const apiId = extractApiId(handler.apiArn);
            if (apiId) {
              apiUrl = yield* getApiUrl(apiId);
              break;
            }
          }
        }
        // Also check internal "api" handler
        const apiResource = resources.find(r =>
          r.Tags?.find(t => t.Key === "effortless:handler" && t.Value === "api") &&
          r.Tags?.find(t => t.Key === "effortless:type" && t.Value === "api-gateway")
        );
        if (!apiUrl && apiResource?.ResourceARN) {
          const apiId = extractApiId(apiResource.ResourceARN);
          if (apiId) {
            apiUrl = yield* getApiUrl(apiId);
          }
        }

        const entries: StatusEntry[] = [];

        // Deployed + New: iterate code handlers
        for (const handler of codeHandlers) {
          const inAws = awsHandlers.find(h => h.name === handler.name);

          if (inAws) {
            // Deployed — get Lambda details
            let lambdaDetails: LambdaDetails | undefined;
            if (inAws.lambdaArn) {
              const functionName = extractFunctionName(inAws.lambdaArn);
              if (functionName) {
                lambdaDetails = yield* getLambdaDetails(functionName);
              }
            }

            entries.push({
              status: "deployed",
              name: handler.name,
              type: handler.type,
              method: handler.method,
              path: handler.path,
              lambda: lambdaDetails,
            });
          } else {
            // New
            entries.push({
              status: "new",
              name: handler.name,
              type: handler.type,
              method: handler.method,
              path: handler.path,
            });
          }
        }

        // Orphaned: in AWS but not in code
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
              status: "orphaned",
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

        // Sort: new first, then deployed, then orphaned
        const order = { new: 0, deployed: 1, orphaned: 2 };
        entries.sort((a, b) => order[a.status] - order[b.status]);

        for (const entry of entries) {
          yield* Console.log(formatEntry(entry));
        }

        if (apiUrl) {
          yield* Console.log(`\nAPI: ${c.cyan(apiUrl)}`);
        }

        const counts = {
          new: entries.filter(e => e.status === "new").length,
          deployed: entries.filter(e => e.status === "deployed").length,
          orphaned: entries.filter(e => e.status === "orphaned").length,
        };

        const parts: string[] = [];
        if (counts.new > 0) parts.push(c.yellow(`${counts.new} new`));
        if (counts.deployed > 0) parts.push(c.green(`${counts.deployed} deployed`));
        if (counts.orphaned > 0) parts.push(c.red(`${counts.orphaned} orphaned`));

        yield* Console.log(`\nTotal: ${parts.join(", ")}`);
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Show status of handlers (code vs deployed)"));
