import { Effect } from "effect";
import { scheduler } from "./clients";

export type EnsureScheduleInput = {
  /** Schedule name (deterministic: project-stage-handler) */
  name: string;
  /** EventBridge Scheduler expression: rate(...) or cron(...) */
  schedule: string;
  /** Lambda function ARN to invoke */
  targetArn: string;
  /** IAM role ARN for the scheduler to assume */
  roleArn: string;
  /** IANA timezone (default: UTC) */
  timezone?: string;
  /** Tags for the schedule */
  tags?: Record<string, string>;
};

export type EnsureScheduleResult = {
  scheduleArn: string;
};

/**
 * Create or update an EventBridge Scheduler schedule that invokes a Lambda function.
 */
export const ensureSchedule = (input: EnsureScheduleInput) =>
  Effect.gen(function* () {
    const { name, schedule, targetArn, roleArn, timezone, tags } = input;

    // Check if schedule exists
    const existing = yield* scheduler.make("get_schedule", {
      Name: name,
    }).pipe(
      Effect.map(result => result.Arn),
      Effect.catchIf(
        (error) => error instanceof scheduler.SchedulerError && error.cause.name === "ResourceNotFoundException",
        () => Effect.succeed(undefined)
      )
    );

    if (existing) {
      yield* Effect.logDebug(`Updating schedule ${name}...`);
      const result = yield* scheduler.make("update_schedule", {
        Name: name,
        ScheduleExpression: schedule,
        ...(timezone ? { ScheduleExpressionTimezone: timezone } : {}),
        Target: {
          Arn: targetArn,
          RoleArn: roleArn,
        },
        FlexibleTimeWindow: { Mode: "OFF" },
        State: "ENABLED",
      });
      return { scheduleArn: result.ScheduleArn! };
    }

    yield* Effect.logDebug(`Creating schedule ${name}...`);
    const result = yield* scheduler.make("create_schedule", {
      Name: name,
      ScheduleExpression: schedule,
      ...(timezone ? { ScheduleExpressionTimezone: timezone } : {}),
      Target: {
        Arn: targetArn,
        RoleArn: roleArn,
      },
      FlexibleTimeWindow: { Mode: "OFF" },
      State: "ENABLED",
      ...(tags ? { Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } : {}),
    });

    return { scheduleArn: result.ScheduleArn! };
  });

