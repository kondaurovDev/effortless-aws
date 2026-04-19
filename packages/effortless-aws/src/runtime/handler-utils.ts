import { readFileSync } from "fs";
import { join } from "path";
import type { LogLevel, Duration } from "../handlers/handler-options";
import { toSeconds } from "../handlers/handler-options";
import type { AuthRuntime, CfSigningConfig } from "../handlers/auth";

// Lazy imports — AWS SDK clients are loaded only when actually needed.
// This avoids loading DynamoDB, S3, SES, SQS, ECS, SSM SDKs on cold start
// for handlers that don't use them.

const lazyTableClient = async (name: string, opts?: { tagField?: string }) => {
  const { createTableClient } = await import("./table-client");
  return createTableClient(name, opts);
};

const lazyBucketClient = async (name: string) => {
  const { createBucketClient } = await import("./bucket-client");
  return createBucketClient(name);
};

const lazyBucketClientWithEntities = async (name: string, config: Record<string, { cacheSeconds?: number }>) => {
  const { createBucketClientWithEntities } = await import("./bucket-client");
  return createBucketClientWithEntities(name, config);
};

const lazyEmailClient = async () => {
  const { createEmailClient } = await import("./email-client");
  return createEmailClient();
};

const lazyQueueClient = async (name: string) => {
  const { createQueueClient } = await import("./queue-client");
  return createQueueClient(name);
};

const lazyWorkerClient = async (name: string) => {
  const { createWorkerClient } = await import("./worker-client");
  return createWorkerClient(name);
};

const lazyGetParameters = async (paths: string[]) => {
  const { getParameters } = await import("./ssm-client");
  return getParameters(paths);
};

const lazyCreateAuthRuntime = async (
  secret: string,
  defaultExpiresIn: number,
  apiTokenVerify?: (args: { value: string }) => unknown | Promise<unknown>,
  apiTokenHeader?: string,
  apiTokenCacheTtlSeconds?: number,
  cfSigningConfig?: CfSigningConfig,
) => {
  const { createAuthRuntime } = await import("../handlers/auth");
  return createAuthRuntime(secret, defaultExpiresIn, apiTokenVerify, apiTokenHeader, apiTokenCacheTtlSeconds, cfSigningConfig);
};

export type { LogLevel };

export const ENV_DEP_PREFIX = "EFF_DEP_";
export const ENV_PARAM_PREFIX = "EFF_PARAM_";

const LOG_RANK: Record<LogLevel, number> = { error: 0, info: 1, debug: 2 };

const truncate = (value: unknown, maxLength = 4096): unknown => {
  if (value === undefined || value === null) return value;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxLength) return value;
  return str.slice(0, maxLength) + "...[truncated]";
};

/**
 * Registry of dep type → client factory.
 * To add a new dep type, add a single entry here.
 */
const DEP_FACTORIES: Record<string, (name: string, depHandler: unknown) => Promise<unknown>> = {
  table: (name, depHandler) => {
    const tagField = (depHandler as { __spec?: { tagField?: string } } | undefined)?.__spec?.tagField;
    return lazyTableClient(name, tagField ? { tagField } : undefined);
  },
  bucket: (name, depHandler) => {
    const entities = (depHandler as { __spec?: { entities?: Record<string, { cache?: Duration }> } } | undefined)?.__spec?.entities;
    if (entities && Object.keys(entities).length > 0) {
      const config: Record<string, { cacheSeconds?: number }> = {};
      for (const [entityName, entityOpts] of Object.entries(entities)) {
        config[entityName] = entityOpts.cache ? { cacheSeconds: toSeconds(entityOpts.cache) } : {};
      }
      return lazyBucketClientWithEntities(name, config);
    }
    return lazyBucketClient(name);
  },
  mailer: () => lazyEmailClient(),
  queue: (name) => lazyQueueClient(name),
  worker: (name) => lazyWorkerClient(name),
};

/**
 * Parse "type:resourceName" from an EFF_DEP_ env var value.
 */
export const parseDepValue = (raw: string): { type: string; name: string } => {
  const idx = raw.indexOf(":");
  return { type: raw.slice(0, idx), name: raw.slice(idx + 1) };
};

/**
 * Build resolved deps object from handler.deps and EFF_DEP_* env vars.
 * Shared by all runtime wrappers.
 */
type DepsInput = Record<string, unknown> | (() => Record<string, unknown>) | undefined;

const resolveDepsInput = (deps: DepsInput): Record<string, unknown> | undefined =>
  typeof deps === "function" ? deps() : deps;

export const buildDeps = async (rawDeps: DepsInput): Promise<Record<string, unknown> | undefined> => {
  const deps = resolveDepsInput(rawDeps);
  if (!deps) return undefined;
  const result: Record<string, unknown> = {};
  const entries = Object.keys(deps).map(key => {
    const raw = process.env[`${ENV_DEP_PREFIX}${key}`];
    if (!raw) throw new Error(`Missing environment variable ${ENV_DEP_PREFIX}${key} for dep "${key}"`);
    const { type, name } = parseDepValue(raw);
    const factory = DEP_FACTORIES[type];
    if (!factory) throw new Error(`Unknown dep type "${type}" for dep "${key}"`);
    return { key, promise: factory(name, deps[key]) };
  });
  for (const { key, promise } of entries) {
    result[key] = await promise;
  }
  return result;
};

/**
 * Build resolved params object from EFF_PARAM_* env vars and SSM GetParameters.
 * Fetches all parameter values in batch, applies transforms from handler.params.
 */
export const buildParams = async (
  params: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | undefined> => {
  if (!params) return undefined;

  // Collect EFF_PARAM_* env vars
  const entries: { propName: string; ssmPath: string }[] = [];
  for (const propName of Object.keys(params)) {
    const ssmPath = process.env[`${ENV_PARAM_PREFIX}${propName}`];
    if (!ssmPath) {
      throw new Error(`Missing environment variable ${ENV_PARAM_PREFIX}${propName} for param "${propName}"`);
    }
    entries.push({ propName, ssmPath });
  }

  if (entries.length === 0) return undefined;

  // Batch fetch from SSM
  const values = await lazyGetParameters(entries.map(e => e.ssmPath));

  // Apply transforms
  const result: Record<string, unknown> = {};
  for (const { propName, ssmPath } of entries) {
    const raw = values.get(ssmPath) ?? "";
    const ref = params[propName];
    const transform = typeof ref === "object" && ref !== null && "transform" in ref && typeof (ref as Record<string, unknown>).transform === "function"
      ? (ref as { transform: (v: string) => unknown }).transform
      : undefined;
    result[propName] = transform ? transform(raw) : raw;
  }

  return result;
};

export type HandlerRuntime = {
  /** Run full init chain (deps → params → auth → setup) during INIT phase. */
  preload(): Promise<void>;
  commonArgs(cookieValue?: string, authHeader?: string, headers?: Record<string, string | undefined>): Promise<Record<string, unknown>>;
  logExecution(startTime: number, input: unknown, output: unknown): void;
  logError(startTime: number, input: unknown, error: unknown): void;
  patchConsole(): void;
  restoreConsole(): void;
  handlerName: string;
};

/**
 * Static file helpers — paths are relative to project root
 * (matching the glob patterns declared in `static`).
 */
const resolvePath = (filePath: string): string => join(process.cwd(), filePath);

/** Singleton files service — stateless, safe to reuse */
const staticFiles = {
  read: (filePath: string): string => readFileSync(resolvePath(filePath), "utf-8"),
  readBuffer: (filePath: string): Buffer => readFileSync(resolvePath(filePath)),
  path: resolvePath,
};

export const createHandlerRuntime = (
  handler: { setup?: (...args: any[]) => any; authFn?: (...args: any[]) => any; deps?: DepsInput; config?: Record<string, unknown>; static?: string[] },
  handlerType: "http" | "table" | "app" | "queue" | "bucket" | "api" | "cron" | "mcp",
  logLevel: LogLevel = "info",
  extraSetupArgs?: () => Record<string, unknown> | Promise<Record<string, unknown>>
): HandlerRuntime => {
  const handlerName = process.env.EFF_HANDLER ?? "unknown";
  const rank = LOG_RANK[logLevel];

  let ctx: unknown = null;
  let resolvedAuthRuntime: AuthRuntime | undefined | null = null;

  // Shared promises ensure each step runs at most once,
  // whether called from preload() during INIT or from commonArgs() on first invoke.
  let depsPromise: Promise<Record<string, unknown> | undefined> | null = null;
  const getDeps = () => (depsPromise ??= buildDeps(handler.deps));

  let configPromise: Promise<Record<string, unknown> | undefined> | null = null;
  const getConfig = () => (configPromise ??= buildParams(handler.config));

  let resolvedCfSigningConfig: CfSigningConfig | undefined | null = null;

  const getCfSigningConfig = async (): Promise<CfSigningConfig | undefined> => {
    if (resolvedCfSigningConfig !== null) return resolvedCfSigningConfig;
    const cfSigningKeySsmPath = process.env.EFF_CF_SIGNING_KEY;
    const cfKeyPairId = process.env.EFF_CF_KEY_PAIR_ID;
    const cfDomain = process.env.EFF_CF_DOMAIN;
    if (!cfSigningKeySsmPath || !cfKeyPairId || !cfDomain) {
      resolvedCfSigningConfig = undefined;
      return undefined;
    }
    const values = await lazyGetParameters([cfSigningKeySsmPath]);
    const privateKey = values.get(cfSigningKeySsmPath);
    if (!privateKey) {
      resolvedCfSigningConfig = undefined;
      return undefined;
    }
    resolvedCfSigningConfig = { privateKey, keyPairId: cfKeyPairId, domain: cfDomain };
    return resolvedCfSigningConfig;
  };

  const getAuthRuntime = async () => {
    if (resolvedAuthRuntime !== null) return resolvedAuthRuntime;
    // Auth config comes from handler.authFn (set by .auth() builder method)
    if (!handler.authFn) { resolvedAuthRuntime = undefined; return undefined; }
    const config = await getConfig();
    const deps = await getDeps();
    const authArgs: Record<string, unknown> = {};
    if (config) authArgs.config = config;
    if (deps) authArgs.deps = deps;
    const authOpts = await handler.authFn(authArgs) as { secret?: string; expiresIn?: Duration; apiToken?: { header?: string; verify?: (value: string) => any; cacheTtl?: Duration } } | undefined;
    if (!authOpts?.secret) { resolvedAuthRuntime = undefined; return undefined; }
    const secret = authOpts.secret;
    resolvedAuthHeaderName = authOpts.apiToken?.header;
    const defaultExpires = authOpts.expiresIn ? toSeconds(authOpts.expiresIn) : 604800; // 7 days
    const apiToken = authOpts.apiToken;
    const cacheTtlSeconds = apiToken?.cacheTtl ? toSeconds(apiToken.cacheTtl as Duration) : undefined;
    const rawVerify = apiToken?.verify;
    const wrappedVerify = rawVerify
      ? (args: { value: string }) => rawVerify(args.value)
      : undefined;
    const cfSigningConfig = await getCfSigningConfig();
    resolvedAuthRuntime = await lazyCreateAuthRuntime(
      secret,
      defaultExpires,
      wrappedVerify,
      apiToken?.header,
      cacheTtlSeconds,
      cfSigningConfig,
    );
    return resolvedAuthRuntime;
  };

  const getSetup = async () => {
    if (ctx !== null) return ctx;
    if (handler.setup) {
      const config = await getConfig();
      const deps = await getDeps();
      const args: Record<string, unknown> = {};
      if (config) args.config = config;
      if (deps) args.deps = deps;
      if (handler.static) args.files = staticFiles;
      if (extraSetupArgs) Object.assign(args, await extraSetupArgs());
      ctx = await handler.setup(args);
    }
    return ctx;
  };

  let resolvedAuthHeaderName: string | undefined;

  const commonArgs = async (cookieValue?: string, authHeader?: string, headers?: Record<string, string | undefined>): Promise<Record<string, unknown>> => {
    const args: Record<string, unknown> = {};
    if (handler.setup) args.ctx = await getSetup();
    const deps = await getDeps();
    if (deps) args.deps = deps;
    const config = await getConfig();
    if (config) args.config = config;
    if (handler.static) args.files = staticFiles;
    const authRuntime = await getAuthRuntime();
    if (authRuntime) {
      // For callback auth, resolve the header name from resolved auth options on first call
      let finalAuthHeader = authHeader;
      if (finalAuthHeader === undefined && headers && resolvedAuthHeaderName) {
        finalAuthHeader = headers[resolvedAuthHeaderName] ?? headers[resolvedAuthHeaderName.toLowerCase()] ?? undefined;
      }
      args.auth = await authRuntime.forRequest(cookieValue, finalAuthHeader);
    }
    return args;
  };

  const logExecution = (startTime: number, input: unknown, output: unknown) => {
    if (rank < LOG_RANK.info) return;
    const entry: Record<string, unknown> = {
      level: "info", handler: handlerName, type: handlerType, ms: Date.now() - startTime,
    };
    if (rank >= LOG_RANK.debug) {
      entry.input = truncate(input);
      entry.output = truncate(output);
    }
    console.log(JSON.stringify(entry));
  };

  const logError = (startTime: number, input: unknown, error: unknown) => {
    const entry: Record<string, unknown> = {
      level: "error", handler: handlerName, type: handlerType, ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
    if (rank >= LOG_RANK.debug) {
      entry.input = truncate(input);
    }
    console.error(JSON.stringify(entry));
  };

  // Console interception: suppress developer logs below configured logLevel
  const noop = () => {};
  const saved = { log: console.log, info: console.info, debug: console.debug };

  const patchConsole = () => {
    if (rank < LOG_RANK.debug) console.debug = noop;
    if (rank < LOG_RANK.info) { console.log = noop; console.info = noop; }
  };

  const restoreConsole = () => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
  };

  const preload = async () => {
    await getDeps();
    await getConfig();
    await getAuthRuntime();
    await getSetup();
  };

  return { preload, commonArgs, logExecution, logError, patchConsole, restoreConsole, handlerName };
};
