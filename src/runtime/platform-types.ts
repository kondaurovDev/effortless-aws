export const ENV_PLATFORM_TABLE = "EFF_PLATFORM_TABLE";

export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ============ Base ============

export type BasePlatformEntity = {
  pk: string;
  sk: string;
  type: string;
  ttl?: number;
};

// ============ Execution Log ============

export type ExecutionEntry = {
  id: string;
  ts: string;
  ms: number;
  in: unknown;
  out?: unknown;
};

export type ErrorEntry = {
  id: string;
  ts: string;
  ms: number;
  in: unknown;
  err: string;
};

export type ExecutionLogEntity = BasePlatformEntity & {
  type: "execution-log";
  handlerName: string;
  handlerType: "http" | "table";
  executions: ExecutionEntry[];
  errors: ErrorEntry[];
};

// ============ Discriminated Union ============

export type PlatformEntity =
  | ExecutionLogEntity;
  // future: | IdempotencyEntity | HandlerMetaEntity

// ============ Helpers ============

export const truncateForStorage = (value: unknown, maxLength = 4096): unknown => {
  if (value === undefined || value === null) return value;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxLength) return value;
  return str.slice(0, maxLength) + "...[truncated]";
};

export const dateBucket = (date = new Date()): string =>
  date.toISOString().slice(0, 10);

export const computeTtl = (ttlSeconds = DEFAULT_TTL_SECONDS): number =>
  Math.floor(Date.now() / 1000) + ttlSeconds;
