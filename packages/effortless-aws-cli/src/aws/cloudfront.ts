import { Effect, Schedule } from "effect";
import type { DistributionConfig } from "@aws-sdk/client-cloudfront";
import { cloudfront } from "./clients";
import { toAwsTagList, getResourcesByTags } from "./resource-lookup";
import { DeployContext } from "../core";

// AWS managed CachingOptimized policy
const CACHING_OPTIMIZED_POLICY_ID = "658327ea-f89d-4fab-a63d-7e88639e58f6";
// AWS managed CachingDisabled policy (for SSR default behavior)
const CACHING_DISABLED_POLICY_ID = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
// Custom cache policy name for API routes (respects origin Cache-Control headers)
const API_CACHE_POLICY_NAME = "Effortless-UseOriginCacheHeaders";
// AWS managed AllViewerExceptHostHeader origin request policy
const ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID = "b689b0a8-53d0-40ab-baf2-68738e2966ac";
// AWS managed SecurityHeadersPolicy (X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy)
const SECURITY_HEADERS_POLICY_ID = "67f7725c-6f97-4210-82d7-5512b31e9d03";

/**
 * Expand route patterns so `/prefix/*` also covers the bare `/prefix` path.
 * CloudFront `/prefix/*` only matches `/prefix/...`, not `/prefix` itself.
 */
const expandRoutePatterns = (patterns: string[]): string[] => {
  const expanded = new Set<string>();
  for (const p of patterns) {
    expanded.add(p);
    if (p.endsWith("/*")) {
      expanded.add(p.slice(0, -2));
    }
  }
  return [...expanded];
};

export type EnsureOACInput = {
  name: string;
  originType?: "s3" | "lambda";
};

export const ensureOAC = (input: EnsureOACInput) =>
  Effect.gen(function* () {
    const { name, originType = "s3" } = input;

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
        OriginAccessControlOriginType: originType,
      },
    });

    return { oacId: createResult.OriginAccessControl!.Id! };
  });

// ============ CloudFront Signed Cookies (Public Keys & Key Groups) ============

export type EnsurePublicKeyInput = {
  name: string;
  publicKeyPem: string;
};

export const ensurePublicKey = (input: EnsurePublicKeyInput) =>
  Effect.gen(function* () {
    const { name, publicKeyPem } = input;

    const result = yield* cloudfront.make("list_public_keys", {});
    const existing = result.PublicKeyList?.Items?.find(
      pk => pk.Name === name
    );

    if (existing) {
      yield* Effect.logDebug(`Public key ${name} already exists: ${existing.Id}`);
      return { publicKeyId: existing.Id! };
    }

    yield* Effect.logDebug(`Creating CloudFront public key: ${name}`);
    const createResult = yield* cloudfront.make("create_public_key", {
      PublicKeyConfig: {
        CallerReference: `${name}-${Date.now()}`,
        Name: name,
        EncodedKey: publicKeyPem,
        Comment: `Signing key for effortless-aws: ${name}`,
      },
    });

    return { publicKeyId: createResult.PublicKey!.Id! };
  });

export type EnsureKeyGroupInput = {
  name: string;
  publicKeyIds: string[];
};

export const ensureKeyGroup = (input: EnsureKeyGroupInput) =>
  Effect.gen(function* () {
    const { name, publicKeyIds } = input;

    const result = yield* cloudfront.make("list_key_groups", {});
    const existing = result.KeyGroupList?.Items?.find(
      kg => kg.KeyGroup?.KeyGroupConfig?.Name === name
    );

    if (existing) {
      const keyGroupId = existing.KeyGroup!.Id!;
      // Check if public key IDs match
      const currentIds = existing.KeyGroup!.KeyGroupConfig!.Items ?? [];
      const idsMatch = currentIds.length === publicKeyIds.length &&
        publicKeyIds.every(id => currentIds.includes(id));

      if (!idsMatch) {
        yield* Effect.logDebug(`Updating Key Group ${name} with new public keys...`);
        const configResult = yield* cloudfront.make("get_key_group_config", { Id: keyGroupId });
        yield* cloudfront.make("update_key_group", {
          Id: keyGroupId,
          IfMatch: configResult.ETag!,
          KeyGroupConfig: {
            Name: name,
            Items: publicKeyIds,
            Comment: `Signing key group for effortless-aws: ${name}`,
          },
        });
      } else {
        yield* Effect.logDebug(`Key Group ${name} already exists: ${keyGroupId}`);
      }

      return { keyGroupId };
    }

    yield* Effect.logDebug(`Creating CloudFront Key Group: ${name}`);
    const createResult = yield* cloudfront.make("create_key_group", {
      KeyGroupConfig: {
        Name: name,
        Items: publicKeyIds,
        Comment: `Signing key group for effortless-aws: ${name}`,
      },
    });

    return { keyGroupId: createResult.KeyGroup!.Id! };
  });

// ============ CloudFront Functions ============

export type ViewerRequestFunctionConfig = {
  /** Non-SPA: append index.html to directory paths (e.g. /about → /about/index.html) */
  rewriteUrls?: boolean;
  /** SPA: rewrite all extensionless paths to /index.html for client-side routing */
  spaFallback?: boolean;
  redirectWwwDomain?: string;
};

/** @internal exported for testing */
export const generateViewerRequestCode = (config: ViewerRequestFunctionConfig): string => {
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

  if (config.spaFallback) {
    lines.push("  var uri = request.uri;");
    lines.push("  if (uri === '/' || uri.includes('.')) {");
    lines.push("    return request;");
    lines.push("  }");
    lines.push("  request.uri = '/index.html';");
  } else if (config.rewriteUrls) {
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
  index: string;
  tags: Record<string, string>;
  urlRewriteFunctionArn?: string;
  /** Lambda@Edge versioned ARN for viewer-request (mutually exclusive with urlRewriteFunctionArn) */
  lambdaEdgeArn?: string;
  aliases?: string[];
  acmCertificateArn?: string;
  /** Resolved API routes: each pattern mapped to its Lambda origin domain */
  apiRoutes?: { pattern: string; originDomain: string }[];
  /** CloudFront cache policy ID for API route behaviors */
  apiCachePolicyId?: string;
  /** S3 key path for custom error page (e.g. "/_effortless/404.html") */
  errorPagePath?: string;
  /** Additional S3 bucket origins (for bucket routes with optional signed cookies) */
  bucketOrigins?: {
    originId: string;
    bucketName: string;
    bucketRegion: string;
    oacId: string;
    pathPattern: string;
    /** CloudFront Key Group ID for signed cookies (only for access: "private") */
    keyGroupId?: string;
  }[];
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
    const { project, stage, handlerName, bucketName, bucketRegion, oacId, index, tags, urlRewriteFunctionArn, lambdaEdgeArn, aliases, acmCertificateArn, apiRoutes, apiCachePolicyId } = input;
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

    // Build API origins: one per unique domain, each route maps to its origin
    const hasApiRoutes = apiRoutes && apiRoutes.length > 0;
    const uniqueApiDomains = new Map<string, string>(); // domain → originId
    if (hasApiRoutes) {
      let idx = 0;
      for (const r of apiRoutes) {
        if (!uniqueApiDomains.has(r.originDomain)) {
          uniqueApiDomains.set(r.originDomain, `API-${project}-${stage}${idx > 0 ? `-${idx}` : ""}`);
          idx++;
        }
      }
    }

    // Build bucket origins (for bucket routes)
    const bucketOriginItems = (input.bucketOrigins ?? []).map(bo => ({
      Id: bo.originId,
      DomainName: `${bo.bucketName}.s3.${bo.bucketRegion}.amazonaws.com`,
      OriginPath: "",
      OriginAccessControlId: bo.oacId,
      S3OriginConfig: { OriginAccessIdentity: "" },
      CustomHeaders: { Quantity: 0, Items: [] as { HeaderName: string; HeaderValue: string }[] },
    }));

    const apiOriginItems = hasApiRoutes
      ? [...uniqueApiDomains.entries()].map(([domain, originId]) => ({
          Id: originId,
          DomainName: domain,
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
        }))
      : [];

    const originsItems = [
      {
        Id: s3OriginId,
        DomainName: s3OriginDomain,
        OriginPath: "",
        OriginAccessControlId: oacId,
        S3OriginConfig: { OriginAccessIdentity: "" },
        CustomHeaders: { Quantity: 0, Items: [] as { HeaderName: string; HeaderValue: string }[] },
      },
      ...apiOriginItems,
      ...bucketOriginItems,
    ];

    // Build cache behaviors for API routes
    const API_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"] as const;
    const CACHED_METHODS = ["GET", "HEAD"] as const;

    const apiCacheBehaviorItems = hasApiRoutes
      ? apiRoutes.flatMap(route => {
          const originId = uniqueApiDomains.get(route.originDomain)!;
          return expandRoutePatterns([route.pattern]).map(pattern => ({
            PathPattern: pattern,
            TargetOriginId: originId,
            ViewerProtocolPolicy: "redirect-to-https" as const,
            AllowedMethods: {
              Quantity: 7 as const,
              Items: [...API_METHODS],
              CachedMethods: { Quantity: 2 as const, Items: [...CACHED_METHODS] },
            },
            Compress: true,
            SmoothStreaming: false,
            CachePolicyId: apiCachePolicyId!,
            OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
            FunctionAssociations: { Quantity: 0, Items: [] },
            LambdaFunctionAssociations: { Quantity: 0, Items: [] },
            FieldLevelEncryptionId: "",
          }));
        })
      : [];

    // Build cache behaviors for bucket origins (with optional signed cookies)
    const bucketCacheBehaviorItems = (input.bucketOrigins ?? []).flatMap(bo => {
      const expandedPatterns = expandRoutePatterns([bo.pathPattern]);
      return expandedPatterns.map(pattern => ({
        PathPattern: pattern,
        TargetOriginId: bo.originId,
        ViewerProtocolPolicy: "redirect-to-https" as const,
        AllowedMethods: {
          Quantity: 2 as const,
          Items: [...CACHED_METHODS],
          CachedMethods: { Quantity: 2 as const, Items: [...CACHED_METHODS] },
        },
        Compress: true,
        SmoothStreaming: false,
        CachePolicyId: CACHING_OPTIMIZED_POLICY_ID,
        ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY_ID,
        FunctionAssociations: { Quantity: 0, Items: [] as { FunctionARN: string; EventType: "viewer-request" }[] },
        LambdaFunctionAssociations: { Quantity: 0, Items: [] },
        FieldLevelEncryptionId: "",
        ...(bo.keyGroupId ? { TrustedKeyGroups: { Enabled: true, Quantity: 1, Items: [bo.keyGroupId] } } : {}),
      }));
    });

    const allBehaviorItems = [...apiCacheBehaviorItems, ...bucketCacheBehaviorItems];
    const cacheBehaviors = allBehaviorItems.length > 0
      ? { Quantity: allBehaviorItems.length, Items: allBehaviorItems }
      : { Quantity: 0, Items: [] as never[] };

    const { errorPagePath } = input;
    // SPA fallback is handled by CloudFront Function (spaFallback), not CustomErrorResponses.
    // This avoids intercepting 403 from private bucket routes.
    const customErrorResponses = errorPagePath
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
    const existing = yield* findDistributionByTags(handlerName);

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
      const desiredBehaviorPatterns = apiCacheBehaviorItems.map(b => b.PathPattern).sort();
      const behaviorsMatch =
        currentBehaviorPatterns.length === desiredBehaviorPatterns.length &&
        desiredBehaviorPatterns.every((p, i) => currentBehaviorPatterns[i] === p);
      // Check all API origin domains match
      const currentOriginDomains = new Set((currentConfig.Origins?.Items ?? []).map(o => o.DomainName));
      const apiOriginMatch = !hasApiRoutes || [...uniqueApiDomains.keys()].every(d => currentOriginDomains.has(d));

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

// ============ SSR Distribution (Lambda Function URL + S3) ============

export type EnsureSsrDistributionInput = {
  project: string;
  stage: string;
  handlerName: string;
  bucketName: string;
  bucketRegion: string;
  s3OacId: string;
  /** Lambda Function URL domain (e.g. "abc123.lambda-url.eu-west-1.on.aws") */
  lambdaOriginDomain: string;
  /** CloudFront path patterns for S3 static assets (e.g. ["/_nuxt/*", "/favicon.ico"]) */
  assetPatterns: string[];
  tags: Record<string, string>;
  aliases?: string[];
  acmCertificateArn?: string;
  /** Resolved API routes: each pattern mapped to its Lambda origin domain */
  apiRoutes?: { pattern: string; originDomain: string }[];
  /** CloudFront cache policy ID for API route behaviors */
  apiCachePolicyId?: string;
};

export const ensureSsrDistribution = (input: EnsureSsrDistributionInput) =>
  Effect.gen(function* () {
    const { project, stage, handlerName, bucketName, bucketRegion, s3OacId, lambdaOriginDomain, assetPatterns, tags, aliases, acmCertificateArn, apiRoutes, apiCachePolicyId } = input;

    const comment = makeDistComment(project, stage, handlerName);
    const lambdaOriginId = `Lambda-${project}-${stage}-${handlerName}`;
    const s3OriginId = `S3-${bucketName}`;
    const s3OriginDomain = `${bucketName}.s3.${bucketRegion}.amazonaws.com`;

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

    const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"] as const;
    const CACHED_METHODS = ["GET", "HEAD"] as const;

    // Build API origins: one per unique domain
    const hasApiRoutes = apiRoutes && apiRoutes.length > 0;
    const uniqueApiDomains = new Map<string, string>(); // domain → originId
    if (hasApiRoutes) {
      let idx = 0;
      for (const r of apiRoutes) {
        if (!uniqueApiDomains.has(r.originDomain)) {
          uniqueApiDomains.set(r.originDomain, `API-${project}-${stage}${idx > 0 ? `-${idx}` : ""}`);
          idx++;
        }
      }
    }

    // Origins: Lambda Function URL (default) + S3 (static assets) + API origins
    const apiOriginItems = hasApiRoutes
      ? [...uniqueApiDomains.entries()].map(([domain, originId]) => ({
          Id: originId,
          DomainName: domain,
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
        }))
      : [];

    const originsItems = [
      {
        Id: lambdaOriginId,
        DomainName: lambdaOriginDomain,
        OriginPath: "",
        CustomOriginConfig: {
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: "https-only" as const,
          OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2" as const] },
          OriginReadTimeout: 30,
          OriginKeepaliveTimeout: 5,
        },
        CustomHeaders: { Quantity: 0, Items: [] as { HeaderName: string; HeaderValue: string }[] },
      },
      {
        Id: s3OriginId,
        DomainName: s3OriginDomain,
        OriginPath: "",
        OriginAccessControlId: s3OacId,
        S3OriginConfig: { OriginAccessIdentity: "" },
        CustomHeaders: { Quantity: 0, Items: [] as { HeaderName: string; HeaderValue: string }[] },
      },
      ...apiOriginItems,
    ];

    // Default behavior → Lambda Function URL (SSR)
    const defaultCacheBehavior = {
      TargetOriginId: lambdaOriginId,
      ViewerProtocolPolicy: "redirect-to-https" as const,
      AllowedMethods: {
        Quantity: 7 as const,
        Items: [...ALL_METHODS],
        CachedMethods: { Quantity: 2 as const, Items: [...CACHED_METHODS] },
      },
      Compress: true,
      SmoothStreaming: false,
      CachePolicyId: CACHING_DISABLED_POLICY_ID,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
      ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY_ID,
      FunctionAssociations: { Quantity: 0, Items: [] },
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FieldLevelEncryptionId: "",
    };

    // Cache behaviors: API routes → asset patterns (cached) → default (SSR)
    const apiRouteBehaviors = hasApiRoutes
      ? apiRoutes.flatMap(route => {
          const originId = uniqueApiDomains.get(route.originDomain)!;
          return expandRoutePatterns([route.pattern]).map(pattern => ({
            PathPattern: pattern,
            TargetOriginId: originId,
            ViewerProtocolPolicy: "redirect-to-https" as const,
            AllowedMethods: {
              Quantity: 7 as const,
              Items: [...ALL_METHODS],
              CachedMethods: { Quantity: 2 as const, Items: [...CACHED_METHODS] },
            },
            Compress: true,
            SmoothStreaming: false,
            CachePolicyId: apiCachePolicyId!,
            OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID,
            FunctionAssociations: { Quantity: 0, Items: [] },
            LambdaFunctionAssociations: { Quantity: 0, Items: [] },
            FieldLevelEncryptionId: "",
          }));
        })
      : [];

    const assetBehaviors = assetPatterns.map(pattern => ({
      PathPattern: pattern,
      TargetOriginId: s3OriginId,
      ViewerProtocolPolicy: "redirect-to-https" as const,
      AllowedMethods: {
        Quantity: 2 as const,
        Items: [...CACHED_METHODS],
        CachedMethods: { Quantity: 2 as const, Items: [...CACHED_METHODS] },
      },
      Compress: true,
      SmoothStreaming: false,
      CachePolicyId: CACHING_OPTIMIZED_POLICY_ID,
      ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY_ID,
      FunctionAssociations: { Quantity: 0, Items: [] },
      LambdaFunctionAssociations: { Quantity: 0, Items: [] },
      FieldLevelEncryptionId: "",
    }));

    const allBehaviors = [...apiRouteBehaviors, ...assetBehaviors];
    const cacheBehaviors = allBehaviors.length > 0
      ? { Quantity: allBehaviors.length, Items: allBehaviors }
      : { Quantity: 0, Items: [] as never[] };

    // Find existing distribution by tags
    const existing = yield* findDistributionByTags(handlerName);

    if (existing) {
      const configResult = yield* cloudfront.make("get_distribution_config", {
        Id: existing.Id,
      });
      const currentConfig = configResult.DistributionConfig!;
      const distResult = yield* cloudfront.make("get_distribution", { Id: existing.Id });
      const distributionArn = distResult.Distribution!.ARN!;

      yield* Effect.logDebug(`Updating SSR CloudFront distribution ${existing.Id}...`);
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
          DefaultCacheBehavior: defaultCacheBehavior,
          CacheBehaviors: cacheBehaviors,
          Aliases: aliasesConfig,
          ...(viewerCertificate ? { ViewerCertificate: viewerCertificate } : {}),
          DefaultRootObject: "",
          Enabled: true,
          CustomErrorResponses: { Quantity: 0, Items: [] },
        },
      });

      yield* cloudfront.make("tag_resource", {
        Resource: distributionArn,
        Tags: { Items: toAwsTagList(tags) },
      });

      return {
        distributionId: existing.Id!,
        distributionArn,
        domainName: existing.DomainName!,
      } satisfies DistributionResult;
    }

    // Create new distribution
    yield* Effect.logDebug("Creating SSR CloudFront distribution (first deploy may take 5-15 minutes)...");

    const distConfig: DistributionConfig = {
      CallerReference: `${project}-${stage}-${handlerName}-${Date.now()}`,
      Comment: comment,
      Origins: {
        Quantity: originsItems.length,
        Items: originsItems,
      },
      DefaultCacheBehavior: defaultCacheBehavior,
      CacheBehaviors: cacheBehaviors,
      Aliases: aliasesConfig,
      ...(viewerCertificate ? { ViewerCertificate: viewerCertificate } : {}),
      DefaultRootObject: "",
      Enabled: true,
      CustomErrorResponses: { Quantity: 0, Items: [] },
      PriceClass: "PriceClass_All",
      HttpVersion: "http2and3",
    };

    const createResult = yield* cloudfront.make("create_distribution_with_tags", {
      DistributionConfigWithTags: {
        DistributionConfig: distConfig,
        Tags: { Items: toAwsTagList(tags) },
      },
    }).pipe(
      Effect.catchIf(
        e => e._tag === "CloudFrontError" && e.is("CNAMEAlreadyExists"),
        () => Effect.gen(function* () {
          const cnameList = aliases?.join(", ") ?? "";
          yield* Effect.logWarning(
            `Domain ${cnameList} is still associated with another CloudFront distribution. ` +
            `Creating distribution without custom domain. Update DNS and redeploy to attach.`
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

export const findDistributionByTags = (handlerName: string) =>
  Effect.gen(function* () {
    const resources = yield* getResourcesByTags;
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
export const cleanupOrphanedFunctions = Effect.gen(function* () {
    const { project, stage } = yield* DeployContext;
    const prefix = `${project}-${stage}-`;

    // List all CloudFront Functions matching our naming pattern
    const list = yield* cloudfront.make("list_functions", {});
    const ourFunctions = (list.FunctionList?.Items ?? []).filter(
      f => f.Name?.startsWith(prefix)
    );

    if (ourFunctions.length === 0) return;

    // Get all distributions for this project/stage
    const resources = yield* getResourcesByTags;
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

// ============ API Cache Policy ============

/**
 * Ensure a custom CloudFront cache policy exists for API routes.
 *
 * This policy has DefaultTTL=0 (no caching by default) but respects
 * origin Cache-Control headers (MaxTTL=86400). Routes that set
 * Cache-Control via the `cache` option will be cached by CloudFront;
 * routes without it won't.
 */
export const ensureApiCachePolicy = () =>
  Effect.gen(function* () {
    // Check if policy already exists
    const result = yield* cloudfront.make("list_cache_policies", { Type: "custom" });
    const existing = result.CachePolicyList?.Items?.find(
      item => item.CachePolicy?.CachePolicyConfig?.Name === API_CACHE_POLICY_NAME,
    );

    if (existing) {
      const id = existing.CachePolicy!.Id!;
      yield* Effect.logDebug(`API cache policy already exists: ${id}`);
      return id;
    }

    yield* Effect.logDebug(`Creating CloudFront cache policy: ${API_CACHE_POLICY_NAME}`);
    const createResult = yield* cloudfront.make("create_cache_policy", {
      CachePolicyConfig: {
        Name: API_CACHE_POLICY_NAME,
        Comment: "Effortless-AWS: Respects origin Cache-Control headers for API routes (DefaultTTL=0)",
        DefaultTTL: 0,
        MinTTL: 0,
        MaxTTL: 86400,
        ParametersInCacheKeyAndForwardedToOrigin: {
          EnableAcceptEncodingGzip: true,
          EnableAcceptEncodingBrotli: true,
          HeadersConfig: { HeaderBehavior: "none" },
          CookiesConfig: { CookieBehavior: "none" },
          QueryStringsConfig: { QueryStringBehavior: "all" },
        },
      },
    });

    const id = createResult.CachePolicy!.Id!;
    yield* Effect.logDebug(`Created API cache policy: ${id}`);
    return id;
  });
