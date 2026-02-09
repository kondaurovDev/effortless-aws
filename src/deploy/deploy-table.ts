import { Effect } from "effect";
import { extractTableConfigs, type ExtractedTableFunction } from "~/build/bundle";
import {
  Aws,
  ensureTable,
  ensureEventSourceMapping,
  makeTags,
  resolveStage,
  type TagContext
} from "../aws";
import {
  type DeployInput,
  type DeployTableResult,
  readSource,
  deployCoreLambda,
  ensureLayerAndExternal
} from "./shared";

// ============ Table handler deployment ============

type DeployTableFunctionInput = {
  input: DeployInput;
  fn: ExtractedTableFunction;
  layerArn?: string;
  external?: string[];
  depsEnv?: Record<string, string>;
  depsPermissions?: readonly string[];
};

const TABLE_DEFAULT_PERMISSIONS = ["dynamodb:*", "logs:*"] as const;

/** @internal */
export const deployTableFunction = ({ input, fn, layerArn, external, depsEnv, depsPermissions }: DeployTableFunctionInput) =>
  Effect.gen(function* () {
    const { exportName, config } = fn;
    const handlerName = config.name ?? exportName;

    const tagCtx: TagContext = {
      project: input.project,
      stage: resolveStage(input.stage),
      handler: handlerName
    };

    yield* Effect.logInfo("Creating DynamoDB table...");
    const tableName = `${input.project}-${tagCtx.stage}-${handlerName}`;
    const { tableArn, streamArn } = yield* ensureTable({
      name: tableName,
      pk: config.pk,
      sk: config.sk,
      billingMode: config.billingMode ?? "PAY_PER_REQUEST",
      streamView: config.streamView ?? "NEW_AND_OLD_IMAGES",
      tags: makeTags(tagCtx, "dynamodb")
    });

    // Merge EFF_TABLE_SELF (own table name) into deps env vars
    const selfEnv: Record<string, string> = { EFF_TABLE_SELF: tableName, ...depsEnv };

    const { functionArn } = yield* deployCoreLambda({
      input,
      exportName,
      handlerName,
      defaultPermissions: TABLE_DEFAULT_PERMISSIONS,
      bundleType: "table",
      ...(config.permissions ? { permissions: config.permissions } : {}),
      ...(config.memory ? { memory: config.memory } : {}),
      ...(config.timeout ? { timeout: config.timeout } : {}),
      ...(layerArn ? { layerArn } : {}),
      ...(external ? { external } : {}),
      depsEnv: selfEnv,
      ...(depsPermissions ? { depsPermissions } : {})
    });

    yield* Effect.logInfo("Setting up event source mapping...");
    yield* ensureEventSourceMapping({
      functionArn,
      streamArn,
      batchSize: config.batchSize ?? 100,
      batchWindow: config.batchWindow ?? 2,
      startingPosition: config.startingPosition ?? "LATEST"
    });

    yield* Effect.logInfo(`Table deployment complete! Table: ${tableArn}`);

    return {
      exportName,
      functionArn,
      tableArn,
      streamArn
    } satisfies DeployTableResult;
  });

export const deployTable = (input: DeployInput) =>
  Effect.gen(function* () {
    const source = yield* readSource(input);
    const configs = extractTableConfigs(source);

    if (configs.length === 0) {
      return yield* Effect.fail(new Error("No defineTable exports found in source"));
    }

    // Find specific export or use first one
    const targetExport = input.exportName ?? "default";
    const fn = configs.find(c => c.exportName === targetExport) ?? configs[0]!;

    // Ensure layer exists
    const { layerArn, external } = yield* ensureLayerAndExternal({
      project: input.project,
      stage: resolveStage(input.stage),
      region: input.region,
      projectDir: input.projectDir
    });

    const result = yield* deployTableFunction({
      input,
      fn,
      ...(layerArn ? { layerArn } : {}),
      ...(external.length > 0 ? { external } : {})
    });

    return result;
  }).pipe(
    Effect.provide(
      Aws.makeClients({
        lambda: { region: input.region },
        iam: { region: input.region },
        dynamodb: { region: input.region }
      })
    )
  );

export const deployAllTables = (input: DeployInput) =>
  Effect.gen(function* () {
    const source = yield* readSource(input);
    const functions = extractTableConfigs(source);

    if (functions.length === 0) {
      return yield* Effect.fail(new Error("No defineTable exports found in source"));
    }

    yield* Effect.logInfo(`Found ${functions.length} table handler(s) to deploy`);

    // Ensure layer exists
    const { layerArn, external } = yield* ensureLayerAndExternal({
      project: input.project,
      stage: resolveStage(input.stage),
      region: input.region,
      projectDir: input.projectDir
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
        lambda: { region: input.region },
        iam: { region: input.region },
        dynamodb: { region: input.region }
      })
    )
  );
