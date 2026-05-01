#!/usr/bin/env node
/**
 * WEB-RECENTS-TIMESTAMP-PORT-1 — screenshot capture for the desktop
 * left rail with compact recents timestamps.
 *
 * Run: node scripts/web-recents-timestamp-port-capture.mjs
 *
 * Requires apps/web running on http://localhost:3000 (override via
 * LUMO_WEB_URL=...). The fixture page is public and this script
 * intercepts /api/history + /api/me for deterministic rows.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const requireFromWeb = createRequire(
  path.join(repoRoot, "apps/web/package.json"),
);
const { chromium } = requireFromWeb("playwright");
const outDir = path.join(
  repoRoot,
  "docs/notes/web-recents-timestamp-port-1-screenshots",
);
const baseURL = process.env.LUMO_WEB_URL ?? "http://localhost:3000";
const now = Date.parse("2026-05-02T12:00:00.000Z");

const sessions = [
  {
    session_id: "session_recent_1",
    preview: "Vegas trip with flight and hotel",
    last_activity_at: new Date(now - (12 * 60 + 3) * 1000).toISOString(),
    trip_ids: ["trip_vegas"],
  },
  {
    session_id: "session_recent_2",
    preview: "SFO to LAX next Friday",
    last_activity_at: new Date(now - (4 * 60 + 8) * 60 * 1000).toISOString(),
    trip_ids: [],
  },
  {
    session_id: "session_recent_3",
    preview: "Japanese restaurant near SoHo",
    last_activity_at: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
    trip_ids: ["trip_food", "trip_table"],
  },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1180, height: 760 },
      colorScheme: "light",
    });
    const page = await ctx.newPage();
    await page.addInitScript((fixedNow) => {
      const OriginalDate = Date;
      class FixedDate extends OriginalDate {
        constructor(...args) {
          if (args.length === 0) {
            super(fixedNow);
          } else {
            super(...args);
          }
        }
        static now() {
          return fixedNow;
        }
      }
      // Keep parse/UTC semantics identical to the native Date object.
      FixedDate.parse = OriginalDate.parse;
      FixedDate.UTC = OriginalDate.UTC;
      FixedDate.prototype = OriginalDate.prototype;
      globalThis.Date = FixedDate;
    }, now);
    await page.route("**/api/history**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions, trips: [] }),
      });
    });
    await page.route("**/api/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            email: "dev@lumo.local",
            full_name: "Prasanth Kalas",
            first_name: "Prasanth",
          },
        }),
      });
    });

    await page.goto(`${baseURL}/fixtures/recents-timestamps`, {
      waitUntil: "networkidle",
    });
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("lumo-theme", "light");
    });
    await page.getByText("12 min, 3 sec").waitFor({ timeout: 5000 });
    await page.screenshot({
      path: path.join(outDir, "left-rail-recents-timestamps-light.png"),
      fullPage: false,
    });
    console.log(`  -> left-rail-recents-timestamps-light.png`);
    await ctx.close();
    console.log(`\n[shots] captured to ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
