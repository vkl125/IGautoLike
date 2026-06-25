export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random integer in [min, max] inclusive. */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Sleep a random number of seconds in the [minSec, maxSec] range. */
export async function humanDelay(range: [number, number]): Promise<void> {
  const [min, max] = range;
  const seconds = randInt(min, max);
  await sleep(seconds * 1000);
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** Apply a random ± jitter (in percent) to a value. */
export function jitter(value: number, percent: number): number {
  if (!percent) return value;
  const factor = 1 + (Math.random() * 2 - 1) * (percent / 100);
  return value * factor;
}

type ActiveHours = { start: string; end: string } | null;

function parseHM(s: string): number {
  const [h, m] = s.split(":").map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

/** Is `now` within the configured active-hours window? null window = always on. */
export function isActive(now: Date, ah: ActiveHours): boolean {
  if (!ah) return true;
  const start = parseHM(ah.start);
  const end = parseHM(ah.end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true; // full day
  if (start < end) return cur >= start && cur < end; // same-day window
  return cur >= start || cur < end; // overnight window
}

/** Milliseconds until the active window next opens (0 if active now). */
export function msUntilActive(now: Date, ah: ActiveHours): number {
  if (isActive(now, ah)) return 0;
  const [sh, sm] = ah!.start.split(":").map((n) => parseInt(n, 10));
  const target = new Date(now);
  target.setHours(sh, sm || 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}
