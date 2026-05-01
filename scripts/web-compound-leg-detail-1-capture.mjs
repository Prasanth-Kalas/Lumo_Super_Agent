#!/usr/bin/env node
/**
 * WEB-COMPOUND-LEG-DETAIL-1 — screenshot capture for the inline
 * compound-leg detail panel.
 *
 * Run: node scripts/web-compound-leg-detail-1-capture.mjs
 *
 * Requires apps/web running on http://localhost:3000 (override via
 * LUMO_WEB_URL=...). The fixture page at /fixtures/compound-leg-strip
 * is public and deterministic.
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
  "docs/notes/web-compound-leg-detail-1-screenshots",
);
const baseURL = process.env.LUMO_WEB_URL ?? "http://localhost:3000";

const shots = [
  { state: "pending", theme: "light", name: "leg-detail-pending-light.png", waitFor: "QUEUED" },
  { state: "in_flight", theme: "light", name: "leg-detail-in-flight-light.png", waitFor: "SEARCHING" },
  { state: "committed", theme: "light", name: "leg-detail-committed-light.png", waitFor: "CONFIRMED" },
  { state: "failed", theme: "light", name: "leg-detail-failed-light.png", waitFor: "FAILED" },
  {
    state: "manual_review",
    theme: "light",
    name: "leg-detail-manual-review-light.png",
    waitFor: "MANUAL REVIEW",
  },
  { state: "committed", theme: "dark", name: "leg-detail-committed-dark.png", waitFor: "CONFIRMED" },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const shot of shots) {
      const ctx = await browser.newContext({
        viewport: { width: 900, height: 760 },
        colorScheme: shot.theme,
      });
      const page = await ctx.newPage();
      const url = new URL("/fixtures/compound-leg-strip", baseURL);
      url.searchParams.set("state", shot.state);
      await page.goto(url.toString(), { waitUntil: "networkidle" });
      await page.evaluate((theme) => {
        document.documentElement.setAttribute("data-theme", theme);
      }, shot.theme);
      await page.getByText(shot.waitFor).first().waitFor({ timeout: 5000 });
      await page.screenshot({ path: path.join(outDir, shot.name), fullPage: false });
      console.log(`  -> ${shot.name}`);
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
