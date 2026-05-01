import XCTest
@testable import Lumo

/// IOS-COMPOUND-ROLLBACK-VIEW-1 — contract tests for the rollback
/// cascade compute + the dispatch-frame depends_on plumbing.
///
/// Five slices:
///
///   1. Frame decode — depends_on flows through ChatService.parseFrame
///      from the assistant_compound_dispatch SSE shape; older frames
///      without the field decode as [].
///
///   2. cascade(failedLegID:legs:) — BFS closure correctness across
///      serial chains, fan-out branches, fan-in joins, and isolated
///      legs.
///
///   3. rollbackCascade(legs:statuses:) — convenience aggregator
///      excludes the failed roots, unions across multiple failures,
///      and reads the override layer (not the dispatch payload's
///      stale initial).
///
///   4. Detail panel rollback-plan copy — the user-facing
///      "the hotel and the dinner reservation are being rolled back"
///      string groups dependents by live status correctly.
///
///   5. Backwards compat — empty depends_on default keeps older
///      callers working.
@MainActor
final class CompoundRollbackViewTests: XCTestCase {

    // MARK: - 1. Frame decode

    func test_parseFrame_compoundDispatch_capturesDependsOn() {
        let line = #"data: {"type":"assistant_compound_dispatch","value":{"kind":"assistant_compound_dispatch","compound_transaction_id":"ct_v","legs":[{"leg_id":"leg_flight","agent_id":"lumo-flights","agent_display_name":"Lumo Flights","description":"flight","status":"committed","depends_on":[]},{"leg_id":"leg_hotel","agent_id":"lumo-hotels","agent_display_name":"Lumo Hotels","description":"hotel","status":"in_flight","depends_on":["leg_flight"]},{"leg_id":"leg_dinner","agent_id":"lumo-restaurants","agent_display_name":"Lumo Restaurants","description":"dinner","status":"pending","depends_on":["leg_hotel"]}]}}"#
        guard case let .compoundDispatch(payload) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .compoundDispatch")
        }
        XCTAssertEqual(payload.legs[0].depends_on, [])
        XCTAssertEqual(payload.legs[1].depends_on, ["leg_flight"])
        XCTAssertEqual(payload.legs[2].depends_on, ["leg_hotel"])
    }

    func test_parseFrame_compoundDispatch_omittedDependsOn_defaultsToEmpty() {
        // Older frames without depends_on still decode — the
        // cascade compute treats every leg as a root.
        let line = #"data: {"type":"assistant_compound_dispatch","value":{"kind":"assistant_compound_dispatch","compound_transaction_id":"ct_v","legs":[{"leg_id":"leg_a","agent_id":"lumo-flights","agent_display_name":"Lumo Flights","description":"x","status":"pending"}]}}"#
        guard case let .compoundDispatch(payload) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .compoundDispatch")
        }
        XCTAssertEqual(payload.legs[0].depends_on, [])
    }

    // MARK: - 2. cascade(failedLegID:legs:)

    func test_cascade_serialChain_includesAllDownstream() {
        // flight → hotel → dinner. Failing flight cascades both.
        let legs = serialChain()
        let result = CompoundDispatchHelpers.cascade(failedLegID: "leg_flight", legs: legs)
        XCTAssertEqual(result, ["leg_hotel", "leg_dinner"])
    }

    func test_cascade_isExclusiveOfFailedLeg() {
        // Saga's "cause" leg never appears in its own cascade —
        // matches the runner's compensation flow.
        let legs = serialChain()
        let result = CompoundDispatchHelpers.cascade(failedLegID: "leg_flight", legs: legs)
        XCTAssertFalse(result.contains("leg_flight"))
    }

    func test_cascade_fanOut_includesAllSiblingsThatDependOnRoot() {
        // flight → hotel; flight → carRental. Failing flight cascades
        // both downstream legs (parallel branches).
        let legs = [
            CompoundLeg(leg_id: "leg_flight",  agent_id: "lumo-flights", agent_display_name: "Lumo Flights",  description: "flight",  status: .pending, depends_on: []),
            CompoundLeg(leg_id: "leg_hotel",   agent_id: "lumo-hotels",  agent_display_name: "Lumo Hotels",   description: "hotel",   status: .pending, depends_on: ["leg_flight"]),
            CompoundLeg(leg_id: "leg_car",     agent_id: "lumo-cars",    agent_display_name: "Lumo Cars",     description: "car",     status: .pending, depends_on: ["leg_flight"]),
        ]
        let result = CompoundDispatchHelpers.cascade(failedLegID: "leg_flight", legs: legs)
        XCTAssertEqual(result, ["leg_hotel", "leg_car"])
    }

    func test_cascade_fanIn_isolatedSiblingNotIncluded() {
        // Two roots (flight, train) both feed into hotel. Failing
        // flight cascades hotel + dinner but NOT train (train is
        // an independent root).
        let legs = [
            CompoundLeg(leg_id: "leg_flight", agent_id: "lumo-flights", agent_display_name: "Lumo Flights", description: "flight", status: .pending, depends_on: []),
            CompoundLeg(leg_id: "leg_train",  agent_id: "lumo-trains",  agent_display_name: "Lumo Trains",  description: "train",  status: .pending, depends_on: []),
            CompoundLeg(leg_id: "leg_hotel",  agent_id: "lumo-hotels",  agent_display_name: "Lumo Hotels",  description: "hotel",  status: .pending, depends_on: ["leg_flight", "leg_train"]),
            CompoundLeg(leg_id: "leg_dinner", agent_id: "lumo-restaurants", agent_display_name: "Lumo Restaurants", description: "dinner", status: .pending, depends_on: ["leg_hotel"]),
        ]
        let result = CompoundDispatchHelpers.cascade(failedLegID: "leg_flight", legs: legs)
        XCTAssertEqual(result, ["leg_hotel", "leg_dinner"])
        XCTAssertFalse(result.contains("leg_train"))
    }

    func test_cascade_isolatedLeg_returnsEmpty() {
        // Failed leg has no dependents → empty cascade.
        let legs = [
            CompoundLeg(leg_id: "leg_a", agent_id: "lumo-flights", agent_display_name: "Lumo Flights", description: "a", status: .failed, depends_on: []),
        ]
        XCTAssertEqual(
            CompoundDispatchHelpers.cascade(failedLegID: "leg_a", legs: legs),
            []
        )
    }

    // MARK: - 3. rollbackCascade aggregator

    func test_rollbackCascade_unionsAcrossMultipleFailures() {
        // Two independent serial chains; both roots fail.
        let legs = [
            CompoundLeg(leg_id: "f1", agent_id: "lumo-flights", agent_display_name: "F1", description: "f1", status: .failed, depends_on: []),
            CompoundLeg(leg_id: "h1", agent_id: "lumo-hotels", agent_display_name: "H1", description: "h1", status: .pending, depends_on: ["f1"]),
            CompoundLeg(leg_id: "f2", agent_id: "lumo-flights", agent_display_name: "F2", description: "f2", status: .failed, depends_on: []),
            CompoundLeg(leg_id: "h2", agent_id: "lumo-hotels", agent_display_name: "H2", description: "h2", status: .pending, depends_on: ["f2"]),
        ]
        let overrides: [String: CompoundLegStatus] = [
            "f1": .failed,
            "f2": .failed,
        ]
        let result = CompoundDispatchHelpers.rollbackCascade(legs: legs, statuses: overrides)
        XCTAssertEqual(result, ["h1", "h2"])
    }

    func test_rollbackCascade_excludesFailedRootsThemselves() {
        let legs = serialChain()
        let overrides: [String: CompoundLegStatus] = [
            "leg_flight": .failed,
            "leg_hotel": .rollback_pending,
            "leg_dinner": .pending,
        ]
        let result = CompoundDispatchHelpers.rollbackCascade(legs: legs, statuses: overrides)
        XCTAssertFalse(result.contains("leg_flight"), "the failed root is the cause, not part of its own cascade")
        XCTAssertTrue(result.contains("leg_hotel"))
        XCTAssertTrue(result.contains("leg_dinner"))
    }

    func test_rollbackCascade_readsOverrideLayer_notDispatchInitial() {
        // Dispatch initial says committed; override flips to
        // failed. Cascade must compute against the override
        // (live status), not the stale initial.
        let legs = [
            CompoundLeg(leg_id: "leg_flight", agent_id: "lumo-flights", agent_display_name: "Lumo Flights", description: "flight", status: .committed, depends_on: []),
            CompoundLeg(leg_id: "leg_hotel",  agent_id: "lumo-hotels",  agent_display_name: "Lumo Hotels",  description: "hotel",  status: .pending,    depends_on: ["leg_flight"]),
        ]
        let result = CompoundDispatchHelpers.rollbackCascade(
            legs: legs,
            statuses: ["leg_flight": .failed]
        )
        XCTAssertEqual(result, ["leg_hotel"])
    }

    // MARK: - 4. Detail panel rollback-plan copy

    func test_rollbackPlanText_groupsDependentsByLiveStatus() {
        // Mirrors the saga mid-cascade demo state: hotel
        // currently rolling back, dinner already rolled back,
        // car_rental escalated to manual review.
        let legs: [CompoundLeg] = [
            CompoundLeg(leg_id: "leg_flight",  agent_id: "lumo-flights",     agent_display_name: "Lumo Flights",     description: "flight",  status: .failed,           depends_on: []),
            CompoundLeg(leg_id: "leg_hotel",   agent_id: "lumo-hotels",      agent_display_name: "Lumo Hotels",      description: "hotel",   status: .rollback_pending, depends_on: ["leg_flight"]),
            CompoundLeg(leg_id: "leg_dinner",  agent_id: "lumo-restaurants", agent_display_name: "Lumo Restaurants", description: "dinner",  status: .rolled_back,      depends_on: ["leg_flight"]),
            CompoundLeg(leg_id: "leg_car",     agent_id: "lumo-cars",        agent_display_name: "Lumo Cars",        description: "car",     status: .manual_review,    depends_on: ["leg_flight"]),
        ]
        let detail = CompoundLegDetailContent(
            leg: legs[0],
            status: .failed,
            metadata: .empty,
            settled: false,
            allLegs: legs,
            overrides: [
                "leg_hotel":  .rollback_pending,
                "leg_dinner": .rolled_back,
                "leg_car":    .manual_review,
            ]
        )
        let plan = detail.rollbackPlanText()
        // "the car" isn't a recognized humanized name today (no
        // "rental" agent_id keyword); it should still appear with
        // some readable form. The mid-cascade copy should mention
        // all three dependents distributed across the right
        // grammar groups.
        XCTAssertTrue(plan.contains("being rolled back"), "copy: \(plan)")
        XCTAssertTrue(plan.contains("already rolled back"), "copy: \(plan)")
        XCTAssertTrue(plan.contains("manual review"), "copy: \(plan)")
        // joinNames sentence-cases the leading name in each
        // grouped sentence ("The hotel is being rolled back."),
        // so assertions match the capitalized form the user
        // actually sees.
        XCTAssertTrue(plan.contains("The hotel"), "copy: \(plan)")
        XCTAssertTrue(plan.contains("The dinner reservation"), "copy: \(plan)")
    }

    func test_rollbackPlanText_isEmpty_whenLegHasNoDependents() {
        let legs = [
            CompoundLeg(leg_id: "leg_only", agent_id: "lumo-flights", agent_display_name: "Lumo Flights", description: "only", status: .failed, depends_on: []),
        ]
        let detail = CompoundLegDetailContent(
            leg: legs[0],
            status: .failed,
            metadata: .empty,
            settled: false,
            allLegs: legs,
            overrides: [:]
        )
        XCTAssertEqual(detail.rollbackPlanText(), "")
    }

    func test_rollbackPlanText_treatsPreRollbackDependentsAsRollingBack() {
        // Saga hasn't started compensation yet — dependents still
        // read as `committed` in the override layer. Copy should
        // describe them as "are being rolled back" since that's
        // the saga's intent (the runner will get to them shortly).
        let legs: [CompoundLeg] = [
            CompoundLeg(leg_id: "leg_flight", agent_id: "lumo-flights",  agent_display_name: "Lumo Flights",  description: "flight", status: .failed,    depends_on: []),
            CompoundLeg(leg_id: "leg_hotel",  agent_id: "lumo-hotels",   agent_display_name: "Lumo Hotels",   description: "hotel",  status: .committed, depends_on: ["leg_flight"]),
        ]
        let detail = CompoundLegDetailContent(
            leg: legs[0],
            status: .failed,
            metadata: .empty,
            settled: false,
            allLegs: legs,
            overrides: ["leg_hotel": .committed]
        )
        XCTAssertTrue(detail.rollbackPlanText().contains("being rolled back"))
    }

    // MARK: - Helpers

    private func serialChain() -> [CompoundLeg] {
        [
            CompoundLeg(leg_id: "leg_flight", agent_id: "lumo-flights",     agent_display_name: "Lumo Flights",     description: "flight", status: .pending, depends_on: []),
            CompoundLeg(leg_id: "leg_hotel",  agent_id: "lumo-hotels",      agent_display_name: "Lumo Hotels",      description: "hotel",  status: .pending, depends_on: ["leg_flight"]),
            CompoundLeg(leg_id: "leg_dinner", agent_id: "lumo-restaurants", agent_display_name: "Lumo Restaurants", description: "dinner", status: .pending, depends_on: ["leg_hotel"]),
        ]
    }
}
