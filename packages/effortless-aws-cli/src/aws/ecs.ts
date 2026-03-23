import { Effect } from "effect";
import { ecs, cloudwatch_logs } from "./clients";
/** ECS uses lowercase tag keys (key/value) unlike other AWS services (Key/Value) */
const toEcsTagList = (tags: Record<string, string>) =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

// ============ CloudWatch Log Group ============

export const ensureLogGroup = (name: string) =>
  Effect.gen(function* () {
    yield* cloudwatch_logs.make("create_log_group", {
      logGroupName: name,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof cloudwatch_logs.CloudWatchLogsError && error.cause.name === "ResourceAlreadyExistsException",
        () => Effect.succeed(undefined)
      )
    );
    yield* Effect.logDebug(`Log group ready: ${name}`);
    return name;
  });

// ============ Cluster ============

export const ensureCluster = (name: string, tags?: Record<string, string>) =>
  Effect.gen(function* () {
    // Check if cluster exists
    const existing = yield* ecs.make("describe_clusters", {
      clusters: [name],
    });

    const cluster = existing.clusters?.find(c => c.status === "ACTIVE");
    if (cluster) {
      yield* Effect.logDebug(`Using existing ECS cluster: ${name}`);
      return cluster.clusterArn!;
    }

    // Create Fargate cluster
    yield* Effect.logDebug(`Creating ECS cluster: ${name}`);
    const result = yield* ecs.make("create_cluster", {
      clusterName: name,
      capacityProviders: ["FARGATE"],
      defaultCapacityProviderStrategy: [{ capacityProvider: "FARGATE", weight: 1 }],
      ...(tags ? { tags: toEcsTagList(tags) } : {}),
    });

    return result.cluster!.clusterArn!;
  });

// ============ Task Definition ============

export type EnsureTaskDefinitionInput = {
  family: string;
  containerName: string;
  image: string;
  memory: number;
  cpu: number;
  environment: Record<string, string>;
  taskRoleArn: string;
  executionRoleArn: string;
  logGroup: string;
  region: string;
  tags?: Record<string, string>;
};

export const ensureTaskDefinition = (input: EnsureTaskDefinitionInput) =>
  Effect.gen(function* () {
    const {
      family, containerName, image, memory, cpu,
      environment, taskRoleArn, executionRoleArn,
      logGroup, region, tags,
    } = input;

    yield* Effect.logDebug(`Registering task definition: ${family}`);
    const result = yield* ecs.make("register_task_definition", {
      family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: String(cpu),
      memory: String(memory),
      taskRoleArn,
      executionRoleArn,
      containerDefinitions: [
        {
          name: containerName,
          image,
          essential: true,
          environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroup,
              "awslogs-region": region,
              "awslogs-stream-prefix": containerName,
            },
          },
        },
      ],
      ...(tags ? { tags: toEcsTagList(tags) } : {}),
    });

    return result.taskDefinition!.taskDefinitionArn!;
  });

// ============ Service ============

export type EnsureServiceInput = {
  cluster: string;
  serviceName: string;
  taskDefinitionArn: string;
  subnets: string[];
  securityGroups?: string[];
  assignPublicIp?: boolean;
  tags?: Record<string, string>;
};

export const ensureService = (input: EnsureServiceInput) =>
  Effect.gen(function* () {
    const {
      cluster, serviceName, taskDefinitionArn,
      subnets, securityGroups, assignPublicIp = true, tags,
    } = input;

    // Check if service exists
    const existing = yield* ecs.make("describe_services", {
      cluster,
      services: [serviceName],
    });

    const svc = existing.services?.find(s => s.status === "ACTIVE");

    if (svc) {
      yield* Effect.logDebug(`Updating ECS service: ${serviceName}`);
      yield* ecs.make("update_service", {
        cluster,
        service: serviceName,
        taskDefinition: taskDefinitionArn,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets,
            ...(securityGroups ? { securityGroups } : {}),
            assignPublicIp: assignPublicIp ? "ENABLED" : "DISABLED",
          },
        },
      });
      return svc.serviceArn!;
    }

    // Create service with desiredCount: 0 (starts idle)
    yield* Effect.logDebug(`Creating ECS service: ${serviceName}`);
    const result = yield* ecs.make("create_service", {
      cluster,
      serviceName,
      taskDefinition: taskDefinitionArn,
      desiredCount: 0,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          ...(securityGroups ? { securityGroups } : {}),
          assignPublicIp: assignPublicIp ? "ENABLED" : "DISABLED",
        },
      },
      ...(tags ? { tags: toEcsTagList(tags) } : {}),
    });

    return result.service!.serviceArn!;
  });

// ============ Delete functions ============

/**
 * Delete an ECS service (scales to 0 first, then deletes).
 */
export const deleteEcsService = (cluster: string, serviceName: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting ECS service: ${serviceName}`);

    // Scale to 0 before deleting
    yield* ecs.make("update_service", {
      cluster,
      service: serviceName,
      desiredCount: 0,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof ecs.ECSError && (
          error.cause.name === "ServiceNotFoundException" ||
          error.cause.name === "ClusterNotFoundException"
        ),
        () => Effect.succeed(undefined)
      )
    );

    yield* ecs.make("delete_service", {
      cluster,
      service: serviceName,
      force: true,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof ecs.ECSError && error.cause.name === "ServiceNotFoundException",
        () => Effect.succeed(undefined)
      )
    );
  });

/**
 * Delete an ECS cluster (must have no active services).
 */
export const deleteEcsCluster = (name: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting ECS cluster: ${name}`);
    yield* ecs.make("delete_cluster", {
      cluster: name,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof ecs.ECSError && error.cause.name === "ClusterNotFoundException",
        () => Effect.succeed(undefined)
      )
    );
  });

/**
 * Deregister all active revisions of a task definition family.
 */
export const deregisterTaskDefinitions = (family: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deregistering task definitions: ${family}`);
    const result = yield* ecs.make("list_task_definitions", {
      familyPrefix: family,
      status: "ACTIVE",
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof ecs.ECSError && error.cause.name === "ClientException",
        () => Effect.succeed({ taskDefinitionArns: [] })
      )
    );

    for (const arn of result.taskDefinitionArns ?? []) {
      yield* ecs.make("deregister_task_definition", {
        taskDefinition: arn,
      }).pipe(
        Effect.catchAll(() => Effect.succeed(undefined))
      );
    }
  });

/**
 * Delete a CloudWatch log group.
 */
export const deleteLogGroup = (name: string) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`Deleting log group: ${name}`);
    yield* cloudwatch_logs.make("delete_log_group", {
      logGroupName: name,
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof cloudwatch_logs.CloudWatchLogsError && error.cause.name === "ResourceNotFoundException",
        () => Effect.succeed(undefined)
      )
    );
  });
