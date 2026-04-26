/**
 * Image embedding pure-core tests.
 *
 * Run: node --experimental-strip-types tests/image-embedding.test.mjs
 */

import assert from "node:assert/strict";
import {
  embedImageCore,
  normalizeEmbedImageResponse,
} from "../lib/image-embedding-core.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \u2717 ${name}\n    ${e.message}`);
  }
};

console.log("\nimage embedding");

await t("missing ML config returns stable not_configured fallback", async () => {
  const result = await embedImageCore({
    input: { image_url: "https://example.com/a.jpg" },
    baseUrl: "",
    authorizationHeader: null,
    fetchImpl: async () => Response.json({}),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.status, "not_configured");
  assert.equal(result.model, "openai/clip-vit-base-patch32");
  assert.equal(result.dimensions, 512);
});

await t("normalizes valid CLIP response", async () => {
  const result = normalizeEmbedImageResponse(
    {
      status: "ok",
      model: "openai/clip-vit-base-patch32",
      dimensions: 3,
      embedding: [0.1, "0.2", -0.3],
      labels: [{ label: " receipt ", score: 0.8 }],
      summary_text: "Image appears to contain: receipt.",
      content_hash: "abc123",
    },
    42,
  );
  assert.equal(result?.status, "ok");
  assert.deepEqual(result?.embedding, [0.1, 0.2, -0.3]);
  assert.equal(result?.labels[0]?.label, "receipt");
  assert.equal(result?.latency_ms, 42);
});

await t("malformed response degrades without throwing", async () => {
  const result = await embedImageCore({
    input: { image_url: "https://example.com/a.jpg" },
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () => Response.json({ status: "ok", embedding: "broken" }),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.status, "error");
  assert.equal(result.error, "malformed_response");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
