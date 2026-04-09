import { Effect } from "effect";
import { Path, FileSystem } from "@effect/platform";
import { builtinModules, createRequire } from "module";
import { esbuildBuild } from "./esbuild";
import type { Metafile } from "esbuild";
import archiver from "archiver";
import { globSync } from "glob";
import { generateEntryPoint, generateMiddlewareEntryPoint } from "./handler-registry";
import type { HandlerType } from "../core";

export type BundleInput = {
  projectDir: string;
  format?: "esm" | "cjs";
  file: string;
};

// ============ Bundle ============

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

    const sourcePath = p.isAbsolute(input.file) ? input.file : `./${input.file}`;

    const runtimeDir = yield* resolveRuntimeDir;
    const entryPoint = generateEntryPoint(sourcePath, exportName, type, runtimeDir);

    // AWS SDK v3 is provided by the Lambda runtime — mark external for Lambda handlers.
    // Workers run in a plain Node.js container (ECS Fargate), so SDK must be bundled in.
    const awsExternals = type === "worker" ? [] : ["@aws-sdk/*", "@smithy/*"];
    const nodeExternals = builtinModules.flatMap(m => [m, `node:${m}`]);
    const allExternals = [...new Set([...awsExternals, ...nodeExternals, ...externals])];

    const format = input.format ?? "esm";

    const result = yield* esbuildBuild({
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
      ...(format === "esm" ? { banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } } : {}),
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
const analyzeMetafile = (metafile: Metafile): { path: string; bytes: number }[] => {
  const packageSizes = new Map<string, number>();

  for (const [filePath, info] of Object.entries(metafile.inputs)) {
    const nodeModIdx = filePath.lastIndexOf("node_modules/");
    let key: string;
    if (nodeModIdx !== -1) {
      const afterNm = filePath.slice(nodeModIdx + "node_modules/".length);
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

    const result = yield* esbuildBuild({
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
    });

    const output = result.outputFiles?.[0];
    if (!output) {
      throw new Error("esbuild produced no output for middleware");
    }
    return output.text;
  });

// ============ Zip ============

export type StaticFile = {
  content: Buffer;
  zipPath: string;
};

export type ZipInput = {
  content: string;
  filename?: string;
  staticFiles?: StaticFile[];
};

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
