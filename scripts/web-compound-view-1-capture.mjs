#!/usr/bin/env node
/**
 * WEB-COMPOUND-VIEW-1 — screenshot capture for the inline compound
 * leg strip.
 *
 * Run: node scripts/web-compound-view-1-capture.mjs
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
  "docs/notes/web-compound-view-1-screenshots",
);
const baseURL = process.env.LUMO_WEB_URL ?? "http://localhost:3000";

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const theme of ["light", "dark"]) {
      for (const state of ["dispatch", "settled"]) {
        const ctx = await browser.newContext({
          viewport: { width: 900, height: 760 },
          colorScheme: theme,
        });
        const page = await ctx.newPage();
        const url = new URL("/fixtures/compound-leg-strip", baseURL);
        if (state === "settled") url.searchParams.set("state", "settled");
        await page.goto(url.toString(), { waitUntil: "networkidle" });
        await page.evaluate((t) => {
          document.documentElement.setAttribute("data-theme", t);
        }, theme);
        await page.getByText("Multi-agent dispatch").waitFor({ timeout: 5000 });
        const out = path.join(outDir, `compound-${state}-${theme}.png`);
        await page.screenshot({ path: out, fullPage: false });
        console.log(`  → compound-${state}-${theme}`);
        await ctx.close();
      }
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
