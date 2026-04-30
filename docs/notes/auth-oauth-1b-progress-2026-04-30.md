# AUTH-OAUTH-1b — progress + ready-for-review, 2026-04-30

Branch: `claude-code/auth-oauth-1b` (4 commits, branched from
`origin/main` at `684c633`).

## What shipped

All web + iOS deliverables from the brief, plus a small open-redirect
guard fix the new test suite caught.

| Area | Outcome |
|---|---|
| `/login` Continue with Google + Apple | Buttons render above the email form with an "or continue with email" divider. |
| `/signup` Continue with Google + Apple | Same shape, identical layout. |
| `/auth/callback` PKCE + ?next= round-trip | No fix needed — already calls `exchangeCodeForSession(code)` and round-trips `next` with a same-origin guard (`next.startsWith("/")`). |
| iOS Google client plist | Dropped at `apps/ios/Lumo/client_…apps.googleusercontent.com.plist`; xcodegen's default source rules add it to Copy Bundle Resources. |
| iOS URL schemes | `Info.plist` now declares `lumo` (auth callback) + `com.googleusercontent.apps.971943870024-…` (Google reversed-client-ID). |
| iOS Sign in with Apple | Untouched. Still works through `AuthenticationServices` + `AuthService.signInWithApple`. |
| iOS Sign in with Google | New `GoogleSignInService` runs ASWebAuthenticationSession against `https://<supabase>/auth/v1/authorize?provider=google&redirect_to=lumo://auth/callback`; auth code exchanged via existing `client.auth.exchangeCodeForSession`. No GoogleSignIn SDK dependency. |

## Files

**New (web):**
- `apps/web/lib/oauth-redirect.ts` — pure helper, builds the
  `redirectTo` URL with same-origin + protocol-relative guards.
- `apps/web/components/OAuthButtons.tsx` — shared component used by
  both pages. Inline brand glyphs (no Google-branded asset shipped).
- `apps/web/tests/auth-oauth-1b.test.mjs` — 17 source-level + helper
  contract tests.

**New (iOS):**
- `apps/ios/Lumo/Services/GoogleSignInService.swift` — protocol +
  impl + FakeGoogleSignInService stub for unit tests.
- `apps/ios/Lumo/client_971943870024-…apps.googleusercontent.com.plist`
  — Google client config (kept for compatibility with a future
  GoogleSignIn-SDK swap path).
- `apps/ios/LumoTests/GoogleSignInTests.swift` — 14 unit tests.

**New (scripts/docs):**
- `scripts/auth-oauth-1b-capture.mjs` — playwright capture for
  `/login` + `/signup` in light + dark.
- `docs/notes/auth-oauth-1b-screenshots/{login,signup}-{light,dark}.png`.

**Modified (web):**
- `apps/web/app/login/page.tsx` — imports + mounts `<OAuthButtons />`.
- `apps/web/app/signup/page.tsx` — same.
- `apps/web/package.json` — `playwright ^1.59.1` already added in
  WEB-REDESIGN-1; just appended `auth-oauth-1b.test.mjs` to the
  test script.

**Modified (iOS):**
- `apps/ios/Lumo/Resources/Info.plist` — adds CFBundleURLTypes for
  the two URL schemes.
- `apps/ios/Lumo/Services/AuthService.swift` — `signInWithGoogle()`
  protocol method + impl. Default-arg dance moved into the init
  body to satisfy Swift 6 main-actor isolation rules.
- `apps/ios/Lumo/ViewModels/AuthViewModel.swift` —
  `startGoogleSignIn()` with silent user-cancel handling.
- `apps/ios/Lumo/Views/AuthView.swift` — outlined "Continue with
  Google" button alongside `SignInWithAppleButton` + inline G glyph.
- `apps/ios/LumoTests/AuthStateMachineTests.swift` — `FakeAuthService`
  gets a no-op `signInWithGoogle` to satisfy the protocol.

## Tests

**31 new tests** total. All gates green.

| Suite | Tests | Coverage |
|---|---|---|
| Web `auth-oauth-1b` | 17 | `buildOAuthRedirectTo` open-redirect guards (http(s), `//`, empty, non-string), encoded `?next=` round-trip, encoded query/hash; `OAuthButtons.tsx` source contract (data-testid hooks, signInWithOAuth call shape, divider copy); `/login` + `/signup` mount-above-form ordering; `/auth/callback` `exchangeCodeForSession` + same-origin guard. |
| iOS `GoogleSignInTests` | 14 | `authorizeURL` builder (Supabase host + path + provider=google + redirect_to=lumo://auth/callback); `extractAuthCode` + `extractError` across happy / error-only / error-with-description / missing shapes; locked constants for callbackScheme + callbackHostPath; `FakeGoogleSignInService` call-count + cancel propagation; `AuthService.signInWithGoogle` fail-closed when Supabase env missing. |

iOS test bundle: 198 pass on iPhone 17 Simulator (184 prior + 14 new).
Web: full suite + 17 new pass via `npm test`.

## Open-redirect guard fix

The first `auth-oauth-1b` test run caught a real protocol-relative
URL bypass: `next = "//evil.example.com/steal"` starts with `/` and
slipped through the original `next.startsWith("/")` check. Fixed in
`lib/oauth-redirect.ts` by also rejecting `next.startsWith("//")`.
The web auth-callback route's same-origin guard already handled this
for emails returning to `/login`; the new helper now matches.

## Gates

- `npm run typecheck` — green.
- `npm run lint` — green; only pre-existing warnings in untouched files.
- `npm run lint:registry` — green.
- `npm run lint:commits` — green.
- `npm run build` — green.
- `npm test` — green (full web suite + 17 new).
- `xcodegen` — clean. `xcodebuild test` on iPhone 17 sim — 198 pass.
- Credential sweep across the diff — clean.

## Notes for review

1. **Inline G glyph rather than asset.** The web button uses an
   inline SVG with the Google quartered colors; iOS draws a small
   `ZStack` with a white circle + gradient "G". This keeps the
   bundle clean (no Google-branded image asset) and matches the
   "no GoogleSignIn SDK" stance of the brief. If brand review
   wants the official SVG, swapping it into `OAuthButtons.tsx` is a
   one-file change; iOS swap would be the same.

2. **Server-side OAuth is untouched.** AUTH-OAUTH-1a (the helper
   lib + admin/webhook flows) lives in a separate Codex lane per
   the brief. Nothing this lane shipped depends on it; both
   /login and /signup hit the public client OAuth path through
   `supabase.auth.signInWithOAuth`.

3. **iOS plist filename intentional.** Kept the long
   `client_971943870024-…apps.googleusercontent.com.plist` filename
   per the brief. If the Google SDK is ever re-introduced, that
   path is what `GIDClientID` looks up by default.

4. **`prefersEphemeralWebBrowserSession = false` on iOS.** Users
   already signed in to Google in Safari skip re-entering credentials.
   Trade-off: signing out of Lumo doesn't sign them out of Google in
   Safari. That's the correct behavior — we don't own their Google
   session — but worth flagging.

5. **No migrations, no env changes.** Supabase project provider
   config is the source of truth for client IDs / scopes / redirect
   URLs (per the brief, Apple + Google already saved as `Enabled`).
   No `LUMO_GOOGLE_OAUTH_*` env vars needed for the client-initiated
   flow.

## Commit shape

```
7dc98fc feat(web): screenshot capture for auth-oauth-1b + 4 shots
cdc95f8 test(auth): web + iOS contract tests for AUTH-OAUTH-1b
52fb1ce feat(ios): Continue with Google + plist + lumo:// URL scheme
cd449b7 feat(web): Continue with Google + Continue with Apple on /login + /signup
```

Ready for review. Merge instructions per the standing FF-merge protocol.
