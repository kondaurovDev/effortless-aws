import { Effect, Layer, Logger, LogLevel } from "effect";

const capitalizeFirst = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const parseLogLevel = (envLevel: string | undefined): LogLevel.LogLevel => {
  if (!envLevel) return LogLevel.Info;

  const normalized = capitalizeFirst(envLevel) as LogLevel.Literal;
  const level = LogLevel.fromLiteral(normalized);

  return level ?? LogLevel.Info;
};

export const LogLevelConfigFromEnv: Layer.Layer<never> =
  Layer.unwrapEffect(
    Effect.sync(() => {
      const level = parseLogLevel(process.env.LOG_LEVEL);
      return Logger.minimumLogLevel(level);
    })
  );
