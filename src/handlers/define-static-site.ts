/**
 * Configuration for a static site handler (S3 + CloudFront)
 */
export type StaticSiteConfig = {
  /** Handler name. Defaults to export name if not specified */
  name?: string;
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
 * Internal handler object created by defineStaticSite
 * @internal
 */
export type StaticSiteHandler = {
  readonly __brand: "effortless-static-site";
  readonly __spec: StaticSiteConfig;
};

/**
 * Deploy a static site via S3 + CloudFront CDN.
 *
 * @param options - Static site configuration: directory, optional SPA mode, build command
 * @returns Handler object used by the deployment system
 *
 * @example Documentation site
 * ```typescript
 * export const docs = defineStaticSite({
 *   dir: "dist",
 *   build: "npx astro build",
 * });
 * ```
 *
 * @example SPA with client-side routing
 * ```typescript
 * export const app = defineStaticSite({
 *   dir: "dist",
 *   spa: true,
 *   build: "npm run build",
 * });
 * ```
 */
export const defineStaticSite = (options: StaticSiteConfig): StaticSiteHandler => ({
  __brand: "effortless-static-site",
  __spec: options,
});
