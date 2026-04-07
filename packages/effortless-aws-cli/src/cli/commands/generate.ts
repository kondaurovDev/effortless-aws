import { Command } from "@effect/cli";
import { Path, FileSystem } from "@effect/platform";
import { Effect, Console } from "effect";

import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { CliContext, withCliContext } from "~/cli/cli-context";
import { projectOption, stageOption, regionOption, verboseOption } from "~/cli/config";
import { c } from "~/cli/colors";
import { generateApiAdapter } from "~/generate/generate-ts-api";
import { generateApiStub } from "~/generate/generate-ts-stub";

// ============ Generate logic ============

const generateAll = Effect.gen(function* () {
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
        const stubCode = generateApiStub({ deps: handler.depsTypes });
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

// ============ Command ============

export const generateCommand = Command.make(
  "generate",
  { project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption },
  (opts) => generateAll.pipe(withCliContext(opts))
).pipe(Command.withDescription("Generate handler adapters and stubs from infrastructure definitions"));
