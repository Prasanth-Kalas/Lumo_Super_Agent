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

    var id: String { leg_id }
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
}
