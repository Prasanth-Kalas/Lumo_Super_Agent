/**
 * OAuth callback regression tests.
 *
 * Run: node --experimental-strip-types tests/oauth-callback.test.mjs
 */

import assert from "node:assert/strict";
import { hasRecentActiveOAuthConnection } from "../lib/oauth-callback.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\noauth callback");

t("suppresses duplicate invalid-state callback after a fresh successful connection", () => {
  const now = Date.parse("2026-04-26T10:00:00.000Z");
  assert.equal(
    hasRecentActiveOAuthConnection(
      [connection({ status: "active", connected_at: "2026-04-26T09:59:30.000Z" })],
      now,
    ),
    true,
  );
});

t("does not suppress stale invalid-state callbacks", () => {
  const now = Date.parse("2026-04-26T10:00:00.000Z");
  assert.equal(
    hasRecentActiveOAuthConnection(
      [connection({ status: "active", connected_at: "2026-04-26T09:55:00.000Z" })],
      now,
    ),
    false,
  );
});

t("does not treat revoked or malformed rows as recent success", () => {
  const now = Date.parse("2026-04-26T10:00:00.000Z");
  assert.equal(
    hasRecentActiveOAuthConnection(
      [
        connection({ status: "revoked", connected_at: "2026-04-26T09:59:30.000Z" }),
        connection({ status: "active", connected_at: "not-a-date" }),
      ],
      now,
    ),
    false,
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

function connection(overrides) {
  return {
    id: "conn_test",
    user_id: "00000000-0000-0000-0000-000000000001",
    agent_id: "google",
    status: "active",
    scopes: [],
    expires_at: null,
    provider_account_id: null,
    connected_at: "2026-04-26T10:00:00.000Z",
    last_refreshed_at: null,
    last_used_at: null,
    revoked_at: null,
    updated_at: "2026-04-26T10:00:00.000Z",
    ...overrides,
  };
}
