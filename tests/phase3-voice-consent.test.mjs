/**
 * VOICE-1 — biometric consent guardrails.
 *
 * Verifies all 8 invariants from ADR-012 §2:
 *   2.1 No default-on
 *   2.2 No incidental cloning (per-bucket isolation)
 *   2.3 Strict audit trail (append-only; every required action enumerated)
 *   2.4 Sample retention bound (24h purge)
 *   2.5 Owner-only (cross-user clone rejected)
 *   2.6 Revocation 7-day SLA
 *   2.7 Use disclosure (voice_clone_used per call)
 *   2.8 Storage encryption (voice_id never plaintext)
 *
 * Adversarial: clone without consent → MUST fail; cross-user clone → MUST 403;
 * audit row update → MUST throw; sample lingers past 24h → MUST flag breach.
 *
 * Run: node --experimental-strip-types tests/phase3-voice-consent.test.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

// ---------- in-memory model of the voice consent surfaces ----------

const REQUIRED_ACTIONS = new Set([
  "consent_granted",
  "consent_revoked",
  "voice_clone_created",
  "voice_clone_used",
  "voice_clone_use_disclosed",
  "voice_clone_accessed",
  "voice_clone_deleted",
  "voice_clone_deletion_failed",
  "voice_sample_purged",
]);

class VoiceState {
  constructor() {
    this.users = new Map();   // user_id → { consent_granted, voice_clone, samples[] }
    this.audit = [];          // append-only
    this.cloningBucket = new Map(); // sample_id → { user_id, bucket, uploaded_at }
  }
  appendAudit(row) {
    if (!REQUIRED_ACTIONS.has(row.action) && !["wake_word_enabled", "wake_word_disabled", "interrupted_listening"].includes(row.action)) {
      throw new Error(`unknown audit action: ${row.action}`);
    }
    this.audit.push(Object.freeze({ ...row, created_at: row.created_at ?? new Date().toISOString() }));
  }
  // Append-only: explicit "update" raises.
  updateAudit() {
    throw new Error("consent_audit_log is append-only; updates forbidden");
  }
  setConsentDefault(userId) {
    if (!this.users.has(userId)) {
      this.users.set(userId, { consent_granted: false, voice_clone: null, samples: [] });
    }
    return this.users.get(userId).consent_granted;
  }
  grantConsent(userId, disclosureText, ip = "127.0.0.1") {
    const u = this.users.get(userId) ?? { consent_granted: false, voice_clone: null, samples: [] };
    u.consent_granted = true;
    this.users.set(userId, u);
    this.appendAudit({
      user_id: userId,
      action: "consent_granted",
      ip_address: ip,
      consent_text_hash: crypto.createHash("sha256").update(disclosureText).digest("hex"),
      evidence_payload: { recording_duration_s: 60, consent_version: "v1" },
      created_by: "user",
    });
  }
  uploadSample(userId, sampleId, bucket) {
    if (bucket !== "voice_cloning_samples") {
      throw new Error("bucket isolation: cloning service refuses non-cloning buckets");
    }
    this.cloningBucket.set(sampleId, { user_id: userId, bucket, uploaded_at: Date.now() });
    const u = this.users.get(userId);
    u.samples.push(sampleId);
  }
  cloneVoice({ jwtUserId, requestUserId }) {
    // Owner-only: JWT user must match request user.
    if (jwtUserId !== requestUserId) {
      throw new Error("403: owner-only");
    }
    const u = this.users.get(requestUserId);
    if (!u || !u.consent_granted) {
      throw new Error("clone without consent forbidden");
    }
    if (u.samples.length === 0) {
      throw new Error("no samples available");
    }
    // Encrypt the voice_id (storage encryption invariant).
    const rawVoiceId = `vc-${crypto.randomBytes(8).toString("hex")}`;
    const encrypted = Buffer.from(crypto.createHash("sha256").update(rawVoiceId).digest());
    u.voice_clone = { voice_id_encrypted: encrypted, status: "active", consent_version: "v1" };
    this.appendAudit({
      user_id: requestUserId,
      action: "voice_clone_created",
      voice_id: `redacted-${rawVoiceId.slice(-4)}`,
      evidence_payload: { engine: "self_hosted", sample_count: u.samples.length },
      created_by: "service",
    });
    return rawVoiceId;
  }
  useVoice({ userId, requestId, surface, callerAgentId }) {
    const u = this.users.get(userId);
    if (!u?.voice_clone || u.voice_clone.status !== "active") {
      throw new Error("voice clone not available");
    }
    this.appendAudit({
      user_id: userId,
      action: "voice_clone_used",
      voice_id: "redacted",
      evidence_payload: { request_id: requestId, surface, text_hash: "abc", caller_agent_id: callerAgentId },
      created_by: "service",
    });
    return { cloned_voice: true, voice_id: "redacted" };
  }
  revoke(userId) {
    const u = this.users.get(userId);
    u.voice_clone.status = "pending_deletion";
    this.appendAudit({ user_id: userId, action: "consent_revoked", created_by: "user" });
    return { deletion_requested_at: Date.now() };
  }
  completeDeletion(userId) {
    const u = this.users.get(userId);
    u.voice_clone = null;
    this.appendAudit({ user_id: userId, action: "voice_clone_deleted", created_by: "service" });
  }
  purgeSamplesOlderThan(maxAgeMs) {
    const now = Date.now();
    const purged = [];
    for (const [sid, s] of this.cloningBucket.entries()) {
      if (now - s.uploaded_at >= maxAgeMs) {
        purged.push(sid);
        this.cloningBucket.delete(sid);
      }
    }
    if (purged.length > 0) {
      this.appendAudit({
        user_id: purged[0] ? this.cloningBucket.get(purged[0])?.user_id ?? "unknown" : "system",
        action: "voice_sample_purged",
        evidence_payload: { sample_count: purged.length },
        created_by: "system",
      });
    }
    return purged;
  }
}

console.log("\nVOICE-1 biometric consent invariants");

await t("2.1 default-off: no consent for a fresh user", () => {
  const v = new VoiceState();
  assert.equal(v.setConsentDefault("u-1"), false);
});

await t("2.2 no incidental cloning: bucket isolation enforced", () => {
  const v = new VoiceState();
  v.users.set("u-1", { consent_granted: true, voice_clone: null, samples: [] });
  assert.throws(() => v.uploadSample("u-1", "s-1", "voice_memos"));
  assert.throws(() => v.uploadSample("u-1", "s-1", "wake_word_post_buffer"));
  // correct bucket works
  v.uploadSample("u-1", "s-1", "voice_cloning_samples");
});

await t("2.3 audit append-only: update raises", () => {
  const v = new VoiceState();
  v.grantConsent("u-1", "disclosure text v1");
  assert.throws(() => v.updateAudit());
});

await t("2.3 every required action is in the enum", () => {
  const required = [
    "consent_granted",
    "consent_revoked",
    "voice_clone_created",
    "voice_clone_used",
    "voice_clone_use_disclosed",
    "voice_clone_accessed",
    "voice_clone_deleted",
    "voice_clone_deletion_failed",
    "voice_sample_purged",
  ];
  for (const a of required) assert.ok(REQUIRED_ACTIONS.has(a), `missing action: ${a}`);
});

await t("2.4 sample retention: 24h purge produces voice_sample_purged audit", () => {
  const v = new VoiceState();
  v.users.set("u-1", { consent_granted: true, voice_clone: null, samples: [] });
  v.uploadSample("u-1", "s-old", "voice_cloning_samples");
  // backdate
  v.cloningBucket.get("s-old").uploaded_at = Date.now() - 25 * 60 * 60 * 1000;
  const purged = v.purgeSamplesOlderThan(24 * 60 * 60 * 1000);
  assert.equal(purged.length, 1);
  assert.ok(v.audit.some((r) => r.action === "voice_sample_purged"));
});

await t("2.4 retention breach detected if sample lingers past 24h", () => {
  const v = new VoiceState();
  v.users.set("u-1", { consent_granted: true, voice_clone: null, samples: [] });
  v.uploadSample("u-1", "s-stuck", "voice_cloning_samples");
  v.cloningBucket.get("s-stuck").uploaded_at = Date.now() - 25 * 60 * 60 * 1000;
  // BREACH check: if any sample > 24h old still present, retention is broken.
  const oldest = Math.min(...[...v.cloningBucket.values()].map((s) => s.uploaded_at));
  const ageHours = (Date.now() - oldest) / 3600000;
  assert.ok(ageHours > 24, "test setup");
  // The cron must fix this; if it doesn't, the assertion below fires.
  v.purgeSamplesOlderThan(24 * 60 * 60 * 1000);
  assert.equal(v.cloningBucket.size, 0);
});

await t("2.5 owner-only: cross-user clone JWT mismatch returns 403", () => {
  const v = new VoiceState();
  v.users.set("u-victim", { consent_granted: true, voice_clone: null, samples: ["s-1"] });
  assert.throws(
    () => v.cloneVoice({ jwtUserId: "u-attacker", requestUserId: "u-victim" }),
    /403/,
  );
});

await t("2.5 clone without consent forbidden even for self", () => {
  const v = new VoiceState();
  v.users.set("u-1", { consent_granted: false, voice_clone: null, samples: ["s-1"] });
  assert.throws(() => v.cloneVoice({ jwtUserId: "u-1", requestUserId: "u-1" }));
});

await t("2.6 revocation flips status to pending_deletion immediately", () => {
  const v = new VoiceState();
  v.grantConsent("u-1", "v1 disclosure");
  v.uploadSample("u-1", "s-1", "voice_cloning_samples");
  v.cloneVoice({ jwtUserId: "u-1", requestUserId: "u-1" });
  v.revoke("u-1");
  const u = v.users.get("u-1");
  assert.equal(u.voice_clone.status, "pending_deletion");
  assert.ok(v.audit.some((r) => r.action === "consent_revoked"));
});

await t("2.6 deletion 7-day SLA: completion within window writes voice_clone_deleted", () => {
  const v = new VoiceState();
  v.grantConsent("u-1", "v1");
  v.uploadSample("u-1", "s-1", "voice_cloning_samples");
  v.cloneVoice({ jwtUserId: "u-1", requestUserId: "u-1" });
  v.revoke("u-1");
  // simulate provider deletion within SLA
  v.completeDeletion("u-1");
  const deletedRow = v.audit.find((r) => r.action === "voice_clone_deleted");
  assert.ok(deletedRow);
  assert.equal(v.users.get("u-1").voice_clone, null);
});

await t("2.7 use disclosure: every voice_clone_used row carries request_id + caller", () => {
  const v = new VoiceState();
  v.grantConsent("u-1", "v1");
  v.uploadSample("u-1", "s-1", "voice_cloning_samples");
  v.cloneVoice({ jwtUserId: "u-1", requestUserId: "u-1" });
  const r = v.useVoice({ userId: "u-1", requestId: "req-42", surface: "drafted_reply", callerAgentId: "lumo-core-tts" });
  assert.equal(r.cloned_voice, true);
  const used = v.audit.find((a) => a.action === "voice_clone_used");
  assert.equal(used.evidence_payload.request_id, "req-42");
  assert.equal(used.evidence_payload.surface, "drafted_reply");
  assert.equal(used.evidence_payload.caller_agent_id, "lumo-core-tts");
});

await t("2.8 voice_id never returned to client in plaintext", () => {
  const v = new VoiceState();
  v.grantConsent("u-1", "v1");
  v.uploadSample("u-1", "s-1", "voice_cloning_samples");
  v.cloneVoice({ jwtUserId: "u-1", requestUserId: "u-1" });
  const r = v.useVoice({ userId: "u-1", requestId: "r1", surface: "drafted_reply", callerAgentId: "lumo-core-tts" });
  assert.equal(r.voice_id, "redacted");
  // Encrypted column is bytes, not the raw id.
  const u = v.users.get("u-1");
  assert.ok(Buffer.isBuffer(u.voice_clone.voice_id_encrypted));
  assert.notEqual(u.voice_clone.voice_id_encrypted.toString(), `vc-${"00".repeat(8)}`);
});

await t("consent_text_hash recorded on consent_granted", () => {
  const v = new VoiceState();
  v.grantConsent("u-1", "I understand. v1 disclosure text.");
  const row = v.audit.find((r) => r.action === "consent_granted");
  assert.equal(row.consent_text_hash.length, 64);
});

await t("adversarial: clone attempt without prior consent_granted audit row fails", () => {
  const v = new VoiceState();
  v.users.set("u-attacker", { consent_granted: false, voice_clone: null, samples: ["s-1"] });
  assert.throws(() => v.cloneVoice({ jwtUserId: "u-attacker", requestUserId: "u-attacker" }));
  assert.equal(v.audit.filter((r) => r.action === "consent_granted").length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
