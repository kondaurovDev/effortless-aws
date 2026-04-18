import { homedir } from "os";
import * as path from "path";
import * as fs from "fs";
import { Effect } from "effect";
import type { DeployProjectResult } from "./deploy";
import { execSync } from "child_process";

// ============ Paths ============

const STATE_ROOT = path.join(homedir(), ".effortless-aws");

export const stateDir = (project: string, stage: string) =>
  path.join(STATE_ROOT, `${project}-${stage}`);

const handlersDir = (project: string, stage: string) =>
  path.join(stateDir(project, stage), "handlers");

// ============ Git SHA ============

const getGitSha = (projectDir: string): string | undefined => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: projectDir, encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
};

// ============ Manifest ============

export type DeployManifest = {
  deployedAt: string;
  project: string;
  stage: string;
  region: string;
  projectDir: string;
  gitSha?: string;
  layer?: {
    arn: string;
    version: number;
  };
  /** HTTP API Gateway URL (when non-streaming API handlers exist). */
  gatewayUrl?: string;
  handlers: Record<string, {
    type: string;
    status?: string;
    bundleSize?: number;
    functionArn?: string;
    url?: string;
    tableArn?: string;
    queueUrl?: string;
    bucketName?: string;
    schedule?: string;
  }>;
};

const resultToHandlers = (results: DeployProjectResult): DeployManifest["handlers"] => {
  const handlers: DeployManifest["handlers"] = {};

  for (const r of results.apiResults) {
    handlers[r.exportName] = { type: "api", functionArn: r.functionArn, url: r.url, bundleSize: r.bundleSize };
  }
  for (const r of results.mcpResults) {
    handlers[r.exportName] = { type: "mcp", functionArn: r.functionArn, url: r.url, bundleSize: r.bundleSize };
  }
  for (const r of results.tableResults) {
    handlers[r.exportName] = { type: "table", status: r.status, functionArn: r.functionArn, tableArn: r.tableArn, bundleSize: r.bundleSize };
  }
  for (const r of results.appResults) {
    handlers[r.exportName] = { type: "app", functionArn: r.functionArn, url: r.url };
  }
  for (const r of results.staticSiteResults) {
    handlers[r.exportName] = { type: "site", url: r.url };
  }
  for (const r of results.fifoQueueResults) {
    handlers[r.exportName] = { type: "queue", functionArn: r.functionArn, status: r.status, queueUrl: r.queueUrl, bundleSize: r.bundleSize };
  }
  for (const r of results.bucketResults) {
    handlers[r.exportName] = { type: "bucket", functionArn: r.functionArn, status: r.status, bucketName: r.bucketName, bundleSize: r.bundleSize };
  }
  for (const r of results.mailerResults) {
    handlers[r.exportName] = { type: "mailer" };
  }
  for (const r of results.cronResults) {
    handlers[r.exportName] = { type: "cron", functionArn: r.functionArn, status: r.status, schedule: r.schedule, bundleSize: r.bundleSize };
  }

  return handlers;
};

// ============ Write state ============

export type WriteStateInput = {
  project: string;
  stage: string;
  region: string;
  projectDir: string;
  results: DeployProjectResult;
  layerArn?: string;
  layerVersion?: number;
  logLines?: string[];
  bundles?: Map<string, string>;
};

export const writeDeployState = ({
  project, stage, region, projectDir, results,
  layerArn, layerVersion, logLines, bundles,
}: WriteStateInput) =>
  Effect.sync(() => {
    const dir = stateDir(project, stage);
    fs.mkdirSync(dir, { recursive: true });

    // manifest.json
    const manifest: DeployManifest = {
      deployedAt: new Date().toISOString(),
      project,
      stage,
      region,
      projectDir,
      gitSha: getGitSha(projectDir),
      ...(layerArn ? { layer: { arn: layerArn, version: layerVersion ?? 0 } } : {}),
      ...(results.gatewayUrl ? { gatewayUrl: results.gatewayUrl } : {}),
      handlers: resultToHandlers(results),
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    // deploy.log
    if (logLines && logLines.length > 0) {
      fs.writeFileSync(path.join(dir, "deploy.log"), logLines.join("\n") + "\n");
    }

    // handler bundles
    if (bundles && bundles.size > 0) {
      const hDir = handlersDir(project, stage);
      fs.mkdirSync(hDir, { recursive: true });
      for (const [name, code] of bundles) {
        fs.writeFileSync(path.join(hDir, `${name}.mjs`), code);
      }
    }
  });
