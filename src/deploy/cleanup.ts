import { Effect } from "effect";
import {
  deleteLambda,
  deleteApi,
  deleteRole,
  deleteTable,
  deleteLayerVersion
} from "../aws";

export type ResourceInfo = {
  arn: string;
  type: string;
};

type LayerInfo = { name: string; version: number };

const extractResourceName = (arn: string, type: string): string => {
  switch (type) {
    case "lambda": {
      // arn:aws:lambda:region:account:function:name
      const parts = arn.split(":");
      return parts[parts.length - 1] ?? arn;
    }
    case "api-gateway": {
      // arn:aws:apigateway:region::/apis/apiId
      const match = arn.match(/\/apis\/([^/]+)/);
      return match?.[1] ?? arn;
    }
    case "iam-role": {
      // arn:aws:iam::account:role/name
      const parts = arn.split("/");
      return parts[parts.length - 1] ?? arn;
    }
    case "dynamodb": {
      // arn:aws:dynamodb:region:account:table/name
      const parts = arn.split("/");
      return parts[parts.length - 1] ?? arn;
    }
    case "lambda-layer": {
      // arn:aws:lambda:region:account:layer:name:version
      const parts = arn.split(":");
      return parts[parts.length - 2] ?? arn; // layer name (without version)
    }
    default:
      return arn;
  }
};

const extractLayerInfo = (arn: string): LayerInfo => {
  // arn:aws:lambda:region:account:layer:name:version
  const parts = arn.split(":");
  return {
    name: parts[parts.length - 2] ?? "",
    version: parseInt(parts[parts.length - 1] ?? "0", 10)
  };
};

export const deleteResource = (resource: ResourceInfo) =>
  Effect.gen(function* () {
    const name = extractResourceName(resource.arn, resource.type);

    switch (resource.type) {
      case "lambda":
        yield* deleteLambda(name);
        break;
      case "api-gateway":
        yield* deleteApi(name);
        break;
      case "iam-role":
        yield* deleteRole(name);
        break;
      case "dynamodb":
        yield* deleteTable(name);
        break;
      case "lambda-layer": {
        const layerInfo = extractLayerInfo(resource.arn);
        yield* deleteLayerVersion(layerInfo.name, layerInfo.version);
        break;
      }
      default:
        yield* Effect.logWarning(`Unknown resource type: ${resource.type}, skipping ${resource.arn}`);
    }
  });

export const deleteResources = (resources: ResourceInfo[]) =>
  Effect.gen(function* () {
    // Delete in order: lambda -> api-gateway -> dynamodb -> lambda-layer -> iam-role
    // IAM roles should be deleted last because they might be in use
    // Lambda layers should be deleted after lambdas that use them
    const orderedTypes = ["lambda", "api-gateway", "dynamodb", "lambda-layer", "iam-role"];

    // Collect IAM roles to delete (derived from Lambda names)
    const iamRolesToDelete = new Set<string>();

    for (const type of orderedTypes) {
      const resourcesOfType = resources.filter(r => r.type === type);
      for (const resource of resourcesOfType) {
        yield* deleteResource(resource).pipe(
          Effect.catchAll(error =>
            Effect.logError(`Failed to delete ${resource.type} ${resource.arn}: ${error}`)
          )
        );

        // Track IAM role to delete based on Lambda function name
        if (resource.type === "lambda") {
          const functionName = extractResourceName(resource.arn, "lambda");
          // {project}-{name} -> {project}-{name}-role
          const roleName = `${functionName}-role`;
          iamRolesToDelete.add(roleName);
        }
      }
    }

    // Delete derived IAM roles (not found by tagging API)
    for (const roleName of iamRolesToDelete) {
      yield* deleteRole(roleName).pipe(
        Effect.catchAll(error =>
          Effect.logError(`Failed to delete IAM role ${roleName}: ${error}`)
        )
      );
    }
  });
