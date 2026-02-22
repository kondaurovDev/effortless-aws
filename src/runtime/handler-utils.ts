import { readFileSync } from "fs";
import { join } from "path";
import type { AnyParamRef, LogLevel } from "~/helpers";
import { createTableClient } from "./table-client";
import { createBucketClient } from "./bucket-client";
import { getParameters } from "./ssm-client";

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
const DEP_FACTORIES: Record<string, (name: string, depHandler: unknown) => unknown> = {
  table: (name, depHandler) => {
    const tagField = (depHandler as { __spec?: { tagField?: string } } | undefined)?.__spec?.tagField;
    return createTableClient(name, tagField ? { tagField } : undefined);
  },
  bucket: (name) => createBucketClient(name),
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
export const buildDeps = (deps: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!deps) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(deps)) {
    const raw = process.env[`${ENV_DEP_PREFIX}${key}`];
    if (!raw) throw new Error(`Missing environment variable ${ENV_DEP_PREFIX}${key} for dep "${key}"`);
    const { type, name } = parseDepValue(raw);
    const factory = DEP_FACTORIES[type];
    if (!factory) throw new Error(`Unknown dep type "${type}" for dep "${key}"`);
    result[key] = factory(name, deps[key]);
  }
  return result;
};

/**
 * Build resolved params object from EFF_PARAM_* env vars and SSM GetParameters.
 * Fetches all parameter values in batch, applies transforms from handler.params.
 */
export const buildParams = async (
  params: Record<string, AnyParamRef> | undefined
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
  const values = await getParameters(entries.map(e => e.ssmPath));

  // Apply transforms
  const result: Record<string, unknown> = {};
  for (const { propName, ssmPath } of entries) {
    const raw = values.get(ssmPath) ?? "";
    const ref = params[propName];
    result[propName] = typeof ref === "object" && ref?.transform ? ref.transform(raw) : raw;
  }

  return result;
};

export type HandlerRuntime = {
  commonArgs(): Promise<Record<string, unknown>>;
  logExecution(startTime: number, input: unknown, output: unknown): void;
  logError(startTime: number, input: unknown, error: unknown): void;
  patchConsole(): void;
  restoreConsole(): void;
  handlerName: string;
};

/**
 * Read a static file bundled into the Lambda ZIP.
 * Path is relative to project root (matches the glob pattern used in `static`).
 */
export const readStatic = (filePath: string): string =>
  readFileSync(join(process.cwd(), filePath), "utf-8");

export const createHandlerRuntime = (
  handler: { setup?: (...args: any[]) => any; deps?: any; config?: any; static?: string[] },
  handlerType: "http" | "table" | "app" | "fifo-queue" | "bucket",
  logLevel: LogLevel = "info",
  extraSetupArgs?: () => Record<string, unknown>
): HandlerRuntime => {
  const handlerName = process.env.EFF_HANDLER ?? "unknown";
  const rank = LOG_RANK[logLevel];

  let ctx: unknown = null;
  let resolvedDeps: Record<string, unknown> | undefined;
  let resolvedParams: Record<string, unknown> | undefined | null = null;

  const getDeps = () => (resolvedDeps ??= buildDeps(handler.deps));

  const getParams = async () => {
    if (resolvedParams !== null) return resolvedParams;
    resolvedParams = await buildParams(handler.config);
    return resolvedParams;
  };

  const getSetup = async () => {
    if (ctx !== null) return ctx;
    if (handler.setup) {
      const params = await getParams();
      const deps = getDeps();
      const args: Record<string, unknown> = {};
      if (params) args.config = params;
      if (deps) args.deps = deps;
      if (extraSetupArgs) Object.assign(args, extraSetupArgs());
      ctx = await handler.setup(args);
    }
    return ctx;
  };

  const commonArgs = async (): Promise<Record<string, unknown>> => {
    const args: Record<string, unknown> = {};
    if (handler.setup) args.ctx = await getSetup();
    const deps = getDeps();
    if (deps) args.deps = deps;
    const params = await getParams();
    if (params) args.config = params;
    if (handler.static) args.readStatic = readStatic;
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

  return { commonArgs, logExecution, logError, patchConsole, restoreConsole, handlerName };
};
