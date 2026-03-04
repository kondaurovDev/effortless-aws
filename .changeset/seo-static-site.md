---
"effortless-aws": minor
"@effortless-aws/cli": minor
---

feat: auto-generate sitemap.xml, robots.txt and submit to Google Indexing API for static sites

Added `seo` option to `defineStaticSite` that generates sitemap.xml and robots.txt at deploy time. Optionally submits new page URLs to the Google Indexing API for faster crawling. Already-indexed URLs are tracked in S3 and skipped on subsequent deploys.
