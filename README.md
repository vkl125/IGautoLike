# ig-autolike

Auto-likes the most recent posts of a list of Instagram users. It drives a **real
Chromium browser session** via Playwright (no unofficial API), polls on a gentle
interval, and rate-limits itself to reduce the chance of being locked out.

## How it works

- Logs in **once, manually**, in a real browser window. The session is saved to a
  persistent browser profile under `storage/`, so 2FA and checkpoints are handled
  by you, the human — the safest path against lockouts.
- On each poll cycle it visits every user in `users.txt`, reads their newest
  `postsToCheck` posts, and likes any it hasn't liked before.
- It remembers what it liked (`storage/state.json`) so it never re-likes, and it
  honors hourly/daily caps and randomized human-like delays.

## Setup

```bash
npm install
```

Playwright's Chromium is already installed on this machine. If it ever complains,
run `npx playwright install chromium`.

## 1. Log in (one time)

```bash
npm run login
```

A browser opens. Log in to Instagram by hand (including any 2FA). Once the app
detects the session it saves it and exits.

## 2. Add target users

Put your accounts in **`users.local.txt`** (one per line — bare handle,
`@handle`, or full profile URL all work). The app reads `users.local.txt` if it
exists and falls back to `users.txt` otherwise. `users.local.txt` is git-ignored,
so your real list never gets committed; `users.txt` stays a public placeholder.

```bash
cp users.txt users.local.txt   # then edit users.local.txt with your accounts
```

## 3. Seed (recommended, one time)

Mark every user's *current* posts as already-liked so the app doesn't fire off a
big like spike on first run. Afterwards it only likes genuinely **new** posts:

```bash
npm run seed
```

(Skip this only if you actually want it to like the existing backlog.)

## 4. Run

```bash
npm start          # continuous polling loop
npm run once       # single pass, then exit (good for cron)
```

Stop with `Ctrl+C` — it shuts down cleanly and keeps its state.

## Configuration (`config.json`)

| Key | Meaning |
| --- | --- |
| `postsToCheck` | How many recent posts to inspect per user (default 10). |
| `pollIntervalMinutes` | Wait between full cycles. |
| `headless` | `false` recommended (a visible browser looks more human). Set `true` only after the session exists. |
| `maxLikesPerHour` / `maxLikesPerDay` | Hard rate caps; the app pauses when hit. |
| `delaySecondsBetweenLikes` | `[min, max]` random pause between likes. |
| `delaySecondsBetweenUsers` | `[min, max]` random pause between users. |
| `skipReels` | If `true`, only like grid photos/carousels, not reels. |
| `loginTimeoutMinutes` | How long the manual-login window waits. |
| `activeHours` | `{ "start": "09:00", "end": "23:00" }` — only operates in this local-time window; idles overnight. Set to `null` to run 24/7. Overnight windows (e.g. `22:00`→`06:00`) are supported. |
| `pollJitterPercent` | Randomly varies the poll interval by ± this percent (e.g. `40` → a 45-min interval becomes ~27–63 min) so cycles aren't clockwork. |

## Fingerprint hardening

`src/stealth.ts` is injected into every page to present a coherent **Linux
desktop Chrome on real Intel hardware** identity — masking the software (WSL)
GPU, advertising Google Chrome client-hint brands, setting `deviceMemory`, and
keeping `navigator.webdriver` false. It deliberately does **not** fake a
different OS: a UA/platform/GPU that contradict each other are a bigger giveaway
than being consistently what we are. Behavior (pacing, caps, hours) still matters
more than fingerprint for staying unblocked.

Residual limits (low risk for IG, listed for honesty): the WebGL *renderer
string* is masked but rendered pixels still come from software; Playwright drives
via CDP, which advanced detectors can probe; and the Linux font set differs from
a typical Windows machine.

## Notes & caveats

- **Private accounts** are only visible if the logged-in account follows them.
- This automates your own account. Instagram's Terms prohibit automation, and
  aggressive use can get an account action-blocked or banned. The conservative
  defaults (slow polling, low caps, real browser, manual login) exist to keep it
  gentle, but use at your own risk and keep the caps modest.
- Files under `storage/` (your session + like history) are git-ignored. Treat the
  browser profile like a password — it grants access to the logged-in account.
