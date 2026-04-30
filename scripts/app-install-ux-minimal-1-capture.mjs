#!/usr/bin/env node
/**
 * APP-INSTALL-UX-MINIMAL-1 screenshot capture — LumoMissionCard in
 * default + expanded states, light + dark.
 *
 * Run: node scripts/app-install-ux-minimal-1-capture.mjs
 *
 * Requires: apps/web running on http://localhost:3000 (override via
 * LUMO_WEB_URL=...). The fixture page at /fixtures/mission-card is
 * public — no auth setup required. The capture script clicks the
 * Show details disclosure for the expanded variants so the same
 * fixture data drives both the minimal default and the full reveal.
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "docs/notes/app-install-ux-minimal-1-screenshots");
const baseURL = process.env.LUMO_WEB_URL ?? "http://localhost:3000";
const subdir = process.env.LUMO_SHOTS_SUBDIR ?? "";

async function main() {
  const targetDir = subdir ? path.join(outDir, subdir) : outDir;
  await mkdir(targetDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const variant of ["default", "expanded"]) {
      for (const theme of ["light", "dark"]) {
        const ctx = await browser.newContext({
          viewport: { width: 900, height: 1400 },
          colorScheme: theme,
        });
        const page = await ctx.newPage();
        await page.goto(`${baseURL}/fixtures/mission-card`, {
          waitUntil: "networkidle",
        });
        await page.evaluate((t) => {
          document.documentElement.setAttribute("data-theme", t);
        }, theme);
        // Wait for the card body to mount.
        await page.waitForSelector('[data-testid="mission-card.scope-summary"]', {
          timeout: 5000,
        });
        if (variant === "expanded") {
          // Toggle Show details. The disclosure may not exist in the
          // before-state capture; tolerate either selector path.
          const toggle = page.locator('[data-testid="mission-card.show-details"]');
          if (await toggle.count()) {
            await toggle.click();
            await page.waitForTimeout(200);
          }
        }
        await page.waitForTimeout(300);
        const out = path.join(targetDir, `card-${variant}-${theme}.png`);
        await page.screenshot({ path: out, fullPage: true });
        console.log(`  → card-${variant}-${theme}`);
        await ctx.close();
      }
    }
    console.log(`\n[shots] all captured to ${targetDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
