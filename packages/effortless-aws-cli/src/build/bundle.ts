import { Effect } from "effect";
import * as esbuild from "esbuild";
import * as fsSync from "fs";
import * as path from "path";
import { builtinModules } from "module";
import { createRequire } from "module";
import archiver from "archiver";
import { globSync } from "glob";
import { generateEntryPoint, generateMiddlewareEntryPoint, type HandlerType, type ExtractedConfig, type SecretEntry } from "./handler-registry";
import type { TableConfig, AppConfig, StaticSiteConfig, FifoQueueConfig, BucketConfig, MailerConfig, ApiConfig } from "effortless-aws";
import * as os from "os";

export type BundleInput = {
  projectDir: string;
  format?: "esm" | "cjs";
  file: string;
};

// ============ Config extraction (via runtime import) ============

export type ExtractedTableFunction = ExtractedConfig<TableConfig>;
export type ExtractedAppFunction = ExtractedConfig<AppConfig>;
export type ExtractedStaticSiteFunction = ExtractedConfig<StaticSiteConfig>;
export type ExtractedFifoQueueFunction = ExtractedConfig<FifoQueueConfig>;
export type ExtractedBucketFunction = ExtractedConfig<BucketConfig>;
export type ExtractedMailerFunction = ExtractedConfig<MailerConfig>;
export type ExtractedApiFunction = ExtractedConfig<ApiConfig>;

/** Convert camelCase to kebab-case for SSM key derivation. */
const toKebabCase = (str: string): string =>
  str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** Brand → handler type mapping */
const BRAND_TO_TYPE: Record<string, HandlerType> = {
  "effortless-table": "table",
  "effortless-app": "app",
  "effortless-static-site": "staticSite",
  "effortless-fifo-queue": "fifoQueue",
  "effortless-bucket": "bucket",
  "effortless-mailer": "mailer",
  "effortless-api": "api",
};

/** Properties that indicate a handler has an active Lambda function */
const HANDLER_PROPS: Record<HandlerType, readonly string[]> = {
  table: ["onRecord", "onRecordBatch"],
  app: [],
  staticSite: ["middleware"],
  fifoQueue: ["onMessage", "onMessageBatch"],
  bucket: ["onObjectCreated", "onObjectRemoved"],
  mailer: [],
  api: ["routes"],
};

/** Extract SecretEntry[] from a handler's resolved config object */
const extractSecretEntriesFromConfig = (config: Record<string, unknown> | undefined): SecretEntry[] => {
  if (!config) return [];
  const entries: SecretEntry[] = [];
  for (const [propName, ref] of Object.entries(config)) {
    if (ref && typeof ref === "object" && (ref as any).__brand === "effortless-secret") {
      const secretRef = ref as { key?: string; generate?: string };
      const ssmKey = secretRef.key ?? toKebabCase(propName);
      entries.push({ propName, ssmKey, ...(secretRef.generate ? { generate: secretRef.generate } : {}) });
    }
  }
  return entries;
};

/** Extract deps keys from a handler's deps property */
const extractDepsKeysFromHandler = (deps: unknown): string[] => {
  if (!deps) return [];
  const resolved = typeof deps === "function" ? (deps as () => Record<string, unknown>)() : deps;
  if (typeof resolved !== "object" || resolved === null) return [];
  return Object.keys(resolved);
};

/** Extract route patterns from parsed routes */
const extractRoutePatternsFromRoutes = (routes: unknown): string[] => {
  if (!Array.isArray(routes)) return [];
  return routes
    .map((r: any) => r.path as string | undefined)
    .filter((p): p is string => !!p);
};

/** Extract route patterns from a static site's routes map */
const extractRouteMapPatterns = (routes: unknown): string[] => {
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return [];
  return Object.keys(routes);
};

/** Props to strip from __spec when building static config */
const SPEC_RUNTIME_PROPS: Record<string, readonly string[]> = {
  staticSite: ["middleware", "routes"],
  app: [],
};

/** Extract an ExtractedConfig from a runtime handler object */
const extractFromHandler = (exportName: string, handler: any, type: HandlerType): ExtractedConfig<any> => {
  const rawSpec = handler.__spec ?? {};
  // Some handler types store all props in __spec (e.g. staticSite, app)
  const checkTarget = type === "staticSite" || type === "app" ? rawSpec : handler;
  // Strip runtime-only props from spec for the config output
  const stripProps = SPEC_RUNTIME_PROPS[type] ?? [];
  const config = stripProps.length > 0
    ? Object.fromEntries(Object.entries(rawSpec).filter(([k]) => !stripProps.includes(k)))
    : rawSpec;
  return {
    exportName,
    config,
    hasHandler: HANDLER_PROPS[type].some(p => checkTarget[p] != null),
    depsKeys: extractDepsKeysFromHandler(handler.deps),
    secretEntries: extractSecretEntriesFromConfig(handler.config),
    staticGlobs: Array.isArray(handler.static) ? handler.static : [],
    routePatterns: type === "staticSite" ? extractRouteMapPatterns(rawSpec.routes) : extractRoutePatternsFromRoutes(handler.routes),
  };
};

/**
 * Import a handler file, extract all configs of a specific handler type.
 * Replaces the old AST-based extract*Configs functions.
 */
export const extractConfigsFromFile = async <T>(
  file: string,
  projectDir: string,
  type: HandlerType,
): Promise<ExtractedConfig<T>[]> => {
  const mod = await importHandlerModule(file, projectDir);
  const results: ExtractedConfig<T>[] = [];
  for (const [exportName, value] of Object.entries(mod)) {
    if (!value || typeof value !== "object" || !("__brand" in value)) continue;
    const handlerType = BRAND_TO_TYPE[(value as any).__brand as string];
    if (handlerType !== type) continue;
    results.push(extractFromHandler(exportName, value, type) as ExtractedConfig<T>);
  }
  return results;
};

/**
 * Bundle a handler file with esbuild to a temp .mjs, import() it, and extract
 * metadata from the exported handler objects.
 */
const importHandlerModule = async (file: string, projectDir: string): Promise<Record<string, any>> => {
  const tmpFile = path.join(os.tmpdir(), `eff-discover-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  try {
    const result = await esbuild.build({
      entryPoints: [file],
      bundle: true,
      platform: "node",
      target: "node22",
      write: false,
      format: "esm",
      external: ["@aws-sdk/*", "@smithy/*", ...builtinModules.flatMap(m => [m, `node:${m}`])],
      absWorkingDir: projectDir,
    });
    const output = result.outputFiles?.[0];
    if (!output) throw new Error(`esbuild produced no output for ${file}`);
    fsSync.writeFileSync(tmpFile, output.text);
    return await import(tmpFile);
  } finally {
    try { fsSync.unlinkSync(tmpFile); } catch {}
  }
};

// ============ Bundle (uses registry) ============

const _require = createRequire(import.meta.url);
const runtimeDir = path.join(path.dirname(_require.resolve("effortless-aws/package.json")), "dist/runtime");

export type BundleResult = {
  code: string;
  /** Top modules by size (path → bytes), only when metafile is enabled */
  topModules?: { path: string; bytes: number }[];
};

export const bundle = (input: BundleInput & { exportName?: string; external?: string[]; type?: HandlerType }) =>
  Effect.gen(function* () {
    const exportName = input.exportName ?? "default";
    const type = input.type ?? "api";
    const externals = input.external ?? [];

    // Get source path for import statement
    const sourcePath = path.isAbsolute(input.file) ? input.file : `./${input.file}`;

    const entryPoint = generateEntryPoint(sourcePath, exportName, type, runtimeDir);

    // AWS SDK v3 + Node.js built-ins are available in the Lambda runtime — never bundle them
    const awsExternals = ["@aws-sdk/*", "@smithy/*"];
    const nodeExternals = builtinModules.flatMap(m => [m, `node:${m}`]);
    const allExternals = [...new Set([...awsExternals, ...nodeExternals, ...externals])];

    const format = input.format ?? "esm";

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
        format,
        external: allExternals,
        metafile: true,
        // CJS packages bundled into ESM need a `require` function for Node.js builtins
        ...(format === "esm" ? { banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } } : {}),
      }),
      catch: (error) => new Error(`esbuild failed: ${error}`)
    });

    const output = result.outputFiles?.[0];
    if (!output) {
      throw new Error("esbuild produced no output");
    }

    const bundleResult: BundleResult = { code: output.text };

    if (result.metafile) {
      bundleResult.topModules = analyzeMetafile(result.metafile);
    }

    return bundleResult;
  });

/**
 * Extract top modules by size from esbuild metafile.
 * Groups by top-level package name (e.g. node_modules/effect/...).
 */
const analyzeMetafile = (metafile: esbuild.Metafile): { path: string; bytes: number }[] => {
  const packageSizes = new Map<string, number>();

  for (const [filePath, info] of Object.entries(metafile.inputs)) {
    // Group by package: node_modules/.pnpm/pkg@ver/node_modules/pkg/... → pkg
    const nodeModIdx = filePath.lastIndexOf("node_modules/");
    let key: string;
    if (nodeModIdx !== -1) {
      const afterNm = filePath.slice(nodeModIdx + "node_modules/".length);
      // Handle scoped packages: @scope/name/...
      if (afterNm.startsWith("@")) {
        const parts = afterNm.split("/");
        key = `${parts[0]}/${parts[1]}`;
      } else {
        key = afterNm.split("/")[0]!;
      }
    } else {
      key = "<project>";
    }
    packageSizes.set(key, (packageSizes.get(key) ?? 0) + info.bytes);
  }

  return Array.from(packageSizes.entries())
    .map(([p, bytes]) => ({ path: p, bytes }))
    .sort((a, b) => b.bytes - a.bytes);
};

/**
 * Bundle middleware as a standalone Lambda@Edge function.
 * Extracts only the middleware function from the handler source via AST,
 * so the bundle doesn't pull in unrelated dependencies (HTTP clients, etc.).
 */
export const bundleMiddleware = (input: { projectDir: string; file: string }) =>
  Effect.gen(function* () {
    const absFile = path.isAbsolute(input.file)
      ? input.file
      : path.resolve(input.projectDir, input.file);
    const source = fsSync.readFileSync(absFile, "utf-8");
    const sourceDir = path.dirname(absFile);

    const { entryPoint } = generateMiddlewareEntryPoint(source, runtimeDir);

    const awsExternals = ["@aws-sdk/*", "@smithy/*"];

    const result = yield* Effect.tryPromise({
      try: () => esbuild.build({
        stdin: {
          contents: entryPoint,
          loader: "ts",
          resolveDir: sourceDir,
        },
        bundle: true,
        platform: "node",
        target: "node22",
        write: false,
        minify: false,
        sourcemap: false,
        format: "esm",
        external: awsExternals,
      }),
      catch: (error) => new Error(`esbuild failed (middleware): ${error}`)
    });

    const output = result.outputFiles?.[0];
    if (!output) {
      throw new Error("esbuild produced no output for middleware");
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

// ============ Directory ZIP (for SSR frameworks) ============

export const zipDirectory = (dirPath: string) =>
  Effect.async<Buffer, Error>((resume) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resume(Effect.succeed(Buffer.concat(chunks))));
    archive.on("error", (err) => resume(Effect.fail(err)));

    archive.directory(dirPath, false);
    archive.finalize();
  });

/**
 * Scan a directory's top-level entries and return CloudFront path patterns.
 * Directories become "/{name}/*", files become "/{name}".
 */
export const detectAssetPatterns = (assetsDir: string): string[] => {
  if (!fsSync.existsSync(assetsDir)) return [];

  const patterns: string[] = [];
  for (const entry of fsSync.readdirSync(assetsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      patterns.push(`/${entry.name}/*`);
    } else {
      patterns.push(`/${entry.name}`);
    }
  }
  return patterns;
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
  tableHandlers: { file: string; exports: ExtractedTableFunction[] }[];
  appHandlers: { file: string; exports: ExtractedAppFunction[] }[];
  staticSiteHandlers: { file: string; exports: ExtractedStaticSiteFunction[] }[];
  fifoQueueHandlers: { file: string; exports: ExtractedFifoQueueFunction[] }[];
  bucketHandlers: { file: string; exports: ExtractedBucketFunction[] }[];
  mailerHandlers: { file: string; exports: ExtractedMailerFunction[] }[];
  apiHandlers: { file: string; exports: ExtractedApiFunction[] }[];
};

export const discoverHandlers = async (files: string[], projectDir: string): Promise<DiscoveredHandlers> => {
  const tableHandlers: { file: string; exports: ExtractedTableFunction[] }[] = [];
  const appHandlers: { file: string; exports: ExtractedAppFunction[] }[] = [];
  const staticSiteHandlers: { file: string; exports: ExtractedStaticSiteFunction[] }[] = [];
  const fifoQueueHandlers: { file: string; exports: ExtractedFifoQueueFunction[] }[] = [];
  const bucketHandlers: { file: string; exports: ExtractedBucketFunction[] }[] = [];
  const mailerHandlers: { file: string; exports: ExtractedMailerFunction[] }[] = [];
  const apiHandlers: { file: string; exports: ExtractedApiFunction[] }[] = [];

  for (const file of files) {
    if (!fsSync.statSync(file).isFile()) continue;

    const mod = await importHandlerModule(file, projectDir);

    const byType: Record<HandlerType, ExtractedConfig<any>[]> = {
      table: [], app: [], staticSite: [], fifoQueue: [], bucket: [], mailer: [], api: [],
    };

    for (const [exportName, value] of Object.entries(mod)) {
      if (!value || typeof value !== "object" || !("__brand" in value)) continue;
      const type = BRAND_TO_TYPE[(value as any).__brand as string];
      if (!type) continue;
      byType[type].push(extractFromHandler(exportName, value, type));
    }

    if (byType.table.length > 0) tableHandlers.push({ file, exports: byType.table });
    if (byType.app.length > 0) appHandlers.push({ file, exports: byType.app });
    if (byType.staticSite.length > 0) staticSiteHandlers.push({ file, exports: byType.staticSite });
    if (byType.fifoQueue.length > 0) fifoQueueHandlers.push({ file, exports: byType.fifoQueue });
    if (byType.bucket.length > 0) bucketHandlers.push({ file, exports: byType.bucket });
    if (byType.mailer.length > 0) mailerHandlers.push({ file, exports: byType.mailer });
    if (byType.api.length > 0) apiHandlers.push({ file, exports: byType.api });
  }

  return { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers };
};

/** Flatten all discovered handlers into a list of { exportName, file, type } */
export const flattenHandlers = (discovered: DiscoveredHandlers) => {
  const entries = (
    type: string,
    handlers: { file: string; exports: { exportName: string }[] }[],
  ) => handlers.flatMap(h => h.exports.map(e => ({ exportName: e.exportName, file: h.file, type })));

  return [
    ...entries("table", discovered.tableHandlers),
    ...entries("app", discovered.appHandlers),
    ...entries("site", discovered.staticSiteHandlers),
    ...entries("queue", discovered.fifoQueueHandlers),
    ...entries("bucket", discovered.bucketHandlers),
    ...entries("mailer", discovered.mailerHandlers),
    ...entries("api", discovered.apiHandlers),
  ];
};
