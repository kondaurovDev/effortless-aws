import { Args, Command, Options } from "@effect/cli";
import { Effect, Console, Schedule } from "effect";

import { Aws } from "../../aws";
import { findHandlerFiles } from "~/build/bundle";
import { discoverHandlers, flattenHandlers } from "~/discovery";
import { projectOption, stageOption, regionOption, verboseOption } from "~/cli/config";
import { CliContext, withCliContext } from "~/cli/cli-context";
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

// ============ Helpers ============

export const parseDuration = (input: string): number => {
  const match = input.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 5 * 60 * 1000;

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
  let msg = message.replace(/\n$/, "");

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

  if (msg.startsWith("START RequestId:") || msg.startsWith("END RequestId:") || msg.startsWith("REPORT RequestId:")) {
    return "";
  }

  return msg;
};

export const fetchLogs = (logGroupName: string, startTime: number, nextToken?: string) =>
  cloudwatch_logs.make("filter_log_events", {
    logGroupName,
    startTime,
    interleaved: true,
    ...(nextToken ? { nextToken } : {}),
  });

// ============ Log data (pure — no side effects) ============

export type LogEvent = {
  timestamp: string | null;
  message: string;
};

export type GetLogsResult = {
  logGroupName: string;
  count: number;
  events: LogEvent[];
};

export type GetLogsError = {
  error: string;
  available?: string[];
};

/** Fetch log events for a handler. No Console output. */
export const getLogs = (handlerName: string, since = "5m", maxLines = 100) =>
  Effect.gen(function* () {
    const { project, stage, patterns, projectDir } = yield* CliContext;

    // Resolve handler type for log group name
    let handlerType: string | undefined;
    if (patterns) {
      const files = findHandlerFiles(patterns, projectDir);
      const discovered = yield* discoverHandlers(files);
      const allHandlers = flattenHandlers(discovered);
      const matched = allHandlers.find(h => h.exportName === handlerName);

      if (!matched) {
        return {
          error: `Handler "${handlerName}" not found in code`,
          available: allHandlers.map(h => h.exportName),
        } satisfies GetLogsError;
      }

      handlerType = matched.type;
    }

    const resourceName = `${project}-${stage}-${handlerName}`;
    const logGroupName = handlerType === "worker"
      ? `/ecs/${resourceName}`
      : `/aws/lambda/${resourceName}`;

    const durationMs = parseDuration(since);
    const startTime = Date.now() - durationMs;

    const result = yield* fetchLogs(logGroupName, startTime).pipe(
      Effect.catchAll((error) => {
        if (error instanceof Aws.cloudwatch_logs.CloudWatchLogsError && error.cause.name === "ResourceNotFoundException") {
          return Effect.succeed({ events: undefined, nextToken: undefined });
        }
        return Effect.fail(error);
      }),
    );

    const events = (result.events ?? [])
      .filter(e => {
        const msg = e.message ?? "";
        return !msg.startsWith("START RequestId:") && !msg.startsWith("END RequestId:") && !msg.startsWith("REPORT RequestId:");
      })
      .slice(-maxLines)
      .map(e => ({
        timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : null,
        message: (e.message ?? "").replace(/\n$/, ""),
      }));

    return { logGroupName, count: events.length, events } satisfies GetLogsResult;
  });

// ============ Command ============

export const logsCommand = Command.make(
  "logs",
  { handler: handlerArg, project: projectOption, stage: stageOption, region: regionOption, tail: tailOption, since: sinceOption, verbose: verboseOption },
  ({ handler: handlerName, tail, since, ...opts }) =>
    Effect.gen(function* () {
      const result = yield* getLogs(handlerName, since);

      if ("error" in result) {
        yield* Console.error(result.error);
        if (result.available && result.available.length > 0) {
          yield* Console.log("\nAvailable handlers:");
          for (const name of result.available) {
            yield* Console.log(`  ${name}`);
          }
        }
        return;
      }

      yield* Console.log(`Logs for ${c.bold(handlerName)} ${c.dim(`(${result.logGroupName})`)}:\n`);

      if (result.events.length > 0) {
        for (const event of result.events) {
          const ts = event.timestamp ? formatTimestamp(new Date(event.timestamp).getTime()) : "";
          const msg = formatLogMessage(event.message);
          if (msg) {
            yield* Console.log(`${c.dim(ts)}  ${msg}`);
          }
        }
      }

      if (result.events.length === 0 && !tail) {
        yield* Console.log("No logs found. Try --since 1h or --tail to wait for new logs.");
        return;
      }

      if (!tail) return;

      if (result.events.length === 0) {
        yield* Console.log("Waiting for logs... (Ctrl+C to stop)\n");
      }

      let startTime = Date.now() - parseDuration(since);

      yield* Effect.repeat(
        Effect.gen(function* () {
          const pollResult = yield* fetchLogs(result.logGroupName, startTime).pipe(
            Effect.catchAll(() => Effect.succeed({ events: undefined, nextToken: undefined }))
          );

          if (pollResult.events && pollResult.events.length > 0) {
            for (const event of pollResult.events) {
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
      withCliContext(opts, (region) => Aws.makeClients({
        cloudwatch_logs: { region },
      })),
    )
).pipe(Command.withDescription("Stream CloudWatch logs for a handler. Supports --tail for live tailing and --since for time range"));
