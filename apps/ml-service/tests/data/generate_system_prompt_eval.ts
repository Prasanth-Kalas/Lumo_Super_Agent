#!/usr/bin/env node --experimental-strip-types
// Seeds tests/data/system_prompt_eval.jsonl with TS-generated expected
// outputs for the SYSTEM-PROMPT-MIGRATE-PYTHON-1 eval harness.
//
// Re-run when the TS source changes:
//   cd apps/ml-service/tests/data
//   node --experimental-strip-types generate_system_prompt_eval.mjs > system_prompt_eval.jsonl
import { buildSystemPrompt } from "../../../../apps/web/lib/system-prompt.js";

const NOW = new Date("2026-05-02T12:30:45.123Z");

const AGENTS_HEALTHY = [
  {
    manifest: {
      display_name: "Flight Agent",
      agent_id: "lumo.flight",
      one_liner: "Search and book flights",
      example_utterances: [
        "Show me flights to Vegas",
        "Price a round trip",
        "Book my flight",
      ],
    },
    health_score: 1.0,
  },
  {
    manifest: {
      display_name: "Hotel Agent",
      agent_id: "lumo.hotel",
      one_liner: "Find and book hotels",
      example_utterances: ["Hotels near the Eiffel Tower"],
    },
    health_score: 1.0,
  },
];

const AGENTS_MIXED = [
  ...AGENTS_HEALTHY,
  {
    manifest: {
      display_name: "Food Agent",
      agent_id: "lumo.food",
      one_liner: "Order delivery and dine-in",
      example_utterances: ["Order pizza"],
    },
    health_score: 0.4,
  },
];

const PROFILE_FULL = {
  id: "u_1",
  display_name: "Alex",
  timezone: "America/Los_Angeles",
  preferred_language: "en",
  home_address: { label: "Home", line1: "123 Main", city: "Chicago", region: "IL", country: "US" },
  work_address: null,
  dietary_flags: ["vegetarian"],
  allergies: ["peanuts"],
  preferred_cuisines: ["thai", "italian"],
  preferred_airline_class: "economy",
  preferred_airline_seat: "aisle",
  frequent_flyer_numbers: null,
  preferred_hotel_chains: ["marriott"],
  budget_tier: "mid",
  preferred_payment_hint: "Visa ending 4242",
  extra: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const FACTS_TWO = [
  { id: "f1", user_id: "u_1", fact: "always books window seat on red-eyes", category: "preference", source: "explicit", confidence: 0.9, supersedes_id: null, first_seen_at: "2026-01-01T00:00:00Z", last_confirmed_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: "f2", user_id: "u_1", fact: "spouse name is Jordan", category: "identity", source: "explicit", confidence: 1.0, supersedes_id: null, first_seen_at: "2026-01-01T00:00:00Z", last_confirmed_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
];

const PATTERNS_ONE = [
  { id: "p1", user_id: "u_1", pattern_kind: "travel", description: "books flights 2-3 weeks in advance", evidence_count: 7, confidence: 0.85, first_observed_at: "2026-01-01T00:00:00Z", last_observed_at: "2026-04-01T00:00:00Z" },
];

const AMBIENT_FULL = {
  local_time: "2026-05-02T05:30:45-07:00",
  timezone: "America/Los_Angeles",
  coords: { lat: 37.774929, lng: -122.419418, accuracy_m: 12 },
  location_label: "San Francisco",
  device_kind: "ios",
};

const AMBIENT_PARTIAL_COORDS = {
  coords: { lat: 41.878114, lng: -87.629798 },
  device_kind: "web",
};

const BOOKING_PRESENT = {
  user_id: "u_1",
  granted_scopes: ["booking.read"],
  fields: {
    name: { status: "present", value: "Alex Doe", label: "Alex Doe" },
    email: { status: "present", value: "alex@example.com", label: "alex@example.com" },
    phone: { status: "present", value: "+15551234567", label: "+1 (555) 123-4567" },
    payment_method_id: { status: "present", value: null, label: "Visa ending 4242" },
    traveler_profile: { status: "present", value: null, label: "1 traveler on file" },
    passport: { status: "not_in_scope", value: null, label: null },
    passport_optional: { status: "not_in_scope", value: null, label: null },
    dob: { status: "present", value: "1990-01-01", label: "1990-01-01" },
  },
  required_missing_fields: [],
  prefill_summary: "Alex Doe — alex@example.com — Visa 4242",
};

const BOOKING_MISSING = {
  user_id: "u_1",
  granted_scopes: ["booking.read"],
  fields: {
    name: { status: "present", value: "Alex Doe", label: "Alex Doe" },
    email: { status: "present", value: "alex@example.com", label: "alex@example.com" },
    phone: { status: "missing", value: null, label: null },
    payment_method_id: { status: "missing", value: null, label: null },
    traveler_profile: { status: "missing", value: null, label: null },
    passport: { status: "not_in_scope", value: null, label: null },
    passport_optional: { status: "not_in_scope", value: null, label: null },
    dob: { status: "missing", value: null, label: null },
  },
  required_missing_fields: ["phone", "payment_method_id", "dob"],
  prefill_summary: null,
};

const scenarios = [
  { id: "base-no-name", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US" } },
  { id: "base-with-name", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", user_first_name: "Alex" } },
  { id: "base-region-uk", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "GB" } },
  { id: "no-agents", input: { agents: [], now: NOW, user_region: "US" } },
  { id: "agents-mixed-health", input: { agents: AGENTS_MIXED, now: NOW, user_region: "US" } },
  { id: "agents-mixed-with-name", input: { agents: AGENTS_MIXED, now: NOW, user_region: "US", user_first_name: "Sam" } },
  { id: "voice-mode-bare", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", mode: "voice" } },
  { id: "voice-mode-with-name", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", user_first_name: "Alex", mode: "voice" } },
  { id: "text-mode-explicit", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", mode: "text" } },
  { id: "ambient-full", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", ambient: AMBIENT_FULL } },
  { id: "ambient-coords-only", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", ambient: AMBIENT_PARTIAL_COORDS } },
  { id: "ambient-empty-object", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", ambient: {} } },
  { id: "ambient-tz-only", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", ambient: { timezone: "America/New_York" } } },
  { id: "memory-empty", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: null, facts: [], patterns: [] } } },
  { id: "memory-profile-only", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: PROFILE_FULL, facts: [], patterns: [] } } },
  { id: "memory-facts-only", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: null, facts: FACTS_TWO, patterns: [] } } },
  { id: "memory-patterns-only", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: null, facts: [], patterns: PATTERNS_ONE } } },
  { id: "memory-full", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: PROFILE_FULL, facts: FACTS_TWO, patterns: PATTERNS_ONE } } },
  { id: "booking-null", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", bookingProfile: null } },
  { id: "booking-present", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", bookingProfile: BOOKING_PRESENT } },
  { id: "booking-missing-fields", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", bookingProfile: BOOKING_MISSING } },
  { id: "all-blocks-text", input: { agents: AGENTS_MIXED, now: NOW, user_region: "US", user_first_name: "Alex", memory: { profile: PROFILE_FULL, facts: FACTS_TWO, patterns: PATTERNS_ONE }, ambient: AMBIENT_FULL, bookingProfile: BOOKING_PRESENT } },
  { id: "all-blocks-voice", input: { agents: AGENTS_MIXED, now: NOW, user_region: "US", user_first_name: "Alex", mode: "voice", memory: { profile: PROFILE_FULL, facts: FACTS_TWO, patterns: PATTERNS_ONE }, ambient: AMBIENT_FULL, bookingProfile: BOOKING_PRESENT } },
  { id: "memory-and-booking", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: PROFILE_FULL, facts: [], patterns: [] }, bookingProfile: BOOKING_MISSING } },
  { id: "ambient-and-voice", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", ambient: AMBIENT_PARTIAL_COORDS, mode: "voice" } },
  { id: "name-region-mixed-health", input: { agents: AGENTS_MIXED, now: NOW, user_region: "DE", user_first_name: "Lukas" } },
  { id: "profile-no-arrays", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: { ...PROFILE_FULL, dietary_flags: [], allergies: [], preferred_cuisines: [], preferred_hotel_chains: [] }, facts: [], patterns: [] } } },
  { id: "profile-with-work-address", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", memory: { profile: { ...PROFILE_FULL, work_address: { line1: "1 Market", city: "SF", region: "CA", country: "US" } }, facts: [], patterns: [] } } },
  { id: "ambient-coords-with-accuracy", input: { agents: AGENTS_HEALTHY, now: NOW, user_region: "US", ambient: { coords: { lat: 40.7128, lng: -74.0060, accuracy_m: 50 } } } },
  { id: "agents-no-examples", input: { agents: [{ manifest: { display_name: "Quiet Agent", agent_id: "lumo.quiet", one_liner: "No example utterances", example_utterances: [] }, health_score: 1.0 }], now: NOW, user_region: "US" } },
];

for (const sc of scenarios) {
  const expected = buildSystemPrompt({ ...sc.input, now: NOW });
  process.stdout.write(JSON.stringify({ id: sc.id, input: sc.input, expected }) + "\n");
}
