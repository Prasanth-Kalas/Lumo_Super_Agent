#!/usr/bin/env node
// db/build-run-all.mjs
//
// Concatenates db/migrations/*.sql in numeric order into db/run-all.sql.
// The combined file is what we paste into Supabase → SQL Editor → Run on
// a fresh install. Every migration is idempotent, so re-running on an
// existing DB is safe.
//
// Run after adding a new migration:  node db/build-run-all.mjs
//
// Output is stable for git diffs as long as migration filenames are.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, "migrations");
const outFile = path.join(__dirname, "run-all.sql");

function numericPrefix(name) {
  const m = /^(\d+)_/.exec(name);
  return m ? parseInt(m[1], 10) : 9999;
}

async function main() {
  const entries = await fs.readdir(migrationsDir);
  const sqlFiles = entries
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => numericPrefix(a) - numericPrefix(b));

  if (sqlFiles.length === 0) {
    console.error("No .sql files found in db/migrations/");
    process.exit(1);
  }

  const range = sqlFiles.map(numericPrefix);
  const lo = String(range[0]).padStart(3, "0");
  const hi = String(range[range.length - 1]).padStart(3, "0");

  const banner = `-- Lumo Super Agent — run-all migrations (generated)
-- Concatenation of db/migrations/${lo}...${hi} in order. Safe to re-run:
-- every CREATE uses IF NOT EXISTS and every ALTER uses ADD COLUMN IF NOT EXISTS.
-- Paste this whole file into Supabase → SQL Editor → Run.
--
-- DO NOT EDIT BY HAND. Regenerate via:  node db/build-run-all.mjs

`;

  const parts = [banner];
  for (const f of sqlFiles) {
    const body = await fs.readFile(path.join(migrationsDir, f), "utf8");
    parts.push(
      `-- ════════════════════════════════════════════════════════════════\n` +
      `-- db/migrations/${f}\n` +
      `-- ════════════════════════════════════════════════════════════════\n\n` +
      body.trimEnd() +
      "\n\n"
    );
  }

  await fs.writeFile(outFile, parts.join(""));
  console.log(`[run-all] wrote ${outFile} (${sqlFiles.length} migrations: ${lo}..${hi})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
