import type { ResolveConfig } from "./handler-options";
import type { ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";

/**
 * Common conditional args injected into handler callbacks.
 * Resolves ctx, deps, config, and files based on whether each generic is defined.
 * @internal
 */
export type HandlerArgs<
  C = undefined,
  D = undefined,
  P = undefined,
  S extends string[] | undefined = undefined
> =
  & ([C] extends [undefined] ? {} : { ctx: C })
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
  & ([S] extends [undefined] ? {} : { files: StaticFiles });
