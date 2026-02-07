/**
 * Configuration for an Effortless project.
 *
 * @example
 * ```typescript
 * // effortless.config.ts
 * import { defineConfig } from "@effect-ak/effortless";
 *
 * export default defineConfig({
 *   name: "my-service",
 *   region: "eu-central-1",
 *   handlers: "src",
 * });
 * ```
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
   * Default settings applied to all handlers unless overridden.
   */
  defaults?: {
    /**
     * Lambda memory in MB.
     * @default 256
     */
    memory?: number;

    /**
     * Lambda timeout as a human-readable string.
     * @example "30 seconds", "5 minutes"
     */
    timeout?: string;

    /**
     * Lambda runtime.
     * @default "nodejs22.x"
     */
    runtime?: string;
  };
};

/**
 * Helper function for type-safe configuration.
 * Returns the config object as-is, but provides TypeScript autocompletion.
 *
 * @example
 * ```typescript
 * import { defineConfig } from "@effect-ak/effortless";
 *
 * export default defineConfig({
 *   name: "my-service",
 *   region: "eu-central-1",
 *   handlers: "src",
 * });
 * ```
 */
export const defineConfig = (config: EffortlessConfig): EffortlessConfig => config;
