import XCTest
@testable import Lumo

/// CHAT-FLIGHT-SELECT-CLICKABLE-1 — iOS contract tests for the
/// `selection` SSE frame plumbing + the FlightOffersSelectCard
/// view-model surface.
///
/// Three slices, mirroring the web `chat-flight-select-clickable.test.mjs`:
///
///   1. Parse — `selection` SSE frames decode into the typed
///      `.selection(.flightOffers(...))` ChatEvent. Unknown kinds
///      round-trip via `.selection(.unsupported(kind:))` so future
///      kinds (food / time slots) don't need re-routing. Malformed
///      payloads fall through to `.other`.
///   2. Render rule — `selections(for:)` only surfaces a card on
///      the latest assistant message before any user message,
///      matching the suggestion-chip stale-suppression rule.
///   3. Click + clear — the brief contract: tapping a row triggers
///      `ChatViewModel.sendSuggestion(value:)` with a submit string
///      carrying the row's exact `offer_id`. The newly-appended
///      user bubble flips the assistant message's selection list
///      to empty via the same render rule (no separate clear path).
@MainActor
final class FlightOffersSelectCardTests: XCTestCase {

    // MARK: - 1. parseFrame

    func test_parseFrame_selection_flightOffers_decodes() {
        let line = #"data: {"type":"selection","value":{"kind":"flight_offers","payload":{"offers":[{"offer_id":"off_123","total_amount":"189.00","total_currency":"USD","owner":{"name":"Frontier","iata_code":"F9"},"slices":[{"origin":{"iata_code":"SFO","city_name":"San Francisco"},"destination":{"iata_code":"LAS","city_name":"Las Vegas"},"duration":"PT1H30M","segments":[{"departing_at":"2026-05-09T09:30:00Z","arriving_at":"2026-05-09T11:00:00Z","marketing_carrier":{"iata_code":"F9"},"marketing_carrier_flight_number":"123"}]}]}]}}}"#
        guard case let .selection(.flightOffers(payload)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.flightOffers), got something else")
        }
        XCTAssertEqual(payload.offers.count, 1)
        let o = payload.offers[0]
        XCTAssertEqual(o.offer_id, "off_123")
        XCTAssertEqual(o.total_amount, "189.00")
        XCTAssertEqual(o.owner.name, "Frontier")
        XCTAssertEqual(o.slices[0].origin.iata_code, "SFO")
        XCTAssertEqual(o.slices[0].segments[0].marketing_carrier_iata, "F9")
    }

    func test_parseFrame_selection_unknownKind_passesThroughAsUnsupported() {
        // IOS-FOOD-MENU-TIME-SLOTS-PARSE-1 made `food_menu` a known
        // kind. A genuinely-unknown future kind still round-trips
        // via `.unsupported(kind:)` so iOS doesn't lose the frame
        // when web ships ahead.
        let line = #"data: {"type":"selection","value":{"kind":"future_kind_we_dont_know","payload":{"anything":"goes"}}}"#
        XCTAssertEqual(
            ChatService.parseFrame(line: line),
            .selection(.unsupported(kind: "future_kind_we_dont_know"))
        )
    }

    func test_parseFrame_selection_missingKind_fallsThrough() {
        let line = #"data: {"type":"selection","value":{"payload":{"offers":[]}}}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .other(type: "selection"))
    }

    func test_parseFrame_selection_flightOffers_emptyOffers_isMalformed() {
        // IOS-FOOD-MENU-TIME-SLOTS-PARSE-1 introduces the
        // `.malformed(kind:reason:)` case to distinguish bad-payload-
        // for-known-kind from unknown-kind. An empty offers array
        // fails the flight_offers decoder, which now surfaces as
        // .malformed rather than .other(type:) — callers that want
        // to log "we got a flight_offers frame but couldn't read it"
        // get the kind context preserved.
        guard case let .selection(.malformed(kind, _)) = ChatService.parseFrame(
            line: #"data: {"type":"selection","value":{"kind":"flight_offers","payload":{"offers":[]}}}"#
        ) else {
            return XCTFail("expected .selection(.malformed(...))")
        }
        XCTAssertEqual(kind, "flight_offers")
    }

    func test_parseFrame_selection_flightOffers_malformedOffer_isDropped() {
        // First offer is fully-formed, second is missing total_amount.
        // The malformed one should drop, the well-formed one survives.
        let line = #"data: {"type":"selection","value":{"kind":"flight_offers","payload":{"offers":[{"offer_id":"off_1","total_amount":"100.00","total_currency":"USD","owner":{"name":"A","iata_code":"AA"},"slices":[{"origin":{"iata_code":"X"},"destination":{"iata_code":"Y"},"duration":"PT1H","segments":[{"departing_at":"2026-05-09T09:30:00Z","arriving_at":"2026-05-09T10:30:00Z","marketing_carrier":{"iata_code":"AA"},"marketing_carrier_flight_number":"1"}]}]},{"offer_id":"off_bad","total_currency":"USD","owner":{"name":"B","iata_code":"BB"},"slices":[]}]}}}"#
        guard case let .selection(.flightOffers(payload)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.flightOffers), got something else")
        }
        XCTAssertEqual(payload.offers.count, 1)
        XCTAssertEqual(payload.offers[0].offer_id, "off_1")
    }

    // MARK: - 2. Render rule

    func test_selectionsFor_returnsCard_whenLatestAssistantHasFrame() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(
            role: .assistant,
            text: "Here are the options.",
            status: .delivered
        )
        let payload = FlightOffersPayload(offers: [
            FlightOffer(
                offer_id: "off_X",
                total_amount: "189.00",
                total_currency: "USD",
                owner: .init(name: "Frontier", iata_code: "F9"),
                slices: [
                    .init(
                        origin: .init(iata_code: "SFO", city_name: nil),
                        destination: .init(iata_code: "LAS", city_name: nil),
                        duration: "PT1H30M",
                        segments: [
                            .init(
                                departing_at: "2026-05-09T09:30:00Z",
                                arriving_at: "2026-05-09T11:00:00Z",
                                marketing_carrier_iata: "F9",
                                marketing_carrier_flight_number: "123"
                            )
                        ]
                    )
                ]
            ),
        ])
        vm._seedForTest(
            messages: [assistant],
            selections: [assistant.id: [.flightOffers(payload)]]
        )

        let result = vm.selections(for: assistant)
        XCTAssertEqual(result.count, 1)
        if case .flightOffers(let p) = result[0] {
            XCTAssertEqual(p.offers.first?.offer_id, "off_X")
        } else {
            XCTFail("expected .flightOffers selection")
        }
    }

    func test_selectionsFor_isEmpty_whenUserMessageFollowsAssistant() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Options.", status: .delivered)
        let user = ChatMessage(role: .user, text: "frontier", status: .sent)
        let payload = FlightOffersPayload(offers: [makeFlightOffer(id: "off_X")])
        vm._seedForTest(
            messages: [assistant, user],
            selections: [assistant.id: [.flightOffers(payload)]]
        )

        XCTAssertTrue(
            vm.selections(for: assistant).isEmpty,
            "stale selection cards must suppress once a user message lands after them"
        )
    }

    func test_selectionsFor_isEmpty_forUserRoleMessage() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let user = ChatMessage(role: .user, text: "Hi", status: .sent)
        let payload = FlightOffersPayload(offers: [makeFlightOffer(id: "off_X")])
        vm._seedForTest(
            messages: [user],
            selections: [user.id: [.flightOffers(payload)]]
        )
        XCTAssertTrue(
            vm.selections(for: user).isEmpty,
            "user-role messages never surface selection cards"
        )
    }

    // MARK: - 3. Submit contract

    func test_buildSubmitText_includesOfferIDVerbatim() {
        let offer = makeFlightOffer(id: "off_abc_xyz")
        let text = FlightOffersSubmit.text(for: offer)
        XCTAssertTrue(
            text.contains("offer off_abc_xyz"),
            "submit text must carry the exact offer_id so the orchestrator can route to flight_price_offer; got: \(text)"
        )
    }

    func test_buildSubmitText_directVsConnection() {
        // Single segment → " direct ".
        let direct = makeFlightOffer(id: "off_direct")
        XCTAssertTrue(FlightOffersSubmit.text(for: direct).contains(" direct "))

        // Multi-segment → "(with connection)".
        let connecting = FlightOffer(
            offer_id: "off_conn",
            total_amount: "189.00",
            total_currency: "USD",
            owner: .init(name: "Frontier", iata_code: "F9"),
            slices: [
                .init(
                    origin: .init(iata_code: "SFO", city_name: nil),
                    destination: .init(iata_code: "JFK", city_name: nil),
                    duration: "PT5H30M",
                    segments: [
                        .init(
                            departing_at: "2026-05-09T09:30:00Z",
                            arriving_at: "2026-05-09T11:00:00Z",
                            marketing_carrier_iata: "F9",
                            marketing_carrier_flight_number: "123"
                        ),
                        .init(
                            departing_at: "2026-05-09T13:00:00Z",
                            arriving_at: "2026-05-09T18:00:00Z",
                            marketing_carrier_iata: "F9",
                            marketing_carrier_flight_number: "456"
                        ),
                    ]
                )
            ]
        )
        XCTAssertTrue(FlightOffersSubmit.text(for: connecting).contains("(with connection)"))
    }

    func test_buildSubmitText_includesCarrierAndPrice() {
        let offer = makeFlightOffer(
            id: "off_X",
            carrierName: "Alaska",
            amount: "1240.00"
        )
        let text = FlightOffersSubmit.text(for: offer)
        XCTAssertTrue(text.contains("Alaska"))
        XCTAssertTrue(text.contains("$1240.00"))
    }

    func test_sendSuggestion_appendsUserBubble_clearsSelectionViaRenderRule() {
        // Ties the iOS path to the brief's contract: tapping a row
        // calls ChatViewModel.sendSuggestion(value:) with the row's
        // submit text. The card uses the same entry point as the
        // suggestion chips — there is intentionally no separate
        // selection-submit method on the view model.
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Options.", status: .delivered)
        let payload = FlightOffersPayload(offers: [makeFlightOffer(id: "off_X")])
        vm._seedForTest(
            messages: [assistant],
            selections: [assistant.id: [.flightOffers(payload)]]
        )
        XCTAssertFalse(
            vm.selections(for: assistant).isEmpty,
            "precondition: card visible before submit"
        )

        let submitText = FlightOffersSubmit.text(for: payload.offers[0])
        vm.sendSuggestion(submitText)

        // The new user bubble carries the submit text — including
        // the offer_id substring the orchestrator parses on.
        let users = vm.messages.filter { $0.role == .user }
        XCTAssertEqual(users.count, 1)
        XCTAssertTrue(users.first?.text.contains("off_X") ?? false,
                      "user bubble must carry the offer_id so the server can resolve it")

        // The same render rule that hides stale suggestion chips
        // also hides stale selection cards — implicit clear, no
        // separate clear path.
        XCTAssertTrue(
            vm.selections(for: assistant).isEmpty,
            "selection card must clear once a user message lands after the assistant turn"
        )
    }

    // MARK: - Helpers

    private func makeFlightOffer(
        id: String,
        carrierName: String = "Frontier",
        amount: String = "189.00"
    ) -> FlightOffer {
        FlightOffer(
            offer_id: id,
            total_amount: amount,
            total_currency: "USD",
            owner: .init(name: carrierName, iata_code: "F9"),
            slices: [
                .init(
                    origin: .init(iata_code: "SFO", city_name: nil),
                    destination: .init(iata_code: "LAS", city_name: nil),
                    duration: "PT1H30M",
                    segments: [
                        .init(
                            departing_at: "2026-05-09T09:30:00Z",
                            arriving_at: "2026-05-09T11:00:00Z",
                            marketing_carrier_iata: "F9",
                            marketing_carrier_flight_number: "123"
                        )
                    ]
                )
            ]
        )
    }
}
