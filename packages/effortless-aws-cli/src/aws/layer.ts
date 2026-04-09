import { Effect } from "effect";
import { Architecture, Runtime } from "@aws-sdk/client-lambda";
import { deferWarning } from "~/deploy/shared";
import { lambda, s3 } from "./clients";
import {
  checkDependencyWarnings,
  readProductionDependencies,
  computeLockfileHash,
  collectLayerPackages,
  createLayerZip,
} from "../build";

export type LayerConfig = {
  project: string;
  stage: string;
  region: string;
  projectDir: string;
  tags?: Record<string, string>;
};

export type LayerStatus = "created" | "cached";

export type LayerResult = {
  layerArn: string;
  layerVersionArn: string;
  version: number;
  lockfileHash: string;
  status: LayerStatus;
};

/**
 * Find existing layer version by hash in description
 */
export const getExistingLayerByHash = (layerName: string, expectedHash: string) =>
  Effect.gen(function* () {
    const versions = yield* lambda.make("list_layer_versions", {
      LayerName: layerName
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.succeed({ LayerVersions: [] })
      )
    );

    const matchingVersion = versions.LayerVersions?.find(v =>
      v.Description?.includes(`hash:${expectedHash}`)
    );

    if (!matchingVersion) {
      return null;
    }

    return {
      layerArn: matchingVersion.LayerVersionArn!,
      layerVersionArn: matchingVersion.LayerVersionArn!,
      version: matchingVersion.Version!,
      lockfileHash: expectedHash,
      status: "cached"
    } satisfies LayerResult;
  });

/**
 * Ensure layer exists with current dependencies.
 * Returns null if no production dependencies.
 */
export const ensureLayer = (config: LayerConfig) =>
  Effect.gen(function* () {
    // Warn about common dependency misplacements
    const depWarnings = yield* checkDependencyWarnings(config.projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );
    for (const w of depWarnings) {
      yield* deferWarning(`[layer] ${w}`);
    }

    const dependencies = yield* readProductionDependencies(config.projectDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as string[]))
    );

    if (dependencies.length === 0) {
      yield* Effect.logDebug("No production dependencies, skipping layer creation");
      return null;
    }

    const hash = yield* computeLockfileHash(config.projectDir).pipe(
      Effect.catchAll((e) => {
        const message = e instanceof Error ? e.message : String(e);
        return deferWarning(`Cannot compute lockfile hash: ${message}, skipping layer`).pipe(
          Effect.andThen(Effect.succeed(null))
        );
      })
    );

    if (!hash) {
      return null;
    }

    const layerName = `${config.project}-${config.stage}-deps`;

    // Check for existing layer with same hash
    const existing = yield* getExistingLayerByHash(layerName, hash);
    if (existing) {
      yield* Effect.logDebug(`Layer ${layerName} with hash ${hash} already exists (version ${existing.version})`);
      return existing;
    }

    // Collect all packages via transitive dep walking + completeness verification
    const { packages: allPackages, resolvedPaths, warnings: layerWarnings } = yield* Effect.sync(() => collectLayerPackages(config.projectDir, dependencies));

    // Surface all warnings so issues are visible, not silently swallowed
    for (const warning of layerWarnings) {
      yield* deferWarning(`[layer] ${warning}`);
    }

    yield* Effect.logDebug(`Creating layer ${layerName} with ${allPackages.length} packages (hash: ${hash})`);
    yield* Effect.logDebug(`Layer packages: ${allPackages.join(", ")}`);

    // Create layer zip
    const { buffer: layerZip, includedPackages, skippedPackages } = yield* createLayerZip(config.projectDir, allPackages, resolvedPaths);

    if (skippedPackages.length > 0) {
      yield* deferWarning(`Skipped ${skippedPackages.length} packages (not found): ${skippedPackages.slice(0, 10).join(", ")}${skippedPackages.length > 10 ? "..." : ""}`);
    }
    const zipSizeMB = layerZip.length / 1024 / 1024;
    yield* Effect.logDebug(`Layer zip size: ${zipSizeMB.toFixed(2)} MB (${includedPackages.length} packages)`);

    // Direct upload limit is ~67 MB; use S3 for larger ZIPs
    const MAX_DIRECT_UPLOAD = 50 * 1024 * 1024;

    let content: { ZipFile: Buffer } | { S3Bucket: string; S3Key: string };

    if (layerZip.length > MAX_DIRECT_UPLOAD) {
      const bucketName = `${config.project}-${config.stage}-deploy-artifacts`;
      const s3Key = `layers/${layerName}-${hash}.zip`;

      yield* Effect.logDebug(`Layer zip too large for direct upload (${zipSizeMB.toFixed(1)} MB), uploading to S3: s3://${bucketName}/${s3Key}`);

      // Ensure bucket exists
      const bucketExists = yield* s3.make("head_bucket", { Bucket: bucketName }).pipe(
        Effect.map(() => true),
        Effect.catchIf(e => e._tag === "S3Error", () => Effect.succeed(false))
      );

      if (!bucketExists) {
        yield* s3.make("create_bucket", {
          Bucket: bucketName,
          ...(config.region !== "us-east-1"
            ? { CreateBucketConfiguration: { LocationConstraint: config.region as any } }
            : {}),
        });
        yield* s3.make("put_public_access_block", {
          Bucket: bucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        });
      }

      yield* s3.make("put_object", {
        Bucket: bucketName,
        Key: s3Key,
        Body: layerZip,
      });

      content = { S3Bucket: bucketName, S3Key: s3Key };
    } else {
      content = { ZipFile: layerZip };
    }

    // Publish layer
    const result = yield* lambda.make("publish_layer_version", {
      LayerName: layerName,
      Description: `effortless deps layer hash:${hash}`,
      Content: content,
      CompatibleRuntimes: [Runtime.nodejs24x],
      CompatibleArchitectures: [Architecture.arm64]
    });

    yield* Effect.logDebug(`Published layer version ${result.Version}`);

    return {
      layerArn: result.LayerVersionArn!,
      layerVersionArn: result.LayerVersionArn!,
      version: result.Version!,
      lockfileHash: hash,
      status: "created"
    } satisfies LayerResult;
  });

/**
 * Delete a specific layer version
 */
export const deleteLayerVersion = (layerName: string, versionNumber: number) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting layer ${layerName} version ${versionNumber}`);

    yield* lambda.make("delete_layer_version", {
      LayerName: layerName,
      VersionNumber: versionNumber
    });
  });

export type LayerVersionInfo = {
  layerName: string;
  version: number;
  description: string | undefined;
  createdDate: string | undefined;
  arn: string;
};

/**
 * List all versions of a layer
 */
export const listLayerVersions = (layerName: string) =>
  Effect.gen(function* () {
    const result = yield* lambda.make("list_layer_versions", {
      LayerName: layerName
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceNotFoundException"),
        () => Effect.succeed({ LayerVersions: [] })
      )
    );

    return (result.LayerVersions ?? []).map(v => ({
      layerName,
      version: v.Version!,
      description: v.Description,
      createdDate: v.CreatedDate,
      arn: v.LayerVersionArn!
    } satisfies LayerVersionInfo));
  });

/**
 * Delete all versions of a layer
 */
export const deleteAllLayerVersions = (layerName: string) =>
  Effect.gen(function* () {
    const versions = yield* listLayerVersions(layerName);

    if (versions.length === 0) {
      yield* Effect.logDebug(`No versions found for layer ${layerName}`);
      return 0;
    }

    for (const v of versions) {
      yield* deleteLayerVersion(layerName, v.version);
    }

    return versions.length;
  });
