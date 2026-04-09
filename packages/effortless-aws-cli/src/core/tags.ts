export type ResourceType = "lambda" | "iam-role" | "dynamodb" | "api-gateway" | "lambda-layer" | "s3-bucket" | "cloudfront-distribution" | "sqs" | "ses" | "scheduler" | "ecs" | "logs";

export type TagContext = {
  project: string;
  stage: string;
  handler: string;
};

/**
 * Generate standard effortless tags for a resource.
 */
export const makeTags = (ctx: TagContext): Record<string, string> => ({
  "effortless:project": ctx.project,
  "effortless:stage": ctx.stage,
  "effortless:handler": ctx.handler,
});

/**
 * Detect resource type from an ARN.
 */
export const resourceTypeFromArn = (arn: string): ResourceType | undefined => {
  if (arn.startsWith("arn:aws:lambda:")) {
    if (arn.includes(":layer:")) return "lambda-layer";
    return "lambda";
  }
  if (arn.startsWith("arn:aws:iam:")) return "iam-role";
  if (arn.startsWith("arn:aws:dynamodb:")) return "dynamodb";
  if (arn.startsWith("arn:aws:apigateway:")) return "api-gateway";
  if (arn.startsWith("arn:aws:s3:")) return "s3-bucket";
  if (arn.startsWith("arn:aws:cloudfront:")) return "cloudfront-distribution";
  if (arn.startsWith("arn:aws:sqs:")) return "sqs";
  if (arn.startsWith("arn:aws:ses:")) return "ses";
  if (arn.startsWith("arn:aws:scheduler:")) return "scheduler";
  if (arn.startsWith("arn:aws:ecs:")) return "ecs";
  if (arn.startsWith("arn:aws:logs:")) return "logs";
  return undefined;
};

/**
 * Resolve stage from input, environment variable, or default.
 * Priority: input > EFFORTLESS_STAGE env > "dev"
 */
export const resolveStage = (input?: string): string =>
  input ?? process.env.EFFORTLESS_STAGE ?? "dev";
