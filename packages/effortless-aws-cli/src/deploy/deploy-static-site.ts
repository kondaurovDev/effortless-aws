import { Effect } from "effect";
import { Path, FileSystem, Command } from "@effect/platform";
import { Architecture } from "@aws-sdk/client-lambda";
import type { ExtractedStaticSiteFunction } from "~/build/bundle";
import { bundleMiddleware, zip } from "~/build/bundle";
import {
  Aws,
  makeTags,
  resolveStage,
  type TagContext,
  ensureBucket,
  syncFiles,
  putObject,
  putBucketPolicyForOAC,
  ensureOAC,
  ensureEdgeRole,
  ensureLambda,
  publishVersion,
  ensureEdgePermission,
  ensureViewerRequestFunction,
  ensureDistribution,
  invalidateDistribution,
  findCertificate,
  ensureApiCachePolicy,
} from "../aws";
import { generateSitemap, generateRobots, collectHtmlKeys, keysToUrls, submitToGoogleIndexing } from "./seo";

// ============ Static site deployment ============

export type DeployStaticSiteInput = {
  projectDir: string;
  project: string;
  stage?: string;
  region: string;
  fn: ExtractedStaticSiteFunction;
  /** Source file path (required when middleware is present) */
  file?: string;
  /** Resolved API routes: pattern → Lambda Function URL domain */
  apiRoutes?: { pattern: string; originDomain: string }[];
  /** Resolved bucket routes for CloudFront origin proxying */
  bucketRoutes?: { pattern: string; bucketName: string; bucketRegion: string; access: string }[];
  /** CloudFront signing info for private bucket routes */
  cfSigningInfo?: { cfSigningKeySsmPath: string; publicKeyId: string; keyGroupId: string };
  verbose?: boolean;
};

export type DeployStaticSiteResult = {
  exportName: string;
  handlerName: string;
  url: string;
  distributionDomain: string;
  distributionId: string;
  bucketName: string;
  seoGenerated?: string[];
  indexingResult?: { submitted: number; skipped: number; failed: number };
};

/** Deploy middleware as Lambda@Edge in us-east-1 */
const deployMiddlewareLambda = (input: {
  projectDir: string;
  project: string;
  stage: string;
  handlerName: string;
  file: string;
  tagCtx: TagContext;
}) =>
  Effect.gen(function* () {
    const { projectDir, project, stage, handlerName, file, tagCtx } = input;
    const middlewareName = `${handlerName}-middleware`;

    yield* Effect.logDebug(`Deploying middleware Lambda@Edge: ${middlewareName}`);

    // 1. Create IAM role with edgelambda trust
    const roleArn = yield* ensureEdgeRole(
      project,
      stage,
      middlewareName,
      makeTags(tagCtx)
    );

    // 2. Bundle middleware code (standalone — extracts only the middleware fn via AST)
    const bundled = yield* bundleMiddleware({ projectDir, file });

    const bundleSizeKB = Math.round(bundled.length / 1024);
    if (bundleSizeKB > 50) {
      yield* Effect.logWarning(
        `[middleware] Bundle size is ${bundleSizeKB}KB (expected <50KB). ` +
        `Middleware may be pulling in unrelated dependencies via barrel imports. ` +
        `Use direct file imports instead (e.g. import { Auth } from "./core/auth" instead of "./core").`
      );
    }

    const code = yield* zip({ content: bundled });

    // 3. Deploy Lambda to us-east-1 (x86_64, no env vars, no layers)
    yield* ensureLambda({
      project,
      stage,
      name: middlewareName,
      region: "us-east-1",
      roleArn,
      code,
      memory: 128,
      timeout: 5,
      architecture: Architecture.x86_64,
      tags: makeTags(tagCtx),
    }).pipe(
      Effect.provide(Aws.makeClients({ lambda: { region: "us-east-1" } }))
    );

    // 4. Allow CloudFront replicator to read the function
    const edgeFunctionName = `${project}-${stage}-${middlewareName}`;
    yield* ensureEdgePermission(edgeFunctionName).pipe(
      Effect.provide(Aws.makeClients({ lambda: { region: "us-east-1" } }))
    );

    // 5. Publish version (Lambda@Edge requires versioned ARN)
    const { versionArn } = yield* publishVersion(edgeFunctionName).pipe(
      Effect.provide(Aws.makeClients({ lambda: { region: "us-east-1" } }))
    );

    yield* Effect.logDebug(`Middleware deployed: ${versionArn}`);
    return { versionArn };
  });

const ERROR_PAGE_KEY = "_effortless/404.html";

const generateErrorPageHtml = (): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — Page not found</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: #fff;
    color: #111;
  }
  .c { text-align: center; }
  h1 { font-size: 4rem; font-weight: 200; letter-spacing: 0.1em; }
  hr { width: 40px; border: none; border-top: 1px solid #ccc; margin: 1.5rem auto; }
  p { font-size: 1rem; color: #666; }
  a { display: inline-block; margin-top: 1.5rem; color: #666; font-size: 0.875rem; text-decoration: none; }
  a:hover { color: #111; }
</style>
</head>
<body>
<div class="c">
  <h1>404</h1>
  <hr>
  <p>This page does not exist.</p>
  <a href="javascript:history.back()">&larr; Back</a>
</div>
</body>
</html>`;

/** @internal */
export const deployStaticSite = (input: DeployStaticSiteInput) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const { projectDir, project, region, fn } = input;
    const { exportName, config } = fn;
    const stage = resolveStage(input.stage);
    const handlerName = exportName;
    const hasMiddleware = fn.hasHandler;

    const tagCtx: TagContext = { project, stage, handler: handlerName };
    const apiRoutes = input.apiRoutes ?? [];

    if (fn.routePatterns.length > 0 && apiRoutes.length === 0) {
      return yield* Effect.fail(
        new Error(
          `Static site "${exportName}" has routes but no API handler was deployed. ` +
          `Ensure defineApi() handlers are included in the discovery patterns.`
        )
      );
    }

    // 1. Run build command if specified
    if (config.build) {
      yield* Effect.logDebug(`Building site: ${config.build}`);
      const buildStart = Date.now();
      yield* Command.make("/bin/sh", "-c", config.build!).pipe(
        Command.workingDirectory(projectDir),
        input.verbose ? Command.stdout("inherit") : (c => c),
        input.verbose ? Command.stderr("inherit") : (c => c),
        Command.exitCode,
        Effect.flatMap(code =>
          code === 0
            ? Effect.void
            : Effect.fail(new Error(`Site build failed (exit ${code}): ${config.build}`))
        ),
      );
      yield* Effect.logDebug(`Site built in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
    }

    // 2. Ensure S3 bucket
    const bucketName = `${project}-${stage}-${handlerName}-site`.toLowerCase();
    yield* ensureBucket({
      name: bucketName,
      region,
      tags: makeTags(tagCtx),
    });

    // 3. Ensure Origin Access Control
    const oacName = `${project}-${stage}-oac`;
    const { oacId } = yield* ensureOAC({ name: oacName });

    // 3b. If domain is set, look up ACM certificate
    const domain = typeof config.domain === "string"
      ? config.domain
      : config.domain?.[stage];
    let aliases: string[] | undefined;
    let acmCertificateArn: string | undefined;
    let wwwDomain: string | undefined;

    if (domain) {
      const certResult = yield* findCertificate(domain);
      acmCertificateArn = certResult.certificateArn;

      // Only consider www redirect for root domains (e.g. "example.com"), not subdomains (e.g. "a.example.com")
      const isRootDomain = domain.split(".").length === 2;

      if (isRootDomain) {
        const wwwCandidate = `www.${domain}`;
        const certCoversWww = certResult.coveredDomains.includes(wwwCandidate) ||
          certResult.coveredDomains.includes(`*.${domain}`);

        if (certCoversWww) {
          aliases = [domain, wwwCandidate];
          wwwDomain = wwwCandidate;
          yield* Effect.logDebug(`ACM certificate covers ${wwwCandidate}, enabling www → non-www redirect`);
        } else {
          aliases = [domain];
          yield* Effect.logWarning(
            `ACM certificate does not cover ${wwwCandidate}. ` +
            `For SEO, add ${wwwCandidate} to your ACM certificate in us-east-1 to enable www → non-www redirect.`
          );
        }
      } else {
        aliases = [domain];
      }
    }

    // 4. Viewer request: either Lambda@Edge (middleware) or CloudFront Function (URL rewrite)
    const index = config.index ?? "index.html";
    const isSpa = config.errorPage === index;
    let urlRewriteFunctionArn: string | undefined;
    let lambdaEdgeArn: string | undefined;

    if (hasMiddleware && input.file) {
      // User-defined Lambda@Edge middleware
      const result = yield* deployMiddlewareLambda({
        projectDir, project, stage, handlerName,
        file: input.file, tagCtx,
      }).pipe(
        Effect.provide(Aws.makeClients({ iam: { region: "us-east-1" } }))
      );
      lambdaEdgeArn = result.versionArn;
    } else {
      // CloudFront Function for SPA fallback / URL rewrite + optional www redirect
      const needsSpaFallback = isSpa;
      const needsUrlRewrite = !isSpa;
      const needsWwwRedirect = !!wwwDomain;

      if (needsSpaFallback || needsUrlRewrite || needsWwwRedirect) {
        const fnName = (needsSpaFallback || needsWwwRedirect)
          ? `${project}-${stage}-${handlerName}-viewer-req`
          : `${project}-${stage}-url-rewrite`;
        const result = yield* ensureViewerRequestFunction(fnName, {
          spaFallback: needsSpaFallback,
          rewriteUrls: needsUrlRewrite,
          redirectWwwDomain: wwwDomain,
        });
        urlRewriteFunctionArn = result.functionArn;
      }
    }

    // 5. Determine error page path (non-SPA only)
    const errorPagePath = isSpa
      ? undefined
      : config.errorPage
        ? `/${config.errorPage}`
        : `/${ERROR_PAGE_KEY}`;

    // 6. Ensure API cache policy if needed
    const apiCachePolicyId = apiRoutes.length > 0 ? yield* ensureApiCachePolicy() : undefined;

    // 7. Build bucket origins for CloudFront
    const bucketOrigins = (input.bucketRoutes ?? []).map(br => {
      // Strip trailing /* to get the prefix (e.g. "/files/*" → "/files")
      const stripPrefix = br.pattern.replace(/\/?\*$/, "");
      return {
        originId: `S3-${br.bucketName}`,
        bucketName: br.bucketName,
        bucketRegion: br.bucketRegion,
        oacId,
        pathPattern: br.pattern,
        stripPrefix,
        ...(br.access === "private" && input.cfSigningInfo
          ? { keyGroupId: input.cfSigningInfo.keyGroupId }
          : {}),
      };
    });

    // 8. Ensure CloudFront distribution
    const { distributionId, distributionArn, domainName } = yield* ensureDistribution({
      project,
      stage,
      handlerName,
      bucketName,
      bucketRegion: region,
      oacId,
      index,
      tags: makeTags(tagCtx),
      urlRewriteFunctionArn,
      lambdaEdgeArn,
      aliases,
      acmCertificateArn,
      errorPagePath,
      ...(apiRoutes.length > 0
        ? { apiRoutes, apiCachePolicyId }
        : {}),
      ...(bucketOrigins.length > 0
        ? { bucketOrigins }
        : {}),
    });

    // 9. Set bucket policy for CloudFront OAC (site bucket + route buckets)
    yield* putBucketPolicyForOAC(bucketName, distributionArn);
    for (const bo of bucketOrigins) {
      yield* putBucketPolicyForOAC(bo.bucketName, distributionArn);
    }

    // 8. Sync files to S3
    const sourceDir = p.resolve(projectDir, config.dir);
    yield* syncFiles({ bucketName, sourceDir });

    // 8b. Generate and upload SEO files (sitemap.xml, robots.txt)
    const seo = config.seo;
    const siteUrl = domain ? `https://${domain}` : `https://${domainName}`;

    const seoGenerated: string[] = [];
    if (seo) {
      const sitemapName = seo.sitemap;

      if (!(yield* fileSystem.exists(p.join(sourceDir, sitemapName)))) {
        const sitemap = yield* generateSitemap(siteUrl, sourceDir);
        yield* putObject({
          bucketName,
          key: sitemapName,
          body: sitemap,
          contentType: "application/xml; charset=utf-8",
        });
        seoGenerated.push(sitemapName);
      }

      const robots = generateRobots(siteUrl, sitemapName);
      yield* putObject({
        bucketName,
        key: "robots.txt",
        body: robots,
        contentType: "text/plain; charset=utf-8",
      });
      seoGenerated.push("robots.txt");
    }

    // 9. Upload generated error page (non-SPA, no custom errorPage)
    if (!isSpa && !config.errorPage) {
      yield* putObject({
        bucketName,
        key: ERROR_PAGE_KEY,
        body: generateErrorPageHtml(),
        contentType: "text/html; charset=utf-8",
      });
    }

    // 10. Invalidate CloudFront cache
    yield* invalidateDistribution(distributionId);

    // 11. Submit pages to Google Indexing API (skips already indexed)
    let indexingResult: { submitted: number; skipped: number; failed: number } | undefined;
    if (seo?.googleIndexing) {
      const allHtmlKeys = yield* collectHtmlKeys(sourceDir);
      const allPageUrls = keysToUrls(siteUrl, allHtmlKeys);
      indexingResult = yield* submitToGoogleIndexing({
        serviceAccountPath: seo.googleIndexing,
        projectDir,
        bucketName,
        allPageUrls,
      });
    }

    yield* Effect.logDebug(`Static site deployed: ${siteUrl}`);

    return {
      exportName,
      handlerName,
      url: siteUrl,
      distributionDomain: domainName,
      distributionId,
      bucketName,
      seoGenerated: seoGenerated.length > 0 ? seoGenerated : undefined,
      indexingResult,
    } satisfies DeployStaticSiteResult;
  });
