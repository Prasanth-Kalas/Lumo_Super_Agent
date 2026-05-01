import XCTest
@testable import Lumo

/// IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase A — composer mic↔send swap.
///
/// The trailing button on the chat composer swaps icon based on input
/// state (WhatsApp / Telegram / Signal pattern). The decision logic
/// is a pure static helper on `ChatComposerTrailingButton.Mode` so
/// it's directly testable without rendering the SwiftUI view.
///
/// Four cases per the brief:
///
///   1. text empty           → `.mic`
///   2. text non-empty       → `.send`
///   3. send tap submits + clears the input via ChatViewModel.send()
///   4. mic tap routes to the voice handler (covered by the tap-mode
///      switch in ChatView.handleTrailingTap; here we pin the pure
///      mode-pick that drives that switch)
///
/// Listening always wins over input — once the mic is open, we don't
/// want the icon flickering to send the moment a partial transcript
/// populates the text field. Two extra cases cover that invariant.
@MainActor
final class ChatComposerSwapTests: XCTestCase {

    // MARK: - 1. Empty input → mic

    func test_mode_emptyInput_isMic() {
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(input: "", isListening: false),
            .mic
        )
    }

    func test_mode_whitespaceOnlyInput_isMic() {
        // Whitespace-only treated as empty — matches the existing
        // ChatView.canSend semantics which trim `.whitespaces` (not
        // `.whitespacesAndNewlines`). Newlines are intentionally
        // treated as content because composer-keyboard behaviour can
        // produce a leading newline, and the user might still want
        // send enabled.
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(input: "   ", isListening: false),
            .mic
        )
    }

    // MARK: - 2. Non-empty input → send

    func test_mode_nonEmptyInput_isSend() {
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(input: "Plan a trip", isListening: false),
            .send
        )
    }

    func test_mode_singleCharacter_isSend() {
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(input: "h", isListening: false),
            .send
        )
    }

    // MARK: - 3. Send tap submits + clears text

    func test_send_clearsInputAfterSubmit() {
        let svc = ChatService(baseURL: URL(string: "http://localhost:0")!)
        let vm = ChatViewModel(service: svc)
        vm.input = "Plan a weekend trip to Vegas"
        XCTAssertFalse(vm.input.isEmpty, "precondition: input populated")

        vm.send(mode: .text)

        XCTAssertEqual(vm.input, "", "send must clear input — drives the icon swap back to mic")
    }

    // MARK: - 4. Listening overrides input — waveform wins

    func test_mode_listeningWithEmptyInput_isWaveform() {
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(input: "", isListening: true),
            .waveform
        )
    }

    func test_mode_listeningWithPartialTranscript_staysWaveform() {
        // While listening, partial transcripts populate the text
        // field. The icon must NOT flicker to send during that
        // window; the user still expects the listening waveform.
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(input: "Plan a trip to", isListening: true),
            .waveform,
            "listening always wins — partial transcripts shouldn't flip the icon to send"
        )
    }

    // MARK: - 5. Icon + accessibility metadata

    func test_modeIcons_matchSpec() {
        XCTAssertEqual(ChatComposerTrailingButton.Mode.mic.systemImage, "mic.fill")
        XCTAssertEqual(ChatComposerTrailingButton.Mode.waveform.systemImage, "waveform")
        XCTAssertEqual(ChatComposerTrailingButton.Mode.send.systemImage, "paperplane.fill")
    }

    func test_modeAccessibilityIdentifiers_match() {
        XCTAssertEqual(ChatComposerTrailingButton.Mode.mic.accessibilityIdentifier, "chat.composer.mic")
        XCTAssertEqual(ChatComposerTrailingButton.Mode.waveform.accessibilityIdentifier, "chat.composer.listening")
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.send.accessibilityIdentifier, "chat.send",
            "send identifier must be preserved across the swap so existing chat.send accessibility tests keep working"
        )
    }
}
