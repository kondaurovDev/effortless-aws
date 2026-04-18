/** CORS configuration for the HTTP API Gateway. */
export type GatewayCorsConfig = {
  /** Allowed origins (e.g. ["https://app.site"]). @default ["*"] */
  origins?: string[];
  /** Allowed HTTP methods. @default ["*"] */
  methods?: string[];
  /** Allowed headers. @default ["*"] */
  headers?: string[];
  /** Max age in seconds for preflight cache. */
  maxAge?: number;
};

/** HTTP API Gateway configuration. */
export type GatewayConfig = {
  /** CORS settings. If omitted, allows all origins/methods/headers. */
  cors?: GatewayCorsConfig;
  /** Custom domain name. Accepts a string (same domain for all stages) or a Record mapping stage names to domains. */
  domain?: string | Record<string, string>;
};

/**
 * Configuration for an Effortless project.
 *
 * @see {@link https://effortless-aws.website/configuration | Configuration guide}
 */
export type EffortlessConfig = {
  /**
   * Project name used for resource naming and tagging.
   * This becomes part of Lambda function names, IAM roles, etc.
   */
  name: string;

  /**
   * Default AWS region for all handlers.
   * Can be overridden per-handler or via CLI `--region` flag.
   * @default "eu-central-1"
   */
  region?: string;

  /**
   * Deployment stage (e.g., "dev", "staging", "prod").
   * Used for resource isolation and tagging.
   * @default "dev"
   */
  stage?: string;

  /**
   * Glob patterns or directory paths to scan for handlers.
   * Used by `eff deploy` (without file argument) to auto-discover handlers.
   *
   * @example
   * ```typescript
   * // Single directory - scans for all .ts files
   * handlers: "src"
   *
   * // Glob patterns
   * handlers: ["src/**\/*.ts", "lib/**\/*.handler.ts"]
   * ```
   */
  handlers?: string | string[];

  /**
   * Default Lambda settings applied to all handlers unless overridden.
   *
   * All Lambdas run on ARM64 (Graviton2) architecture — ~20% cheaper than x86_64
   * with better price-performance for most workloads.
   */
  lambda?: {
    /**
     * Lambda memory in MB. AWS allocates proportional CPU —
     * 1769 MB gives one full vCPU.
     * @default 256
     */
    memory?: number;

    /**
     * Lambda timeout as a human-readable string.
     * AWS maximum is 15 minutes.
     * @example "30 seconds", "5 minutes"
     */
    timeout?: string;

    /**
     * Node.js Lambda runtime version.
     * @default "nodejs24.x"
     */
    runtime?: string;
  };

  /**
   * HTTP API Gateway configuration for API handlers.
   * When present, non-streaming API handlers are deployed behind an HTTP API Gateway
   * instead of Lambda Function URLs. If omitted, a gateway is still created with default
   * settings (CORS allowing all origins).
   *
   * Streaming APIs (`stream: true`) always use Function URLs regardless of this setting.
   */
  gateway?: GatewayConfig;

};

/** Helper function for type-safe configuration with TypeScript autocompletion. */
export const defineConfig = (config: EffortlessConfig): EffortlessConfig => config;
