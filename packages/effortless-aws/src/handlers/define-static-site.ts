/** Any branded handler that deploys to API Gateway (HttpHandler, ApiHandler, etc.) */
type AnyRoutableHandler = { readonly __brand: string };

/** Simplified request object passed to middleware */
export type MiddlewareRequest = {
  uri: string;
  method: string;
  querystring: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
};

/** Redirect the user to another URL */
export type MiddlewareRedirect = {
  redirect: string;
  status?: 301 | 302 | 307 | 308;
};

/** Deny access with a 403 status */
export type MiddlewareDeny = {
  status: 403;
  body?: string;
};

/** Middleware return type: redirect, deny, or void (continue serving) */
export type MiddlewareResult = MiddlewareRedirect | MiddlewareDeny | void;

/** Function that runs before serving static files via Lambda@Edge */
export type MiddlewareHandler = (
  request: MiddlewareRequest
) => Promise<MiddlewareResult> | MiddlewareResult;

/** SEO options for auto-generating sitemap.xml, robots.txt, and submitting to Google Indexing API */
export type StaticSiteSeo = {
  /** Sitemap filename (e.g. "sitemap.xml", "sitemap-v2.xml") */
  sitemap: string;
  /** Path to Google service account JSON key file for Indexing API batch submission.
   * Requires adding the service account email as an owner in Google Search Console. */
  googleIndexing?: string;
};

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
  /** Custom domain name. Accepts a string (same domain for all stages) or a Record mapping stage names to domains (e.g., `{ prod: "example.com", dev: "dev.example.com" }`). Requires an ACM certificate in us-east-1. If the cert also covers www, a 301 redirect from www to non-www is set up automatically. */
  domain?: string | Record<string, string>;
  /** CloudFront route overrides: path patterns forwarded to API Gateway instead of S3.
   * Keys are CloudFront path patterns (e.g., "/api/*"), values are HTTP handlers.
   * Example: `routes: { "/api/*": api }` */
  routes?: Record<string, AnyRoutableHandler>;
  /** Custom 404 error page path relative to `dir` (e.g. "404.html").
   * For non-SPA sites only. If not set, a default page is generated automatically. */
  errorPage?: string;
  /** Lambda@Edge middleware that runs before serving pages. Use for auth checks, redirects, etc. */
  middleware?: MiddlewareHandler;
  /** SEO: auto-generate sitemap.xml and robots.txt at deploy time, optionally submit URLs to Google Indexing API */
  seo?: StaticSiteSeo;
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
 *
 */
export const defineStaticSite = () => (options: StaticSiteConfig): StaticSiteHandler => ({
  __brand: "effortless-static-site",
  __spec: options,
});
