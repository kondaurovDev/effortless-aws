---
"effortless-aws": patch
"@effortless-aws/cli": patch
---

- Add bucket routes in static sites with public/private access (CloudFront signed cookies)
- Add SPA fallback mode for static sites (extensionless paths rewrite to /index.html)
- Deploy API routes to per-handler Lambda origins instead of shared API Gateway
- Add cache options for GET routes (auto Cache-Control headers)
- Support multiple set-cookie headers via Lambda Function URL cookies array
- Use custom CloudFront cache policy (UseOriginCacheHeaders) for API behaviors
