import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { STORAGE_DIR } from "./config.js";
import type { Config } from "./config.js";
import { log } from "./logger.js";
import { sleep, randInt } from "./util.js";
import { STEALTH_SCRIPT } from "./stealth.js";

const BASE = "https://www.instagram.com";
const USER_DATA_DIR = join(STORAGE_DIR, "browser-profile");

export async function launchContext(config: Config): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: config.headless,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "Asia/Hong_Kong",
    // Drop the flag that adds the "controlled by automated software" signal.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  // Inject fingerprint hardening into every page before its scripts run.
  await context.addInitScript(STEALTH_SCRIPT);
  return context;
}

async function isLoggedIn(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(BASE);
  const sid = cookies.find((c) => c.name === "sessionid");
  return Boolean(sid && sid.value);
}

/**
 * Make sure we have a logged-in session. With a persistent profile this is a
 * one-time manual step: the browser opens, the user logs in (handling 2FA /
 * checkpoints by hand — the safest path), and the session is reused afterwards.
 */
export async function ensureLoggedIn(
  context: BrowserContext,
  config: Config
): Promise<void> {
  if (await isLoggedIn(context)) {
    log.info("Existing Instagram session found — reusing it.");
    return;
  }

  if (config.headless) {
    throw new Error(
      "No saved session and headless=true. Run `npm run login` once (headed) " +
        "to log in by hand, then switch headless back on."
    );
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE}/accounts/login/`, { waitUntil: "domcontentloaded" });
  await dismissPopups(page);

  log.warn("Not logged in. Please log in manually in the opened browser window.");
  log.warn("Handle any 2FA / verification prompts yourself, then wait here.");

  const deadline = Date.now() + config.loginTimeoutMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(context)) {
      log.info("Login detected — session saved to the browser profile.");
      await sleep(2000);
      return;
    }
    await sleep(3000);
  }
  throw new Error(
    `Login not completed within ${config.loginTimeoutMinutes} minutes.`
  );
}

/** Dismiss the common interstitials IG throws up (cookies, save-login, notifications). */
async function dismissPopups(page: Page): Promise<void> {
  const labels = [
    "Allow all cookies",
    "Only allow essential cookies",
    "Not Now",
    "Not now",
    "Dismiss",
  ];
  for (const label of labels) {
    try {
      const btn = page.getByRole("button", { name: label, exact: false });
      if (await btn.first().isVisible({ timeout: 800 })) {
        await btn.first().click({ timeout: 1500 });
        await sleep(500);
      }
    } catch {
      // not present — fine
    }
  }
}

/** Return the shortcodes of a user's most recent posts, newest first. */
export async function getRecentShortcodes(
  page: Page,
  username: string,
  limit: number,
  skipReels: boolean
): Promise<string[]> {
  await page.goto(`${BASE}/${username}/`, { waitUntil: "domcontentloaded" });
  await dismissPopups(page);

  // Profile not found / unavailable.
  const notFound = await page
    .getByText("Sorry, this page isn't available.", { exact: false })
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (notFound) {
    log.warn(`@${username}: profile not available (renamed, removed, or wrong handle).`);
    return [];
  }

  // Private account we don't follow shows no post grid.
  const isPrivate = await page
    .getByText("This account is private", { exact: false })
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (isPrivate) {
    log.warn(`@${username}: account is private and not followed — cannot see posts.`);
    return [];
  }

  // Let the grid render.
  await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 8000 })
    .catch(() => {});

  const hrefs: string[] = await page.$$eval(
    'a[href*="/p/"], a[href*="/reel/"]',
    (anchors) => anchors.map((a) => (a as HTMLAnchorElement).getAttribute("href") || "")
  );

  const shortcodes: string[] = [];
  for (const href of hrefs) {
    const m = href.match(/\/(p|reel)\/([^/]+)\//);
    if (!m) continue;
    if (skipReels && m[1] === "reel") continue;
    const code = m[2];
    if (!shortcodes.includes(code)) shortcodes.push(code);
    if (shortcodes.length >= limit) break;
  }
  return shortcodes;
}

export type LikeResult = "liked" | "already-liked" | "failed";

// The post's own action-bar heart renders at 24px; the small hearts next to
// each comment are 16px. Selecting on size is how we avoid liking a comment
// (or a "more posts" suggestion) instead of the post itself.
const MAIN_LIKE = 'svg[aria-label="Like"][height="24"]';
const MAIN_UNLIKE = 'svg[aria-label="Unlike"][height="24"]';

/** Open a post and like it if not already liked. */
export async function likePost(page: Page, shortcode: string): Promise<LikeResult> {
  try {
    await page.goto(`${BASE}/p/${shortcode}/`, { waitUntil: "domcontentloaded" });
    await dismissPopups(page);

    // Wait for the post's action bar (the 24px heart, liked or not) to render.
    await page
      .locator(`${MAIN_LIKE}, ${MAIN_UNLIKE}`)
      .first()
      .waitFor({ state: "visible", timeout: 8000 });

    // Already liked? The main heart is filled ("Unlike").
    if (await isMainLiked(page)) {
      return "already-liked";
    }

    const like = page.locator(MAIN_LIKE).first();
    await like.waitFor({ state: "visible", timeout: 6000 });
    await sleep(randInt(600, 1800)); // small human-ish pause before acting

    // Click the actual button wrapping the heart; the <svg> itself usually has
    // pointer-events disabled.
    const button = like.locator(
      'xpath=ancestor::*[self::button or @role="button"][1]'
    );
    if (await button.count()) {
      await button.first().click({ timeout: 4000 });
    } else {
      await like.click({ timeout: 4000 });
    }

    if (await confirmMainLiked(page)) return "liked";

    // Fallback: double-tap the media (how a human likes on web/mobile).
    const media = page.locator("article img[srcset], article video, main img[srcset], main video").first();
    if (await media.count()) {
      await media.dblclick({ timeout: 4000 }).catch(() => {});
      if (await confirmMainLiked(page)) return "liked";
    }

    log.warn(`${shortcode}: clicked Like but couldn't confirm it registered.`);
    return "failed";
  } catch (err) {
    log.error(`Failed to like ${shortcode}: ${(err as Error).message}`);
    return "failed";
  }
}

/** Is the post's main heart currently filled (liked)? */
async function isMainLiked(page: Page): Promise<boolean> {
  return page
    .locator(MAIN_UNLIKE)
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
}

/** Wait briefly for the like to register (main heart flips to filled). */
async function confirmMainLiked(page: Page): Promise<boolean> {
  return page
    .locator(MAIN_UNLIKE)
    .first()
    .waitFor({ state: "visible", timeout: 6000 })
    .then(() => true)
    .catch(() => false);
}
