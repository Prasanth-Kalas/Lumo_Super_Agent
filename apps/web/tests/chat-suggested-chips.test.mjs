/**
 * CHAT-SUGGESTED-CHIPS-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/chat-suggested-chips.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAssistantSuggestions } from "../lib/chat-suggestions.ts";

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.log(`  ✗ ${name}\n    ${error.stack ?? error.message}`);
  }
};

console.log("\nchat suggested chips");

const migration049 = readFileSync("../../db/migrations/049_chat_suggested_chips_events.sql", "utf8");
const orchestrator = readFileSync("lib/orchestrator.ts", "utf8");
const events = readFileSync("lib/events.ts", "utf8");
const page = readFileSync("app/page.tsx", "utf8");
const component = readFileSync("components/SuggestionChips.tsx", "utf8");
const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
const systemPrompt = readFileSync("lib/system-prompt.ts", "utf8");

await t("date clarification emits 2-4 complete suggested replies", () => {
  const frame = buildAssistantSuggestions({
    turnId: "turn-date",
    assistantText:
      "I've got a few date windows that look good — pick one or tell me what works. What dates should I use?",
    latestUserMessage: "Can you book a flight from Chicago to Vegas?",
    now: new Date("2026-05-01T12:00:00Z"),
  });
  assert.equal(frame?.kind, "assistant_suggestions");
  assert.equal(frame?.turn_id, "turn-date");
  assert.ok(frame.suggestions.length >= 2 && frame.suggestions.length <= 4);
  for (const suggestion of frame.suggestions) {
    assert.match(suggestion.id, /^s\d+$/);
    assert.ok(suggestion.label.length > 0);
    assert.match(suggestion.value, /\b(May|June)\b/);
  }
});

await t("free-text identity questions do not emit suggestions", () => {
  const frame = buildAssistantSuggestions({
    turnId: "turn-name",
    assistantText: "What are the passenger names exactly as they appear on the IDs?",
    now: new Date("2026-05-01T12:00:00Z"),
  });
  assert.equal(frame, null);
});

await t("airport and budget suggestions are domain-aware and bounded", () => {
  const airport = buildAssistantSuggestions({
    turnId: "turn-airport",
    assistantText:
      "I can use a few Chicago airports — pick one or tell me what works. Which departure airport should I use?",
    latestUserMessage: "Flight from Chicago to Vegas",
  });
  assert.deepEqual(
    airport?.suggestions.map((s) => s.value),
    [
      "Depart from Chicago O'Hare (ORD)",
      "Depart from Chicago Midway (MDW)",
      "Depart from either ORD or MDW, whichever has the better option",
    ],
  );

  const budget = buildAssistantSuggestions({
    turnId: "turn-budget",
    assistantText:
      "I've got a few budget lanes — pick one or tell me what works. What budget should I use?",
  });
  assert.ok((budget?.suggestions.length ?? 0) <= 4);
  assert.ok(budget?.suggestions.some((s) => /No hard budget/.test(s.value)));
});

await t("system prompt teaches suggestive clarification phrasing", () => {
  assert.match(systemPrompt, /ask ONE short clarifying question/);
  assert.match(systemPrompt, /suggested-answer chips/);
  assert.match(systemPrompt, /pick one or tell me what works/);
  assert.match(systemPrompt, /legal traveler names/);
});

await t("SSE protocol and event log include assistant_suggestions", () => {
  assert.match(chatRoute, /assistant_suggestions/);
  assert.match(orchestrator, /type: "assistant_suggestions"/);
  assert.match(events, /"assistant_suggestions"/);
  assert.match(migration049, /'assistant_suggestions'/);
});

await t("web shell tracks suggestions by turn and clears on submit", () => {
  assert.match(page, /suggestionsByTurn/);
  assert.match(page, /setSuggestionsByTurn\(\{\}\)/);
  assert.match(page, /replaySuggestions/);
  assert.match(page, /assistantSuggestionsToUI\(frame\.value\)/);
  assert.match(page, /assistantSuggestionsToUI\(raw\["suggestions"\]\)/);
  assert.match(page, /suggestionsTurnId/);
  assert.match(page, /userMessageExistsAfter\(m\.id\)\.exists/);
});

await t("SuggestionChips renders click-through values, not labels", () => {
  assert.match(component, /data-testid="suggestion-chips"/);
  assert.match(component, /onChipSelect\(suggestion\.value\)/);
  assert.match(component, /suggestion\.label/);
  assert.match(component, /overflow-x-auto/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
