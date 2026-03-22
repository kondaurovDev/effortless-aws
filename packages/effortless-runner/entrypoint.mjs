import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const codeUrl = process.env.EFF_CODE_URL;
if (!codeUrl) {
  console.error("[effortless-runner] Missing EFF_CODE_URL env var");
  process.exit(1);
}

// Parse s3://bucket/key
const match = codeUrl.match(/^s3:\/\/([^/]+)\/(.+)$/);
if (!match) {
  console.error(`[effortless-runner] Invalid EFF_CODE_URL: ${codeUrl}`);
  process.exit(1);
}

const [, bucket, key] = match;

console.log(`[effortless-runner] Downloading code from ${codeUrl}...`);

const s3 = new S3Client({});
const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
const body = await resp.Body.transformToByteArray();

// Write ZIP to temp file and extract
const zipPath = join(tmpdir(), "code.zip");
const extractDir = "/app/code";

writeFileSync(zipPath, body);
mkdirSync(extractDir, { recursive: true });
execSync(`unzip -o ${zipPath} -d ${extractDir}`, { stdio: "inherit" });

console.log("[effortless-runner] Code extracted, starting handler...");

// Import and run the handler
const mod = await import(join(extractDir, "index.mjs"));
const handler = mod.handler;

if (typeof handler !== "function") {
  console.error("[effortless-runner] No 'handler' export found in index.mjs");
  process.exit(1);
}

await handler();
