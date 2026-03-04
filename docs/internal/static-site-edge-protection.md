# Static Site Edge Protection — Design Notes

## Problem

`defineStaticSite` deploys S3 + CloudFront but has no way to protect pages behind auth.
Use case: hide docs/admin sections, redirect unauthenticated users to login.

## CloudFront Architecture Constraints

- One CloudFront distribution can have **one function per event per cache behavior**
- `viewer-request` event: either CloudFront Function **or** Lambda@Edge (not both)
- `origin-request` event: Lambda@Edge only, but fires only on cache miss — **not suitable for auth** (cached pages bypass the check)
- Current implementation already uses a CF Function on `viewer-request` for URL rewrite (`/path/` → `/path/index.html`)

## Two Approaches

### 1. CloudFront Function (declarative `protect`)

User configures protection via params, effortless generates CF Function code:

```ts
export const docs = defineStaticSite({
  dir: "docs/dist",
  protect: {
    cookie: "session",
    redirectTo: "https://example.com/login",
    exclude: ["/login", "/public/"],
  }
})
```

Generated CF Function handles: protect check → URL rewrite → www redirect (all in one function).

**Pros:**
- Sub-millisecond latency, runs on all 400+ edge locations
- $0.10/million requests
- No cold starts
- Simple declarative API

**Cons:**
- Can only check cookie **presence** (not validate JWT signatures)
- No network access, no crypto, no external calls
- 10KB code limit, 1ms execution limit
- ES 5.1-like runtime (no modules, no async)

**Best for:** Public sites with simple cookie gate (backend validates token on API calls).

### 2. Lambda@Edge (custom `edge` function)

User writes full Node.js code, effortless bundles and deploys as Lambda@Edge:

```ts
export const admin = defineStaticSite({
  dir: "admin/dist",
  edge: (request) => {
    // Full Node.js — JWT validation, DynamoDB, SSM, etc.
    const token = request.cookies?.token;
    if (!verifyJWT(token)) {
      return redirect("/login");
    }
    return request;
  }
})
```

**Pros:**
- Full Node.js runtime: JWT validation, network calls, SDK access
- 128MB-10GB memory, 5s timeout (viewer-request)
- Can run arbitrary auth logic

**Cons:**
- Cold start: 100-500ms
- $0.60/million requests + compute time
- Deploys only to us-east-1 (CloudFront replicates)
- **No environment variables** (must hardcode or fetch from SSM at runtime)
- No VPC, no layers, no ARM — x86 Node.js only

**Best for:** Admin panels, internal tools, anything needing token validation.

### Mutually exclusive

`protect` and `edge` cannot coexist on the same handler — one distribution has one viewer-request function. If user provides `edge`, Lambda@Edge handles everything (auth + URL rewrite). If user provides `protect`, CF Function handles everything.

## Recommended Architecture: Separate Domains

Instead of mixing public and protected content on one distribution:

```ts
// Public landing — CF Function for URL rewrite only
export const landing = defineStaticSite({
  dir: "landing/dist",
  domain: "example.com",
})

// Protected admin — with auth
export const admin = defineStaticSite({
  dir: "admin/dist",
  domain: "admin.example.com",
  protect: { cookie: "session", redirectTo: "https://example.com/login" }
})
```

Each `defineStaticSite` already creates its own distribution. Separate domains = clean separation of concerns.

## Implementation Notes

### `protect` (CloudFront Function)

- **Type definition**: Add `ProtectConfig` to `StaticSiteConfig` in `src/handlers/define-static-site.ts`
- **Build extraction**: No changes needed — `protect` is a plain object, extracted automatically by `new Function()` eval
- **Code generation**: Extend `generateViewerRequestCode()` in `src/aws/cloudfront.ts` to insert cookie check + redirect before URL rewrite
- **Deploy**: In `src/deploy/deploy-static-site.ts`, pass `protect` config to the CF Function generator, use per-handler function name (`${project}-${stage}-${handlerName}-viewer-req`)
- **Exclude matching**: Prefix-based (`startsWith`) — simple, predictable, fits CF Function constraints

### `edge` (Lambda@Edge) — future

- Bundle user function with esbuild (same as `defineApi`)
- Deploy Lambda to `us-east-1` (use `Effect.provide()` with Lambda client `.Default({ region: "us-east-1" })`)
- Associate as `viewer-request` Lambda@Edge on distribution
- Include URL rewrite logic inside the Lambda wrapper
- No env vars — consider SSM fetch at cold start or bake config into bundle

## Decision

Start with `protect` (declarative CF Function) — covers 90% of use cases, simpler to implement.
Add `edge` (Lambda@Edge) as a follow-up when full auth validation is needed.
