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
  /**
   * Response body. Type determines serialization:
   * - `Uint8Array` (incl. `Buffer`) — sent as binary, base64-encoded
   * - `Blob` — sent as binary, base64-encoded; `Blob.type` is used as Content-Type when not set explicitly
   * - other values — JSON-serialized by default, or sent as string when `contentType` is set
   */
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
   * Multiple Set-Cookie values. Used by Lambda Function URLs to set multiple cookies
   * in a single response (e.g., session cookie + CloudFront signed cookies).
   * When present, takes precedence over `set-cookie` in `headers`.
   */
  cookies?: string[];
  /**
   * Force the client to download the response as a file with the given filename.
   * Sets `Content-Disposition: attachment; filename="<value>"`. Works with any body type
   * (JSON, text, binary). An explicit `Content-Disposition` header overrides this.
   */
  downloadAs?: string;
  /**
   * Set to `true` to return binary data when `body` is already a base64-encoded string.
   * Prefer returning `Uint8Array` / `Buffer` / `Blob` directly — the runtime detects them automatically.
   */
  binary?: boolean;
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
  /** Read file as raw bytes (for binary content) */
  readBytes(path: string): Uint8Array;
  /** Resolve absolute path to the bundled file */
  path(path: string): string;
};
