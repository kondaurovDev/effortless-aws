/** Any branded handler that deploys to API Gateway or S3 */
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
 * Configuration for a static site (S3 + CloudFront)
 */
export type StaticSiteConfig = {
  /** Directory containing the static site files, relative to project root */
  dir: string;
  /** Default file for directory requests (default: "index.html") */
  index?: string;
  /** Shell command to run before deploy to generate site content (e.g., "npx astro build") */
  build?: string;
  /** Path to a custom error page relative to `dir`.
   * - If set to the same value as `index` (e.g. "index.html"), enables SPA mode:
   *   all paths that don't match a file are served with `index.html` (HTTP 200), letting the client-side router handle them.
   * - If set to a different file (e.g. "404.html"), that file is served with HTTP 404 for missing paths.
   * - If omitted, a default 404 page is auto-generated. */
  errorPage?: string;
  /** Custom domain name. Accepts a string (same domain for all stages) or a Record mapping stage names to domains (e.g., `{ prod: "example.com", dev: "dev.example.com" }`). Requires an ACM certificate in us-east-1. If the cert also covers www, a 301 redirect from www to non-www is set up automatically. */
  domain?: string | Record<string, string>;
  /** SEO: auto-generate sitemap.xml and robots.txt at deploy time, optionally submit URLs to Google Indexing API */
  seo?: StaticSiteSeo;
};

/** Route entry stored on the static site handler */
type StaticSiteRouteEntry = {
  pattern: string;
  origin: AnyRoutableHandler;
  access?: "private" | "public";
};

/**
 * Internal handler object created by defineStaticSite
 * @internal
 */
export type StaticSiteHandler = {
  readonly __brand: "effortless-static-site";
  readonly __spec: StaticSiteConfig;
  readonly routes: StaticSiteRouteEntry[];
  readonly middleware?: MiddlewareHandler;
};

/** Builder for configuring a static site before calling `.build()` */
export type StaticSiteBuilder = {
  route(pattern: string, origin: AnyRoutableHandler, opts?: { access?: "private" | "public" }): StaticSiteBuilder;
  middleware(fn: MiddlewareHandler): StaticSiteBuilder;
  build(): StaticSiteHandler;
};

/**
 * Deploy a static site via S3 + CloudFront CDN, with optional API and bucket route overrides.
 *
 * @see {@link https://effortless-aws.website/use-cases/web-app | Web app guide}
 *
 * @param options - Static site configuration: directory, optional SPA mode, build command, domain
 * @returns Builder with `.route()`, `.middleware()`, and `.build()` methods
 */
export function defineStaticSite(options: StaticSiteConfig): StaticSiteBuilder {
  const state = {
    spec: { ...options },
    routes: [] as StaticSiteRouteEntry[],
    middleware: undefined as MiddlewareHandler | undefined,
  };

  const builder = {
    route(pattern: string, origin: AnyRoutableHandler, opts?: { access?: "private" | "public" }) {
      state.routes.push({ pattern, origin, ...(opts?.access ? { access: opts.access } : {}) });
      return builder;
    },
    middleware(fn: MiddlewareHandler) {
      state.middleware = fn;
      return builder;
    },
    build(): StaticSiteHandler {
      return {
        __brand: "effortless-static-site",
        __spec: state.spec,
        routes: state.routes,
        ...(state.middleware ? { middleware: state.middleware } : {}),
      };
    },
  };

  return builder;
}
