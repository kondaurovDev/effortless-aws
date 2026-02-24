---
"effortless-aws": minor
---

Enhanced defineStaticSite with security headers, automatic 404 error pages, and API route proxying.

- Automatically apply AWS managed SecurityHeadersPolicy (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) to all CloudFront distributions
- Generate a minimal styled 404 page for non-SPA static sites (replaces ugly S3 XML error); customizable via `errorPage` option
- Add `routes` option for proxying API paths through CloudFront to API Gateway (same domain, no CORS)
