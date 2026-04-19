/**
 * Unified handler type registry — single source of truth for all handler metadata.
 *
 * Every handler type (defineTable, defineApi, etc.) is described here.
 * Build, deploy, and CLI modules all import from this file.
 */

export const handlers = {
  table: {
    brand: "effortless-table",
    defineFn: "defineTable",
    handlerProps: ["onRecord", "onRecordBatch"] as const,
    wrapperFn: "wrapTableStream",
    wrapperPath: "~/runtime/wrap-table-stream",
  },
  app: {
    brand: "effortless-app",
    defineFn: "defineApp",
    handlerProps: [] as const,
    wrapperFn: "",
    wrapperPath: "",
  },
  staticSite: {
    brand: "effortless-static-site",
    defineFn: "defineStaticSite",
    handlerProps: ["middleware"] as const,
    wrapperFn: "wrapMiddleware",
    wrapperPath: "~/runtime/wrap-middleware",
  },
  queue: {
    brand: "effortless-queue",
    defineFn: "defineQueue",
    handlerProps: ["onMessage", "onMessageBatch"] as const,
    wrapperFn: "wrapQueue",
    wrapperPath: "~/runtime/wrap-queue",
  },
  bucket: {
    brand: "effortless-bucket",
    defineFn: "defineBucket",
    handlerProps: ["onObjectCreated", "onObjectRemoved"] as const,
    wrapperFn: "wrapBucket",
    wrapperPath: "~/runtime/wrap-bucket",
  },
  mailer: {
    brand: "effortless-mailer",
    defineFn: "defineMailer",
    handlerProps: [] as const,
    wrapperFn: "",
    wrapperPath: "",
  },
  cron: {
    brand: "effortless-cron",
    defineFn: "defineCron",
    handlerProps: ["onTick"] as const,
    wrapperFn: "wrapCron",
    wrapperPath: "~/runtime/wrap-cron",
  },
  api: {
    brand: "effortless-api",
    defineFn: "defineApi",
    handlerProps: ["routes"] as const,
    wrapperFn: "wrapApi",
    wrapperPath: "~/runtime/wrap-api",
  },
  worker: {
    brand: "effortless-worker",
    defineFn: "defineWorker",
    handlerProps: ["onMessage"] as const,
    wrapperFn: "wrapWorker",
    wrapperPath: "~/runtime/wrap-worker",
  },
  mcp: {
    brand: "effortless-mcp",
    defineFn: "defineMcp",
    handlerProps: ["tools", "resources", "prompts"] as const,
    wrapperFn: "wrapMcp",
    wrapperPath: "~/runtime/wrap-mcp",
  },
} as const;

export type HandlerType = keyof typeof handlers;

/** Map brand string → HandlerType (e.g., "effortless-api" → "api") */
export const brandToType = Object.fromEntries(
  Object.entries(handlers).map(([type, def]) => [def.brand, type]),
) as Record<string, HandlerType>;

/** Map define function name → HandlerType (e.g., "defineApi" → "api") */
export const defineFnToType = Object.fromEntries(
  Object.entries(handlers).map(([type, def]) => [def.defineFn, type]),
) as Record<string, HandlerType>;

/** Set of all define function names */
export const allDefineFns = new Set(Object.values(handlers).map(h => h.defineFn));
