import { Args, Command } from "@effect/cli";
import { Path } from "@effect/platform";
import { Effect, Console, Option } from "effect";

import { deploy, deployTable, deployAllTables, deployProject, type DeployTableResult, type DeployProjectResult } from "~/deploy/deploy";
import { findHandlerFiles, discoverHandlers, flattenHandlers } from "~/build/bundle";
import { Aws } from "../../aws";
import { projectOption, stageOption, regionOption, verboseOption, noSitesOption, getPatternsFromConfig } from "~/cli/config";
import { CliContext, withCliContext } from "~/cli/cli-context";
import { c } from "~/cli/colors";

const deployTargetArg = Args.text({ name: "target" }).pipe(
  Args.withDescription("Handler name or file path to deploy (optional - uses config patterns if not specified)"),
  Args.optional
);

const isFilePath = (target: string): boolean => {
  return target.includes("/") || target.includes("\\") || target.endsWith(".ts") || target.endsWith(".js");
};

// ============ Output formatting ============

const formatDeploySummary = (results: DeployProjectResult): string[] => {
  const total = results.tableResults.length + results.appResults.length + results.staticSiteResults.length + results.apiResults.length + results.cronResults.length;
  const lines: string[] = [`\n${c.green(`Deployed ${total} handler(s):`)}`];

  const summaryLines: { name: string; line: string }[] = [];
  for (const r of results.appResults) {
    summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[app]")}   ${c.bold(r.exportName)}  ${c.dim(r.url)}` });
  }
  for (const r of results.tableResults) {
    summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[table]")} ${c.bold(r.exportName)}` });
  }
  for (const r of results.apiResults) {
    summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[api]")}   ${c.bold(r.exportName)}  ${c.dim(r.url)}` });
  }
  for (const r of results.cronResults) {
    const tz = r.timezone ? ` ${c.dim(r.timezone)}` : "";
    summaryLines.push({ name: r.exportName, line: `  ${c.cyan("[cron]")}  ${c.bold(r.exportName)}  ${c.dim(r.schedule)}${tz}` });
  }
  for (const r of results.staticSiteResults) {
    let line = `  ${c.cyan("[site]")}  ${c.bold(r.exportName)}: ${c.cyan(r.url)}`;
    if (!r.url.includes(r.distributionDomain)) {
      line += `  ${c.dim(r.distributionDomain)}`;
    }
    const extras: string[] = [];
    if (r.seoGenerated) extras.push(`seo: ${r.seoGenerated.join(", ")}`);
    if (r.indexingResult) {
      const { submitted, skipped, failed } = r.indexingResult;
      if (submitted > 0 || failed > 0) {
        const parts = [`${submitted} submitted`];
        if (failed > 0) parts.push(c.red(`${failed} failed`));
        extras.push(`indexing: ${parts.join(", ")}`);
      } else {
        extras.push(`indexing: all ${skipped} pages already indexed`);
      }
    }
    if (extras.length > 0) line += `  ${c.dim(extras.join(" | "))}`;
    summaryLines.push({ name: r.exportName, line });
  }
  summaryLines.sort((a, b) => a.name.localeCompare(b.name));
  for (const { line } of summaryLines) {
    lines.push(line);
  }

  return lines;
};

// ============ Deploy handlers ============

const deployAll = (deployOpts: { noSites: boolean; verbose: boolean }) =>
  Effect.gen(function* () {
    const { project, stage, region, patterns, projectDir } = yield* CliContext;

    if (!patterns) {
      yield* Console.error("Error: No target specified and no 'handlers' patterns in config");
      return;
    }

    const results = yield* deployProject({
      projectDir,
      patterns,
      project,
      stage,
      region,
      noSites: deployOpts.noSites,
      verbose: deployOpts.verbose,
    });

    for (const line of formatDeploySummary(results)) {
      yield* Console.log(line);
    }
  });

const deployByFilePath = (targetValue: string) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const { project, stage, region, projectDir } = yield* CliContext;
    const fullPath = p.isAbsolute(targetValue) ? targetValue : p.resolve(projectDir, targetValue);

    const input = {
      projectDir,
      file: fullPath,
      project,
      stage,
      region,
    };

    const tableResults = yield* deployAllTables(input).pipe(
      Effect.catchIf(
        e => e instanceof Error && e.message.includes("No defineTable"),
        () => Effect.succeed([] as DeployTableResult[])
      )
    );

    if (tableResults.length === 0) {
      yield* Console.error("No handlers found in file");
      return;
    }

    yield* Console.log(c.green(`\nDeployed ${tableResults.length} table handler(s):`));
    for (const r of tableResults) {
      yield* Console.log(`  ${c.bold(r.exportName)}: ${c.dim(r.tableArn)}`);
    }
  });

const deployByName = (targetValue: string) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const { project, stage, region, patterns, projectDir } = yield* CliContext;

    if (!patterns) {
      yield* Console.error("Error: No 'handlers' patterns in config to search for handler name");
      return;
    }

    const files = findHandlerFiles(patterns, projectDir);
    const discovered = yield* discoverHandlers(files, projectDir);
    const allHandlers = flattenHandlers(discovered);
    const found = allHandlers.find(h => h.exportName === targetValue);

    if (!found) {
      yield* Console.error(`Error: Handler "${targetValue}" not found`);
      yield* Console.log("\nAvailable handlers:");
      for (const h of allHandlers) {
        yield* Console.log(`  ${c.cyan(`[${h.type}]`.padEnd(9))} ${h.exportName}`);
      }
      return;
    }

    yield* Console.log(`Found handler ${c.bold(targetValue)} in ${c.dim(p.relative(projectDir, found.file))}`);

    const input = {
      projectDir,
      file: found.file,
      project,
      stage,
      region,
      exportName: found.exportName,
    };

    if (found.type === "table") {
      const result = yield* deployTable(input);
      yield* Console.log(`\n${c.green("Table deployed:")} ${c.dim(result.tableArn)}`);
    } else {
      const result = yield* deploy(input);
      yield* Console.log(`\n${c.green("Deployed:")} ${c.cyan(result.url)}`);
    }
  });

// ============ Command ============

export const deployCommand = Command.make(
  "deploy",
  { target: deployTargetArg, project: projectOption, stage: stageOption, region: regionOption, verbose: verboseOption, noSites: noSitesOption },
  ({ target, noSites, ...opts }) =>
    Option.match(target, {
      onNone: () => deployAll({ noSites, verbose: opts.verbose }),
      onSome: (targetValue) =>
        isFilePath(targetValue) ? deployByFilePath(targetValue) : deployByName(targetValue),
    }).pipe(
      withCliContext(opts, (region) => Aws.makeClients({
        lambda: { region },
        iam: { region },
        dynamodb: { region },
        resource_groups_tagging_api: { region },
        s3: { region },
        cloudfront: { region: "us-east-1" },
        acm: { region: "us-east-1" },
      })),
    )
).pipe(Command.withDescription("Deploy handlers to AWS Lambda. Accepts a handler name, file path, or deploys all from config"));
