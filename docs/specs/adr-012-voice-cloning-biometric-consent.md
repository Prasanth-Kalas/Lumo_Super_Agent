# ADR-012 — Voice Cloning Biometric Consent

**Status:** Accepted (sealed 2026-04-27). Codex VOICE-1 implements against this ADR.
**Authors:** Coworker A (architecture pass), reviewed by Kalas (CEO/CTO/CFO).
**Related:** `docs/specs/lumo-intelligence-layer.md`,
`docs/specs/phase-4-outlook.md` (Anchor 2),
`docs/specs/adr-010-wake-word-engine.md`,
`docs/specs/phase-3-master.md` (VOICE-1 entry).
**Implements:** the consent, audit, and revocation posture for voice
cloning. This is not a how-to-clone-a-voice ADR; it is the
guardrails ADR that VOICE-1 cannot ship without.

**Cost posture:** self-hosted or open-weight voice cloning is the v1
default. A third-party cloning API may be used only as a temporary
fallback when quality, latency, or legal review proves the self-hosted
path is not ship-ready.

---

## 1. Context

Voice prints are biometric data. Under GDPR Article 9 they are a
"special category" — processing is prohibited unless one of the
explicit lawful bases applies. Under CCPA/CPRA (effective in
California, where the test user lives) voice biometrics are
"sensitive personal information" with heightened opt-in
requirements. Under BIPA (Illinois) voice prints carry statutory
damages of $1,000 per negligent violation, $5,000 per intentional.

Lumo's posture is conservative on principle: even where the law is
permissive, we treat voice cloning as a sensitive feature that the
user must explicitly opt into, with audit trails dense enough to
prove consent and revocation if challenged.

This ADR is sealed before VOICE-1 starts implementation because the
guardrails need to be in place at the schema level, not bolted on
later.

---

## 2. Mandatory invariants

These invariants are non-negotiable. VOICE-1 cannot ship without
all of them.

### 2.1 No default-on

- Voice cloning is **off by default** for every user, every tenant.
- There is no admin toggle, no marketing flag, no rollout ramp that
  can flip cloning on without each individual user's explicit
  consent.
- The opt-in is via a deliberate "Record me to clone my voice"
  flow. Not a settings checkbox buried in a panel; a dedicated
  consent screen with the disclosures below (§5).

### 2.2 No incidental cloning

- Voice samples used to clone must come from a **purposeful "record
  me" UI**, not from voice memos, dictation, wake-word post-buffers,
  or background ambient audio.
- The recording session is explicitly scoped: a 30-90 second
  prompt-driven script ("Read these three sentences"). The audio
  used for cloning is *only* the audio captured in that session.
- Audio captured for any other purpose (wake-word post-buffer,
  dictation, voice-to-text transcription) is **forbidden** as a
  cloning source. Codex enforces this with a per-bucket isolation:
  cloning samples land in a dedicated `voice_cloning_samples`
  bucket; the cloning service refuses input from any other bucket.

### 2.3 Strict audit trail

Every clone-relevant action writes a row to a new table
`consent_audit_log`:

```sql
create table public.consent_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  action text not null,                     -- enumerated below
  voice_id text,                            -- provider/local voice id, when applicable
  ip_address inet,
  user_agent text,
  timestamp timestamptz not null default now(),
  evidence_payload jsonb not null default '{}'::jsonb,
  created_by text not null,                 -- 'user' | 'system' | 'admin' | 'service'
  unique (user_id, action, timestamp, voice_id)
);

create index consent_audit_log_user on public.consent_audit_log (user_id, timestamp desc);
create index consent_audit_log_voice on public.consent_audit_log (voice_id) where voice_id is not null;
```

Required actions:

| `action` | When written | Required `evidence_payload` keys |
|---|---|---|
| `consent_granted` | User completes opt-in flow | `consent_text_hash`, `consent_version`, `recording_duration_s` |
| `consent_revoked` | User clicks "delete my voice" | `revocation_reason` (optional, free text) |
| `voice_clone_created` | The cloning engine returns a voice_id | `voice_id`, `model`, `provider`, `sample_count` |
| `voice_clone_used` | TTS playback uses the cloned voice | `request_id`, `surface`, `text_hash`, `caller_agent_id` |
| `voice_clone_use_disclosed` | Each use that surfaces user-visible disclosure | `request_id`, `disclosure_type` |
| `voice_clone_accessed` | Any read of the voice_id (admin debug, support) | `accessor_user_id`, `reason`, `ticket_ref` |
| `voice_clone_deleted` | Provider/local clone delete succeeded | `voice_id`, `provider`, `deletion_evidence` |
| `voice_clone_deletion_failed` | Provider/local clone delete failed | `voice_id`, `provider`, `error_code`, `retry_count` |
| `voice_sample_purged` | Raw sample audio deleted from temp storage | `sample_count`, `purge_evidence` |

The audit table is append-only. Updates are forbidden by an RLS
policy. Deletes are forbidden except via the user-deletion cascade
when an account is fully terminated. The append-only constraint is
also enforced by an `BEFORE UPDATE` trigger that raises an
exception.

Service-role only writes; users cannot insert, update, or delete
their own audit rows.

### 2.4 Sample retention bound

- Raw audio samples land in `voice_cloning_samples` Supabase bucket,
  scoped per user, encrypted at rest with the bucket's default key.
- Within **24 hours** of clone success, the raw samples are deleted
  by a hard-delete cron (`/api/cron/purge-voice-samples`). The cron
  writes a `voice_sample_purged` audit row. The cron runs hourly to
  bound worst-case retention.
- After the purge, only the encrypted clone reference (`voice_id`)
  and provider metadata are retained. No raw audio is retained by Lumo.
- The 24h bound covers retry windows: if a clone fails, we have
  one retry within 24h; if both fail, samples are still purged
  and the user re-records.
- `LUMO_VOICE_SAMPLE_TTL_HOURS=24` is documented in the deploy
  config. Lowering it is fine (faster purge); raising it requires
  an ADR addendum.

### 2.5 Owner-only

- Voice cloning is restricted to the **account owner**, never to
  agents acting on the owner's behalf, never shared with other
  users on the same workspace.
- The cloning endpoint requires a session-bound user JWT, not a
  service JWT, not a delegated agent JWT. An agent calling the
  cloning endpoint with a service JWT receives 403.
- The voice_id is keyed in `voice_clones(user_id, voice_id, ...)`
  with a unique constraint on `user_id` (one voice clone per user
  in v1; multi-clone is a Phase-5+ feature).
- A user cannot clone another user's voice through any path. The
  cloning endpoint refuses requests where the `user_id` in the JWT
  does not match the `user_id` in the request body.

### 2.6 Revocation: one-click, 7-day SLA

- Workspace settings exposes a single one-click "Delete my voice"
  action.
- Click triggers:
  1. Immediate UI-level disable: the cloned-voice TTS path stops
     being available immediately (synchronous in-memory cache
     invalidation).
  2. Async provider/local deletion job to delete the clone from
     the active engine. Retried up to 5 times over 24h with
     exponential backoff.
  3. `consent_revoked` audit row written immediately.
  4. `voice_clone_deleted` audit row written when the provider/local engine
     confirms.
  5. `voice_clones` row hard-deleted only after the provider/local
     deletion is confirmed; until then the row is marked
     `status='pending_deletion'` and the cloned-voice path
     refuses to serve.
- **Deletion SLA: 7 days.** From the user click, the clone must
  be removed from the provider/local store and from `voice_clones` within 7
  days. If after 7 days the deletion has not confirmed, the
  on-call engineer is paged with a P1.
- If deletion permanently fails (the provider/local engine returns an error we
  cannot recover from), an admin-side manual escalation path
  exists. The user is notified that deletion is in progress.

### 2.7 Use disclosure

- Every TTS playback that uses a cloned voice is flagged in both
  the request and the response:
  - Request: `voice_id` is set; the brain logs
    `voice_clone_used` with the `request_id`, surface,
    `text_hash`, and the caller's agent_id.
  - Response: the response envelope includes
    `cloned_voice: true` and the `voice_id`. The client can
    render a small disclosure ("This was read in your voice") on
    surfaces where the user benefits from knowing.
- Use telemetry powers the abuse-detection guardrail (§4): if
  the use rate spikes anomalously for a user, an alert fires.

### 2.8 Storage encryption

- The `voice_id` column is stored encrypted at rest using
  pgcrypto's `pgp_sym_encrypt` with a key from the platform
  secrets manager (Vercel/Supabase env). The decrypt-on-read
  function is service-role only.
- The voice_id is never exposed to the client. The client gets a
  short-lived TTS-call token, the server uses the token to fetch
  the voice_id and call the active voice engine server-side.
- A leaked voice_id is not directly weaponisable without access to
  the active voice engine, but the encryption-at-rest invariant
  removes the "voice_id leaked from a Postgres dump" attack
  surface.

---

## 3. Schema

```sql
create table public.voice_clones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,             -- one clone per user in v1
  voice_id_encrypted bytea not null,        -- encrypted provider/local voice id
  provider text not null default 'self_hosted',
  status text not null default 'active',    -- 'active' | 'pending_deletion' | 'failed'
  consent_version text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  deletion_requested_at timestamptz,
  deletion_completed_at timestamptz
);

-- RLS: user can read their own row but cannot read voice_id_encrypted directly.
-- A service-role function `get_voice_id_for_tts(user_id)` decrypts and returns.

create index voice_clones_status on public.voice_clones (status);
create index voice_clones_deletion_pending
  on public.voice_clones (deletion_requested_at)
  where status = 'pending_deletion';
```

Helper functions:

- `request_voice_id_for_tts(user_id, request_id, surface, caller_agent_id) returns text`
  — service-role only. Decrypts and returns voice_id, writes a
  `voice_clone_used` audit row in the same transaction.
- `revoke_voice_clone(user_id) returns void` — sets status to
  `pending_deletion`, writes `consent_revoked`, schedules the
  provider/local delete via the cron queue.

---

## 4. Abuse detection guardrails

Even with all the invariants, we still need detection for misuse
patterns:

- **Use-rate spike.** If `voice_clone_used` rows for a user exceed
  100/day (vs. a ~5-20/day baseline for engaged users), an alert
  fires. May be legitimate (active session); may indicate token
  theft or a runaway agent. Investigated case-by-case.
- **Cross-surface spread.** If a user's voice is being used on
  surfaces other than the documented allow-list (drafted-reply
  read-back, JARVIS responses, confirmation summaries), an alert
  fires. Adding a new surface is a deliberate code change that
  goes through this ADR.
- **Cross-agent caller.** Only Lumo Core's TTS service should call
  `request_voice_id_for_tts`. Any other caller fires a P1 alert.
- **Repeated deletion failures.** A `voice_clone_deletion_failed`
  count > 3 for any user fires a P1.

---

## 5. Consent flow UX

The opt-in flow is a single dedicated screen with three sections:

### 5.1 Disclosure (must read before recording)

Plain-language explanation with these required points:

1. "Lumo will record a 30-90 second sample of your voice."
2. "We will create a voice clone tied to your account, used only
   to read drafted replies, brief summaries, and confirmations
   back to you."
3. "Your voice clone is never used by another user. Lumo will
   never clone someone else's voice without their consent."
4. "Audio samples are deleted from our servers within 24 hours
   of cloning. Only the cloned voice profile is kept."
5. "You can delete your voice at any time. We will remove it
   from our systems and from our voice provider within 7 days."
6. "Voice prints are biometric data. We treat them with the same
   care as a password."
7. A direct link to the privacy policy section on biometric data.

The user must click "I understand" to proceed. The click writes a
`consent_granted` row with `consent_text_hash` set to the SHA-256 of
the disclosure text shown (so a future audit can prove which
version of the disclosure was shown).

### 5.2 Recording

A prompt-driven recording session. The user reads three sentences
displayed on screen. Recording is in-browser (or in-app on mobile);
the recorded audio is uploaded directly to the
`voice_cloning_samples` bucket with a per-user signed URL valid
for 5 minutes.

The user can re-record any sentence. The user can cancel at any
point. Cancelling deletes any partial samples immediately and writes
a `consent_revoked` audit row (since consent was granted but the
clone never materialised).

### 5.3 Confirmation

After clone success, the user hears a sample playback in their
own voice ("Hi, this is your Lumo voice. You can change this any
time in settings."). The user clicks "Sounds right" or "Try
again." "Sounds right" finalises; "Try again" deletes the
voice_id and re-runs the recording flow.

The opt-in flow is mandatory. There is no "skip" path. Cloning
without going through this flow is a bug.

---

## 6. What happens when the user revokes consent

Synchronous (within the click handler):

1. UI disables the cloned-voice path immediately. Any in-flight
   TTS requests using the voice continue to play but no new
   requests are issued.
2. `consent_revoked` audit row written.
3. `voice_clones.status` set to `pending_deletion`.
4. `voice_clones.deletion_requested_at` set to now.
5. Job enqueued: `delete_voice_clone(voice_id)` on the cron queue.

Asynchronous (within 7 days):

6. Cron worker calls the provider/local delete operation. On success, writes
   `voice_clone_deleted` audit row, hard-deletes
   `voice_clones` row, writes `voice_sample_purged` if any
   samples are still in the bucket (defence in depth).
7. On non-2xx, retry with exponential backoff (5 attempts over
   24h). After all retries fail, write
   `voice_clone_deletion_failed` and page on-call.

---

## 7. Legal-basis posture

Documented for the DPIA/RoPA. This is not legal advice; it is the
posture engineering implements.

- **GDPR.** Consent (Art 9(2)(a)) is the lawful basis. Consent is
  freely given, specific, informed, unambiguous, and revocable —
  matching the Art 7 requirements via the consent-flow UX above.
  Right-to-erasure is the revocation flow with a 7-day SLA.
- **CCPA/CPRA.** Voice biometrics are sensitive personal
  information. Opt-in is explicit. The user can request deletion
  via the same revocation flow; the SLA exceeds CCPA's 45-day
  deletion requirement comfortably.
- **BIPA.** Illinois biometric law requires written consent
  before collection. The consent flow's "I understand" click,
  combined with the audit row that records the disclosure text
  hash and the user's identifying fields, satisfies the written
  consent requirement under standard interpretation. We
  conservatively retain the audit row for 7 years post-deletion
  (BIPA's statute of limitations is 5; 7 gives buffer).
- **Cross-border.** The v1 target is self-hosted cloning in Lumo's
  controlled infrastructure, keeping voice-print processing inside
  our chosen region. If a third-party cloning API is temporarily used,
  its DPA/SCC posture must be reviewed before production traffic.

---

## 8. Acceptance criteria for VOICE-1

VOICE-1 ships when:

1. Migration adds `consent_audit_log` (with append-only trigger)
   and `voice_clones` (with encryption helpers and RLS).
2. The consent flow UX is implemented and a CI test verifies the
   `consent_granted` audit row is written with the correct hash.
3. The recording flow uploads to a dedicated bucket; the cloning
   service refuses inputs from any other bucket (test: attempt
   from a different bucket returns 403).
4. The self-hosted cloning engine produces a clone for the test user;
   `voice_clone_created` audit row written.
5. `request_voice_id_for_tts` writes `voice_clone_used` for every
   call; the response envelope flags `cloned_voice: true`.
6. The 24h sample-purge cron runs hourly and produces
   `voice_sample_purged` audit rows.
7. End-to-end revocation test: enroll, clone, use, revoke. Verify
   provider/local clone deletion completes within the 7-day SLA (in
   test, we mock the provider to confirm immediately). All required
   audit rows are present.
8. Owner-only test: a user A's session JWT cannot clone user B's
   voice (test returns 403).
9. Encryption-at-rest test: `voice_id_encrypted` column is
   non-empty bytes; raw decrypt requires service role.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Clone sample leaks before 24h purge | Bucket is private; per-user scoped; signed URLs expire in 5 min; purge cron runs hourly not daily |
| Voice_id leaked from a Postgres dump | Encrypted at rest with pgcrypto; service-role decryption only |
| Revocation API permanently fails on provider side | 5-retry exponential backoff; manual escalation; user notified; P1 page on permanent failure |
| Audit trail gaps | Append-only enforced at the trigger level; every clone-relevant action has a defined audit shape; CI tests verify shape |
| Misuse via incidental capture | Per-bucket isolation; cloning service refuses inputs from non-cloning buckets |
| Owner-only bypass via shared workspace | Cloning endpoint requires session JWT; agent JWTs return 403; user_id JWT match enforced |
| Use-rate abuse (token theft) | Per-user use-rate alerts; surface allow-list enforcement |
| Disclosure version drift | `consent_text_hash` recorded; consent flow shows current version; old versions still produce a valid hash on the audit row |
| Cross-jurisdiction biometric law expansion | DPIA/RoPA reviewed quarterly; ADR addendum if a new jurisdiction's law affects posture |

---

## 10. Open questions

1. Multi-clone per user (e.g., "casual voice" and "business
   voice"). Out of scope for v1 — we ship one clone per user.
   Phase-5+ feature.
2. Family-sharing (a parent enrolling a child's voice) — explicitly
   forbidden in v1. Adult, account-owner only.
3. Watermarking the cloned-voice audio output (C2PA-style). Listed
   as a Phase-4.5 follow-up in the Phase-4 outlook; not blocking
   VOICE-1 acceptance.
4. Voice-clone playback on third-party-facing channels (phone
   calls, voicemail). Not in v1. Phase-4.5+ behind a separate
   per-channel consent flow.
5. Clone refresh (user re-records to update aging voice). v1 ships
   a "Re-record my voice" path that goes through the same consent
   flow as the initial enrollment, deletes the old clone first,
   creates the new clone. The deletion of the old clone goes
   through the same 7-day SLA path.

---

## 11. Decision log

| Date | Decision |
|---|---|
| 2026-04-27 | Voice cloning is opt-in only with a dedicated consent flow; no default-on, no incidental cloning |
| 2026-04-27 | `consent_audit_log` is append-only with mandatory action enumeration |
| 2026-04-27 | Raw audio samples are hard-deleted within 24h of clone success |
| 2026-04-27 | Voice cloning is owner-only; agents and other users cannot clone or use another user's voice |
| 2026-04-27 | Revocation is one-click with a 7-day deletion SLA covering the clone provider/local store and Lumo storage |
| 2026-04-27 | Self-hosted/open-weight cloning is the v1 default; third-party cloning APIs are fallback only |
| 2026-04-27 | Every cloned-voice TTS use is flagged in request and response and audit-logged |
| 2026-04-27 | `voice_id` is encrypted at rest; service-role decryption only; never exposed to client |
| 2026-04-27 | Cloning samples land in a dedicated bucket; cloning service refuses inputs from any other bucket |
| 2026-04-27 | GDPR/CCPA/BIPA posture documented; consent_text_hash recorded for legal defensibility |
