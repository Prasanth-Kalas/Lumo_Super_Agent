/**
 * APP-INSTALL-UX-MINIMAL-1 — LumoMissionCard contract tests.
 *
 * Run: node --experimental-strip-types tests/app-install-ux-minimal-1.test.mjs
 *
 * Two kinds of assertions:
 *   1. Pure-helper tests against the exported `scopeSummary` —
 *      condensed one-line copy must read naturally for 0 / 1 / 2 / 3 /
 *      4+ fields and clamp at "and N more".
 *   2. Source-level structural tests on LumoMissionCard.tsx — assert
 *      the default render no longer exposes the removed-from-default
 *      sections and that they sit behind the Show details gate. This
 *      mirrors the existing web-redesign-mobile-nav / web-screens-account
 *      pattern (the repo doesn't ship a React renderer for unit tests).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scopeSummary } from "../lib/lumo-mission-card-helpers.ts";

const SRC = readFileSync(
  new URL("../components/LumoMissionCard.tsx", import.meta.url),
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

console.log("\napp-install-ux-minimal-1 — LumoMissionCard");

const proposalWithFields = (fields) => ({
  agent_id: "test",
  display_name: "Test",
  one_liner: "x",
  capability_label: "x",
  marketplace_url: "/x",
  action: "install",
  can_auto_install: true,
  permission_title: "x",
  permission_copy: "x",
  profile_fields_requested: fields,
  required_scopes: [],
  requires_payment: false,
  rank_score: null,
  rank_reasons: [],
  risk_badge: null,
});

// ── scopeSummary ──────────────────────────────────────────────────────

t("scopeSummary: empty fields → 'Won't access your profile'", () => {
  assert.equal(scopeSummary(proposalWithFields([])), "Won't access your profile");
});

t("scopeSummary: 1 field → 'Will see: name'", () => {
  assert.equal(scopeSummary(proposalWithFields(["name"])), "Will see: name");
});

t("scopeSummary: 2 fields → 'Will see: name and email'", () => {
  assert.equal(
    scopeSummary(proposalWithFields(["name", "email"])),
    "Will see: name and email",
  );
});

t("scopeSummary: 3 fields → Oxford-comma phrasing", () => {
  assert.equal(
    scopeSummary(proposalWithFields(["name", "email", "payment method"])),
    "Will see: name, email, and payment method",
  );
});

t("scopeSummary: 4+ fields → first two + 'and N more'", () => {
  assert.equal(
    scopeSummary(
      proposalWithFields(["name", "email", "payment method", "address", "phone"]),
    ),
    "Will see: name, email, and 3 more",
  );
});

// ── Default render: removed sections must be gated by showDetails ─────

t("removed sections are gone from default — only render under showDetails", () => {
  // Each section has a literal header. Confirm the only occurrence is
  // inside a `showDetails && …` ternary so the default render hides it.
  for (const [label, header] of [
    ["alternatives", "Ranked app matches"],
    ["itinerary", "Optimized itinerary"],
    ["questions", "Questions before execution"],
    ["confirmation-points", "Confirmation points"],
  ]) {
    const regex = new RegExp(`showDetails && [\\s\\S]{0,400}?${header}`);
    assert.match(SRC, regex, `${label} (header "${header}") should sit inside a showDetails && … block`);
  }
});

t("'Show details' disclosure button rendered with a useState hook", () => {
  assert.match(SRC, /useState<boolean>\(false\)/);
  // The toggle copy lives inside a JSX children expression with
  // surrounding whitespace; match leniently.
  assert.match(SRC, /\{showDetails \? "Hide details" : "Show details"\}/);
  assert.match(SRC, /data-testid="mission-card\.show-details"/);
});

t("default proposal block exposes one-line scope summary, not the chip list", () => {
  // The scope-summary line is unconditional; the chip list lives under
  // a `showDetails ? …` gate per proposal.
  assert.match(SRC, /data-testid="mission-card\.scope-summary"/);
  // The chip-list block + permission_copy + rank line must sit inside
  // a `showDetails ? …` ternary inside the per-proposal block — the
  // permission_copy / rank_score / profile_fields_requested triplet
  // appears in that order under a single ternary gate.
  assert.match(
    SRC,
    /showDetails \?[\s\S]{0,2000}?permission_copy[\s\S]{0,2000}?rank_score[\s\S]{0,2000}?profile_fields_requested/,
  );
});

t("Approve + Cancel buttons present on each proposal", () => {
  assert.match(SRC, /data-testid=\{?`mission-card\.approve\.\$\{proposal\.agent_id\}`\}?/);
  assert.match(SRC, /data-testid=\{?`mission-card\.cancel\.\$\{proposal\.agent_id\}`\}?/);
});

t("declined state hides Approve/Cancel and renders 'Cancelled' instead", () => {
  assert.match(SRC, /declined\.has\(proposal\.agent_id\)/);
  assert.match(SRC, /isDeclined \?[\s\S]{0,200}>Cancelled</);
});

t("Continue button gates on activeAutoInstallable, not raw autoInstallable", () => {
  // Brief expectation: declining all proposals should unlock Continue.
  // The Continue disable-check now reads activeAutoInstallable.length.
  assert.match(SRC, /disabled=\{[^}]*activeAutoInstallable\.length > 0 && !allAutoInstalled/);
});

t("'Approve all' relabel — primary action copy matches the per-row Approve", () => {
  // JSX whitespace between > and the literal — match leniently.
  assert.match(SRC, /\bApprove all\b/);
  // The previous user-visible "Install available" label is gone.
  assert.equal(/Install available/.test(SRC), false);
  // approveLabel's default return is "Approve" — locks the per-row
  // primary-action copy.
  assert.match(SRC, /return "Approve";/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
