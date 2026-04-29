import XCTest
@testable import Lumo

@MainActor
final class BackgroundFetchTests: XCTestCase {

    // MARK: - Identifier + interval

    func test_proactiveRefreshIdentifier_isStable() {
        XCTAssertEqual(
            BackgroundFetchService.proactiveRefreshIdentifier,
            "com.lumo.rentals.ios.proactive-refresh",
            "matches the BGTaskSchedulerPermittedIdentifiers Info.plist entry"
        )
    }

    func test_earliestBeginInterval_isFourHours() {
        XCTAssertEqual(
            BackgroundFetchService.earliestBeginInterval,
            4 * 60 * 60,
            accuracy: 1,
            "brief specifies 4h cadence"
        )
    }

    // MARK: - FakeBackgroundFetchService

    func test_fake_register_increments() {
        let fake = FakeBackgroundFetchService()
        fake.register()
        fake.register()
        XCTAssertEqual(fake.registerCallCount, 2)
    }

    func test_fake_scheduleNext_setsEarliestBeginInFuture() {
        let fake = FakeBackgroundFetchService()
        let beforeCall = Date()
        fake.scheduleNext()
        XCTAssertEqual(fake.scheduleNextCallCount, 1)
        guard let earliest = fake.lastScheduledRequestEarliestBegin else {
            return XCTFail("expected earliest-begin date to be recorded")
        }
        // Should be ~4h in the future (allow a small skew window).
        let delta = earliest.timeIntervalSince(beforeCall)
        XCTAssertGreaterThan(delta, 4 * 60 * 60 - 5)
        XCTAssertLessThan(delta, 4 * 60 * 60 + 5)
    }

    // MARK: - Cache update via fetcher (the work the BGTask handler does)

    func test_cache_updatesFromFetcher_filtersExpiredAndDismissed() async throws {
        let cache = ProactiveMomentsCache()
        let now = Date()
        let fresh = makeMoment(id: "mom_a", expiresAt: now.addingTimeInterval(3600))
        let expired = makeMoment(id: "mom_b", expiresAt: now.addingTimeInterval(-60))
        let response = ProactiveMomentsResponse(generatedAt: now, moments: [fresh, expired])
        cache.update(with: response)
        XCTAssertEqual(cache.moments.map(\.id), ["mom_a"], "expired moment filtered out")
    }

    func test_cache_dismissPersistsAcrossUpdate() async throws {
        // Use a unique key path to avoid cross-test bleed via UserDefaults.
        let cache = ProactiveMomentsCache()
        let now = Date()
        let m = makeMoment(id: "mom_persistent_\(UUID().uuidString)", expiresAt: now.addingTimeInterval(3600))
        cache.update(with: ProactiveMomentsResponse(generatedAt: now, moments: [m]))
        XCTAssertEqual(cache.moments.count, 1)
        cache.dismiss(m.id)
        XCTAssertEqual(cache.moments.count, 0)

        // Re-pump from server with the same moment — it should stay
        // dismissed.
        cache.update(with: ProactiveMomentsResponse(generatedAt: now, moments: [m]))
        XCTAssertEqual(cache.moments.count, 0,
                       "dismissed id should not re-surface on subsequent fetch")
    }

    // MARK: - Helpers

    private func makeMoment(id: String, expiresAt: Date) -> ProactiveMoment {
        ProactiveMoment(
            id: id,
            category: NotificationCategory.proactiveSuggestion.rawValue,
            headline: "Test",
            body: "Body",
            primaryAction: ProactiveMomentAction(label: "Go", deeplink: nil, chatPrefill: "do it"),
            createdAt: Date().addingTimeInterval(-60),
            expiresAt: expiresAt
        )
    }
}
