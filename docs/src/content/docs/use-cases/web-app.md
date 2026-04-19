---
title: Website
description: Deploy SSR frameworks with defineApp and static sites with defineStaticSite — via CloudFront CDN.
---

You've built a frontend and you need to host it. But not all frontends are the same — and the hosting approach depends on what your app actually does at request time.

## Static sites vs SSR — what's the difference?

A **static site** is a set of pre-built HTML, CSS, and JS files. When you run `npm run build`, the framework generates all pages upfront. The server's job is simple: find the file, send it back. A blog, a documentation site, a landing page — these are static. Every visitor gets the same files.

A **single-page application (SPA)** is a variation of a static site. There's one `index.html` and a JS bundle that handles routing in the browser. The server still just serves files — but any URL that doesn't match a real file returns `index.html`, and the JS router takes over. React, Vue, and Angular apps typically work this way.

**Server-side rendering (SSR)** is fundamentally different. When a request comes in, server code runs to generate the HTML on the fly. The page might fetch data from a database, check the user's session, or render personalized content. The result is a complete HTML page — search engines can crawl it, the first paint is fast, and the page works even before JS loads.

Modern frameworks blur the line. Nuxt, Astro, SvelteKit, and Next.js can do both: render some pages on the server, pre-build others as static HTML, and serve JS bundles as static assets. That's why they produce two outputs — a **server handler** (the code that runs per-request) and **static assets** (the pre-built files that never change).

### Why SSR matters

- **SEO** — search engines get fully rendered HTML without executing JavaScript
- **Performance** — users see content immediately, no blank page while JS loads
- **Personalization** — each request can render user-specific content (logged-in state, locale, A/B tests)
- **Data freshness** — pages show real-time data, not stale builds from hours ago
- **Progressive enhancement** — the page works before client JS hydrates

The tradeoff is infrastructure: you need a server. On AWS, that means Lambda. Effortless handles the wiring — you point it at the framework output and deploy.

---

Effortless gives you two options depending on your needs: **defineApp** (SSR frameworks via CloudFront + Lambda Function URL + S3) and **defineStaticSite** (static sites and SPAs via CloudFront + S3).

## defineApp — deploy SSR frameworks

Your app uses server-side rendering — Nuxt, Next.js, or any framework that produces a server handler and static assets.

`defineApp` creates a CloudFront distribution with two origins: a Lambda Function URL for server-side rendering, and an S3 bucket for static assets. The framework's built server handler runs in Lambda, while static assets (JS bundles, CSS, images) are served directly from S3 with CDN caching.

```typescript
// src/app.ts
import { defineApp } from "effortless-aws";

export const app = defineApp({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
});
```

On deploy, Effortless:
1. Runs `nuxt build` to produce the server and assets directories
2. ZIPs the server directory and deploys it as a Lambda function
3. Creates a Lambda Function URL (secured with AWS_IAM + CloudFront OAC)
4. Creates an S3 bucket and uploads static assets
5. Creates a CloudFront distribution with auto-detected cache behaviors

Static assets are detected automatically from the assets directory. Directories become `/{name}/*` patterns, files become `/{name}` — all routed to S3 with `CachingOptimized`. Everything else goes to the Lambda Function URL with `CachingDisabled`.

### Supported frameworks

Any framework that builds into a server handler + static assets works with `defineApp`. The `server` directory must contain an `index.mjs` (or `index.js`) exporting a Lambda-compatible `handler` function.

#### Nuxt

The best-supported framework. Nuxt uses [Nitro](https://nitro.build/) which has a built-in `aws-lambda` preset that produces a Lambda handler directly.

```typescript
export const app = defineApp({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
});
```

Set `NITRO_PRESET=aws-lambda` as an environment variable, or configure it in `nuxt.config.ts`:

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  nitro: {
    preset: "aws-lambda",
  },
});
```

#### Next.js (via OpenNext)

Next.js doesn't produce a Lambda handler natively. [OpenNext](https://opennext.js.org/) is an open-source adapter that transforms Next.js output into Lambda-compatible packages.

```typescript
export const app = defineApp({
  server: ".open-next/server-function",
  assets: ".open-next/assets",
  build: "npx open-next build",
});
```

OpenNext runs `next build` internally and produces `.open-next/server-function/index.mjs` (Lambda handler) and `.open-next/assets` (static files for S3).

#### Other Nitro-powered frameworks

Any framework built on [Nitro](https://nitro.build/) supports the `aws-lambda` preset and works the same way as Nuxt — set the preset and point `defineApp` at the output directories. This includes [Analog](https://analogjs.org/) (Angular) and [Vinxi](https://vinxi.vercel.app/)-based frameworks.

#### Bringing your own handler

If your framework doesn't have a Lambda adapter, you can write a thin wrapper yourself. The `server` directory needs an `index.mjs` that exports a `handler(event, context)` function matching the [Lambda function handler](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html) signature. Wrap your framework's HTTP server with a library like [`serverless-http`](https://github.com/dougmoscrop/serverless-http) or [`@vendia/serverless-express`](https://github.com/vendia/serverless-express).

### Custom domain

```typescript
export const app = defineApp({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
  domain: "app.example.com",
});
```

Effortless automatically finds your ACM certificate in us-east-1 and configures SSL.

Stage-specific domains are also supported:

```typescript
export const app = defineApp({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
  domain: {
    prod: "app.example.com",
    staging: "staging.example.com",
  },
});
```

### SSR + API in one project

Your Nuxt/Astro app and API handlers deploy together.

```typescript
// src/app.ts
import { defineApp } from "effortless-aws";

export const frontend = defineApp({
  server: ".output/server",
  assets: ".output/public",
  build: "nuxt build",
  memory: 1024,
});
```

```typescript
// src/api.ts
import { defineApi, defineTable } from "effortless-aws";

type Item = { id: string; name: string };

export const items = defineTable<Item>();

export const api = defineApi({
  basePath: "/api/items",
  deps: () => ({ items }),
})
  .setup(({ deps }) => ({ items: deps.items }))
  .get("/", async ({ items }) => ({
    status: 200,
    body: await items.query({}),
  }));
```

The SSR app is served from CloudFront, and the API from a Lambda Function URL — each with its own URL. Use the SSR framework's built-in API routes or proxy to the Function URL from the frontend.

---

## defineStaticSite — global CDN

Your site is public-facing — a marketing page, blog, documentation — and you want fast load times worldwide.

[CloudFront](/why-serverless/#cloudfront--s3) is AWS's global CDN. Once cached, your files are served directly from the nearest edge location — no Lambda, no origin server.

The usual pain is the setup: create a private S3 bucket, configure Origin Access Control, set up URL rewriting for clean paths, handle SPA routing with custom error responses, and invalidate the cache on every deploy. `defineStaticSite` does all of this from one export.

```typescript
// src/site.ts
import { defineStaticSite } from "effortless-aws";

export const blog = defineStaticSite({
  dir: "dist",
  build: "npm run build",
});
```

On deploy, Effortless:
1. Runs `npm run build`
2. Creates a private S3 bucket
3. Uploads all files from `dist/`
4. Creates a CloudFront distribution with Origin Access Control
5. Sets up URL rewriting: `/about/` becomes `/about/index.html`
6. Invalidates the CloudFront cache so changes are live immediately

You get a CloudFront URL like `https://d1234567890.cloudfront.net`. Your site is served from edge locations worldwide.

### Custom domain

Want to serve from `example.com` instead of a CloudFront URL? Add `domain`:

```typescript
export const site = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  domain: "example.com",
});
```

Effortless automatically finds your ACM certificate in us-east-1 and configures SSL. If the certificate also covers `www.example.com`, a 301 redirect from `www` to the non-www domain is set up automatically — no extra config needed.

**What you need to do beforehand:**

1. Create an ACM certificate in **us-east-1** for your domain (include `www` for redirect support)
2. Validate the certificate via DNS
3. After first deploy, point your DNS (CNAME or alias) to the CloudFront distribution

**What Effortless does for you:**

- Finds the ACM certificate by domain match (exact or wildcard)
- Configures CloudFront aliases and SSL (SNI, TLSv1.2)
- Detects www coverage on the certificate and sets up a CloudFront Function for 301 redirect
- Cleans up orphaned CloudFront Functions when config changes

### SPA mode

For client-side routed apps (React, Vue, Angular), enable `spa: true` — all routes return `index.html`:

```typescript
export const app = defineStaticSite({
  dir: "build",
  build: "npm run build",
  spa: true,
});
```

Behind the scenes, CloudFront returns `index.html` for any path that doesn't match a real file (via custom error response for 403/404).

### Error pages

For non-SPA sites, Effortless automatically generates a clean 404 error page. When a visitor hits a path that doesn't exist, they see a styled page instead of a raw S3 XML error.

If you want to use your own error page, point to a file inside your `dir`:

```typescript
export const docs = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  errorPage: "404.html",  // relative to dist/
});
```

For SPA sites (`spa: true`), error pages are not used — all paths are routed to `index.html` for client-side routing.

### API route proxying

Your frontend and API can share the same domain — CloudFront proxies specific paths to API Gateway, eliminating CORS entirely.

```typescript
import { api } from "./api";

export const app = defineStaticSite({
  dir: "dist",
  spa: true,
  build: "npm run build",
  domain: "example.com",
  routes: {
    "/api/*": api,  // proxied to API Gateway
  },
});
```

With `routes`, requests to `/api/*` go directly to your API Gateway. Everything else is served from S3. Same domain, no CORS headers needed.

The `api` value is a reference to a `defineApi` handler — Effortless resolves the Function URL domain automatically at deploy time.

### Middleware — protect pages with auth

Some sections of your site shouldn't be public. An admin panel, internal docs, a paid content area — you need to check authentication before serving the page.

`middleware` lets you run custom Node.js code at the edge before CloudFront serves any file. If the check fails — redirect to login or block access. If it passes — the page is served normally.

```typescript
export const admin = defineStaticSite({
  dir: "admin/dist",
  domain: "admin.example.com",
  build: "npm run build",
  middleware: async (request) => {
    // Check for session cookie
    if (!request.cookies.session) {
      return { redirect: "https://example.com/login" };
    }

    // Optionally verify the token
    const isValid = verifyJWT(request.cookies.session);
    if (!isValid) {
      return { status: 403, body: "Access denied" };
    }

    // No return → serve the page
  },
});
```

The middleware receives a simplified request with `uri`, `method`, `querystring`, `headers`, and `cookies`. Return nothing to serve the page, `{ redirect: url }` to redirect, or `{ status: 403 }` to block.

This runs as Lambda@Edge — full Node.js runtime, so you can validate JWTs, call external APIs, check databases. It's deployed to us-east-1 and replicated to all CloudFront edge locations worldwide.

When middleware is set, it replaces the default CloudFront Function. URL rewriting (`/path/` → `/path/index.html`) is handled automatically inside the middleware wrapper.

**A common pattern** — separate public and protected sites into different domains:

```typescript
// Public landing — fast, no middleware overhead
export const landing = defineStaticSite({
  dir: "landing/dist",
  domain: "example.com",
});

// Protected admin — with JWT validation
export const admin = defineStaticSite({
  dir: "admin/dist",
  domain: "admin.example.com",
  middleware: async (request) => {
    if (!request.cookies.session) {
      return { redirect: "https://example.com/login" };
    }
  },
});
```

Each `defineStaticSite` creates its own CloudFront distribution, so there's no performance penalty for the public site.

### SEO — sitemap, robots.txt, Google Indexing

Search engines need to discover your pages. A sitemap tells crawlers what pages exist, `robots.txt` tells them where the sitemap is, and the Google Indexing API notifies Google immediately when new pages are published.

Effortless generates both files at deploy time and optionally submits pages to the Indexing API — no framework plugins needed.

```typescript
export const docs = defineStaticSite({
  dir: "dist",
  build: "npm run build",
  domain: "docs.example.com",
  seo: {
    sitemap: "sitemap.xml",
    googleIndexing: "~/google-service-account.json",
  },
});
```

The `sitemap` field is the filename for the generated sitemap. Effortless walks your `dir`, finds all HTML files, and generates a sitemap XML with clean URLs (`/about/` instead of `/about/index.html`). If you already have a `sitemap.xml` in your build output (from Astro, Next.js, etc.), the auto-generated one is skipped.

`robots.txt` is always generated pointing to your sitemap — it's overwritten on every deploy.

`googleIndexing` points to a Google Cloud service account JSON key. On each deploy, new page URLs are submitted via the [Indexing API](https://developers.google.com/search/apis/indexing-api/v3/quickstart). Already-submitted URLs are tracked in S3 and skipped — so only new pages are sent to Google.

To set up Google Indexing:
1. Create a service account in [Google Cloud Console](https://console.cloud.google.com/iam-admin/serviceaccounts) and download the JSON key
2. In [Search Console](https://search.google.com/search-console), add the service account email as an **Owner**
3. Point `googleIndexing` to the key file path (relative to project root, or `~/` for home directory)

---

## Which one to choose?

| | defineApp | defineStaticSite |
|---|---|---|
| Serves via | CloudFront + Lambda Function URL + S3 | CloudFront + S3 |
| Server-side rendering | Yes | No |
| Global CDN | Yes | Yes |
| Custom domain | Yes (`domain` option) | Yes (`domain` option) |
| www redirect | No | Automatic (when cert covers www) |
| Edge auth/middleware | No | Yes (`middleware` option — Lambda@Edge) |
| SEO automation | No | Yes (`seo` option — sitemap, robots.txt, Google Indexing) |
| Security headers | Automatic | Automatic |
| Extra AWS resources | Lambda + S3 bucket + CloudFront distribution | S3 bucket + CloudFront distribution |
| Best for | SSR frameworks (Nuxt, Next.js) | Static sites, SPAs, docs |

**Rule of thumb**: if your framework produces a server handler (Nuxt, Next.js via OpenNext) — use `defineApp`. If your site is fully static or a client-side SPA — use `defineStaticSite`.

## See also

- [Definitions reference — defineApp](/definitions/#defineapp) — all configuration options
- [Definitions reference — defineStaticSite](/definitions/#definestaticsite) — all configuration options including middleware
