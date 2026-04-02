/**
 * Integration test environment.
 *
 * Values are resolved in order:
 *   1. Environment variables (API_URL, API_DEPS_URL, SITE_URL)
 *   2. deploy.local.json (created by `eff deploy`, git-ignored)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalDeploy(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(__dirname, "deploy.local.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const local = loadLocalDeploy();

export const env = {
  /** Lambda Function URL for handlers/api.ts (no trailing slash) */
  apiUrl: strip(process.env.API_URL ?? local.testApi ?? ""),
  /** Lambda Function URL for handlers/api-with-deps.ts (no trailing slash) */
  apiDepsUrl: strip(process.env.API_DEPS_URL ?? local.api ?? ""),
  /** CloudFront URL for handlers/static-site.ts (no trailing slash) */
  siteUrl: strip(process.env.SITE_URL ?? local.site ?? ""),
};

function strip(url: string) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function requireEnv() {
  if (!env.apiUrl) {
    throw new Error(
      "API_URL is not set. Deploy the sandbox first:\n" +
      "  cd integration && eff deploy handlers/api.ts\n" +
      "Then set API_URL to the Lambda Function URL."
    );
  }
}
