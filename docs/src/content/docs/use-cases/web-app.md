---
title: Website
description: Serve static sites and SPAs with defineApp and defineStaticSite — via Lambda or CloudFront CDN.
---

You've built a frontend — React, Vue, Astro, a documentation site — and you need to host it. On AWS that usually means: create an S3 bucket, configure permissions, set up CloudFront, write rewrite rules for SPAs, handle cache invalidation. Or if you just want it alongside your API — figure out how to serve static files from Lambda.

Effortless gives you two options depending on your needs: **defineApp** (Lambda + API Gateway) and **defineStaticSite** (CloudFront + S3).

## defineApp — serve alongside your API

Your frontend lives in the same project as your API. You want everything on the same domain, deployed with one command.

`defineApp` bundles your built site into a Lambda that serves static files through API Gateway. Since the site shares the same API Gateway as your HTTP handlers, there's no extra infrastructure — no S3 bucket, no CloudFront distribution, no additional cost.

```typescript
// src/site.ts
import { defineApp } from "effortless-aws";

export const docs = defineApp({
  dir: "dist",
  path: "/",
  build: "npx astro build",
});
```

On deploy, Effortless:
1. Runs `npx astro build` to produce the `dist/` folder
2. Bundles all files into the Lambda ZIP
3. Creates a Lambda that serves them with correct content types
4. Sets up API Gateway routes for `GET /` and `GET /{proxy+}`

HTML files get `Cache-Control: public, max-age=0, must-revalidate`. Assets (JS, CSS, images) get `Cache-Control: public, max-age=31536000, immutable`. No manual cache configuration.

### SPA mode

Your React or Vue app uses client-side routing. Every URL should return `index.html` and let the JS router handle the path.

```typescript
export const app = defineApp({
  dir: "build",
  path: "/app",
  build: "npm run build",
  spa: true,
});
```

With `spa: true`, any request that doesn't match a real file returns `index.html`. So `/app/dashboard`, `/app/settings/profile`, `/app/anything` all serve your SPA — and the client-side router takes over.

### Frontend + API in one project

This is where defineApp shines — your frontend and backend deploy together. No CORS issues, no separate infrastructure.

```typescript
// src/site.ts
import { defineApp } from "effortless-aws";

export const frontend = defineApp({
  dir: "client/dist",
  path: "/",
  build: "cd client && npm run build",
  spa: true,
});
```

```typescript
// src/api.ts
import { defineHttp, defineTable, typed } from "effortless-aws";

type Item = { id: string; name: string };

export const items = defineTable({
  pk: { name: "id", type: "string" },
  schema: typed<Item>(),
});

export const listItems = defineHttp({
  method: "GET",
  path: "/api/items",
  deps: { items },
  onRequest: async ({ deps }) => {
    const result = await deps.items.query({});
    return { status: 200, body: result };
  },
});
```

Your React app fetches `/api/items` — same domain, same API Gateway. The frontend serves from `/`, the API from `/api/*`. Everything deploys with one command.

---

## defineStaticSite — global CDN

Your site is public-facing — a marketing page, blog, documentation — and you want fast load times worldwide.

[CloudFront](/why-aws/#cloudfront--s3) is AWS's global CDN. Once cached, your files are served directly from the nearest edge location — no Lambda, no origin server.

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

Same as defineApp — enable `spa: true` and all routes return `index.html`:

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

The `api` value is a reference to a `defineHttp` handler — Effortless resolves the API Gateway domain automatically at deploy time.

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

---

## Which one to choose?

| | defineApp | defineStaticSite |
|---|---|---|
| Serves via | Lambda + API Gateway | CloudFront + S3 |
| Global CDN | No | Yes |
| Custom domain | No (uses API Gateway URL) | Yes (`domain` option) |
| www redirect | No | Automatic (when cert covers www) |
| Edge auth/middleware | No | Yes (`middleware` option — Lambda@Edge) |
| API route proxying | Built-in (same API Gateway) | Yes (`routes` option — same domain, no CORS) |
| Security headers | No | Automatic (HSTS, X-Frame-Options, etc.) |
| Custom error pages | No | Automatic 404 page (or `errorPage` override) |
| Extra AWS resources | None | S3 bucket + CloudFront distribution |
| Best for | Internal tools, fullstack apps | Public sites, docs, protected admin panels |

**Rule of thumb**: if your site lives alongside API handlers — use `defineApp`. If it's a standalone public site that needs CDN performance — use `defineStaticSite`.

## See also

- [Definitions reference — defineApp](/definitions/#defineapp) — all configuration options
- [Definitions reference — defineStaticSite](/definitions/#definestaticsite) — all configuration options including middleware
