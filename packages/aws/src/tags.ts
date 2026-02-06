import { Effect } from "effect";
import type { ResourceTagMapping } from "@aws-sdk/client-resource-groups-tagging-api";
import * as tagging from "./clients/resource-groups-tagging-api";

export type ResourceType = "lambda" | "iam-role" | "dynamodb" | "api-gateway" | "lambda-layer";

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
    const result = yield* tagging.make("get_resources", {
      TagFilters: [
        { Key: "effortless:project", Values: [project] },
        { Key: "effortless:stage", Values: [stage] },
      ],
    });
    return result.ResourceTagMappingList ?? [];
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
