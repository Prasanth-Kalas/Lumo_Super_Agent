/**
 * Phase-1 Intelligence Layer eval harness.
 *
 * This intentionally uses deterministic fixtures and pure-core modules so it
 * can run in CI without Supabase, Anthropic, OpenAI, or Lumo_ML_Service.
 *
 * Run: node --experimental-strip-types scripts/eval-phase1.mjs
 */

import assert from "node:assert/strict";
import {
  rankAgentsFallback,
  riskBadgeFallback,
} from "../lib/marketplace-intelligence-core.ts";
import {
  recallArchiveCore,
  recallArchiveFallback,
} from "../lib/archive-recall-core.ts";
import {
  LEAD_SCORE_THRESHOLD,
  scoreLeadHeuristic,
} from "../lib/lead-scoring.ts";

const results = [];

async function main() {
  await evalRanking();
  evalRiskBadges();
  evalRecall();
  evalClassifierFallback();
  await evalBrainFailureSmoke();

  const failed = results.filter((result) => !result.pass);
  console.log(JSON.stringify({ phase: "phase1-intelligence", results }, null, 2));
  if (failed.length > 0) {
    console.error(`Phase-1 eval failed: ${failed.map((item) => item.name).join(", ")}`);
    process.exit(1);
  }
}

async function evalRanking() {
  const ranked = rankAgentsFallback(
    "I'm going to Vegas next Saturday for a week. Book flights, hotels, cabs, food, events, attractions, and EV charging if I drive.",
    agents,
    ["flight"],
    8,
  ).ranked_agents;
  const relevance = {
    flight: 3,
    hotel: 3,
    "open-maps": 3,
    food: 2,
    "open-events": 2,
    "open-attractions": 2,
    "open-ev-charging": 1,
  };
  const score = ndcgAtK(ranked.map((item) => item.agent_id), relevance, 7);
  metric("ranking_ndcg_at_7", round(score), 0.82, score >= 0.82);
  assert.ok(ranked.slice(0, 4).some((item) => item.agent_id === "flight"));
  assert.ok(ranked.slice(0, 4).some((item) => item.agent_id === "hotel"));
}

function evalRiskBadges() {
  const badges = riskAgents.map((agent) => riskBadgeFallback({ agent }));
  const coverage = badges.length / riskAgents.length;
  const high = badges.filter((badge) => badge.level === "high").length;
  const review = badges.filter((badge) => badge.level === "review_required").length;
  metric("risk_badge_coverage", coverage, 1, coverage === 1);
  metric("risk_badge_high_or_review_count", high + review, 2, high + review >= 2);
}

function evalRecall() {
  const cases = [
    ["Where did Alex mention the Vegas partnership?", "archive_a"],
    ["Who asked about the hotel resort fees?", "archive_b"],
    ["Find my note about EV charging in Baker.", "archive_c"],
    ["Where did someone mention the conference keynote?", "archive_d"],
    ["Search my comments for the paid food campaign.", "archive_e"],
  ];
  const reciprocalRanks = cases.map(([query, expectedId]) => {
    const result = recallArchiveFallback(query, recallDocs, 5);
    const rank = result.hits.findIndex((hit) => hit.id === expectedId) + 1;
    return rank > 0 ? 1 / rank : 0;
  });
  const mrr =
    reciprocalRanks.reduce((sum, score) => sum + score, 0) /
    reciprocalRanks.length;
  metric("recall_mrr_at_5", round(mrr), 0.8, mrr >= 0.8);
}

function evalClassifierFallback() {
  const predictions = leadExamples.map((example) =>
    scoreLeadHeuristic(example.text).score >= LEAD_SCORE_THRESHOLD,
  );
  const labels = leadExamples.map((example) => example.lead);
  const stats = confusion(labels, predictions);
  metric("classifier_fallback_precision", round(stats.precision), 0.8, stats.precision >= 0.8);
  metric("classifier_fallback_recall", round(stats.recall), 0.8, stats.recall >= 0.8);
  metric("classifier_fallback_f1", round(stats.f1), 0.8, stats.f1 >= 0.8);
}

async function evalBrainFailureSmoke() {
  const result = await recallArchiveCore({
    query: "Where did Alex mention the Vegas partnership?",
    documents: recallDocs,
    baseUrl: "http://lumo-ml.test",
    authorizationHeader: "Bearer test",
    fetchImpl: async () => Response.json({ status: "ok", hits: "not-an-array" }),
    timeoutMs: 50,
    topK: 3,
    recordUsage: async () => {},
  });
  const pass =
    result.source === "fallback" &&
    result.error === "malformed_response" &&
    result.hits[0]?.id === "archive_a";
  metric("brain_malformed_recall_fallback", pass ? 1 : 0, 1, pass);
}

function metric(name, value, threshold, pass) {
  results.push({ name, value, threshold, pass });
}

function ndcgAtK(ids, relevance, k) {
  const actual = dcg(ids.slice(0, k).map((id) => relevance[id] ?? 0));
  const ideal = dcg(Object.values(relevance).sort((a, b) => b - a).slice(0, k));
  return ideal > 0 ? actual / ideal : 0;
}

function dcg(relevance) {
  return relevance.reduce(
    (sum, rel, index) => sum + (2 ** rel - 1) / Math.log2(index + 2),
    0,
  );
}

function confusion(labels, predictions) {
  const tp = labels.filter((label, index) => label && predictions[index]).length;
  const fp = labels.filter((label, index) => !label && predictions[index]).length;
  const fn = labels.filter((label, index) => label && !predictions[index]).length;
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  return {
    precision,
    recall,
    f1: (2 * precision * recall) / Math.max(precision + recall, 1e-9),
  };
}

function round(value) {
  return Number(value.toFixed(3));
}

function agent(
  agent_id,
  display_name,
  category,
  one_liner,
  intents,
  scopes,
  installed,
  requires_payment = false,
  pii_scope = [],
) {
  return {
    agent_id,
    display_name,
    domain: category.toLowerCase(),
    category,
    one_liner,
    intents,
    scopes,
    installed,
    connect_model: scopes.length > 0 ? "oauth2" : "none",
    requires_payment,
    pii_scope,
    health_score: 1,
    source: "lumo",
  };
}

const agents = [
  agent("flight", "Lumo Flights", "Travel", "Search and book flights.", ["search_flights"], [], true),
  agent("hotel", "Lumo Hotels", "Travel", "Find hotels in Las Vegas.", ["search_hotels"], [], false),
  agent("open-maps", "Open Maps", "Maps", "Routes, cabs, taxis, driving directions.", ["route"], [], false),
  agent("food", "Food Delivery", "Food", "Order meals and delivery.", ["order_food"], ["food:read", "food:orders"], false),
  agent("open-events", "Open Events", "Events", "Find concerts and shows.", ["events"], [], false),
  agent("open-attractions", "Open Attractions", "Travel", "Find things to do and tours.", ["attractions"], [], false),
  agent("open-ev-charging", "Open EV Charging", "EV", "Find EV charging stops.", ["charging"], [], false),
  agent("weather", "Weather", "Weather", "Read forecasts.", ["forecast"], [], false),
];

const riskAgents = [
  agent("weather", "Weather", "Weather", "Read forecasts.", ["forecast"], [], false),
  agent("calendar", "Calendar", "Productivity", "Read calendar.", ["calendar"], ["calendar:read"], false),
  agent("email", "Email", "Productivity", "Read and send email.", ["email"], ["email:read", "email:send"], false, false, ["email"]),
  agent("food", "Food Delivery", "Food", "Order food.", ["order_food"], ["food:read", "food:orders", "payment_method:read", "address:read"], false, true, ["address", "phone", "payment_method_id"]),
  agent("flight", "Flight Booking", "Travel", "Book flights.", ["book_flight"], ["flight:read", "flight:book", "passport:read", "payment_method:read"], false, true, ["name", "email", "passport", "payment_method_id"]),
  agent("events", "Events", "Events", "Find events.", ["events"], [], false),
  agent("maps", "Maps", "Maps", "Directions.", ["route"], [], false),
  agent("crm", "CRM", "Sales", "Manage leads.", ["crm"], ["contacts:read", "contacts:write"], false, false, ["email", "phone"]),
  agent("newsletter", "Newsletter", "Creator", "Read newsletter stats.", ["newsletter"], ["newsletter:read"], false),
  agent("social", "Social Publisher", "Creator", "Publish social posts.", ["social"], ["posts:read", "posts:write"], false),
];

const recallDocs = [
  doc("archive_a", "Alex mentioned the Vegas partnership idea in the creator inbox and asked for a follow-up deck.", "meta", "comments.sync"),
  doc("archive_b", "Maya asked about hotel resort fees before booking the Saturday check-in.", "hotel", "hotel.notes"),
  doc("archive_c", "Driving note: stop for EV charging in Baker before reaching Las Vegas.", "open-ev-charging", "stations.search"),
  doc("archive_d", "Conference organizer asked about a keynote slot and speaker fee.", "youtube", "comments.sync"),
  doc("archive_e", "Brand lead asked for a paid food campaign and media kit.", "food", "orders.leads"),
  doc("archive_f", "General engineering sync note with no trip context.", "github", "issues"),
];

function doc(id, text, source, endpoint) {
  return { id, text, source, metadata: { endpoint } };
}

const leadExamples = [
  { lead: true, text: "Our brand wants to sponsor your next video. Can you send rates to partnerships@example.com?" },
  { lead: true, text: "Could you join our podcast for an interview and send your consulting packages to producer@example.com?" },
  { lead: true, text: "We would like to hire you as an advisor for our workshop. What are your rates?" },
  { lead: true, text: "Can our startup retain you for consulting? Please email your proposal to founder@example.com." },
  { lead: true, text: "Our agency has a paid campaign and wants a brand deal. Send the business email to ops@example.com." },
  { lead: false, text: "Great video, I learned a lot from this." },
  { lead: false, text: "What camera are you using in the intro?" },
  { lead: false, text: "Can you make a tutorial about the spreadsheet formula?" },
  { lead: false, text: "Thanks, this saved me an hour." },
  { lead: false, text: "Do you have a playlist for beginners?" },
];

await main();
