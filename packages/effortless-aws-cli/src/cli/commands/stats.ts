import { Args, Command, Options } from "@effect/cli";
import { Effect, Console } from "effect";

import { Aws } from "../../aws";
import { findHandlerFiles } from "~/build/bundle";
import { discoverHandlers, flattenHandlers } from "~/discovery";
import { projectOption, stageOption, regionOption, verboseOption } from "~/cli/config";
import { CliContext, withCliContext } from "~/cli/cli-context";
import { c } from "~/cli/colors";
import { parseDuration } from "./logs";

const { cloudwatch, cloudwatch_logs, lambda } = Aws;

const handlerArg = Args.text({ name: "handler" }).pipe(
  Args.withDescription("Handler name to show stats for"),
);

const sinceOption = Options.text("since").pipe(
  Options.withDescription("How far back to query (e.g. '1h', '24h', '7d')"),
  Options.withDefault("24h")
);

// ============ Helpers ============

const NON_LAMBDA_TYPES = new Set(["worker", "site", "app", "mailer"]);

const formatMs = (ms: number): string => {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const formatNumber = (n: number): string =>
  n.toLocaleString("en-US");

const formatPct = (n: number): string =>
  `${n.toFixed(1)}%`;

const extractMetricValue = (
  results: { Id?: string; Values?: number[] }[],
  id: string,
  agg: "sum" | "max" | "avg",
): number => {
  const metric = results.find(r => r.Id === id);
  const values = metric?.Values ?? [];
  if (values.length === 0) return 0;
  if (agg === "sum") return values.reduce((a, b) => a + b, 0);
  if (agg === "max") return Math.max(...values);
  return values.reduce((a, b) => a + b, 0) / values.length;
};

const extractInsightsField = (
  row: { field?: string; value?: string }[],
  fieldName: string,
): number => {
  const field = row.find(f => f.field === fieldName);
  return field?.value ? parseFloat(field.value) : 0;
};

type InsightsRow = { field?: string; value?: string }[];

type InsightsResult = {
  status?: string;
  results?: InsightsRow[];
};

/** Poll a Logs Insights query until it completes. */
const pollQueryResults = (queryId: string): Effect.Effect<InsightsResult | undefined, any, any> =>
  Effect.gen(function* () {
    const result = yield* cloudwatch_logs.make("get_query_results", { queryId });

    if (result.status === "Complete" || result.status === "Failed" || result.status === "Cancelled") {
      return result as InsightsResult;
    }

    yield* Effect.sleep("500 millis");
    return yield* pollQueryResults(queryId);
  }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

// ============ Stats data (pure — no side effects) ============

// Lambda pricing (us-east-1, arm64)
const PRICE_PER_GB_SECOND = 0.0000133334;
const PRICE_PER_REQUEST = 0.0000002;

const estimateCost = (invocations: number, avgDurationMs: number, memoryMB: number): number => {
  const gbSeconds = (memoryMB / 1024) * (avgDurationMs / 1000) * invocations;
  return gbSeconds * PRICE_PER_GB_SECOND + invocations * PRICE_PER_REQUEST;
};

const formatCost = (dollars: number): string => {
  if (dollars < 0.005) return "<$0.01";
  if (dollars < 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(2)}`;
};

export type StatsResult = {
  handlerName: string;
  functionName: string;
  sinceLabel: string;
  invocations: number;
  errors: number;
  errorRate: number;
  throttles: number;
  duration: { p50: number; p95: number; p99: number; max: number };
  timeout: number;
  coldStarts: { count: number; rate: number; avgInitMs: number };
  memory: { configuredMB: number; peakUsedMB: number; usagePct: number };
  concurrency: { peak: number; avg: number };
  estimatedCost: number;
};

export type StatsError = {
  error: string;
  available?: string[];
};

/** Fetch Lambda stats for a handler. No Console output. */
export const getStats = (handlerName: string, since: string) =>
  Effect.gen(function* () {
    const { project, stage, patterns, projectDir } = yield* CliContext;

    // Resolve handler
    if (patterns) {
      const files = findHandlerFiles(patterns, projectDir);
      const discovered = yield* discoverHandlers(files);
      const allHandlers = flattenHandlers(discovered);
      const matched = allHandlers.find(h => h.exportName === handlerName);

      if (!matched) {
        return {
          error: `Handler "${handlerName}" not found in code`,
          available: allHandlers.map(h => h.exportName),
        } satisfies StatsError;
      }

      if (NON_LAMBDA_TYPES.has(matched.type)) {
        return {
          error: `"${handlerName}" is a ${matched.type} handler. Stats are only supported for Lambda handlers (api, table, queue, bucket, cron, mcp).`,
        } satisfies StatsError;
      }
    }

    const functionName = `${project}-${stage}-${handlerName}`;
    const logGroupName = `/aws/lambda/${functionName}`;
    const durationMs = parseDuration(since);
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - durationMs);

    // Period: use full range as single bucket, clamped to CloudWatch limits
    const totalSeconds = Math.max(60, Math.ceil(durationMs / 1000));
    const period = Math.min(totalSeconds, 86400);

    const makeDimensions = () => [{ Name: "FunctionName", Value: functionName }];
    const makeMetric = (metricName: string) => ({
      Namespace: "AWS/Lambda",
      MetricName: metricName,
      Dimensions: makeDimensions(),
    });

    // Run all queries in parallel
    const [metricsResult, functionConfig, insightsResult] = yield* Effect.all([
      // CloudWatch Metrics
      cloudwatch.make("get_metric_data", {
        StartTime: startTime,
        EndTime: endTime,
        MetricDataQueries: [
          { Id: "invocations", MetricStat: { Metric: makeMetric("Invocations"), Period: period, Stat: "Sum" } },
          { Id: "errors", MetricStat: { Metric: makeMetric("Errors"), Period: period, Stat: "Sum" } },
          { Id: "throttles", MetricStat: { Metric: makeMetric("Throttles"), Period: period, Stat: "Sum" } },
          { Id: "p50", MetricStat: { Metric: makeMetric("Duration"), Period: period, Stat: "p50" } },
          { Id: "p95", MetricStat: { Metric: makeMetric("Duration"), Period: period, Stat: "p95" } },
          { Id: "p99", MetricStat: { Metric: makeMetric("Duration"), Period: period, Stat: "p99" } },
          { Id: "duration_max", MetricStat: { Metric: makeMetric("Duration"), Period: period, Stat: "Maximum" } },
          { Id: "concurrency_max", MetricStat: { Metric: makeMetric("ConcurrentExecutions"), Period: period, Stat: "Maximum" } },
          { Id: "concurrency_avg", MetricStat: { Metric: makeMetric("ConcurrentExecutions"), Period: period, Stat: "Average" } },
        ],
      }).pipe(Effect.catchAll(() => Effect.succeed({ MetricDataResults: [] as { Id?: string; Values?: number[] }[] }))),

      // Lambda configuration (for memory + timeout)
      lambda.make("get_function_configuration", { FunctionName: functionName }).pipe(
        Effect.catchAll(() => Effect.succeed({ MemorySize: undefined as number | undefined, Timeout: undefined as number | undefined })),
      ),

      // CloudWatch Logs Insights (cold starts + memory)
      Effect.gen(function* () {
        const query = yield* cloudwatch_logs.make("start_query", {
          logGroupName,
          startTime: Math.floor(startTime.getTime() / 1000),
          endTime: Math.floor(endTime.getTime() / 1000),
          queryString: [
            `filter @type = "REPORT"`,
            `| stats count() as total,`,
            `  count(@initDuration) as coldStarts,`,
            `  avg(@initDuration) as avgInit,`,
            `  max(@maxMemoryUsed) as peakMemory`,
          ].join("\n"),
        });

        if (!query.queryId) return undefined;
        return yield* pollQueryResults(query.queryId);
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
    ], { concurrency: "unbounded" });

    const results = metricsResult.MetricDataResults ?? [];

    const invocations = extractMetricValue(results, "invocations", "sum");
    const errors = extractMetricValue(results, "errors", "sum");
    const throttles = extractMetricValue(results, "throttles", "sum");

    // Parse Logs Insights results
    let coldStartCount = 0;
    let avgInitMs = 0;
    let peakMemoryMB = 0;
    let insightsTotalInvocations = 0;

    if (insightsResult?.results && insightsResult.results.length > 0) {
      const row = insightsResult.results[0]!;
      insightsTotalInvocations = extractInsightsField(row, "total");
      coldStartCount = extractInsightsField(row, "coldStarts");
      avgInitMs = extractInsightsField(row, "avgInit");
      peakMemoryMB = Math.round(extractInsightsField(row, "peakMemory") / (1024 * 1024));
    }

    const configuredMB = functionConfig.MemorySize ?? 0;
    const timeoutSeconds = functionConfig.Timeout ?? 0;
    const totalForRate = insightsTotalInvocations || invocations;
    const avgDurationMs = extractMetricValue(results, "p50", "avg");

    return {
      handlerName,
      functionName,
      sinceLabel: since,
      invocations,
      errors,
      errorRate: invocations > 0 ? (errors / invocations) * 100 : 0,
      throttles,
      duration: {
        p50: avgDurationMs,
        p95: extractMetricValue(results, "p95", "avg"),
        p99: extractMetricValue(results, "p99", "avg"),
        max: extractMetricValue(results, "duration_max", "max"),
      },
      timeout: timeoutSeconds,
      coldStarts: {
        count: coldStartCount,
        rate: totalForRate > 0 ? (coldStartCount / totalForRate) * 100 : 0,
        avgInitMs,
      },
      memory: {
        configuredMB,
        peakUsedMB: peakMemoryMB,
        usagePct: configuredMB > 0 ? (peakMemoryMB / configuredMB) * 100 : 0,
      },
      concurrency: {
        peak: extractMetricValue(results, "concurrency_max", "max"),
        avg: extractMetricValue(results, "concurrency_avg", "avg"),
      },
      estimatedCost: configuredMB > 0 ? estimateCost(invocations, avgDurationMs, configuredMB) : 0,
    } satisfies StatsResult;
  });

// ============ Command ============

export const statsCommand = Command.make(
  "stats",
  { handler: handlerArg, project: projectOption, stage: stageOption, region: regionOption, since: sinceOption, verbose: verboseOption },
  ({ handler: handlerName, since, ...opts }) =>
    Effect.gen(function* () {
      const result = yield* getStats(handlerName, since);

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

      yield* Console.log(`\nStats for ${c.bold(result.handlerName)} ${c.dim(`(last ${result.sinceLabel})`)}:\n`);

      if (result.invocations === 0) {
        yield* Console.log("  No invocations found. Try --since 7d for a longer time range.");
        return;
      }

      // Invocations / Errors / Throttles
      const errorsStr = result.errors > 0
        ? c.red(`${formatNumber(result.errors)} (${formatPct(result.errorRate)})`)
        : `${formatNumber(result.errors)}`;

      const throttlesStr = result.throttles > 0
        ? c.yellow(formatNumber(result.throttles))
        : formatNumber(result.throttles);

      yield* Console.log(`  Invocations   ${formatNumber(result.invocations)}`);
      yield* Console.log(`  Errors        ${errorsStr}`);
      yield* Console.log(`  Throttles     ${throttlesStr}`);

      // Duration
      yield* Console.log("");
      let durationLine = `  Duration      p50: ${formatMs(result.duration.p50)}  p95: ${formatMs(result.duration.p95)}  p99: ${formatMs(result.duration.p99)}`;
      if (result.duration.max > 0) {
        const timeoutMs = result.timeout * 1000;
        const nearTimeout = timeoutMs > 0 && result.duration.max > timeoutMs * 0.8;
        const maxStr = nearTimeout
          ? c.red(`max: ${formatMs(result.duration.max)} (timeout: ${result.timeout}s)`)
          : `max: ${formatMs(result.duration.max)}`;
        durationLine += `  ${maxStr}`;
      }
      yield* Console.log(durationLine);

      // Cold starts
      const coldStr = result.coldStarts.count > 0
        ? `${formatNumber(result.coldStarts.count)} (${formatPct(result.coldStarts.rate)})  avg init: ${formatMs(result.coldStarts.avgInitMs)}`
        : "0";
      yield* Console.log(`  Cold starts   ${coldStr}`);

      // Memory
      if (result.memory.configuredMB > 0) {
        const memColor = result.memory.usagePct > 85 ? c.yellow : (s: string) => s;
        const memStr = result.memory.peakUsedMB > 0
          ? memColor(`${result.memory.configuredMB} MB configured, peak ${result.memory.peakUsedMB} MB (${formatPct(result.memory.usagePct)})`)
          : `${result.memory.configuredMB} MB configured`;
        yield* Console.log(`  Memory        ${memStr}`);
      }

      // Concurrency
      if (result.concurrency.peak > 0) {
        yield* Console.log(`  Concurrency   peak: ${Math.round(result.concurrency.peak)}  avg: ${result.concurrency.avg.toFixed(1)}`);
      }

      // Cost
      if (result.estimatedCost > 0) {
        yield* Console.log(`  Cost          ~${formatCost(result.estimatedCost)} ${c.dim("(excl. free tier)")}`);
      }

      yield* Console.log("");
    }).pipe(
      withCliContext(opts, (region) => Aws.makeClients({
        cloudwatch: { region },
        cloudwatch_logs: { region },
        lambda: { region },
      })),
    )
).pipe(Command.withDescription("Show Lambda performance stats: invocations, duration, cold starts, memory, concurrency"));
