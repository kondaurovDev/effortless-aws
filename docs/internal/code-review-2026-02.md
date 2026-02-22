# Code Review — February 2026

Review of the effortless-aws codebase: quality, clarity, reliability, complexity.

---

## Architecture verdict

Architecture is **clear**. The layered pipeline is easy to follow:

```
define (handlers/) → extract (build/) → bundle (build/) → deploy (deploy/) → wrap (runtime/)
```

Each handler type follows the same pipeline. New types (e.g. bucket) slot in predictably.
The one aspect that takes time to grok is the generic machinery (`T, C, R, D, P, S`),
but it's justified by the DX it provides to end users.

---

## Issues found

### 1. `new Function()` without error handling — High

**File:** `src/build/handler-registry.ts:229`

```ts
const configObj = new Function(`return ${configText}`)() as T;
```

Evals arbitrary text from user source files at build time. Problems:
- Silently fails on computed values, template literals, imported constants
- Throws cryptic `SyntaxError` with no context
- Linters and security scanners flag `new Function()`

**Improvement:**

```ts
const evalConfig = <T>(configText: string, exportName: string): T => {
  try {
    return new Function(`return ${configText}`)() as T;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to extract config for "${exportName}": ${msg}.\n` +
      `Handler config must use only literal values (no variables, imports, or expressions).`
    );
  }
};
```

**Effect:** Turns a cryptic runtime crash into a clear actionable error message.
One change, one file, zero risk.

---

### 2. `SetupFactory` has two different patterns — High (DX)

**HTTP / FIFO Queue** — conditional:
```ts
type SetupFactory<C, D, P> = [D | P] extends [undefined]
  ? () => C | Promise<C>
  : (args: { deps?, config? }) => C | Promise<C>;
```

**Table / Bucket** — always receives args (because of self-client):
```ts
type SetupFactory<C, T, D, P> = (args:
  & { table: TableClient<T> }
  & ...
) => C | Promise<C>;
```

This is correct (table/bucket always pass a self-client), but the inconsistency
means adding `deps` to an HTTP handler changes the setup signature from
`() => ...` to `({ deps }) => ...`.

**Improvement:** Unify to always-args pattern. HTTP/FIFO setup always receives
an args object (possibly empty). This removes the conditional type and makes
all handlers behave the same:

```ts
// All handler types:
type SetupFactory<C, D, P> =
  (args:
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  ) => C | Promise<C>;
```

User code `setup: () => ({ db })` still works (TS allows unused args object).
User code `setup: ({ deps }) => ...` works the same.

**Effect:** Eliminates a conditional type, makes all handlers consistent,
no breaking change (existing `() => ...` signatures still compile).

---

### 3. Duplicated `buildTableNameMap` / `buildBucketNameMap` — Medium

**File:** `src/deploy/deploy.ts:189-221`

Two identical functions except for the type parameter:

```ts
const buildTableNameMap = (tableHandlers, project, stage) => { ... };
const buildBucketNameMap = (bucketHandlers, project, stage) => { ... };
```

**Improvement:** Extract a generic:

```ts
const buildResourceNameMap = (
  handlers: { exports: { exportName: string; config: { name?: string } }[] }[],
  project: string,
  stage: string,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const { exports } of handlers) {
    for (const fn of exports) {
      map.set(fn.exportName, `${project}-${stage}-${fn.config.name ?? fn.exportName}`);
    }
  }
  return map;
};
```

Usage:
```ts
const tableNameMap = buildResourceNameMap(tableHandlers, project, stage);
const bucketNameMap = buildResourceNameMap(bucketHandlers, project, stage);
```

**Effect:** -20 lines, one function instead of two, easier to add new resource types.

---

### 4. Duplicated task builders in `deploy.ts` — Medium

`buildHttpTasks`, `buildTableTasks`, `buildFifoQueueTasks`, `buildBucketTasks`,
`buildStaticSiteTasks`, `buildAppTasks` — 6 functions with near-identical structure:

```
for files → for exports → resolve env → call deploy fn → push result → log
```

~30 lines each = ~180 lines of boilerplate.

**Improvement:** Generic task builder:

```ts
type TaskConfig<TFn, TResult> = {
  handlers: { file: string; exports: TFn[] }[];
  results: TResult[];
  deploy: (fn: TFn, input: DeployInput, env: ResolvedEnv) => Effect.Effect<TResult & { status: string }, unknown>;
  typeName: string;
  awsClients: (region: string) => Layer;
};

const buildGenericTasks = <TFn extends { exportName: string; config: { name?: string }; depsKeys: string[]; paramEntries: ParamEntry[]; staticGlobs: string[] }, TResult>(
  ctx: DeployTaskCtx,
  config: TaskConfig<TFn, TResult>,
): Effect.Effect<void, unknown>[] => {
  const tasks: Effect.Effect<void, unknown>[] = [];
  for (const { file, exports } of config.handlers) {
    for (const fn of exports) {
      tasks.push(
        Effect.gen(function* () {
          const env = resolveHandlerEnv(fn.depsKeys, fn.paramEntries, ctx);
          const result = yield* config.deploy(fn, makeDeployInput(ctx, file), env)
            .pipe(Effect.provide(config.awsClients(ctx.input.region)));
          config.results.push(result);
          yield* ctx.logComplete(fn.config.name ?? fn.exportName, config.typeName, result.status);
        })
      );
    }
  }
  return tasks;
};
```

**Caveat:** HTTP and App tasks need extra steps (API Gateway route creation),
so they can't fully use the generic. Still, table/bucket/queue/staticSite can,
cutting ~100 lines.

**Effect:** -100 lines, consistent behavior, one place to add cross-cutting
concerns (metrics, retry, etc.). Tradeoff: slightly more abstract code.

---

### 5. `resolveStage()` called repeatedly before being stored — Medium

**File:** `src/deploy/deploy.ts`

`resolveStage(input.stage)` is called ~10 times. It's assigned to `const stage`
on line 617, but several earlier calls (lines 585, 601, 602, 608) happen before
that assignment.

**Improvement:** Move `const stage = resolveStage(input.stage)` to the top
of `deployProject`, use it everywhere.

**Effect:** Removes 9 redundant function calls. Prevents bugs if `resolveStage`
ever becomes non-idempotent.

---

### 6. `BucketObjectCreatedFn` and `BucketObjectRemovedFn` are identical — Low

**File:** `src/handlers/define-bucket.ts:36-53`

Both types have the exact same shape. Only the name differs.

**Improvement:** One type:

```ts
export type BucketEventFn<C, D, P, S extends string[] | undefined> =
  (args: { event: BucketEvent; bucket: BucketClient }
    & ([C] extends [undefined] ? {} : { ctx: C })
    & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
    & ([P] extends [undefined] ? {} : { config: ResolveConfig<P> })
    & ([S] extends [undefined] ? {} : { readStatic: (path: string) => string })
  ) => Promise<void>;
```

Usage: `onObjectCreated?: BucketEventFn<C, D, P, S>`.

**Effect:** -15 lines, one less type to maintain. If the signatures ever diverge,
split them back.

---

### 7. Console `warn` saved but never restored — Low

**File:** `src/runtime/handler-utils.ts:184-195`

```ts
const saved = { log: ..., info: ..., debug: ..., warn: ..., error: ... };
// restoreConsole does not restore warn
```

`warn` is captured in `saved` but `patchConsole` never suppresses it and
`restoreConsole` never restores it.

**Improvement:** Either remove `warn` from `saved`, or add `console.warn = saved.warn`
to `restoreConsole`. The first option is simpler — if warn is never patched,
don't save it.

**Effect:** Removes dead code, prevents confusion.

---

### 8. `wrap-bucket.ts` doesn't explain why there are no batch failures — Low

S3 event notifications don't support partial batch failure reporting
(unlike DynamoDB Streams / SQS). The code is correct, but a reader familiar
with the table/queue wrappers will wonder why bucket doesn't return
`{ batchItemFailures }`.

**Improvement:** Add a one-line comment:

```ts
// S3 event notifications are fire-and-forget — no partial batch failure support
```

**Effect:** Saves future developers 5 minutes of investigation.

---

### 9. Handler counting in `deployProject` is verbose — Low

**File:** `src/deploy/deploy.ts:562-580`

14 lines of `reduce` calls + string building.

**Improvement:**

```ts
const handlerTypes = [
  { handlers: httpHandlers, label: "http" },
  { handlers: tableHandlers, label: "table" },
  { handlers: appHandlers, label: "app" },
  { handlers: staticSiteHandlers, label: "site" },
  { handlers: fifoQueueHandlers, label: "queue" },
  { handlers: bucketHandlers, label: "bucket" },
] as const;

const counts = handlerTypes
  .map(({ handlers, label }) => {
    const n = handlers.reduce((acc, h) => acc + h.exports.length, 0);
    return n > 0 ? `${n} ${label}` : null;
  })
  .filter(Boolean);
const totalAllHandlers = handlerTypes.reduce(
  (acc, { handlers }) => acc + handlers.reduce((a, h) => a + h.exports.length, 0), 0
);
```

**Effect:** -10 lines, easier to add new handler types without touching 5 places.

---

### 10. Manifest building is the same pattern repeated 6 times — Low

**File:** `src/deploy/deploy.ts:651-663`

**Improvement:**

```ts
const manifest: HandlerManifest = handlerTypes.flatMap(({ handlers, label }) =>
  handlers.flatMap(({ exports }) =>
    exports.map(fn => ({ name: fn.config.name ?? fn.exportName, type: label }))
  )
);
```

**Effect:** -10 lines, same data, declarative.

---

## Summary

| # | Issue | Criticality | Effort | Effect |
|---|---|---|---|---|
| 1 | `new Function()` without error handling | High | 15 min | Reliable build errors |
| 2 | `SetupFactory` inconsistency | High | 1 hr | Consistent DX across all handlers |
| 3 | Duplicated name map builders | Medium | 15 min | -20 lines |
| 4 | Duplicated task builders | Medium | 2 hr | -100 lines, single extension point |
| 5 | `resolveStage()` called 10 times | Medium | 5 min | Correctness safeguard |
| 6 | Identical bucket event fn types | Low | 10 min | -15 lines |
| 7 | `warn` saved but not restored | Low | 2 min | Remove dead code |
| 8 | Missing batch failure comment | Low | 1 min | Clarity for future readers |
| 9 | Verbose handler counting | Low | 15 min | -10 lines, extensible |
| 10 | Verbose manifest building | Low | 10 min | -10 lines |

### Recommended order of execution

**Phase 1 — Quick wins (reliability, ~30 min):**
1, 5, 7, 8

**Phase 2 — DX consistency (~1 hr):**
2, 6

**Phase 3 — Reduce complexity (~2.5 hr):**
3, 4, 9, 10

Total estimated: ~4 hours for all improvements.
Net effect: ~175 fewer lines, clearer errors, consistent DX, one extension point for new handler types.

---

## What's already good

- Branded types prevent handler mix-ups at compile time
- Conditional intersection types for callback args — no phantom `undefined` args
- Lazy init (`??=`) across all runtime wrappers — great for cold starts
- `createHandlerRuntime()` eliminates duplication across 5 wrappers
- `RUNTIME_PROPS` cleanly separates static config from runtime callbacks
- Effect.js for deploy orchestration — concurrent deploys, composable errors
- Deterministic ZIPs with `FIXED_DATE`
- `helpers.ts` has zero heavy imports — protects public API bundle size
- `typed()` solves partial generic inference elegantly
- `DEP_FACTORIES` registry — adding a new dep type is one line
- Progress UI with TTY detection and ANSI cursor manipulation is polished
