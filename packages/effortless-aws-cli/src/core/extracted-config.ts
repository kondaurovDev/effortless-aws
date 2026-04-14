/**
 * Types for handler config extraction (used by both AST and deploy layers).
 */

import type { HandlerType } from "./handler-types";

/** Secret entry extracted from handler config at discovery time. */
export type SecretEntry = { propName: string; ssmKey: string; generate?: string };

/** @deprecated Use SecretEntry */
export type ParamEntry = SecretEntry;

/** API route extracted from a static site's routes map */
export type ApiRouteEntry = {
  /** CloudFront path pattern (e.g., "/api/*") */
  pattern: string;
  /** Export name of the referenced API handler */
  handlerExport: string;
  /** Access control mode (only relevant when route points to a bucket) */
  access?: "private" | "public";
};

/** Bucket route extracted from a static site's routes map */
export type BucketRouteEntry = {
  /** CloudFront path pattern (e.g., "/files/*") */
  pattern: string;
  /** Export name of the referenced bucket handler */
  bucketExportName: string;
  /** Access control mode */
  access: "private" | "public";
};

export type ExtractedConfig<T = unknown> = {
  exportName: string;
  config: T;
  hasHandler: boolean;
  depsKeys: string[];
  secretEntries: SecretEntry[];
  staticGlobs: string[];
  routePatterns: string[];
  /** API routes extracted from a static site's routes map (only for staticSite type) */
  apiRoutes: ApiRouteEntry[];
  /** Bucket routes extracted from a static site's routes map (only for staticSite type) */
  bucketRoutes: BucketRouteEntry[];
};

export type HandlerDefinition = {
  defineFn: string;
  handlerProps: readonly string[];
  wrapperFn: string;
};
