import XCTest
@testable import Lumo

/// IOS-BOOKING-CONFIRM-AUTOFILL-1 — contract tests for the `summary`
/// SSE frame plumbing + the BookingConfirmationCard view-model
/// surface. Mirrors the FlightOffersSelectCardTests / SuggestionChipsTests
/// pattern.
///
/// Three slices:
///
///   1. Parse — `summary` SSE frames decode into
///      `.summary(.itinerary(...))` for `kind: "structured-itinerary"`.
///      Other kinds round-trip via `.summary(.unsupported(kind:))`.
///      Frames missing envelope fields fall through to `.other`;
///      malformed slices/segments drop while preserving
///      well-formed siblings.
///   2. Render rule — `summary(for:)` returns the cached summary
///      regardless of subsequent user messages (unlike chips and
///      selections, which auto-suppress); decision flips to
///      `.confirmed` / `.cancelled` once a user message lands.
///   3. Confirm + Cancel — the brief contract: tapping a button
///      calls `ChatViewModel.sendSuggestion(value:)` with the exact
///      web-matching submit string from `BookingConfirmationSubmit`.
@MainActor
final class BookingConfirmationCardTests: XCTestCase {

    // MARK: - 1. parseFrame

    func test_parseFrame_summary_itinerary_decodes() {
        let line = #"data: {"type":"summary","value":{"kind":"structured-itinerary","hash":"abc123","session_id":"sess-1","turn_id":"turn-7","rendered_at":"2026-05-01T15:30:00Z","payload":{"kind":"structured-itinerary","offer_id":"off_united","total_amount":"287.00","total_currency":"USD","slices":[{"origin":"SFO","destination":"LAS","segments":[{"origin":"SFO","destination":"LAS","departing_at":"2026-05-09T07:15:00Z","arriving_at":"2026-05-09T08:50:00Z","carrier":"UA","flight_number":"1234"}]}]}}}"#
        guard case let .summary(.itinerary(payload, env)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .summary(.itinerary(...)), got something else")
        }
        XCTAssertEqual(payload.offer_id, "off_united")
        XCTAssertEqual(payload.total_amount, "287.00")
        XCTAssertEqual(payload.total_currency, "USD")
        XCTAssertEqual(payload.slices.first?.origin, "SFO")
        XCTAssertEqual(payload.slices.first?.segments.first?.carrier, "UA")
        XCTAssertEqual(env.hash, "abc123")
        XCTAssertEqual(env.turn_id, "turn-7")
    }

    func test_parseFrame_summary_unknownKind_passesThroughAsUnsupported() {
        let line = #"data: {"type":"summary","value":{"kind":"structured-cart","hash":"h","session_id":"s","turn_id":"t","rendered_at":"2026-05-01T00:00:00Z","payload":{}}}"#
        guard case let .summary(.unsupported(kind, env)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .summary(.unsupported(...)), got something else")
        }
        XCTAssertEqual(kind, "structured-cart")
        XCTAssertEqual(env.hash, "h")
    }

    func test_parseFrame_summary_missingEnvelopeFields_fallsThrough() {
        // No hash → fall through to .other(type:); the orchestrator's
        // confirm gate requires a hash so a frame without one is
        // unusable on iOS too.
        let line = #"data: {"type":"summary","value":{"kind":"structured-itinerary","session_id":"s","turn_id":"t","rendered_at":"2026-05-01T00:00:00Z","payload":{}}}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .other(type: "summary"))
    }

    func test_parseFrame_summary_itinerary_malformedSegment_drops_keepsRest() {
        // First segment is fully-formed, second is missing carrier →
        // the malformed segment drops, the slice stays.
        let line = #"data: {"type":"summary","value":{"kind":"structured-itinerary","hash":"h","session_id":"s","turn_id":"t","rendered_at":"2026-05-01T00:00:00Z","payload":{"kind":"structured-itinerary","offer_id":"off_x","total_amount":"100.00","total_currency":"USD","slices":[{"origin":"SFO","destination":"LAS","segments":[{"origin":"SFO","destination":"LAS","departing_at":"2026-05-09T09:30:00Z","arriving_at":"2026-05-09T11:00:00Z","carrier":"UA","flight_number":"1"},{"origin":"SFO","destination":"LAS","departing_at":"2026-05-09T12:00:00Z","arriving_at":"2026-05-09T14:00:00Z","flight_number":"2"}]}]}}}"#
        guard case let .summary(.itinerary(payload, _)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .summary(.itinerary(...))")
        }
        XCTAssertEqual(payload.slices.first?.segments.count, 1)
        XCTAssertEqual(payload.slices.first?.segments.first?.carrier, "UA")
    }

    // MARK: - 2. Render rule + decision

    func test_summaryFor_returnsCard_evenWithLaterUserMessage() {
        // Unlike chips and selection cards, summaries DON'T
        // auto-suppress when a user message lands — they transition
        // into a decided-label state instead. The card is the
        // receipt of the user's confirm/cancel.
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Here's the price.", status: .delivered)
        let user = ChatMessage(role: .user, text: BookingConfirmationSubmit.confirmText, status: .sent)
        let payload = makeItineraryPayload()
        let envelope = ConfirmationEnvelope(
            hash: "h", session_id: "s", turn_id: "t", rendered_at: "2026-05-01T00:00:00Z"
        )
        vm._seedForTest(
            messages: [assistant, user],
            summaries: [assistant.id: .itinerary(payload, envelope: envelope)]
        )

        guard case let .itinerary(returned, _) = vm.summary(for: assistant) else {
            return XCTFail("expected .itinerary summary, got nil/other")
        }
        XCTAssertEqual(returned.offer_id, payload.offer_id)
    }

    func test_summaryDecision_isNil_whenNoUserMessageAfter() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Here's the price.", status: .delivered)
        let payload = makeItineraryPayload()
        let envelope = ConfirmationEnvelope(
            hash: "h", session_id: "s", turn_id: "t", rendered_at: "2026-05-01T00:00:00Z"
        )
        vm._seedForTest(
            messages: [assistant],
            summaries: [assistant.id: .itinerary(payload, envelope: envelope)]
        )

        XCTAssertNil(vm.summaryDecision(for: assistant))
    }

    func test_summaryDecision_isConfirmed_onAffirmativeUserReply() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Here's the price.", status: .delivered)
        let user = ChatMessage(role: .user, text: BookingConfirmationSubmit.confirmText, status: .sent)
        let payload = makeItineraryPayload()
        let envelope = ConfirmationEnvelope(
            hash: "h", session_id: "s", turn_id: "t", rendered_at: "2026-05-01T00:00:00Z"
        )
        vm._seedForTest(
            messages: [assistant, user],
            summaries: [assistant.id: .itinerary(payload, envelope: envelope)]
        )

        XCTAssertEqual(vm.summaryDecision(for: assistant), .confirmed)
    }

    func test_summaryDecision_isCancelled_onCancelUserReply() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Here's the price.", status: .delivered)
        let user = ChatMessage(role: .user, text: BookingConfirmationSubmit.cancelText, status: .sent)
        let payload = makeItineraryPayload()
        let envelope = ConfirmationEnvelope(
            hash: "h", session_id: "s", turn_id: "t", rendered_at: "2026-05-01T00:00:00Z"
        )
        vm._seedForTest(
            messages: [assistant, user],
            summaries: [assistant.id: .itinerary(payload, envelope: envelope)]
        )

        XCTAssertEqual(vm.summaryDecision(for: assistant), .cancelled)
    }

    func test_summaryFor_isNil_forUserRoleMessage() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let user = ChatMessage(role: .user, text: "Hi", status: .sent)
        let payload = makeItineraryPayload()
        let envelope = ConfirmationEnvelope(
            hash: "h", session_id: "s", turn_id: "t", rendered_at: "2026-05-01T00:00:00Z"
        )
        vm._seedForTest(
            messages: [user],
            summaries: [user.id: .itinerary(payload, envelope: envelope)]
        )

        XCTAssertNil(vm.summary(for: user))
    }

    // MARK: - 3. Confirm + Cancel submit contract

    func test_sendSuggestion_appendsUserBubbleWithExactConfirmText() {
        // Locks the byte-identical web ↔ iOS submit string. If the
        // orchestrator's isAffirmative regex moves, both surfaces
        // need to update together.
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Here's the price.", status: .delivered)
        let payload = makeItineraryPayload()
        let envelope = ConfirmationEnvelope(
            hash: "h", session_id: "s", turn_id: "t", rendered_at: "2026-05-01T00:00:00Z"
        )
        vm._seedForTest(
            messages: [assistant],
            summaries: [assistant.id: .itinerary(payload, envelope: envelope)]
        )

        vm.sendSuggestion(BookingConfirmationSubmit.confirmText)

        let users = vm.messages.filter { $0.role == .user }
        XCTAssertEqual(users.count, 1)
        XCTAssertEqual(users.first?.text, "Yes, book it.")
        XCTAssertEqual(vm.summaryDecision(for: assistant), .confirmed)
    }

    func test_sendSuggestion_appendsUserBubbleWithExactCancelText() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Here's the price.", status: .delivered)
        let payload = makeItineraryPayload()
        let envelope = ConfirmationEnvelope(
            hash: "h", session_id: "s", turn_id: "t", rendered_at: "2026-05-01T00:00:00Z"
        )
        vm._seedForTest(
            messages: [assistant],
            summaries: [assistant.id: .itinerary(payload, envelope: envelope)]
        )

        vm.sendSuggestion(BookingConfirmationSubmit.cancelText)

        let users = vm.messages.filter { $0.role == .user }
        XCTAssertEqual(users.count, 1)
        XCTAssertEqual(users.first?.text, "Cancel — don't book that.")
        XCTAssertEqual(vm.summaryDecision(for: assistant), .cancelled)
    }

    func test_confirmText_andCancelText_locked() {
        // Byte-identical with the web shell's calls in
        // apps/web/app/page.tsx onConfirm/onCancel:
        //   onConfirm={() => void sendText("Yes, book it.")}
        //   onCancel={() => void sendText("Cancel — don't book that.")}
        // If web changes these strings, iOS must update too — these
        // hit the orchestrator's isAffirmative regex contract.
        XCTAssertEqual(BookingConfirmationSubmit.confirmText, "Yes, book it.")
        XCTAssertEqual(BookingConfirmationSubmit.cancelText, "Cancel — don't book that.")
    }

    // MARK: - Helpers

    private func makeItineraryPayload() -> ItineraryPayload {
        ItineraryPayload(
            kind: "structured-itinerary",
            offer_id: "off_united_morning",
            total_amount: "238.00",
            total_currency: "USD",
            slices: [
                ItinerarySlice(
                    origin: "SFO",
                    destination: "LAS",
                    segments: [
                        ItinerarySegment(
                            origin: "SFO",
                            destination: "LAS",
                            departing_at: "2026-05-09T07:15:00Z",
                            arriving_at: "2026-05-09T08:50:00Z",
                            carrier: "UA",
                            flight_number: "1234"
                        )
                    ]
                )
            ]
        )
    }
}
