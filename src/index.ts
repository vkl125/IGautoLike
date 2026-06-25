import { loadConfig, loadUsers, STORAGE_DIR } from "./config.js";
import { log, ensureStorage } from "./logger.js";
import { State } from "./state.js";
import {
  launchContext,
  ensureLoggedIn,
  getRecentShortcodes,
  likePost,
} from "./instagram.js";
import {
  humanDelay,
  sleep,
  fmtDuration,
  jitter,
  isActive,
  msUntilActive,
} from "./util.js";
import type { BrowserContext } from "playwright";

const args = process.argv.slice(2);
const LOGIN_ONLY = args.includes("--login-only");
const RUN_ONCE = args.includes("--once");
const SEED = args.includes("--seed");

let context: BrowserContext | null = null;
let shuttingDown = false;

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Shutting down…");
  try {
    await context?.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

/** Block until we're under the hourly and daily like caps. */
async function waitForRateLimit(state: State, config: Config_): Promise<void> {
  for (;;) {
    if (state.likesInLastDay() >= config.maxLikesPerDay) {
      log.warn(
        `Daily cap (${config.maxLikesPerDay}) reached. Pausing 30 min before re-checking.`
      );
      await sleep(30 * 60 * 1000);
      continue;
    }
    if (state.likesInLastHour() >= config.maxLikesPerHour) {
      log.warn(
        `Hourly cap (${config.maxLikesPerHour}) reached. Pausing 5 min before re-checking.`
      );
      await sleep(5 * 60 * 1000);
      continue;
    }
    return;
  }
}

type Config_ = ReturnType<typeof loadConfig>;

async function runCycle(
  context: BrowserContext,
  config: Config_,
  users: string[],
  state: State
): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());

  for (const username of users) {
    if (shuttingDown) return;
    if (!isActive(new Date(), config.activeHours)) {
      log.info("Active-hours window closed mid-cycle — pausing until it reopens.");
      return;
    }
    log.info(`Checking @${username}…`);

    let shortcodes: string[];
    try {
      shortcodes = await getRecentShortcodes(
        page,
        username,
        config.postsToCheck,
        config.skipReels
      );
    } catch (err) {
      log.error(`@${username}: could not load profile: ${(err as Error).message}`);
      continue;
    }

    const fresh = shortcodes.filter((c) => !state.hasLiked(c));
    if (fresh.length === 0) {
      log.info(`@${username}: nothing new among the latest ${shortcodes.length} posts.`);
      await humanDelay(config.delaySecondsBetweenUsers);
      continue;
    }

    log.info(`@${username}: ${fresh.length} new post(s) to like.`);
    for (const code of fresh) {
      if (shuttingDown) return;
      await waitForRateLimit(state, config);

      const result = await likePost(page, code);
      if (result === "liked") {
        state.recordLike(code);
        log.info(
          `  ♥ liked ${code}  (hour ${state.likesInLastHour()}/${config.maxLikesPerHour}, day ${state.likesInLastDay()}/${config.maxLikesPerDay})`
        );
        await humanDelay(config.delaySecondsBetweenLikes);
      } else if (result === "already-liked") {
        // Record so we skip the round-trip next time.
        state.recordLike(code);
        log.info(`  – ${code} was already liked; remembering it.`);
      } else {
        log.warn(`  ✗ skipped ${code} (will retry next cycle).`);
        await sleep(3000);
      }
    }

    await humanDelay(config.delaySecondsBetweenUsers);
  }
}

async function main(): Promise<void> {
  ensureStorage(STORAGE_DIR);
  const config = loadConfig();
  const users = loadUsers();

  log.info(
    `ig-autolike starting — ${users.length} user(s), top ${config.postsToCheck} posts, ` +
      `poll every ${config.pollIntervalMinutes}m, headless=${config.headless}.`
  );

  context = await launchContext(config);
  await ensureLoggedIn(context, config);

  if (LOGIN_ONLY) {
    log.info("Login-only mode: session is ready. Exiting.");
    await shutdown(0);
    return;
  }

  if (users.length === 0) {
    log.warn("No users in users.txt — add some usernames and restart.");
    await shutdown(0);
    return;
  }

  const state = State.load();

  if (SEED) {
    await seed(context, config, users, state);
    await shutdown(0);
    return;
  }

  for (;;) {
    if (shuttingDown) return;
    await waitUntilActive(config);
    if (shuttingDown) return;

    const startedAt = Date.now();
    log.info("=== Starting poll cycle ===");
    try {
      await runCycle(context, config, users, state);
    } catch (err) {
      log.error(`Cycle error: ${(err as Error).message}`);
    }
    log.info(`=== Cycle done in ${fmtDuration(Date.now() - startedAt)} ===`);

    if (RUN_ONCE) {
      log.info("--once specified; exiting after one cycle.");
      await shutdown(0);
      return;
    }

    const waitMs = jitter(config.pollIntervalMinutes, config.pollJitterPercent) * 60 * 1000;
    log.info(`Next cycle in ${fmtDuration(waitMs)}.`);
    await interruptibleSleep(waitMs);
  }
}

/** Sleep that wakes early on shutdown, checking every few seconds. */
async function interruptibleSleep(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !shuttingDown) {
    await sleep(Math.min(5000, end - Date.now()));
  }
}

/** Block until inside the active-hours window. */
async function waitUntilActive(config: Config_): Promise<void> {
  let announced = false;
  for (;;) {
    if (shuttingDown) return;
    const wait = msUntilActive(new Date(), config.activeHours);
    if (wait <= 0) return;
    if (!announced) {
      const openAt = config.activeHours?.start ?? "??";
      log.info(`Outside active hours — sleeping ~${fmtDuration(wait)} until ${openAt}.`);
      announced = true;
    }
    await interruptibleSleep(Math.min(wait, 5 * 60 * 1000));
  }
}

/**
 * Seed mode: mark every user's current recent posts as already-liked, without
 * liking anything. Lets the loop start clean so only NEW posts get liked.
 */
async function seed(
  context: BrowserContext,
  config: Config_,
  users: string[],
  state: State
): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  let total = 0;
  for (const username of users) {
    if (shuttingDown) return;
    try {
      const codes = await getRecentShortcodes(
        page,
        username,
        config.postsToCheck,
        config.skipReels
      );
      const added = state.markSeen(codes);
      total += added;
      log.info(`@${username}: marked ${added} existing post(s) as seen.`);
    } catch (err) {
      log.error(`@${username}: seed failed: ${(err as Error).message}`);
    }
    await humanDelay([8, 20]); // gentle profile browsing pace
  }
  log.info(
    `Seed complete: ${total} post(s) marked as already-liked. ` +
      `From now on only NEW posts will be liked.`
  );
}

main().catch(async (err) => {
  log.error(`Fatal: ${(err as Error).stack ?? err}`);
  await shutdown(1);
});
