# WEB-COMPOUND-LEG-DETAIL-1 Progress

Branch: `codex/web-compound-leg-detail-1`

## Scope

Ported the iOS `CompoundLegDetailContent` contract to web so each row in the inline `CompoundLegStrip` can expand in place and explain what the specialist agent is doing.

## Implementation Notes

| Area | Result |
|---|---|
| Payload | `CompoundLegStripFrame` legs now accept optional `timestamp`, `provider_reference`, and string-coerced `evidence`. Rows without metadata remain simple and non-expandable. |
| Detail model | New pure helper in `apps/web/lib/compound-leg-detail.ts` mirrors the iOS status-branch copy and six-code failure map. |
| UI | `CompoundLegStrip` rows become buttons only when detail metadata exists. Chevron rotates 90 degrees, multiple rows may be expanded at once, and expansion state is held in the chat shell keyed by `leg_id`. |
| Live updates | The existing compound SSE stream now merges incoming leg metadata as well as statuses. |
| Ticker | `in_flight` and `rollback_pending` details render a 1-second elapsed ticker, suppressed once the compound strip settles. |

## iOS Parity

The iOS source of truth is `apps/ios/Lumo/Components/CompoundLegDetailContent.swift`. Web copies the five status branches byte-for-byte where visible:

| State | iOS reference | Web capture |
|---|---|---|
| Pending | `docs/notes/ios-compound-leg-detail-1-screenshots/leg-detail-pending-light.png` | `docs/notes/web-compound-leg-detail-1-screenshots/leg-detail-pending-light.png` |
| In flight | `docs/notes/ios-compound-leg-detail-1-screenshots/leg-detail-in-flight-light.png` | `docs/notes/web-compound-leg-detail-1-screenshots/leg-detail-in-flight-light.png` |
| Committed | `docs/notes/ios-compound-leg-detail-1-screenshots/leg-detail-committed-light.png` | `docs/notes/web-compound-leg-detail-1-screenshots/leg-detail-committed-light.png` |
| Failed | `docs/notes/ios-compound-leg-detail-1-screenshots/leg-detail-failed-light.png` | `docs/notes/web-compound-leg-detail-1-screenshots/leg-detail-failed-light.png` |
| Manual review | `docs/notes/ios-compound-leg-detail-1-screenshots/leg-detail-manual-review-light.png` | `docs/notes/web-compound-leg-detail-1-screenshots/leg-detail-manual-review-light.png` |
| Committed dark | `docs/notes/ios-compound-leg-detail-1-screenshots/leg-detail-committed-dark.png` | `docs/notes/web-compound-leg-detail-1-screenshots/leg-detail-committed-dark.png` |

## Verification

- `node --experimental-strip-types tests/web-compound-leg-detail.test.mjs`
- `npm run typecheck`
- Screenshot capture: `node scripts/web-compound-leg-detail-1-capture.mjs`
