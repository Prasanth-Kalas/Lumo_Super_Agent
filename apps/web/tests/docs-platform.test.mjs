/**
 * DOCS sprint regression checks.
 *
 * Run: node --experimental-strip-types tests/docs-platform.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.stack ?? e.message}`);
  }
};

console.log("\ndocs platform");

await t("migration 042 carries feedback validation and service-role-only writes", () => {
  const sql = readFileSync("../../db/migrations/042_docs_feedback.sql", "utf8");
  assert.match(sql, /create table if not exists public\.docs_page_feedback/i);
  assert.match(sql, /score\s+smallint not null check \(score in \(-1,\s*1\)\)/i);
  assert.match(sql, /page_id.*~.*\^\[A-Za-z0-9\]/is);
  assert.match(sql, /revoke all on public\.docs_page_feedback from anon, authenticated/i);
  assert.match(sql, /DOCS_PAGE_FEEDBACK_APPEND_ONLY/);
});

await t("Docusaurus site mounts developer docs and TypeDoc API reference", () => {
  const config = readFileSync("../../apps/docs/docusaurus.config.ts", "utf8");
  const sidebars = readFileSync("../../apps/docs/sidebars.ts", "utf8");
  assert.match(config, /baseUrl:\s*"\/agents\/"/);
  assert.match(config, /path:\s*"\.\.\/\.\.\/docs\/developers"/);
  assert.match(config, /id:\s*"api"/);
  assert.match(config, /routeBasePath:\s*"reference\/api"/);
  assert.match(sidebars, /API reference/);
  assert.ok(existsSync("../../apps/docs/docs/reference/api/index.md"));
});

await t("developer docs include Phase 4 as-built behavior", () => {
  const platform = readFileSync("../../docs/developers/appstore-platform.md", "utf8");
  const publishing = readFileSync("../../docs/developers/publishing.md", "utf8");
  const examples = readFileSync("../../docs/developers/example-agents.md", "utf8");
  assert.match(platform, /agent_scope_grants/);
  assert.match(platform, /user_budget_tiers/);
  assert.match(platform, /TRUST-1 runs five automated checks/);
  assert.match(platform, /7-day error rate greater than 25%/);
  assert.match(publishing, /lumo-agent-bundle:v1/);
  assert.match(publishing, /ECDSA-P256/);
  assert.match(examples, /Weather Now/);
  assert.match(examples, /Daily Email Digest/);
  assert.match(examples, /Lumo Rentals Trip Planner/);
});

await t("feedback route and weekly digest cron are registered", () => {
  const feedback = readFileSync("app/api/docs/feedback/route.ts", "utf8");
  const cron = readFileSync("app/api/cron/docs-weekly-digest/route.ts", "utf8");
  const rootVercel = readFileSync("../../vercel.json", "utf8");
  const appVercel = readFileSync("vercel.json", "utf8");
  const ops = readFileSync("lib/ops.ts", "utf8");
  assert.match(feedback, /invalid_page_id/);
  assert.match(feedback, /docs_page_feedback/);
  assert.match(cron, /SLACK_WEBHOOK_AGENT_PLATFORM/);
  assert.match(cron, /recordCronRun/);
  for (const source of [rootVercel, appVercel, ops]) {
    assert.match(source, /docs-weekly-digest/);
  }
});

await t("publish and nightly workflows run docs generation and build", () => {
  const publish = readFileSync("../../.github/workflows/docs-publish.yml", "utf8");
  const nightly = readFileSync("../../.github/workflows/docs-quickstart-nightly.yml", "utf8");
  assert.match(publish, /npm run docs:api-ref/);
  assert.match(publish, /npm run docs:build/);
  assert.match(publish, /vercel deploy apps\/docs\/build/);
  assert.match(nightly, /docs-quickstart-e2e\.test\.mjs/);
  assert.match(nightly, /schedule:/);
});

if (fail > 0) {
  console.error(`\n${fail} docs platform test(s) failed`);
  process.exit(1);
}
console.log(`\n${pass} docs platform test(s) passed`);
