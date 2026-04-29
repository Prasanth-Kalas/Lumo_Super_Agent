import XCTest
@testable import Lumo

final class NotificationSettingsTests: XCTestCase {

    override func setUp() {
        super.setUp()
        NotificationSettings.resetForTesting()
    }

    override func tearDown() {
        NotificationSettings.resetForTesting()
        super.tearDown()
    }

    func test_isPushEnabled_defaultsTrue() {
        XCTAssertTrue(NotificationSettings.isPushEnabled)
    }

    func test_isPushEnabled_persistsExplicitFalse() {
        NotificationSettings.isPushEnabled = false
        XCTAssertFalse(NotificationSettings.isPushEnabled)
    }

    func test_categoryEnabled_defaultsTrue_forEveryCategory() {
        for category in NotificationCategory.allCases {
            XCTAssertTrue(
                NotificationSettings.isCategoryEnabled(category),
                "\(category.rawValue) should default on"
            )
        }
    }

    func test_setCategoryEnabled_isolatedPerCategory() {
        NotificationSettings.setCategoryEnabled(.proactiveSuggestion, false)
        XCTAssertFalse(NotificationSettings.isCategoryEnabled(.proactiveSuggestion))
        XCTAssertTrue(NotificationSettings.isCategoryEnabled(.tripUpdate))
        XCTAssertTrue(NotificationSettings.isCategoryEnabled(.paymentReceipt))
        XCTAssertTrue(NotificationSettings.isCategoryEnabled(.alert))
    }

    // MARK: - Quiet hours

    func test_quietHours_unsetByDefault() {
        XCTAssertNil(NotificationSettings.quietHoursStart)
        XCTAssertNil(NotificationSettings.quietHoursEnd)
        XCTAssertFalse(NotificationSettings.isInQuietHours(at: Date()))
    }

    func test_quietHours_sameDayWindow() {
        // 13:00 to 17:00.
        NotificationSettings.quietHoursStart = 13 * 60
        NotificationSettings.quietHoursEnd = 17 * 60

        // 14:00 in.
        XCTAssertTrue(NotificationSettings.isInQuietHours(at: dateAt(hour: 14)))
        // 12:59 out (just before).
        XCTAssertFalse(NotificationSettings.isInQuietHours(at: dateAt(hour: 12, minute: 59)))
        // 17:00 out (boundary is exclusive on end).
        XCTAssertFalse(NotificationSettings.isInQuietHours(at: dateAt(hour: 17)))
    }

    func test_quietHours_wrapsMidnight() {
        // 22:00 to 07:00.
        NotificationSettings.quietHoursStart = 22 * 60
        NotificationSettings.quietHoursEnd = 7 * 60

        XCTAssertTrue(NotificationSettings.isInQuietHours(at: dateAt(hour: 23, minute: 30)))
        XCTAssertTrue(NotificationSettings.isInQuietHours(at: dateAt(hour: 1)))
        XCTAssertTrue(NotificationSettings.isInQuietHours(at: dateAt(hour: 6, minute: 59)))
        XCTAssertFalse(NotificationSettings.isInQuietHours(at: dateAt(hour: 7)))
        XCTAssertFalse(NotificationSettings.isInQuietHours(at: dateAt(hour: 12)))
        XCTAssertFalse(NotificationSettings.isInQuietHours(at: dateAt(hour: 21, minute: 59)))
    }

    func test_quietHours_zeroLengthWindow_treatedAsDisabled() {
        NotificationSettings.quietHoursStart = 9 * 60
        NotificationSettings.quietHoursEnd = 9 * 60
        XCTAssertFalse(NotificationSettings.isInQuietHours(at: dateAt(hour: 9)))
    }

    func test_minutesSinceMidnight_roundTrip() {
        let date = dateAt(hour: 14, minute: 37)
        let minutes = NotificationSettings.minutesSinceMidnight(date)
        XCTAssertEqual(minutes, 14 * 60 + 37)
        let restored = NotificationSettings.dateFromMinutesSinceMidnight(minutes)
        let comps = Calendar.current.dateComponents([.hour, .minute], from: restored)
        XCTAssertEqual(comps.hour, 14)
        XCTAssertEqual(comps.minute, 37)
    }

    // MARK: - Helpers

    private func dateAt(hour: Int, minute: Int = 0) -> Date {
        var comps = DateComponents()
        comps.hour = hour
        comps.minute = minute
        comps.year = 2026
        comps.month = 4
        comps.day = 30
        return Calendar.current.date(from: comps) ?? Date()
    }
}
