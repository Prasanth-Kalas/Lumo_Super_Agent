#!/usr/bin/env node
/**
 * web-capture-screenshots.mjs — playwright-driven web screenshot capture.
 *
 * Captures the WEB-REDESIGN-1 visual gates:
 *   01-login-signed-out (light + dark)
 *   02-chat-empty-signed-in (light + dark)
 *   03-chat-with-recents (light + dark)
 *   04-mobile-drawer (light + dark)
 *
 * Run: node scripts/web-capture-screenshots.mjs
 *
 * Requires:
 *   - apps/web running on http://localhost:3000 (start it via
 *     `cd apps/web && npm run dev` in another terminal first).
 *   - playwright + chromium installed (npm install --save-dev playwright
 *     && npx playwright install chromium).
 *
 * Auth strategy: the web app's middleware short-circuits when Supabase
 * isn't configured, so an unconfigured dev server renders / as the
 * chat shell without bouncing to /login. The "signed-in" shots use
 * route mocking — /api/me returns a fake user, /api/history returns
 * three fixture sessions for the recents shot. This keeps production
 * code out of the fixture business.
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "docs/notes/web-redesign-1-screenshots");
const baseURL = process.env.LUMO_WEB_URL ?? "http://localhost:3000";
const FIXED_NOW = Date.parse("2026-05-02T12:00:00.000Z");

const FAKE_ME = {
  user: {
    id: "fixture-user",
    email: "alex@example.com",
    full_name: "Alex Kim",
    first_name: "Alex",
    member_since: "2025-09-04T00:00:00Z",
  },
};

const FAKE_HISTORY = {
  sessions: [
    {
      session_id: "sess-vegas",
      preview: "Plan a weekend trip to Vegas next month",
      started_at: "2026-04-29T18:00:00Z",
      last_activity_at: "2026-04-30T12:30:00Z",
      user_message_count: 4,
      trip_ids: ["trp-vegas"],
    },
    {
      session_id: "sess-sushi",
      preview: "Find a Japanese restaurant near work",
      started_at: "2026-04-30T08:00:00Z",
      last_activity_at: "2026-04-30T08:14:00Z",
      user_message_count: 2,
      trip_ids: [],
    },
    {
      session_id: "sess-sfo",
      preview: "Rebook the SFO→LAX flight",
      started_at: "2026-04-29T22:30:00Z",
      last_activity_at: "2026-04-29T22:35:00Z",
      user_message_count: 3,
      trip_ids: ["trp-sfo"],
    },
  ],
  trips: [],
};

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    await captureLoginSignedOut(browser);
    await captureChatEmptySignedIn(browser);
    await captureChatWithRecents(browser);
    await captureMobileDrawer(browser);
    console.log(`\n[shots] all captured to ${outDir}`);
  } finally {
    await browser.close();
  }
}

async function captureLoginSignedOut(browser) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    await page.goto(`${baseURL}/login`, { waitUntil: "networkidle" });
    await applyTheme(page, theme);
    await page.waitForTimeout(400);
    const out = path.join(outDir, `01-login-signed-out-${theme}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`  → 01-login-signed-out-${theme}`);
    await ctx.close();
  }
}

async function captureChatEmptySignedIn(browser) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    await mockAuthedShell(page, { history: { sessions: [] } });
    await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
    await applyTheme(page, theme);
    await page.waitForTimeout(800);
    const out = path.join(outDir, `02-chat-empty-signed-in-${theme}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`  → 02-chat-empty-signed-in-${theme}`);
    await ctx.close();
  }
}

async function captureChatWithRecents(browser) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    await mockAuthedShell(page, { history: FAKE_HISTORY });
    await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
    await applyTheme(page, theme);
    await page.waitForTimeout(800);
    const out = path.join(outDir, `03-chat-with-recents-${theme}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`  → 03-chat-with-recents-${theme}`);
    await ctx.close();
  }
}

async function captureMobileDrawer(browser) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: 380, height: 820 },
      colorScheme: theme,
    });
    const page = await ctx.newPage();
    await mockAuthedShell(page, { history: FAKE_HISTORY });
    await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
    await applyTheme(page, theme);
    await page.waitForTimeout(500);
    // Click the hamburger to open the drawer.
    await page.locator('button[aria-label="Open menu"]').click();
    await page.waitForTimeout(500);
    const out = path.join(outDir, `04-mobile-drawer-${theme}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`  → 04-mobile-drawer-${theme}`);
    await ctx.close();
  }
}

async function mockAuthedShell(page, opts = {}) {
  const history = opts.history ?? { sessions: [] };
  await freezeDate(page, FIXED_NOW);
  // /api/me — pretend a user is signed in.
  await page.route("**/api/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(FAKE_ME),
    }),
  );
  // /api/history — drives the recents list.
  await page.route("**/api/history**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(history),
    }),
  );
  // Other endpoints LeftRail / page.tsx hit on mount — return empty
  // shapes so the spinner doesn't linger. Using a catch-all here would
  // be too broad; list the ones we know about.
  for (const stub of [
    {
      pat: "**/api/memory",
      // Setting home_address suppresses LocationPrompt so the empty
      // chat surface doesn't get occluded by the post-sign-in card.
      body: {
        profile: {
          display_name: "Alex Kim",
          home_address: { city: "San Francisco", country: "US" },
        },
        facts: [],
        patterns: [],
      },
    },
    { pat: "**/api/registry", body: { agents: [] } },
    { pat: "**/api/connections", body: { connections: [] } },
    { pat: "**/api/proactive/recent", body: { moments: [] } },
    { pat: "**/api/notifications", body: { notifications: [], unread_count: 0 } },
  ]) {
    await page.route(stub.pat, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(stub.body),
      }),
    );
  }
}

async function freezeDate(page, fixedNow) {
  await page.addInitScript((now) => {
    const OriginalDate = Date;
    class FixedDate extends OriginalDate {
      constructor(...args) {
        if (args.length === 0) {
          super(now);
        } else {
          super(...args);
        }
      }
      static now() {
        return now;
      }
    }
    FixedDate.parse = OriginalDate.parse;
    FixedDate.UTC = OriginalDate.UTC;
    FixedDate.prototype = OriginalDate.prototype;
    globalThis.Date = FixedDate;
  }, fixedNow);
}

async function applyTheme(page, theme) {
  // The Lumo app reads `data-theme` on <html>; flipping it forces
  // either light or dark regardless of system setting.
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
