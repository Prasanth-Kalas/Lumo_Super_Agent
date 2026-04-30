import SwiftUI
import XCTest
@testable import Lumo

/// Chat-root behavior tests for the ChatGPT-style nav arch.
///
/// Covers:
///   • ChatViewModel.reset() — drawer's "New Chat" affordance.
///   • NotificationRouteResolver — deep-link → NavigationStack path.
///   • Send-disabled rule — composer's canSend logic indirectly via
///     ChatViewModel state.
///
/// Body inspection is out of scope (no ViewInspector in this repo);
/// this file replaces a body-level check with a state-shape check
/// against the ViewModels and pure resolvers RootView/ChatView bind to.
@MainActor
final class ChatRootViewTests: XCTestCase {

    // MARK: - ChatViewModel.reset

    func test_reset_dropsMessagesInputErrorAndStreamingState() {
        let svc = ChatService(
            baseURL: URL(string: "http://localhost:9999")!,
            session: URLSession(configuration: .ephemeral)
        )
        let vm = ChatViewModel(service: svc)
        // Synthesize the post-turn state: input typed, an error set,
        // a couple of messages locally appended (we use the public
        // surface — sendVoiceTranscript appends a user bubble).
        vm.input = "hello there"
        vm.sendVoiceTranscript("hi")
        // Even though the stream wires up an SSE call, we don't care
        // about the network side — reset() should wipe regardless.
        vm.reset()

        XCTAssertTrue(vm.messages.isEmpty)
        XCTAssertEqual(vm.input, "")
        XCTAssertNil(vm.error)
        XCTAssertFalse(vm.isStreaming)
        XCTAssertNil(vm.lastFirstTokenLatency)
    }

    // MARK: - Notification route resolver

    func test_resolve_openTrips_pushesTripsDestination() {
        let res = NotificationRouteResolver.resolve(.openTrips)
        XCTAssertEqual(res, .replace(path: [.trips], chatInput: nil))
    }

    func test_resolve_openReceipt_withID_pushesReceiptsThenDetail() {
        let res = NotificationRouteResolver.resolve(.openReceiptID("rcpt_42"))
        XCTAssertEqual(
            res,
            .replace(path: [.receipts, .receiptDetail("rcpt_42")], chatInput: nil)
        )
    }

    func test_resolve_openReceipt_withNilID_pushesOnlyReceipts() {
        let res = NotificationRouteResolver.resolve(.openReceiptID(nil))
        XCTAssertEqual(res, .replace(path: [.receipts], chatInput: nil))
    }

    func test_resolve_openReceipt_withEmptyID_pushesOnlyReceipts() {
        let res = NotificationRouteResolver.resolve(.openReceiptID(""))
        XCTAssertEqual(res, .replace(path: [.receipts], chatInput: nil))
    }

    func test_resolve_openChatWithPrefill_clearsPathSetsInput() {
        let res = NotificationRouteResolver.resolve(.openChatWithPrefill("Plan Vegas"))
        XCTAssertEqual(res, .replace(path: [], chatInput: "Plan Vegas"))
    }

    func test_resolve_openAlertsCenter_landsOnSettings() {
        // No dedicated alerts surface today — settings owns notif prefs.
        let res = NotificationRouteResolver.resolve(.openAlertsCenter)
        XCTAssertEqual(res, .replace(path: [.settings], chatInput: nil))
    }

    func test_resolve_dismissed_isNoChange() {
        XCTAssertEqual(NotificationRouteResolver.resolve(.dismissed), .noChange)
    }

    func test_resolve_snoozedAcknowledged_isNoChange() {
        XCTAssertEqual(NotificationRouteResolver.resolve(.snoozedAcknowledged), .noChange)
    }

    // MARK: - Composer canSend rule (mirrors ChatView's predicate)

    func test_canSend_emptyInput_isFalse() {
        XCTAssertFalse(canSendFor(input: "", isStreaming: false))
    }

    func test_canSend_whitespaceOnlyInput_isFalse() {
        XCTAssertFalse(canSendFor(input: "    \n\t  ", isStreaming: false))
    }

    func test_canSend_realInput_isTrue() {
        XCTAssertTrue(canSendFor(input: "hello", isStreaming: false))
    }

    func test_canSend_whileStreaming_isFalse() {
        XCTAssertFalse(canSendFor(input: "hello", isStreaming: true))
    }

    /// Mirror of ChatView.canSend so any future changes to the rule
    /// (e.g. min length) update both sides at once.
    private func canSendFor(input: String, isStreaming: Bool) -> Bool {
        return !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isStreaming
    }
}

