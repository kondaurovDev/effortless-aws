import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { c } from "./colors";

const PACKAGE_NAME = "@effortless-aws/cli";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const CACHE_DIR = join(homedir(), ".effortless-aws");
const CACHE_FILE = join(CACHE_DIR, "update-check.json");

interface CacheData {
  lastCheck: number;
  latestVersion: string;
}

function readCache(): CacheData | undefined {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeCache(data: CacheData) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch {}
}

async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return undefined;
  }
}

function compareVersions(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(".").map(Number) as [number, number, number];
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);
  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

export async function checkForUpdate(currentVersion: string) {
  const cache = readCache();
  const now = Date.now();

  let latestVersion: string | undefined;

  if (cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
    latestVersion = cache.latestVersion;
  } else {
    latestVersion = await fetchLatestVersion();
    if (latestVersion) {
      writeCache({ lastCheck: now, latestVersion });
    }
  }

  if (latestVersion && compareVersions(currentVersion, latestVersion)) {
    const border = "┌─────────────────────────────────────────┐";
    const bottom = "└─────────────────────────────────────────┘";
    const pad = (line: string, width: number) => {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
      return line + " ".repeat(Math.max(0, width - visible.length));
    };
    const W = 39;
    const line1 = `Update available! ${c.dim(currentVersion)} ${c.dim("\u2192")} ${c.green(latestVersion)}`;
    const line2 = `Run ${c.cyan(`pnpm i -g ${PACKAGE_NAME}`)} to update`;

    console.log();
    console.log(`  ${border}`);
    console.log(`  │ ${pad(line1, W)} │`);
    console.log(`  │ ${pad(line2, W)} │`);
    console.log(`  ${bottom}`);
    console.log();
  }
}
