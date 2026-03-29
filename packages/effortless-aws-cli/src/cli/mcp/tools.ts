import * as Effect from "effect/Effect";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { Aws } from "~/aws";
import { findHandlerFiles, discoverHandlers, flattenHandlers } from "~/build/bundle";
import { deployProject } from "~/deploy/deploy";
import { CliContext } from "~/cli/cli-context";
import { getStatus } from "~/cli/commands/status";
import { getLogs } from "~/cli/commands/logs";
import { getConfigList, setConfig } from "~/cli/commands/config";
import { getCleanupPreview, runCleanup } from "~/cli/commands/cleanup";
import { getLayerInfo } from "~/cli/commands/layer";
import { makeContext, runToolEffect } from "./run-effect";

// ============ describe ============

export const handleDescribe = async (): Promise<CallToolResult> =>
  runToolEffect(
    Effect.gen(function* () {
      const { project, stage, region, patterns, projectDir, config } = yield* CliContext;
      const handlers = patterns
        ? flattenHandlers(yield* discoverHandlers(findHandlerFiles(patterns, projectDir), projectDir))
            .map(h => ({ name: h.exportName, type: h.type, file: h.file }))
        : [];
      return { project, stage, region, projectDir, handlersPattern: config?.handlers ?? null, handlers };
    }).pipe(makeContext()),
  );

// ============ cloud-status ============

export const handleCloudStatus = async (): Promise<CallToolResult> =>
  runToolEffect(
    getStatus.pipe(
      makeContext((region) => Aws.makeClients({
        lambda: { region },
        cloudfront: { region: "us-east-1" },
        resource_groups_tagging_api: { region },
      })),
    ),
  );

// ============ logs ============

export const handleLogs = async (args: {
  handler: string;
  since?: string;
  lines?: number;
}): Promise<CallToolResult> =>
  runToolEffect(
    getLogs(args.handler, args.since, args.lines).pipe(
      makeContext((region) => Aws.makeClients({
        cloudwatch_logs: { region },
      })),
    ),
  );

// ============ config-list ============

export const handleConfigList = async (): Promise<CallToolResult> =>
  runToolEffect(getConfigList.pipe(makeContext()));

// ============ config-set ============

export const handleConfigSet = async (args: {
  key: string;
  value: string;
}): Promise<CallToolResult> =>
  runToolEffect(setConfig(args.key, args.value).pipe(makeContext()));

// ============ cleanup-preview ============

export const handleCleanupPreview = async (args: {
  handler?: string;
  stale?: boolean;
  all?: boolean;
}): Promise<CallToolResult> =>
  runToolEffect(
    getCleanupPreview(args).pipe(
      makeContext((region) => Aws.makeClients({
        lambda: { region },
        iam: { region },
        apigatewayv2: { region },
        dynamodb: { region },
        resource_groups_tagging_api: { region },
        s3: { region },
        sqs: { region },
        ecs: { region },
        cloudwatch_logs: { region },
        scheduler: { region },
        sesv2: { region },
        cloudfront: { region: "us-east-1" },
      })),
    ),
  );

// ============ cleanup ============

export const handleCleanup = async (args: {
  handler?: string;
  stale?: boolean;
  all?: boolean;
}): Promise<CallToolResult> =>
  runToolEffect(
    runCleanup(args).pipe(
      makeContext((region) => Aws.makeClients({
        lambda: { region },
        iam: { region },
        apigatewayv2: { region },
        dynamodb: { region },
        resource_groups_tagging_api: { region },
        s3: { region },
        sqs: { region },
        ecs: { region },
        cloudwatch_logs: { region },
        scheduler: { region },
        sesv2: { region },
        cloudfront: { region: "us-east-1" },
      })),
    ),
  );

// ============ layer-info ============

export const handleLayerInfo = async (): Promise<CallToolResult> =>
  runToolEffect(getLayerInfo.pipe(makeContext()));

// ============ deploy ============

export const handleDeploy = async (args: {
  target?: string;
  noSites?: boolean;
}): Promise<CallToolResult> =>
  runToolEffect(
    Effect.gen(function* () {
      const { project, stage, region, patterns, projectDir } = yield* CliContext;

      if (!patterns) {
        return { error: "No 'handlers' patterns in effortless.config.ts" };
      }

      const results = yield* deployProject({
        projectDir,
        patterns,
        project,
        stage,
        region,
        noSites: args.noSites,
        silent: true,
      });

      const summary = {
        tables: results.tableResults.map(r => ({ name: r.exportName, tableArn: r.tableArn })),
        apis: results.apiResults.map(r => ({ name: r.exportName, url: r.url })),
        apps: results.appResults.map(r => ({ name: r.exportName, url: r.url })),
        sites: results.staticSiteResults.map(r => ({ name: r.exportName, url: r.url })),
        crons: results.cronResults.map(r => ({ name: r.exportName, schedule: r.schedule })),
        queues: results.fifoQueueResults.map(r => ({ name: r.exportName })),
        buckets: results.bucketResults.map(r => ({ name: r.exportName })),
        mailers: results.mailerResults.map(r => ({ name: r.exportName })),
      };

      const total = Object.values(summary).reduce((acc, arr) => acc + arr.length, 0);
      return { deployed: total, ...summary };
    }).pipe(
      makeContext((region) => Aws.makeClients({
        lambda: { region },
        iam: { region },
        dynamodb: { region },
        resource_groups_tagging_api: { region },
        s3: { region },
        cloudfront: { region: "us-east-1" },
        acm: { region: "us-east-1" },
      })),
    ),
  );
