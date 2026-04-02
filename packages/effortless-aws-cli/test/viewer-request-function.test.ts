import { describe, it, expect } from "vitest";
import { generateViewerRequestCode, type ViewerRequestFunctionConfig } from "~cli/aws/cloudfront";

/** Execute the generated CF Function code against a mock event */
const run = (config: ViewerRequestFunctionConfig, uri: string, host?: string) => {
  const code = generateViewerRequestCode(config);
  const event = {
    request: {
      uri,
      headers: host ? { host: { value: host } } : {},
    },
  };
  // CF Functions export a `handler(event)` function
  const fn = new Function("event", code.replace("function handler(event) {", "").replace(/\}$/, ""));
  // Actually, let's eval properly
  const handler = new Function("event", `${code}; return handler(event);`);
  const result = handler(event);
  return result;
};

describe("generateViewerRequestCode", () => {
  describe("spaFallback", () => {
    const config: ViewerRequestFunctionConfig = { spaFallback: true };

    it("/ stays as /", () => {
      const result = run(config, "/");
      expect(result.uri).toBe("/");
    });

    it("/style.css passes through", () => {
      const result = run(config, "/style.css");
      expect(result.uri).toBe("/style.css");
    });

    it("/app.js passes through", () => {
      const result = run(config, "/app.js");
      expect(result.uri).toBe("/app.js");
    });

    it("/data.json passes through", () => {
      const result = run(config, "/data.json");
      expect(result.uri).toBe("/data.json");
    });

    it("/images/logo.png passes through", () => {
      const result = run(config, "/images/logo.png");
      expect(result.uri).toBe("/images/logo.png");
    });

    it("/about rewrites to /index.html", () => {
      const result = run(config, "/about");
      expect(result.uri).toBe("/index.html");
    });

    it("/dashboard/settings rewrites to /index.html", () => {
      const result = run(config, "/dashboard/settings");
      expect(result.uri).toBe("/index.html");
    });

    it("/users/123/edit rewrites to /index.html", () => {
      const result = run(config, "/users/123/edit");
      expect(result.uri).toBe("/index.html");
    });

    it("/about.html passes through (has extension)", () => {
      const result = run(config, "/about.html");
      expect(result.uri).toBe("/about.html");
    });
  });

  describe("rewriteUrls (non-SPA)", () => {
    const config: ViewerRequestFunctionConfig = { rewriteUrls: true };

    it("/ → /index.html", () => {
      const result = run(config, "/");
      expect(result.uri).toBe("/index.html");
    });

    it("/about/ → /about/index.html", () => {
      const result = run(config, "/about/");
      expect(result.uri).toBe("/about/index.html");
    });

    it("/about → /about/index.html (no extension)", () => {
      const result = run(config, "/about");
      expect(result.uri).toBe("/about/index.html");
    });

    it("/style.css passes through", () => {
      const result = run(config, "/style.css");
      expect(result.uri).toBe("/style.css");
    });

    it("/images/logo.png passes through", () => {
      const result = run(config, "/images/logo.png");
      expect(result.uri).toBe("/images/logo.png");
    });
  });

  describe("redirectWwwDomain", () => {
    const config: ViewerRequestFunctionConfig = { redirectWwwDomain: "www.example.com" };

    it("redirects www to non-www with 301", () => {
      const result = run(config, "/about", "www.example.com");
      expect(result.statusCode).toBe(301);
      expect(result.headers.location.value).toBe("https://example.com/about");
    });

    it("passes through non-www requests", () => {
      const result = run(config, "/about", "example.com");
      expect(result.uri).toBe("/about");
    });
  });

  describe("spaFallback + redirectWwwDomain", () => {
    const config: ViewerRequestFunctionConfig = {
      spaFallback: true,
      redirectWwwDomain: "www.example.com",
    };

    it("redirects www before SPA fallback", () => {
      const result = run(config, "/dashboard", "www.example.com");
      expect(result.statusCode).toBe(301);
    });

    it("SPA fallback for non-www", () => {
      const result = run(config, "/dashboard", "example.com");
      expect(result.uri).toBe("/index.html");
    });
  });

  describe("no options", () => {
    const config: ViewerRequestFunctionConfig = {};

    it("passes through as-is", () => {
      const result = run(config, "/anything/here");
      expect(result.uri).toBe("/anything/here");
    });
  });
});
