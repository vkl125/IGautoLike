import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const STORAGE_DIR = join(ROOT, "storage");

export interface Config {
  postsToCheck: number;
  pollIntervalMinutes: number;
  headless: boolean;
  maxLikesPerHour: number;
  maxLikesPerDay: number;
  /** [min, max] seconds */
  delaySecondsBetweenLikes: [number, number];
  /** [min, max] seconds */
  delaySecondsBetweenUsers: [number, number];
  skipReels: boolean;
  loginTimeoutMinutes: number;
  /** Only operate within this local-time window; null = always active. */
  activeHours: { start: string; end: string } | null;
  /** Randomly vary the poll interval by ± this percent (e.g. 40 = ±40%). */
  pollJitterPercent: number;
}

export function loadConfig(): Config {
  const raw = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
  return raw as Config;
}

/** Reserved IG path segments that are never real usernames. */
const RESERVED = new Set([
  "p", "reel", "reels", "stories", "explore", "accounts", "direct",
]);

/**
 * Extract a username from a bare handle, @handle, or full Instagram URL.
 * Returns null for lines that aren't profile references (e.g. a post URL).
 */
export function parseUsername(line: string): string | null {
  let s = line.trim().replace(/^@/, "");
  if (s.length === 0) return null;

  if (/instagram\.com/i.test(s)) {
    // Pull the first path segment after the domain.
    const m = s.match(/instagram\.com\/+([^/?#]+)/i);
    if (!m) return null;
    s = m[1];
  } else {
    // A non-URL token: strip any stray path/query just in case.
    s = s.split(/[/?#]/)[0];
  }

  s = s.toLowerCase();
  if (s.length === 0 || RESERVED.has(s)) return null;
  // Valid IG usernames: letters, numbers, periods, underscores.
  if (!/^[a-z0-9._]+$/.test(s)) return null;
  return s;
}

export function loadUsers(): string[] {
  // Prefer the private, git-ignored list if present; fall back to users.txt.
  const localPath = join(ROOT, "users.local.txt");
  const path = existsSync(localPath) ? localPath : join(ROOT, "users.txt");
  const raw = readFileSync(path, "utf8");
  const users = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map(parseUsername)
    .filter((u): u is string => u !== null);
  // de-duplicate, preserve order
  return [...new Set(users)];
}
