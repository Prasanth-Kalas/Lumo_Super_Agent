/**
 * PDF extraction pure-core tests.
 *
 * Run: node --experimental-strip-types tests/pdf-extraction.test.mjs
 */

import assert from "node:assert/strict";
import {
  extractPdfCore,
  normalizeExtractPdfResponse,
} from "../lib/pdf-extraction-core.ts";

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

console.log("\npdf extraction");

await t("missing ML config returns stable not_configured fallback", async () => {
  const result = await extractPdfCore({
    input: { pdf_url: "https://example.com/a.pdf" },
    baseUrl: "",
    authorizationHeader: null,
    fetchImpl: async () => Response.json({}),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.status, "not_configured");
  assert.equal(result.pages.length, 0);
  assert.equal(result.error, "ml_extract_pdf_not_configured");
});

await t("normalizes valid layout response", async () => {
  const result = normalizeExtractPdfResponse(
    {
      status: "ok",
      pages: [
        {
          page_number: 2,
          blocks: [{ type: "table", text: " Room | Rate ", bbox: [0, 1, 2, 3] }],
        },
        {
          page_number: 1,
          blocks: [{ type: "heading", text: " Contract Terms " }],
        },
      ],
      total_pages: 2,
      language: "en",
    },
    42,
  );
  assert.equal(result?.status, "ok");
  assert.equal(result?.pages[0]?.page_number, 1);
  assert.equal(result?.pages[1]?.blocks[0]?.type, "table");
  assert.deepEqual(result?.pages[1]?.blocks[0]?.bbox, [0, 1, 2, 3]);
  assert.equal(result?.latency_ms, 42);
});

await t("malformed response degrades without throwing", async () => {
  const result = await extractPdfCore({
    input: { pdf_url: "https://example.com/a.pdf" },
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () => Response.json({ status: "maybe", pages: "broken" }),
    timeoutMs: 100,
    recordUsage: async () => {},
  });
  assert.equal(result.status, "error");
  assert.equal(result.error, "malformed_response");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
