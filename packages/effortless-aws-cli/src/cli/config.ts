import { Options } from "@effect/cli";
import { Path, FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { esbuildEval } from "../build/esbuild";
import type { EffortlessConfig } from "effortless-aws";

export type LoadedConfig = {
  config: EffortlessConfig | null;
  configDir: string;
};

export const loadConfig = Effect.fn("loadConfig")(function* () {
  const p = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const configPath = p.resolve(process.cwd(), "effortless.config.ts");

  const exists = yield* fs.exists(configPath);
  if (!exists) {
    return { config: null, configDir: process.cwd() };
  }

  const configDir = p.dirname(configPath);

  const mod = yield* esbuildEval({
    entryPoints: [configPath],
  }).pipe(Effect.catchAll((err) => {
    return Effect.logWarning(`Failed to load ${configPath}: ${err.cause}`).pipe(
      Effect.map(() => null)
    );
  }));

  return { config: (mod as any)?.default as EffortlessConfig | null, configDir };
});

export const DEFAULT_STAGE = "dev";
export const DEFAULT_REGION = "eu-central-1";

export const projectOption = Options.text("project").pipe(
  Options.withAlias("p"),
  Options.withDescription("Project name (or 'name' in effortless.config.ts)"),
  Options.optional
);

export const stageOption = Options.text("stage").pipe(
  Options.withAlias("s"),
  Options.withDescription(`Deployment stage (default: ${DEFAULT_STAGE})`),
  Options.withDefault(DEFAULT_STAGE)
);

export const regionOption = Options.text("region").pipe(
  Options.withAlias("r"),
  Options.withDescription(`AWS region (default: ${DEFAULT_REGION})`),
  Options.withDefault(DEFAULT_REGION)
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

export const noSitesOption = Options.boolean("no-sites").pipe(
  Options.withDescription("Skip static site deployments")
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
      if (/\.tsx?$/.test(p)) return p;
      return `${p.replace(/\/$/, "")}/**/*.ts`;
    }
    return p;
  });
};
