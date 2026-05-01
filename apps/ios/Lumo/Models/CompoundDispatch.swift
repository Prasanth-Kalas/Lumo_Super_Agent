import Foundation

/// Mirror of web's `AssistantCompoundDispatchFrameValue` —
/// see apps/web/lib/compound/dispatch-frame.ts. Emitted by the
/// orchestrator on the main `/api/chat` SSE stream when a turn
/// fans out into a multi-agent compound transaction (flight +
/// hotel + restaurant, etc.). The strip subscribes to a per-
/// compound `/api/compound/transactions/:id/stream` for live
/// per-leg status updates after the initial dispatch frame lands.
///
/// Same forward-compat pattern as the `selection` and `summary`
/// envelopes in this folder: typed payload here today;
/// rollback-detail and per-leg-detail surfaces become separate
/// follow-up sprints (IOS-COMPOUND-LEG-DETAIL-1,
/// IOS-COMPOUND-ROLLBACK-VIEW-1).
struct CompoundDispatchPayload: Equatable {
    let kind: String                 // always "assistant_compound_dispatch"
    let compound_transaction_id: String
    let legs: [CompoundLeg]
}

struct CompoundLeg: Equatable, Identifiable {
    let leg_id: String
    let agent_id: String
    let agent_display_name: String
    let description: String
    let status: CompoundLegStatus
    /// IDs of legs this leg waits on. Mirrors web's
    /// `CompoundDispatchLeg.depends_on` (apps/web/lib/compound/dispatch-frame.ts).
    /// Threaded through from the saga DAG by
    /// `buildAssistantCompoundDispatchFrame`. Empty array on root
    /// legs and on older frames that pre-date the field — the
    /// decoder defaults to `[]` so the cascade compute returns
    /// "no dependents" rather than crashing.
    let depends_on: [String]

    var id: String { leg_id }

    init(
        leg_id: String,
        agent_id: String,
        agent_display_name: String,
        description: String,
        status: CompoundLegStatus,
        depends_on: [String] = []
    ) {
        self.leg_id = leg_id
        self.agent_id = agent_id
        self.agent_display_name = agent_display_name
        self.description = description
        self.status = status
        self.depends_on = depends_on
    }
}

/// 8-value status enum mirroring `LEG_STATUS_V2_STATUSES` in
/// apps/web/lib/sse/leg-status.ts. Order + spelling pinned to
/// the web/SDK source — leg-status SSE frames carry these as
/// raw strings, so any drift breaks the wire contract.
enum CompoundLegStatus: String, Equatable, CaseIterable {
    case pending
    case in_flight
    case committed
    case failed
    case rollback_pending
    case rolled_back
    case rollback_failed
    case manual_review

    /// True when the strip should treat this leg as done — the
    /// orchestrator will not emit further status updates for it
    /// and the pulse animation should suppress. Mirrors web's
    /// `TERMINAL_STATUSES` set in CompoundLegStrip.tsx.
    var isTerminal: Bool {
        switch self {
        case .committed, .failed, .rolled_back, .rollback_failed, .manual_review:
            return true
        case .pending, .in_flight, .rollback_pending:
            return false
        }
    }

    /// Statuses that drive the cyan pulse + dot animation in the
    /// status pill. Mirrors web's
    /// `status === "in_flight" || status === "rollback_pending"`.
    var isPulsing: Bool {
        self == .in_flight || self == .rollback_pending
    }

    /// Display label — snake_case → space-separated, matching web's
    /// `status.replace(/_/g, " ")`. Used by the pill text.
    var label: String {
        rawValue.replacingOccurrences(of: "_", with: " ")
    }
}

/// Per-leg metadata captured client-side from leg-status SSE
/// updates. Drives the detail panel's elapsed-time ticker
/// (`firstSeenInFlightAt`), terminal-state booking refs
/// (`provider_reference`), and failure reasons (`evidence`).
/// Lives in the view model rather than the dispatch payload
/// because most fields only show up after the leg transitions
/// out of `pending`.
struct CompoundLegMetadata: Equatable {
    /// First time the override layer marked this leg as
    /// `in_flight` — drives the elapsed-time ticker on the detail
    /// panel. nil while the leg is still `pending`.
    var firstSeenInFlightAt: Date?
    /// Wall-clock timestamp from the most recent leg-status frame.
    /// nil if the frame omitted it.
    var lastUpdatedAt: Date?
    /// Provider booking reference (Duffel order id, Booking.com
    /// confirmation, etc.). nil for pre-terminal statuses.
    var provider_reference: String?
    /// Saga evidence dict (reason / provider_status / etc.).
    /// String-coerced upstream so the dict stays Equatable.
    var evidence: [String: String]?

    static let empty = CompoundLegMetadata()

    init(
        firstSeenInFlightAt: Date? = nil,
        lastUpdatedAt: Date? = nil,
        provider_reference: String? = nil,
        evidence: [String: String]? = nil
    ) {
        self.firstSeenInFlightAt = firstSeenInFlightAt
        self.lastUpdatedAt = lastUpdatedAt
        self.provider_reference = provider_reference
        self.evidence = evidence
    }
}

/// Pure helpers shared by the SwiftUI view, the live-stream
/// service, and unit tests.
enum CompoundDispatchHelpers {
    /// Aggregate "settled" — all legs in terminal status. Drives
    /// the badge ("Live" → "Settled"), pulse-animation suppression,
    /// and EventSource shutdown.
    static func isSettled(legs: [CompoundLeg], statuses: [String: CompoundLegStatus] = [:]) -> Bool {
        guard !legs.isEmpty else { return true }
        return legs.allSatisfy { leg in
            (statuses[leg.leg_id] ?? leg.status).isTerminal
        }
    }

    /// Single-character glyph for the leg's agent. Mirrors web's
    /// `agentGlyph`: substring-match against the agent_id.
    /// `lumo-flights` → ✈, `lumo-hotels` → ⌂, anything else → ◆.
    /// Restaurant agents (`lumo-restaurants`/`lumo-food`) fall
    /// through to ◆ today; matching web exactly until web adds
    /// dedicated glyphs.
    static func glyph(for agentID: String) -> String {
        if agentID.contains("flight") { return "✈" }
        if agentID.contains("hotel") { return "⌂" }
        return "◆"
    }

    /// Resolve the rollback cascade for a failed leg — every leg
    /// that transitively depends on `failedLegID`. Pure read over
    /// the dispatch graph; the saga runner is the source of truth
    /// for which legs *actually* roll back at runtime, but for
    /// visual purposes the graph closure matches the saga's
    /// dependent-cascade rule (see
    /// `apps/web/lib/saga.ts::evaluateCompoundConfirmation` +
    /// graph-runner.ts compensation flow).
    ///
    /// Returns leg ids that depend on `failedLegID` directly or
    /// transitively. The failed leg itself is NOT in the result.
    /// O(N + edges) iterative BFS — handles graphs of any shape
    /// (serial chain, fan-out, fan-in).
    static func cascade(failedLegID: String, legs: [CompoundLeg]) -> Set<String> {
        // Build reverse adjacency: for each leg id, the legs that
        // wait on it. cheap O(edges) since iOS sees small graphs
        // (typical 3-5 legs).
        var dependents: [String: [String]] = [:]
        for leg in legs {
            for dep in leg.depends_on {
                dependents[dep, default: []].append(leg.leg_id)
            }
        }
        var result: Set<String> = []
        var queue: [String] = [failedLegID]
        var seen: Set<String> = [failedLegID]
        while !queue.isEmpty {
            let current = queue.removeFirst()
            for child in dependents[current] ?? [] {
                if seen.insert(child).inserted {
                    result.insert(child)
                    queue.append(child)
                }
            }
        }
        return result
    }

    /// Convenience: leg ids that are "rolling back because of an
    /// upstream failure" — the cascade of every currently-failed
    /// leg, intersected with the supplied status overrides so the
    /// view only marks dependents that have actually transitioned
    /// out of `committed` / `pending`. Failed root legs themselves
    /// are excluded — they're the cause, not the cascade.
    static func rollbackCascade(
        legs: [CompoundLeg],
        statuses: [String: CompoundLegStatus]
    ) -> Set<String> {
        var aggregate: Set<String> = []
        for leg in legs {
            let status = statuses[leg.leg_id] ?? leg.status
            if status == .failed || status == .rollback_failed {
                aggregate.formUnion(cascade(failedLegID: leg.leg_id, legs: legs))
            }
        }
        return aggregate
    }
}
