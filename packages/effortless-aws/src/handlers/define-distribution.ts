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

/** Inline static origin config for a CloudFront route */
export type StaticOriginConfig = {
  /** Directory containing the static site files, relative to project root */
  dir: string;
  /** Default file for directory requests (default: "index.html") */
  index?: string;
  /** SPA mode: serve index.html for all paths that don't match a file (default: false) */
  spa?: boolean;
  /** Shell command to run before deploy to generate site content (e.g., "npx astro build") */
  build?: string;
  /** Custom 404 error page path relative to `dir` (e.g. "404.html").
   * For non-SPA sites only. If not set, a default page is generated automatically. */
  errorPage?: string;
  /** SEO: auto-generate sitemap.xml and robots.txt at deploy time, optionally submit URLs to Google Indexing API */
  seo?: StaticSiteSeo;
};

/** Route origin: a handler (API, MCP, bucket) or inline static site config */
type RouteOrigin = AnyRoutableHandler | StaticOriginConfig;

/** Route entry stored on the distribution handler */
type DistributionRouteEntry = {
  pattern: string;
  origin: RouteOrigin;
  access?: "private" | "public";
};

/**
 * Distribution-level config (CloudFront settings, not per-origin)
 */
export type DistributionConfig = {
  /** Custom domain name. Accepts a string (same domain for all stages) or a Record mapping stage names to domains (e.g., `{ prod: "example.com", dev: "dev.example.com" }`). Requires an ACM certificate in us-east-1. If the cert also covers www, a 301 redirect from www to non-www is set up automatically. */
  domain?: string | Record<string, string>;
};

/**
 * Internal handler object created by defineDistribution
 * @internal
 */
export type DistributionHandler = {
  readonly __brand: "effortless-static-site";
  readonly __spec: DistributionConfig;
  readonly routes: DistributionRouteEntry[];
  readonly middleware?: MiddlewareHandler;
};


/**
 * Deploy a CloudFront distribution with static site, API, and bucket origins.
 *
 * @see {@link https://effortless-aws.website/use-cases/web-app | Web app guide}
 *
 * @param options - Distribution configuration: name, domain
 * @returns Builder with `.route()`, `.middleware()`, and `.build()` methods
 */
export function defineDistribution(options?: DistributionConfig) {
  const state = {
    spec: { ...options },
    routes: [] as DistributionRouteEntry[],
    middleware: undefined as MiddlewareHandler | undefined,
  };

  const builder = {
    route(pattern: string, origin: RouteOrigin, opts?: { access?: "private" | "public" }) {
      state.routes.push({ pattern, origin, ...(opts?.access ? { access: opts.access } : {}) });
      return builder;
    },
    middleware(fn: MiddlewareHandler) {
      state.middleware = fn;
      return builder;
    },
    build(): DistributionHandler {
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

