import { Effect } from "effect";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { s3 } from "~/aws/clients";

// ============ Sitemap generation ============

const collectHtmlPaths = (sourceDir: string): string[] => {
  const paths: string[] = [];

  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), key);
      } else if (entry.name.endsWith(".html") || entry.name.endsWith(".htm")) {
        if (entry.name === "404.html" || entry.name === "500.html") continue;

        // /index.html → /
        // /about/index.html → /about/
        // /page.html → /page.html
        let urlPath = "/" + key;
        if (urlPath.endsWith("/index.html")) {
          urlPath = urlPath.slice(0, -"index.html".length);
        } else if (urlPath.endsWith("/index.htm")) {
          urlPath = urlPath.slice(0, -"index.htm".length);
        }

        paths.push(urlPath);
      }
    }
  };

  walk(sourceDir, "");
  return paths.sort();
};

export const generateSitemap = (siteUrl: string, sourceDir: string): string => {
  const baseUrl = siteUrl.replace(/\/$/, "");
  const paths = collectHtmlPaths(sourceDir);

  const urls = paths
    .map(urlPath => `  <url>\n    <loc>${baseUrl}${urlPath}</loc>\n  </url>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
};

// ============ Robots.txt generation ============

export const generateRobots = (siteUrl: string, sitemapName = "sitemap.xml"): string => {
  const baseUrl = siteUrl.replace(/\/$/, "");
  return `User-agent: *
Allow: /

Sitemap: ${baseUrl}/${sitemapName}
`;
};

// ============ Google Indexing API ============

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

const createJwt = (serviceAccount: ServiceAccountKey): string => {
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");

  const payload = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/indexing",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url");

  const signInput = `${header}.${payload}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signInput)
    .sign(serviceAccount.private_key, "base64url");

  return `${signInput}.${signature}`;
};

const getAccessToken = async (serviceAccount: ServiceAccountKey): Promise<string> => {
  const jwt = createJwt(serviceAccount);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get Google access token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
};

const publishUrl = async (accessToken: string, url: string): Promise<{ url: string; ok: boolean; error?: string }> => {
  const response = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ url, type: "URL_UPDATED" }),
  });

  if (!response.ok) {
    const text = await response.text();
    return { url, ok: false, error: `${response.status} ${text}` };
  }

  return { url, ok: true };
};

/** Collect all HTML file keys from a directory (e.g. ["index.html", "about/index.html"]) */
export const collectHtmlKeys = (sourceDir: string): string[] => {
  const keys: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, key);
      } else if (entry.name.endsWith(".html") || entry.name.endsWith(".htm")) {
        if (entry.name === "404.html" || entry.name === "500.html") continue;
        keys.push(key);
      }
    }
  };
  walk(sourceDir, "");
  return keys;
};

/** Convert S3 keys (e.g. "about/index.html") to page URLs (e.g. "https://example.com/about/") */
export const keysToUrls = (siteUrl: string, keys: string[]): string[] => {
  const baseUrl = siteUrl.replace(/\/$/, "");
  return keys.map(key => {
    let urlPath = "/" + key;
    if (urlPath.endsWith("/index.html")) {
      urlPath = urlPath.slice(0, -"index.html".length);
    } else if (urlPath.endsWith("/index.htm")) {
      urlPath = urlPath.slice(0, -"index.htm".length);
    }
    return `${baseUrl}${urlPath}`;
  });
};

// ============ Indexed URLs tracking (S3) ============

const INDEXED_URLS_KEY = "_effortless/indexed-urls.json";

/** Load previously indexed URLs from S3 */
const loadIndexedUrls = (bucketName: string) =>
  Effect.gen(function* () {
    const result = yield* s3.make("get_object", {
      Bucket: bucketName,
      Key: INDEXED_URLS_KEY,
    }).pipe(Effect.option);

    if (result._tag === "None") return new Set<string>();

    const body = yield* Effect.tryPromise({
      try: () => result.value.Body?.transformToString("utf-8") ?? Promise.resolve("[]"),
      catch: () => new Error("Failed to read indexed URLs from S3"),
    });

    const urls = JSON.parse(body) as string[];
    return new Set(urls);
  });

/** Save indexed URLs to S3 as pretty JSON */
const saveIndexedUrls = (bucketName: string, urls: Set<string>) =>
  s3.make("put_object", {
    Bucket: bucketName,
    Key: INDEXED_URLS_KEY,
    Body: JSON.stringify([...urls].sort(), null, 2),
    ContentType: "application/json; charset=utf-8",
  });

export const submitToGoogleIndexing = (input: {
  serviceAccountPath: string;
  projectDir: string;
  bucketName: string;
  allPageUrls: string[];
}) =>
  Effect.gen(function* () {
    const { serviceAccountPath, projectDir, bucketName, allPageUrls } = input;

    // Load already indexed URLs from S3
    const indexedUrls = yield* loadIndexedUrls(bucketName);
    const urlsToSubmit = allPageUrls.filter(url => !indexedUrls.has(url));

    // Remove URLs that no longer exist from the tracking set
    const currentUrlSet = new Set(allPageUrls);
    for (const url of indexedUrls) {
      if (!currentUrlSet.has(url)) {
        indexedUrls.delete(url);
      }
    }

    if (urlsToSubmit.length === 0) {
      yield* Effect.logDebug("All pages already indexed, skipping Google Indexing API");
      return { submitted: 0, failed: 0, skipped: allPageUrls.length };
    }

    const expanded = serviceAccountPath.startsWith("~/")
      ? path.join(os.homedir(), serviceAccountPath.slice(2))
      : serviceAccountPath;
    const keyPath = path.resolve(projectDir, expanded);

    if (!fs.existsSync(keyPath)) {
      return yield* Effect.fail(
        new Error(`Google service account key not found: ${keyPath}`)
      );
    }

    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf-8")) as ServiceAccountKey;

    if (!serviceAccount.client_email || !serviceAccount.private_key) {
      return yield* Effect.fail(
        new Error(`Invalid service account key: missing client_email or private_key`)
      );
    }

    yield* Effect.logDebug(`Authenticating with Google as ${serviceAccount.client_email}`);

    const accessToken = yield* Effect.tryPromise({
      try: () => getAccessToken(serviceAccount),
      catch: (error) => new Error(`Google auth failed: ${error}`),
    });

    // Google Indexing API has a 200 requests/day quota
    const maxUrls = Math.min(urlsToSubmit.length, 200);
    if (urlsToSubmit.length > 200) {
      yield* Effect.logDebug(
        `Google Indexing API daily quota is 200. Submitting first 200 of ${urlsToSubmit.length} URLs.`
      );
    }

    let submitted = 0;
    let failed = 0;

    for (const url of urlsToSubmit.slice(0, maxUrls)) {
      const result = yield* Effect.tryPromise({
        try: () => publishUrl(accessToken, url),
        catch: (error) => new Error(`Failed to submit ${url}: ${error}`),
      });

      if (result.ok) {
        submitted++;
        indexedUrls.add(url);
      } else {
        failed++;
        yield* Effect.logDebug(`Failed to index ${result.url}: ${result.error}`);
      }
    }

    // Save updated tracking set to S3
    yield* saveIndexedUrls(bucketName, indexedUrls);

    yield* Effect.logDebug(`Google Indexing: ${submitted} submitted, ${failed} failed, ${allPageUrls.length - urlsToSubmit.length} already indexed`);
    return { submitted, failed, skipped: allPageUrls.length - urlsToSubmit.length };
  });
