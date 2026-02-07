import * as Config from "effect/Config"

const functionEnvironmentVariables = [
  "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR",
  "AWS_EXECUTION_ENV"
] as const;

type FunctionEnvName =
  typeof functionEnvironmentVariables[number];

export const functionEnvironmentVariable =
  (name: FunctionEnvName) =>
    Config.nonEmptyString(name)
