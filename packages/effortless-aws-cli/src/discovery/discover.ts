/**
 * Multi-file handler discovery — orchestrates AST extraction across project files
 * and resolves cross-file references (static site routes).
 */

import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import type { HandlerType, ExtractedConfig } from "../core";
import { extractAll, extractConfigs, resolveStaticSiteRoutes } from "./extract";
import type { TableConfig, AppConfig, StaticSiteConfig, QueueConfig, BucketConfig, MailerConfig, ApiConfig, CronConfig, WorkerConfig, McpConfig } from "effortless-aws";

// ============ Types ============

export type ExtractedTableFunction = ExtractedConfig<TableConfig>;
export type ExtractedAppFunction = ExtractedConfig<AppConfig>;
export type ExtractedStaticSiteFunction = ExtractedConfig<StaticSiteConfig>;
export type ExtractedQueueFunction = ExtractedConfig<QueueConfig>;
export type ExtractedBucketFunction = ExtractedConfig<BucketConfig>;
export type ExtractedMailerFunction = ExtractedConfig<MailerConfig>;
export type ExtractedApiFunction = ExtractedConfig<ApiConfig>;
export type ExtractedCronFunction = ExtractedConfig<CronConfig>;
export type ExtractedWorkerFunction = ExtractedConfig<WorkerConfig>;
export type ExtractedMcpFunction = ExtractedConfig<McpConfig>;

export type DiscoveredHandlers = {
  tableHandlers: { file: string; exports: ExtractedTableFunction[] }[];
  appHandlers: { file: string; exports: ExtractedAppFunction[] }[];
  staticSiteHandlers: { file: string; exports: ExtractedStaticSiteFunction[] }[];
  queueHandlers: { file: string; exports: ExtractedQueueFunction[] }[];
  bucketHandlers: { file: string; exports: ExtractedBucketFunction[] }[];
  mailerHandlers: { file: string; exports: ExtractedMailerFunction[] }[];
  apiHandlers: { file: string; exports: ExtractedApiFunction[] }[];
  cronHandlers: { file: string; exports: ExtractedCronFunction[] }[];
  workerHandlers: { file: string; exports: ExtractedWorkerFunction[] }[];
  mcpHandlers: { file: string; exports: ExtractedMcpFunction[] }[];
};

// ============ Discovery ============

/** Full project discovery — read files, parse AST, resolve cross-file routes. */
export const discoverHandlers = (files: string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const result: DiscoveredHandlers = {
      tableHandlers: [], appHandlers: [], staticSiteHandlers: [], queueHandlers: [],
      bucketHandlers: [], mailerHandlers: [], apiHandlers: [], cronHandlers: [],
      workerHandlers: [], mcpHandlers: [],
    };

    const typeToKey: Record<HandlerType, keyof DiscoveredHandlers> = {
      table: "tableHandlers", app: "appHandlers", staticSite: "staticSiteHandlers",
      queue: "queueHandlers", bucket: "bucketHandlers", mailer: "mailerHandlers",
      api: "apiHandlers", cron: "cronHandlers", worker: "workerHandlers", mcp: "mcpHandlers",
    };

    const allExports = new Map<string, { type: HandlerType; exportName: string }>();

    // Phase 1: Parse all files and extract handlers
    for (const file of files) {
      const stat = yield* fileSystem.stat(file);
      if (stat.type !== "File") continue;

      const source = yield* fileSystem.readFileString(file);
      const extracted = extractAll(source);

      for (const { type, configs } of extracted) {
        const key = typeToKey[type];
        (result[key] as { file: string; exports: ExtractedConfig<any>[] }[]).push({ file, exports: configs });

        for (const config of configs) {
          allExports.set(config.exportName, { type, exportName: config.exportName });
        }
      }
    }

    // Phase 2: Resolve cross-file static site routes
    for (const { file, exports: siteExports } of result.staticSiteHandlers) {
      const source = yield* fileSystem.readFileString(file);
      resolveStaticSiteRoutes(siteExports, allExports, source);
    }

    return result;
  });

/** Extract handler configs of a specific type from a file. */
export const extractConfigsFromFile = <T>(file: string, type: HandlerType) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(file);
    return extractConfigs<T>(source, type);
  });

/** Flatten all discovered handlers into a list of { exportName, file, type }. */
export const flattenHandlers = (discovered: DiscoveredHandlers) => {
  const entries = (
    type: string,
    items: { file: string; exports: { exportName: string }[] }[],
  ) => items.flatMap(h => h.exports.map(e => ({ exportName: e.exportName, file: h.file, type })));

  return [
    ...entries("table", discovered.tableHandlers),
    ...entries("app", discovered.appHandlers),
    ...entries("site", discovered.staticSiteHandlers),
    ...entries("queue", discovered.queueHandlers),
    ...entries("bucket", discovered.bucketHandlers),
    ...entries("mailer", discovered.mailerHandlers),
    ...entries("api", discovered.apiHandlers),
    ...entries("cron", discovered.cronHandlers),
    ...entries("worker", discovered.workerHandlers),
    ...entries("mcp", discovered.mcpHandlers),
  ];
};
