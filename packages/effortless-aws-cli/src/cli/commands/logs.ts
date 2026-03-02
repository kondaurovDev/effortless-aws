import { Args, Command, Options } from "@effect/cli";
import { Effect, Console, Logger, LogLevel, Option, Schedule } from "effect";

import { Aws } from "../../aws";
import { findHandlerFiles, discoverHandlers } from "~/build/bundle";
import { loadConfig, projectOption, stageOption, regionOption, verboseOption, getPatternsFromConfig } from "~/cli/config";
import { c } from "~/cli/colors";

const { cloudwatch_logs } = Aws;

const handlerArg = Args.text({ name: "handler" }).pipe(
  Args.withDescription("Handler name to show logs for"),
);

const tailOption = Options.boolean("tail").pipe(
  Options.withAlias("f"),
  Options.withDescription("Continuously poll for new logs")
);

const sinceOption = Options.text("since").pipe(
  Options.withDescription("How far back to start (e.g. '5m', '1h', '30s')"),
  Options.withDefault("5m")
);

const parseDuration = (input: string): number => {
  const match = input.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 5 * 60 * 1000; // default 5m

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 5 * 60 * 1000;
  }
};

const formatTimestamp = (ts: number): string => {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
};

const LOG_LEVEL_COLORS: Record<string, (s: string) => string> = {
  ERROR: c.red,
  WARN: c.yellow,
  DEBUG: c.dim,
};

const formatLogMessage = (message: string): string => {
  // Remove trailing newline
  let msg = message.replace(/\n$/, "");

  // Strip Lambda metadata prefix (e.g. "2024-01-15T10:30:00.000Z\tRequestId\tINFO\t")
  const lambdaPrefix = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\t[a-f0-9-]+\t(\w+)\t/;
  const match = msg.match(lambdaPrefix);
  if (match) {
    const level = match[1]!;
    msg = msg.replace(lambdaPrefix, "");
    if (level !== "INFO") {
      const colorize = LOG_LEVEL_COLORS[level];
      const tag = colorize ? colorize(`[${level}]`) : `[${level}]`;
      msg = `${tag} ${msg}`;
    }
  }

  // Skip START/END/REPORT lines
  if (msg.startsWith("START RequestId:") || msg.startsWith("END RequestId:") || msg.startsWith("REPORT RequestId:")) {
    return "";
  }

  return msg;
};

const fetchLogs = (logGroupName: string, startTime: number, nextToken?: string) =>
  cloudwatch_logs.make("filter_log_events", {
    logGroupName,
    startTime,
    interleaved: true,
    ...(nextToken ? { nextToken } : {}),
  });

export const logsCommand = Command.make(
  "logs",
  { handler: handlerArg, project: projectOption, stage: stageOption, region: regionOption, tail: tailOption, since: sinceOption, verbose: verboseOption },
  ({ handler: handlerName, project: projectOpt, stage, region, tail, since, verbose }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(loadConfig);

      const project = Option.getOrElse(projectOpt, () => config?.name ?? "");
      const finalStage = config?.stage ?? stage;
      const finalRegion = config?.region ?? region;

      if (!project) {
        yield* Console.error("Error: --project is required (or set 'name' in effortless.config.ts)");
        return;
      }

      // Validate handler exists in code
      const projectDir = process.cwd();
      const patterns = getPatternsFromConfig(config);
      if (patterns) {
        const files = findHandlerFiles(patterns, projectDir);
        const discovered = discoverHandlers(files);

        const allHandlerNames = [
          ...discovered.httpHandlers.flatMap(h => h.exports.map(e => e.exportName)),
          ...discovered.tableHandlers.flatMap(h => h.exports.map(e => e.exportName)),
          ...discovered.appHandlers.flatMap(h => h.exports.map(e => e.exportName)),
          ...discovered.fifoQueueHandlers.flatMap(h => h.exports.map(e => e.exportName)),
        ];

        if (!allHandlerNames.includes(handlerName)) {
          yield* Console.error(`Handler "${handlerName}" not found in code.`);
          if (allHandlerNames.length > 0) {
            yield* Console.log("\nAvailable handlers:");
            for (const name of allHandlerNames) {
              yield* Console.log(`  ${name}`);
            }
          }
          return;
        }
      }

      const functionName = `${project}-${finalStage}-${handlerName}`;
      const logGroupName = `/aws/lambda/${functionName}`;

      const clientsLayer = Aws.makeClients({
        cloudwatch_logs: { region: finalRegion },
      });

      const logLevel = verbose ? LogLevel.Debug : LogLevel.Info;

      yield* Effect.gen(function* () {
        const durationMs = parseDuration(since);
        let startTime = Date.now() - durationMs;

        yield* Console.log(`Logs for ${c.bold(handlerName)} ${c.dim(`(${logGroupName})`)}:\n`);

        // Fetch initial logs
        let hasLogs = false;
        const result = yield* fetchLogs(logGroupName, startTime).pipe(
          Effect.catchAll((error) => {
            if (error instanceof Aws.cloudwatch_logs.CloudWatchLogsError && error.cause.name === "ResourceNotFoundException") {
              return Effect.succeed({ events: undefined, nextToken: undefined });
            }
            return Effect.fail(error);
          })
        );

        if (result.events && result.events.length > 0) {
          hasLogs = true;
          for (const event of result.events) {
            const ts = formatTimestamp(event.timestamp ?? 0);
            const msg = formatLogMessage(event.message ?? "");
            if (msg) {
              yield* Console.log(`${c.dim(ts)}  ${msg}`);
            }
            if (event.timestamp) {
              startTime = Math.max(startTime, event.timestamp + 1);
            }
          }
        }

        if (!hasLogs && !tail) {
          yield* Console.log("No logs found. Try --since 1h or --tail to wait for new logs.");
          return;
        }

        if (!tail) return;

        // Tail mode: poll every 2 seconds
        if (!hasLogs) {
          yield* Console.log("Waiting for logs... (Ctrl+C to stop)\n");
        }

        yield* Effect.repeat(
          Effect.gen(function* () {
            const result = yield* fetchLogs(logGroupName, startTime).pipe(
              Effect.catchAll(() => Effect.succeed({ events: undefined, nextToken: undefined }))
            );

            if (result.events && result.events.length > 0) {
              for (const event of result.events) {
                const ts = formatTimestamp(event.timestamp ?? 0);
                const msg = formatLogMessage(event.message ?? "");
                if (msg) {
                  yield* Console.log(`${c.dim(ts)}  ${msg}`);
                }
                if (event.timestamp) {
                  startTime = Math.max(startTime, event.timestamp + 1);
                }
              }
            }
          }),
          Schedule.spaced("2 seconds")
        );
      }).pipe(
        Effect.provide(clientsLayer),
        Logger.withMinimumLogLevel(logLevel)
      );
    })
).pipe(Command.withDescription("Show logs for a handler"));
