import assert from "node:assert/strict";
import agent, { sampleUnreadMessages } from "../src/index.ts";
import {
  createSampleContext,
  invokeSampleAgent,
} from "../../_shared/runtime.ts";

const ctx = createSampleContext({
  brain: {
    lumo_personalize_rank: async ({ items }) => ({
      ranked: items.map((item, index) => ({
        ...item,
        rank_score: index === 0 ? 0.91 : 0.55,
      })),
    }),
  },
  connectors: {
    gmail: {
      listUnread: async () => ({ messages: sampleUnreadMessages() }),
    },
  },
});

const first = await invokeSampleAgent(agent, "summarize_unread_inbox", {}, ctx);
const second = await invokeSampleAgent(agent, "summarize_unread_inbox", {}, ctx);
const firstOutputs = first.outputs as {
  total_unread: number;
  important_count: number;
};
const secondOutputs = second.outputs as { cached?: boolean };

assert.equal(first.status, "succeeded");
assert.equal(firstOutputs.total_unread, 3);
assert.equal(firstOutputs.important_count, 1);
assert.equal(second.status, "succeeded");
assert.equal(secondOutputs.cached, true);
assert.equal(ctx.costLog[0]?.usd, 0.018);
