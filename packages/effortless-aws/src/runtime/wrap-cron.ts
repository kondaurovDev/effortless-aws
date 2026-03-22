import type { CronHandler } from "../handlers/define-cron";
import { createHandlerRuntime } from "./handler-utils";

export const wrapCron = <C>(handler: CronHandler<C>) => {
  if (!handler.onTick) {
    throw new Error("wrapCron requires a handler with onTick defined");
  }

  const rt = createHandlerRuntime(handler, "cron", handler.__spec.lambda?.logLevel ?? "info");
  const handleError = handler.onError ?? (({ error }: { error: unknown }) => console.error(`[effortless:${rt.handlerName}]`, error));

  return async () => {
    const startTime = Date.now();
    rt.patchConsole();
    let ctxProps: Record<string, unknown> = {};

    try {
      const common = await rt.commonArgs();
      const ctx = common.ctx;
      ctxProps = ctx && typeof ctx === "object" ? { ...ctx as Record<string, unknown> } : {};

      await (handler.onTick as any)({ ...ctxProps });

      rt.logExecution(startTime, { trigger: "schedule" }, {});
    } catch (error) {
      await handleError({ error, ...ctxProps });
      rt.logError(startTime, { trigger: "schedule" }, error);
      throw error;
    } finally {
      if (handler.onCleanup) {
        try { await handler.onCleanup(ctxProps); }
        catch (e) { console.error(`[effortless:${rt.handlerName}] onCleanup error`, e); }
      }
      rt.restoreConsole();
    }
  };
};
