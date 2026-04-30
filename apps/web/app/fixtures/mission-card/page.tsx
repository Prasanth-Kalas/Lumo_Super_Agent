"use client";

/**
 * Fixture-only page that renders LumoMissionCard with deterministic
 * seed data so the playwright capture script can shoot the card in
 * isolation. Public route — middleware doesn't gate /fixtures/*.
 *
 * The seed is chosen to exercise every section the brief moves
 * behind "Show details": multiple install proposals (with rank +
 * scope chips), ranked alternatives, optimized itinerary, user
 * questions, confirmation points. The before/after capture pair
 * uses this same plan so the simplification is apparent against a
 * fixed reference.
 */

import {
  LumoMissionCard,
  type LumoMissionPlan,
} from "@/components/LumoMissionCard";

const FIXTURE_PLAN: LumoMissionPlan = {
  mission_id: "fixture-mission-vegas",
  original_request: "Plan a weekend trip to Las Vegas for two",
  mission_title: "Las Vegas weekend",
  message:
    "I can plan flights, hotel, and a Saturday-night dinner. To do that I'll need to install Duffel and Booking, and connect OpenTable for the reservation.",
  install_proposals: [
    {
      agent_id: "duffel",
      display_name: "Duffel",
      one_liner: "Books flights from 200+ airlines.",
      capability_label: "flights",
      marketplace_url: "/marketplace/duffel",
      action: "install_with_profile_permission",
      can_auto_install: true,
      permission_title: "Allow flight booking",
      permission_copy:
        "Duffel uses your name + email to issue tickets and your saved card to charge.",
      profile_fields_requested: ["name", "email", "payment method"],
      required_scopes: [],
      requires_payment: true,
      rank_score: 0.92,
      rank_reasons: ["Top-rated flight provider", "Used in 84% of past trips"],
      risk_badge: {
        level: "low",
        score: 0.12,
        reasons: ["Stable provider", "PCI-compliant"],
        mitigations: [],
        source: "ml",
        latency_ms: 24,
      },
    },
    {
      agent_id: "booking",
      display_name: "Booking.com",
      one_liner: "Reserves hotels with free cancellation.",
      capability_label: "stays",
      marketplace_url: "/marketplace/booking",
      action: "install_with_profile_permission",
      can_auto_install: true,
      permission_title: "Allow hotel booking",
      permission_copy:
        "Booking.com uses your name + email to confirm reservations.",
      profile_fields_requested: ["name", "email"],
      required_scopes: [],
      requires_payment: false,
      rank_score: 0.81,
      rank_reasons: ["Best inventory in Las Vegas", "Free cancellation"],
      risk_badge: null,
    },
    {
      agent_id: "opentable",
      display_name: "OpenTable",
      one_liner: "Reserves dinner tables at popular restaurants.",
      capability_label: "reservations",
      marketplace_url: "/marketplace/opentable",
      action: "connect_oauth",
      can_auto_install: false,
      permission_title: "Connect OpenTable",
      permission_copy:
        "OpenTable will redirect you to confirm sign-in via OAuth.",
      profile_fields_requested: ["name"],
      required_scopes: [],
      requires_payment: false,
      rank_score: 0.74,
      rank_reasons: ["Required for table booking"],
      risk_badge: null,
    },
  ],
  ranked_recommendations: [
    {
      agent_id: "duffel",
      display_name: "Duffel",
      score: 0.92,
      installed: false,
      reasons: ["High match"],
      missing_scopes: [],
    },
    {
      agent_id: "amadeus",
      display_name: "Amadeus",
      score: 0.79,
      installed: false,
      reasons: ["Good coverage"],
      missing_scopes: [],
    },
    {
      agent_id: "skyscanner",
      display_name: "Skyscanner",
      score: 0.71,
      installed: false,
      reasons: ["Cheap fares"],
      missing_scopes: [],
    },
    {
      agent_id: "expedia",
      display_name: "Expedia",
      score: 0.66,
      installed: false,
      reasons: ["Bundle deals"],
      missing_scopes: [],
    },
    {
      agent_id: "kayak",
      display_name: "Kayak",
      score: 0.58,
      installed: false,
      reasons: ["Aggregator"],
      missing_scopes: [],
    },
    {
      agent_id: "google-flights",
      display_name: "Google Flights",
      score: 0.55,
      installed: false,
      reasons: ["Read-only search"],
      missing_scopes: [],
    },
  ],
  trip_optimization: {
    status: "ok",
    objective: "balanced",
    route: [
      {
        id: "depart-sfo",
        label: "Depart SFO",
        category: "flight",
        sequence: 0,
        arrival_minute: 7 * 60,
        departure_minute: 7 * 60,
        wait_minutes: 0,
      },
      {
        id: "arrive-las",
        label: "Arrive LAS · check in to The Cosmopolitan",
        category: "hotel",
        sequence: 1,
        arrival_minute: 8 * 60 + 30,
        departure_minute: 8 * 60 + 30,
        wait_minutes: 0,
      },
      {
        id: "dinner-bouchon",
        label: "Dinner at Bouchon (reservation 19:30)",
        category: "dining",
        sequence: 2,
        arrival_minute: 19 * 60 + 30,
        departure_minute: 21 * 60,
        wait_minutes: 30,
      },
      {
        id: "depart-las",
        label: "Depart LAS",
        category: "flight",
        sequence: 3,
        arrival_minute: 1440 + 17 * 60,
        departure_minute: 1440 + 17 * 60,
        wait_minutes: 0,
      },
    ],
    dropped_stop_ids: [],
    total_duration_minutes: 1440 + 600,
    total_cost_usd: 1240,
    total_distance_km: 920,
    solver: "or-tools",
    source: "ml",
    latency_ms: 41,
  },
  user_questions: [
    "Window or aisle seat?",
    "King bed or two queens?",
    "Any dietary restrictions for dinner?",
  ],
  confirmation_points: [
    "Total round-trip cost: ~$1,240 for two",
    "Hotel cancellation deadline: 48 hours before check-in",
    "Dinner reservation cancellation fee: $50 if within 24h",
  ],
  unavailable_capabilities: [],
};

export default function MissionCardFixture() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high px-5 py-10">
      <div className="mx-auto max-w-2xl">
        <LumoMissionCard
          plan={FIXTURE_PLAN}
          onContinue={(text) => {
            // Capture-only fixture — log to console rather than POST.
            console.log("[fixture] continue:", text);
          }}
        />
      </div>
    </main>
  );
}
