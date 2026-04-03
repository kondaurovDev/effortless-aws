import { Effect } from "effect";
import { ssm } from "~/aws/clients";
import type { DiscoveredHandlers } from "~/build/bundle";
import type { SecretEntry } from "~/build/handler-registry";

export type RequiredSecret = {
  ssmPath: string;
  propName: string;
  ssmKey: string;
  handlerName: string;
  generate?: string;
};

/**
 * Collect all required SSM parameter paths from discovered handlers.
 * Deduplicates by ssmPath (same key used by multiple handlers is listed once).
 */
export const collectRequiredSecrets = (
  handlers: DiscoveredHandlers,
  project: string,
  stage: string,
): RequiredSecret[] => {
  const seen = new Map<string, RequiredSecret>();

  const collect = (
    handlerGroups: { exports: { exportName: string; secretEntries: SecretEntry[] }[] }[],
  ) => {
    for (const { exports } of handlerGroups) {
      for (const fn of exports) {
        for (const { propName, ssmKey, generate } of fn.secretEntries) {
          const ssmPath = `/${project}/${stage}/${ssmKey}`;
          if (!seen.has(ssmPath)) {
            seen.set(ssmPath, {
              ssmPath,
              propName,
              ssmKey,
              handlerName: fn.exportName,
              ...(generate ? { generate } : {}),
            });
          }
        }
      }
    }
  };

  collect(handlers.tableHandlers);
  collect(handlers.fifoQueueHandlers);
  collect(handlers.bucketHandlers);
  collect(handlers.apiHandlers);
  collect(handlers.cronHandlers);
  collect(handlers.workerHandlers);
  collect(handlers.mcpHandlers);

  return Array.from(seen.values());
};


/**
 * Check which SSM parameters exist and which are missing.
 * Uses the generated SSM Effect client — requires SSMClient layer.
 */
export const checkMissingSecrets = (secrets: RequiredSecret[]) =>
  Effect.gen(function* () {
    if (secrets.length === 0) return { existing: [] as RequiredSecret[], missing: [] as RequiredSecret[] };

    const existingNames = new Set<string>();

    // SSM GetParameters supports max 10 names per call
    for (let i = 0; i < secrets.length; i += 10) {
      const batch = secrets.slice(i, i + 10);
      const result = yield* ssm.make("get_parameters", {
        Names: batch.map(p => p.ssmPath),
        WithDecryption: false,
      });
      for (const p of result.Parameters ?? []) {
        if (p.Name) existingNames.add(p.Name);
      }
    }

    const existing: RequiredSecret[] = [];
    const missing: RequiredSecret[] = [];
    for (const p of secrets) {
      if (existingNames.has(p.ssmPath)) {
        existing.push(p);
      } else {
        missing.push(p);
      }
    }

    return { existing, missing };
  });

