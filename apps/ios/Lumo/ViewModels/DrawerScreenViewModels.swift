import Foundation
import SwiftUI

/// ViewModels for the drawer destinations wired in
/// IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase B. Each owns its own
/// fetch state machine and accepts a `DrawerScreensFetching` so
/// tests + the DEBUG fixture seam can substitute deterministic data.

enum DrawerLoadState<Value: Equatable>: Equatable {
    case idle
    case loading
    case loaded(Value)
    case error(String)
}

// MARK: - Memory

@MainActor
final class MemoryScreenViewModel: ObservableObject {
    @Published var state: DrawerLoadState<MemoryProfileDTO> = .idle
    @Published var saveError: String? = nil
    @Published var isSaving: Bool = false
    /// IOS-MEMORY-FACTS-1 — facts and patterns sit alongside the
    /// profile state rather than inside it so existing view bindings
    /// (the 5-category list) keep working unchanged.
    @Published var facts: [MemoryFactDTO] = []
    @Published var patterns: [MemoryPatternDTO] = []
    /// Non-nil while a Forget request is in flight for that fact.
    /// Drives the row's "Forgetting…" affordance + disabled button.
    @Published var forgettingFactID: String? = nil
    @Published var factError: String? = nil

    private let fetcher: DrawerScreensFetching

    init(fetcher: DrawerScreensFetching) {
        self.fetcher = fetcher
    }

    func load() async {
        if case .loading = state { return }
        state = .loading
        do {
            let resp = try await fetcher.fetchMemory()
            // Empty profile renders an "as you chat, Lumo will fill
            // this in" empty state on the view side, so pass a
            // default-empty profile rather than nil.
            state = .loaded(resp.profile ?? MemoryProfileDTO())
            facts = resp.facts
            patterns = resp.patterns
            factError = nil
        } catch {
            state = .error(Self.message(for: error))
        }
    }

    func save(_ patch: MemoryProfilePatchDTO) async {
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            let updated = try await fetcher.updateMemoryProfile(patch)
            state = .loaded(updated)
        } catch {
            saveError = Self.message(for: error)
        }
    }

    /// Optimistic "Forget this memory" — removes from the local list
    /// immediately; on transport/server error, restores the row and
    /// surfaces a one-shot error message via `factError`.
    func forgetFact(id: String) async {
        guard forgettingFactID == nil else { return }
        guard let removedIndex = facts.firstIndex(where: { $0.id == id }) else { return }
        let removed = facts[removedIndex]
        forgettingFactID = id
        facts.remove(at: removedIndex)
        defer { forgettingFactID = nil }
        do {
            try await fetcher.forgetMemoryFact(id: id)
            factError = nil
        } catch {
            // Roll back at the same index so the user doesn't see
            // their fact teleport to a different position on retry.
            let safeIndex = min(removedIndex, facts.count)
            facts.insert(removed, at: safeIndex)
            factError = Self.message(for: error)
        }
    }

    /// DEBUG seed used by RootView's -LumoSeedDrawerScreens fixture.
    func _seedForTest(state: DrawerLoadState<MemoryProfileDTO>) {
        self.state = state
    }

    func _seedForTest(facts: [MemoryFactDTO], patterns: [MemoryPatternDTO]) {
        self.facts = facts
        self.patterns = patterns
    }

    static func message(for error: Error) -> String {
        if let e = error as? DrawerScreensError {
            switch e {
            case .badStatus(let code): return "Server returned \(code). Pull to retry."
            case .decode: return "Couldn't read the response. Pull to retry."
            case .transport: return "Network error. Pull to retry."
            // The cases below are action-specific (marketplace install,
            // trip cancel) but the shared formatter must remain
            // exhaustive — the catalog-load surface should never see
            // them, but we route them to a generic message rather
            // than crash.
            case .oauthRequired: return "OAuth is required. Use the web app for this action."
            case .unknownAgent: return "This item is no longer available. Pull to retry."
            case .unknownTrip: return "This trip is no longer available. Pull to retry."
            case .tripAlreadyTerminal: return "This trip is already finalized."
            }
        }
        return "Something went wrong. Pull to retry."
    }
}

// MARK: - Marketplace

@MainActor
final class MarketplaceScreenViewModel: ObservableObject {
    @Published var state: DrawerLoadState<[MarketplaceAgentDTO]> = .idle
    @Published var installingAgentID: String? = nil
    /// One-shot user-facing message after a failed install attempt.
    /// Distinct from `state.error` which represents catalog-load
    /// failure — install failures don't blank the catalog.
    @Published var installError: String? = nil

    private let fetcher: DrawerScreensFetching

    init(fetcher: DrawerScreensFetching) {
        self.fetcher = fetcher
    }

    func load() async {
        if case .loading = state { return }
        state = .loading
        do {
            let resp = try await fetcher.fetchMarketplace()
            state = .loaded(resp.agents)
        } catch {
            state = .error(MemoryScreenViewModel.message(for: error))
        }
    }

    /// IOS-MARKETPLACE-INSTALL-1 — round-trips
    /// `POST /api/lumo/mission/install` for the given agent and
    /// updates the loaded list with the installed status on success.
    /// No-op if the agent is already installed or another install
    /// is in flight (the button is disabled in those states; this
    /// is a defensive guard for programmatic callers).
    func installAgent(id: String) async {
        guard installingAgentID == nil else { return }
        guard case .loaded(let agents) = state,
              let idx = agents.firstIndex(where: { $0.agent_id == id }) else { return }
        if agents[idx].isInstalled { return }
        installingAgentID = id
        installError = nil
        defer { installingAgentID = nil }
        do {
            let installedAt = try await fetcher.installAgent(id: id)
            // Re-resolve the index — the catalog could have been
            // refreshed mid-install; if the agent disappeared we
            // skip the local state update rather than crash.
            if case .loaded(var fresh) = state,
               let i = fresh.firstIndex(where: { $0.agent_id == id }) {
                fresh[i] = fresh[i].markedInstalled(at: installedAt)
                state = .loaded(fresh)
            }
        } catch let e as DrawerScreensError {
            switch e {
            case .oauthRequired:
                installError = "This app requires OAuth. Install it from the web app for now — iOS connect-flow ships in a follow-up."
            case .unknownAgent:
                installError = "This agent is no longer in the catalog. Pull to refresh."
            case .badStatus(let code):
                installError = "Install failed (\(code)). Please try again."
            case .decode, .transport:
                installError = "Network hiccup. Please try again."
            case .unknownTrip, .tripAlreadyTerminal:
                // Not reachable from install; route to a generic so
                // the switch stays exhaustive.
                installError = "Install failed. Please try again."
            }
        } catch {
            installError = "Install failed. Please try again."
        }
    }

    func _seedForTest(state: DrawerLoadState<[MarketplaceAgentDTO]>) {
        self.state = state
    }
}

// MARK: - History

@MainActor
final class HistoryScreenViewModel: ObservableObject {
    @Published var state: DrawerLoadState<[HistorySessionDTO]> = .idle
    /// IOS-HISTORY-TRIP-DETAIL-1 — trips published alongside the
    /// sessions state so the existing `state: DrawerLoadState<[HistorySessionDTO]>`
    /// surface stays binary-compatible.
    @Published var trips: [HistoryTripDTO] = []
    /// Per-trip expanded flag for inline leg-list reveal.
    @Published var expandedTripIDs: Set<String> = []
    /// IOS-TRIP-CANCEL-1 — non-nil while a cancel is in flight for
    /// that trip_id; drives the "Cancelling…" affordance and gates
    /// concurrent taps.
    @Published var cancellingTripID: String? = nil
    /// One-shot success message after a cancel succeeds, keyed to
    /// the trip_id it concerns. Cleared when the user dismisses or
    /// loads again.
    @Published var tripCancelMessage: (tripID: String, text: String)? = nil
    @Published var tripCancelError: (tripID: String, text: String)? = nil

    private let fetcher: DrawerScreensFetching

    init(fetcher: DrawerScreensFetching) {
        self.fetcher = fetcher
    }

    func load() async {
        if case .loading = state { return }
        state = .loading
        do {
            let resp = try await fetcher.fetchHistory(limitSessions: 30)
            state = .loaded(resp.sessions)
            trips = resp.trips
        } catch {
            state = .error(MemoryScreenViewModel.message(for: error))
        }
    }

    func toggleTripExpanded(_ id: String) {
        if expandedTripIDs.contains(id) {
            expandedTripIDs.remove(id)
        } else {
            expandedTripIDs.insert(id)
        }
    }

    /// True when the trip is in a status the cancel endpoint
    /// supports a non-409 path for. Mirrors the four branches in
    /// `apps/web/app/api/trip/[trip_id]/cancel/route.ts`.
    static func canCancel(status: String) -> Bool {
        switch status {
        case "draft", "confirmed", "dispatching", "committed":
            return true
        default:
            return false
        }
    }

    /// IOS-TRIP-CANCEL-1 — user-initiated cancel/refund. Calls
    /// `POST /api/trip/{id}/cancel` and refreshes the catalog on
    /// success so the trip's new status surfaces. Confirmation UI
    /// is the caller's responsibility — this VM trusts the call.
    func cancelTrip(id: String, reason: String? = nil) async {
        guard cancellingTripID == nil else { return }
        guard let trip = trips.first(where: { $0.trip_id == id }) else { return }
        guard Self.canCancel(status: trip.status) else { return }
        cancellingTripID = id
        tripCancelError = nil
        defer { cancellingTripID = nil }
        do {
            let result = try await fetcher.cancelTrip(id: id, reason: reason)
            tripCancelMessage = (
                tripID: id,
                text: result.message ?? "Cancellation \(result.action.replacingOccurrences(of: "_", with: " "))."
            )
            // Pull a fresh catalog so the new_status / leg states
            // surface in the row without reconstructing payload by hand.
            await load()
        } catch let e as DrawerScreensError {
            switch e {
            case .tripAlreadyTerminal(let status):
                let suffix = status.map { " (\($0))" } ?? ""
                tripCancelError = (
                    tripID: id,
                    text: "This trip is already finalized\(suffix). Refresh to see the latest state."
                )
            case .unknownTrip:
                tripCancelError = (id, "This trip is no longer available. Pull to refresh.")
            case .badStatus(let code):
                tripCancelError = (id, "Cancel failed (\(code)). Please try again.")
            case .decode, .transport:
                tripCancelError = (id, "Network hiccup. Please try again.")
            case .oauthRequired, .unknownAgent:
                // Not reachable from cancel; route to a generic so
                // the switch stays exhaustive.
                tripCancelError = (id, "Cancel failed. Please try again.")
            }
        } catch {
            tripCancelError = (id, "Cancel failed. Please try again.")
        }
    }

    func _seedForTest(state: DrawerLoadState<[HistorySessionDTO]>) {
        self.state = state
    }

    func _seedForTest(trips: [HistoryTripDTO]) {
        self.trips = trips
    }
}

// MARK: - Connections (IOS-CONNECTIONS-1)

@MainActor
final class ConnectionsScreenViewModel: ObservableObject {
    @Published var state: DrawerLoadState<[ConnectionMetaDTO]> = .idle
    /// Non-nil while a disconnect call is in flight for that
    /// connection_id. Drives the row's "Disconnecting…" affordance
    /// + disabled button; gates concurrent taps.
    @Published var disconnectingID: String? = nil
    @Published var disconnectError: String? = nil

    private let fetcher: DrawerScreensFetching

    init(fetcher: DrawerScreensFetching) {
        self.fetcher = fetcher
    }

    func load() async {
        if case .loading = state { return }
        state = .loading
        do {
            let resp = try await fetcher.fetchConnections()
            state = .loaded(resp.connections)
            disconnectError = nil
        } catch {
            state = .error(MemoryScreenViewModel.message(for: error))
        }
    }

    /// Optimistically removes the connection from the loaded list
    /// while the disconnect call is in flight; restores on failure.
    /// System rows (id starts with `system:`) cannot be revoked
    /// server-side and are gated out at the call site.
    func disconnect(id: String) async {
        guard disconnectingID == nil else { return }
        guard !id.hasPrefix("system:") else { return }
        guard case .loaded(let connections) = state,
              let index = connections.firstIndex(where: { $0.id == id }) else { return }
        let removed = connections[index]
        var optimistic = connections
        optimistic.remove(at: index)
        state = .loaded(optimistic)
        disconnectingID = id
        disconnectError = nil
        defer { disconnectingID = nil }
        do {
            try await fetcher.disconnectConnection(id: id)
        } catch {
            // Rollback at the same index so the user doesn't see
            // their connection teleport on retry.
            if case .loaded(var current) = state {
                let safeIndex = min(index, current.count)
                current.insert(removed, at: safeIndex)
                state = .loaded(current)
            }
            disconnectError = MemoryScreenViewModel.message(for: error)
        }
    }

    func _seedForTest(state: DrawerLoadState<[ConnectionMetaDTO]>) {
        self.state = state
    }
}

// MARK: - Time-since formatter

/// Compact iOS-style "time since" formatter. Mirrors the contract of
/// web's `apps/web/lib/format-time-since.ts` (landed in
/// WEB-RECENTS-TIMESTAMP-PORT-1) so the side-by-side recents/history
/// captures stay parity-aligned.
///
///   < 60s         → "now"
///   < 60min       → "<n> min, <s> sec"
///   < 24h         → "<h> hr, <m> min"
///   < 7d          → "<d> day, <h> hr"
///   else          → date as "MMM d"
///
/// `relativeTo:` exists for tests so we don't depend on the wall
/// clock.
enum HistoryTimeFormatter {
    static func formatTimeSince(_ iso: String, relativeTo now: Date = Date()) -> String {
        guard let then = parseISO(iso) else { return "" }
        let interval = now.timeIntervalSince(then)
        if interval < 60 { return "now" }
        if interval < 3_600 {
            let m = Int(interval) / 60
            let s = Int(interval) % 60
            return "\(m) min, \(s) sec"
        }
        if interval < 86_400 {
            let h = Int(interval) / 3_600
            let m = (Int(interval) % 3_600) / 60
            return "\(h) hr, \(m) min"
        }
        if interval < 7 * 86_400 {
            let d = Int(interval) / 86_400
            let h = (Int(interval) % 86_400) / 3_600
            return "\(d) day, \(h) hr"
        }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f.string(from: then)
    }

    static func parseISO(_ iso: String) -> Date? {
        if let d = isoFractional.date(from: iso) { return d }
        if let d = isoPlain.date(from: iso) { return d }
        return nil
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}
