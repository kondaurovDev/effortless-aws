import { Effect } from "effect";
import { apigatewayv2, lambda } from "./clients";

// Type from define-http (duplicated to avoid circular dependency)
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD" | "ANY";

export type ProjectApiConfig = {
  projectName: string;
  stage: string;
  region: string;
  tags?: Record<string, string>;
};

export type RouteConfig = {
  apiId: string;
  region: string;
  functionArn: string;
  method: HttpMethod;
  path: string;
};

export const ensureProjectApi = (config: ProjectApiConfig) =>
  Effect.gen(function* () {
    const apiName = `${config.projectName}-${config.stage}`;

    const existingApis = yield* apigatewayv2.make("get_apis", {});
    const existingApi = existingApis.Items?.find(api => api.Name === apiName);

    let apiId: string;

    if (existingApi) {
      yield* Effect.logInfo(`Using existing API Gateway: ${apiName}`);
      apiId = existingApi.ApiId!;

      if (config.tags) {
        const apiArn = `arn:aws:apigateway:${config.region}::/apis/${apiId}`;
        yield* apigatewayv2.make("tag_resource", {
          ResourceArn: apiArn,
          Tags: config.tags
        });
      }
    } else {
      yield* Effect.logInfo(`Creating API Gateway: ${apiName}`);

      const createResult = yield* apigatewayv2.make("create_api", {
        Name: apiName,
        ProtocolType: "HTTP",
        CorsConfiguration: {
          AllowOrigins: ["*"],
          AllowMethods: ["*"],
          AllowHeaders: ["*"]
        },
        Tags: config.tags
      });

      apiId = createResult.ApiId!;

      // Create default stage with auto-deploy
      yield* apigatewayv2.make("create_stage", {
        ApiId: apiId,
        StageName: "$default",
        AutoDeploy: true
      });
    }

    return { apiId };
  });

export const addRouteToApi = (config: RouteConfig) =>
  Effect.gen(function* () {
    const integrationUri = `arn:aws:apigateway:${config.region}:lambda:path/2015-03-31/functions/${config.functionArn}/invocations`;

    // Find or create integration
    const existingIntegrations = yield* apigatewayv2.make("get_integrations", { ApiId: config.apiId });
    let integrationId = existingIntegrations.Items?.find(
      i => i.IntegrationUri === integrationUri
    )?.IntegrationId;

    if (!integrationId) {
      yield* Effect.logDebug("Creating integration");

      const integrationResult = yield* apigatewayv2.make("create_integration", {
        ApiId: config.apiId,
        IntegrationType: "AWS_PROXY",
        IntegrationUri: integrationUri,
        IntegrationMethod: "POST",
        PayloadFormatVersion: "2.0"
      });

      integrationId = integrationResult.IntegrationId!;
    }

    // Find or create route
    const routeKey = `${config.method} ${config.path}`;
    const existingRoutes = yield* apigatewayv2.make("get_routes", { ApiId: config.apiId });
    const existingRoute = existingRoutes.Items?.find(r => r.RouteKey === routeKey);

    if (!existingRoute) {
      yield* Effect.logInfo(`Creating route: ${routeKey}`);

      yield* apigatewayv2.make("create_route", {
        ApiId: config.apiId,
        RouteKey: routeKey,
        Target: `integrations/${integrationId}`
      });
    } else {
      yield* Effect.logDebug(`Route already exists: ${routeKey}`);
    }

    // Add Lambda permission
    yield* addLambdaPermission(config.functionArn, config.apiId, config.region);

    const apiUrl = `https://${config.apiId}.execute-api.${config.region}.amazonaws.com${config.path}`;

    return { apiUrl };
  });

const addLambdaPermission = (
  functionArn: string,
  apiId: string,
  region: string
) =>
  Effect.gen(function* () {
    const statementId = `apigateway-${apiId}`;

    const accountId = functionArn.split(":")[4];
    const sourceArn = `arn:aws:execute-api:${region}:${accountId}:${apiId}/*/*`;

    yield* lambda.make("add_permission", {
      FunctionName: functionArn,
      StatementId: statementId,
      Action: "lambda:InvokeFunction",
      Principal: "apigateway.amazonaws.com",
      SourceArn: sourceArn
    }).pipe(
      Effect.catchIf(
        e => e._tag === "LambdaError" && e.is("ResourceConflictException"),
        () => {
          return Effect.logDebug("Permission already exists");
        }
      )
    );
  });

export const deleteApi = (apiId: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Deleting API Gateway: ${apiId}`);

    yield* apigatewayv2.make("delete_api", {
      ApiId: apiId
    }).pipe(
      Effect.catchIf(
        e => e._tag === "ApiGatewayV2Error" && e.is("NotFoundException"),
        () => Effect.logDebug(`API ${apiId} not found, skipping`)
      )
    );
  });
