import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const MIGRATIONS_DIR = "db/migrations";

// This helper intentionally reports the caller role as a diagnostic. Runtime
// authorization must still be enforced by GRANT EXECUTE boundaries.
const FUNCTION_ALLOWLIST = new Set(["mission_executor_claim_diagnostics"]);

const EXPECTED_036_FUNCTIONS = new Set([
  "next_audio_transcript_embedding_batch",
  "next_pdf_document_embedding_batch",
  "next_image_embedding_text_batch",
  "next_rollback_step_for_execution",
]);

function stripLineComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function extractFunctions(sql, file) {
  const stripped = stripLineComments(sql);
  const functions = [];
  const fnRe =
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z0-9_]+)"?\s*\([\s\S]*?\)\s*[\s\S]*?as\s+\$\$([\s\S]*?)\$\$/gi;

  let match;
  while ((match = fnRe.exec(stripped)) !== null) {
    functions.push({
      body: match[2],
      file,
      name: match[1].toLowerCase(),
    });
  }

  return functions;
}

function readLatestFunctionDefinitions() {
  const latestByName = new Map();

  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const fn of extractFunctions(sql, file)) {
      latestByName.set(fn.name, fn);
    }
  }

  return latestByName;
}

test("migration 036 redefines every active embedding/rollback claim RPC", () => {
  const sql = readFileSync(
    join(MIGRATIONS_DIR, "036_embedding_rpc_auth_hardening.sql"),
    "utf8",
  );
  const names = new Set(extractFunctions(sql, "036_embedding_rpc_auth_hardening.sql").map((fn) => fn.name));

  assert.deepEqual(names, EXPECTED_036_FUNCTIONS);
});

test("latest CREATE FUNCTION bodies do not gate service-role RPCs with auth.role()", () => {
  const offenders = [];

  for (const fn of readLatestFunctionDefinitions().values()) {
    if (FUNCTION_ALLOWLIST.has(fn.name)) continue;

    if (/auth\.role\s*\(\s*\)/i.test(fn.body)) {
      offenders.push(`${fn.file}:${fn.name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `auth.role() found inside active function body in: ${offenders.join(", ")}\n` +
      "This pattern caused silent cron failures when pooler calls had no Supabase JWT.\n" +
      "Service-role gating belongs in the GRANT EXECUTE boundary, not inside WHERE predicates.\n" +
      "If this is intentional, add the function name to FUNCTION_ALLOWLIST with justification.",
  );
});
