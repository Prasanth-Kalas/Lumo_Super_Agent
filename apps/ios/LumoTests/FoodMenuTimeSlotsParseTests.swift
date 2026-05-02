import XCTest
@testable import Lumo

/// IOS-FOOD-MENU-TIME-SLOTS-PARSE-1 — contract tests.
///
/// Parser-only lane. Until web ships
/// IOS-SELECT-CLICKABLE-FOOD-1 / -RESTAURANT-1, the SwiftUI cards
/// for these kinds aren't mounted — but ChatService.parseFrame
/// already produces the typed payloads so the wiring is ready when
/// the cards land.
///
/// Four slices per the brief:
///
///   1. Parse — `food_menu` selection frame decodes into a typed
///      `.selection(.foodMenu(FoodMenuPayload))` event.
///   2. Parse — `time_slots` selection frame decodes into
///      `.selection(.timeSlots(TimeSlotsPayload))`.
///   3. Malformed-frame fallthrough — known kind with bad payload
///      now produces `.selection(.malformed(kind:reason:))` (NOT
///      `.unsupported(kind:)` anymore — this is the new
///      distinction introduced by the lane).
///   4. Backwards-compat — `.unsupported(kind:)` still produced for
///      genuinely-unknown kinds (forward-compat for whatever web
///      ships next), and `sameKind(as:)` continues to dedupe by
///      kind across all five enum cases.
@MainActor
final class FoodMenuTimeSlotsParseTests: XCTestCase {

    // MARK: - 1. food_menu parse

    func test_parseFrame_foodMenu_decodesTypedPayload() {
        let line = #"data: {"type":"selection","value":{"kind":"food_menu","payload":{"restaurant_id":"r-burger-1","restaurant_name":"The Slider","is_open":true,"menu":[{"item_id":"i-1","name":"Cheeseburger","description":"Classic with cheddar","unit_price_cents":1295,"category":"Burgers"},{"item_id":"i-2","name":"Fries","unit_price_cents":495}]}}}"#
        guard case let .selection(.foodMenu(payload)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.foodMenu(...)); got something else")
        }
        XCTAssertEqual(payload.restaurant_id, "r-burger-1")
        XCTAssertEqual(payload.restaurant_name, "The Slider")
        XCTAssertEqual(payload.is_open, true)
        XCTAssertEqual(payload.menu.count, 2)
        XCTAssertEqual(payload.menu[0].item_id, "i-1")
        XCTAssertEqual(payload.menu[0].name, "Cheeseburger")
        XCTAssertEqual(payload.menu[0].description, "Classic with cheddar")
        XCTAssertEqual(payload.menu[0].unit_price_cents, 1295)
        XCTAssertEqual(payload.menu[0].category, "Burgers")
        // Second item exercises optional fields absent.
        XCTAssertEqual(payload.menu[1].item_id, "i-2")
        XCTAssertNil(payload.menu[1].description)
        XCTAssertNil(payload.menu[1].category)
    }

    func test_parseFrame_foodMenu_dropsMalformedItems_keepsRest() {
        // Mixed payload — one fully-formed, one missing item_id, one
        // missing unit_price_cents. Only the well-formed entry should
        // land in the decoded payload (matches web's `payload.menu ?? []`
        // posture — drop bad rows rather than fail the whole card).
        let line = #"data: {"type":"selection","value":{"kind":"food_menu","payload":{"restaurant_id":"r-1","restaurant_name":"X","menu":[{"item_id":"ok","name":"Good","unit_price_cents":500},{"name":"NoID","unit_price_cents":300},{"item_id":"no-price","name":"NoPrice"}]}}}"#
        guard case let .selection(.foodMenu(payload)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.foodMenu(...))")
        }
        XCTAssertEqual(payload.menu.count, 1)
        XCTAssertEqual(payload.menu.first?.item_id, "ok")
    }

    func test_parseFrame_foodMenu_emptyMenu_decodesSuccessfully() {
        // An empty menu is a valid state (restaurant has no items
        // listed yet). Distinct from missing — missing produces
        // `.malformed`; empty is just a card with zero rows.
        let line = #"data: {"type":"selection","value":{"kind":"food_menu","payload":{"restaurant_id":"r-1","restaurant_name":"Empty Cafe","menu":[]}}}"#
        guard case let .selection(.foodMenu(payload)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.foodMenu(...))")
        }
        XCTAssertEqual(payload.restaurant_name, "Empty Cafe")
        XCTAssertTrue(payload.menu.isEmpty)
    }

    // MARK: - 2. time_slots parse

    func test_parseFrame_timeSlots_decodesTypedPayload() {
        let line = #"data: {"type":"selection","value":{"kind":"time_slots","payload":{"restaurant_id":"r-1","restaurant_name":"Sushi Place","date":"2026-05-15","party_size":2,"slots":[{"slot_id":"s-7pm","starts_at":"2026-05-15T19:00:00-07:00","party_size":2,"table_type":"window","deposit_amount":"25.00","deposit_currency":"USD"},{"slot_id":"s-730pm","starts_at":"2026-05-15T19:30:00-07:00","party_size":2}]}}}"#
        guard case let .selection(.timeSlots(payload)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.timeSlots(...)); got something else")
        }
        XCTAssertEqual(payload.restaurant_id, "r-1")
        XCTAssertEqual(payload.restaurant_name, "Sushi Place")
        XCTAssertEqual(payload.date, "2026-05-15")
        XCTAssertEqual(payload.party_size, 2)
        XCTAssertEqual(payload.slots.count, 2)
        XCTAssertEqual(payload.slots[0].slot_id, "s-7pm")
        XCTAssertEqual(payload.slots[0].starts_at, "2026-05-15T19:00:00-07:00")
        XCTAssertEqual(payload.slots[0].deposit_amount, "25.00")
        XCTAssertEqual(payload.slots[0].deposit_currency, "USD")
        XCTAssertEqual(payload.slots[0].table_type, "window")
        // Second slot exercises optional fields absent.
        XCTAssertNil(payload.slots[1].deposit_amount)
        XCTAssertNil(payload.slots[1].table_type)
    }

    func test_parseFrame_timeSlots_dropsMalformedSlots_keepsRest() {
        let line = #"data: {"type":"selection","value":{"kind":"time_slots","payload":{"restaurant_id":"r-1","slots":[{"slot_id":"ok","starts_at":"2026-05-15T19:00:00Z","party_size":2},{"starts_at":"2026-05-15T19:30:00Z","party_size":2},{"slot_id":"no-start","party_size":2}]}}}"#
        guard case let .selection(.timeSlots(payload)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.timeSlots(...))")
        }
        XCTAssertEqual(payload.slots.count, 1)
        XCTAssertEqual(payload.slots.first?.slot_id, "ok")
    }

    // MARK: - 3. Malformed payload → .malformed(kind:reason:)

    func test_parseFrame_foodMenu_missingRequiredEnvelope_isMalformed() {
        // restaurant_id present but restaurant_name missing — envelope
        // unusable. Should produce `.malformed("food_menu", reason)`,
        // NOT `.unsupported("food_menu")` (that's reserved for kinds
        // we don't recognise yet) and NOT `.other(type:)` (which
        // would lose the kind context).
        let line = #"data: {"type":"selection","value":{"kind":"food_menu","payload":{"restaurant_id":"r-1","menu":[]}}}"#
        guard case let .selection(.malformed(kind, reason)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.malformed(...)); got something else")
        }
        XCTAssertEqual(kind, "food_menu", "malformed must preserve the kind context for callers")
        XCTAssertFalse(reason.isEmpty, "malformed must surface a reason string")
    }

    func test_parseFrame_timeSlots_missingSlotsArray_isMalformed() {
        let line = #"data: {"type":"selection","value":{"kind":"time_slots","payload":{"restaurant_id":"r-1"}}}"#
        guard case let .selection(.malformed(kind, _)) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .selection(.malformed(...))")
        }
        XCTAssertEqual(kind, "time_slots")
    }

    // MARK: - 4. Backwards-compat — unknown kind still .unsupported

    func test_parseFrame_unknownKind_stillFallsThroughToUnsupported() {
        // Forward-compat invariant — when web ships a new kind iOS
        // doesn't know, it should round-trip via `.unsupported`, NOT
        // `.malformed`. The distinction matters for log routing
        // (unknown kind = upgrade iOS; malformed = bug somewhere on
        // the wire).
        let line = #"data: {"type":"selection","value":{"kind":"future_kind_we_dont_know","payload":{"anything":"goes"}}}"#
        guard case let .selection(.unsupported(kind)) = ChatService.parseFrame(line: line) else {
            return XCTFail("unknown kind must round-trip via .unsupported")
        }
        XCTAssertEqual(kind, "future_kind_we_dont_know")
    }

    func test_sameKind_dedupesAcrossAllFiveCases() {
        let foodA = InteractiveSelection.foodMenu(FoodMenuPayload(
            restaurant_id: "a", restaurant_name: "A", is_open: nil, menu: []
        ))
        let foodB = InteractiveSelection.foodMenu(FoodMenuPayload(
            restaurant_id: "b", restaurant_name: "B", is_open: nil, menu: []
        ))
        XCTAssertTrue(foodA.sameKind(as: foodB), "food_menu dedupes across different restaurant_ids — latest wins")

        let slotsA = InteractiveSelection.timeSlots(TimeSlotsPayload(
            restaurant_id: "a", restaurant_name: nil, date: nil, party_size: nil, slots: []
        ))
        XCTAssertFalse(foodA.sameKind(as: slotsA),
                       "different kinds never dedupe with each other")

        let unsupportedA = InteractiveSelection.unsupported(kind: "future_kind")
        let unsupportedB = InteractiveSelection.unsupported(kind: "future_kind")
        let unsupportedC = InteractiveSelection.unsupported(kind: "another_kind")
        XCTAssertTrue(unsupportedA.sameKind(as: unsupportedB))
        XCTAssertFalse(unsupportedA.sameKind(as: unsupportedC),
                       ".unsupported dedupes per-kind so two different unknowns can co-exist")

        let malformedA = InteractiveSelection.malformed(kind: "food_menu", reason: "x")
        let malformedB = InteractiveSelection.malformed(kind: "food_menu", reason: "y")
        XCTAssertTrue(malformedA.sameKind(as: malformedB),
                      ".malformed dedupes by kind ignoring reason — latest re-emit replaces")
    }
}
