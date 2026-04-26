/**
 * Confirmation-card ↔ mission-step linkage tests.
 *
 * Run: node --experimental-strip-types tests/confirmation-card-mission-link.test.mjs
 */

import assert from "node:assert/strict";
import {
  applyCardOutcome,
  linkConfirmationCardToStep,
} from "../lib/confirmation-card-mission-link.ts";
import {
  linkConfirmationCard,
  resolveCardOutcome,
} from "../lib/mission-execution.ts";

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

async function main() {
console.log("\nconfirmation card mission link");

await t("linkConfirmationCardToStep returns the correct update shape", () => {
  const linked = linkConfirmationCardToStep(
    {
      id: "step_1",
      mission_id: "mission_1",
      status: "pending",
      confirmation_card_id: null,
    },
    "card_hash_1",
  );
  assert.deepEqual(linked, {
    ok: true,
    update: {
      confirmation_card_id: "card_hash_1",
      status: "awaiting_confirmation",
      error_text: null,
    },
  });
});

await t("applyCardOutcome approves awaiting-confirmation steps", () => {
  assert.deepEqual(
    applyCardOutcome(step("awaiting_confirmation"), "approved"),
    { ok: true, update: { status: "ready", error_text: null } },
  );
});

await t("applyCardOutcome dismisses awaiting-confirmation steps", () => {
  assert.deepEqual(
    applyCardOutcome(step("awaiting_confirmation"), "dismissed"),
    {
      ok: true,
      update: { status: "skipped", error_text: "confirmation dismissed" },
    },
  );
});

await t("applyCardOutcome expires awaiting-confirmation steps", () => {
  assert.deepEqual(
    applyCardOutcome(step("awaiting_confirmation"), "expired"),
    {
      ok: true,
      update: { status: "failed", error_text: "confirmation expired" },
    },
  );
});

await t("applyCardOutcome rejects steps that are not awaiting confirmation", () => {
  const result = applyCardOutcome(step("pending"), "approved");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "step_not_awaiting_confirmation:pending");
});

await t("linkConfirmationCard writes the card id and awaits confirmation", async () => {
  const db = mockMissionDb({
    missions: [{ id: "mission_1", state: "ready" }],
    steps: [
      {
        id: "step_2",
        mission_id: "mission_1",
        step_order: 1,
        agent_id: "flight",
        status: "pending",
        confirmation_card_id: null,
        error_text: null,
      },
    ],
  });
  const result = await linkConfirmationCard("step_2", "card_hash_2", { db });
  assert.equal(result.linked, true);
  assert.equal(db.tables.steps[0].status, "awaiting_confirmation");
  assert.equal(db.tables.steps[0].confirmation_card_id, "card_hash_2");
  assert.equal(db.tables.missions[0].state, "awaiting_confirmation");
});

await t("resolveCardOutcome approves one linked step and writes an event", async () => {
  const db = mockMissionDb({
    missions: [{ id: "mission_1", state: "awaiting_confirmation" }],
    steps: [
      {
        id: "step_1",
        mission_id: "mission_1",
        step_order: 0,
        agent_id: "open-maps",
        status: "pending",
        confirmation_card_id: null,
        error_text: null,
      },
      {
        id: "step_2",
        mission_id: "mission_1",
        step_order: 1,
        agent_id: "flight",
        status: "awaiting_confirmation",
        confirmation_card_id: "card_hash_3",
        error_text: null,
      },
      {
        id: "step_3",
        mission_id: "mission_1",
        step_order: 2,
        agent_id: "open-weather",
        status: "pending",
        confirmation_card_id: null,
        error_text: null,
      },
    ],
  });

  const result = await resolveCardOutcome("card_hash_3", "approved", { db });
  assert.deepEqual(result, { resolved: 1, outcome: "approved" });
  assert.equal(db.tables.steps[1].status, "ready");
  assert.equal(db.tables.steps[0].status, "pending");
  assert.equal(db.tables.steps[2].status, "pending");
  assert.equal(db.tables.events.length, 1);
  assert.equal(db.tables.events[0].event_type, "card_resolved");
  assert.equal(db.tables.events[0].payload.outcome, "approved");
});

await t("resolveCardOutcome moves mission to ready when every step is resolved", async () => {
  const db = mockMissionDb({
    missions: [{ id: "mission_2", state: "awaiting_confirmation" }],
    steps: [
      {
        id: "step_4",
        mission_id: "mission_2",
        step_order: 0,
        agent_id: "flight",
        status: "awaiting_confirmation",
        confirmation_card_id: "card_hash_4",
        error_text: null,
      },
      {
        id: "step_5",
        mission_id: "mission_2",
        step_order: 1,
        agent_id: "hotel",
        status: "skipped",
        confirmation_card_id: null,
        error_text: null,
      },
    ],
  });
  await resolveCardOutcome("card_hash_4", "approved", { db });
  assert.equal(db.tables.steps[0].status, "ready");
  assert.equal(db.tables.missions[0].state, "ready");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
}

function step(status) {
  return {
    id: "step_1",
    mission_id: "mission_1",
    status,
    confirmation_card_id: "card_hash",
  };
}

function mockMissionDb(seed) {
  const tables = {
    missions: seed.missions.map((row) => ({ ...row })),
    steps: seed.steps.map((row) => ({ ...row })),
    events: [],
  };
  return {
    tables,
    from(table) {
      return new MockQuery(tables, table);
    },
  };
}

class MockQuery {
  constructor(tables, table) {
    this.tables = tables;
    this.table = table;
    this.filters = [];
    this.inFilters = [];
    this.orderSpec = null;
    this.limitCount = null;
    this.operation = "select";
    this.updatePayload = null;
  }

  select() {
    this.operation = "select";
    return this;
  }

  update(payload) {
    this.operation = "update";
    this.updatePayload = payload;
    return this;
  }

  insert(values) {
    if (this.table === "mission_execution_events") {
      this.tables.events.push({ ...values });
    }
    return Promise.resolve({ error: null });
  }

  eq(column, value) {
    this.filters.push([column, value]);
    return this;
  }

  in(column, values) {
    this.inFilters.push([column, values]);
    return this;
  }

  order(column, options = {}) {
    this.orderSpec = [column, options.ascending !== false];
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    const rows = this.rowsForTable();
    const matches = rows.filter((row) => this.matches(row));
    if (this.operation === "update") {
      for (const row of matches) Object.assign(row, this.updatePayload);
      return { data: null, error: null };
    }
    let data = matches.map((row) => ({ ...row }));
    if (this.orderSpec) {
      const [column, ascending] = this.orderSpec;
      data.sort((a, b) => {
        const av = a[column] ?? "";
        const bv = b[column] ?? "";
        return ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
    }
    if (typeof this.limitCount === "number") data = data.slice(0, this.limitCount);
    return { data, error: null };
  }

  rowsForTable() {
    if (this.table === "missions") return this.tables.missions;
    if (this.table === "mission_steps") return this.tables.steps;
    if (this.table === "mission_execution_events") return this.tables.events;
    return [];
  }

  matches(row) {
    for (const [column, value] of this.filters) {
      if (row[column] !== value) return false;
    }
    for (const [column, values] of this.inFilters) {
      if (!values.includes(row[column])) return false;
    }
    return true;
  }
}

await main();
