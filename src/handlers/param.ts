// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyParamRef = ParamRef<any>;

/**
 * Reference to an SSM Parameter Store parameter.
 *
 * @typeParam T - The resolved type after optional transform (default: string)
 */
export type ParamRef<T = string> = {
  readonly __brand: "effortless-param";
  readonly key: string;
  readonly transform?: (raw: string) => T;
};

/**
 * Maps a params declaration to resolved value types.
 *
 * @typeParam P - Record of param names to ParamRef instances
 */
export type ResolveParams<P> = {
  [K in keyof P]: P[K] extends ParamRef<infer T> ? T : never;
};

/**
 * Declare an SSM Parameter Store parameter.
 *
 * The key is combined with project and stage at deploy time to form the full
 * SSM path: `/${project}/${stage}/${key}`.
 *
 * @param key - Parameter key (e.g., "database-url")
 * @param transform - Optional function to transform the raw string value
 * @returns A ParamRef used by the deployment and runtime systems
 *
 * @example Simple string parameter
 * ```typescript
 * params: {
 *   dbUrl: param("database-url"),
 * }
 * ```
 *
 * @example With transform (e.g., TOML parsing)
 * ```typescript
 * import TOML from "smol-toml";
 *
 * params: {
 *   config: param("app-config", TOML.parse),
 * }
 * ```
 */
export const param = <T = string>(
  key: string,
  transform?: (raw: string) => T
): ParamRef<T> => ({
  __brand: "effortless-param",
  key,
  ...(transform ? { transform } : {}),
});
