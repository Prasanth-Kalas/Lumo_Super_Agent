# IOS-DEV-BYPASS-GATE-1 — progress + ready-for-review, 2026-05-02

Branch: `claude-code/ios-dev-bypass-gate-1` (3 commits, branched from
`origin/main` at the IOS-COMPOUND-ROLLBACK-VIEW-1 closeout).

App Review will reject any production binary that ships a "skip auth"
affordance visible to users. The dev-bypass button on the welcome
screen needed to be invisible to TestFlight + App Store builds. This
lane locks that invariant with defense-in-depth.

## Recon flag → narrowed scope

The brief assumed the bypass button was "currently visible to all
users." Recon turned up otherwise: it was already wrapped in
`#if DEBUG` and the welcome screen carried a header doc comment
explaining the rationale, both shipped on 2026-04-29 in `bca3a862`
(the AUTH-OAUTH foundation lane). The Release config in
`apps/ios/project.yml` correctly omits `SWIFT_ACTIVE_COMPILATION_CONDITIONS`,
so the button was already stripped from `archive` (Release) builds.

Three paths surfaced:

- **A · Close as no-op** — point at `bca3a862` and save the half-day.
- **B · Defense-in-depth** — keep the wrap, add visual-gate PNGs and
  a build-config sanity test so a future regression that drops the
  `#if DEBUG` (or flips Release to set DEBUG) gets caught.
- **C · A+B plus a CI lint rule** — overkill for a single button; an
  eyeball during code review is cheap.

You preauthorised B in the brief itself ("verify… add a build-config
sanity test"), so this lane shipped Path B.

## What shipped

| Δ | Surface | Outcome |
|---|---|---|
| 1 | `AuthView.isDevBypassButtonCompiledIn` | Public static constant defined via the same `#if DEBUG` block as the button. Test-introspectable; documents the gate symbol. The constant + the button travel together — anyone deleting the wrap has to also touch this constant. |
| 2 | `scripts/verify-release-bypass-stripped.sh` | Shell script that asserts (a) the bypass label string appears only inside `#if DEBUG / #endif` across `apps/ios/Lumo/**/*.swift`, and (b) the Release config in `apps/ios/project.yml` does not set `SWIFT_ACTIVE_COMPILATION_CONDITIONS: DEBUG`. Both invariants verified positive (passes on current source) + negative (fails when a leak is injected). Pure bash + awk; portable to bash 3 (macOS default shell). |
| 3 | `LumoTests/DevBypassGateTests.swift` | Three new tests that mirror the shell script invariants in Swift so they run as part of `xcodebuild test`: gate-symbol-true-under-Debug, source-grep-finds-no-leaks, project-yml-Release-not-DEBUG. Uses `#filePath` to anchor to the repo root from the simulator sandbox. |
| 4 | Visual gate PNGs | 2 captures committed under `docs/notes/ios-dev-bypass-gate-1-screenshots/`. Debug build: bypass button visible below Apple + Google. Release build: bypass button absent — only Apple + Google sign-in. Same simulator (iPhone 17), same appearance, locked frame. |
| 5 | Capture script variant | `LUMO_SHOTS_VARIANT=ios-dev-bypass-gate-1` in `scripts/ios-capture-screenshots.sh` reproduces both PNGs. Swaps install between Debug and Release builds, restores Debug on exit so subsequent default-variant runs still work. Release `.app` path is overridable via `LUMO_RELEASE_APP`. |

## How the invariants compose

Three layers, each catches a different failure mode:

| Layer | Catches |
|---|---|
| `#if DEBUG` wrap on the button | Compiler strips the button from Release builds — the runtime invariant. |
| `AuthView.isDevBypassButtonCompiledIn` constant | Programmatic check that the gate symbol is wired through; tests in Debug see `true`, Release archive sees `false`. Pure documentation in source code form. |
| `verify-release-bypass-stripped.sh` (and Swift mirror) | Source-grep that catches the bypass label appearing OUTSIDE a `#if DEBUG` block (e.g., a future engineer copies the button and forgets the wrap), and YAML-grep that catches a misconfigured Release that sets DEBUG. |

The third layer is the value-add — the first two were already in
place. If someone drops the wrap by accident in a future PR, the
shell script + Swift tests both fail, and the visual-gate PNGs (when
re-captured) regress visibly. Three independent signals before the
binary leaves the build server.

## Tests

`xcodebuild test -scheme Lumo -only-testing:LumoTests` →
**288 tests, 0 failures** (was 285 before the lane: +3 in
`DevBypassGateTests`).

```
DevBypassGateTests.test_devBypassGate_isCompiledInUnderDebug
DevBypassGateTests.test_releaseBuild_stripsDevBypass_perSourceInvariant
DevBypassGateTests.test_releaseConfig_doesNotSetDebugCompilationCondition
```

Shell script (positive + negative tested in this session):

```
$ scripts/verify-release-bypass-stripped.sh
verify-release-bypass-stripped: OK
  · dev-bypass label only appears inside #if DEBUG
  · Release config does not set SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG
```

Negative-test (string injected outside #if DEBUG) → exits 1 with the
file:line of the leak, as expected.

## Visual gate

`docs/notes/ios-dev-bypass-gate-1-screenshots/`:
- `auth-debug-build-bypass-visible.png` — three buttons (Apple, Google, "Continue without signing in (dev)").
- `auth-release-build-bypass-stripped.png` — two buttons (Apple, Google); bypass row absent. Same simulator, same appearance, identical frame.

Re-captured via:

```bash
xcodebuild build -scheme Lumo -configuration Release \
  -sdk iphonesimulator -destination "id=$LUMO_SIM_ID" \
  CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/lumo-release-dd

LUMO_SHOTS_VARIANT=ios-dev-bypass-gate-1 \
LUMO_SHOTS_OUT=docs/notes/ios-dev-bypass-gate-1-screenshots \
  scripts/ios-capture-screenshots.sh
```

## Doctrine notes

This pattern (constant + shell script + Swift tests + visual gate)
generalises to any "must not appear in production" affordance:
TestFlight-only debug menus, internal-only feature flags, dev-only
endpoints. The IOS-DOCTRINE-DOCS-1 lane (Lane 6 of this queue) won't
fold this into a doctrine doc — the brief's three doctrines are
mic-vs-send, selection-card-confirmation, and DEBUG-fixture-launch-args
— but if a future surface needs the same gate, the IOS-DEV-BYPASS-GATE-1
artefacts are the reference implementation.

## Out of scope

- A CI workflow that runs the shell script on every push (filed-deferred
  as `CI-IOS-INVARIANTS-1`). Useful but not necessary for this lane's
  goal — the Swift tests already run in `xcodebuild test`, which the
  existing iOS CI executes.
- Auditing other DEBUG-gated affordances (`-LumoVoiceFixture`,
  `-LumoPaymentsFixture`, `-LumoSeed*`, etc.) for the same gate. Those
  are launch-arg-only and not visible in the standard UI; the audit
  is a separate sweep if App Review ever flags one.
