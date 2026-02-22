import { Effect } from "effect";
import { ssm } from "~/aws/clients";
import type { DiscoveredHandlers } from "~/build/bundle";
import type { ParamEntry } from "~/build/handler-registry";

export type RequiredParam = {
  ssmPath: string;
  propName: string;
  ssmKey: string;
  handlerName: string;
};

/**
 * Collect all required SSM parameter paths from discovered handlers.
 * Deduplicates by ssmPath (same key used by multiple handlers is listed once).
 */
export const collectRequiredParams = (
  handlers: DiscoveredHandlers,
  project: string,
  stage: string,
): RequiredParam[] => {
  const seen = new Map<string, RequiredParam>();

  const collect = (
    handlerGroups: { exports: { exportName: string; paramEntries: ParamEntry[] }[] }[],
  ) => {
    for (const { exports } of handlerGroups) {
      for (const fn of exports) {
        for (const { propName, ssmKey } of fn.paramEntries) {
          const ssmPath = `/${project}/${stage}/${ssmKey}`;
          if (!seen.has(ssmPath)) {
            seen.set(ssmPath, {
              ssmPath,
              propName,
              ssmKey,
              handlerName: fn.exportName,
            });
          }
        }
      }
    }
  };

  collect(handlers.httpHandlers);
  collect(handlers.tableHandlers);
  collect(handlers.fifoQueueHandlers);
  collect(handlers.bucketHandlers);

  return Array.from(seen.values());
};

/**
 * Check which SSM parameters exist and which are missing.
 * Uses the generated SSM Effect client — requires SSMClient layer.
 */
export const checkMissingParams = (params: RequiredParam[]) =>
  Effect.gen(function* () {
    if (params.length === 0) return { existing: [] as RequiredParam[], missing: [] as RequiredParam[] };

    const existingNames = new Set<string>();

    // SSM GetParameters supports max 10 names per call
    for (let i = 0; i < params.length; i += 10) {
      const batch = params.slice(i, i + 10);
      const result = yield* ssm.make("get_parameters", {
        Names: batch.map(p => p.ssmPath),
        WithDecryption: false,
      });
      for (const p of result.Parameters ?? []) {
        if (p.Name) existingNames.add(p.Name);
      }
    }

    const existing: RequiredParam[] = [];
    const missing: RequiredParam[] = [];
    for (const p of params) {
      if (existingNames.has(p.ssmPath)) {
        existing.push(p);
      } else {
        missing.push(p);
      }
    }

    return { existing, missing };
  });
