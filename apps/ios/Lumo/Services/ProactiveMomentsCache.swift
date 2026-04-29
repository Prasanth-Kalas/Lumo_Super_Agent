import Foundation

/// Shared in-memory store for the in-app proactive feed.
///
/// Both the foreground refresh path (`ProactiveMomentsViewModel`) and
/// the background-fetch handler (`BackgroundFetchService`) write to
/// this cache. The view subscribes via the `@Published` `moments` so
/// updates from any source flow into the UI without manual polling.
///
/// `dismissedIDs` is in-memory + UserDefaults-backed so dismissals
/// survive app re-launches without round-tripping to the backend.
/// MOBILE-API-1 will sync this state across devices.

@MainActor
final class ProactiveMomentsCache: ObservableObject {
    @Published private(set) var moments: [ProactiveMoment] = []
    @Published private(set) var lastFetchedAt: Date?
    @Published private(set) var loadError: String?

    private static let dismissedIDsKey = "lumo.notifications.dismissedMomentIDs"

    /// Update the cache from a fresh server response. Merges with the
    /// existing dismissed-id set so a moment the user already swiped
    /// away doesn't reappear after a background fetch.
    func update(with response: ProactiveMomentsResponse) {
        let dismissed = loadDismissedIDs()
        let now = Date()
        moments = response.moments.filter { moment in
            !moment.isExpired(now: now) && !dismissed.contains(moment.id)
        }
        lastFetchedAt = response.generatedAt
        loadError = nil
    }

    func recordError(_ message: String) {
        loadError = message
    }

    /// User dismissed a moment from the in-app card. Removes from the
    /// in-memory list and persists the id so subsequent fetches don't
    /// re-surface it.
    func dismiss(_ momentID: String) {
        moments.removeAll { $0.id == momentID }
        var dismissed = loadDismissedIDs()
        dismissed.insert(momentID)
        UserDefaults.standard.set(Array(dismissed), forKey: Self.dismissedIDsKey)
    }

    /// Test/seed hook — replaces the moments list directly. Real
    /// callers should always go through `update(with:)` so the
    /// dismissed-set filter applies.
    func injectMomentsForFixture(_ seed: [ProactiveMoment]) {
        moments = seed
    }

    private func loadDismissedIDs() -> Set<String> {
        let raw = UserDefaults.standard.array(forKey: Self.dismissedIDsKey) as? [String] ?? []
        return Set(raw)
    }
}
