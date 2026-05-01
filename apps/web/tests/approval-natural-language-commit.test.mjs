/**
 * APPROVAL-NATURAL-LANGUAGE-COMMIT-1 regression suite.
 *
 * Run: node --experimental-strip-types tests/approval-natural-language-commit.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  detectPendingInstallDecision,
  installStateChangeFrame,
  selectSinglePendingInstallProposal,
} from "../lib/mission-install-natural-language-core.ts";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${e.stack ?? e.message}`);
  }
};

const naturalLanguage = readFileSync("lib/mission-install-natural-language.ts", "utf8");
const sharedApproval = readFileSync("lib/mission-install-approval.ts", "utf8");
const installRoute = readFileSync("app/api/lumo/mission/install/route.ts", "utf8");
const chatRoute = readFileSync("app/api/chat/route.ts", "utf8");
const homePage = readFileSync("app/page.tsx", "utf8");
const missionCard = readFileSync("components/LumoMissionCard.tsx", "utf8");

console.log("\napproval natural-language commit");

t("detects typed approval and cancel only for clear install-card intents", () => {
  assert.equal(detectPendingInstallDecision("just approved"), "approve");
  assert.equal(detectPendingInstallDecision("yeah install it"), "approve");
  assert.equal(detectPendingInstallDecision("yes please"), "approve");
  assert.equal(detectPendingInstallDecision("sure, go ahead"), "approve");
  assert.equal(detectPendingInstallDecision("no thanks"), "cancel");
  assert.equal(detectPendingInstallDecision("skip this one"), "cancel");
  assert.equal(detectPendingInstallDecision("cancel that"), "cancel");
  assert.equal(detectPendingInstallDecision("no, don't install it"), "cancel");
  assert.equal(detectPendingInstallDecision("what airport do you mean?"), null);
});

t("single pending auto-install card is required before committing from text", () => {
  const flightProposal = {
    agent_id: "flight",
    display_name: "Lumo Flights",
    can_auto_install: true,
    approval_idempotency_key: "abc",
  };
  assert.deepEqual(
    selectSinglePendingInstallProposal({
      mission_id: "mission-1",
      install_proposals: [flightProposal],
    }),
    flightProposal,
  );
  assert.equal(
    selectSinglePendingInstallProposal({
      mission_id: "mission-2",
      install_proposals: [
        flightProposal,
        { agent_id: "hotel", display_name: "Lumo Hotels", can_auto_install: true },
      ],
    }),
    null,
  );
  assert.equal(
    selectSinglePendingInstallProposal({
      mission_id: "mission-3",
      install_proposals: [
        { agent_id: "google", display_name: "Google", can_auto_install: false },
      ],
    }),
    null,
  );
});

t("state-change frame updates the existing install card without a schema migration", () => {
  assert.deepEqual(
    installStateChangeFrame({
      mission_id: "mission-1",
      agent_id: "flight",
      display_name: "Lumo Flights",
      state: "approved",
    }),
    {
      kind: "mission_install_state_change",
      detail: {
        mission_id: "mission-1",
        agent_id: "flight",
        display_name: "Lumo Flights",
        state: "approved",
      },
    },
  );
});

t("natural-language commit uses the same approval transaction as the Approve button", () => {
  assert.match(sharedApproval, /export async function commitMissionInstallApproval/);
  assert.match(sharedApproval, /connectFirstPartySessionAppApproval/);
  assert.match(sharedApproval, /upsertSessionAppApproval/);
  assert.match(sharedApproval, /upsertAgentInstall/);
  assert.match(installRoute, /commitMissionInstallApproval/);
  assert.match(naturalLanguage, /commitMissionInstallApproval/);
  assert.match(naturalLanguage, /\.eq\("state", "awaiting_permissions"\)/);
  assert.match(naturalLanguage, /approval_idempotency_key/);
  assert.match(naturalLanguage, /profile_fields_requested/);
});

t("cancel path records a declined event and emits cancelled card state", () => {
  assert.match(naturalLanguage, /event_type: "permission_declined"/);
  assert.match(naturalLanguage, /source: "natural_language_install_commit"/);
  assert.match(naturalLanguage, /state: "cancelled"/);
  assert.match(naturalLanguage, /Cancelled \$\{display_name\}/);
});

t("chat route intercepts typed install decisions before normal orchestration", () => {
  const decisionIndex = chatRoute.indexOf("commitPendingInstallDecisionFromText");
  const runTurnIndex = chatRoute.indexOf("const turn = await runTurn");
  assert.ok(decisionIndex > 0, "chat route imports/calls commitPendingInstallDecisionFromText");
  assert.ok(runTurnIndex > 0, "chat route still calls runTurn");
  assert.ok(decisionIndex < runTurnIndex, "install decision is committed before runTurn");
  assert.match(chatRoute, /emit\(\{ type: "internal", value: pendingInstallDecision\.state_frame \}\)/);
  assert.match(chatRoute, /emit\(\{ type: "text", value: pendingInstallDecision\.assistant_text \}\)/);
  assert.match(chatRoute, /send\(\{ type: "done" \}\)/);
});

t("web shell consumes internal card state updates and mission card renders them", () => {
  assert.match(homePage, /missionInstallStateByMission/);
  assert.match(homePage, /missionInstallStateChangeToUI/);
  assert.match(homePage, /frame\.type === "internal"/);
  assert.match(homePage, /stateOverrides=\{/);
  assert.match(missionCard, /stateOverrides\?: Record<string, "done" \| "cancelled">/);
  assert.match(missionCard, /externalState === "done"/);
  assert.match(missionCard, /externalState === "cancelled"/);
  assert.match(missionCard, /Cancelled/);
});

t("repeated approval stays idempotent through the existing card key contract", () => {
  assert.match(sharedApproval, /sessionApprovalIdempotencyKey/);
  assert.match(sharedApproval, /approval_idempotency_key_mismatch/);
  assert.match(sharedApproval, /connectFirstPartySessionAppApproval/);
  assert.match(installRoute, /approval_idempotency_key/);
  assert.match(naturalLanguage, /approval_idempotency_key/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
