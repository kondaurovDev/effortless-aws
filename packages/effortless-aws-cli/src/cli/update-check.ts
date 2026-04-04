import { Effect, Console } from "effect";
import { Path, FileSystem } from "@effect/platform";
import { homedir } from "os";
import { c } from "./colors";

const PACKAGE_NAME = "@effortless-aws/cli";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

interface CacheData {
  lastCheck: number;
  latestVersion: string;
}

const readCache = Effect.gen(function* () {
  const p = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const cacheFile = p.join(homedir(), ".effortless-aws", "update-check.json");
  const exists = yield* fs.exists(cacheFile);
  if (!exists) return undefined;
  const content = yield* fs.readFileString(cacheFile);
  return JSON.parse(content) as CacheData;
}).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

const writeCache = (data: CacheData) =>
  Effect.gen(function* () {
    const p = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const cacheDir = p.join(homedir(), ".effortless-aws");
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    yield* fs.writeFileString(p.join(cacheDir, "update-check.json"), JSON.stringify(data));
  }).pipe(Effect.catchAll(() => Effect.void));

const fetchLatestVersion = Effect.tryPromise({
  try: async () => {
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
  },
  catch: () => new Error("Failed to fetch latest version"),
}).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

const compareVersions = (current: string, latest: string): boolean => {
  const parse = (v: string) => v.split(".").map(Number) as [number, number, number];
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);
  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
};

export const checkForUpdate = (currentVersion: string) =>
  Effect.gen(function* () {
    const cache = yield* readCache;
    const now = Date.now();

    let latestVersion: string | undefined;

    if (cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
      latestVersion = cache.latestVersion;
    } else {
      latestVersion = yield* fetchLatestVersion;
      if (latestVersion) {
        yield* writeCache({ lastCheck: now, latestVersion });
      }
    }

    if (latestVersion && compareVersions(currentVersion, latestVersion)) {
      const border = "┌─────────────────────────────────────────┐";
      const bottom = "└─────────────────────────────────────────┘";
      const pad = (line: string, width: number) => {
        const visible = line.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");
        return line + " ".repeat(Math.max(0, width - visible.length));
      };
      const W = 39;
      const line1 = `Update available! ${c.dim(currentVersion)} ${c.dim("\u2192")} ${c.green(latestVersion)}`;
      const line2 = `Run ${c.cyan(`pnpm i -g ${PACKAGE_NAME}`)} to update`;

      yield* Console.log("");
      yield* Console.log(`  ${border}`);
      yield* Console.log(`  │ ${pad(line1, W)} │`);
      yield* Console.log(`  │ ${pad(line2, W)} │`);
      yield* Console.log(`  ${bottom}`);
      yield* Console.log("");
    }
  }).pipe(Effect.catchAll(() => Effect.void));
