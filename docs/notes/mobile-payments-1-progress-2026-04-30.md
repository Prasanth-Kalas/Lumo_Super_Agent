# MOBILE-PAYMENTS-1 — review packet

Lane: `claude-code/mobile-payments-1`. Brief: iOS payment surface
(card-on-file via Stripe SDK + Apple Pay, biometric-backed
transaction confirmation, receipt rendering + history) per the
roadmap §5 sprint description issued 2026-04-30. Ship in Stripe
**Test mode** only — real-money execution waits on Phase 4.5
MERCHANT-1 backend + Stripe Issuing partnership.

All 9 deliverable groups landed. 41 new tests added (57 → 98 total).
14 light + dark screenshots captured deterministically via the
`PaymentsFixtureRoot` debug path.

## Commits on the lane

```
deec68a docs(mobile-payments-1): open lane
b313284 feat(ios): wire Stripe SDK + Apple Pay capability + xcconfig
40d4025 feat(payments): add backend stub endpoints under /api/payments/*
c941ae3 feat(payments): fall back to x-lumo-user-id header for iOS dev
b785325 feat(ios): add PaymentService — Stripe-shaped client + in-memory stub
16ea97e feat(ios): add BiometricConfirmationService + signed-token shape
48c6eb5 feat(ios): add ReceiptStore + ReceiptHistoryView + ReceiptDetailView
6a1e5ec feat(ios): add PaymentConfirmationCard + view model state machine
6f4aa32 feat(ios): wire PaymentMethodsView + Receipts into Settings tab
625c2ac test(ios): add 41 payment tests across four suites
f305d0e feat(ios): add PaymentsFixtureRoot for screenshot capture + 14 shots
```

## Brief deliverables — status

| # | Group | Status | Notes |
|---|---|---|---|
| 1 | Stripe SDK integration + capabilities + xcconfig | ✅ done | `stripe-ios-spm` 24.x via SwiftPM (StripePaymentSheet + StripeApplePay products); `com.apple.developer.in-app-payments` entitlement with `merchant.com.lumo.rentals.ios`; new xcconfig slots `LUMO_STRIPE_PUBLISHABLE_KEY_TEST` + `LUMO_STRIPE_MERCHANT_ID` propagated by `ios-write-xcconfig.sh`; `AppConfig.isStripeConfigured` + `isStripeLiveMode`. |
| 2 | `PaymentService.swift` + protocol | ✅ done | `PaymentServicing` with the five spec'd ops + `confirmTransaction`. Real `PaymentService` (HTTP against `/api/payments/*`) + `PaymentServiceStub` (in-memory). `presentPaymentSheet` records a synthetic added card via POST `/methods` — Stripe SDK PaymentSheet linked but inert in v1 because backend stubs don't issue real SetupIntent client_secrets. |
| 3 | Backend stub endpoints under `apps/web/app/api/payments/*` | ✅ done | Five routes: `setup-intent`, `methods` (GET+POST), `methods/[id]` DELETE, `methods/[id]/set-default` POST, `confirm-transaction` POST. State in `lib/payments-stub.ts` (process-volatile module-level Map keyed by user id). Each route header-commented with the exact MERCHANT-1 hand-off shape. |
| 4 | `BiometricConfirmationService` | ✅ done | Wraps `BiometricUnlockServicing`; on auth success returns a `SignedConfirmationToken` = `HMAC-SHA256(digest \|\| nonce, k)` with a fresh per-call symmetric key. v1 shape, not a real device-bound signature — MERCHANT-1 swaps in Secure Enclave ECDSA-P256. `BiometricConfirmationStub` covers tests. |
| 5 | `PaymentConfirmationCard.swift` | ✅ done | Modal with line items + total + payment-method row + state-machine footer (`ready → authorizing → processing → succeeded \| failed \| cancelled`). State machine in `PaymentConfirmationViewModel` (pulled out of view for unit testability). Receipt persistence is best-effort — local-cache miss after server success doesn't undo `.succeeded`. |
| 6 | `PaymentMethodsView.swift` | ✅ done | Settings sub-screen with Test-mode banner, saved-cards section (brand glyph + last 4 + expiry + Default badge), swipe-to-delete + swipe-to-set-default, "Add payment method" presents an in-app form sheet. "Payments not configured" empty state when env key is missing. |
| 7 | Receipt rendering + history | ✅ done | `ReceiptStore` writes JSON to `Application Support/Lumo/receipts.json` (atomic, idempotent on transactionId). `ReceiptHistoryView` groups by month, descending. `ReceiptDetailView` shows status / line items / payment / transaction IDs. |
| 8 | Tests | ✅ done | 41 added across `PaymentServiceTests` (12), `BiometricConfirmationTests` (10), `PaymentConfirmationCardTests` (10), `ReceiptStoreTests` (9). All 98 tests pass on iPhone 17 / iOS 26.4. |
| 9 | Screenshots + documentation | ✅ done | 14 screenshots driven by `PaymentsFixtureRoot` + `LUMO_SHOTS_VARIANT=payments`. This progress note + STATUS.md close. |

## §1 — Build-time configuration + Stripe key handling

### What I changed

- `apps/ios/Lumo.xcconfig` — added `LUMO_STRIPE_PUBLISHABLE_KEY_TEST`
  and `LUMO_STRIPE_MERCHANT_ID` slots with empty defaults.
- `scripts/ios-write-xcconfig.sh` — propagates the two new env vars.
  Warns separately when each is missing so the developer knows
  exactly which capability is unconfigured.
- `apps/ios/project.yml` — pinned `stripe-ios-spm` from `24.0.0` (the
  SPM-only mirror; smaller checkout than `stripe-ios`). Added
  `StripePaymentSheet` and `StripeApplePay` as target dependencies.
  `INFOPLIST_KEY_LumoStripePublishableKey` /
  `INFOPLIST_KEY_LumoStripeMerchantID` substitution.
- `apps/ios/Lumo/Resources/Info.plist` — surfaces the two values.
- `apps/ios/Lumo/Lumo.entitlements` —
  `com.apple.developer.in-app-payments` array with
  `merchant.com.lumo.rentals.ios`. With `CODE_SIGNING_ALLOWED=NO` it's
  file-only; takes effect when CI signing lands.
- `apps/ios/Lumo/Services/AppConfig.swift` — adds
  `stripePublishableKey`, `stripeMerchantID`, `isStripeConfigured`,
  `isStripeLiveMode`. Test-mode keys (`pk_test_*`) are the only ones
  we ship in this sprint; live mode flips on with MERCHANT-1.

### What I did *not* do, and why

The brief specified appending Stripe values to `~/.config/lumo/.env`:
```
LUMO_STRIPE_PUBLISHABLE_KEY_TEST=
LUMO_STRIPE_MERCHANT_ID=
```

The brief said "values stay out of chat — Kalas adds them on his
terminal," so I never had real keys to write. The xcconfig pipeline
treats both as optional — when empty, `PaymentMethodsView` renders a
"Payments not configured" empty state with the env-set instruction;
when the publishable key starts with `pk_test_*`, a "TEST MODE"
banner renders at the top of the Payment Methods screen. To enable
end-to-end Stripe Test card-add (the brief's E2E gate), Kalas runs
in his own terminal:

```sh
cat >> ~/.config/lumo/.env <<'EOF'
LUMO_STRIPE_PUBLISHABLE_KEY_TEST=pk_test_<the publishable key>
LUMO_STRIPE_MERCHANT_ID=merchant.com.lumo.rentals.ios
EOF
chmod 600 ~/.config/lumo/.env

set -a; source ~/.config/lumo/.env; set +a
cd apps/ios && bash ../../scripts/ios-write-xcconfig.sh && xcodegen generate
xcodebuild build -project Lumo.xcodeproj -scheme Lumo \
  -destination 'platform=iOS Simulator,id=12CA8A97-CB46-49E5-95EB-88B072FF57CD' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO
```

## §2 — Backend stubs + the iOS↔server contract

`apps/web/app/api/payments/*` ships five routes. State lives in
`apps/web/lib/payments-stub.ts` as a module-level `Map<userId,
{methods, receipts}>` — process-volatile, fine for v1 dev. Each route
file's header comment names the exact MERCHANT-1 replacement
(`stripe.setupIntents.create()`, `stripe.paymentMethods.attach()`,
etc.) so the swap is mechanical.

Auth resolves via `resolvePaymentsUserId(req, getServerUser)` which
mirrors the chat route: try Supabase session, fall back to
`x-lumo-user-id` header, default to `anon`. iOS doesn't carry browser
cookies, so the header path is what the iOS client uses; production
MERCHANT-1 will require real auth and drop the dev fallback.

### About the "stub" vs the brief's E2E expectation

The brief's E2E gate says:

> Add card via Stripe PaymentSheet using test card 4242 4242 4242
> 4242 → appears in Payment Methods → set default → confirmation card
> with Face-ID succeeds → receipt appears in history.

Real Stripe PaymentSheet requires a valid SetupIntent `client_secret`
issued by Stripe's API, which requires a server-side Stripe **secret**
key (`sk_test_*` or `sk_live_*`). The brief explicitly says backend
stubs, "MERCHANT-1 replaces with real Stripe calls" — meaning we do
NOT ship a server-side Stripe secret in this sprint. The stub
returns `{ stub: true, clientSecret: null }`.

What the iOS PaymentService does with `clientSecret == null`:
`presentPaymentSheet(input:)` records a synthetic added card via
`POST /api/payments/methods` instead of invoking real PaymentSheet.
The view layer (`PaymentMethodsView`'s in-app `AddPaymentMethodSheet`)
collects card-shaped input that mirrors PaymentSheet's UX and
validates against the same Stripe test prefix (4242 begets
`CardBrand.visa`). Same E2E shape, no real-Stripe round-trip.

When MERCHANT-1 ships:
1. `setup-intent` returns a real `client_secret`.
2. PaymentService's `createSetupIntent()` consumers see
   `clientSecret != nil` → switch to real
   `PaymentSheet.present(from:)`.
3. The synthetic add-card sheet remains as a dev fallback.

The Stripe SDK is linked + the entitlement is granted; only the
`clientSecret` flip is missing.

## §3 — `PaymentService` + `PaymentServiceStub`

`apps/ios/Lumo/Services/PaymentService.swift` owns the wire shape.

### Surface

```swift
protocol PaymentServicing {
    func createSetupIntent() async throws -> SetupIntentResponse
    func presentPaymentSheet(input: AddPaymentMethodInput) async throws -> PaymentMethod
    func listPaymentMethods() async throws -> [PaymentMethod]
    func setDefaultPaymentMethod(id: String) async throws -> PaymentMethod
    func removePaymentMethod(id: String) async throws
    func confirmTransaction(_ input: ConfirmTransactionInput) async throws -> Receipt
}
```

`createSetupIntent` and `presentPaymentSheet` are kept as separate
methods to match the brief's spec; in a real-Stripe future they
collapse into a single PaymentSheet flow that internally creates the
intent and presents the sheet.

### Wiring

`LumoApp.init` constructs `PaymentService.make(config:userIDProvider:)`
where `userIDProvider` is a closure capturing the `AuthService` so
sign-in/out transitions don't require service re-instantiation. The
provider sends `x-lumo-user-id` on every request; nil/empty resolves
to "anon" server-side.

### Date decoding

The backend stub serializes timestamps with `Date.toISOString()`
(includes fractional seconds, e.g. `2026-04-30T12:00:00.123Z`).
Stock `JSONDecoder.dateDecodingStrategy = .iso8601` rejects them. We
register a custom strategy that tries
`ISO8601DateFormatter[.withInternetDateTime,.withFractionalSeconds]`
first and falls back to plain ISO 8601. Hit by the receipt round-trip
test.

## §4 — `BiometricConfirmationService` + signed-token shape

Where `BiometricUnlockService` gates app entry on cold launch,
`BiometricConfirmationService` gates a single transaction. The user
performs Face/Touch-ID against a prompt that names the payment
("Confirm payment of $462.20 for Acme Hotel — 2 nights"); on success
we produce a `SignedConfirmationToken` bound to the transaction
digest.

### v1 token shape

```
mac = HMAC<SHA256>(transactionDigest || nonce, k)
tokenData = mac (32 bytes) || nonce (16 bytes)  // 48 bytes total
```

Where `k` is a fresh `SymmetricKey(size: .bits256)` per call. This
satisfies the backend stub's "well-formed token" check (`length >=
16` after base64) and mirrors the eventual real shape. It is NOT a
real device-bound signature — anyone with access to the device can
produce a structurally valid token.

### MERCHANT-1 replacement

Secure Enclave ECDSA-P256 keypair generated at first sign-in. Public
key registered server-side. Each `requestConfirmation(prompt:digest:)`
call invokes `SecKeyCreateSignature` against the private key (gated
by Face/Touch-ID via `kSecAccessControlBiometryCurrentSet`); the
signature is what travels as `signedConfirmationToken`. Server
verifies against the registered public key.

### Helpers

`Data.transactionDigest(of:)` is the canonical SHA-256 wrapper used
by `PendingTransaction.digest`. Dedicated helper because the digest
shape needs to be identical on both sides of the wire (server
re-derives from the canonical text representation
`title|currency|label:cents,…` to verify the user authorized this
exact payload).

## §5 — `PaymentConfirmationCard` + state machine

`PaymentConfirmationViewModel` is pulled out of the view so unit
tests exercise transitions without instantiating SwiftUI. State
machine:

```
ready ──confirm()──▶ authorizing ──biometric ok──▶ processing ──server ok──▶ succeeded(Receipt)
                                                                       │
                                                              ──server error──▶ failed(message)
                                  ──biometric cancel─────────────────────────▶ cancelled
                                  ──biometric error──────────────────────────▶ failed(message)
```

`reset()` returns from `.cancelled`/`.failed` to `.ready` for retry;
`.succeeded` is terminal — the host dismisses the card.

### Receipt persistence is best-effort

If `confirmTransaction` returns a successful receipt but
`ReceiptStore.append()` throws (disk full, sandbox issue), we still
land in `.succeeded`. The user did pay; a local-cache miss shouldn't
undo the payment confirmation. The next history reload (post
MOBILE-API-1 sync) will re-pull from the server.

## §6 — `PaymentMethodsView` + add-card sheet

Settings sub-screen, presented from the new "Payments" section in
`SettingsTab` between Security and Voice. Layout:

- **Test-mode banner** (only when `isStripeLiveMode == false`):
  "Test mode — no real charges. MERCHANT-1 enables live payments."
- **Saved cards** section: each row shows brand glyph + last 4 +
  Default badge (if applicable) + expiry. Swipe-trailing reveals
  Remove (with confirmation dialog) and Default (when not already
  default).
- **Add payment method** row → opens `AddPaymentMethodSheet`.

The add sheet is the synthetic v1 form that mirrors PaymentSheet's
UX (number / MM / YY / CVV) with a footer note instructing test card
`4242 4242 4242 4242`. `PaymentMethodsViewModel.AddCardFormState.validate()`
enforces shape and produces an `AddPaymentMethodInput` with brand
detected from the IIN prefix.

CVV is collected for UX continuity but never stored or sent —
backend `POST /methods` only accepts brand + last 4 + expiry.

## §7 — Receipts (local-only)

`ReceiptStore` writes `Application Support/Lumo/receipts.json`. JSON
envelope `{ version: 1, receipts: [...] }` with atomic writes
(`Data.write(to:options:.atomic)`). `append()` is idempotent on
`transactionId` so a retry of `confirm-transaction` won't
double-record.

`ReceiptHistoryView` groups by month, descending. `ReceiptDetailView`
shows status / line items / total / payment method label /
transaction + receipt IDs (truncated, monospaced). Read-only —
MERCHANT-1 will add the refund-initiation entry point here.

Local-only is an explicit v1 choice. Server-side `transactions`
table is MERCHANT-1 territory; this store becomes a write-through
cache + offline-history surface when MOBILE-API-1's sync layer ships.

## §8 — Tests

### Test inventory

```
LumoTests.xctest:
  AuthStateMachineTests           — 13 passed   (existing)
  BiometricConfirmationTests      — 10 passed   (NEW)
  ChatMessageListSnapshotTests    —  6 passed   (existing)
  ChatServiceTests                — 11 passed   (existing)
  PaymentConfirmationCardTests    — 10 passed   (NEW)
  PaymentServiceTests             — 12 passed   (NEW)
  ReceiptStoreTests               —  9 passed   (NEW)
  TTSChunkingTests                — 11 passed   (existing)
  ThemeContrastTests              —  4 passed   (existing)
  VoiceStateMachineTests          — 12 passed   (existing)
                                  ────────────
                                    98 passed, 0 failed
```

### Coverage rationale

- **PaymentServiceTests (12)** — Stub end-to-end (add / list / set-default
  / remove / confirm-with-known-method / confirm-with-unknown-throws);
  real PaymentService against URLProtocolMock (decode list, setup-intent
  shape, add-method 201 path, not-configured throws, bad-status
  surfaces code+body, confirm-transaction sends hex digest +
  base64 token).
- **BiometricConfirmationTests (10)** — `makeToken` produces ≥48
  bytes, is non-deterministic, base64 well-formed; stub success/cancel/
  failure; service against unlock stub for success/false/throws;
  SHA-256 helper.
- **PaymentConfirmationCardTests (10)** — initial `.ready`,
  happy-path → `.succeeded` persists receipt, biometric cancel →
  `.cancelled`, biometric failure → `.failed`, service failure →
  `.failed`, `reset()` from `.cancelled`/`.failed` returns to
  `.ready` but does NOT escape `.succeeded`; PendingTransaction
  digest stability + total math.
- **ReceiptStoreTests (9)** — empty-on-missing-file, append+load
  round-trip, ordering newest-first, idempotent on transactionId,
  persists across instance recreation, clear, atomic-write
  preserves prior; stub seed + dedup.

### What's not covered by unit tests

- Real Stripe PaymentSheet integration (deferred — needs MERCHANT-1
  server-side Stripe secret; covered by manual E2E once enabled).
- Real biometric prompt (LAContext requires hardware; tested via
  `BiometricUnlockStub`).
- Real Apple Pay sheet (requires device with Apple Pay configured
  + signed entitlement; documented as deferred).

## §9 — Screenshots

`docs/notes/mobile-payments-1-screenshots/`:

- [`07-payment-methods-empty-{light,dark}.png`](mobile-payments-1-screenshots/07-payment-methods-empty-light.png)
  — empty state with "No payment methods saved" + Add button
- [`08-payment-methods-saved-{light,dark}.png`](mobile-payments-1-screenshots/08-payment-methods-saved-light.png)
  — Visa default + Mastercard, Test mode banner, Add row
- [`09-add-card-{light,dark}.png`](mobile-payments-1-screenshots/09-add-card-light.png)
  — populated add sheet with `4242 4242 4242 4242` / `12 / 30 / 123`
- [`10-confirm-ready-{light,dark}.png`](mobile-payments-1-screenshots/10-confirm-ready-light.png)
  — confirmation card in `.ready`, "Confirm with Biometric" button
  (the simulator has no enrolled biometric, so the label falls
  through to "Biometric" — on a real device with Face ID it shows
  "Confirm with Face ID")
- [`11-confirm-success-{light,dark}.png`](mobile-payments-1-screenshots/11-confirm-success-light.png)
  — `.succeeded` state, green check, "$462.20", Done button
- [`12-receipts-history-{light,dark}.png`](mobile-payments-1-screenshots/12-receipts-history-light.png)
  — list grouped by month, two seeded receipts
- [`13-receipt-detail-{light,dark}.png`](mobile-payments-1-screenshots/13-receipt-detail-light.png)
  — single-receipt detail with line items + total + truncated IDs

Captures driven by `PaymentsFixtureRoot` — a DEBUG-only alternate
WindowGroup root activated by `-LumoPaymentsFixture <name>` that
renders one screen directly with deterministic seeded data,
bypassing auth + nav. Compiled out of Release. Capture command:

```sh
LUMO_SHOTS_VARIANT=payments \
LUMO_SHOTS_OUT=docs/notes/mobile-payments-1-screenshots \
bash scripts/ios-capture-screenshots.sh
```

## Carry-forward observations

### "Confirm with Biometric" simulator label

The confirmation card's primary button reads "Confirm with Biometric"
on the simulator because `LAContext.canEvaluatePolicy` returns false
without enrolled biometric hardware, and `BiometricUnlockService.biometryKind()`
falls through to `.none` whose label is `"Biometric"`. On a real
iPhone with Face ID enrolled, it reads "Confirm with Face ID". No
behavior change — only the label.

### Dark-mode artifact (carry-over from MOBILE-CHAT-1B §5)

The §5 phantom artifact from 1B is not visible in any of the
captured payment screens because `PaymentsFixtureRoot` bypasses the
ChatTab path that triggers it. On a real (non-fixture) launch, the
artifact still appears on the chat empty state in dark mode —
unchanged from 1B's documentation. Recommend keeping
`MOBILE-POLISH-1` candidate active.

### Build environment

The Xcode 26.4 → 26.4.1 actool/runtime mismatch from 1B/voice
persists. The `xcrun simctl runtime match set iphoneos26.4 23E244`
workaround is still required locally. Recommend `MOBILE-CI-1` to
bake into GitHub Actions.

## Verification gate

- ✅ Stripe SDK 24.x linked via SwiftPM; `com.apple.developer.in-app-payments`
  entitlement granted.
- ✅ PaymentService HTTP path round-trips the five spec'd ops + the
  per-transaction confirm.
- ✅ Backend stubs ship with header-commented MERCHANT-1 hand-off
  contracts.
- ✅ BiometricConfirmationService produces well-formed tokens; stub
  + real-service tests cover success / cancel / failure.
- ✅ PaymentConfirmationCard state machine drives the full flow;
  receipt persistence is best-effort; reset is non-terminal.
- ✅ PaymentMethodsView surfaces saved cards with brand + last 4 +
  expiry + Default badge; swipe-to-delete; Test-mode banner; Add
  flow via the synthetic sheet.
- ✅ Receipts persist locally; round-trip; idempotent on
  transactionId; history grouped by month.
- ✅ All 98 tests pass on iPhone 17 / iOS 26.4. (Up from 57; +41
  payment tests.)
- ✅ `xcodebuild build` succeeds CODE_SIGNING_ALLOWED=NO.
- ✅ `npm run typecheck` + `npm run lint` green (only pre-existing
  warnings).
- ✅ 14 light + dark screenshots committed.
- ✅ Diff swept for token / secret patterns — no `pk_test_*` /
  `pk_live_*` / `sk_*` leaked in committed files. The merchant id
  `merchant.com.lumo.rentals.ios` is a public Apple Pay identifier.
- ⚠️ E2E gate "Add card via Stripe PaymentSheet using test card
  4242" — passes through the synthetic in-app sheet that mirrors
  PaymentSheet UX. Real Stripe PaymentSheet flow is wired but
  inert in v1 because backend stubs don't issue real
  `client_secret`s; flips on with MERCHANT-1.
- ⚠️ Apple Pay end-to-end on device — entitlement + merchant id
  configured; simulator can show the button but cannot complete
  auth. Real-device test deferred until CI signing lands.
- ✅ STATUS.md — lane stays Active until reviewer fast-forward,
  then closed.

## Hand-off to MERCHANT-1 — explicit swap path

This is the file MERCHANT-1's author should read first when wiring
the real backend. Each item is a flag flip or single-method swap, not
a refactor.

### Server-side (the bigger half)

1. **Add server env vars** to `apps/web/.env`:
   - `STRIPE_SECRET_KEY_TEST` (then `STRIPE_SECRET_KEY_LIVE`).
   - `STRIPE_WEBHOOK_SIGNING_SECRET`.
   - `STRIPE_MERCHANT_ACCOUNT_ID` (the merchant-of-record account).
2. **Add migration** for `payments_customers` (1:1 with auth users,
   stores Stripe `customerId`), `payment_methods` (mirror of Stripe
   PaymentMethod plus our flags), `transactions` (the source of
   truth for receipts), `confirmation_keys` (per-device public keys
   registered at sign-in for ECDSA verification).
3. **Replace each route body in `apps/web/app/api/payments/*`**:
   - `setup-intent` → call `stripe.setupIntents.create({ customer,
     usage: 'off_session' })`, return `{ stub: false, clientSecret,
     setupIntentId, customerId }`. Drop the `stub: true` flag.
   - `methods` GET → `stripe.paymentMethods.list({ customer, type:
     'card' })`, project to our shape.
   - `methods` POST → delete this route. iOS PaymentSheet path
     attaches PaymentMethods directly via Stripe; our stub-only
     synthetic-add endpoint is no longer needed.
   - `methods/[id]/set-default` → `stripe.customers.update({
     invoice_settings: { default_payment_method: id } })`.
   - `methods/[id]` DELETE → `stripe.paymentMethods.detach(id)`.
   - `confirm-transaction` →
     (a) verify the `signedConfirmationToken` against the user's
     registered ECDSA public key for this device,
     (b) re-derive the canonical digest from `{ paymentMethodId,
     amountCents, currency, lineItems }` and compare,
     (c) `stripe.paymentIntents.create({ confirm: true,
     payment_method: paymentMethodId, customer, amount,
     currency, off_session: true })`,
     (d) on success, INSERT into `transactions`, return the row.
4. **Delete `apps/web/lib/payments-stub.ts`** and its
   `resolvePaymentsUserId` helper; switch routes to
   `requireServerUser()` (drop the `x-lumo-user-id` header
   fallback — production requires real auth).
5. **Add Stripe webhook handler** at
   `/api/payments/webhooks/stripe` for `payment_intent.succeeded`,
   `payment_intent.payment_failed`, and `setup_intent.succeeded`
   to reconcile state if iOS misses a return trip.

### iOS-side (smaller half — mostly works automatically)

The iOS client switches to real PaymentSheet behavior **the moment
the server returns a non-null `clientSecret`** in the setup-intent
response. To complete the swap:

1. **Replace the synthetic add-card sheet body** in
   `PaymentMethodsView.AddPaymentMethodSheet` with a call to
   `PaymentSheet(setupIntentClientSecret:configuration:)` followed
   by `paymentSheet.present(from: presentingViewController)`. The
   surrounding view + form state machine stay; only the inner
   "input collection" widget changes from our SwiftUI form to
   Stripe's drop-in.
2. **Add ECDSA-P256 keypair generation at first sign-in.** New
   `BiometricConfirmationService.makeToken(...)` body uses
   `SecKeyCreateSignature` with the Secure Enclave-backed private
   key gated by `kSecAccessControlBiometryCurrentSet`. Send the
   public key to `/api/payments/register-device-key` once at first
   sign-in. The `SignedConfirmationToken` shape (digest + signature)
   stays the same; only the crypto primitive changes.
3. **Drop the `isStripeLiveMode` test-mode banner branch** in
   `PaymentMethodsView` once a live `pk_live_*` is provisioned.
4. **Wire `MOBILE-API-1` sync layer** to write through `ReceiptStore`
   from server `transactions` rows. The local store stays as a
   write-through cache + offline-history surface.

### Contract surface that should NOT change

Things MERCHANT-1 should preserve to keep the iOS client
unchanged:

- `PaymentMethod` JSON shape: `{ id, brand, last4, expMonth,
  expYear, isDefault, addedAt }`. Same field names, same types.
- `Receipt` JSON shape: `{ id, transactionId, amountCents, currency,
  paymentMethodId, paymentMethodLabel, lineItems, createdAt,
  status }`.
- `confirm-transaction` request body shape: `{ paymentMethodId,
  amountCents, currency, lineItems, transactionDigest (hex),
  signedConfirmationToken (base64) }`.
- HTTP status codes: 201 for created PaymentMethod, 404 for
  not-found, 4xx for validation errors. The iOS error decoder
  expects these.
- ISO 8601 with fractional seconds for all timestamps.

If MERCHANT-1 needs to break any of these for legitimate reasons,
file an issue at the same time the PR opens so the iOS client can
land its compatibility change in lockstep.
