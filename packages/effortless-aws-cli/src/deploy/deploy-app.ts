import { Effect } from "effect";
import { execSync } from "child_process";
import * as path from "path";
import type { ExtractedAppFunction } from "~/build/bundle";
import { zipDirectory, detectAssetPatterns } from "~/build/bundle";
import {
  Aws,
  makeTags,
  resolveStage,
  type TagContext,
  ensureRole,
  ensureLambda,
  ensureFunctionUrl,
  addCloudFrontPermission,
  ensureBucket,
  syncFiles,
  putBucketPolicyForOAC,
  ensureOAC,
  ensureSsrDistribution,
  invalidateDistribution,
  findCertificate,
} from "../aws";

// ============ App (SSR) deployment ============

export type DeployAppInput = {
  projectDir: string;
  project: string;
  stage?: string;
  region: string;
  fn: ExtractedAppFunction;
};

export type DeployAppResult = {
  exportName: string;
  handlerName: string;
  url: string;
  distributionId: string;
  bucketName: string;
  functionArn: string;
};

/** @internal */
export const deployApp = (input: DeployAppInput) =>
  Effect.gen(function* () {
    const { projectDir, project, region, fn } = input;
    const { exportName, config } = fn;
    const stage = resolveStage(input.stage);
    const handlerName = exportName;

    const tagCtx: TagContext = { project, stage, handler: handlerName };

    // 1. Run build command if specified
    if (config.build) {
      yield* Effect.logDebug(`Building app: ${config.build}`);
      yield* Effect.try({
        try: () => execSync(config.build!, { cwd: projectDir, stdio: "inherit" }),
        catch: (error) => new Error(`App build failed: ${error}`),
      });
    }

    // 2. ZIP server directory
    const serverDir = path.resolve(projectDir, config.server);
    yield* Effect.logDebug(`Zipping server directory: ${serverDir}`);
    const code = yield* zipDirectory(serverDir);

    // 3. Create IAM role
    const permissions = config.permissions ?? [];
    const roleArn = yield* ensureRole(
      project, stage, handlerName,
      permissions.length > 0 ? permissions : undefined,
      makeTags(tagCtx, "iam-role"),
    );

    // 4. Deploy Lambda
    const { functionArn } = yield* ensureLambda({
      project,
      stage,
      name: handlerName,
      region,
      roleArn,
      code,
      handler: "index.handler",
      memory: config.memory ?? 1024,
      timeout: config.timeout ?? 30,
      tags: makeTags(tagCtx, "lambda"),
      environment: {
        EFF_PROJECT: project,
        EFF_STAGE: stage,
        EFF_HANDLER: handlerName,
      },
    });

    // 5. Create Lambda Function URL (AWS_IAM auth)
    const lambdaName = `${project}-${stage}-${handlerName}`;
    const { functionUrl } = yield* ensureFunctionUrl(lambdaName);
    const lambdaOriginDomain = functionUrl!
      .replace("https://", "")
      .replace(/\/$/, "");

    // 6. Create S3 bucket for static assets
    const bucketName = `${project}-${stage}-${handlerName}-assets`.toLowerCase();
    yield* ensureBucket({
      name: bucketName,
      region,
      tags: makeTags(tagCtx, "s3-bucket"),
    });

    // 7. Ensure S3 OAC
    const s3OacName = `${project}-${stage}-oac`;
    const { oacId: s3OacId } = yield* ensureOAC({ name: s3OacName, originType: "s3" });

    // 8. Ensure Lambda OAC
    const lambdaOacName = `${project}-${stage}-lambda-oac`;
    const { oacId: lambdaOacId } = yield* ensureOAC({ name: lambdaOacName, originType: "lambda" });

    // 9. Detect asset patterns from the assets directory
    const assetsDir = path.resolve(projectDir, config.assets);
    const assetPatterns = detectAssetPatterns(assetsDir);
    yield* Effect.logDebug(`Detected ${assetPatterns.length} asset pattern(s): ${assetPatterns.join(", ")}`);

    // 10. Resolve domain + ACM certificate
    const domain = typeof config.domain === "string"
      ? config.domain
      : config.domain?.[stage];
    let aliases: string[] | undefined;
    let acmCertificateArn: string | undefined;

    if (domain) {
      const certResult = yield* findCertificate(domain);
      acmCertificateArn = certResult.certificateArn;
      aliases = [domain];
    }

    // 11. Create/update CloudFront distribution
    const { distributionId, distributionArn, domainName } = yield* ensureSsrDistribution({
      project,
      stage,
      handlerName,
      bucketName,
      bucketRegion: region,
      s3OacId,
      lambdaOriginDomain,
      lambdaOacId,
      assetPatterns,
      tags: makeTags(tagCtx, "cloudfront-distribution"),
      aliases,
      acmCertificateArn,
    });

    // 12. Add CloudFront → Lambda permission
    yield* addCloudFrontPermission(lambdaName, distributionArn);

    // 13. Set S3 bucket policy for OAC
    yield* putBucketPolicyForOAC(bucketName, distributionArn);

    // 14. Sync static assets to S3
    yield* syncFiles({ bucketName, sourceDir: assetsDir });

    // 15. Invalidate CloudFront cache
    yield* invalidateDistribution(distributionId);

    const url = domain ? `https://${domain}` : `https://${domainName}`;
    yield* Effect.logDebug(`App deployed: ${url}`);

    return {
      exportName,
      handlerName,
      url,
      distributionId,
      bucketName,
      functionArn,
    } satisfies DeployAppResult;
  });
