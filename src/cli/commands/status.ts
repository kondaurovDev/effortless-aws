import { Command } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option } from "effect";

import {
  Aws,
  getResourcesByTags,
  groupResourcesByHandler
} from "../../aws";
import { loadConfig, projectOption, stageOption, regionOption, verboseOption } from "~/cli/config";

const { lambda, apigatewayv2: apigateway } = Aws;

type ResourceDetails = {
  type: string;
  arn: string;
  lastModified?: string;
  memory?: number;
  timeout?: number;
  runtime?: string;
  url?: string;
};

const extractApiId = (arn: string): string | undefined => {
  // arn:aws:apigateway:eu-central-1::/apis/o4epasmyie
  const match = arn.match(/\/apis\/([a-z0-9]+)$/);
  return match?.[1];
};

const extractFunctionName = (arn: string): string | undefined => {
  // arn:aws:lambda:eu-central-1:906667703291:function:family-budget-expense-api
  const match = arn.match(/:function:([^:]+)$/);
  return match?.[1];
};

const formatDate = (date: Date | string | undefined): string => {
  if (!date) return "unknown";
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

type LambdaDetails = {
  lastModified?: string;
  memory?: number;
  timeout?: number;
  runtime?: string;
};

type ApiDetails = {
  url?: string;
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
      runtime: config.Runtime,
    } as LambdaDetails;
  }).pipe(
    Effect.catchAll(() => Effect.succeed({} as LambdaDetails))
  );

const getApiGatewayDetails = (apiId: string) =>
  Effect.gen(function* () {
    const api = yield* apigateway.make("get_api", { ApiId: apiId });
    return {
      url: api.ApiEndpoint,
    } as ApiDetails;
  }).pipe(
    Effect.catchAll(() => Effect.succeed({} as ApiDetails))
  );

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
        iam: { region: finalRegion },
        apigatewayv2: { region: finalRegion },
        dynamodb: { region: finalRegion },
        resource_groups_tagging_api: { region: finalRegion },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;

      yield* Effect.gen(function* () {
        yield* Console.log(`\nStatus for ${project}/${finalStage}:\n`);

        const resources = yield* getResourcesByTags(project, finalStage);

        if (resources.length === 0) {
          yield* Console.log("No resources found.");
          return;
        }

        const byHandler = groupResourcesByHandler(resources);

        for (const [handler, handlerResources] of byHandler) {
          yield* Console.log(`${handler}:`);

          for (const resource of handlerResources) {
            const typeTag = resource.Tags?.find(t => t.Key === "effortless:type");
            const type = typeTag?.Value ?? "unknown";
            const arn = resource.ResourceARN ?? "";

            let details: ResourceDetails = { type, arn };

            if (type === "lambda") {
              const functionName = extractFunctionName(arn);
              if (functionName) {
                const lambdaDetails = yield* getLambdaDetails(functionName);
                details = { ...details, ...lambdaDetails };
              }
            } else if (type === "api-gateway") {
              const apiId = extractApiId(arn);
              if (apiId) {
                const apiDetails = yield* getApiGatewayDetails(apiId);
                details = { ...details, ...apiDetails };
              }
            }

            // Format output based on resource type
            if (type === "lambda" && details.lastModified) {
              const memStr = details.memory ? `${details.memory}MB` : "";
              const timeoutStr = details.timeout ? `${details.timeout}s` : "";
              const runtimeStr = details.runtime ?? "";
              const config = [memStr, timeoutStr, runtimeStr].filter(Boolean).join(", ");
              yield* Console.log(`  [${type}] ${arn}`);
              yield* Console.log(`           deployed: ${formatDate(details.lastModified)} | ${config}`);
            } else if (type === "api-gateway" && details.url) {
              yield* Console.log(`  [${type}] ${details.url}`);
            } else {
              yield* Console.log(`  [${type}] ${arn}`);
            }
          }
          yield* Console.log("");
        }

        yield* Console.log(`Total: ${resources.length} resource(s)`);
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Show status of deployed resources"));
