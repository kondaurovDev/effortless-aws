import { Effect } from "effect";
import type { ResourceTagMapping } from "@aws-sdk/client-resource-groups-tagging-api";
import { resource_groups_tagging_api as tagging } from "./clients";

export type ResourceType = "lambda" | "iam-role" | "dynamodb" | "api-gateway" | "lambda-layer" | "s3-bucket" | "cloudfront-distribution" | "sqs" | "ses";

export type TagContext = {
  project: string;
  stage: string;
  handler: string;
};

/**
 * Generate standard effortless tags for a resource.
 */
export const makeTags = (ctx: TagContext, type: ResourceType): Record<string, string> => ({
  "effortless:project": ctx.project,
  "effortless:stage": ctx.stage,
  "effortless:handler": ctx.handler,
  "effortless:type": type,
});

/**
 * Convert Record<string, string> to AWS tag list format: { Key, Value }[]
 */
export const toAwsTagList = (tags: Record<string, string>) =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/**
 * Resolve stage from input, environment variable, or default.
 * Priority: input > EFFORTLESS_STAGE env > "dev"
 */
export const resolveStage = (input?: string): string =>
  input ?? process.env.EFFORTLESS_STAGE ?? "dev";

/**
 * Query all resources for a project/stage using Resource Groups Tagging API.
 */
export const getResourcesByTags = (project: string, stage: string) =>
  Effect.gen(function* () {
    const all: ResourceTagMapping[] = [];
    let token: string | undefined;

    do {
      const result = yield* tagging.make("get_resources", {
        TagFilters: [
          { Key: "effortless:project", Values: [project] },
          { Key: "effortless:stage", Values: [stage] },
        ],
        ...(token ? { PaginationToken: token } : {}),
      });
      all.push(...(result.ResourceTagMappingList ?? []));
      token = result.PaginationToken;
    } while (token);

    return all;
  });

/**
 * Query all resources including global ones (CloudFront, IAM).
 * Makes a regional query via the injected client + a separate us-east-1 query for global resources.
 * Deduplicates by ARN.
 */
export const getAllResourcesByTags = (project: string, stage: string, region: string) =>
  Effect.gen(function* () {
    const tagFilters = [
      { Key: "effortless:project", Values: [project] },
      { Key: "effortless:stage", Values: [stage] },
    ];

    // Regional resources via injected client
    const regional = yield* getResourcesByTags(project, stage);

    // Skip global query if already in us-east-1
    if (region === "us-east-1") return regional;

    // Global resources (CloudFront, IAM) via us-east-1 layer
    const global: ResourceTagMapping[] = [];
    let globalToken: string | undefined;
    do {
      const globalResult = yield* tagging.make("get_resources", {
        TagFilters: tagFilters,
        ...(globalToken ? { PaginationToken: globalToken } : {}),
      }).pipe(
        Effect.provide(tagging.ResourceGroupsTaggingAPIClient.Default({ region: "us-east-1" })),
        Effect.catchAll(() => Effect.succeed({ ResourceTagMappingList: [] as ResourceTagMapping[], PaginationToken: undefined })),
      );
      global.push(...(globalResult.ResourceTagMappingList ?? []));
      globalToken = globalResult.PaginationToken;
    } while (globalToken);

    // Merge and deduplicate by ARN
    const seen = new Set(regional.map(r => r.ResourceARN));
    return [...regional, ...global.filter(r => !seen.has(r.ResourceARN))];
  });

/**
 * Find orphaned resources - resources in AWS that don't match any current handler.
 */
export const findOrphanedResources = (
  project: string,
  stage: string,
  currentHandlers: string[]
) =>
  Effect.gen(function* () {
    const resources = yield* getResourcesByTags(project, stage);
    return resources.filter(r => {
      const handlerTag = r.Tags?.find(t => t.Key === "effortless:handler");
      return handlerTag && !currentHandlers.includes(handlerTag.Value ?? "");
    });
  });

/**
 * Group resources by handler name.
 */
export const groupResourcesByHandler = (
  resources: ResourceTagMapping[]
) => {
  const grouped = new Map<string, ResourceTagMapping[]>();

  for (const resource of resources) {
    const handlerTag = resource.Tags?.find(t => t.Key === "effortless:handler");
    const handler = handlerTag?.Value ?? "unknown";

    if (!grouped.has(handler)) {
      grouped.set(handler, []);
    }
    grouped.get(handler)!.push(resource);
  }

  return grouped;
};
