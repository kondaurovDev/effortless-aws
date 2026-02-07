import { Effect } from "effect";
import * as esbuild from "esbuild";
import * as fsSync from "fs";
import * as path from "path";
import archiver from "archiver";
import { globSync } from "glob";
import { generateEntryPoint, extractHandlerConfigs, type HandlerType, type ExtractedConfig } from "./handler-registry";
import type { HttpConfig } from "~/handlers/define-http";
import type { TableConfig } from "~/handlers/define-table";

export type BundleInput = {
  projectDir: string;
  format?: "esm" | "cjs";
  file: string;
};

// ============ Config extraction (uses registry) ============

export type ExtractedFunction = ExtractedConfig<HttpConfig>;
export type ExtractedTableFunction = ExtractedConfig<TableConfig>;

export const extractConfigs = (source: string): ExtractedFunction[] =>
  extractHandlerConfigs<HttpConfig>(source, "http");

export const extractTableConfigs = (source: string): ExtractedTableFunction[] =>
  extractHandlerConfigs<TableConfig>(source, "table");

export const extractConfig = (source: string): HttpConfig | null => {
  const configs = extractConfigs(source);
  return configs.length > 0 ? configs[0]?.config ?? null : null;
};

// ============ Bundle (uses registry) ============

export const bundle = (input: BundleInput & { exportName?: string; external?: string[]; type?: HandlerType }) =>
  Effect.gen(function* () {
    const exportName = input.exportName ?? "default";
    const type = input.type ?? "http";
    const externals = input.external ?? [];

    // Get source path for import statement
    const sourcePath = path.isAbsolute(input.file) ? input.file : `./${input.file}`;

    const entryPoint = generateEntryPoint(sourcePath, exportName, type);

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
        ...(externals.length > 0 ? { external: externals } : { packages: "bundle" as const })
      }),
      catch: (error) => new Error(`esbuild failed: ${error}`)
    });

    const output = result.outputFiles?.[0];
    if (!output) {
      throw new Error("esbuild produced no output");
    }
    return output.text;
  });

export type ZipInput = {
  content: string;
  filename?: string;
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
    archive.finalize();
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
  httpHandlers: { file: string; exports: ExtractedFunction[] }[];
  tableHandlers: { file: string; exports: ExtractedTableFunction[] }[];
};

export const discoverHandlers = (files: string[]): DiscoveredHandlers => {
  const httpHandlers: { file: string; exports: ExtractedFunction[] }[] = [];
  const tableHandlers: { file: string; exports: ExtractedTableFunction[] }[] = [];

  for (const file of files) {
    // Skip directories
    if (!fsSync.statSync(file).isFile()) continue;

    const source = fsSync.readFileSync(file, "utf-8");
    const http = extractConfigs(source);
    const table = extractTableConfigs(source);

    if (http.length > 0) httpHandlers.push({ file, exports: http });
    if (table.length > 0) tableHandlers.push({ file, exports: table });
  }

  return { httpHandlers, tableHandlers };
};
