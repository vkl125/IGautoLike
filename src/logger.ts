import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.js";

const LOG_FILE = join(ROOT, "activity.log");

function stamp(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string): void {
  const line = `${stamp()} [${level}] ${msg}`;
  // console for live view
  if (level === "ERROR") console.error(line);
  else console.log(line);
  // file for history
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // logging must never crash the run
  }
}

export const log = {
  info: (m: string) => write("INFO", m),
  warn: (m: string) => write("WARN", m),
  error: (m: string) => write("ERROR", m),
};

export function ensureStorage(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
