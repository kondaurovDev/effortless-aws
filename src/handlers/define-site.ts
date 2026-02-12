/**
 * Configuration for a static site handler (serializable, extracted at build time)
 */
export type SiteConfig = {
  /** Handler name. Defaults to export name if not specified */
  name?: string;
  /** Base URL path the site is served under (e.g., "/app") */
  path: string;
  /** Directory containing the static site files, relative to project root */
  dir: string;
  /** Default file for directory requests (default: "index.html") */
  index?: string;
  /** SPA mode: serve index.html for all paths that don't match a file (default: false) */
  spa?: boolean;
  /** Shell command to run before deploy to generate site content (e.g., "npx astro build") */
  build?: string;
  /** Lambda memory in MB (default: 256) */
  memory?: number;
  /** Lambda timeout in seconds (default: 5) */
  timeout?: number;
};

/**
 * Internal handler object created by defineSite
 * @internal
 */
export type SiteHandler = {
  readonly __brand: "effortless-site";
  readonly config: SiteConfig;
};

/**
 * Define a static site endpoint that serves files from a directory via Lambda
 *
 * @param options - Site configuration: path, directory, optional SPA mode
 * @returns Handler object used by the deployment system
 *
 * @example Basic static site
 * ```typescript
 * export const app = defineSite({
 *   path: "/app",
 *   dir: "src/webapp",
 * });
 * ```
 *
 * @example Astro site with build step
 * ```typescript
 * export const dashboard = defineSite({
 *   path: "/dashboard",
 *   dir: "dist",
 *   build: "npx astro build",
 *   spa: true,
 * });
 * ```
 */
export const defineSite = (options: SiteConfig): SiteHandler => ({
  __brand: "effortless-site",
  config: options,
});
