# IOS-DOCTRINE-DOCS-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/ios-doctrine-docs-1` (3 commits, branched from
`origin/main` at the IOS-CHAT-WEB-VIEWPORT-COMPARE-1 closeout).

**Lane 7 of 7 — final lane in the small-lanes queue.** Docs-only
lane writing the three filed-deferred design doctrines as
`docs/doctrines/` entries.

## Recon flag → 1 of 3 already shipped

The brief asked for 3 doctrines. Recon found:

- **Mic-vs-Send button pattern** — `docs/doctrines/mic-vs-send-button.md`
  already shipped in Lane 3 (`IOS-COMPOSER-AND-DRAWER-SCREENS-1`
  Phase A) when the WhatsApp-style swap was canonicalized.

So this lane shipped the remaining two:

- `docs/doctrines/selection-card-confirmation.md` — 280 ms confirmation
  pattern.
- `docs/doctrines/debug-fixture-launch-args.md` — Pattern A vs Pattern B
  + naming convention + fixture inventory.

## What shipped

### selection-card-confirmation.md

The doctrine for every interactive selection card the
orchestrator can emit (`flight_offers` shipped, `food_menu`,
`time_slots`, future hotels/restaurants/etc).

Locks the contract:

- Tap row → immediate accent stripe + Selected pill on that row.
- Sibling cascade: non-selected rows fade to 40% opacity + become
  non-tappable.
- 280 ms confirmation window before submit (mirrors web's
  `SUBMIT_DELAY_MS = 280` for cross-platform commit cadence).
- `onSubmit` carries a natural-language string the orchestrator's
  existing handoff parser already understands.
- No separate Continue / Confirm CTA — the tap IS the commit.

Documents WHY 280 ms (below 200 ms cascade hasn't landed; above
350 ms users tap twice). Lists the seven required behaviours every
card must share. Names the two things explicitly NOT required
(undo affordance; choice between accent-stripe and full-row-fill
for the selected state). Points at `FlightOffersSelectCard.swift`
as the canonical reference implementation.

### debug-fixture-launch-args.md

The doctrine for screenshot capture and deterministic preview
state via launch arguments.

Two patterns documented with explicit "use Pattern A when... use
Pattern B when..." decision criteria:

- **Pattern A — `applyDebugLaunchArgs`** (in-app, mutates view-
  model state): for fixtures that seed data into the production
  view tree. Inline `if defaults.bool/string(forKey:)` checks in
  `RootView.applyDebugLaunchArgs()`. Today: 14 flags inventoried.
- **Pattern B — `*FixtureRoot`** (full-screen, replaces the view
  tree): for fixtures that bypass auth/nav and wire mock services.
  Top-level `LumoApp.body` short-circuits the normal `AppRootView`.
  Today: 2 fixture roots inventoried (Payments, Notifications).

Naming convention codified:

| Prefix | Meaning |
|---|---|
| `-LumoSeedX <value>` | Seed deterministic data (Pattern A). |
| `-LumoStartX <value>` | Set initial app state at cold launch (Pattern A). |
| `-LumoOpenX <value>` | Auto-navigate to a sub-state, one-shot (Pattern A). |
| `-LumoXFixture <name>` | Top-level fixture root that swaps the view tree (Pattern B). |

Documents DEBUG-only enforcement (every fixture path behind
`#if DEBUG`; `IOS-DEV-BYPASS-GATE-1` defense-in-depth verifier
extends to this doctrine — if a fixture leaks into Release, the
verifier should catch it). Includes "when to add a new fixture"
checklist (5 steps) and "when to revisit" criteria.

## Tests

None — docs-only lane.

## Visual gates

None — docs-only lane.

## Cross-platform coordination

None. The selection-card-confirmation doctrine names web's
`SUBMIT_DELAY_MS = 280` as the cross-platform parity constraint
but doesn't change web. The fixture doctrine is iOS-only.

## Out of scope (filed)

- **DOCTRINE-INDEX-1** — `docs/doctrines/README.md` index page
  listing all doctrines with one-line summaries. Not needed at 3
  doctrines (filename = topic); revisit at ~10.
- **WEB-DOCTRINES-MIRROR-1** — web's `apps/web/components/`
  components have analogous patterns (e.g., the 280 ms delay
  exists on `FlightOffersSelectCard.tsx`) but no
  `apps/web/docs/doctrines/` directory. If web's design language
  formalises into a parallel doctrine library, the iOS docs in
  this lane are the reference structure. Cosmetic; defer.
