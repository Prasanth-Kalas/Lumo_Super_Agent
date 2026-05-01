/**
 * CHAT-FLIGHT-SELECT-CLICKABLE-1 — FlightOffersSelectCard contract tests.
 *
 * Two slices:
 *   1. Pure-helper tests against `buildOfferSubmitText` — the orchestrator
 *      contract. Locks the exact submit-text shape so the orchestrator's
 *      Duffel-offer handoff doesn't break.
 *   2. Source-level structural tests on the .tsx — assert the new
 *      tap-to-submit cascade replaces the previous two-step radio +
 *      Continue-button flow. Mirrors the pattern used by the other
 *      web-* sprints (no React renderer in this repo).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildOfferSubmitText } from "../lib/flight-offers-helpers.ts";

const SRC = readFileSync(
  new URL("../components/FlightOffersSelectCard.tsx", import.meta.url),
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

console.log("\nchat-flight-select-clickable-1 — FlightOffersSelectCard");

const offer = (overrides = {}) => ({
  offer_id: "off_123",
  total_amount: "189.00",
  total_currency: "USD",
  owner: { name: "Frontier" },
  slices: [
    {
      segments: [{ departing_at: "2026-05-09T09:30:00Z" }],
    },
  ],
  ...overrides,
});

// ── buildOfferSubmitText ──────────────────────────────────────────────

t("buildOfferSubmitText: includes offer_id verbatim", () => {
  const text = buildOfferSubmitText(offer({ offer_id: "off_abc_xyz" }));
  assert.match(
    text,
    /\boffer off_abc_xyz\b/,
    "submit text must carry the exact offer_id so the orchestrator can route the selected Duffel offer without ambiguity",
  );
});

t("buildOfferSubmitText: nonstop reads as 'direct'", () => {
  const text = buildOfferSubmitText(offer());
  assert.ok(text.includes(" direct "), `expected " direct " in: ${text}`);
});

t("buildOfferSubmitText: connection reads as '(with connection)'", () => {
  const o = offer({
    slices: [
      {
        segments: [
          { departing_at: "2026-05-09T09:30:00Z" },
          { departing_at: "2026-05-09T12:00:00Z" },
        ],
      },
    ],
  });
  const text = buildOfferSubmitText(o);
  assert.ok(
    text.includes("(with connection)"),
    `expected "(with connection)" in: ${text}`,
  );
});

t("buildOfferSubmitText: USD prices format with $", () => {
  const text = buildOfferSubmitText(offer({ total_amount: "1240.00", total_currency: "USD" }));
  assert.ok(text.includes("$1240.00"), `expected $-prefixed price in: ${text}`);
});

t("buildOfferSubmitText: includes carrier name", () => {
  const text = buildOfferSubmitText(offer({ owner: { name: "JetBlue" } }));
  assert.ok(text.includes("JetBlue"), `expected carrier in: ${text}`);
});

// ── Source-level: new tap-to-submit cascade ───────────────────────────

t("each row is a button with a stable testid", () => {
  assert.match(SRC, /data-testid=\{?`flight-offers-row-\$\{o\.offer_id\}`\}?/);
});

t("row carries data-selected + data-dimmed reflecting selection state", () => {
  assert.match(SRC, /data-selected=\{selected \? "true" : "false"\}/);
  assert.match(SRC, /data-dimmed=\{dimmed \? "true" : "false"\}/);
});

t("tap → setSelectedId; commit happens via useEffect cascade, not inline", () => {
  // The submit cascade runs in a useEffect tied to selectedId so a
  // mid-window unmount can clean up the timer.
  assert.match(SRC, /useEffect\(\(\) => \{[\s\S]{0,400}?if \(!selectedId\) return;/);
  assert.match(SRC, /window\.setTimeout\([\s\S]{0,200}?onSubmit\(buildOfferSubmitText/);
  assert.match(SRC, /return \(\) => window\.clearTimeout\(handle\);/);
});

t("frozen state covers committed selection — siblings must dim, not re-select", () => {
  // Once selectedId is set, frozen flips to true so a second tap on
  // a sibling does nothing.
  assert.match(SRC, /const frozen = !!decidedLabel \|\| !!disabled \|\| selectedId !== null;/);
});

t("dimmed: any non-selected row when a selection has been made", () => {
  assert.match(SRC, /const dimmed = selectedId !== null && !selected;/);
});

t("'Selected' pill renders inline only on the selected row", () => {
  // The pill markup wraps a `{selected ? (<span …>Selected</span>) : null}`
  // ternary inside the row body. Anchor to the `{selected ? (` JSX form
  // (the only occurrence of that exact shape) and walk forward to the
  // pill testid + literal "Selected" copy.
  assert.match(
    SRC,
    /\{selected \? \([\s\S]{0,800}?flight-offers-row-\$\{o\.offer_id\}-pill[\s\S]{0,400}?Selected/,
  );
});

t("Continue-with-this-flight CTA is gone — single-tap is the only commit path", () => {
  // The literal button copy + role="radiogroup" wrapper from the
  // pre-redesign card are absent. Comments referencing the removed
  // CTA are fine; the negative assertion targets the live JSX shape.
  assert.equal(/role="radiogroup"/.test(SRC), false);
  assert.equal(/role="radio"/.test(SRC), false);
  assert.equal(/Select a flight to continue/.test(SRC), false);
  // The Continue button used to live inside `{selectedId ? "Continue …" : "Select …"}`;
  // matching the conditional shape is the precise negative assertion.
  assert.equal(/selectedId \? "Continue with this flight"/.test(SRC), false);
});

t("focus ring / focus-visible state lands on the row, not a separate CTA", () => {
  assert.match(SRC, /focus-visible:ring/);
});

t("aria-pressed reflects selected state for assistive tech", () => {
  assert.match(SRC, /aria-pressed=\{selected\}/);
});

t("typing fallback preserved: card has no chat-composer event handlers", () => {
  // Sanity — the card never listens to the global chat composer, so
  // typing the carrier name still flows through the same orchestrator
  // path it always has. This is a negative assertion against the
  // anti-pattern of intercepting global keystrokes.
  assert.equal(/window\.addEventListener\("keydown"/.test(SRC), false);
  assert.equal(/document\.addEventListener\("keydown"/.test(SRC), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
