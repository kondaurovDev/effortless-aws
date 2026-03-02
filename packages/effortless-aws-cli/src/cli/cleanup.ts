import { Effect, Console } from "effect";
import { Aws, type ResourceTagMapping } from "../aws";

const { lambda, iam, dynamodb, apigatewayv2 } = Aws;

type ResourceType = "lambda" | "iam-role" | "dynamodb" | "api-gateway";

const extractResourceType = (resource: ResourceTagMapping): ResourceType | null => {
  const typeTag = resource.Tags?.find(t => t.Key === "effortless:type");
  const type = typeTag?.Value;
  if (type === "lambda" || type === "iam-role" || type === "dynamodb" || type === "api-gateway") {
    return type;
  }
  return null;
};

const extractResourceName = (arn: string, type: ResourceType): string | null => {
  // Parse ARN to get resource name
  // arn:aws:lambda:region:account:function:name
  // arn:aws:iam::account:role/name
  // arn:aws:dynamodb:region:account:table/name
  // arn:aws:apigateway:region::/apis/id

  const parts = arn.split(":");

  switch (type) {
    case "lambda": {
      // arn:aws:lambda:region:account:function:function-name
      return parts[6] ?? null;
    }
    case "iam-role": {
      // arn:aws:iam::account:role/role-name
      const roleSection = parts[5];
      return roleSection?.replace("role/", "") ?? null;
    }
    case "dynamodb": {
      // arn:aws:dynamodb:region:account:table/table-name
      const tableSection = parts[5];
      return tableSection?.replace("table/", "") ?? null;
    }
    case "api-gateway": {
      // arn:aws:apigateway:region::/apis/api-id
      const apiSection = parts[5];
      return apiSection?.replace("/apis/", "") ?? null;
    }
  }
};

const deleteLambdaFunction = (functionName: string) =>
  Effect.gen(function* () {
    yield* Console.log(`  Deleting Lambda function: ${functionName}`);
    yield* lambda.make("delete_function", { FunctionName: functionName });
  }).pipe(
    Effect.catchAll(error => Console.error(`  Failed to delete Lambda: ${error}`))
  );

const deleteIamRole = (roleName: string) =>
  Effect.gen(function* () {
    yield* Console.log(`  Deleting IAM role: ${roleName}`);

    // First, list and detach all managed policies
    const attachedPolicies = yield* iam.make("list_attached_role_policies", { RoleName: roleName });
    for (const policy of attachedPolicies.AttachedPolicies ?? []) {
      yield* iam.make("detach_role_policy", {
        RoleName: roleName,
        PolicyArn: policy.PolicyArn!,
      });
    }

    // List and delete all inline policies
    const inlinePolicies = yield* iam.make("list_role_policies", { RoleName: roleName });
    for (const policyName of inlinePolicies.PolicyNames ?? []) {
      yield* iam.make("delete_role_policy", {
        RoleName: roleName,
        PolicyName: policyName,
      });
    }

    // Delete the role
    yield* iam.make("delete_role", { RoleName: roleName });
  }).pipe(
    Effect.catchAll(error => Console.error(`  Failed to delete IAM role: ${error}`))
  );

const deleteDynamoDBTable = (tableName: string) =>
  Effect.gen(function* () {
    yield* Console.log(`  Deleting DynamoDB table: ${tableName}`);
    yield* dynamodb.make("delete_table", { TableName: tableName });
  }).pipe(
    Effect.catchAll(error => Console.error(`  Failed to delete DynamoDB table: ${error}`))
  );

const deleteApiGateway = (apiId: string) =>
  Effect.gen(function* () {
    yield* Console.log(`  Deleting API Gateway: ${apiId}`);
    yield* apigatewayv2.make("delete_api", { ApiId: apiId });
  }).pipe(
    Effect.catchAll(error => Console.error(`  Failed to delete API Gateway: ${error}`))
  );

export const deleteResource = (resource: ResourceTagMapping) =>
  Effect.gen(function* () {
    const arn = resource.ResourceARN;
    if (!arn) return;

    const type = extractResourceType(resource);
    if (!type) {
      yield* Console.log(`  Skipping unknown resource type: ${arn}`);
      return;
    }

    const name = extractResourceName(arn, type);
    if (!name) {
      yield* Console.log(`  Could not extract name from: ${arn}`);
      return;
    }

    switch (type) {
      case "lambda":
        yield* deleteLambdaFunction(name);
        break;
      case "iam-role":
        yield* deleteIamRole(name);
        break;
      case "dynamodb":
        yield* deleteDynamoDBTable(name);
        break;
      case "api-gateway":
        yield* deleteApiGateway(name);
        break;
    }
  });

export const deleteResources = (resources: ResourceTagMapping[]) =>
  Effect.gen(function* () {
    // Delete in order: Lambda first (has dependencies), then API Gateway, then DynamoDB, then IAM roles
    const lambdas = resources.filter(r => extractResourceType(r) === "lambda");
    const apis = resources.filter(r => extractResourceType(r) === "api-gateway");
    const tables = resources.filter(r => extractResourceType(r) === "dynamodb");
    const roles = resources.filter(r => extractResourceType(r) === "iam-role");

    for (const resource of lambdas) {
      yield* deleteResource(resource);
    }

    for (const resource of apis) {
      yield* deleteResource(resource);
    }

    for (const resource of tables) {
      yield* deleteResource(resource);
    }

    for (const resource of roles) {
      yield* deleteResource(resource);
    }
  });
