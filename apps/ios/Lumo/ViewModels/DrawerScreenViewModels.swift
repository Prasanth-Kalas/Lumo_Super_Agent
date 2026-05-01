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

    /// DEBUG seed used by RootView's -LumoSeedDrawerScreens fixture.
    func _seedForTest(state: DrawerLoadState<MemoryProfileDTO>) {
        self.state = state
    }

    static func message(for error: Error) -> String {
        if let e = error as? DrawerScreensError {
            switch e {
            case .badStatus(let code): return "Server returned \(code). Pull to retry."
            case .decode: return "Couldn't read the response. Pull to retry."
            case .transport: return "Network error. Pull to retry."
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

    func _seedForTest(state: DrawerLoadState<[MarketplaceAgentDTO]>) {
        self.state = state
    }
}

// MARK: - History

@MainActor
final class HistoryScreenViewModel: ObservableObject {
    @Published var state: DrawerLoadState<[HistorySessionDTO]> = .idle

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
        } catch {
            state = .error(MemoryScreenViewModel.message(for: error))
        }
    }

    func _seedForTest(state: DrawerLoadState<[HistorySessionDTO]>) {
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
