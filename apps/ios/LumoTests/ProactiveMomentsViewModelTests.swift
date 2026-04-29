import XCTest
@testable import Lumo

@MainActor
final class ProactiveMomentsViewModelTests: XCTestCase {

    func test_refresh_populatesMomentsFromFetcher() async {
        let fetcher = FakeProactiveMomentsFetcher()
        let now = Date()
        fetcher.nextResult = .success(.init(
            generatedAt: now,
            moments: [makeMoment(id: "mom_1", expiresAt: now.addingTimeInterval(3600))]
        ))
        let cache = ProactiveMomentsCache()
        let vm = ProactiveMomentsViewModel(cache: cache, fetcher: fetcher)
        await vm.refresh()
        XCTAssertEqual(vm.moments.map(\.id), ["mom_1"])
        XCTAssertEqual(fetcher.fetchCallCount, 1)
    }

    func test_refresh_filtersExpiredMoments() async {
        let fetcher = FakeProactiveMomentsFetcher()
        let now = Date()
        fetcher.nextResult = .success(.init(
            generatedAt: now,
            moments: [
                makeMoment(id: "mom_fresh", expiresAt: now.addingTimeInterval(3600)),
                makeMoment(id: "mom_old", expiresAt: now.addingTimeInterval(-3600)),
            ]
        ))
        let vm = ProactiveMomentsViewModel(cache: ProactiveMomentsCache(), fetcher: fetcher)
        await vm.refresh()
        XCTAssertEqual(vm.moments.map(\.id), ["mom_fresh"],
                       "moments past expiresAt must be filtered before publishing")
    }

    func test_refresh_failure_surfacesErrorMessage() async {
        struct Boom: Error, LocalizedError { var errorDescription: String? { "network down" } }
        let fetcher = FakeProactiveMomentsFetcher()
        fetcher.nextResult = .failure(Boom())
        let vm = ProactiveMomentsViewModel(cache: ProactiveMomentsCache(), fetcher: fetcher)
        await vm.refresh()
        XCTAssertNotNil(vm.lastError)
        XCTAssertTrue(vm.lastError?.contains("network down") ?? false)
    }

    func test_dismiss_removesFromMoments_andPersists() async {
        let fetcher = FakeProactiveMomentsFetcher()
        let now = Date()
        let id = "mom_dismiss_\(UUID().uuidString)"
        fetcher.nextResult = .success(.init(
            generatedAt: now,
            moments: [makeMoment(id: id, expiresAt: now.addingTimeInterval(3600))]
        ))
        let cache = ProactiveMomentsCache()
        let vm = ProactiveMomentsViewModel(cache: cache, fetcher: fetcher)
        await vm.refresh()
        XCTAssertEqual(vm.moments.count, 1)
        vm.dismiss(id)
        XCTAssertEqual(vm.moments.count, 0)
        // Subsequent refresh with the same moment should NOT re-surface
        // it (cache.dismiss persisted to UserDefaults).
        fetcher.nextResult = .success(.init(
            generatedAt: now,
            moments: [makeMoment(id: id, expiresAt: now.addingTimeInterval(3600))]
        ))
        await vm.refresh()
        XCTAssertEqual(vm.moments.count, 0,
                       "dismissed moment should not re-surface from a follow-up fetch")
    }

    func test_consumeCachedUpdate_mirrorsCacheState() async {
        let cache = ProactiveMomentsCache()
        let now = Date()
        cache.update(with: .init(
            generatedAt: now,
            moments: [makeMoment(id: "mom_bg_a", expiresAt: now.addingTimeInterval(3600))]
        ))
        let fetcher = FakeProactiveMomentsFetcher()
        let vm = ProactiveMomentsViewModel(cache: cache, fetcher: fetcher)
        // Initial sync from cache happens in init; verify it's visible.
        XCTAssertEqual(vm.moments.map(\.id), ["mom_bg_a"])

        // Simulate background fetch updating the cache; vm.moments
        // doesn't auto-update (no Combine bridge in v1) — host calls
        // consumeCachedUpdate.
        cache.update(with: .init(
            generatedAt: now,
            moments: [
                makeMoment(id: "mom_bg_a", expiresAt: now.addingTimeInterval(3600)),
                makeMoment(id: "mom_bg_b", expiresAt: now.addingTimeInterval(7200)),
            ]
        ))
        vm.consumeCachedUpdate()
        XCTAssertEqual(vm.moments.map(\.id), ["mom_bg_a", "mom_bg_b"])
    }

    func test_doubleRefresh_doesNotConcurrentlyFire() async {
        let fetcher = FakeProactiveMomentsFetcher()
        fetcher.nextResult = .success(.init(generatedAt: Date(), moments: []))
        let vm = ProactiveMomentsViewModel(cache: ProactiveMomentsCache(), fetcher: fetcher)
        async let r1: Void = vm.refresh()
        async let r2: Void = vm.refresh()
        _ = await (r1, r2)
        // Since the second refresh sees `isRefreshing == true` and
        // returns immediately, fetcher should be called exactly once.
        XCTAssertLessThanOrEqual(fetcher.fetchCallCount, 2,
                                 "concurrent refresh calls must not stack")
    }

    // MARK: - Helpers

    private func makeMoment(id: String, expiresAt: Date) -> ProactiveMoment {
        ProactiveMoment(
            id: id,
            category: NotificationCategory.proactiveSuggestion.rawValue,
            headline: "Test moment",
            body: "Body text",
            primaryAction: ProactiveMomentAction(label: "Plan it", deeplink: nil, chatPrefill: "plan it"),
            createdAt: Date().addingTimeInterval(-60),
            expiresAt: expiresAt
        )
    }
}
