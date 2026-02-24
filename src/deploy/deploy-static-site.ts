import { Effect } from "effect";
import { Architecture } from "@aws-sdk/client-lambda";
import { execSync } from "child_process";
import * as path from "path";
import type { ExtractedStaticSiteFunction } from "~/build/bundle";
import { bundle, zip } from "~/build/bundle";
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
  ensureViewerRequestFunction,
  ensureDistribution,
  invalidateDistribution,
  findCertificate,
} from "../aws";

// ============ Static site deployment ============

export type DeployStaticSiteInput = {
  projectDir: string;
  project: string;
  stage?: string;
  region: string;
  fn: ExtractedStaticSiteFunction;
  /** Source file path (required when middleware is present) */
  file?: string;
  /** API Gateway domain for route proxying (e.g. "abc123.execute-api.eu-west-1.amazonaws.com") */
  apiOriginDomain?: string;
};

export type DeployStaticSiteResult = {
  exportName: string;
  handlerName: string;
  url: string;
  distributionId: string;
  bucketName: string;
};

/** Deploy middleware as Lambda@Edge in us-east-1 */
const deployMiddlewareLambda = (input: {
  projectDir: string;
  project: string;
  stage: string;
  handlerName: string;
  file: string;
  exportName: string;
  tagCtx: TagContext;
}) =>
  Effect.gen(function* () {
    const { projectDir, project, stage, handlerName, file, exportName, tagCtx } = input;
    const middlewareName = `${handlerName}-middleware`;

    yield* Effect.logDebug(`Deploying middleware Lambda@Edge: ${middlewareName}`);

    // 1. Create IAM role with edgelambda trust
    const roleArn = yield* ensureEdgeRole(
      project,
      stage,
      middlewareName,
      makeTags(tagCtx, "iam-role")
    );

    // 2. Bundle middleware code
    const bundled = yield* bundle({
      projectDir,
      file,
      exportName,
      type: "staticSite",
    });
    const code = yield* zip({ content: bundled });

    // 3. Deploy Lambda to us-east-1 (x86_64, no env vars, no layers)
    const { functionArn } = yield* ensureLambda({
      project,
      stage,
      name: middlewareName,
      region: "us-east-1",
      roleArn,
      code,
      memory: 128,
      timeout: 5,
      architecture: Architecture.x86_64,
      tags: makeTags(tagCtx, "lambda"),
    }).pipe(
      Effect.provide(Aws.makeClients({ lambda: { region: "us-east-1" } }))
    );

    // 4. Publish version (Lambda@Edge requires versioned ARN)
    const { versionArn } = yield* publishVersion(
      `${project}-${stage}-${middlewareName}`
    ).pipe(
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
    const { projectDir, project, region, fn } = input;
    const { exportName, config } = fn;
    const stage = resolveStage(input.stage);
    const handlerName = exportName;
    const hasMiddleware = fn.hasHandler;

    const tagCtx: TagContext = { project, stage, handler: handlerName };
    const routePatterns = fn.routePatterns;

    if (routePatterns.length > 0 && !input.apiOriginDomain) {
      return yield* Effect.fail(
        new Error(
          `Static site "${exportName}" has routes but no API Gateway exists. ` +
          `Ensure defineHttp() handlers are included in the discovery patterns.`
        )
      );
    }

    // 1. Run build command if specified
    if (config.build) {
      yield* Effect.logDebug(`Building site: ${config.build}`);
      yield* Effect.try({
        try: () => execSync(config.build!, { cwd: projectDir, stdio: "inherit" }),
        catch: (error) => new Error(`Site build failed: ${error}`),
      });
    }

    // 2. Ensure S3 bucket
    const bucketName = `${project}-${stage}-${handlerName}-site`.toLowerCase();
    yield* ensureBucket({
      name: bucketName,
      region,
      tags: makeTags(tagCtx, "s3-bucket"),
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
    const isSpa = config.spa ?? false;
    let urlRewriteFunctionArn: string | undefined;
    let lambdaEdgeArn: string | undefined;

    if (hasMiddleware && input.file) {
      // Lambda@Edge handles both middleware logic and URL rewrite
      const result = yield* deployMiddlewareLambda({
        projectDir, project, stage, handlerName,
        file: input.file, exportName, tagCtx,
      }).pipe(
        Effect.provide(Aws.makeClients({ iam: { region: "us-east-1" } }))
      );
      lambdaEdgeArn = result.versionArn;
    } else {
      // CloudFront Function for URL rewrite + optional www redirect
      const needsUrlRewrite = !isSpa;
      const needsWwwRedirect = !!wwwDomain;

      if (needsUrlRewrite || needsWwwRedirect) {
        const fnName = needsWwwRedirect
          ? `${project}-${stage}-${handlerName}-viewer-req`
          : `${project}-${stage}-url-rewrite`;
        const result = yield* ensureViewerRequestFunction(fnName, {
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

    // 6. Ensure CloudFront distribution
    const index = config.index ?? "index.html";
    const { distributionId, distributionArn, domainName } = yield* ensureDistribution({
      project,
      stage,
      handlerName,
      bucketName,
      bucketRegion: region,
      oacId,
      spa: isSpa,
      index,
      tags: makeTags(tagCtx, "cloudfront-distribution"),
      urlRewriteFunctionArn,
      lambdaEdgeArn,
      aliases,
      acmCertificateArn,
      errorPagePath,
      ...(input.apiOriginDomain && routePatterns.length > 0
        ? { apiOriginDomain: input.apiOriginDomain, routePatterns }
        : {}),
    });

    // 7. Set bucket policy for CloudFront OAC
    yield* putBucketPolicyForOAC(bucketName, distributionArn);

    // 8. Sync files to S3
    const sourceDir = path.resolve(projectDir, config.dir);
    yield* syncFiles({ bucketName, sourceDir });

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

    const url = domain ? `https://${domain}` : `https://${domainName}`;
    yield* Effect.logDebug(`Static site deployed: ${url}`);

    return {
      exportName,
      handlerName,
      url,
      distributionId,
      bucketName,
    } satisfies DeployStaticSiteResult;
  });
