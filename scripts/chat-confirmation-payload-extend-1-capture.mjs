#!/usr/bin/env node
/**
 * CHAT-CONFIRMATION-PAYLOAD-EXTEND-1 — web screenshot capture for the
 * enriched booking confirmation card.
 *
 * Run: node scripts/chat-confirmation-payload-extend-1-capture.mjs
 *
 * Requires apps/web running on http://localhost:3000 (override via
 * LUMO_WEB_URL=...). The fixture page at /fixtures/confirmation-card
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
  "docs/notes/chat-confirmation-payload-extend-1-screenshots",
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
      await page.goto(`${baseURL}/fixtures/confirmation-card`, {
        waitUntil: "networkidle",
      });
      await page.evaluate((t) => {
        document.documentElement.setAttribute("data-theme", t);
      }, theme);
      await page.getByText("Prefilled from approved profile").waitFor({
        timeout: 5000,
      });
      const out = path.join(outDir, `confirmation-card-${theme}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`  → confirmation-card-${theme}`);
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
