/** HTTP methods supported by Lambda Function URLs */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ANY";

/** Short content-type aliases for common response formats */
export type ContentType = "json" | "html" | "text" | "css" | "js" | "xml" | "csv" | "svg";

/**
 * Incoming HTTP request object passed to the handler
 */
export type HttpRequest = {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Request path (e.g., "/users/123") */
  path: string;
  /** Request headers */
  headers: Record<string, string | undefined>;
  /** Query string parameters */
  query: Record<string, string | undefined>;
  /** Path parameters extracted from route (e.g., {id} -> params.id) */
  params: Record<string, string | undefined>;
  /** Parsed request body (JSON parsed if Content-Type is application/json) */
  body: unknown;
  /** Raw unparsed request body */
  rawBody?: string;
};

/**
 * HTTP response returned from the handler
 */
export type HttpResponse = {
  /** HTTP status code (e.g., 200, 404, 500) */
  status: number;
  /** Response body — JSON-serialized by default, or sent as string when contentType is set */
  body?: unknown;
  /**
   * Short content-type alias. Resolves to full MIME type automatically:
   * - `"json"` → `application/json` (default if omitted)
   * - `"html"` → `text/html; charset=utf-8`
   * - `"text"` → `text/plain; charset=utf-8`
   * - `"css"` → `text/css; charset=utf-8`
   * - `"js"` → `application/javascript; charset=utf-8`
   * - `"xml"` → `application/xml; charset=utf-8`
   * - `"csv"` → `text/csv; charset=utf-8`
   * - `"svg"` → `image/svg+xml; charset=utf-8`
   */
  contentType?: ContentType;
  /** Response headers (use for custom content-types not covered by contentType) */
  headers?: Record<string, string>;
  /**
   * Set to `true` to return binary data.
   * When enabled, `body` must be a base64-encoded string and the response
   * will include `isBase64Encoded: true` so Lambda Function URLs / API Gateway
   * decode it back to binary for the client.
   */
  binary?: boolean;
};

/** Response helpers for defineApi handlers */
export const result = {
  /** Return a JSON response */
  json: (body: unknown, status: number = 200): HttpResponse => ({ status, body }),
  /** Return a binary response. Accepts a Buffer and converts to base64 automatically. */
  binary: (body: Buffer, contentType: string, headers?: Record<string, string>): HttpResponse => ({
    status: 200,
    body: body.toString("base64"),
    binary: true,
    headers: { "content-type": contentType, ...headers },
  }),
};

/** Stream helper injected into route args when `stream: true` is set on defineApi */
export type ResponseStream = {
  /** Write a raw string chunk to the response stream */
  write(chunk: string): void;
  /** End the response stream */
  end(): void;
  /** Switch to SSE mode: sets Content-Type to text/event-stream */
  sse(): void;
  /** Write an SSE event: `data: JSON.stringify(data)\n\n` */
  event(data: unknown): void;
};

/** Service for reading static files bundled into the Lambda ZIP */
export type StaticFiles = {
  /** Read file as UTF-8 string */
  read(path: string): string;
  /** Read file as Buffer (for binary content) */
  readBuffer(path: string): Buffer;
  /** Resolve absolute path to the bundled file */
  path(path: string): string;
};
