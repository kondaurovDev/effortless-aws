import type { HttpHandler } from "./define-http";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHttpHandler = HttpHandler<any, any, any, any, any>;

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
  routes?: Record<string, AnyHttpHandler>;
  /** Custom 404 error page path relative to `dir` (e.g. "404.html").
   * For non-SPA sites only. If not set, a default page is generated automatically. */
  errorPage?: string;
  /** Lambda@Edge middleware that runs before serving pages. Use for auth checks, redirects, etc. */
  middleware?: MiddlewareHandler;
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
 * @example Protected site with middleware (Lambda@Edge)
 * ```typescript
 * export const admin = defineStaticSite({
 *   dir: "admin/dist",
 *   middleware: async (request) => {
 *     if (!request.cookies.session) {
 *       return { redirect: "/login" };
 *     }
 *   },
 * });
 * ```
 */
export const defineStaticSite = (options: StaticSiteConfig): StaticSiteHandler => ({
  __brand: "effortless-static-site",
  __spec: options,
});
