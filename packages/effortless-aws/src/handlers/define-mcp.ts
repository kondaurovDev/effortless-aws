import type { StandardSchemaV1, StandardJSONSchemaV1 } from "@standard-schema/spec";
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

/** Legacy resource content result type used by runtime internals */
type McpResourceResult = McpResourceContent | McpResourceContent[] | Promise<McpResourceContent | McpResourceContent[]>;

/** Static resource definition (no URI template params) */
export type McpStaticResourceDef = {
  /** Resource URI */
  uri: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional MIME type */
  mimeType?: string;
};

/** Template resource definition with typed params via Standard Schema */
export type McpTypedResourceDef<S extends StandardSchemaV1 = StandardSchemaV1> = {
  /** Resource URI template (e.g. "resource://contacts/{id}") */
  uri: `${string}{${string}}${string}`;
  /** Human-readable name */
  name: string;
  /** Schema for URI template params — provides type inference + validation */
  params: S;
  /** Optional description */
  description?: string;
  /** Optional MIME type */
  mimeType?: string;
};

/** Template resource definition without typed params */
export type McpTemplateResourceDef = {
  /** Resource URI template (e.g. "resource://contacts/{id}") */
  uri: `${string}{${string}}${string}`;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional MIME type */
  mimeType?: string;
};

/** What resource handlers can return — plain data is auto-wrapped by the runtime */
type McpResourceReturn = unknown | Promise<unknown>;

/** Handler for static resource */
type McpStaticResourceHandler<C> = (ctx: SpreadCtx<C>) => McpResourceReturn;

/** Handler for template resource with typed params */
type McpTypedResourceHandler<C, S extends StandardSchemaV1> = (params: StandardSchemaV1.InferOutput<S>, ctx: SpreadCtx<C>) => McpResourceReturn;

/** Handler for template resource with untyped params */
type McpTemplateResourceHandler<C> = (params: Record<string, string>, ctx: SpreadCtx<C>) => McpResourceReturn;

// Legacy types used by wrap-mcp runtime
/** @internal */
export type McpResourceDef<C = undefined> = {
  name: string;
  description?: string;
  mimeType?: string;
  handler: (ctx: SpreadCtx<C>) => McpResourceResult;
};

/** @internal */
export type McpResourceTemplateDef<C = undefined> = {
  name: string;
  description?: string;
  mimeType?: string;
  handler: (params: Record<string, string>, ctx: SpreadCtx<C>) => McpResourceResult;
};

/** @internal */
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

/** @internal Legacy prompt definition used by runtime */
export type McpPromptDef<C = undefined> = {
  description?: string;
  arguments?: McpPromptArgument[];
  handler: (args: Record<string, string>, ctx: SpreadCtx<C>) => McpPromptResult | Promise<McpPromptResult>;
};

/** Prompt definition with typed args via Standard Schema */
export type McpTypedPromptDef<S extends StandardSchemaV1 = StandardSchemaV1> = {
  /** Prompt name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Args schema — provides type inference + validation */
  args: S;
};

/** Prompt definition with untyped args */
export type McpUntypedPromptDef = {
  /** Prompt name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Arguments this prompt accepts */
  args?: McpPromptArgument[];
};

/** Handler return: string auto-wraps as user message, or return full McpPromptResult */
type McpPromptReturn = string | McpPromptResult | Promise<string | McpPromptResult>;

/** Handler for prompt with typed args */
type McpTypedPromptHandler<C, S extends StandardSchemaV1> = (args: StandardSchemaV1.InferOutput<S>, ctx: SpreadCtx<C>) => McpPromptReturn;

/** Handler for prompt with untyped args */
type McpUntypedPromptHandler<C> = (args: Record<string, string>, ctx: SpreadCtx<C>) => McpPromptReturn;

/** Tool definition with raw JSON Schema input */
export type McpToolDef = {
  /** Tool name */
  name: string;
  /** Human-readable description of the tool */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  input: McpInputSchema;
};

/** Tool definition with typed Standard JSON Schema input */
export type McpTypedToolDef<S extends StandardJSONSchemaV1 = StandardJSONSchemaV1> = {
  /** Tool name */
  name: string;
  /** Human-readable description of the tool */
  description: string;
  /** Schema object implementing StandardJSONSchemaV1 (e.g. z.object({...})) */
  input: S;
};

/** Handler function for a tool with raw JSON Schema input — return plain data, framework wraps it */
type McpToolHandler<C> = (input: any, ctx: SpreadCtx<C>) => unknown | Promise<unknown>;

/** Handler function for a tool with typed schema input — return plain data, framework wraps it */
type McpTypedToolHandler<C, S extends StandardJSONSchemaV1> = (input: StandardJSONSchemaV1.InferOutput<S>, ctx: SpreadCtx<C>) => unknown | Promise<unknown>;

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

// ============ McpEntries — returned after first singular method ============

/**
 * Finalized MCP handler with chainable registration methods.
 * Has `__brand` so CLI discovers it. Each `.tool()/.resource()/.prompt()` adds an entry and returns self.
 */
export interface McpEntries<C = undefined> extends McpHandler<C> {
  /** Register a tool with typed Standard JSON Schema input */
  tool<S extends StandardJSONSchemaV1>(def: McpTypedToolDef<S>, handler: McpTypedToolHandler<C, S>): McpEntries<C>;
  /** Register a tool with raw JSON Schema input */
  tool(def: McpToolDef, handler: McpToolHandler<C>): McpEntries<C>;
  /** Register a template resource with typed params */
  resource<S extends StandardSchemaV1>(def: McpTypedResourceDef<S>, handler: McpTypedResourceHandler<C, S>): McpEntries<C>;
  /** Register a template resource with untyped params */
  resource(def: McpTemplateResourceDef, handler: McpTemplateResourceHandler<C>): McpEntries<C>;
  /** Register a static resource */
  resource(def: McpStaticResourceDef, handler: McpStaticResourceHandler<C>): McpEntries<C>;
  /** Register a prompt with typed args via Standard Schema */
  prompt<S extends StandardSchemaV1>(def: McpTypedPromptDef<S>, handler: McpTypedPromptHandler<C, S>): McpEntries<C>;
  /** Register a prompt with untyped args */
  prompt(def: McpUntypedPromptDef, handler: McpUntypedPromptHandler<C>): McpEntries<C>;
}

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

  /** Register a tool with typed Standard JSON Schema input */
  tool<S extends StandardJSONSchemaV1>(def: McpTypedToolDef<S>, handler: McpTypedToolHandler<C, S>): McpEntries<C>;
  /** Register a tool with raw JSON Schema input */
  tool(def: McpToolDef, handler: McpToolHandler<C>): McpEntries<C>;

  /** Register a template resource with typed params */
  resource<S extends StandardSchemaV1>(def: McpTypedResourceDef<S>, handler: McpTypedResourceHandler<C, S>): McpEntries<C>;
  /** Register a template resource with untyped params */
  resource(def: McpTemplateResourceDef, handler: McpTemplateResourceHandler<C>): McpEntries<C>;
  /** Register a static resource */
  resource(def: McpStaticResourceDef, handler: McpStaticResourceHandler<C>): McpEntries<C>;

  /** Register a prompt with typed args via Standard Schema */
  prompt<S extends StandardSchemaV1>(def: McpTypedPromptDef<S>, handler: McpTypedPromptHandler<C, S>): McpEntries<C>;
  /** Register a prompt with untyped args */
  prompt(def: McpUntypedPromptDef, handler: McpUntypedPromptHandler<C>): McpEntries<C>;

  /** Finalize the handler without adding more entries */
  build(): McpHandler<C>;
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
    toolEntries: [string, any][];
    resourceEntries: [string, any][];
    promptEntries: [string, any][];
  } = { spec, toolEntries: [], resourceEntries: [], promptEntries: [] };

  const applyLambdaOptions = (lambda: LambdaOptions) => {
    if (Object.keys(lambda).length > 0) {
      state.spec = { ...state.spec, lambda: { ...state.spec.lambda, ...lambda } };
    }
  };

  // Build factory functions from accumulated entries
  const buildToolsFactory = () =>
    state.toolEntries.length > 0
      ? () => Object.fromEntries(state.toolEntries)
      : undefined;

  const buildResourcesFactory = () =>
    state.resourceEntries.length > 0
      ? () => Object.fromEntries(state.resourceEntries)
      : undefined;

  const buildPromptsFactory = () =>
    state.promptEntries.length > 0
      ? () => Object.fromEntries(state.promptEntries)
      : undefined;

  const finalize = (): McpHandler => {
    const tools = buildToolsFactory();
    const resources = buildResourcesFactory();
    const prompts = buildPromptsFactory();
    return {
      __brand: "effortless-mcp",
      __spec: state.spec,
      ...(state.onError ? { onError: state.onError } : {}),
      ...(state.onCleanup ? { onCleanup: state.onCleanup } : {}),
      ...(state.setup ? { setup: state.setup } : {}),
      ...(state.deps ? { deps: state.deps } : {}),
      ...(state.config ? { config: state.config } : {}),
      ...(state.static ? { static: state.static } : {}),
      ...(resources ? { resources } : {}),
      ...(prompts ? { prompts } : {}),
      ...(tools ? { tools } : {}),
    } as McpHandler;
  };

  const finalizeWithEntries = (): McpEntries => {
    const handler: any = finalize();

    handler.tool = (def: any, fn: any) => {
      state.toolEntries.push([def.name, { description: def.description, input: def.input, handler: fn }]);
      handler.tools = buildToolsFactory();
      return handler;
    };

    handler.resource = (def: any, fn: any) => {
      const entry = { name: def.name, ...(def.description ? { description: def.description } : {}), ...(def.mimeType ? { mimeType: def.mimeType } : {}), handler: fn, ...(def.params ? { params: def.params } : {}) };
      state.resourceEntries.push([def.uri, entry]);
      handler.resources = buildResourcesFactory();
      return handler;
    };

    handler.prompt = (def: any, fn: any) => {
      const entry = { ...(def.description ? { description: def.description } : {}), args: def.args, handler: fn };
      state.promptEntries.push([def.name, entry]);
      handler.prompts = buildPromptsFactory();
      return handler;
    };

    return handler as McpEntries;
  };

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
    tool(def: any, fn: any) {
      state.toolEntries.push([def.name, { description: def.description, input: def.input, handler: fn }]);
      return finalizeWithEntries() as any;
    },
    resource(def: any, fn: any) {
      const entry = { name: def.name, ...(def.description ? { description: def.description } : {}), ...(def.mimeType ? { mimeType: def.mimeType } : {}), handler: fn, ...(def.params ? { params: def.params } : {}) };
      state.resourceEntries.push([def.uri, entry]);
      return finalizeWithEntries() as any;
    },
    prompt(def: any, fn: any) {
      const entry = { ...(def.description ? { description: def.description } : {}), args: def.args, handler: fn };
      state.promptEntries.push([def.name, entry]);
      return finalizeWithEntries() as any;
    },
    build() {
      return finalize() as any;
    },
  };

  return builder;
}
