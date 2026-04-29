import XCTest
import UserNotifications
@testable import Lumo

@MainActor
final class NotificationActionHandlerTests: XCTestCase {

    private var handler: NotificationActionHandler!
    private var snoozer: FakeNotificationSnoozer!

    override func setUp() async throws {
        try await super.setUp()
        handler = NotificationActionHandler.shared
        snoozer = FakeNotificationSnoozer()
        handler._installForTestingOnly(snoozer: snoozer)
    }

    // MARK: - Default tap (body tap, no action button)

    func test_defaultTap_tripUpdate_routesToTrips() {
        handler.handle(
            categoryIdentifier: NotificationCategory.tripUpdate.rawValue,
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .openTrips)
    }

    func test_defaultTap_proactive_routesToChatWithPrefill() {
        handler.handle(
            categoryIdentifier: NotificationCategory.proactiveSuggestion.rawValue,
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: ["chatPrefill": "Plan a Vegas trip"]
        )
        XCTAssertEqual(handler.lastRoute, .openChatWithPrefill("Plan a Vegas trip"))
    }

    func test_defaultTap_proactive_fallsBackToHeadlineWhenNoPrefill() {
        handler.handle(
            categoryIdentifier: NotificationCategory.proactiveSuggestion.rawValue,
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: ["headline": "You have a 3-day weekend"]
        )
        XCTAssertEqual(handler.lastRoute, .openChatWithPrefill("You have a 3-day weekend"))
    }

    func test_defaultTap_paymentReceipt_routesToReceiptWithID() {
        handler.handle(
            categoryIdentifier: NotificationCategory.paymentReceipt.rawValue,
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: ["receiptID": "rcpt_test_42"]
        )
        XCTAssertEqual(handler.lastRoute, .openReceiptID("rcpt_test_42"))
    }

    func test_defaultTap_alert_routesToAlertsCenter() {
        handler.handle(
            categoryIdentifier: NotificationCategory.alert.rawValue,
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .openAlertsCenter)
    }

    func test_defaultTap_unknownCategory_publishesNothing() {
        handler.handle(
            categoryIdentifier: "made-up-category",
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: [:]
        )
        XCTAssertNil(handler.lastRoute)
    }

    // MARK: - Explicit action buttons

    func test_explicitAction_tripUpdateView_routesToTrips() {
        handler.handle(
            categoryIdentifier: NotificationCategory.tripUpdate.rawValue,
            actionIdentifier: NotificationAction.tripUpdateView.rawValue,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .openTrips)
    }

    func test_explicitAction_tripUpdateDismiss_publishesDismissed() {
        handler.handle(
            categoryIdentifier: NotificationCategory.tripUpdate.rawValue,
            actionIdentifier: NotificationAction.tripUpdateDismiss.rawValue,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .dismissed)
    }

    func test_explicitAction_proactiveAccept_routesToChatWithPrefill() {
        handler.handle(
            categoryIdentifier: NotificationCategory.proactiveSuggestion.rawValue,
            actionIdentifier: NotificationAction.proactiveAccept.rawValue,
            userInfo: ["chatPrefill": "Yes plan that"]
        )
        XCTAssertEqual(handler.lastRoute, .openChatWithPrefill("Yes plan that"))
    }

    func test_explicitAction_proactiveDismiss_publishesDismissed() {
        handler.handle(
            categoryIdentifier: NotificationCategory.proactiveSuggestion.rawValue,
            actionIdentifier: NotificationAction.proactiveDismiss.rawValue,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .dismissed)
    }

    func test_explicitAction_proactiveRemindLater_callsSnoozer_andPublishesAck() async {
        let momentID = "mom_stub_1"
        handler.handle(
            categoryIdentifier: NotificationCategory.proactiveSuggestion.rawValue,
            actionIdentifier: NotificationAction.proactiveRemindLater.rawValue,
            userInfo: ["momentID": momentID]
        )
        XCTAssertEqual(handler.lastRoute, .snoozedAcknowledged)

        // Snooze is fire-and-forget via Task; give it a tick to land.
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(snoozer.snoozeCalls.count, 1, "snooze should have been called once")
        XCTAssertEqual(snoozer.snoozeCalls.first?.momentID, momentID)
    }

    func test_explicitAction_paymentReceiptView_routesToReceiptWithID() {
        handler.handle(
            categoryIdentifier: NotificationCategory.paymentReceipt.rawValue,
            actionIdentifier: NotificationAction.paymentReceiptView.rawValue,
            userInfo: ["receiptID": "rcpt_test_42"]
        )
        XCTAssertEqual(handler.lastRoute, .openReceiptID("rcpt_test_42"))
    }

    func test_explicitAction_paymentReceiptDismiss_publishesDismissed() {
        handler.handle(
            categoryIdentifier: NotificationCategory.paymentReceipt.rawValue,
            actionIdentifier: NotificationAction.paymentReceiptDismiss.rawValue,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .dismissed)
    }

    func test_explicitAction_alertAcknowledge_routesToAlertsCenter() {
        handler.handle(
            categoryIdentifier: NotificationCategory.alert.rawValue,
            actionIdentifier: NotificationAction.alertAcknowledge.rawValue,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .openAlertsCenter)
    }

    // MARK: - System dismiss + unknown action

    func test_systemDismissAction_publishesDismissed() {
        handler.handle(
            categoryIdentifier: NotificationCategory.tripUpdate.rawValue,
            actionIdentifier: UNNotificationDismissActionIdentifier,
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .dismissed)
    }

    func test_unknownExplicitAction_fallsBackToDefaultTap() {
        handler.handle(
            categoryIdentifier: NotificationCategory.tripUpdate.rawValue,
            actionIdentifier: "trip-update.fictional-button",
            userInfo: [:]
        )
        XCTAssertEqual(handler.lastRoute, .openTrips,
                       "unknown action should fall through to default tap rather than swallowing the gesture")
    }

    // MARK: - Dispute action explicitly absent (Option A)

    func test_paymentReceiptDispute_isUnknownAction_fallsBackToDefaultTap() {
        // The reviewer's Option A drop means `payment-receipt.dispute`
        // is not a registered action — the handler treats it as unknown
        // and falls back to default-tap (open the receipt).
        handler.handle(
            categoryIdentifier: NotificationCategory.paymentReceipt.rawValue,
            actionIdentifier: "payment-receipt.dispute",
            userInfo: ["receiptID": "rcpt_test_42"]
        )
        XCTAssertEqual(handler.lastRoute, .openReceiptID("rcpt_test_42"))
    }
}
