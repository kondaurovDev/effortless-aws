import { Effect } from "effect";
import { toSeconds } from "effortless-aws";
import { extractConfigsFromFile, type ExtractedTableFunction } from "~/discovery";
import { Aws, ensureTable, ensureEventSourceMapping } from "../aws";
import { makeTags, type TagContext } from "../core";
import { DeployContext } from "../core";
import {
  type DeployInput,
  deployCoreLambda,
  ensureLayerAndExternal,
  resolveSecrets,
} from "./shared";

// ============ Table handler deployment ============

type DeployTableFunctionInput = {
  input: DeployInput;
  fn: ExtractedTableFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
  staticGlobs?: string[];
};

const TABLE_DEFAULT_PERMISSIONS = ["dynamodb:*", "logs:*"] as const;

/** @internal */
export const deployTableFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions, staticGlobs }: DeployTableFunctionInput) =>
  Effect.gen(function* () {
    const { project, stage } = yield* DeployContext;
    const { exportName, config, hasHandler } = fn;
    const handlerName = exportName;

    const tagCtx: TagContext = {
      project,
      stage,
      handler: handlerName
    };

    yield* Effect.logDebug("Creating DynamoDB table...");
    const tableName = `${project}-${stage}-${handlerName}`;
    const { tableArn, streamArn, created } = yield* ensureTable({
      name: tableName,
      billingMode: config.billingMode ?? "PAY_PER_REQUEST",
      streamView: config.streamView ?? "NEW_AND_OLD_IMAGES",
      tags: makeTags(tagCtx)
    });

    // Resource-only mode: no Lambda, just the table
    if (!hasHandler) {
      yield* Effect.logDebug(`Table deployment complete (resource-only)! Table: ${tableArn}`);
      return {
        exportName,
        status: (created ? "created" : "unchanged") as "created" | "unchanged",
        tableArn,
      };
    }

    // Merge EFF_DEP_SELF (own table name) into deps env vars
    const selfEnv: Record<string, string> = { EFF_DEP_SELF: `table:${tableName}`, ...depsEnv };

    const { functionArn, status, bundleSize } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      defaultPermissions: TABLE_DEFAULT_PERMISSIONS,
      bundleType: "table",
      ...(config.lambda?.permissions ? { permissions: config.lambda.permissions } : {}),
      ...(config.lambda?.memory ? { memory: config.lambda.memory } : {}),
      ...(config.lambda?.timeout ? { timeout: toSeconds(config.lambda.timeout) } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      depsEnv: selfEnv,
      ...(depsPermissions ? { depsPermissions } : {}),
      ...(staticGlobs && staticGlobs.length > 0 ? { staticGlobs } : {})
    });

    yield* Effect.logDebug("Setting up event source mapping...");
    yield* ensureEventSourceMapping({
      functionArn,
      streamArn,
      batchSize: config.batchSize ?? 100,
      batchWindow: toSeconds(config.batchWindow ?? 2),
      startingPosition: config.startingPosition ?? "LATEST"
    });

    yield* Effect.logDebug(`Table deployment complete! Table: ${tableArn}`);

    return {
      exportName,
      functionArn,
      status,
      bundleSize,
      tableArn,
      streamArn
    };
  });

export const deployTable = (input: DeployInput) =>
  Effect.flatMap(DeployContext, ({ project, stage, region }) =>
    Effect.gen(function* () {
      const configs = yield* extractConfigsFromFile<import("effortless-aws").TableConfig>(input.file, "table");

      if (configs.length === 0) {
        return yield* Effect.fail(new Error("No defineTable exports found in source"));
      }

      // Find specific export or use first one
      const targetExport = input.exportName ?? "default";
      const fn = configs.find(c => c.exportName === targetExport) ?? configs[0]!;

      // Ensure layer exists
      const { layerArn, external } = yield* ensureLayerAndExternal({
        projectDir: input.projectDir,
        file: input.file,
      });

      // Resolve secrets into EFF_PARAM_* env vars
      const secrets = resolveSecrets(fn.secretEntries, project, stage);

      const result = yield* deployTableFunction({
        input,
        fn,
        ...(layerArn ? { layerArn } : {}),
        ...(external.length > 0 ? { external } : {}),
        ...(secrets ? { depsEnv: secrets.paramsEnv, depsPermissions: secrets.paramsPermissions } : {}),
      });

      return result;
    }).pipe(
      Effect.provide(
        Aws.makeClients({
          lambda: { region },
          iam: { region },
          dynamodb: { region }
        })
      )
    )
  );

export const deployAllTables = (input: DeployInput) =>
  Effect.flatMap(DeployContext, ({ region }) =>
    Effect.gen(function* () {
      const functions = yield* extractConfigsFromFile<import("effortless-aws").TableConfig>(input.file, "table");

      if (functions.length === 0) {
        return yield* Effect.fail(new Error("No defineTable exports found in source"));
      }

      yield* Effect.logDebug(`Found ${functions.length} table handler(s) to deploy`);

      // Ensure layer exists
      const { layerArn, external } = yield* ensureLayerAndExternal({
        projectDir: input.projectDir,
        file: input.file,
      });

      const results = yield* Effect.forEach(
        functions,
        fn => deployTableFunction({
          input,
          fn,
          ...(layerArn ? { layerArn } : {}),
          ...(external.length > 0 ? { external } : {})
        }),
        { concurrency: 1 }
      );

      return results;
    }).pipe(
      Effect.provide(
        Aws.makeClients({
          lambda: { region },
          iam: { region },
          dynamodb: { region }
        })
      )
    )
  );
