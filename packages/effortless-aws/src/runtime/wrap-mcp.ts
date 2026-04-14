import type { McpHandler, McpResourceDef, McpResourceTemplateDef, McpResourceMap, McpPromptDef, McpToolResult, McpResourceContent, McpPromptResult } from "../handlers/define-mcp";

/** Internal tool entry shape: definition fields + handler */
type McpToolEntry = { description: string; input: unknown; handler: (...args: any[]) => any };
import type { JSONRPCRequest, JSONRPCResponse } from "@modelcontextprotocol/sdk/types.js";
import { createHandlerRuntime } from "./handler-utils";

/** Standard JSON-RPC / MCP error codes (mirrored from @modelcontextprotocol/sdk ErrorCode to avoid bundling Zod runtime) */
const ErrorCode = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

// ============ Lambda event ============

type LambdaEvent = {
  requestContext?: { http?: { method?: string; path?: string } };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
};

const parseBody = (body: string | undefined, isBase64: boolean): unknown => {
  if (!body) return undefined;
  const decoded = isBase64 ? Buffer.from(body, "base64").toString("utf-8") : body;
  try {
    return JSON.parse(decoded);
  } catch {
    return undefined;
  }
};

// ============ URI template matching ============

/** Check if a URI key contains template params like {id} */
const isTemplate = (uri: string): boolean => /\{[^}]+\}/.test(uri);

/** Match a concrete URI against a URI template, returning params or null */
const matchTemplate = (template: string, uri: string): Record<string, string> | null => {
  const paramNames: string[] = [];
  const regexStr = template.replace(/\{([^}]+)\}/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  const match = uri.match(new RegExp(`^${regexStr}$`));
  if (!match) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]!] = decodeURIComponent(match[i + 1]!);
  }
  return params;
};

// ============ Response helpers ============

const jsonResponse = (body: JSONRPCResponse, status = 200) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const RESOURCE_NOT_FOUND = -32002;

// ============ Standard Schema helpers ============

/** Check if a tool input implements StandardJSONSchemaV1 (~standard.jsonSchema) */
const isStandardSchema = (input: unknown): input is { "~standard": { jsonSchema: { input: Function }; validate?: Function } } =>
  input != null && typeof input === "object" && "~standard" in input &&
  typeof (input as any)["~standard"]?.jsonSchema?.input === "function";

/** Validate input using Standard Schema ~standard.validate() if available */
const validateInput = async (
  schema: { "~standard": { validate?: Function } },
  rawArgs: unknown,
  toolName: string,
): Promise<unknown> => {
  const validate = schema["~standard"].validate;
  if (typeof validate !== "function") return rawArgs;
  const result = await validate(rawArgs);
  if (result.issues) {
    const messages = (result.issues as { message: string; path?: any[] }[]).map(i => {
      const path = i.path?.map((p: any) => typeof p === "object" ? p.key : p).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    });
    throw new Error(`Validation failed for tool "${toolName}": ${messages.join("; ")}`);
  }
  return result.value;
};

/** Wrap a resource handler's return value into McpResourceContent[] */
const wrapResourceResult = (raw: unknown, uri: string): McpResourceContent[] => {
  if (raw == null) return [{ uri, text: "null" }];
  // Already a full McpResourceContent or array of them
  if (Array.isArray(raw)) {
    if (raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null && "uri" in raw[0]) return raw;
    return [{ uri, text: JSON.stringify(raw) }];
  }
  if (typeof raw === "object" && "uri" in (raw as any) && ("text" in (raw as any) || "blob" in (raw as any))) {
    return [raw as McpResourceContent];
  }
  // Plain data — auto-serialize
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return [{ uri, text }];
};

/** Wrap a tool handler's return value into McpToolResult */
const wrapToolResult = (raw: unknown): McpToolResult => {
  // Already a full McpToolResult
  if (raw != null && typeof raw === "object" && "content" in raw && Array.isArray((raw as any).content)) {
    return raw as McpToolResult;
  }
  // Plain data — auto-serialize
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  return { content: [{ type: "text", text }] };
};

// ============ Wrapper ============

export const wrapMcp = <C>(handler: McpHandler<C>) => {
  const rt = createHandlerRuntime(handler, "mcp", handler.__spec.lambda?.logLevel ?? "info");
  const serverName = handler.__spec.name;
  const serverVersion = handler.__spec.version ?? "1.0.0";
  const instructions = handler.__spec.instructions;

  const fn = async (event: LambdaEvent) => {
    const startTime = Date.now();
    rt.patchConsole();
    let ctxProps: Record<string, unknown> = {};

    try {
      const method = event.requestContext?.http?.method ?? "GET";

      // Health check / discovery via GET (not a JSON-RPC response)
      if (method === "GET") {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: null, result: { name: serverName, version: serverVersion, protocol: "mcp" } }),
        };
      }

      if (method !== "POST") {
        return { statusCode: 405, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Method not allowed" }) };
      }

      const body = parseBody(event.body, event.isBase64Encoded ?? false) as JSONRPCRequest | undefined;
      if (!body || body.jsonrpc !== "2.0" || !body.method) {
        return jsonResponse({ jsonrpc: "2.0", error: { code: ErrorCode.InvalidRequest, message: "Invalid JSON-RPC request" } });
      }

      // Extract Authorization header for auth check
      const headers = event.headers ?? {};
      const authHeader = headers["authorization"] ?? headers["Authorization"] ?? undefined;

      const common = await rt.commonArgs(undefined, authHeader, headers as Record<string, string | undefined>);
      const ctx = common.ctx;
      ctxProps = ctx && typeof ctx === "object" ? { ...ctx as Record<string, unknown> } : {};

      // Auth gate: if auth is configured, reject unauthenticated requests
      if (common.auth) {
        const auth = common.auth as { session: unknown };
        if (!auth.session) {
          return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
        }
      }

      // Resolve tools, resources, prompts from factories
      const tools: Record<string, McpToolEntry> = handler.tools ? (handler.tools as any)(ctxProps) : {};
      const resourceMap: McpResourceMap<C> = handler.resources ? (handler.resources as any)(ctxProps) : {};
      const prompts: Record<string, McpPromptDef<C>> = handler.prompts ? (handler.prompts as any)(ctxProps) : {};

      const response = await handleMethod(body, ctxProps, tools, resourceMap, prompts, serverName, serverVersion, instructions);
      const logPayload = "result" in response ? response.result : response.error;
      rt.logExecution(startTime, { method: body.method, id: body.id }, logPayload);
      return jsonResponse(response);
    } catch (error) {
      rt.logError(startTime, { method: "unknown" }, error);
      if (handler.onError) {
        try { await (handler.onError as any)({ error, toolName: "unknown", ...ctxProps }); }
        catch { /* ignore onError errors */ }
      }
      return jsonResponse({ jsonrpc: "2.0", error: { code: ErrorCode.InternalError, message: "Internal server error" } });
    } finally {
      if (handler.onCleanup) {
        try { await (handler.onCleanup as any)(ctxProps); }
        catch (e) { console.error(`[effortless:${rt.handlerName}] onCleanup error`, e); }
      }
      rt.restoreConsole();
    }
  };
  (fn as any).__preload = () => rt.preload();
  return fn;
};

// ============ Method router ============

async function handleMethod<C>(
  req: JSONRPCRequest,
  ctx: Record<string, unknown>,
  tools: Record<string, McpToolEntry>,
  resourceMap: McpResourceMap<C>,
  prompts: Record<string, McpPromptDef<C>>,
  serverName: string,
  serverVersion: string,
  instructions: string | undefined,
): Promise<JSONRPCResponse> {
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {
            ...(Object.keys(tools).length > 0 ? { tools: {} } : {}),
            ...(Object.keys(resourceMap).length > 0 ? { resources: {} } : {}),
            ...(Object.keys(prompts).length > 0 ? { prompts: {} } : {}),
          },
          serverInfo: {
            name: serverName,
            version: serverVersion,
          },
          ...(instructions ? { instructions } : {}),
        },
      };

    case "notifications/initialized":
      // Client acknowledgement — no response needed for notifications
      return { jsonrpc: "2.0", id: req.id, result: {} };

    case "ping":
      return { jsonrpc: "2.0", id: req.id, result: {} };

    case "notifications/cancelled":
      // Lambda is stateless — can't cancel in-flight requests, but accept gracefully
      return { jsonrpc: "2.0", id: req.id, result: {} };

    // ── Tools ──

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: Object.entries(tools).map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: isStandardSchema(def.input)
              ? def.input["~standard"].jsonSchema.input({ target: "draft-07" })
              : def.input,
          })),
        },
      };

    case "tools/call": {
      const toolName = req.params?.name as string | undefined;
      if (!toolName || !tools[toolName]) {
        return { jsonrpc: "2.0", id: req.id, error: { code: ErrorCode.InvalidParams, message: `Unknown tool: ${toolName}` } };
      }
      const tool = tools[toolName]!;
      try {
        const rawArgs = req.params?.arguments ?? {};
        const input = isStandardSchema(tool.input)
          ? await validateInput(tool.input, rawArgs, toolName)
          : rawArgs;
        const raw = await tool.handler(input, ctx as any);
        return { jsonrpc: "2.0", id: req.id, result: wrapToolResult(raw) };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          },
        };
      }
    }

    // ── Resources ──

    case "resources/list": {
      const resources = Object.entries(resourceMap)
        .filter(([uri]) => !isTemplate(uri))
        .map(([uri, def]) => ({
          uri,
          name: def.name,
          ...(def.description ? { description: def.description } : {}),
          ...(def.mimeType ? { mimeType: def.mimeType } : {}),
        }));
      return { jsonrpc: "2.0", id: req.id, result: { resources } };
    }

    case "resources/templates/list": {
      const resourceTemplates = Object.entries(resourceMap)
        .filter(([uri]) => isTemplate(uri))
        .map(([uriTemplate, def]) => ({
          uriTemplate,
          name: def.name,
          ...(def.description ? { description: def.description } : {}),
          ...(def.mimeType ? { mimeType: def.mimeType } : {}),
        }));
      return { jsonrpc: "2.0", id: req.id, result: { resourceTemplates } };
    }

    case "resources/read": {
      const uri = req.params?.uri as string | undefined;
      if (!uri) {
        return { jsonrpc: "2.0", id: req.id, error: { code: ErrorCode.InvalidParams, message: "Missing uri parameter" } };
      }

      // Try exact match first (static resource)
      const staticDef = resourceMap[uri];
      if (staticDef && !isTemplate(uri)) {
        const raw = await (staticDef as McpResourceDef<C>).handler(ctx as any);
        return { jsonrpc: "2.0", id: req.id, result: { contents: wrapResourceResult(raw, uri) } };
      }

      // Try template match
      for (const [template, def] of Object.entries(resourceMap)) {
        if (!isTemplate(template)) continue;
        const rawParams = matchTemplate(template, uri);
        if (rawParams) {
          // Validate params if schema is present
          const defAny = def as any;
          const params = defAny.params && typeof defAny.params === "object" && "~standard" in defAny.params
            ? await validateInput(defAny.params, rawParams, `resource ${template}`)
            : rawParams;
          const raw = await (def as McpResourceTemplateDef<C>).handler(params as any, ctx as any);
          return { jsonrpc: "2.0", id: req.id, result: { contents: wrapResourceResult(raw, uri) } };
        }
      }

      return { jsonrpc: "2.0", id: req.id, error: { code: RESOURCE_NOT_FOUND, message: "Resource not found", data: { uri } } };
    }

    // ── Prompts ──

    case "prompts/list": {
      const promptList = Object.entries(prompts).map(([name, def]) => {
        const defAny = def as any;
        // Convert schema args to MCP argument list
        let args: { name: string; description?: string; required?: boolean }[] | undefined;
        if (defAny.args && typeof defAny.args === "object" && "~standard" in defAny.args) {
          // Schema — extract properties from JSON Schema
          const jsonSchema = defAny.args["~standard"].jsonSchema?.input?.({ target: "draft-07" });
          if (jsonSchema?.properties) {
            const required = new Set(jsonSchema.required ?? []);
            args = Object.entries(jsonSchema.properties as Record<string, any>).map(([key, prop]) => ({
              name: key,
              ...(prop.description ? { description: prop.description } : {}),
              ...(required.has(key) ? { required: true } : {}),
            }));
          }
        } else if (Array.isArray(defAny.args)) {
          args = defAny.args;
        } else if (defAny.arguments) {
          args = defAny.arguments;
        }
        return {
          name,
          ...(def.description ? { description: def.description } : {}),
          ...(args ? { arguments: args } : {}),
        };
      });
      return { jsonrpc: "2.0", id: req.id, result: { prompts: promptList } };
    }

    case "prompts/get": {
      const promptName = req.params?.name as string | undefined;
      if (!promptName || !prompts[promptName]) {
        return { jsonrpc: "2.0", id: req.id, error: { code: ErrorCode.InvalidParams, message: `Unknown prompt: ${promptName}` } };
      }
      const prompt = prompts[promptName]!;
      const rawArgs = (req.params?.arguments ?? {}) as Record<string, string>;
      try {
        // Validate args if schema is present
        const defAny = prompt as any;
        const args = defAny.args && typeof defAny.args === "object" && "~standard" in defAny.args
          ? await validateInput(defAny.args, rawArgs, `prompt ${promptName}`)
          : rawArgs;
        const raw = await (prompt as any).handler(args, ctx as any);
        // Auto-wrap string return as user message
        const result: McpPromptResult = typeof raw === "string"
          ? { messages: [{ role: "user", content: { type: "text", text: raw } }] }
          : raw;
        return { jsonrpc: "2.0", id: req.id, result };
      } catch (error) {
        return { jsonrpc: "2.0", id: req.id, error: { code: ErrorCode.InternalError, message: error instanceof Error ? error.message : String(error) } };
      }
    }

    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: ErrorCode.MethodNotFound, message: `Unknown method: ${req.method}` } };
  }
}
