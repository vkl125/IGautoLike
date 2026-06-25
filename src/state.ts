import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STORAGE_DIR } from "./config.js";

const STATE_FILE = join(STORAGE_DIR, "state.json");

interface PersistedState {
  /** shortcode -> ISO timestamp of when we liked it */
  liked: Record<string, string>;
  /** ISO timestamps of recent likes, used for rate limiting */
  likeTimestamps: string[];
}

export class State {
  private liked: Record<string, string>;
  private likeTimestamps: number[];

  private constructor(data: PersistedState) {
    this.liked = data.liked ?? {};
    this.likeTimestamps = (data.likeTimestamps ?? []).map((t) =>
      new Date(t).getTime()
    );
  }

  static load(): State {
    if (existsSync(STATE_FILE)) {
      try {
        return new State(JSON.parse(readFileSync(STATE_FILE, "utf8")));
      } catch {
        // corrupt file — start fresh rather than crash
      }
    }
    return new State({ liked: {}, likeTimestamps: [] });
  }

  private save(): void {
    const data: PersistedState = {
      liked: this.liked,
      likeTimestamps: this.likeTimestamps.map((t) => new Date(t).toISOString()),
    };
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  }

  hasLiked(shortcode: string): boolean {
    return shortcode in this.liked;
  }

  recordLike(shortcode: string): void {
    const now = Date.now();
    this.liked[shortcode] = new Date(now).toISOString();
    this.likeTimestamps.push(now);
    this.prune();
    this.save();
  }

  /**
   * Mark posts as already-seen WITHOUT counting them as likes (no click, no
   * rate-limit impact). Used by --seed to skip the existing backlog.
   * Returns how many were newly marked.
   */
  markSeen(shortcodes: string[]): number {
    const now = new Date().toISOString();
    let added = 0;
    for (const code of shortcodes) {
      if (!(code in this.liked)) {
        this.liked[code] = now;
        added++;
      }
    }
    if (added > 0) this.save();
    return added;
  }

  /** Drop like timestamps older than 24h so the arrays don't grow forever. */
  private prune(): void {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.likeTimestamps = this.likeTimestamps.filter((t) => t >= dayAgo);
  }

  likesInLastHour(): number {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    return this.likeTimestamps.filter((t) => t >= hourAgo).length;
  }

  likesInLastDay(): number {
    this.prune();
    return this.likeTimestamps.length;
  }
}
