import { Effect } from "effect";
import * as esbuild from "esbuild";
import * as fsSync from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import archiver from "archiver";
import { globSync } from "glob";
import { generateEntryPoint, extractHandlerConfigs, type HandlerType, type ExtractedConfig } from "./handler-registry";
import type { HttpConfig } from "~/handlers/define-http";
import type { TableConfig } from "~/handlers/define-table";
import type { AppConfig } from "~/handlers/define-app";
import type { StaticSiteConfig } from "~/handlers/define-static-site";
import type { FifoQueueConfig } from "~/handlers/define-fifo-queue";
import type { BucketConfig } from "~/handlers/define-bucket";
import type { MailerConfig } from "~/handlers/define-mailer";

export type BundleInput = {
  projectDir: string;
  format?: "esm" | "cjs";
  file: string;
};

// ============ Config extraction (uses registry) ============

export type ExtractedFunction = ExtractedConfig<HttpConfig>;
export type ExtractedTableFunction = ExtractedConfig<TableConfig>;
export type ExtractedAppFunction = ExtractedConfig<AppConfig>;
export type ExtractedStaticSiteFunction = ExtractedConfig<StaticSiteConfig>;

export const extractConfigs = (source: string): ExtractedFunction[] =>
  extractHandlerConfigs<HttpConfig>(source, "http");

export const extractTableConfigs = (source: string): ExtractedTableFunction[] =>
  extractHandlerConfigs<TableConfig>(source, "table");

export const extractAppConfigs = (source: string): ExtractedAppFunction[] =>
  extractHandlerConfigs<AppConfig>(source, "app");

export const extractStaticSiteConfigs = (source: string): ExtractedStaticSiteFunction[] =>
  extractHandlerConfigs<StaticSiteConfig>(source, "staticSite");

export type ExtractedFifoQueueFunction = ExtractedConfig<FifoQueueConfig>;

export const extractFifoQueueConfigs = (source: string): ExtractedFifoQueueFunction[] =>
  extractHandlerConfigs<FifoQueueConfig>(source, "fifoQueue");

export type ExtractedBucketFunction = ExtractedConfig<BucketConfig>;

export const extractBucketConfigs = (source: string): ExtractedBucketFunction[] =>
  extractHandlerConfigs<BucketConfig>(source, "bucket");

export type ExtractedMailerFunction = ExtractedConfig<MailerConfig>;

export const extractMailerConfigs = (source: string): ExtractedMailerFunction[] =>
  extractHandlerConfigs<MailerConfig>(source, "mailer");

export const extractConfig = (source: string): HttpConfig | null => {
  const configs = extractConfigs(source);
  return configs.length > 0 ? configs[0]?.config ?? null : null;
};

// ============ Bundle (uses registry) ============

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/runtime");

export const bundle = (input: BundleInput & { exportName?: string; external?: string[]; type?: HandlerType }) =>
  Effect.gen(function* () {
    const exportName = input.exportName ?? "default";
    const type = input.type ?? "http";
    const externals = input.external ?? [];

    // Get source path for import statement
    const sourcePath = path.isAbsolute(input.file) ? input.file : `./${input.file}`;

    const entryPoint = generateEntryPoint(sourcePath, exportName, type, runtimeDir);

    // AWS SDK v3 is available in the Lambda Node.js runtime — never bundle it
    const awsExternals = ["@aws-sdk/*", "@smithy/*"];
    const allExternals = [...new Set([...awsExternals, ...externals])];

    const result = yield* Effect.tryPromise({
      try: () => esbuild.build({
        stdin: {
          contents: entryPoint,
          loader: "ts",
          resolveDir: input.projectDir
        },
        bundle: true,
        platform: "node",
        target: "node22",
        write: false,
        minify: false,
        sourcemap: false,
        format: input.format ?? "esm",
        external: allExternals
      }),
      catch: (error) => new Error(`esbuild failed: ${error}`)
    });

    const output = result.outputFiles?.[0];
    if (!output) {
      throw new Error("esbuild produced no output");
    }
    return output.text;
  });

export type StaticFile = {
  content: Buffer;
  zipPath: string;
};

export type ZipInput = {
  content: string;
  filename?: string;
  staticFiles?: StaticFile[];
};

// Fixed date for deterministic zip (same content = same hash)
const FIXED_DATE = new Date(0);

export const zip = (input: ZipInput) =>
  Effect.async<Buffer, Error>((resume) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
    archive.on("error", (err) => resume(Effect.fail(err)));

    archive.append(input.content, { name: input.filename ?? "index.mjs", date: FIXED_DATE });
    if (input.staticFiles) {
      for (const file of input.staticFiles) {
        archive.append(file.content, { name: file.zipPath, date: FIXED_DATE });
      }
    }
    archive.finalize();
  });

// ============ Static file resolution ============

export const resolveStaticFiles = (globs: string[], projectDir: string): StaticFile[] => {
  const files: StaticFile[] = [];
  for (const pattern of globs) {
    const matches = globSync(pattern, { cwd: projectDir, nodir: true });
    for (const match of matches) {
      const absPath = path.join(projectDir, match);
      files.push({
        content: fsSync.readFileSync(absPath),
        zipPath: match
      });
    }
  }
  return files;
};

// ============ File discovery ============

export const findHandlerFiles = (patterns: string[], cwd: string): string[] => {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd, absolute: true });
    matches.forEach(f => files.add(f));
  }
  return Array.from(files);
};

export type DiscoveredHandlers = {
  httpHandlers: { file: string; exports: ExtractedFunction[] }[];
  tableHandlers: { file: string; exports: ExtractedTableFunction[] }[];
  appHandlers: { file: string; exports: ExtractedAppFunction[] }[];
  staticSiteHandlers: { file: string; exports: ExtractedStaticSiteFunction[] }[];
  fifoQueueHandlers: { file: string; exports: ExtractedFifoQueueFunction[] }[];
  bucketHandlers: { file: string; exports: ExtractedBucketFunction[] }[];
  mailerHandlers: { file: string; exports: ExtractedMailerFunction[] }[];
};

export const discoverHandlers = (files: string[]): DiscoveredHandlers => {
  const httpHandlers: { file: string; exports: ExtractedFunction[] }[] = [];
  const tableHandlers: { file: string; exports: ExtractedTableFunction[] }[] = [];
  const appHandlers: { file: string; exports: ExtractedAppFunction[] }[] = [];
  const staticSiteHandlers: { file: string; exports: ExtractedStaticSiteFunction[] }[] = [];
  const fifoQueueHandlers: { file: string; exports: ExtractedFifoQueueFunction[] }[] = [];
  const bucketHandlers: { file: string; exports: ExtractedBucketFunction[] }[] = [];
  const mailerHandlers: { file: string; exports: ExtractedMailerFunction[] }[] = [];

  for (const file of files) {
    // Skip directories
    if (!fsSync.statSync(file).isFile()) continue;

    const source = fsSync.readFileSync(file, "utf-8");
    const http = extractConfigs(source);
    const table = extractTableConfigs(source);
    const app = extractAppConfigs(source);
    const staticSite = extractStaticSiteConfigs(source);
    const fifoQueue = extractFifoQueueConfigs(source);
    const bucket = extractBucketConfigs(source);
    const mailer = extractMailerConfigs(source);

    if (http.length > 0) httpHandlers.push({ file, exports: http });
    if (table.length > 0) tableHandlers.push({ file, exports: table });
    if (app.length > 0) appHandlers.push({ file, exports: app });
    if (staticSite.length > 0) staticSiteHandlers.push({ file, exports: staticSite });
    if (fifoQueue.length > 0) fifoQueueHandlers.push({ file, exports: fifoQueue });
    if (bucket.length > 0) bucketHandlers.push({ file, exports: bucket });
    if (mailer.length > 0) mailerHandlers.push({ file, exports: mailer });
  }

  return { httpHandlers, tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers };
};
