/**
 * AUTH-GATE-CI-GUARD-1 — production auth-gate bypass guard.
 *
 * Run: node --experimental-strip-types tests/auth-gate-ci-guard.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertAuthGateNotDisabledInProduction,
  isProductionAuthGateBypass,
} from "../lib/auth-gate-guard.ts";

const MIDDLEWARE_SRC = readFileSync(
  new URL("../middleware.ts", import.meta.url),
  "utf8",
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const BUILD_GUARD_SRC = readFileSync(
  new URL("../scripts/check-auth-gate-env.mjs", import.meta.url),
  "utf8",
);

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

console.log("\nauth gate CI guard");

t("throws when production build tries to disable auth gate", () => {
  const env = {
    NODE_ENV: "production",
    LUMO_WEB_DISABLE_AUTH_GATE: "1",
  };
  assert.equal(isProductionAuthGateBypass(env), true);
  assert.throws(
    () => assertAuthGateNotDisabledInProduction(env),
    /auth_gate_disabled_in_production/,
  );
});

t("allows local development to disable the auth gate", () => {
  const env = {
    NODE_ENV: "development",
    LUMO_WEB_DISABLE_AUTH_GATE: "1",
  };
  assert.equal(isProductionAuthGateBypass(env), false);
  assert.doesNotThrow(() => assertAuthGateNotDisabledInProduction(env));
});

t("allows production when the bypass flag is absent", () => {
  const env = { NODE_ENV: "production" };
  assert.equal(isProductionAuthGateBypass(env), false);
  assert.doesNotThrow(() => assertAuthGateNotDisabledInProduction(env));
});

t("middleware imports and invokes the guard before the bypass branch", () => {
  assert.match(
    MIDDLEWARE_SRC,
    /import \{ assertAuthGateNotDisabledInProduction \} from "@\/lib\/auth-gate-guard"/,
  );
  const guardIndex = MIDDLEWARE_SRC.indexOf("assertAuthGateNotDisabledInProduction();");
  const bypassIndex = MIDDLEWARE_SRC.indexOf('process.env.LUMO_WEB_DISABLE_AUTH_GATE === "1"');
  assert.ok(guardIndex > -1, "guard call not found");
  assert.ok(bypassIndex > -1, "bypass branch not found");
  assert.ok(guardIndex < bypassIndex, "guard must run before the bypass branch");
  assert.match(MIDDLEWARE_SRC, /for local bypass use NODE_ENV=development/);
});

t("build script runs the guard before next build", () => {
  assert.equal(
    PACKAGE_JSON.scripts.build,
    "node scripts/check-auth-gate-env.mjs && next build",
  );
  assert.match(BUILD_GUARD_SRC, /NODE_ENV === "production"/);
  assert.match(BUILD_GUARD_SRC, /LUMO_WEB_DISABLE_AUTH_GATE === "1"/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
