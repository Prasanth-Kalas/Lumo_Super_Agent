import Foundation

/// Drives `ProactiveMomentsView`. Fetches from `/api/proactive/recent`
/// on foreground + when the host explicitly calls `refresh()`.
/// Reads/writes through `ProactiveMomentsCache` so background-fetch
/// updates flow into the same observable state.

@MainActor
final class ProactiveMomentsViewModel: ObservableObject {
    @Published private(set) var moments: [ProactiveMoment] = []
    @Published private(set) var isRefreshing: Bool = false
    @Published private(set) var lastError: String?

    private let cache: ProactiveMomentsCache
    private let fetcher: ProactiveMomentsFetching
    private var cacheTask: Task<Void, Never>?

    init(cache: ProactiveMomentsCache, fetcher: ProactiveMomentsFetching) {
        self.cache = cache
        self.fetcher = fetcher
        // Initial sync from the cache's current state.
        self.moments = cache.moments
        self.lastError = cache.loadError
        // Subscribe to cache updates. The cache is @MainActor-isolated
        // and emits via @Published; mirror its `moments` into ours.
        cacheTask = Task { @MainActor [weak self] in
            // Best-effort polling sync — `@Published` doesn't expose an
            // async sequence directly without a Combine bridge, so we
            // walk the cache state on demand from `refresh()` and
            // foreground transitions. The view also calls
            // `consumeCachedUpdate()` when it appears.
            _ = self
        }
    }

    deinit {
        cacheTask?.cancel()
    }

    /// Pull the latest snapshot from the cache. Called by the view
    /// `.onAppear` so background-fetch updates flow in.
    func consumeCachedUpdate() {
        moments = cache.moments
        lastError = cache.loadError
    }

    /// Force a network refresh. Updates the cache; the view's next
    /// `consumeCachedUpdate()` will pick up the new state.
    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let response = try await fetcher.fetchRecent()
            cache.update(with: response)
            consumeCachedUpdate()
        } catch {
            cache.recordError(error.localizedDescription)
            lastError = error.localizedDescription
        }
    }

    /// User tapped the X on a card. Persists the dismissal so it
    /// doesn't re-surface on the next fetch.
    func dismiss(_ momentID: String) {
        cache.dismiss(momentID)
        moments = cache.moments
    }
}
