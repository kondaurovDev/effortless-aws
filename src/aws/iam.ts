import { Effect } from "effect";
import { iam } from "./clients";
import { toAwsTagList } from "./tags";

const LAMBDA_ASSUME_ROLE_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        Service: "lambda.amazonaws.com"
      },
      Action: "sts:AssumeRole"
    }
  ]
});

const BASIC_EXECUTION_POLICY_ARN = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";

export const ensureRole = (
  project: string,
  stage: string,
  name: string,
  additionalActions?: string[],
  tags?: Record<string, string>
) =>
  Effect.gen(function* () {
    const roleName = `${project}-${stage}-${name}-role`;

    const existingRole = yield* iam.make("get_role", { RoleName: roleName }).pipe(
      Effect.map(r => r.Role),
      Effect.catchIf(
        e => e._tag === "IAMError" && e.is("NoSuchEntityException"),
        () => Effect.succeed(undefined)
      )
    );

    if (existingRole) {
      yield* Effect.logInfo(`Using existing role: ${roleName}`);

      if (additionalActions && additionalActions.length > 0) {
        yield* ensureInlinePolicy(roleName, name, additionalActions);
      }

      // Sync tags on existing role
      if (tags) {
        yield* iam.make("tag_role", {
          RoleName: roleName,
          Tags: toAwsTagList(tags)
        });
      }

      return existingRole.Arn!;
    }

    yield* Effect.logInfo(`Creating role: ${roleName}`);

    const createResult = yield* iam.make("create_role", {
      RoleName: roleName,
      AssumeRolePolicyDocument: LAMBDA_ASSUME_ROLE_POLICY,
      Description: `Execution role for Lambda function ${name}`,
      Tags: tags ? toAwsTagList(tags) : undefined
    });

    yield* iam.make("attach_role_policy", {
      RoleName: roleName,
      PolicyArn: BASIC_EXECUTION_POLICY_ARN
    });

    if (additionalActions && additionalActions.length > 0) {
      yield* ensureInlinePolicy(roleName, name, additionalActions);
    }

    yield* Effect.sleep("10 seconds");

    return createResult.Role!.Arn!;
  });

const ensureInlinePolicy = (roleName: string, functionName: string, actions: string[]) =>
  Effect.gen(function* () {
    const policyName = `${functionName}-inline-policy`;
    const policyDocument = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: actions,
          Resource: "*"
        }
      ]
    });

    yield* iam.make("put_role_policy", {
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: policyDocument
    });
  });

export const deleteRole = (roleName: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Deleting IAM role: ${roleName}`);

    // Delete inline policies
    const inlinePolicies = yield* iam.make("list_role_policies", { RoleName: roleName }).pipe(
      Effect.map(r => r.PolicyNames ?? []),
      Effect.catchIf(
        e => e._tag === "IAMError" && e.is("NoSuchEntityException"),
        () => Effect.succeed([] as string[])
      )
    );

    for (const policyName of inlinePolicies) {
      yield* iam.make("delete_role_policy", {
        RoleName: roleName,
        PolicyName: policyName
      });
    }

    // Detach managed policies
    const attachedPolicies = yield* iam.make("list_attached_role_policies", { RoleName: roleName }).pipe(
      Effect.map(r => r.AttachedPolicies ?? []),
      Effect.catchIf(
        e => e._tag === "IAMError" && e.is("NoSuchEntityException"),
        () => Effect.succeed([] as Array<{ PolicyArn?: string }>)
      )
    );

    for (const policy of attachedPolicies) {
      if (policy.PolicyArn) {
        yield* iam.make("detach_role_policy", {
          RoleName: roleName,
          PolicyArn: policy.PolicyArn
        });
      }
    }

    // Delete the role
    yield* iam.make("delete_role", { RoleName: roleName }).pipe(
      Effect.catchIf(
        e => e._tag === "IAMError" && e.is("NoSuchEntityException"),
        () => Effect.logDebug(`Role ${roleName} not found, skipping`)
      )
    );
  });

export type EffortlessRole = {
  name: string;
  arn: string;
  project?: string;
  stage?: string;
  handler?: string;
};

export const listEffortlessRoles = () =>
  Effect.gen(function* () {
    const roles: EffortlessRole[] = [];
    let marker: string | undefined;

    do {
      const result = yield* iam.make("list_roles", {
        PathPrefix: "/",
        Marker: marker,
        MaxItems: 100
      });

      for (const role of result.Roles ?? []) {
        if (role.RoleName?.endsWith("-role")) {
          // Get tags to find project/stage/handler
          const tagsResult = yield* iam.make("list_role_tags", { RoleName: role.RoleName }).pipe(
            Effect.catchAll(() => Effect.succeed({ Tags: [] }))
          );

          const tags = tagsResult.Tags ?? [];
          const roleInfo: EffortlessRole = {
            name: role.RoleName,
            arn: role.Arn!,
          };
          const project = tags.find(t => t.Key === "effortless:project")?.Value;
          const stage = tags.find(t => t.Key === "effortless:stage")?.Value;
          const handler = tags.find(t => t.Key === "effortless:handler")?.Value;
          if (project) roleInfo.project = project;
          if (stage) roleInfo.stage = stage;
          if (handler) roleInfo.handler = handler;
          roles.push(roleInfo);
        }
      }

      marker = result.Marker;
    } while (marker);

    return roles;
  });
