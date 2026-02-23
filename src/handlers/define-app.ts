import type { LambdaConfig } from "./handler-options";

/**
 * Configuration for a Lambda-served static site (API Gateway + Lambda)
 */
export type AppConfig = LambdaConfig & {
  /** Base URL path the site is served under (e.g., "/app") */
  path?: string;
  /** Directory containing the static site files, relative to project root */
  dir: string;
  /** Default file for directory requests (default: "index.html") */
  index?: string;
  /** SPA mode: serve index.html for all paths that don't match a file (default: false) */
  spa?: boolean;
  /** Shell command to run before deploy to generate site content (e.g., "npx astro build") */
  build?: string;
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
 * Deploy a static site via Lambda + API Gateway.
 * Files are bundled into the Lambda ZIP and served with auto-detected content types.
 *
 * For CDN-backed sites (S3 + CloudFront), use {@link defineStaticSite} instead.
 *
 * @param options - Site configuration: path, directory, optional SPA mode
 * @returns Handler object used by the deployment system
 *
 * @example Basic static site
 * ```typescript
 * export const app = defineApp({
 *   path: "/app",
 *   dir: "src/webapp",
 * });
 * ```
 */
export const defineApp = (options: AppConfig): AppHandler => ({
  __brand: "effortless-app",
  __spec: options,
});
