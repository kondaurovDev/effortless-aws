import { Command } from "@effect/cli";
import { Path, FileSystem } from "@effect/platform";
import { Effect, Console } from "effect";
import type { ProjectManifest, ProjectResource } from "effortless-aws";

import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { CliContext, withCliContext } from "~/cli/cli-context";
import { projectOption, stageOption, regionOption, verboseOption } from "~/cli/config";
import { c } from "~/cli/colors";
import { generateApiAdapter } from "~/generate/generate-ts-api";
import { generateCronAdapter } from "~/generate/generate-ts-cron";
import { generateTableStreamAdapter } from "~/generate/generate-ts-table-stream";
import { generateBucketAdapter } from "~/generate/generate-ts-bucket";
import { generateQueueAdapter } from "~/generate/generate-ts-queue";
import { generateStub } from "~/generate/generate-ts-stub";

// ============ Project mode: generate from manifest ============

const RESOURCE_TYPE_TO_DEP_TYPE: Record<string, string> = {
  table: "table",
  bucket: "bucket",
  queue: "fifoQueue",
  worker: "worker",
  mailer: "mailer",
};

const resolveDepsFromLink = (
  link: string[] | undefined,
  resources: Record<string, ProjectResource>,
): Record<string, string> => {
  const deps: Record<string, string> = {};
  if (!link) return deps;
  for (const name of link) {
    const resource = resources[name];
    if (!resource || resource.__type === "secret") continue;
    const depType = RESOURCE_TYPE_TO_DEP_TYPE[resource.__type];
    if (depType) deps[name] = depType;
  }
  return deps;
};

type GeneratorFn = (input: { deps: Record<string, string> }) => string;

const GENERATORS: Record<string, GeneratorFn> = {
  api: (input) => generateApiAdapter({ deps: input.deps }),
  cron: (input) => generateCronAdapter({ deps: input.deps }),
  table: (input) => generateTableStreamAdapter({ deps: input.deps }),
  bucket: (input) => generateBucketAdapter({ deps: input.deps }),
  queue: (input) => generateQueueAdapter({ deps: input.deps }),
};

const generateFromManifest = (manifest: ProjectManifest) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const { projectDir } = yield* CliContext;

    let generated = 0;
    let skipped = 0;

    for (const [name, resource] of Object.entries(manifest.resources)) {
      // Only generate for resources with handlers
      if (!("handler" in resource) || !(resource as any).handler) continue;
      const handlerPath = (resource as any).handler as string;
      const resourceType = resource.__type;

      const generator = GENERATORS[resourceType];
      if (!generator) {
        yield* Console.log(`  ${c.dim("?")} ${c.dim(name)} ${c.dim(`(no generator for type "${resourceType}", skipping)`)}`);
        continue;
      }

      const fullHandlerPath = p.isAbsolute(handlerPath)
        ? handlerPath
        : p.resolve(projectDir, handlerPath);

      const handlerDir = p.dirname(fullHandlerPath);
      yield* fs.makeDirectory(handlerDir, { recursive: true });

      // Resolve deps from link references
      const deps = resolveDepsFromLink((resource as any).link, manifest.resources);

      // Generate handler.gen.ts (always overwrite)
      const adapterCode = generator({ deps });
      const genFileName = p.basename(fullHandlerPath).replace(/\.\w+$/, ".gen.ts");
      const genPath = p.join(handlerDir, genFileName);
      yield* fs.writeFileString(genPath, adapterCode);
      yield* Console.log(`  ${c.cyan("\u21BB")} ${c.dim(p.relative(projectDir, genPath))} ${c.dim("(regenerated)")}`);
      generated++;

      // Generate handler file stub (only if doesn't exist)
      const genName = p.basename(fullHandlerPath).replace(/\.\w+$/, ".gen");
      const stubExists = yield* fs.exists(fullHandlerPath);
      if (!stubExists) {
        const stubCode = generateStub({ type: resourceType, deps, genName });
        yield* fs.writeFileString(fullHandlerPath, stubCode);
        yield* Console.log(`  ${c.green("+")} ${c.dim(p.relative(projectDir, fullHandlerPath))} ${c.dim("(new scaffold)")}`);
        generated++;
      } else {
        yield* Console.log(`  ${c.dim("\u2713")} ${c.dim(p.relative(projectDir, fullHandlerPath))} ${c.dim("(exists, skipping)")}`);
        skipped++;
      }
    }

    if (generated === 0 && skipped === 0) {
      yield* Console.log("No resources with handler paths found in defineProject().");
    } else {
      yield* Console.log(`\n${c.green("Done.")} ${generated} file(s) generated, ${skipped} skipped.`);
    }
  });

// ============ Legacy mode: generate from discovered handlers ============

const generateFromDiscovery = Effect.gen(function* () {
  const p = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const { patterns, projectDir } = yield* CliContext;

  if (!patterns) {
    yield* Console.error("Error: No 'handlers' patterns in config");
    return;
  }

  const files = findHandlerFiles(patterns, projectDir);
  if (files.length === 0) {
    yield* Console.error("No handler files found");
    return;
  }

  const discovered = yield* discoverHandlers(files, projectDir);

  let generated = 0;
  let skipped = 0;

  // Process API handlers with external handler paths
  for (const { exports: handlers } of discovered.apiHandlers) {
    for (const handler of handlers) {
      const handlerPath = (handler.config as any).handler as string | undefined;
      if (!handlerPath) continue;

      const fullHandlerDir = p.isAbsolute(handlerPath)
        ? handlerPath
        : p.resolve(projectDir, handlerPath);

      yield* fs.makeDirectory(fullHandlerDir, { recursive: true });

      // Generate handler.gen.ts (always overwrite)
      const adapterCode = generateApiAdapter({
        deps: handler.depsTypes,
        stream: (handler.config as any).stream,
      });
      const genPath = p.join(fullHandlerDir, "handler.gen.ts");
      yield* fs.writeFileString(genPath, adapterCode);
      yield* Console.log(`  ${c.cyan("\u21BB")} ${c.dim(p.relative(projectDir, genPath))} ${c.dim("(regenerated)")}`);
      generated++;

      // Generate handler.ts (only if doesn't exist)
      const stubPath = p.join(fullHandlerDir, "handler.ts");
      const stubExists = yield* fs.exists(stubPath);
      if (!stubExists) {
        const stubCode = generateStub({ type: "api", deps: handler.depsTypes });
        yield* fs.writeFileString(stubPath, stubCode);
        yield* Console.log(`  ${c.green("+")} ${c.dim(p.relative(projectDir, stubPath))} ${c.dim("(new scaffold)")}`);
        generated++;
      } else {
        yield* Console.log(`  ${c.dim("\u2713")} ${c.dim(p.relative(projectDir, stubPath))} ${c.dim("(exists, skipping)")}`);
        skipped++;
      }
    }
  }

  if (generated === 0 && skipped === 0) {
    yield* Console.log("No handlers with external handler paths found.");
    yield* Console.log(c.dim('Add handler: "./path" to defineApi() to use code generation.'));
  } else {
    yield* Console.log(`\n${c.green("Done.")} ${generated} file(s) generated, ${skipped} skipped.`);
  }
});

// ============ Main generate logic ============

const generateAll = Effect.gen(function* () {
  const { manifest } = yield* CliContext;

  if (manifest) {
    yield* generateFromManifest(manifest);
  } else {
    yield* generateFromDiscovery;
  }
});

// ============ Command ============

export const generateCommand = Command.make(
  "generate",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  (opts) => generateAll.pipe(withCliContext(opts))
).pipe(Command.withDescription("Generate handler adapters and stubs from infrastructure definitions"));
