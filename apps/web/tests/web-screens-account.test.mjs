/**
 * WEB-SCREENS-1 /settings/account contract — verifies the /api/me
 * route source contains the member_since field the page reads, and
 * that the logout route is a real POST endpoint (sign-out happy path
 * targets it). We don't render the page; the helpers are trivial.
 *
 * Run: node --experimental-strip-types tests/web-screens-account.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\nweb-screens account contract");

const ME_ROUTE = readFileSync(new URL("../app/api/me/route.ts", import.meta.url), "utf8");
const LOGOUT_ROUTE = readFileSync(
  new URL("../app/api/auth/logout/route.ts", import.meta.url),
  "utf8",
);
const PROFILE_ROUTE = readFileSync(
  new URL("../app/api/memory/profile/route.ts", import.meta.url),
  "utf8",
);
const PAGE = readFileSync(
  new URL("../app/settings/account/page.tsx", import.meta.url),
  "utf8",
);

t("authenticated render — /api/me exposes member_since", () => {
  assert.match(ME_ROUTE, /member_since/);
  assert.match(ME_ROUTE, /user\.created_at/);
});

t("authenticated render — /api/memory/profile now answers GET", () => {
  assert.match(PROFILE_ROUTE, /export async function GET/);
});

t("empty state — page handles null member_since with em-dash", () => {
  assert.match(PAGE, /member_since[\s\S]*"—"/);
});

t("error state — page renders error banner on fetch failure", () => {
  assert.match(PAGE, /role="alert"/);
});

t("happy path — sign-out posts to /api/auth/logout and redirects", () => {
  assert.match(PAGE, /\/api\/auth\/logout/);
  assert.match(PAGE, /method:\s*"POST"/);
  assert.match(PAGE, /window\.location\.assign\("\/login"\)/);
});

t("logout route is POST-only (no GET handler)", () => {
  assert.match(LOGOUT_ROUTE, /export async function POST/);
  assert.equal(/export async function GET/.test(LOGOUT_ROUTE), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
