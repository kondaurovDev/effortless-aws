# Package Boundaries and Type Hygiene

## The Two Packages

### `effortless-aws` (runtime library)

User-facing SDK. Provides `defineTable`, `defineApi`, `defineBucket`, etc. and runtime clients (`TableClient`, `BucketClient`, etc.).

**Boundary:** everything the user imports and writes code against. Handler definitions, typed callbacks, runtime clients, SSM param helpers.

### `@effortless-aws/cli` (CLI tool)

Build and deploy toolchain. Uses ts-morph to statically analyze user source code, extracts handler configs via AST, bundles Lambdas with esbuild, and deploys to AWS via Effect.

**Boundary:** reads handler source files at build time. Never imports handler code at runtime — only inspects it via AST. Communicates with handler objects through branded `__brand` fields and `__spec` static config.

## How They Work Together

```
User code (defineTable, defineApi, ...)
        |
        v
  effortless-aws          — provides types + runtime
        |
        v (AST analysis at build time)
  @effortless-aws/cli     — extracts config, bundles, deploys
```

The CLI reads the **static shape** of handler objects:
- `__brand` — determines handler type (table, api, bucket, etc.)
- `__spec` — static config (memory, timeout, basePath, etc.)
- `deps` keys — extracted from AST (ShorthandPropertyAssignment names)
- `config` entries — extracted from AST (`param("key")` call args)
- `static` globs — extracted from AST (string array elements)

The CLI does **not** need or use:
- Generic type parameters (D, P, S, ST, R)
- Callback function types
- Options types (DefineTableOptions, etc.)
- Internal utility types (ResolveDeps, ResolveConfig)

## Lesson: Unnecessary Generic Leakage

### Problem

Handler return types originally carried all generic parameters from the options:

```typescript
// Before: 6 generics on the return type
export type TableHandler<T, C, R, D, P, S> = { ... };
```

This caused:
1. **Circular type dependencies** — `D` references other handlers which reference other handlers
2. **Bloated public API** — internal types like `ResolveDeps<D>` had to be exported
3. **Fragile test types** — tests needed `TableHandler<any,any,any,any,any,any>`

### Root Cause

The generics `D` (deps), `P` (config), `S` (static), `R` (stream record), `ST` (stream boolean) exist purely for **type inference inside callbacks**. Once `defineTable()` returns, those generics serve no purpose — the handler object stores deps/config/callbacks as opaque values.

### Fix

Reduce handler return types to only externally-meaningful generics:

```typescript
// After: only generics that matter to consumers
export type TableHandler<T = Record<string, unknown>, C = undefined> = {
  readonly __brand: "effortless-table";
  readonly __spec: TableConfig;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  // ...
};
```

- `T` — needed for typed `QueueClient<T>` when used as a dep
- `C` — needed for setup context type (rarely used externally)
- Everything else — type-erased to `Record<string, unknown>` or `(...args: any[]) => any`

### Result

- `handler-deps.ts` simplified from `TableHandler<any,any,any,any,any,any>` to just `TableHandler`
- 15+ internal types removed from public API exports
- No circular type issues
- CLI works exactly the same (it never used these generics)

### Rule

> Only export types from `index.ts` that users need directly. Handler return types should only carry generics needed externally. Internal generics (D, P, S for deps/config/static) must stay local to the `define*` function.
