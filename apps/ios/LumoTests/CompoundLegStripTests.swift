import XCTest
@testable import Lumo

/// IOS-COMPOUND-VIEW-1 — contract tests for the
/// `assistant_compound_dispatch` SSE frame plumbing + the
/// per-leg status override layer + settled-state suppression.
/// Mirrors the BookingConfirmationCardTests / FlightOffersSelectCardTests
/// pattern.
///
/// Four slices:
///
///   1. Parse — `assistant_compound_dispatch` SSE frames decode
///      into `.compoundDispatch(CompoundDispatchPayload)`.
///      Malformed legs drop, unknown statuses fall back to
///      `manual_review`, empty leg list falls through to .other.
///
///   2. Leg-status frame parse — `event: leg_status\ndata: {...}`
///      from the per-compound stream decodes via
///      `CompoundStreamService.parseLegStatusFrame`.
///
///   3. Render rule + settled — `compoundDispatch(for:)` returns
///      the cached payload regardless of subsequent user
///      messages (like summary cards, the strip stays visible).
///      `compoundSettled` flips true only when every leg's
///      override-or-initial status is terminal.
///
///   4. Status transitions — driving `_applyCompoundLegStatusForTest`
///      with a sequence of pending → in_flight → committed updates
///      flips the override layer; the helper layer derives
///      settled-state correctly through the transitions.
@MainActor
final class CompoundLegStripTests: XCTestCase {

    // MARK: - 1. parseFrame for assistant_compound_dispatch

    func test_parseFrame_compoundDispatch_decodes() {
        let line = #"data: {"type":"assistant_compound_dispatch","value":{"kind":"assistant_compound_dispatch","compound_transaction_id":"ct_vegas","legs":[{"leg_id":"leg_1","agent_id":"lumo-flights","agent_display_name":"Lumo Flights","description":"Booking flight ORD → LAS","status":"in_flight"},{"leg_id":"leg_2","agent_id":"lumo-hotels","agent_display_name":"Lumo Hotels","description":"Booking hotel near the Strip","status":"pending"},{"leg_id":"leg_3","agent_id":"lumo-restaurants","agent_display_name":"Lumo Restaurants","description":"Booking dinner reservation","status":"pending"}]}}"#
        guard case let .compoundDispatch(payload) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .compoundDispatch, got something else")
        }
        XCTAssertEqual(payload.compound_transaction_id, "ct_vegas")
        XCTAssertEqual(payload.legs.count, 3)
        XCTAssertEqual(payload.legs[0].leg_id, "leg_1")
        XCTAssertEqual(payload.legs[0].agent_id, "lumo-flights")
        XCTAssertEqual(payload.legs[0].status, .in_flight)
        XCTAssertEqual(payload.legs[2].agent_display_name, "Lumo Restaurants")
    }

    func test_parseFrame_compoundDispatch_emptyLegs_fallsThrough() {
        let line = #"data: {"type":"assistant_compound_dispatch","value":{"kind":"assistant_compound_dispatch","compound_transaction_id":"ct_x","legs":[]}}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .other(type: "assistant_compound_dispatch"))
    }

    func test_parseFrame_compoundDispatch_malformedLeg_drops_keepsRest() {
        // Second leg missing description — drops; first survives.
        let line = #"data: {"type":"assistant_compound_dispatch","value":{"kind":"assistant_compound_dispatch","compound_transaction_id":"ct_x","legs":[{"leg_id":"leg_1","agent_id":"lumo-flights","agent_display_name":"Lumo Flights","description":"Flight","status":"pending"},{"leg_id":"leg_2","agent_id":"lumo-hotels","agent_display_name":"Lumo Hotels","status":"pending"}]}}"#
        guard case let .compoundDispatch(payload) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .compoundDispatch")
        }
        XCTAssertEqual(payload.legs.count, 1)
        XCTAssertEqual(payload.legs.first?.leg_id, "leg_1")
    }

    func test_parseFrame_compoundDispatch_unknownStatus_fallsBackToManualReview() {
        // Mirrors web's normalizeDispatchStatus fallback.
        let line = #"data: {"type":"assistant_compound_dispatch","value":{"kind":"assistant_compound_dispatch","compound_transaction_id":"ct_x","legs":[{"leg_id":"leg_1","agent_id":"lumo-flights","agent_display_name":"Lumo Flights","description":"Flight","status":"unknown_future_status"}]}}"#
        guard case let .compoundDispatch(payload) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .compoundDispatch")
        }
        XCTAssertEqual(payload.legs.first?.status, .manual_review)
    }

    // MARK: - 2. Leg-status frame parse (per-compound stream)

    func test_parseLegStatusFrame_decodesLegIDAndStatus() {
        // serializeLegStatusSse format from
        // apps/web/lib/sse/leg-status.ts. iOS only needs leg_id + status.
        let payload = #"{"leg_id":"leg_2","transaction_id":"ct_x","agent_id":"lumo-hotels","capability_id":"hotel_book","status":"committed","timestamp":"2026-05-01T17:00:00Z"}"#
        let result = CompoundStreamService.parseLegStatusFrame(payload)
        XCTAssertEqual(result, CompoundLegStatusUpdate(leg_id: "leg_2", status: .committed))
    }

    func test_parseLegStatusFrame_returnsNil_onEmptyLegID() {
        let payload = #"{"leg_id":"","status":"committed"}"#
        XCTAssertNil(CompoundStreamService.parseLegStatusFrame(payload))
    }

    func test_parseLegStatusFrame_returnsNil_onUnknownStatus() {
        // Conservative iOS-side strictness: unknown statuses on
        // the per-compound stream drop rather than falling back.
        // The strip keeps the previous status, which is a safer
        // visual default than blindly mapping to manual_review.
        let payload = #"{"leg_id":"leg_2","status":"frobnicated"}"#
        XCTAssertNil(CompoundStreamService.parseLegStatusFrame(payload))
    }

    func test_parseLegStatusFrame_returnsNil_onMalformedJSON() {
        XCTAssertNil(CompoundStreamService.parseLegStatusFrame("{not json"))
    }

    // MARK: - 3. Render rule + settled

    func test_compoundDispatchFor_returnsPayload_evenWithLaterUserMessage() {
        // Like summary cards (and unlike chips/selections),
        // compound strips stay visible after the user moves on.
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Dispatching…", status: .delivered)
        let user = ChatMessage(role: .user, text: "ok", status: .sent)
        let dispatch = makeDispatch(legs: [
            ("leg_1", "lumo-flights", .in_flight),
            ("leg_2", "lumo-hotels", .pending),
        ])
        vm._seedForTest(
            messages: [assistant, user],
            compoundDispatches: [assistant.id: dispatch]
        )

        XCTAssertEqual(vm.compoundDispatch(for: assistant)?.compound_transaction_id, "ct_test")
        XCTAssertNil(vm.compoundDispatch(for: user))
    }

    func test_compoundSettled_falseUntilAllLegsTerminal() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(role: .assistant, text: "Dispatching…", status: .delivered)
        let dispatch = makeDispatch(legs: [
            ("leg_1", "lumo-flights", .pending),
            ("leg_2", "lumo-hotels", .pending),
        ])
        vm._seedForTest(
            messages: [assistant],
            compoundDispatches: [assistant.id: dispatch]
        )

        XCTAssertFalse(vm.compoundSettled(dispatch))

        // Only one leg terminal — still not settled.
        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .committed),
            compoundID: dispatch.compound_transaction_id
        )
        XCTAssertFalse(vm.compoundSettled(dispatch))

        // Both legs terminal — settled.
        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_2", status: .committed),
            compoundID: dispatch.compound_transaction_id
        )
        XCTAssertTrue(vm.compoundSettled(dispatch))
    }

    func test_compoundLegStatus_overridesWinOverDispatchInitial() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let dispatch = makeDispatch(legs: [
            ("leg_1", "lumo-flights", .pending),
        ])
        let assistant = ChatMessage(role: .assistant, text: "Dispatching…", status: .delivered)
        vm._seedForTest(
            messages: [assistant],
            compoundDispatches: [assistant.id: dispatch]
        )

        XCTAssertEqual(
            vm.compoundLegStatus(compoundID: "ct_test", legID: "leg_1", fallback: .pending),
            .pending
        )

        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .in_flight),
            compoundID: "ct_test"
        )
        XCTAssertEqual(
            vm.compoundLegStatus(compoundID: "ct_test", legID: "leg_1", fallback: .pending),
            .in_flight
        )

        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .committed),
            compoundID: "ct_test"
        )
        XCTAssertEqual(
            vm.compoundLegStatus(compoundID: "ct_test", legID: "leg_1", fallback: .pending),
            .committed
        )
    }

    // MARK: - 4. Status enum invariants

    func test_terminalStatuses_matchWebSet() {
        // Mirrors apps/web/components/CompoundLegStrip.tsx
        // TERMINAL_STATUSES exactly. If web changes, iOS must.
        let terminal = CompoundLegStatus.allCases.filter { $0.isTerminal }
        XCTAssertEqual(
            Set(terminal.map { $0.rawValue }),
            Set(["committed", "failed", "rolled_back", "rollback_failed", "manual_review"])
        )
    }

    func test_pulsingStatuses_matchWebGate() {
        // Web's `status === "in_flight" || status === "rollback_pending"`.
        let pulsing = CompoundLegStatus.allCases.filter { $0.isPulsing }
        XCTAssertEqual(
            Set(pulsing.map { $0.rawValue }),
            Set(["in_flight", "rollback_pending"])
        )
    }

    func test_statusLabel_replacesUnderscoreWithSpace() {
        // Mirrors web's `status.replace(/_/g, " ")`.
        XCTAssertEqual(CompoundLegStatus.in_flight.label, "in flight")
        XCTAssertEqual(CompoundLegStatus.rollback_pending.label, "rollback pending")
        XCTAssertEqual(CompoundLegStatus.manual_review.label, "manual review")
        XCTAssertEqual(CompoundLegStatus.pending.label, "pending")
    }

    func test_glyph_matchesWebSubstringRules() {
        XCTAssertEqual(CompoundDispatchHelpers.glyph(for: "lumo-flights"), "✈")
        XCTAssertEqual(CompoundDispatchHelpers.glyph(for: "lumo-hotels"), "⌂")
        XCTAssertEqual(CompoundDispatchHelpers.glyph(for: "lumo-restaurants"), "◆")
        XCTAssertEqual(CompoundDispatchHelpers.glyph(for: "lumo-food"), "◆")
        // Substring match — "flight-aggregator" still picks ✈.
        XCTAssertEqual(CompoundDispatchHelpers.glyph(for: "flight-aggregator"), "✈")
    }

    // MARK: - Helpers

    private func makeDispatch(
        compoundID: String = "ct_test",
        legs: [(leg_id: String, agent_id: String, status: CompoundLegStatus)]
    ) -> CompoundDispatchPayload {
        CompoundDispatchPayload(
            kind: "assistant_compound_dispatch",
            compound_transaction_id: compoundID,
            legs: legs.map { entry in
                CompoundLeg(
                    leg_id: entry.leg_id,
                    agent_id: entry.agent_id,
                    agent_display_name: "Lumo \(entry.agent_id.replacingOccurrences(of: "lumo-", with: "").capitalized)",
                    description: "Booking \(entry.agent_id)",
                    status: entry.status
                )
            }
        )
    }
}
