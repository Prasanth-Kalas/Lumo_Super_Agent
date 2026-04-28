import assert from "node:assert/strict";
import {
  marketplaceAgentMatchesQuery,
  marketplaceAgentMatchesSegment,
  marketplaceCounts,
  marketplaceSegmentLabel,
  sortMarketplaceAgents,
} from "../lib/marketplace-ui.ts";

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

const agents = [
  {
    agent_id: "hotels",
    display_name: "Lumo Hotels",
    one_liner: "Book rooms across US cities.",
    domain: "travel",
    intents: ["book_hotel"],
    listing: { category: "Travel" },
    source: "lumo",
    install: { status: "installed" },
  },
  {
    agent_id: "gmail",
    display_name: "Google",
    one_liner: "Read calendar and email context.",
    domain: "productivity",
    intents: ["calendar.events"],
    listing: { category: "Productivity" },
    source: "lumo",
    connection: { status: "active" },
  },
  {
    agent_id: "slack-mcp",
    display_name: "Slack MCP",
    one_liner: "Message workspace channels.",
    domain: "work",
    intents: ["send_message"],
    listing: { category: "Work" },
    source: "mcp",
  },
  {
    agent_id: "rides",
    display_name: "Lumo Rides",
    one_liner: "Request rides from chat.",
    domain: "transport",
    intents: ["book_ride"],
    listing: { category: "Travel" },
    source: "coming_soon",
  },
];

console.log("\nmarketplace UI helpers");

t("counts separate connected, available, review-only, and MCP apps", () => {
  assert.deepEqual(marketplaceCounts(agents), {
    total: 4,
    connected: 2,
    available: 3,
    review: 1,
    mcp: 1,
  });
});

t("segment labels are user-facing", () => {
  assert.equal(marketplaceSegmentLabel("all"), "All");
  assert.equal(marketplaceSegmentLabel("review"), "Review only");
});

t("segment filters match the marketplace controls", () => {
  assert.equal(marketplaceAgentMatchesSegment(agents[0], "connected"), true);
  assert.equal(marketplaceAgentMatchesSegment(agents[2], "mcp"), true);
  assert.equal(marketplaceAgentMatchesSegment(agents[3], "review"), true);
  assert.equal(marketplaceAgentMatchesSegment(agents[0], "available"), false);
  assert.equal(marketplaceAgentMatchesSegment(agents[2], "available"), true);
});

t("query searches name, one-liner, domain, category, and intents", () => {
  assert.equal(marketplaceAgentMatchesQuery(agents[0], "rooms"), true);
  assert.equal(marketplaceAgentMatchesQuery(agents[1], "calendar"), true);
  assert.equal(marketplaceAgentMatchesQuery(agents[2], "work"), true);
  assert.equal(marketplaceAgentMatchesQuery(agents[3], "book_ride"), true);
  assert.equal(marketplaceAgentMatchesQuery(agents[3], "airport"), false);
});

t("sorting keeps connected apps first and review-only apps last", () => {
  assert.deepEqual(
    sortMarketplaceAgents(agents).map((agent) => agent.agent_id),
    ["gmail", "hotels", "slack-mcp", "rides"],
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
