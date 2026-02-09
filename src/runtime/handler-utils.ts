import type { AnyParamRef } from "~/handlers/param";
import { createTableClient } from "./table-client";
import { getParameters } from "./ssm-client";

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
