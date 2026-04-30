/**
 * WEB-SCREENS-1 notification-preferences stub.
 *
 * Run: node --experimental-strip-types tests/web-screens-notif-prefs.test.mjs
 */

import assert from "node:assert/strict";
import {
  __resetForTesting,
  defaultPrefs,
  getPrefs,
  quietHoursIsActive,
  setPrefs,
  validatePrefsBody,
} from "../lib/notif-prefs-stub.ts";

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

console.log("\nweb-screens notification preferences");

t("authenticated render — getPrefs returns defaults for new user", () => {
  __resetForTesting();
  const p = getPrefs("user_new");
  assert.equal(p.master, true);
  assert.equal(p.categories.mission_update, true);
  assert.equal(p.categories.payment_receipt, true);
  assert.equal(p.categories.proactive_moment, true);
  assert.equal(p.categories.system, true);
  assert.equal(p.quiet_hours.enabled, false);
});

t("happy path — setPrefs persists and getPrefs returns the saved value", () => {
  __resetForTesting();
  const next = defaultPrefs();
  next.categories.proactive_moment = false;
  next.quiet_hours = { enabled: true, start_hh_local: 22, end_hh_local: 7 };
  setPrefs("user_a", next);
  const fetched = getPrefs("user_a");
  assert.equal(fetched.categories.proactive_moment, false);
  assert.equal(fetched.quiet_hours.enabled, true);
  assert.equal(fetched.quiet_hours.start_hh_local, 22);
});

t("scoped by user — user_b not affected by user_a writes", () => {
  __resetForTesting();
  const a = defaultPrefs();
  a.master = false;
  setPrefs("user_a", a);
  assert.equal(getPrefs("user_b").master, true);
});

t("error state — validator rejects malformed bodies", () => {
  assert.equal(validatePrefsBody(null), null);
  assert.equal(validatePrefsBody({ master: "yes" }), null);
  assert.equal(
    validatePrefsBody({
      master: true,
      categories: { mission_update: true },
      quiet_hours: { enabled: true, start_hh_local: 22, end_hh_local: 7 },
    }),
    null,
    "missing payment_receipt should reject",
  );
  assert.equal(
    validatePrefsBody({
      master: true,
      categories: {
        mission_update: true,
        payment_receipt: true,
        proactive_moment: true,
        system: true,
      },
      quiet_hours: { enabled: true, start_hh_local: 99, end_hh_local: 7 },
    }),
    null,
    "out-of-range hour should reject",
  );
});

t("validator clamps to ints and accepts a clean body", () => {
  const ok = validatePrefsBody({
    master: false,
    categories: {
      mission_update: false,
      payment_receipt: true,
      proactive_moment: false,
      system: true,
    },
    quiet_hours: { enabled: true, start_hh_local: 22.7, end_hh_local: 7.0 },
  });
  assert.ok(ok);
  assert.equal(ok.master, false);
  assert.equal(ok.quiet_hours.start_hh_local, 22);
  assert.equal(ok.quiet_hours.end_hh_local, 7);
});

t("quiet hours active for non-wraparound window 13→17", () => {
  const p = defaultPrefs();
  p.quiet_hours = { enabled: true, start_hh_local: 13, end_hh_local: 17 };
  assert.equal(quietHoursIsActive(p, 12), false);
  assert.equal(quietHoursIsActive(p, 13), true);
  assert.equal(quietHoursIsActive(p, 16), true);
  assert.equal(quietHoursIsActive(p, 17), false);
});

t("quiet hours active for wraparound window 22→7", () => {
  const p = defaultPrefs();
  p.quiet_hours = { enabled: true, start_hh_local: 22, end_hh_local: 7 };
  assert.equal(quietHoursIsActive(p, 23), true);
  assert.equal(quietHoursIsActive(p, 0), true);
  assert.equal(quietHoursIsActive(p, 6), true);
  assert.equal(quietHoursIsActive(p, 7), false);
  assert.equal(quietHoursIsActive(p, 12), false);
});

t("quiet hours disabled returns false even inside window", () => {
  const p = defaultPrefs();
  p.quiet_hours = { enabled: false, start_hh_local: 22, end_hh_local: 7 };
  assert.equal(quietHoursIsActive(p, 23), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
