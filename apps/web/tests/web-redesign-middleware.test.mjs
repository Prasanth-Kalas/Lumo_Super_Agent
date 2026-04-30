/**
 * WEB-REDESIGN-1 middleware contract — / is now authenticated-only.
 *
 * Run: node --experimental-strip-types tests/web-redesign-middleware.test.mjs
 *
 * Asserts:
 *   • PROTECTED_PAGE_EXACT exists and contains "/" — the new gate.
 *   • The middleware redirect path uses /login?next=… (preserves
 *     where the unauthed visitor was going).
 *   • The top-of-file doc comment block reflects "/" as Protected,
 *     not Public — so future reviewers see the new state.
 *   • Existing public allow-list (/login, /signup, /landing,
 *     /auth/callback) remains accessible — those routes must NOT be
 *     in PROTECTED_PAGE_PREFIXES or PROTECTED_PAGE_EXACT.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../middleware.ts", import.meta.url),
  "utf8",
);

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
};

console.log("\nweb-redesign middleware");

t("PROTECTED_PAGE_EXACT list exists and gates '/'", () => {
  // The list is declared as `const PROTECTED_PAGE_EXACT = [ ... "/" ... ]`.
  assert.match(SRC, /const\s+PROTECTED_PAGE_EXACT\s*=/);
  // Pull just the literal array body and verify "/" is in it.
  const m = SRC.match(/const\s+PROTECTED_PAGE_EXACT\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, "PROTECTED_PAGE_EXACT array literal not found");
  const body = m[1];
  assert.match(body, /["']\/["']/, '"/" not in PROTECTED_PAGE_EXACT');
});

t("isProtectedPage check uses PROTECTED_PAGE_EXACT.includes(pathname)", () => {
  assert.match(
    SRC,
    /PROTECTED_PAGE_EXACT\.includes\(pathname\)/,
  );
});

t("redirect target is /login with next=<pathname>+search", () => {
  assert.match(SRC, /loginUrl\.pathname\s*=\s*["']\/login["']/);
  assert.match(SRC, /loginUrl\.searchParams\.set\("next"/);
  assert.match(SRC, /pathname \+ search/);
});

t("doc comment block lists '/' as Protected (not Public)", () => {
  // The brief required updating the comment block at the top.
  // Pull the leading comment block and verify the new shape.
  const head = SRC.slice(0, SRC.indexOf("import "));
  assert.match(
    head,
    /\/\s*—\s*the chat shell\.\s*Authed users land on it\./,
    'doc block must describe "/" as the chat shell behind auth',
  );
  // Isolate just the Public routes block and verify it does NOT list
  // "/" as the landing. The Protected block legitimately lists "/" —
  // we only check the Public block.
  const publicBlockMatch = head.match(
    /Public routes \(no gate\):[\s\S]*?(?=\n\s*\*\s*\n\s*\*\s*Protected:)/,
  );
  assert.ok(publicBlockMatch, "Public routes block not found in doc");
  const publicBlock = publicBlockMatch[0];
  // Reject any "- /  —  the landing chat" -style entry, but allow
  // /login, /signup, /api/*, /.well-known/* which all start with "/<word>".
  assert.equal(
    /^\s*\*\s*-\s*\/\s+—/m.test(publicBlock),
    false,
    'Public-routes block still lists "/" as a public landing',
  );
});

t("public-allow-list paths remain accessible", () => {
  // Each of these MUST NOT appear inside the protected lists.
  const protectedExact = (SRC.match(/const\s+PROTECTED_PAGE_EXACT\s*=\s*\[([^\]]*)\]/) ?? ["", ""])[1];
  const protectedPrefixes = (SRC.match(/const\s+PROTECTED_PAGE_PREFIXES\s*=\s*\[([\s\S]*?)\];/) ?? ["", ""])[1];
  for (const route of ["/login", "/signup", "/landing", "/auth/callback"]) {
    assert.equal(
      protectedExact.includes(`"${route}"`) || protectedPrefixes.includes(`"${route}"`),
      false,
      `public route ${route} should not be gated`,
    );
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
