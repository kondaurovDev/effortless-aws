import { readFileSync, existsSync } from "fs";
import { join, extname, resolve } from "path";
import type { SiteHandler } from "~/handlers/define-site";
import { createHandlerRuntime } from "./handler-utils";

// Content-type map for common web file types
const CONTENT_TYPES: Record<string, string> = {
  // Text
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  // Images (binary)
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  // Fonts (binary)
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  // Media (binary)
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  // Other
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".gz": "application/gzip",
  ".zip": "application/zip",
};

// Extensions that need base64 encoding for API Gateway v2
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".webm", ".mp3", ".ogg",
  ".pdf", ".wasm", ".gz", ".zip",
]);

type LambdaEvent = {
  requestContext?: { http?: { method?: string; path?: string } };
  pathParameters?: Record<string, string>;
  headers?: Record<string, string>;
};

export const wrapSite = (handler: SiteHandler) => {
  const { dir, index: indexFile = "index.html", spa = false } = handler.config;
  const rt = createHandlerRuntime({}, "site");
  const baseDir = join(process.cwd(), dir);

  return async (event: LambdaEvent) => {
    const startTime = Date.now();
    let filePath = event.pathParameters?.["file"] ?? "";

    // Empty path or trailing slash → serve index
    if (!filePath || filePath.endsWith("/")) {
      filePath = filePath + indexFile;
    }

    const fullPath = resolve(baseDir, filePath);

    // Path traversal protection
    if (!fullPath.startsWith(baseDir)) {
      return {
        statusCode: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: "<!DOCTYPE html><html><body><h1>403 Forbidden</h1></body></html>",
      };
    }

    // Serve file if it exists
    if (existsSync(fullPath)) {
      return serveFile(fullPath, filePath, rt, startTime);
    }

    // SPA mode: if path has no extension, serve index.html
    if (spa && !extname(filePath)) {
      const spaPath = join(baseDir, indexFile);
      if (existsSync(spaPath)) {
        return serveFile(spaPath, indexFile, rt, startTime);
      }
    }

    // 404
    rt.logError(startTime, { path: filePath }, "File not found");
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: `<!DOCTYPE html><html><body><h1>404 Not Found</h1><p>${filePath}</p></body></html>`,
    };
  };
};

function serveFile(
  fullPath: string,
  filePath: string,
  rt: ReturnType<typeof createHandlerRuntime>,
  startTime: number,
) {
  const ext = extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const binary = BINARY_EXTENSIONS.has(ext);

  // HTML: always revalidate. Other assets: long cache (assumes hashed filenames).
  const isHtml = ext === ".html" || ext === ".htm";
  const cacheControl = isHtml
    ? "public, max-age=0, must-revalidate"
    : "public, max-age=31536000, immutable";

  if (binary) {
    const body = readFileSync(fullPath).toString("base64");
    rt.logExecution(startTime, { path: filePath }, { status: 200, binary: true });
    return {
      statusCode: 200,
      headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
      body,
      isBase64Encoded: true,
    };
  }

  const body = readFileSync(fullPath, "utf-8");
  rt.logExecution(startTime, { path: filePath }, { status: 200 });
  return {
    statusCode: 200,
    headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
    body,
  };
}
