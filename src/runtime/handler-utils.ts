import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import type { AnyParamRef } from "~/handlers/param";
import { createTableClient } from "./table-client";
import { getParameters } from "./ssm-client";
import { createPlatformClient } from "./platform-client";
import { truncateForStorage } from "./platform-types";

export const ENV_TABLE_PREFIX = "EFF_TABLE_";
export const ENV_PARAM_PREFIX = "EFF_PARAM_";

/**
 * Build resolved deps object from handler.deps and EFF_TABLE_* env vars.
 * Shared by wrap-http and wrap-table-stream.
 */
export const buildDeps = (deps: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!deps) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(deps)) {
    const tableName = process.env[`${ENV_TABLE_PREFIX}${key}`];
    if (!tableName) {
      throw new Error(`Missing environment variable ${ENV_TABLE_PREFIX}${key} for dep "${key}"`);
    }
    result[key] = createTableClient(tableName);
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
    result[propName] = ref?.transform ? ref.transform(raw) : raw;
  }

  return result;
};

export type HandlerRuntime = {
  commonArgs(): Promise<Record<string, unknown>>;
  logExecution(startTime: number, input: unknown, output: unknown): void;
  logError(startTime: number, input: unknown, error: unknown): void;
  handlerName: string;
};

/**
 * Read a static file bundled into the Lambda ZIP.
 * Path is relative to project root (matches the glob pattern used in `static`).
 */
export const readStatic = (filePath: string): string =>
  readFileSync(join(process.cwd(), filePath), "utf-8");

export const createHandlerRuntime = (
  handler: { context?: (...args: any[]) => any; deps?: any; params?: any; static?: string[] },
  handlerType: "http" | "table" | "site"
): HandlerRuntime => {
  const platform = createPlatformClient();
  const handlerName = process.env.EFF_HANDLER ?? "unknown";

  let ctx: unknown = null;
  let resolvedDeps: Record<string, unknown> | undefined;
  let resolvedParams: Record<string, unknown> | undefined | null = null;

  const getDeps = () => (resolvedDeps ??= buildDeps(handler.deps));

  const getParams = async () => {
    if (resolvedParams !== null) return resolvedParams;
    resolvedParams = await buildParams(handler.params);
    return resolvedParams;
  };

  const getCtx = async () => {
    if (ctx !== null) return ctx;
    if (handler.context) {
      const params = await getParams();
      ctx = params
        ? await handler.context({ params })
        : await handler.context();
    }
    return ctx;
  };

  const commonArgs = async (): Promise<Record<string, unknown>> => {
    const args: Record<string, unknown> = {};
    if (handler.context) args.ctx = await getCtx();
    const deps = getDeps();
    if (deps) args.deps = deps;
    const params = await getParams();
    if (params) args.params = params;
    if (handler.static) args.readStatic = readStatic;
    return args;
  };

  const logExecution = (startTime: number, input: unknown, output: unknown) => {
    platform?.appendExecution(handlerName, handlerType, {
      id: randomUUID(), ts: new Date().toISOString(), ms: Date.now() - startTime,
      in: input, out: truncateForStorage(output),
    });
  };

  const logError = (startTime: number, input: unknown, error: unknown) => {
    platform?.appendError(handlerName, handlerType, {
      id: randomUUID(), ts: new Date().toISOString(), ms: Date.now() - startTime,
      in: input, err: error instanceof Error ? error.message : String(error),
    });
  };

  return { commonArgs, logExecution, logError, handlerName };
};
