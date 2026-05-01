#!/usr/bin/env node
/**
 * CHAT-FLIGHT-SELECT-CLICKABLE-1 — web screenshot capture for
 * FlightOffersSelectCard in its post-tap "Selected" state.
 *
 * Run: node scripts/chat-flight-select-clickable-1-capture.mjs
 *
 * Requires apps/web running on http://localhost:3000 (override via
 * LUMO_WEB_URL=...). The fixture page at /fixtures/flight-offers
 * auto-picks the Frontier row on mount, so the capture lands the
 * post-tap visual state without playwright having to script the
 * click itself.
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(
  repoRoot,
  "docs/notes/chat-flight-select-clickable-1-screenshots",
);
const baseURL = process.env.LUMO_WEB_URL ?? "http://localhost:3000";

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const theme of ["light", "dark"]) {
      const ctx = await browser.newContext({
        viewport: { width: 900, height: 900 },
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/fixtures/flight-offers`, {
        waitUntil: "networkidle",
      });
      await page.evaluate((t) => {
        document.documentElement.setAttribute("data-theme", t);
      }, theme);
      // Wait for the auto-pick + the selected pill to render.
      await page
        .locator('[data-testid="flight-offers-row-off_frontier_midmorning-pill"]')
        .waitFor({ timeout: 5000 });
      await page.waitForTimeout(200);
      const out = path.join(outDir, `flight-offers-${theme}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`  → flight-offers-${theme}`);
      await ctx.close();
    }
    console.log(`\n[shots] all captured to ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
