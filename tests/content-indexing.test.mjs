/**
 * Content indexer privacy/chunking helpers.
 *
 * Run: node --experimental-strip-types tests/content-indexing.test.mjs
 */

import assert from "node:assert/strict";
import {
  buildAudioTranscriptTextChunks,
  buildArchiveTextChunks,
  redactForEmbedding,
  sourceEtag,
} from "../lib/content-indexing.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\ncontent indexing");

t("redacts common PII before embedding", () => {
  const redacted = redactForEmbedding(
    "Email alex@example.com or call +1 (415) 555-1212. Card 4242 4242 4242 4242.",
  );
  assert.match(redacted.text, /\[EMAIL\]/);
  assert.match(redacted.text, /\[PHONE\]/);
  assert.match(redacted.text, /\[CREDIT_CARD\]/);
  assert.equal(redacted.counts.email, 1);
  assert.equal(redacted.counts.phone, 1);
  assert.equal(redacted.counts.credit_card, 1);
});

t("redacts French contact and bank identifiers before embedding", () => {
  const redacted = redactForEmbedding(
    "Bonjour, contactez elise.dupont@example.fr ou +33 6 12 34 56 78. IBAN FR76 3000 6000 0112 3456 7890 189.",
  );
  assert.match(redacted.text, /\[EMAIL\]/);
  assert.match(redacted.text, /\[PHONE\]/);
  assert.match(redacted.text, /\[SECRET\]/);
  assert.doesNotMatch(redacted.text, /example\.fr/);
  assert.doesNotMatch(redacted.text, /FR76/);
  assert.equal(redacted.counts.email, 1);
  assert.equal(redacted.counts.phone, 1);
  assert.equal(redacted.counts.secret, 1);
});

t("redacts Spanish contact and passport identifiers before embedding", () => {
  const redacted = redactForEmbedding(
    "Telefono +34 612 345 678, correo ana.garcia@example.es, pasaporte X1234567.",
  );
  assert.match(redacted.text, /\[EMAIL\]/);
  assert.match(redacted.text, /\[PHONE\]/);
  assert.match(redacted.text, /\[SECRET\]/);
  assert.doesNotMatch(redacted.text, /example\.es/);
  assert.doesNotMatch(redacted.text, /X1234567/);
  assert.equal(redacted.counts.email, 1);
  assert.equal(redacted.counts.phone, 1);
  assert.equal(redacted.counts.secret, 1);
});

t("redacts Hindi contact and Aadhaar identifiers before embedding", () => {
  const redacted = redactForEmbedding(
    "ईमेल ravi.kumar@example.in और फोन +91 98765 43210. आधार 1234 5678 9012.",
  );
  assert.match(redacted.text, /\[EMAIL\]/);
  assert.match(redacted.text, /\[PHONE\]/);
  assert.match(redacted.text, /\[SECRET\]/);
  assert.doesNotMatch(redacted.text, /example\.in/);
  assert.doesNotMatch(redacted.text, /1234 5678 9012/);
  assert.equal(redacted.counts.email, 1);
  assert.equal(redacted.counts.phone, 1);
  assert.equal(redacted.counts.secret, 1);
});

t("extracts useful text and excludes token-shaped fields", () => {
  const chunks = buildArchiveTextChunks({
    id: 42,
    user_id: "user_1",
    agent_id: "google",
    external_account_id: "channel-123",
    endpoint: "gmail.messages.preview",
    request_hash: "reqhash",
    response_status: 200,
    fetched_at: "2026-04-26T00:00:00.000Z",
    response_body: {
      access_token: "secret-token-that-should-not-leak",
      message: {
        subject: "Vegas itinerary",
        snippet:
          "Alex sent the Vegas trip plan for next Saturday and asked Lumo to compare flights, hotels, and cab options.",
      },
    },
  });

  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Vegas itinerary/);
  assert.doesNotMatch(chunks[0].text, /secret-token/);
  assert.equal(chunks[0].metadata.external_account_hash.length, 64);
});

t("source etag is stable across object key order", () => {
  const base = {
    id: 1,
    user_id: "user_1",
    agent_id: "google",
    endpoint: "gmail",
    request_hash: "abc",
    response_status: 200,
    fetched_at: "2026-04-26T00:00:00.000Z",
  };
  const a = sourceEtag({ ...base, response_body: { b: 2, a: 1 } });
  const b = sourceEtag({ ...base, response_body: { a: 1, b: 2 } });
  assert.equal(a, b);
});

t("audio transcript chunks redact before recall indexing", () => {
  const chunks = buildAudioTranscriptTextChunks({
    id: 7,
    user_id: "user_1",
    audio_upload_id: "audio_1",
    storage_path: "users/user_1/audio_1.mp3",
    transcript:
      "Meeting note: Alex asked about Vegas hotels. Contact alex@example.com after the call.",
    segments: [{ start: 0, end: 5, text: "Meeting note" }],
    language: "en",
    duration_s: 8,
    model: "whisper-large-v3",
    created_at: "2026-04-26T00:00:00.000Z",
  });

  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /Vegas hotels/);
  assert.match(chunks[0].text, /\[EMAIL\]/);
  assert.equal(chunks[0].metadata.source, "audio_transcripts");
  assert.equal(chunks[0].metadata.model, "whisper-large-v3");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
