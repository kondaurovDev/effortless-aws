#!/usr/bin/env node

import { CliConfig, Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { createRequire } from "module";

import { deployCommand } from "./commands/deploy";
import { statusCommand } from "./commands/status";
import { cleanupCommand } from "./commands/cleanup";
import { logsCommand } from "./commands/logs";
import { layerCommand } from "./commands/layer";
import { configCommand } from "./commands/config";
import { buildCommand } from "./commands/build";
import { checkForUpdate } from "./update-check";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json");
const versionString = `${version} (${new URL(".", import.meta.url).pathname})`;

const mainCommand = Command.make("eff").pipe(
  Command.withSubcommands([deployCommand, statusCommand, logsCommand, cleanupCommand, layerCommand, configCommand, buildCommand]),
  Command.withDescription("Code-first AWS Lambda framework")
);

const cli = Command.run(mainCommand, {
  name: "effortless",
  version: versionString,
});

const updateCheck = checkForUpdate(version);

cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  Effect.provide(CliConfig.layer({ showBuiltIns: false, showTypes: false })),
  Effect.tap(() => Effect.promise(() => updateCheck)),
  NodeRuntime.runMain
);
