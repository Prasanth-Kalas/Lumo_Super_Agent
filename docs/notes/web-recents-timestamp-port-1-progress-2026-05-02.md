# WEB-RECENTS-TIMESTAMP-PORT-1 — progress, 2026-05-02

Branch: `codex/web-recents-timestamp-port-1`.

## What changed

- Added `apps/web/lib/format-time-since.ts`, a pure compact relative-time helper for recents rows.
- Rendered the helper in both desktop `LeftRail` and mobile `MobileNav` recent-chat rows.
- Preserved trip-count context by joining it onto the dim timestamp subtitle.
- Added `/fixtures/recents-timestamps` plus `scripts/web-recents-timestamp-port-capture.mjs` for deterministic visual capture.

## iOS reference

iOS's `SideDrawerView` renders the recent-row timestamp under the title in the tertiary label color:

```swift
Text(item.updatedAt, style: .relative)
    .font(LumoFonts.footnote)
    .foregroundStyle(LumoColors.labelTertiary)
```

The web port keeps the same layout and dim-label posture, but uses an explicit helper so the product copy is stable across browser locale settings:

- `now`
- `5 sec`
- `5 min`
- `12 min, 3 sec`
- `4 hr, 8 min`
- `1 day, 2 hr`

## Visual gate

- Web: `docs/notes/web-recents-timestamp-port-1-screenshots/left-rail-recents-timestamps-light.png`
- iOS counterpart reference: `docs/notes/ios-mirror-web-1-screenshots/drawer-with-recents-light.png`

## Tests

- `tests/web-recents-timestamp-port.test.mjs` covers the formatter boundaries and source-level component wiring.
