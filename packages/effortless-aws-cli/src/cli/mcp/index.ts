#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { handleDescribe, handleCloudStatus, handleLogs, handleDeploy, handleConfigList, handleConfigSet, handleCleanupPreview, handleCleanup, handleLayerInfo } from "./tools";

const server = new McpServer({ name: "effortless-aws", version: "1.0.0" });

server.registerTool("describe", {
  description: "Describe the effortless-aws project: list all handlers with their types and files, show project config (name, region, stage). No AWS calls — reads code only.",
  annotations: { readOnlyHint: true },
}, () => handleDescribe());

server.registerTool("cloud-status", {
  description: "Compare local code handlers with deployed AWS resources. Shows which handlers are new (not yet deployed), deployed, or stale (in AWS but removed from code).",
  annotations: { readOnlyHint: true },
}, () => handleCloudStatus());

server.registerTool("logs", {
  description: "Fetch recent CloudWatch logs for a handler. Returns log events with timestamps.",
  inputSchema: {
    handler: z.string().describe("Handler name to fetch logs for"),
    since: z.string().optional().describe("How far back to look (e.g. '5m', '1h', '30s'). Default: '5m'"),
    lines: z.number().optional().describe("Maximum number of log lines to return. Default: 100"),
  },
  annotations: { readOnlyHint: true },
}, (args) => handleLogs(args));

server.registerTool("config-list", {
  description: "List all config parameters (secrets) declared in handlers and show which are set vs missing in AWS SSM.",
  annotations: { readOnlyHint: true },
}, () => handleConfigList());

server.registerTool("config-set", {
  description: "Set a config parameter value in AWS SSM Parameter Store (stored as SecureString).",
  inputSchema: {
    key: z.string().describe("SSM parameter key (e.g. stripe/secret-key)"),
    value: z.string().describe("Value to set"),
  },
  annotations: { destructiveHint: true },
}, (args) => handleConfigSet(args));

server.registerTool("cleanup-preview", {
  description: "Preview what resources would be deleted by cleanup. Returns a list of handlers and resources that would be removed. Use before 'cleanup' to review.",
  inputSchema: {
    handler: z.string().optional().describe("Specific handler name to delete"),
    stale: z.boolean().optional().describe("Find stale resources — handlers not in code or leftover resources"),
    all: z.boolean().optional().describe("Delete all resources"),
  },
  annotations: { readOnlyHint: true },
}, (args) => handleCleanupPreview(args));

server.registerTool("cleanup", {
  description: "Delete deployed AWS resources. Use 'cleanup-preview' first to review what will be deleted. Requires one of: handler, stale, or all.",
  inputSchema: {
    handler: z.string().optional().describe("Specific handler name to delete"),
    stale: z.boolean().optional().describe("Delete stale resources — handlers not in code or leftover resources"),
    all: z.boolean().optional().describe("Delete all resources"),
  },
  annotations: { destructiveHint: true },
}, (args) => handleCleanup(args));

server.registerTool("layer-info", {
  description: "Show Lambda layer info: production dependencies, packages, lockfile hash. Useful for debugging bundle and layer issues.",
  annotations: { readOnlyHint: true },
}, () => handleLayerInfo());

server.registerTool("deploy", {
  description: "Deploy handlers to AWS. Deploys all handlers from config. Returns deployment results with URLs and ARNs.",
  inputSchema: {
    noSites: z.boolean().optional().describe("Skip static site deployments"),
  },
  annotations: { destructiveHint: true },
}, (args) => handleDeploy(args));

const transport = new StdioServerTransport();
await server.connect(transport);
