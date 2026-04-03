import type { AnySecretRef, ResolveConfig, LambdaWithPermissions, ConfigFactory, LambdaOptions } from "./handler-options";
import { resolveConfigFactory } from "./handler-options";
import type { AnyDepHandler, ResolveDeps } from "./handler-deps";
import type { StaticFiles } from "./shared";

// ============ Static config ============

/** Static config extracted at deploy time */
export type McpConfig = {
  /** MCP server name (used in server info) */
  name: string;
  /** MCP server version (default: "1.0.0") */
  version?: string;
  /** Human-readable description — sent to clients in initialize response as system prompt context */
  instructions?: string;
  /** Lambda function settings (memory, timeout, permissions, etc.) */
  lambda?: LambdaWithPermissions;
};

// ============ MCP tool types ============

/** JSON Schema for a tool's input parameters */
export type McpInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

/** Content block returned by a tool handler */
export type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } };

/** Result returned by a tool handler */
export type McpToolResult = {
  content: McpToolContent[];
  isError?: boolean;
};

// ============ MCP resource types ============

/** Content returned when reading a resource */
export type McpResourceContent =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

/** A static resource definition */
export type McpResourceDef<C = undefined> = {
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional MIME type */
  mimeType?: string;
  /** Handler called on resources/read */
  handler: (ctx: SpreadCtx<C>) => McpResourceContent | McpResourceContent[] | Promise<McpResourceContent | McpResourceContent[]>;
};

/** A parameterized resource template (URI template RFC 6570) */
export type McpResourceTemplateDef<C = undefined> = {
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional MIME type */
  mimeType?: string;
  /** Handler called on resources/read — receives matched URI params */
  handler: (params: Record<string, string>, ctx: SpreadCtx<C>) => McpResourceContent | McpResourceContent[] | Promise<McpResourceContent | McpResourceContent[]>;
};

/** Map of uri → resource definition, or uriTemplate → template definition */
export type McpResourceMap<C = undefined> = {
  [uriOrTemplate: string]: McpResourceDef<C> | McpResourceTemplateDef<C>;
};

// ============ MCP prompt types ============

/** An argument accepted by a prompt */
export type McpPromptArgument = {
  /** Argument name */
  name: string;
  /** Optional description */
  description?: string;
  /** Whether the argument is required (default: false) */
  required?: boolean;
};

/** Content block inside a prompt message */
export type McpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

/** A single message returned by a prompt */
export type McpPromptMessage = {
  role: "user" | "assistant";
  content: McpPromptContent;
};

/** Result returned by a prompt handler */
export type McpPromptResult = {
  description?: string;
  messages: McpPromptMessage[];
};

/** A single prompt definition */
export type McpPromptDef<C = undefined> = {
  /** Human-readable description */
  description?: string;
  /** Arguments this prompt accepts */
  arguments?: McpPromptArgument[];
  /** Handler called on prompts/get — receives argument values */
  handler: (args: Record<string, string>, ctx: SpreadCtx<C>) => McpPromptResult | Promise<McpPromptResult>;
};

/** A single MCP tool definition */
export type McpToolDef<C = undefined> = {
  /** Human-readable description of the tool */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  input: McpInputSchema;
  /** Handler function called when the tool is invoked */
  handler: (input: any, ctx: SpreadCtx<C>) => McpToolResult | Promise<McpToolResult>;
};

// ============ Setup args ============

/** Setup factory — receives deps/config/files/enableAuth based on what was declared */
type SetupArgs<D, P, HasFiles extends boolean> =
  & { enableAuth: import("./define-api").EnableAuth }
  & ([D] extends [undefined] ? {} : { deps: ResolveDeps<D> })
  & ([P] extends [undefined] ? {} : { config: ResolveConfig<P & {}> })
  & (HasFiles extends true ? { files: StaticFiles } : {});

/** Spread ctx into callback args (empty when no setup) */
type SpreadCtx<C> = [C] extends [undefined] ? {} : C & {};

// ============ Handler type ============

/**
 * Handler object created by defineMcp.
 * @internal
 */
export type McpHandler<C = any> = {
  readonly __brand: "effortless-mcp";
  readonly __spec: McpConfig;
  readonly onError?: (...args: any[]) => any;
  readonly onCleanup?: (...args: any[]) => any;
  readonly setup?: (...args: any[]) => C | Promise<C>;
  readonly deps?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly config?: Record<string, unknown>;
  readonly static?: string[];
  readonly resources?: (...args: any[]) => any;
  readonly prompts?: (...args: any[]) => any;
  readonly tools?: (...args: any[]) => any;
};

// ============ Options ============

/** Options passed to `defineMcp()` */
type McpOptions = {
  /** MCP server name (used in server info) */
  name: string;
  /** MCP server version (default: "1.0.0") */
  version?: string;
  /** Human-readable description — sent to clients in initialize response as system prompt context */
  instructions?: string;
};

// ============ Builder ============

interface McpBuilder<
  D = undefined,
  P = undefined,
  C = undefined,
  HasFiles extends boolean = false,
> {
  /** Declare handler dependencies (tables, queues, buckets, mailers, workers) */
  deps<D2 extends Record<string, AnyDepHandler>>(
    fn: () => D2
  ): McpBuilder<D2, P, C, HasFiles>;

  /** Declare SSM secrets */
  config<P2 extends Record<string, AnySecretRef>>(
    fn: ConfigFactory<P2>
  ): McpBuilder<D, P2, C, HasFiles>;

  /** Include static files in the bundle. Chainable — call multiple times. */
  include(glob: string): McpBuilder<D, P, C, true>;

  /** Configure Lambda settings only (memory, timeout, permissions, logLevel) */
  setup(lambda: LambdaOptions): McpBuilder<D, P, C, HasFiles>;

  /** Initialize shared state on cold start. Receives deps, config, files. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>
  ): McpBuilder<D, P, C2, HasFiles>;

  /** Initialize shared state on cold start + configure Lambda settings. */
  setup<C2>(
    fn: (args: SetupArgs<D, P, HasFiles>) => C2 | Promise<C2>,
    lambda: LambdaOptions
  ): McpBuilder<D, P, C2, HasFiles>;

  /** Handle errors thrown by tool handlers */
  onError(
    fn: (args: { error: unknown; toolName: string } & SpreadCtx<C>) => void | Promise<void>
  ): McpBuilder<D, P, C, HasFiles>;

  /** Cleanup callback — runs on shutdown */
  onCleanup(
    fn: (args: SpreadCtx<C>) => void | Promise<void>
  ): McpBuilder<D, P, C, HasFiles>;

  /** Define MCP resources (chainable) */
  resources(
    fn: (ctx: SpreadCtx<C>) => McpResourceMap<C>
  ): McpBuilder<D, P, C, HasFiles>;

  /** Define MCP prompts (chainable) */
  prompts(
    fn: (ctx: SpreadCtx<C>) => Record<string, McpPromptDef<C>>
  ): McpBuilder<D, P, C, HasFiles>;

  /** Define MCP tools (terminal) */
  tools(
    fn: (ctx: SpreadCtx<C>) => Record<string, McpToolDef<C>>
  ): McpHandler<C>;
}

// ============ Implementation ============

/**
 * Define an MCP (Model Context Protocol) server endpoint.
 *
 * Creates a Lambda-backed MCP server that exposes tools, resources, and prompts
 * for AI models and MCP-compatible clients via Streamable HTTP (JSON-RPC over POST).
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26 — MCP specification
 * @see https://effortless-aws.com/use-cases/mcp-server/ — full documentation with examples
 */
export function defineMcp(options: McpOptions): McpBuilder {
  const spec: McpConfig = {
    name: options.name,
    ...(options.version ? { version: options.version } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
  };

  const state: {
    spec: McpConfig;
    deps?: () => Record<string, unknown>;
    config?: Record<string, unknown>;
    static?: string[];
    setup?: (...args: any[]) => any;
    onError?: (...args: any[]) => any;
    onCleanup?: (...args: any[]) => any;
    resources?: (...args: any[]) => any;
    prompts?: (...args: any[]) => any;
    tools?: (...args: any[]) => any;
  } = { spec };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
  };

  const finalize = (): McpHandler => ({
    __brand: "effortless-mcp",
    __spec: state.spec,
    ...(state.onError ? { onError: state.onError } : {}),
    ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
    ...(state.setup ? { setup: state.setup } : {}),
    ...(state.deps ? { deps: state.deps } : {}),
    ...(state.config ? { config: state.config } : {}),
    ...(state.static ? { static: state.static } : {}),
    ...(state.resources ? { resources: state.resources } : {}),
    ...(state.prompts ? { prompts: state.prompts } : {}),
    ...(state.tools ? { tools: state.tools } : {}),
  }) as McpHandler;

  const builder: McpBuilder = {
    deps(fn) {
      state.deps = fn as any;
      return builder as any;
    },
    config(fn) {
      state.config = resolveConfigFactory(fn) as any;
      return builder as any;
    },
    include(glob) {
      state.static = [...(state.static ?? []), glob];
      return builder as any;
    },
    setup(fnOrLambda: any, maybeLambda?: LambdaOptions) {
      if (typeof fnOrLambda === "function") {
        state.setup = fnOrLambda;
        if (maybeLambda) applyLambdaOptions(maybeLambda);
      } else {
        applyLambdaOptions(fnOrLambda);
      }
      return builder as any;
    },
    onError(fn) {
      state.onError = fn as any;
      return builder as any;
    },
    onCleanup(fn) {
      state.onCleanup = fn as any;
      return builder as any;
    },
    resources(fn) {
      state.resources = fn as any;
      return builder as any;
    },
    prompts(fn) {
      state.prompts = fn as any;
      return builder as any;
    },
    tools(fn) {
      state.tools = fn as any;
      return finalize() as any;
    },
  };

  return builder;
}
