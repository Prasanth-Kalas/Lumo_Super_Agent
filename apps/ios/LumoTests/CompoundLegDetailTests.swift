import XCTest
@testable import Lumo

/// IOS-COMPOUND-LEG-DETAIL-1 — contract tests for the tap-to-expand
/// detail panel state machine + the leg-status frame metadata
/// pass-through. Mirrors the CompoundLegStripTests pattern.
///
/// Five slices:
///
///   1. Leg-status frame metadata pass-through — provider_reference,
///      timestamp, evidence flow through the parser when present;
///      missing fields decode to nil; non-string evidence values
///      coerce to a string form rather than dropping the frame.
///
///   2. Metadata stamping on transition — applying an in_flight
///      update stamps `firstSeenInFlightAt`; subsequent in_flight
///      re-emits don't reset the stamp; provider_reference + evidence
///      land on the committed update.
///
///   3. Tap-to-expand state — toggleCompoundLegDetail flips the
///      Set<String> idempotently; multiple legs may be expanded
///      concurrently; reset() clears the set.
///
///   4. metadataFor returns .empty fallback when nothing was
///      captured for a leg, so the view always reads a value.
///
///   5. compoundLegMetadata persists across status transitions —
///      the in_flight stamp survives the committed update so the
///      "Elapsed: …" record on the detail panel stays meaningful
///      after a leg lands.
@MainActor
final class CompoundLegDetailTests: XCTestCase {

    // MARK: - 1. Frame metadata pass-through

    func test_parseLegStatusFrame_capturesProviderReferenceTimestampEvidence() {
        let payload = #"{"leg_id":"leg_1","status":"committed","timestamp":"2026-05-01T18:00:00Z","provider_reference":"DUFFEL_ord_abc","evidence":{"reason":"happy","provider_status":"OK","seats":42}}"#
        guard let update = CompoundStreamService.parseLegStatusFrame(payload) else {
            return XCTFail("expected typed update")
        }
        XCTAssertEqual(update.leg_id, "leg_1")
        XCTAssertEqual(update.status, .committed)
        XCTAssertEqual(update.timestamp, "2026-05-01T18:00:00Z")
        XCTAssertEqual(update.provider_reference, "DUFFEL_ord_abc")
        // String values pass through as-is.
        XCTAssertEqual(update.evidence?["reason"], "happy")
        XCTAssertEqual(update.evidence?["provider_status"], "OK")
        // Non-string values stringify rather than drop the frame.
        XCTAssertEqual(update.evidence?["seats"], "42")
    }

    func test_parseLegStatusFrame_omittedFields_decodeAsNil() {
        // Backwards compat: older frames without the trailing
        // metadata still decode (just with nil for the optional
        // fields).
        let payload = #"{"leg_id":"leg_1","status":"in_flight"}"#
        guard let update = CompoundStreamService.parseLegStatusFrame(payload) else {
            return XCTFail("expected typed update")
        }
        XCTAssertNil(update.timestamp)
        XCTAssertNil(update.provider_reference)
        XCTAssertNil(update.evidence)
    }

    // MARK: - 2. Metadata stamping on transition

    func test_applyUpdate_stampsFirstSeenInFlightOnTransition() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let dispatch = makeDispatch()
        vm._seedForTest(
            messages: [],
            compoundDispatches: [:],
            compoundOverrides: [dispatch.compound_transaction_id: [:]]
        )

        // Pending → no stamp yet.
        var meta = vm.compoundLegMeta(compoundID: dispatch.compound_transaction_id, legID: "leg_1")
        XCTAssertNil(meta.firstSeenInFlightAt)

        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .in_flight),
            compoundID: dispatch.compound_transaction_id
        )
        meta = vm.compoundLegMeta(compoundID: dispatch.compound_transaction_id, legID: "leg_1")
        XCTAssertNotNil(meta.firstSeenInFlightAt, "stamp on first in_flight")
    }

    func test_applyUpdate_doesNotResetFirstSeenOnReEmit() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let dispatch = makeDispatch()
        vm._seedForTest(
            messages: [],
            compoundDispatches: [:],
            compoundOverrides: [dispatch.compound_transaction_id: [:]]
        )
        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .in_flight),
            compoundID: dispatch.compound_transaction_id
        )
        let stampedFirst = vm.compoundLegMeta(compoundID: dispatch.compound_transaction_id, legID: "leg_1").firstSeenInFlightAt
        // A redundant in_flight frame must not reset the stamp.
        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .in_flight),
            compoundID: dispatch.compound_transaction_id
        )
        let stampedSecond = vm.compoundLegMeta(compoundID: dispatch.compound_transaction_id, legID: "leg_1").firstSeenInFlightAt
        XCTAssertEqual(stampedFirst, stampedSecond)
    }

    func test_applyUpdate_capturesProviderReferenceAndEvidenceOnCommit() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let dispatch = makeDispatch()
        vm._seedForTest(
            messages: [],
            compoundDispatches: [:],
            compoundOverrides: [dispatch.compound_transaction_id: [:]]
        )

        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(
                leg_id: "leg_1",
                status: .committed,
                timestamp: "2026-05-01T18:00:00Z",
                provider_reference: "DUFFEL_ord_abc",
                evidence: ["seats": "12"]
            ),
            compoundID: dispatch.compound_transaction_id
        )
        let meta = vm.compoundLegMeta(compoundID: dispatch.compound_transaction_id, legID: "leg_1")
        XCTAssertEqual(meta.provider_reference, "DUFFEL_ord_abc")
        XCTAssertEqual(meta.evidence?["seats"], "12")
    }

    func test_metadataPersists_throughCommittedAfterInFlight() {
        // The in_flight stamp survives the committed update so
        // the elapsed-time record on the detail panel remains
        // meaningful even after the leg lands.
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let dispatch = makeDispatch()
        vm._seedForTest(
            messages: [],
            compoundDispatches: [:],
            compoundOverrides: [dispatch.compound_transaction_id: [:]]
        )

        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .in_flight),
            compoundID: dispatch.compound_transaction_id
        )
        let stamped = vm.compoundLegMeta(compoundID: dispatch.compound_transaction_id, legID: "leg_1").firstSeenInFlightAt
        XCTAssertNotNil(stamped)

        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(
                leg_id: "leg_1",
                status: .committed,
                provider_reference: "REF1"
            ),
            compoundID: dispatch.compound_transaction_id
        )
        let after = vm.compoundLegMeta(compoundID: dispatch.compound_transaction_id, legID: "leg_1")
        XCTAssertEqual(after.firstSeenInFlightAt, stamped, "in_flight stamp must survive the commit")
        XCTAssertEqual(after.provider_reference, "REF1")
    }

    // MARK: - 3. Tap-to-expand state

    func test_toggleCompoundLegDetail_flipsIdempotently() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)

        XCTAssertFalse(vm.isCompoundLegDetailExpanded(legID: "leg_1"))
        vm.toggleCompoundLegDetail(legID: "leg_1")
        XCTAssertTrue(vm.isCompoundLegDetailExpanded(legID: "leg_1"))
        vm.toggleCompoundLegDetail(legID: "leg_1")
        XCTAssertFalse(vm.isCompoundLegDetailExpanded(legID: "leg_1"))
    }

    func test_toggleCompoundLegDetail_supportsConcurrentExpansions() {
        // Comparison-friendly UX: tapping leg_2 doesn't collapse leg_1.
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        vm.toggleCompoundLegDetail(legID: "leg_1")
        vm.toggleCompoundLegDetail(legID: "leg_2")
        XCTAssertTrue(vm.isCompoundLegDetailExpanded(legID: "leg_1"))
        XCTAssertTrue(vm.isCompoundLegDetailExpanded(legID: "leg_2"))
    }

    func test_reset_clearsExpandedSetAndMetadata() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        vm.toggleCompoundLegDetail(legID: "leg_1")
        vm._applyCompoundLegStatusForTest(
            CompoundLegStatusUpdate(leg_id: "leg_1", status: .committed, provider_reference: "X"),
            compoundID: "ct_1"
        )

        vm.reset()

        XCTAssertFalse(vm.isCompoundLegDetailExpanded(legID: "leg_1"))
        XCTAssertEqual(
            vm.compoundLegMeta(compoundID: "ct_1", legID: "leg_1"),
            .empty
        )
    }

    // MARK: - 4. .empty fallback for unseen legs

    func test_compoundLegMeta_returnsEmptyForUnseenLeg() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        // Nothing has been recorded for this leg — the view layer
        // should still get a usable record.
        let meta = vm.compoundLegMeta(compoundID: "ct_unseen", legID: "leg_unseen")
        XCTAssertEqual(meta, .empty)
        XCTAssertNil(meta.firstSeenInFlightAt)
        XCTAssertNil(meta.provider_reference)
        XCTAssertNil(meta.evidence)
    }

    // MARK: - 5. Seed-from-test surfaces both layers

    func test_seedForTest_acceptsCompoundMetadataAndExpandedSet() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let meta = CompoundLegMetadata(
            firstSeenInFlightAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastUpdatedAt: Date(timeIntervalSince1970: 1_700_000_010),
            provider_reference: "REF",
            evidence: ["reason": "ok"]
        )
        vm._seedForTest(
            messages: [],
            compoundMetadata: ["ct_1": ["leg_1": meta]],
            compoundExpanded: ["leg_1"]
        )

        XCTAssertEqual(vm.compoundLegMeta(compoundID: "ct_1", legID: "leg_1"), meta)
        XCTAssertTrue(vm.isCompoundLegDetailExpanded(legID: "leg_1"))
    }

    // MARK: - Helpers

    private func makeDispatch() -> CompoundDispatchPayload {
        CompoundDispatchPayload(
            kind: "assistant_compound_dispatch",
            compound_transaction_id: "ct_test",
            legs: [
                CompoundLeg(
                    leg_id: "leg_1",
                    agent_id: "lumo-flights",
                    agent_display_name: "Lumo Flights",
                    description: "Booking flight",
                    status: .pending
                )
            ]
        )
    }
}
