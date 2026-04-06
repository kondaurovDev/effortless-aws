import { Effect } from "effect";
import { Path, FileSystem } from "@effect/platform";
import * as esbuild from "esbuild";
import { builtinModules, createRequire } from "module";
import * as os from "os";
import archiver from "archiver";
import { globSync } from "glob";
import { generateEntryPoint, generateMiddlewareEntryPoint, type HandlerType, type ExtractedConfig, type SecretEntry, type ApiRouteEntry, type BucketRouteEntry } from "./handler-registry";
import type { TableConfig, AppConfig, StaticSiteConfig, FifoQueueConfig, BucketConfig, MailerConfig, ApiConfig, CronConfig, WorkerConfig, McpConfig } from "effortless-aws";

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
export type ExtractedCronFunction = ExtractedConfig<CronConfig>;
export type ExtractedWorkerFunction = ExtractedConfig<WorkerConfig>;
export type ExtractedMcpFunction = ExtractedConfig<McpConfig>;

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
  "effortless-cron": "cron",
  "effortless-worker": "worker",
  "effortless-mcp": "mcp",
};

/** Properties that indicate a handler has an active Lambda function */
const HANDLER_PROPS: Record<HandlerType, readonly string[]> = {
  table: ["onRecord", "onRecordBatch"],
  app: [],
  staticSite: ["middleware"],
  fifoQueue: ["onMessage", "onMessageBatch"],
  bucket: ["onObjectCreated", "onObjectRemoved"],
  mailer: [],
  cron: ["onTick"],
  api: ["routes"],
  worker: ["onMessage"],
  mcp: ["tools", "resources", "prompts"],
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
    .map((r: any) => r.method && r.path ? `${r.method} ${r.path}` : r.path as string | undefined)
    .filter((p): p is string => !!p);
};

/** Extract route entries from a static site handler's routes array */
const extractStaticSiteRoutes = (handler: any, allExports: Record<string, unknown>) => {
  const routes: Array<{ pattern: string; origin: any; access?: string }> = handler.routes;
  if (!Array.isArray(routes)) return { apiRoutes: [] as ApiRouteEntry[], bucketRoutes: [] as BucketRouteEntry[], routePatterns: [] as string[] };

  const apiRoutes: ApiRouteEntry[] = [];
  const bucketRoutes: BucketRouteEntry[] = [];
  const routePatterns: string[] = [];

  for (const entry of routes) {
    const brand = (entry.origin as any).__brand as string;

    if (brand === "effortless-bucket") {
      let bucketExportName = "";
      for (const [name, exp] of Object.entries(allExports)) {
        if (exp === entry.origin) { bucketExportName = name; break; }
      }
      bucketRoutes.push({
        pattern: entry.pattern,
        bucketExportName,
        access: entry.access === "private" ? "private" : "public",
      });
    } else {
      let handlerExport = "";
      for (const [name, exp] of Object.entries(allExports)) {
        if (exp === entry.origin) { handlerExport = name; break; }
      }
      apiRoutes.push({ pattern: entry.pattern, handlerExport });
      routePatterns.push(entry.pattern);
    }
  }

  return { apiRoutes, bucketRoutes, routePatterns };
};

/** Props to strip from __spec when building static config */
const SPEC_RUNTIME_PROPS: Record<string, readonly string[]> = {
  staticSite: [],
  app: [],
};

/** Extract an ExtractedConfig from a runtime handler object */
const extractFromHandler = (exportName: string, handler: any, type: HandlerType, allExports?: Record<string, unknown>): ExtractedConfig<any> => {
  const rawSpec = handler.__spec ?? {};
  const checkTarget = type === "app" ? rawSpec : handler;
  // Strip runtime-only props from spec for the config output
  const stripProps = SPEC_RUNTIME_PROPS[type] ?? [];
  const config = stripProps.length > 0
    ? Object.fromEntries(Object.entries(rawSpec).filter(([k]) => !stripProps.includes(k)))
    : rawSpec;

  // For staticSite, extract routes from handler.routes array
  if (type === "staticSite") {
    const { apiRoutes, bucketRoutes, routePatterns } = extractStaticSiteRoutes(handler, allExports ?? {});

    return {
      exportName,
      config,
      hasHandler: handler.middleware != null,
      depsKeys: extractDepsKeysFromHandler(handler.deps),
      secretEntries: extractSecretEntriesFromConfig(handler.config),
      staticGlobs: Array.isArray(handler.static) ? handler.static : [],
      routePatterns,
      apiRoutes,
      bucketRoutes,
    };
  }

  return {
    exportName,
    config,
    hasHandler: type === "api"
      ? Array.isArray(checkTarget.routes) && checkTarget.routes.length > 0
      : HANDLER_PROPS[type].some(p => checkTarget[p] != null),
    depsKeys: extractDepsKeysFromHandler(handler.deps),
    secretEntries: extractSecretEntriesFromConfig(handler.config),
    staticGlobs: Array.isArray(handler.static) ? handler.static : [],
    routePatterns: extractRoutePatternsFromRoutes(handler.routes),
    apiRoutes: [],
    bucketRoutes: [],
  };
};

/**
 * Import a handler file, extract all configs of a specific handler type.
 * Replaces the old AST-based extract*Configs functions.
 */
export const extractConfigsFromFile = <T>(
  file: string,
  projectDir: string,
  type: HandlerType,
) =>
  Effect.gen(function* () {
    const mod = yield* importHandlerModule(file, projectDir);
    const results: ExtractedConfig<T>[] = [];
    for (const [exportName, value] of Object.entries(mod)) {
      if (!value || typeof value !== "object" || !("__brand" in value)) continue;
      const handlerType = BRAND_TO_TYPE[(value as any).__brand as string];
      if (handlerType !== type) continue;
      results.push(extractFromHandler(exportName, value, type, mod) as ExtractedConfig<T>);
    }
    return results;
  });

/**
 * Bundle a handler file with esbuild to a temp .mjs, import() it, and extract
 * metadata from the exported handler objects.
 */
const importHandlerModule = (file: string, projectDir: string) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const tmpFile = p.join(os.tmpdir(), `eff-discover-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

    const result = yield* Effect.tryPromise({
      try: () => esbuild.build({
        entryPoints: [file],
        bundle: true,
        platform: "node",
        target: "node24",
        write: false,
        format: "esm",
        external: ["@aws-sdk/*", "@smithy/*", ...builtinModules.flatMap(m => [m, `node:${m}`])],
        absWorkingDir: projectDir,
        banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      }),
      catch: (err) => new Error(`Failed to bundle ${file}: ${err}`),
    });

    const output = result.outputFiles?.[0];
    if (!output) {
      return yield* Effect.fail(new Error(`esbuild produced no output for ${file}`));
    }

    yield* fs.writeFileString(tmpFile, output.text);

    const mod = yield* Effect.tryPromise({
      try: () => import(tmpFile) as Promise<Record<string, any>>,
      catch: (err) => {
        console.error(`Discovery bundle left at: ${tmpFile}`);
        return new Error(`Failed to import ${file}: ${err}`);
      },
    });

    yield* fs.remove(tmpFile).pipe(Effect.catchAll(() => Effect.void));
    return mod;
  });

// ============ Bundle (uses registry) ============

const _require = createRequire(import.meta.url);

const resolveRuntimeDir = Effect.gen(function* () {
  const p = yield* Path.Path;
  return p.join(p.dirname(_require.resolve("effortless-aws/package.json")), "dist/runtime");
});

export type BundleResult = {
  code: string;
  /** Top modules by size (path → bytes), only when metafile is enabled */
  topModules?: { path: string; bytes: number }[];
};

export const bundle = (input: BundleInput & { exportName?: string; external?: string[]; type?: HandlerType }) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const exportName = input.exportName ?? "default";
    const type = input.type ?? "api";
    const externals = input.external ?? [];

    // Get source path for import statement
    const sourcePath = p.isAbsolute(input.file) ? input.file : `./${input.file}`;

    const runtimeDir = yield* resolveRuntimeDir;
    const entryPoint = generateEntryPoint(sourcePath, exportName, type, runtimeDir);

    // AWS SDK v3 is provided by the Lambda runtime — mark external for Lambda handlers.
    // Workers run in a plain Node.js container (ECS Fargate), so SDK must be bundled in.
    const awsExternals = type === "worker" ? [] : ["@aws-sdk/*", "@smithy/*"];
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
        target: "node24",
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
    const p = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const absFile = p.isAbsolute(input.file)
      ? input.file
      : p.resolve(input.projectDir, input.file);
    const source = yield* fs.readFileString(absFile);
    const sourceDir = p.dirname(absFile);

    const runtimeDir = yield* resolveRuntimeDir;
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
        target: "node24",
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

export const resolveStaticFiles = (paths: string[], projectDir: string) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const files: StaticFile[] = [];
    const missing: string[] = [];

    const collectFiles = (absPath: string, relPath: string): Effect.Effect<void, any> =>
      Effect.gen(function* () {
        const exists = yield* fileSystem.exists(absPath);
        if (!exists) {
          missing.push(relPath);
          return;
        }
        const stat = yield* fileSystem.stat(absPath);
        if (stat.type === "Directory") {
          const entries = yield* fileSystem.readDirectory(absPath);
          for (const name of entries) {
            yield* collectFiles(p.join(absPath, name), p.join(relPath, name));
          }
        } else {
          const content = yield* fileSystem.readFile(absPath);
          files.push({ content: Buffer.from(content), zipPath: relPath });
        }
      });

    for (const pathStr of paths) {
      const rel = pathStr.replace(/^\//, "");
      yield* collectFiles(p.join(projectDir, rel), rel);
    }

    return { files, missing };
  });

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
export const detectAssetPatterns = (assetsDir: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(assetsDir);
    if (!exists) return [] as string[];

    const patterns: string[] = [];
    const entries = yield* fileSystem.readDirectory(assetsDir);
    for (const name of entries) {
      const stat = yield* fileSystem.stat(`${assetsDir}/${name}`);
      if (stat.type === "Directory") {
        patterns.push(`/${name}/*`);
      } else {
        patterns.push(`/${name}`);
      }
    }
    return patterns;
  });

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
  cronHandlers: { file: string; exports: ExtractedCronFunction[] }[];
  workerHandlers: { file: string; exports: ExtractedWorkerFunction[] }[];
  mcpHandlers: { file: string; exports: ExtractedMcpFunction[] }[];
};

export const discoverHandlers = (files: string[], projectDir: string) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const tableHandlers: { file: string; exports: ExtractedTableFunction[] }[] = [];
    const appHandlers: { file: string; exports: ExtractedAppFunction[] }[] = [];
    const staticSiteHandlers: { file: string; exports: ExtractedStaticSiteFunction[] }[] = [];
    const fifoQueueHandlers: { file: string; exports: ExtractedFifoQueueFunction[] }[] = [];
    const bucketHandlers: { file: string; exports: ExtractedBucketFunction[] }[] = [];
    const mailerHandlers: { file: string; exports: ExtractedMailerFunction[] }[] = [];
    const apiHandlers: { file: string; exports: ExtractedApiFunction[] }[] = [];
    const cronHandlers: { file: string; exports: ExtractedCronFunction[] }[] = [];
    const workerHandlers: { file: string; exports: ExtractedWorkerFunction[] }[] = [];
    const mcpHandlers: { file: string; exports: ExtractedMcpFunction[] }[] = [];
    const allModuleExports = new Map<string, unknown>();

    for (const file of files) {
      const stat = yield* fileSystem.stat(file);
      if (stat.type !== "File") continue;

      const mod = yield* importHandlerModule(file, projectDir);

      const byType: Record<HandlerType, ExtractedConfig<any>[]> = {
        table: [], app: [], staticSite: [], fifoQueue: [], bucket: [], mailer: [], cron: [], api: [], worker: [], mcp: [],
      };

      for (const [exportName, value] of Object.entries(mod)) {
        if (!value || typeof value !== "object") continue;

        // Detect unfinalized builders (have .build() method but no __brand)
        if (!("__brand" in value) && typeof (value as any).build === "function") {
          const shortFile = p.relative(projectDir, file);
          const v = value as Record<string, unknown>;
          const hint = typeof v.get === "function" && typeof v.post === "function" ? ".get() or .post()"
            : typeof v.onRecord === "function" ? ".onRecord() or .onRecordBatch()"
            : typeof v.onMessage === "function" ? ".onMessage() or .onMessageBatch()"
            : typeof v.onObjectCreated === "function" ? ".onObjectCreated() or .onObjectRemoved()"
            : typeof v.onTick === "function" ? ".onTick()"
            : typeof v.handler === "function" ? ".onMessage()"
            : typeof v.tool === "function" ? ".tool() or .tools()"
            : typeof v.route === "function" ? ".route() and .build()"
            : ".build()";
          console.warn(`⚠ ${shortFile}: "${exportName}" is missing a handler — did you forget ${hint}?`);
          continue;
        }

        if (!("__brand" in value)) continue;
        const type = BRAND_TO_TYPE[(value as any).__brand as string];
        if (!type) continue;
        allModuleExports.set(exportName, value);
        byType[type].push(extractFromHandler(exportName, value, type, mod));
      }

      if (byType.table.length > 0) tableHandlers.push({ file, exports: byType.table });
      if (byType.app.length > 0) appHandlers.push({ file, exports: byType.app });
      if (byType.staticSite.length > 0) staticSiteHandlers.push({ file, exports: byType.staticSite });
      if (byType.fifoQueue.length > 0) fifoQueueHandlers.push({ file, exports: byType.fifoQueue });
      if (byType.bucket.length > 0) bucketHandlers.push({ file, exports: byType.bucket });
      if (byType.mailer.length > 0) mailerHandlers.push({ file, exports: byType.mailer });
      if (byType.api.length > 0) apiHandlers.push({ file, exports: byType.api });
      if (byType.cron.length > 0) cronHandlers.push({ file, exports: byType.cron });
      if (byType.worker.length > 0) workerHandlers.push({ file, exports: byType.worker });
      if (byType.mcp.length > 0) mcpHandlers.push({ file, exports: byType.mcp });
    }

    // Post-process: resolve cross-file route origins for static sites.
    // When a route origin (API/MCP/bucket) is imported from another file, reference equality
    // against the current file's exports fails. Fall back to matching by __brand + __spec.
    if (staticSiteHandlers.length > 0) {
      // Build a global lookup: "brand:specJSON" → exportName
      const specToExport = new Map<string, string>();
      const allHandlerGroups = [apiHandlers, mcpHandlers, bucketHandlers, appHandlers];
      for (const group of allHandlerGroups) {
        for (const { exports: exps } of group) {
          for (const exp of exps) {
            const handler = allModuleExports.get(exp.exportName);
            if (handler && typeof handler === "object" && "__brand" in handler && "__spec" in handler) {
              specToExport.set(`${(handler as any).__brand}:${JSON.stringify((handler as any).__spec)}`, exp.exportName);
            }
          }
        }
      }

      for (const { exports: siteExports } of staticSiteHandlers) {
        for (const site of siteExports) {
          // Re-resolve empty apiRoutes
          for (const ar of site.apiRoutes) {
            if (ar.handlerExport) continue;
            // Find the route origin from the static site handler's routes array
            const siteHandler = allModuleExports.get(site.exportName);
            if (!siteHandler || typeof siteHandler !== "object") continue;
            const routes: any[] = (siteHandler as any).routes ?? [];
            const route = routes.find((r: any) => r.pattern === ar.pattern);
            if (!route?.origin?.__brand || !route?.origin?.__spec) continue;
            const key = `${route.origin.__brand}:${JSON.stringify(route.origin.__spec)}`;
            ar.handlerExport = specToExport.get(key) ?? "";
          }
          // Re-resolve empty bucketRoutes
          for (const br of site.bucketRoutes) {
            if (br.bucketExportName) continue;
            const siteHandler = allModuleExports.get(site.exportName);
            if (!siteHandler || typeof siteHandler !== "object") continue;
            const routes: any[] = (siteHandler as any).routes ?? [];
            const route = routes.find((r: any) => r.pattern === br.pattern);
            if (!route?.origin?.__brand || !route?.origin?.__spec) continue;
            const key = `${route.origin.__brand}:${JSON.stringify(route.origin.__spec)}`;
            br.bucketExportName = specToExport.get(key) ?? "";
          }
        }
      }
    }

    return { tableHandlers, appHandlers, staticSiteHandlers, fifoQueueHandlers, bucketHandlers, mailerHandlers, apiHandlers, cronHandlers, workerHandlers, mcpHandlers } as DiscoveredHandlers;
  });

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
    ...entries("cron", discovered.cronHandlers),
    ...entries("worker", discovered.workerHandlers),
    ...entries("mcp", discovered.mcpHandlers),
  ];
};
