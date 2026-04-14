/**
 * Dynamic import wrapper that prevents esbuild from converting
 * external package imports to static imports during bundling.
 *
 * esbuild sees `await import("@aws-sdk/client-dynamodb")` as a string literal
 * and hoists it to a static `import` at the top of the bundle.
 * Passing the path through a function parameter makes it opaque
 * to static analysis, keeping the import lazy at runtime.
 *
 * This lets handlers that don't use e.g. DynamoDB skip loading
 * `@aws-sdk/client-dynamodb` entirely — reducing cold start time.
 */
export const lazyImport = <T>(pkg: string): Promise<T> => import(pkg);
