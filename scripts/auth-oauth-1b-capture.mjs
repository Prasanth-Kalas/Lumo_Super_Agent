#!/usr/bin/env node
/**
 * AUTH-OAUTH-1b screenshot capture — login + signup, light + dark.
 *
 * Run: node scripts/auth-oauth-1b-capture.mjs
 *
 * Requires: apps/web running on http://localhost:3000 (override via
 * LUMO_WEB_URL=...) with NEXT_PUBLIC_SUPABASE_URL +
 * NEXT_PUBLIC_SUPABASE_ANON_KEY set so the form actually renders the
 * OAuth buttons + email fields rather than the env-not-configured
 * fallback. Mirrors the WEB-REDESIGN-1 capture pattern.
 */

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "docs/notes/auth-oauth-1b-screenshots");
const baseURL = process.env.LUMO_WEB_URL ?? "http://localhost:3000";

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const page of ["login", "signup"]) {
      for (const theme of ["light", "dark"]) {
        const ctx = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: theme,
        });
        const tab = await ctx.newPage();
        await tab.goto(`${baseURL}/${page}`, { waitUntil: "networkidle" });
        await tab.evaluate((t) => {
          document.documentElement.setAttribute("data-theme", t);
        }, theme);
        // Allow hydration to land so the OAuth buttons + form replace
        // the static skeleton fallback.
        await tab.waitForSelector('[data-testid="oauth-button-google"]', {
          timeout: 5000,
        });
        await tab.waitForTimeout(400);
        const out = path.join(outDir, `${page}-${theme}.png`);
        await tab.screenshot({ path: out, fullPage: false });
        console.log(`  → ${page}-${theme}`);
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
