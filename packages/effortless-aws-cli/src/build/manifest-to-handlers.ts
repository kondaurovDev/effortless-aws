/**
 * Bridge between ProjectManifest and the existing deploy pipeline.
 *
 * Converts a defineProject() manifest into the same DiscoveredHandlers shape
 * that the legacy discovery pipeline produces, so deploy-*.ts files work unchanged.
 */

import type { ProjectManifest, ProjectResource, ProjectTable, ProjectApi, ProjectBucket, ProjectCron, ProjectQueue, ProjectWorker, ProjectMailer, ProjectSecret } from "effortless-aws";
import type { TableConfig, ApiConfig, BucketConfig, CronConfig, FifoQueueConfig, WorkerConfig, MailerConfig } from "effortless-aws";
import type { ExtractedConfig, SecretEntry } from "./handler-registry";
import type { DiscoveredHandlers } from "./bundle";

// ============ Resource type → dep type mapping ============

const RESOURCE_TYPE_TO_DEP_TYPE: Record<string, string> = {
  table: "table",
  bucket: "bucket",
  queue: "fifoQueue",
  worker: "worker",
  mailer: "mailer",
};

// ============ Conversion helpers ============

const resolveLinks = (
  link: string[] | undefined,
  resources: Record<string, ProjectResource>,
): { depsKeys: string[]; depsTypes: Record<string, string>; secretEntries: SecretEntry[] } => {
  const depsKeys: string[] = [];
  const depsTypes: Record<string, string> = {};
  const secretEntries: SecretEntry[] = [];

  if (!link) return { depsKeys, depsTypes, secretEntries };

  for (const name of link) {
    const resource = resources[name];
    if (!resource) continue;

    if (resource.__type === "secret") {
      const secret = resource as ProjectSecret;
      secretEntries.push({
        propName: name,
        ssmKey: secret.key ?? name,
        ...(secret.generate ? { generate: secret.generate } : {}),
      });
    } else {
      const depType = RESOURCE_TYPE_TO_DEP_TYPE[resource.__type];
      if (depType) {
        depsKeys.push(name);
        depsTypes[name] = depType;
      }
    }
  }

  return { depsKeys, depsTypes, secretEntries };
};

const makeExtracted = <T>(
  exportName: string,
  config: T,
  hasHandler: boolean,
  link: string[] | undefined,
  resources: Record<string, ProjectResource>,
): ExtractedConfig<T> => {
  const { depsKeys, depsTypes, secretEntries } = resolveLinks(link, resources);
  return {
    exportName,
    config,
    hasHandler,
    depsKeys,
    depsTypes,
    secretEntries,
    staticGlobs: [],
    routePatterns: [],
    apiRoutes: [],
    bucketRoutes: [],
  };
};

// ============ Main conversion ============

export const manifestToDiscoveredHandlers = (
  manifest: ProjectManifest,
  _projectDir: string,
): DiscoveredHandlers => {
  const result: DiscoveredHandlers = {
    tableHandlers: [],
    appHandlers: [],
    staticSiteHandlers: [],
    fifoQueueHandlers: [],
    bucketHandlers: [],
    mailerHandlers: [],
    apiHandlers: [],
    cronHandlers: [],
    workerHandlers: [],
    mcpHandlers: [],
  };

  for (const [name, resource] of Object.entries(manifest.resources)) {
    switch (resource.__type) {
      case "table": {
        const r = resource as ProjectTable;
        const config: TableConfig = {
          billingMode: r.billingMode,
          streamView: r.streamView,
          batchSize: r.batchSize,
          batchWindow: r.batchWindow,
          startingPosition: r.startingPosition,
          concurrency: r.concurrency,
          lambda: r.lambda,
        };
        const extracted = makeExtracted(name, config, !!r.handler, r.link, manifest.resources);
        result.tableHandlers.push({ file: r.handler ?? "", exports: [extracted] });
        break;
      }

      case "api": {
        const r = resource as ProjectApi;
        const config: ApiConfig = {
          basePath: r.basePath,
          stream: r.stream,
          handler: r.handler,
          lambda: r.lambda,
        };
        const extracted = makeExtracted(name, config, true, r.link, manifest.resources);
        result.apiHandlers.push({ file: r.handler, exports: [extracted] });
        break;
      }

      case "bucket": {
        const r = resource as ProjectBucket;
        const config: BucketConfig = {
          prefix: r.prefix,
          suffix: r.suffix,
          seed: r.seed,
          sync: r.sync,
          lambda: r.lambda,
        };
        const extracted = makeExtracted(name, config, !!r.handler, r.link, manifest.resources);
        result.bucketHandlers.push({ file: r.handler ?? "", exports: [extracted] });
        break;
      }

      case "cron": {
        const r = resource as ProjectCron;
        const config: CronConfig = {
          schedule: r.schedule,
          timezone: r.timezone,
          lambda: r.lambda,
        };
        const extracted = makeExtracted(name, config, true, r.link, manifest.resources);
        result.cronHandlers.push({ file: r.handler, exports: [extracted] });
        break;
      }

      case "queue": {
        const r = resource as ProjectQueue;
        const config: FifoQueueConfig = {
          batchSize: r.batchSize,
          batchWindow: r.batchWindow,
          visibilityTimeout: r.visibilityTimeout,
          retentionPeriod: r.retentionPeriod,
          delay: r.delay,
          contentBasedDeduplication: r.contentBasedDeduplication,
          maxReceiveCount: r.maxReceiveCount,
          lambda: r.lambda,
        };
        const extracted = makeExtracted(name, config, !!r.handler, r.link, manifest.resources);
        result.fifoQueueHandlers.push({ file: r.handler ?? "", exports: [extracted] });
        break;
      }

      case "worker": {
        const r = resource as ProjectWorker;
        const config: WorkerConfig = {
          size: r.size,
          idleTimeout: r.idleTimeout,
          concurrency: r.concurrency,
          lambda: r.lambda,
        };
        const extracted = makeExtracted(name, config, !!r.handler, r.link, manifest.resources);
        result.workerHandlers.push({ file: r.handler ?? "", exports: [extracted] });
        break;
      }

      case "mailer": {
        const r = resource as ProjectMailer;
        const config: MailerConfig = {
          domain: r.domain,
        };
        const extracted = makeExtracted(name, config, false, undefined, manifest.resources);
        result.mailerHandlers.push({ file: "", exports: [extracted] });
        break;
      }

      // "secret" resources are resolved via links, not deployed directly
      case "secret":
        break;
    }
  }

  return result;
};
