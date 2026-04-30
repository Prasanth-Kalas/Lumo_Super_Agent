/**
 * AUTH-OAUTH-1b — web OAuth wiring contract.
 *
 * Run: node --experimental-strip-types tests/auth-oauth-1b.test.mjs
 *
 * Covers three surfaces:
 *   1. buildOAuthRedirectTo pure helper — open-redirect guard,
 *      origin assembly, ?next= encoding.
 *   2. OAuthButtons component source — both buttons are rendered with
 *      the expected provider strings and accessibility identifiers.
 *   3. /login + /signup pages — OAuthButtons is mounted above the
 *      email form and the auth-callback route exchanges code for
 *      session with ?next= round-trip.
 *
 * The repo doesn't pull in a React renderer for unit tests, so the
 * component + page assertions read the source — same pattern as
 * web-screens-account.test.mjs and the WEB-REDESIGN-1 suites.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildOAuthRedirectTo,
} from "../lib/oauth-redirect.ts";

const ROOT = new URL("..", import.meta.url);
const OAUTH_BUTTONS = readFileSync(new URL("components/OAuthButtons.tsx", ROOT), "utf8");
const LOGIN = readFileSync(new URL("app/login/page.tsx", ROOT), "utf8");
const SIGNUP = readFileSync(new URL("app/signup/page.tsx", ROOT), "utf8");
const AUTH_CALLBACK = readFileSync(new URL("app/auth/callback/route.ts", ROOT), "utf8");

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

console.log("\nauth-oauth-1b — web wiring");

// ── buildOAuthRedirectTo ────────────────────────────────────────────────

t("redirectTo: default '/' next produces a clean callback URL", () => {
  assert.equal(
    buildOAuthRedirectTo("https://example.com", "/"),
    "https://example.com/auth/callback",
  );
});

t("redirectTo: encoded next round-trips via /auth/callback", () => {
  assert.equal(
    buildOAuthRedirectTo("https://example.com", "/marketplace/food"),
    "https://example.com/auth/callback?next=%2Fmarketplace%2Ffood",
  );
});

t("redirectTo: open-redirect guard rejects http(s) next", () => {
  assert.equal(
    buildOAuthRedirectTo("https://example.com", "https://evil.example.com/steal"),
    "https://example.com/auth/callback",
  );
});

t("redirectTo: open-redirect guard rejects protocol-relative next", () => {
  assert.equal(
    buildOAuthRedirectTo("https://example.com", "//evil.example.com/steal"),
    "https://example.com/auth/callback",
  );
});

t("redirectTo: open-redirect guard rejects empty / non-string next", () => {
  assert.equal(buildOAuthRedirectTo("https://example.com", ""), "https://example.com/auth/callback");
  // @ts-expect-error — exercising the runtime fallback
  assert.equal(buildOAuthRedirectTo("https://example.com", null), "https://example.com/auth/callback");
});

t("redirectTo: encoded next preserves query and hash", () => {
  assert.equal(
    buildOAuthRedirectTo("https://example.com", "/foo?bar=1&baz=2#hash"),
    "https://example.com/auth/callback?next=%2Ffoo%3Fbar%3D1%26baz%3D2%23hash",
  );
});

// ── OAuthButtons component source ──────────────────────────────────────

t("OAuthButtons: Continue with Google button with data-testid", () => {
  assert.match(OAUTH_BUTTONS, /data-testid="oauth-button-google"/);
  assert.match(OAUTH_BUTTONS, /Continue with Google/);
});

t("OAuthButtons: Continue with Apple button with data-testid", () => {
  assert.match(OAUTH_BUTTONS, /data-testid="oauth-button-apple"/);
  assert.match(OAUTH_BUTTONS, /Continue with Apple/);
});

t("OAuthButtons: invokes signInWithOAuth with provider", () => {
  assert.match(OAUTH_BUTTONS, /signInWithOAuth\(\{/);
  // Provider is parametric; the start() helper takes a provider arg.
  assert.match(OAUTH_BUTTONS, /provider,\s*\n?\s*options:/);
});

t("OAuthButtons: passes redirectTo built from buildOAuthRedirectTo", () => {
  assert.match(OAUTH_BUTTONS, /redirectTo:\s*buildOAuthRedirectTo\(origin,\s*next\)/);
});

t("OAuthButtons: divider 'or continue with email' below the buttons", () => {
  assert.match(OAUTH_BUTTONS, /or continue with email/);
});

// ── /login + /signup pages ─────────────────────────────────────────────

t("/login imports + mounts OAuthButtons", () => {
  assert.match(LOGIN, /import OAuthButtons from "@\/components\/OAuthButtons"/);
  assert.match(LOGIN, /<OAuthButtons next=\{next\}/);
});

t("/signup imports + mounts OAuthButtons", () => {
  assert.match(SIGNUP, /import OAuthButtons from "@\/components\/OAuthButtons"/);
  assert.match(SIGNUP, /<OAuthButtons next=\{next\}/);
});

t("/login mounts OAuthButtons ABOVE the email form", () => {
  const buttonsIdx = LOGIN.indexOf("<OAuthButtons");
  const formIdx = LOGIN.indexOf("<form onSubmit={onSubmit}");
  assert.ok(buttonsIdx > 0, "OAuthButtons not found");
  assert.ok(formIdx > 0, "email form not found");
  assert.ok(buttonsIdx < formIdx, "OAuthButtons must render above the email form");
});

t("/signup mounts OAuthButtons ABOVE the email form", () => {
  const buttonsIdx = SIGNUP.indexOf("<OAuthButtons");
  const formIdx = SIGNUP.indexOf("<form onSubmit={onSubmit}");
  assert.ok(buttonsIdx > 0, "OAuthButtons not found");
  assert.ok(formIdx > 0, "email form not found");
  assert.ok(buttonsIdx < formIdx, "OAuthButtons must render above the email form");
});

// ── /auth/callback route ───────────────────────────────────────────────

t("auth/callback exchanges code for session", () => {
  assert.match(AUTH_CALLBACK, /exchangeCodeForSession\(code\)/);
});

t("auth/callback honors ?next= and rejects open-redirect", () => {
  assert.match(AUTH_CALLBACK, /searchParams\.get\("next"\)/);
  // The route must guard absolute / protocol-relative `next` values
  // (only same-origin paths starting with "/" are allowed).
  assert.match(AUTH_CALLBACK, /next\.startsWith\("\/"\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
