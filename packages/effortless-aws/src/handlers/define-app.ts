import type { LambdaWithPermissions } from "./handler-options";

/**
 * Configuration for deploying an SSR framework (Nuxt, Astro, etc.)
 * via CloudFront + S3 (static assets) + Lambda Function URL (server-side rendering).
 */
export type AppConfig = LambdaWithPermissions & {
  /** Directory containing the Lambda server handler (e.g., ".output/server").
   *  Must contain an `index.mjs` (or `index.js`) that exports a `handler` function. */
  server: string;
  /** Directory containing static assets for S3 (e.g., ".output/public") */
  assets: string;
  /** Base URL path (default: "/") */
  path?: string;
  /** Shell command to build the framework output (e.g., "nuxt build") */
  build?: string;
  /** Custom domain name. String or stage-keyed record (e.g., { prod: "app.example.com" }). */
  domain?: string | Record<string, string>;
};

/**
 * Internal handler object created by defineApp
 * @internal
 */
export type AppHandler = {
  readonly __brand: "effortless-app";
  readonly __spec: AppConfig;
};

/**
 * Deploy an SSR framework application via CloudFront + Lambda Function URL.
 *
 * Static assets from the `assets` directory are served via S3 + CloudFront CDN.
 * Server-rendered pages are handled by a Lambda function using the framework's
 * built output from the `server` directory.
 *
 * For static-only sites (no SSR), use {@link defineStaticSite} instead.
 *
 * @param options - App configuration: server directory, assets directory, optional build command
 * @returns Handler object used by the deployment system
 *
 * @example Nuxt SSR
 * ```typescript
 * export const app = defineApp({
 *   build: "nuxt build",
 *   server: ".output/server",
 *   assets: ".output/public",
 *   memory: 1024,
 * });
 * ```
 */
export const defineApp = (options: AppConfig): AppHandler => ({
  __brand: "effortless-app",
  __spec: options,
});
