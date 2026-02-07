#!/usr/bin/env node

import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { deployCommand } from "./commands/deploy";
import { buildCommand } from "./commands/build";
import { statusCommand } from "./commands/status";
import { cleanupCommand, cleanupRolesCommand } from "./commands/cleanup";
import { layersCommand } from "./commands/layers";

const mainCommand = Command.make("eff").pipe(
  Command.withSubcommands([deployCommand, buildCommand, statusCommand, cleanupCommand, cleanupRolesCommand, layersCommand]),
  Command.withDescription("Code-first AWS Lambda framework")
);

const cli = Command.run(mainCommand, {
  name: "effortless",
  version: "0.0.1",
});

cli(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
);
