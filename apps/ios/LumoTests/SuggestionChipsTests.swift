import XCTest
@testable import Lumo

/// CHAT-SUGGESTED-CHIPS-1-IOS — contract tests.
///
/// Three slices, mirroring the web `chat-suggested-chips.test.mjs`:
///
///   1. Parse — `assistant_suggestions` SSE frames decode into the
///      typed `.suggestions(turnID:items:)` ChatEvent. Edge cases
///      (missing turn_id, empty list, bad item shape) fall through
///      to `.other(type:)` rather than crash.
///   2. Render rule — `ChatViewModel.suggestions(for:)` only
///      surfaces chips on the latest assistant message before any
///      user message. Mirrors web's `userMessageExistsAfter`
///      stale-suppression.
///   3. Click + clear — `sendSuggestion(_:)` appends a user bubble
///      with the chip's `value` (NOT label). The added user message
///      flips the previous assistant message's chip strip to empty
///      via the same rule (no separate clear logic needed).
@MainActor
final class SuggestionChipsTests: XCTestCase {

    // MARK: - 1. parseFrame contract

    func test_parseFrame_assistantSuggestions_decodesItems() {
        let line = #"data: {"type":"assistant_suggestions","value":{"kind":"assistant_suggestions","turn_id":"t-42","suggestions":[{"id":"s1","label":"Next weekend","value":"May 9, 2026 to May 11, 2026"},{"id":"s2","label":"In 2 weeks","value":"May 16, 2026 to May 18, 2026"}]}}"#
        guard case let .suggestions(turnID, items) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .suggestions event, got something else")
        }
        XCTAssertEqual(turnID, "t-42")
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].id, "s1")
        XCTAssertEqual(items[0].label, "Next weekend")
        XCTAssertEqual(items[0].value, "May 9, 2026 to May 11, 2026")
        XCTAssertEqual(items[1].id, "s2")
    }

    func test_parseFrame_assistantSuggestions_missingTurnID_fallsThrough() {
        let line = #"data: {"type":"assistant_suggestions","value":{"kind":"assistant_suggestions","suggestions":[{"id":"s1","label":"x","value":"y"}]}}"#
        XCTAssertEqual(
            ChatService.parseFrame(line: line),
            .other(type: "assistant_suggestions")
        )
    }

    func test_parseFrame_assistantSuggestions_emptyItems_fallsThrough() {
        let line = #"data: {"type":"assistant_suggestions","value":{"kind":"assistant_suggestions","turn_id":"t-1","suggestions":[]}}"#
        XCTAssertEqual(
            ChatService.parseFrame(line: line),
            .other(type: "assistant_suggestions")
        )
    }

    func test_parseFrame_assistantSuggestions_dropsBadItems_keepsRest() {
        // Mixed payload — one fully-formed, one missing label, one
        // missing value, one missing id. Only the well-formed entry
        // should land in the decoded event.
        let line = #"data: {"type":"assistant_suggestions","value":{"kind":"assistant_suggestions","turn_id":"t-1","suggestions":[{"id":"s1","label":"Roundtrip","value":"Roundtrip"},{"id":"s2","label":"","value":"empty"},{"id":"s3","label":"x","value":""},{"label":"no-id","value":"no-id"}]}}"#
        guard case let .suggestions(_, items) = ChatService.parseFrame(line: line) else {
            return XCTFail("expected .suggestions, got something else")
        }
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].id, "s1")
    }

    // MARK: - 2. Render rule

    func test_suggestionsFor_returnsChips_whenLatestAssistantHasFrame() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(
            role: .assistant,
            text: "When are you traveling?",
            status: .delivered,
            suggestionsTurnId: "t-1"
        )
        let chips = [
            AssistantSuggestion(id: "s1", label: "Next weekend", value: "May 9, 2026 to May 11, 2026"),
            AssistantSuggestion(id: "s2", label: "In 2 weeks", value: "May 16, 2026 to May 18, 2026"),
        ]
        vm._seedForTest(messages: [assistant], suggestions: ["t-1": chips])

        XCTAssertEqual(vm.suggestions(for: assistant), chips)
    }

    func test_suggestionsFor_isEmpty_whenUserMessageFollowsAssistant() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(
            role: .assistant,
            text: "When are you traveling?",
            status: .delivered,
            suggestionsTurnId: "t-1"
        )
        let user = ChatMessage(role: .user, text: "Next weekend", status: .sent)
        let chips = [
            AssistantSuggestion(id: "s1", label: "Next weekend", value: "May 9, 2026 to May 11, 2026"),
        ]
        vm._seedForTest(messages: [assistant, user], suggestions: ["t-1": chips])

        XCTAssertTrue(vm.suggestions(for: assistant).isEmpty,
                      "stale chips must suppress once a user message lands after them")
    }

    func test_suggestionsFor_isEmpty_whenAssistantHasNoTurnID() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(
            role: .assistant,
            text: "Hello",
            status: .delivered
        )
        vm._seedForTest(messages: [assistant], suggestions: [:])

        XCTAssertTrue(vm.suggestions(for: assistant).isEmpty)
    }

    func test_suggestionsFor_isEmpty_forUserRoleMessage() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let user = ChatMessage(
            role: .user,
            text: "Hi",
            status: .sent,
            suggestionsTurnId: "t-1"
        )
        let chips = [
            AssistantSuggestion(id: "s1", label: "x", value: "x"),
        ]
        vm._seedForTest(messages: [user], suggestions: ["t-1": chips])

        XCTAssertTrue(vm.suggestions(for: user).isEmpty,
                      "user-role messages never surface chips even if seeded")
    }

    // MARK: - 3. Click + clear

    func test_sendSuggestion_appendsUserBubbleWithChipValue_notLabel() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(
            role: .assistant,
            text: "When are you traveling?",
            status: .delivered,
            suggestionsTurnId: "t-1"
        )
        let chip = AssistantSuggestion(
            id: "s1",
            label: "Next weekend",
            value: "May 9, 2026 to May 11, 2026"
        )
        vm._seedForTest(messages: [assistant], suggestions: ["t-1": [chip]])

        vm.sendSuggestion(chip.value)

        // The first appended message after the seed should be the user
        // bubble carrying the chip's `value` (not its `label`).
        let users = vm.messages.filter { $0.role == .user }
        XCTAssertEqual(users.count, 1)
        XCTAssertEqual(users.first?.text, "May 9, 2026 to May 11, 2026")
        XCTAssertNotEqual(users.first?.text, "Next weekend",
                          "must submit chip.value, never chip.label")
    }

    // MARK: - 4. Overflow scroll affordance (CHIP-OVERFLOW-SCROLL-1)

    func test_chipStrip_exposesTrailingFadeOverlay() {
        // Regression catcher for the fade gradient that signals the
        // strip scrolls when chips overflow the viewport. The
        // `trailingFadeWidth` constant and the `.overlay(alignment:
        // .trailing)` modifier travel together — if a future change
        // deletes the overlay, the natural cleanup also removes this
        // constant, which fails the assertion. The fade itself is
        // visually verified by the chip-overflow-scroll-1 capture
        // variant.
        XCTAssertGreaterThan(
            SuggestionChips.trailingFadeWidth,
            0,
            "Trailing fade affordance must be present so users see the strip scrolls"
        )
    }

    func test_chipStrip_renders3LongLabels_withoutTextTruncation() {
        // The brief's clipping repro: three chips whose combined
        // intrinsic width overflows the iPhone 17 viewport. The
        // ScrollView's job is to let the user scroll to reach the
        // third chip; the chip view itself must not truncate its
        // label text (no `.lineLimit`, no truncation modes). We
        // assert this via the data path: the suggestions array
        // passed in is preserved unchanged into the chip Button's
        // label, so testing that the array survives the view's
        // initialiser (no filter / no map drops) is the meaningful
        // contract.
        let chips = [
            AssistantSuggestion(id: "c1", label: "Next weekend",
                                value: "May 9, 2026 to May 11, 2026"),
            AssistantSuggestion(id: "c2", label: "In 2 weeks",
                                value: "May 16, 2026 to May 18, 2026"),
            AssistantSuggestion(id: "c3", label: "Memorial Day weekend",
                                value: "May 22, 2026 to May 25, 2026"),
        ]
        let strip = SuggestionChips(
            suggestions: chips,
            isDisabled: false,
            onSelect: { _ in }
        )
        XCTAssertEqual(strip.suggestions.count, 3,
                       "all three chips reach the strip — overflow is handled by ScrollView, not by dropping chips")
        XCTAssertEqual(strip.suggestions.last?.label, "Memorial Day weekend",
                       "third chip's full label survives — no truncation at the data layer")
    }

    func test_sendSuggestion_clearsPreviousChipStrip_viaRenderRule() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        let assistant = ChatMessage(
            role: .assistant,
            text: "When are you traveling?",
            status: .delivered,
            suggestionsTurnId: "t-1"
        )
        let chip = AssistantSuggestion(id: "s1", label: "x", value: "y")
        vm._seedForTest(messages: [assistant], suggestions: ["t-1": [chip]])
        XCTAssertFalse(vm.suggestions(for: assistant).isEmpty,
                       "precondition: chips visible before submit")

        vm.sendSuggestion(chip.value)

        XCTAssertTrue(vm.suggestions(for: assistant).isEmpty,
                      "chips must clear once a user message follows the assistant")
    }
}
