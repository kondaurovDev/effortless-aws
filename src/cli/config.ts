import { Options } from "@effect/cli";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "url";
import * as esbuild from "esbuild";
import type { EffortlessConfig } from "~/config";

export const loadConfig = async (): Promise<EffortlessConfig | null> => {
  const configPath = path.resolve(process.cwd(), "effortless.config.ts");

  if (!fs.existsSync(configPath)) {
    return null;
  }

  const result = await esbuild.build({
    entryPoints: [configPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    external: ["@effect-ak/effortless"],
  });

  const output = result.outputFiles?.[0];
  if (!output) {
    return null;
  }
  const code = output.text;
  const tempFile = path.join(process.cwd(), ".effortless-config.mjs");
  fs.writeFileSync(tempFile, code);

  try {
    const mod = await import(pathToFileURL(tempFile).href);
    return mod.default;
  } finally {
    fs.unlinkSync(tempFile);
  }
};

export const projectOption = Options.text("project").pipe(
  Options.withAlias("p"),
  Options.withDescription("Project name (or 'name' in effortless.config.ts)"),
  Options.optional
);

export const stageOption = Options.text("stage").pipe(
  Options.withAlias("s"),
  Options.withDescription("Stage name"),
  Options.withDefault("dev")
);

export const regionOption = Options.text("region").pipe(
  Options.withAlias("r"),
  Options.withDescription("AWS region"),
  Options.withDefault("eu-central-1")
);

export const verboseOption = Options.boolean("verbose").pipe(
  Options.withAlias("v"),
  Options.withDescription("Enable verbose logging")
);

export const outputOption = Options.text("output").pipe(
  Options.withAlias("o"),
  Options.withDescription("Output directory"),
  Options.withDefault(".effortless")
);

export const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Show what would be deleted without deleting")
);

export const getPatternsFromConfig = (config: EffortlessConfig | null): string[] | null => {
  const handlersConfig = config?.handlers;
  if (!handlersConfig || (Array.isArray(handlersConfig) && handlersConfig.length === 0)) {
    return null;
  }
  const rawPatterns = Array.isArray(handlersConfig) ? handlersConfig : [handlersConfig];
  return rawPatterns.map(p => {
    if (!p.includes("*") && !p.includes("?")) {
      return `${p.replace(/\/$/, "")}/**/*.ts`;
    }
    return p;
  });
};
