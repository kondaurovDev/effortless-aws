import { Effect } from "effect";
import * as path from "path";
import {
  Aws,
  ensureProjectApi,
  addRouteToApi,
  makeTags,
  resolveStage,
  type TagContext,
  ensureLayer,
  readProductionDependencies,
  collectLayerPackages
} from "../aws";
import { findHandlerFiles, discoverHandlers, type DiscoveredHandlers } from "~/build/bundle";

// Re-export from shared
export {
  type DeployResult,
  type DeployTableResult,
  type DeployAllResult,
  type DeployInput
} from "./shared";

// Re-export from deploy-http
export { deploy, deployAll } from "./deploy-http";

// Re-export from deploy-table
export { deployTable, deployAllTables } from "./deploy-table";

// Import for internal use
import { type DeployInput, type DeployResult, type DeployTableResult } from "./shared";
import { deployLambda } from "./deploy-http";
import { deployTableFunction } from "./deploy-table";

// ============ Layer preparation ============

type PrepareLayerInput = {
  project: string;
  region: string;
  projectDir: string;
};

const prepareLayer = (input: PrepareLayerInput) =>
  Effect.gen(function* () {
    const layerResult = yield* ensureLayer({
      project: input.project,
      region: input.region,
      projectDir: input.projectDir
    }).pipe(
      Effect.provide(
        Aws.makeClients({
          lambda: { region: input.region }
        })
      )
    );

    const prodDeps = layerResult
      ? yield* readProductionDependencies(input.projectDir)
      : [];
    const external = prodDeps.length > 0
      ? yield* Effect.promise(() => collectLayerPackages(input.projectDir, prodDeps))
      : [];

    yield* Effect.logDebug(`Layer result: ${layerResult ? "exists" : "null"}, external packages: ${external.length}`);
    if (external.length > 0) {
      yield* Effect.logInfo(`Bundling with ${external.length} external packages from layer`);
    }

    return {
      layerArn: layerResult?.layerVersionArn,
      external
    };
  });

// ============ HTTP handlers deployment ============

type DeployHttpHandlersInput = {
  handlers: DiscoveredHandlers["httpHandlers"];
  apiId: string;
  input: DeployProjectInput;
  layerArn: string | undefined;
  external: string[];
};

const deployHttpHandlers = (ctx: DeployHttpHandlersInput) =>
  Effect.gen(function* () {
    const results: DeployResult[] = [];

    for (const { file, exports } of ctx.handlers) {
      yield* Effect.logInfo(`Processing ${path.basename(file)} (${exports.length} HTTP handler(s))`);

      const deployInput: DeployInput = {
        projectDir: ctx.input.projectDir,
        file,
        project: ctx.input.project,
        region: ctx.input.region
      };
      if (ctx.input.stage) deployInput.stage = ctx.input.stage;

      for (const fn of exports) {
        const { exportName, functionArn, config } = yield* deployLambda({
          input: deployInput,
          fn,
          ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
          ...(ctx.external.length > 0 ? { external: ctx.external } : {})
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              iam: { region: ctx.input.region }
            })
          )
        );

        const { apiUrl: handlerUrl } = yield* addRouteToApi({
          apiId: ctx.apiId,
          region: ctx.input.region,
          functionArn,
          method: config.method,
          path: config.path
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              apigatewayv2: { region: ctx.input.region }
            })
          )
        );

        results.push({ exportName, url: handlerUrl, functionArn });
        yield* Effect.logInfo(`  ${config.method} ${config.path} → ${config.name}`);
      }
    }

    return results;
  });

// ============ Table handlers deployment ============

type DeployTableHandlersInput = {
  handlers: DiscoveredHandlers["tableHandlers"];
  input: DeployProjectInput;
  layerArn: string | undefined;
  external: string[];
};

const deployTableHandlers = (ctx: DeployTableHandlersInput) =>
  Effect.gen(function* () {
    const results: DeployTableResult[] = [];

    for (const { file, exports } of ctx.handlers) {
      yield* Effect.logInfo(`Processing ${path.basename(file)} (${exports.length} table handler(s))`);

      const deployInput: DeployInput = {
        projectDir: ctx.input.projectDir,
        file,
        project: ctx.input.project,
        region: ctx.input.region
      };
      if (ctx.input.stage) deployInput.stage = ctx.input.stage;

      for (const fn of exports) {
        const result = yield* deployTableFunction({
          input: deployInput,
          fn,
          ...(ctx.layerArn ? { layerArn: ctx.layerArn } : {}),
          ...(ctx.external.length > 0 ? { external: ctx.external } : {})
        }).pipe(
          Effect.provide(
            Aws.makeClients({
              lambda: { region: ctx.input.region },
              iam: { region: ctx.input.region },
              dynamodb: { region: ctx.input.region }
            })
          )
        );
        results.push(result);
      }
    }

    return results;
  });

// ============ Project deployment ============

export type DeployProjectInput = {
  projectDir: string;
  patterns: string[];
  project: string;
  stage?: string;
  region: string;
};

export type DeployProjectResult = {
  apiId?: string;
  apiUrl?: string;
  httpResults: DeployResult[];
  tableResults: DeployTableResult[];
};

export const deployProject = (input: DeployProjectInput) =>
  Effect.gen(function* () {
    // Discover handlers from file patterns
    const files = findHandlerFiles(input.patterns, input.projectDir);

    if (files.length === 0) {
      return yield* Effect.fail(new Error(`No files match patterns: ${input.patterns.join(", ")}`));
    }

    yield* Effect.logInfo(`Found ${files.length} file(s) matching patterns`);

    const { httpHandlers, tableHandlers } = discoverHandlers(files);

    const totalHttpHandlers = httpHandlers.reduce((acc, h) => acc + h.exports.length, 0);
    const totalTableHandlers = tableHandlers.reduce((acc, h) => acc + h.exports.length, 0);

    if (totalHttpHandlers === 0 && totalTableHandlers === 0) {
      return yield* Effect.fail(new Error("No handlers found in matched files"));
    }

    yield* Effect.logInfo(`Discovered ${totalHttpHandlers} HTTP handler(s) and ${totalTableHandlers} table handler(s)`);

    // Prepare layer
    const { layerArn, external } = yield* prepareLayer({
      project: input.project,
      region: input.region,
      projectDir: input.projectDir
    });

    // Setup API Gateway for HTTP handlers
    let apiId: string | undefined;
    let apiUrl: string | undefined;

    if (totalHttpHandlers > 0) {
      const tagCtx: TagContext = {
        project: input.project,
        stage: resolveStage(input.stage),
        handler: "api"
      };

      yield* Effect.logInfo("Setting up API Gateway...");
      const api = yield* ensureProjectApi({
        projectName: input.project,
        region: input.region,
        tags: makeTags(tagCtx, "api-gateway")
      }).pipe(
        Effect.provide(
          Aws.makeClients({
            apigatewayv2: { region: input.region }
          })
        )
      );

      apiId = api.apiId;
      apiUrl = `https://${apiId}.execute-api.${input.region}.amazonaws.com`;
    }

    // Deploy handlers
    const httpResults = apiId
      ? yield* deployHttpHandlers({
          handlers: httpHandlers,
          apiId,
          input,
          layerArn,
          external
        })
      : [];

    const tableResults = yield* deployTableHandlers({
      handlers: tableHandlers,
      input,
      layerArn,
      external
    });

    if (apiUrl) {
      yield* Effect.logInfo(`Deployment complete! API: ${apiUrl}`);
    }

    return { apiId, apiUrl, httpResults, tableResults };
  });
