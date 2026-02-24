import { Effect, Schedule } from "effect";
import type { DistributionConfig } from "@aws-sdk/client-cloudfront";
import { cloudfront } from "./clients";
import { toAwsTagList, getResourcesByTags } from "./tags";

// AWS managed CachingOptimized policy
const CACHING_OPTIMIZED_POLICY_ID = "658327ea-f89d-4fab-a63d-7e88639e58f6";
// AWS managed CachingDisabled policy (for API proxying)
const CACHING_DISABLED_POLICY_ID = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
// AWS managed AllViewerExceptHostHeader origin request policy
const ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
// AWS managed SecurityHeadersPolicy (X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy)
const SECURITY_HEADERS_POLICY_ID = "67f7725c-6f97-4210-82d7-5512b31e9d03";

export type EnsureOACInput = {
  name: string;
};

export const ensureOAC = (input: EnsureOACInput) =>
  Effect.gen(function* () {
    const { name } = input;

    // Check if OAC already exists
    const result = yield* cloudfront.make("list_origin_access_controls", {});
    const existing = result.OriginAccessControlList?.Items?.find(
      oac => oac.Name === name
    );

    if (existing) {
      yield* Effect.logDebug(`OAC ${name} already exists: ${existing.Id}`);
      return { oacId: existing.Id! };
    }

    yield* Effect.logDebug(`Creating Origin Access Control: ${name}`);
    const createResult = yield* cloudfront.make("create_origin_access_control", {
      OriginAccessControlConfig: {
        Name: name,
        Description: `OAC for effortless-aws: ${name}`,
        SigningProtocol: "sigv4",
        SigningBehavior: "always",
        OriginAccessControlOriginType: "s3",
      },
    });

    return { oacId: createResult.OriginAccessControl!.Id! };
  });

// ============ CloudFront Functions ============

export type ViewerRequestFunctionConfig = {
  rewriteUrls: boolean;
  redirectWwwDomain?: string;
};

const generateViewerRequestCode = (config: ViewerRequestFunctionConfig): string => {
  const lines: string[] = [];
  lines.push("function handler(event) {");
  lines.push("  var request = event.request;");

  if (config.redirectWwwDomain) {
    const primaryDomain = config.redirectWwwDomain.replace(/^www\./, "");
    lines.push("  var host = request.headers.host && request.headers.host.value;");
    lines.push(`  if (host === '${config.redirectWwwDomain}') {`);
    lines.push("    return {");
    lines.push("      statusCode: 301,");
    lines.push("      statusDescription: 'Moved Permanently',");
    lines.push(`      headers: { location: { value: 'https://${primaryDomain}' + request.uri } }`);
    lines.push("    };");
    lines.push("  }");
  }

  if (config.rewriteUrls) {
    lines.push("  var uri = request.uri;");
    lines.push("  if (uri.endsWith('/')) {");
    lines.push("    request.uri += 'index.html';");
    lines.push("  } else if (!uri.includes('.')) {");
    lines.push("    request.uri += '/index.html';");
    lines.push("  }");
  }

  lines.push("  return request;");
  lines.push("}");
  return lines.join("\n");
};

const buildFunctionComment = (config: ViewerRequestFunctionConfig): string => {
  const parts: string[] = [];
  if (config.rewriteUrls) parts.push("URL rewrite");
  if (config.redirectWwwDomain) parts.push("www redirect");
  return `effortless: ${parts.join(" + ") || "viewer request"}`;
};

export const ensureViewerRequestFunction = (name: string, config: ViewerRequestFunctionConfig) =>
  Effect.gen(function* () {
    const functionCode = generateViewerRequestCode(config);
    const encodedCode = new TextEncoder().encode(functionCode);
    const comment = buildFunctionComment(config);

    const list = yield* cloudfront.make("list_functions", {});
    const existing = list.FunctionList?.Items?.find(f => f.Name === name);

    if (existing) {
      // Check if code has changed by comparing with the live version
      const getResult = yield* cloudfront.make("get_function", {
        Name: name,
        Stage: "LIVE",
      });
      const currentCode = getResult.FunctionCode
        ? new TextDecoder().decode(getResult.FunctionCode)
        : "";

      if (currentCode === functionCode) {
        yield* Effect.logDebug(`CloudFront Function ${name} is up to date, skipping update`);
        return { functionArn: existing.FunctionMetadata!.FunctionARN! };
      }

      yield* Effect.logDebug(`CloudFront Function ${name} code changed, updating...`);
      const updateResult = yield* cloudfront.make("update_function", {
        Name: name,
        IfMatch: getResult.ETag!,
        FunctionConfig: { Comment: comment, Runtime: "cloudfront-js-2.0" },
        FunctionCode: encodedCode,
      });

      yield* cloudfront.make("publish_function", {
        Name: name,
        IfMatch: updateResult.ETag!,
      });

      return { functionArn: existing.FunctionMetadata!.FunctionARN! };
    }

    yield* Effect.logDebug(`Creating CloudFront Function: ${name}`);
    const result = yield* cloudfront.make("create_function", {
      Name: name,
      FunctionConfig: { Comment: comment, Runtime: "cloudfront-js-2.0" },
      FunctionCode: encodedCode,
    });

    yield* cloudfront.make("publish_function", {
      Name: name,
      IfMatch: result.ETag!,
    });

    return { functionArn: result.FunctionSummary!.FunctionMetadata!.FunctionARN! };
  });

export const ensureUrlRewriteFunction = (name: string) =>
  ensureViewerRequestFunction(name, { rewriteUrls: true });

export type EnsureDistributionInput = {
  project: string;
  stage: string;
  handlerName: string;
  bucketName: string;
  bucketRegion: string;
  oacId: string;
  spa: boolean;
  index: string;
  tags: Record<string, string>;
  urlRewriteFunctionArn?: string;
  /** Lambda@Edge versioned ARN for viewer-request (mutually exclusive with urlRewriteFunctionArn) */
  lambdaEdgeArn?: string;
  aliases?: string[];
  acmCertificateArn?: string;
  /** API Gateway domain for route proxying (e.g. "abc123.execute-api.eu-west-1.amazonaws.com") */
  apiOriginDomain?: string;
  /** CloudFront path patterns to route to API Gateway (e.g. ["/api/*"]) */
  routePatterns?: string[];
  /** S3 key path for custom error page (e.g. "/_effortless/404.html") */
  errorPagePath?: string;
};

export type DistributionResult = {
  distributionId: string;
  distributionArn: string;
  domainName: string;
};

const makeDistComment = (project: string, stage: string, handlerName: string) =>
  `effortless: ${project}/${stage}/${handlerName}`;

export const ensureDistribution = (input: EnsureDistributionInput) =>
  Effect.gen(function* () {
    const { project, stage, handlerName, bucketName, bucketRegion, oacId, spa, index, tags, urlRewriteFunctionArn, lambdaEdgeArn, aliases, acmCertificateArn, apiOriginDomain, routePatterns } = input;
    const aliasesConfig = aliases && aliases.length > 0
      ? { Quantity: aliases.length, Items: aliases }
      : { Quantity: 0, Items: [] as string[] };
    const viewerCertificate = acmCertificateArn
      ? {
          ACMCertificateArn: acmCertificateArn,
          SSLSupportMethod: "sni-only" as const,
          MinimumProtocolVersion: "TLSv1.2_2021" as const,
        }
      : undefined;
    // CloudFront Functions and Lambda@Edge are mutually exclusive on viewer-request
    const functionAssociations = (!lambdaEdgeArn && urlRewriteFunctionArn)
      ? { Quantity: 1, Items: [{ FunctionARN: urlRewriteFunctionArn, EventType: "viewer-request" as const }] }
      : { Quantity: 0, Items: [] };
    const lambdaFunctionAssociations = lambdaEdgeArn
      ? { Quantity: 1, Items: [{ EventType: "viewer-request" as const, LambdaFunctionARN: lambdaEdgeArn, IncludeBody: false }] }
      : { Quantity: 0, Items: [] };
    const comment = makeDistComment(project, stage, handlerName);
    const s3OriginId = `S3-${bucketName}`;
    const s3OriginDomain = `${bucketName}.s3.${bucketRegion}.amazonaws.com`;

    // Build origins array: S3 + optional API Gateway
    const hasApiRoutes = apiOriginDomain && routePatterns && routePatterns.length > 0;
    const apiOriginId = hasApiRoutes ? `API-${project}-${stage}` : undefined;

    const originsItems = [
      {
        Id: s3OriginId,
        DomainName: s3OriginDomain,
        OriginPath: "",
        OriginAccessControlId: oacId,
        S3OriginConfig: { OriginAccessIdentity: "" },
        CustomHeaders: { Quantity: 0, Items: [] as { HeaderName: string; HeaderValue: string }[] },
      },
      ...(hasApiRoutes ? [{
        Id: apiOriginId!,
        DomainName: apiOriginDomain,
        OriginPath: "",
        ConnectionAttempts: 3,
        ConnectionTimeout: 10,
        CustomOriginConfig: {
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: "https-only" as const,
          OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2" as const] },
          OriginReadTimeout: 30,
          OriginKeepaliveTimeout: 5,
        },
        CustomHeaders: { Quantity: 0, Items: [] as { HeaderName: string; HeaderValue: string }[] },
      }] : []),
    ];

    // Build cache behaviors for API routes
    const API_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"] as const;
    const CACHED_METHODS = ["GET", "HEAD"] as const;

    const cacheBehaviors = hasApiRoutes
      ? {
          Quantity: routePatterns.length,
          Items: routePatterns.map(pattern => ({
            PathPattern: pattern,
            TargetOriginId: apiOriginId!,
            ViewerProtocolPolicy: "redirect-to-https" as const,
            AllowedMethods: {
              Quantity: 7 as const,
              Items: [...API_METHODS],
              CachedMethods: { Quantity: 2 as const, Items: [...CACHED_METHODS] },
            },
            Compress: true,
            SmoothStreaming: false,
            CachePolicyId: CACHING_DISABLED_POLICY_ID,
            OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
            FunctionAssociations: { Quantity: 0, Items: [] },
            LambdaFunctionAssociations: { Quantity: 0, Items: [] },
            FieldLevelEncryptionId: "",
          })),
        }
      : { Quantity: 0, Items: [] as never[] };

    const { errorPagePath } = input;
    const customErrorResponses = spa
      ? {
          Quantity: 2,
          Items: [
            {
              ErrorCode: 403,
              ResponseCode: "200",
              ResponsePagePath: `/${index}`,
              ErrorCachingMinTTL: 0,
            },
            {
              ErrorCode: 404,
              ResponseCode: "200",
              ResponsePagePath: `/${index}`,
              ErrorCachingMinTTL: 0,
            },
          ],
        }
      : errorPagePath
        ? {
            Quantity: 2,
            Items: [
              {
                ErrorCode: 403,
                ResponseCode: "404",
                ResponsePagePath: errorPagePath,
                ErrorCachingMinTTL: 0,
              },
              {
                ErrorCode: 404,
                ResponseCode: "404",
                ResponsePagePath: errorPagePath,
                ErrorCachingMinTTL: 0,
              },
            ],
          }
        : { Quantity: 0, Items: [] };

    // Find existing distribution by tags
    const existing = yield* findDistributionByTags(project, stage, handlerName);

    if (existing) {
      // Get current config to check if update is needed
      const configResult = yield* cloudfront.make("get_distribution_config", {
        Id: existing.Id,
      });
      const currentConfig = configResult.DistributionConfig!;

      const distResult = yield* cloudfront.make("get_distribution", { Id: existing.Id });
      const distributionArn = distResult.Distribution!.ARN!;

      // Check if distribution config needs updating
      const currentOrigin = currentConfig.Origins?.Items?.[0];
      const currentAliases = currentConfig.Aliases?.Items ?? [];
      const desiredAliases = aliases ?? [];
      const aliasesMatch =
        currentAliases.length === desiredAliases.length &&
        desiredAliases.every(a => currentAliases.includes(a));
      const certMatch = currentConfig.ViewerCertificate?.ACMCertificateArn === (acmCertificateArn ?? undefined);

      const currentLambdaEdgeArn = currentConfig.DefaultCacheBehavior?.LambdaFunctionAssociations?.Items?.[0]?.LambdaFunctionARN;

      // Check origins count and cache behaviors
      const originsMatch = (currentConfig.Origins?.Quantity ?? 0) === originsItems.length;
      const currentBehaviorPatterns = (currentConfig.CacheBehaviors?.Items ?? []).map(b => b.PathPattern).sort();
      const desiredBehaviorPatterns = (routePatterns ?? []).slice().sort();
      const behaviorsMatch =
        currentBehaviorPatterns.length === desiredBehaviorPatterns.length &&
        desiredBehaviorPatterns.every((p, i) => currentBehaviorPatterns[i] === p);
      // Check API origin domain if routes are configured
      const apiOriginMatch = !hasApiRoutes || currentConfig.Origins?.Items?.some(o => o.DomainName === apiOriginDomain);

      const needsUpdate =
        currentOrigin?.DomainName !== s3OriginDomain ||
        currentOrigin?.OriginAccessControlId !== oacId ||
        currentConfig.DefaultRootObject !== index ||
        currentConfig.DefaultCacheBehavior?.CachePolicyId !== CACHING_OPTIMIZED_POLICY_ID ||
        currentConfig.DefaultCacheBehavior?.ResponseHeadersPolicyId !== SECURITY_HEADERS_POLICY_ID ||
        (currentConfig.CustomErrorResponses?.Quantity ?? 0) !== customErrorResponses.Quantity ||
        (currentConfig.DefaultCacheBehavior?.FunctionAssociations?.Quantity ?? 0) !== functionAssociations.Quantity ||
        currentConfig.DefaultCacheBehavior?.FunctionAssociations?.Items?.[0]?.FunctionARN !== (urlRewriteFunctionArn ?? undefined) ||
        (currentConfig.DefaultCacheBehavior?.LambdaFunctionAssociations?.Quantity ?? 0) !== lambdaFunctionAssociations.Quantity ||
        currentLambdaEdgeArn !== (lambdaEdgeArn ?? undefined) ||
        !aliasesMatch ||
        !certMatch ||
        !originsMatch ||
        !behaviorsMatch ||
        !apiOriginMatch;

      if (needsUpdate) {
        yield* Effect.logDebug(`CloudFront distribution ${existing.Id} config changed, updating...`);
        const etag = configResult.ETag!;

        yield* cloudfront.make("update_distribution", {
          Id: existing.Id,
          IfMatch: etag,
          DistributionConfig: {
            ...currentConfig,
            Comment: comment,
            Origins: {
              Quantity: originsItems.length,
              Items: originsItems,
            },
            DefaultCacheBehavior: {
              ...currentConfig.DefaultCacheBehavior,
              TargetOriginId: s3OriginId,
              ViewerProtocolPolicy: "redirect-to-https",
              AllowedMethods: {
                Quantity: 2,
                Items: ["GET", "HEAD"],
                CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
              },
              Compress: true,
              CachePolicyId: CACHING_OPTIMIZED_POLICY_ID,
              ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY_ID,
              FunctionAssociations: functionAssociations,
              LambdaFunctionAssociations: lambdaFunctionAssociations,
              ForwardedValues: undefined,
            },
            CacheBehaviors: cacheBehaviors,
            Aliases: aliasesConfig,
            ...(viewerCertificate ? { ViewerCertificate: viewerCertificate } : {}),
            DefaultRootObject: index,
            CustomErrorResponses: customErrorResponses,
            Enabled: true,
          },
        });

        yield* cloudfront.make("tag_resource", {
          Resource: distributionArn,
          Tags: { Items: toAwsTagList(tags) },
        });
      } else {
        yield* Effect.logDebug(`CloudFront distribution ${existing.Id} is up to date, skipping update`);
      }

      return {
        distributionId: existing.Id!,
        distributionArn,
        domainName: existing.DomainName!,
      } satisfies DistributionResult;
    }

    // Create new distribution
    yield* Effect.logDebug("Creating CloudFront distribution (first deploy may take 5-15 minutes)...");

    const distConfig: DistributionConfig = {
      CallerReference: `${project}-${stage}-${handlerName}-${Date.now()}`,
      Comment: comment,
      Origins: {
        Quantity: originsItems.length,
        Items: originsItems,
      },
      DefaultCacheBehavior: {
        TargetOriginId: s3OriginId,
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: {
          Quantity: 2,
          Items: ["GET", "HEAD"],
          CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
        },
        Compress: true,
        CachePolicyId: CACHING_OPTIMIZED_POLICY_ID,
        ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY_ID,
        FunctionAssociations: functionAssociations,
        LambdaFunctionAssociations: lambdaFunctionAssociations,
      },
      CacheBehaviors: cacheBehaviors,
      Aliases: aliasesConfig,
      ...(viewerCertificate ? { ViewerCertificate: viewerCertificate } : {}),
      DefaultRootObject: index,
      Enabled: true,
      CustomErrorResponses: customErrorResponses,
      PriceClass: "PriceClass_All",
      HttpVersion: "http2and3",
    };

    const createResult = yield* cloudfront.make("create_distribution_with_tags", {
      DistributionConfigWithTags: {
        DistributionConfig: distConfig,
        Tags: { Items: toAwsTagList(tags) },
      },
    }).pipe(
      // If CNAME is claimed by another distribution (e.g. DNS still points elsewhere),
      // retry without aliases so the deploy doesn't fail
      Effect.catchIf(
        e => e._tag === "CloudFrontError" && e.is("CNAMEAlreadyExists"),
        () => Effect.gen(function* () {
          const cnameList = aliases?.join(", ") ?? "";
          yield* Effect.logWarning(
            `Domain ${cnameList} is still associated with another CloudFront distribution (DNS points elsewhere). ` +
            `Creating distribution without custom domain. Update your DNS records and redeploy to attach the domain.`
          );
          return yield* cloudfront.make("create_distribution_with_tags", {
            DistributionConfigWithTags: {
              DistributionConfig: {
                ...distConfig,
                Aliases: { Quantity: 0, Items: [] as string[] },
              },
              Tags: { Items: toAwsTagList(tags) },
            },
          });
        })
      )
    );

    const dist = createResult.Distribution!;
    return {
      distributionId: dist.Id!,
      distributionArn: dist.ARN!,
      domainName: dist.DomainName!,
    } satisfies DistributionResult;
  });

const findDistributionByTags = (project: string, stage: string, handlerName: string) =>
  Effect.gen(function* () {
    const resources = yield* getResourcesByTags(project, stage);
    const candidates = resources.filter(r => {
      const isDistribution = r.ResourceARN?.includes(":distribution/");
      const handlerTag = r.Tags?.find(t => t.Key === "effortless:handler");
      return isDistribution && handlerTag?.Value === handlerName;
    });

    // Try each candidate — stale tag entries may reference deleted distributions
    for (const dist of candidates) {
      const distributionId = dist.ResourceARN!.split("/").pop()!;
      const result = yield* cloudfront.make("get_distribution", { Id: distributionId }).pipe(
        Effect.catchIf(
          e => e._tag === "CloudFrontError" && e.is("NoSuchDistribution"),
          () => {
            Effect.logDebug(`Distribution ${distributionId} no longer exists (stale tag), skipping`);
            return Effect.succeed(undefined);
          }
        )
      );
      if (result) {
        return {
          Id: distributionId,
          DomainName: result.Distribution!.DomainName!,
        };
      }
    }

    return undefined;
  });

export const invalidateDistribution = (distributionId: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Invalidating CloudFront distribution: ${distributionId}`);

    yield* cloudfront.make("create_invalidation", {
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: Date.now().toString(),
        Paths: {
          Quantity: 1,
          Items: ["/*"],
        },
      },
    });
  });

export const disableAndDeleteDistribution = (distributionId: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Disabling CloudFront distribution: ${distributionId}`);

    // Get current config
    const configResult = yield* cloudfront.make("get_distribution_config", {
      Id: distributionId,
    }).pipe(
      Effect.catchIf(
        e => e._tag === "CloudFrontError" && e.is("NoSuchDistribution"),
        () => Effect.succeed(undefined)
      )
    );

    if (!configResult) {
      yield* Effect.logDebug(`Distribution ${distributionId} not found, skipping`);
      return;
    }

    const currentConfig = configResult.DistributionConfig!;

    // Disable if enabled
    if (currentConfig.Enabled) {
      const disableResult = yield* cloudfront.make("update_distribution", {
        Id: distributionId,
        IfMatch: configResult.ETag!,
        DistributionConfig: {
          ...currentConfig,
          Enabled: false,
        },
      });

      // Wait for distribution to be deployed (disabled)
      yield* waitForDistributionDeployed(distributionId);

      // Delete with the new ETag
      yield* cloudfront.make("delete_distribution", {
        Id: distributionId,
        IfMatch: disableResult.ETag!,
      });
    } else {
      // Already disabled, just delete
      yield* cloudfront.make("delete_distribution", {
        Id: distributionId,
        IfMatch: configResult.ETag!,
      });
    }

    yield* Effect.logDebug(`Deleted CloudFront distribution: ${distributionId}`);
  });

const waitForDistributionDeployed = (distributionId: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Waiting for distribution ${distributionId} to deploy (this may take several minutes)...`);

    yield* Effect.retry(
      cloudfront.make("get_distribution", { Id: distributionId }).pipe(
        Effect.flatMap(r => {
          const status = r.Distribution?.Status;
          if (status === "Deployed") {
            return Effect.succeed(r);
          }
          return Effect.fail(new Error(`Distribution status: ${status}`));
        })
      ),
      {
        times: 45,
        schedule: Schedule.spaced("10 seconds"),
      }
    );
  });

export const deleteOAC = (oacId: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting Origin Access Control: ${oacId}`);

    // Get ETag first
    const result = yield* cloudfront.make("list_origin_access_controls", {});
    const oac = result.OriginAccessControlList?.Items?.find(o => o.Id === oacId);

    if (!oac) {
      yield* Effect.logDebug(`OAC ${oacId} not found, skipping`);
      return;
    }

    // Need to get the full OAC to get ETag
    // OAC deletion requires going through get_origin_access_control first
    // but we don't have that command easily. Use the list to check existence,
    // and try delete directly — CloudFront will error if in use.
    yield* cloudfront.make("delete_origin_access_control", {
      Id: oacId,
      IfMatch: "*", // Not ideal but works for cleanup
    }).pipe(
      Effect.catchIf(
        e => e._tag === "CloudFrontError",
        (e) => Effect.logDebug(`Could not delete OAC ${oacId}: ${e.cause.message}`)
      )
    );
  });

/**
 * Find and delete CloudFront Functions that match the project/stage naming
 * convention but are not associated with any distribution in the project.
 */
export const cleanupOrphanedFunctions = (project: string, stage: string) =>
  Effect.gen(function* () {
    const prefix = `${project}-${stage}-`;

    // List all CloudFront Functions matching our naming pattern
    const list = yield* cloudfront.make("list_functions", {});
    const ourFunctions = (list.FunctionList?.Items ?? []).filter(
      f => f.Name?.startsWith(prefix)
    );

    if (ourFunctions.length === 0) return;

    // Get all distributions for this project/stage
    const resources = yield* getResourcesByTags(project, stage);
    const distIds = resources
      .filter(r => r.ResourceARN?.includes(":distribution/"))
      .map(r => r.ResourceARN!.split("/").pop()!)
      .filter(Boolean);

    // Collect all function ARNs actively used by our distributions
    const activeFunctionArns = new Set<string>();
    for (const distId of distIds) {
      const config = yield* cloudfront.make("get_distribution_config", { Id: distId });
      const associations = config.DistributionConfig?.DefaultCacheBehavior?.FunctionAssociations?.Items ?? [];
      for (const assoc of associations) {
        if (assoc.FunctionARN) activeFunctionArns.add(assoc.FunctionARN);
      }
    }

    // Delete functions not referenced by any distribution
    for (const fn of ourFunctions) {
      const arn = fn.FunctionMetadata?.FunctionARN;
      if (arn && !activeFunctionArns.has(arn)) {
        yield* Effect.logDebug(`Deleting orphaned CloudFront Function: ${fn.Name}`);
        yield* cloudfront.make("describe_function", {
          Name: fn.Name!,
          Stage: "LIVE",
        }).pipe(
          Effect.flatMap(desc =>
            cloudfront.make("delete_function", {
              Name: fn.Name!,
              IfMatch: desc.ETag!,
            })
          ),
          Effect.catchIf(
            e => e._tag === "CloudFrontError",
            (e) => Effect.logDebug(`Could not delete function ${fn.Name}: ${e.cause.message}`)
          )
        );
      }
    }
  });
