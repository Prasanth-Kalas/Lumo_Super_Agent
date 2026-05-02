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

    // MARK: - 6. AGENT_SPEAKING / POST_SPEAKING_GUARD → Stop affordance
    //
    // IOS-VOICE-MODE-CONTROLS-REGRESSION-1 — phase wins over input
    // and listening so the user always has a visible Stop button
    // for explicit barge-in. Mirror of codex's web fix for the same
    // bug class (b65ca9d).

    func test_mode_agentSpeakingPhase_overridesEverything() {
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "", isListening: false, phase: .agentSpeaking
            ),
            .agentSpeaking
        )
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "Plan a trip", isListening: false, phase: .agentSpeaking
            ),
            .agentSpeaking,
            "phase must override input — Send button hiding the Stop affordance is the bug class we're patching"
        )
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "", isListening: true, phase: .agentSpeaking
            ),
            .agentSpeaking
        )
    }

    func test_mode_postSpeakingGuard_alsoSurfacesStop_noFlicker() {
        // The 300 ms tail guard window MUST visually look the
        // same as AGENT_SPEAKING — flicker over 300 ms is ugly.
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "", isListening: false, phase: .postSpeakingGuard
            ),
            .agentSpeaking
        )
    }

    func test_mode_listeningPhase_fallsThroughToInputBasedRules() {
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "", isListening: false, phase: .listening
            ),
            .mic
        )
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "Plan a trip", isListening: false, phase: .listening
            ),
            .send
        )
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "", isListening: true, phase: .listening
            ),
            .waveform
        )
    }

    func test_mode_agentThinkingPhase_fallsThroughToday() {
        // AGENT_THINKING is reserved for a future LLM-streaming
        // surface; locking current passthrough behaviour so a
        // future addition is an explicit decision, not accidental.
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.from(
                input: "", isListening: false, phase: .agentThinking
            ),
            .mic
        )
    }

    func test_agentSpeakingMode_iconAndIdentifierAndLabel() {
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.agentSpeaking.systemImage,
            "stop.fill"
        )
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.agentSpeaking.accessibilityIdentifier,
            "chat.composer.bargeIn"
        )
        XCTAssertEqual(
            ChatComposerTrailingButton.Mode.agentSpeaking.accessibilityLabel,
            "Stop speaking"
        )
    }

    func test_modeTapActions_matchVisibleAffordance() {
        XCTAssertEqual(ChatComposerTrailingButton.Mode.mic.tapAction, .startVoice)
        XCTAssertEqual(ChatComposerTrailingButton.Mode.waveform.tapAction, .stopVoice)
        XCTAssertEqual(ChatComposerTrailingButton.Mode.send.tapAction, .sendMessage)
        XCTAssertEqual(ChatComposerTrailingButton.Mode.agentSpeaking.tapAction, .stopSpeaking)
    }

    // MARK: - 7. Barge-in handler

    func test_requestBargeIn_callsTtsCancel() async {
        let speech = SpeechRecognitionStub()
        let tts = TextToSpeechStub()
        let vm = VoiceComposerViewModel(speech: speech, tailGuardMs: 50)
        vm.observe(tts: tts)

        tts.state = .speaking(provider: .deepgram)
        try? await Task.sleep(nanoseconds: 50_000_000)

        vm.requestBargeIn()

        // The stub's cancel() resets state to .idle — observable
        // proof that requestBargeIn() reached tts.cancel().
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(
            tts.state, .idle,
            "requestBargeIn must call tts.cancel() so the .idle state propagates and clears the gate"
        )
    }

    func test_requestBargeIn_clearsGateImmediately() async {
        let speech = SpeechRecognitionStub()
        let tts = TextToSpeechStub()
        let vm = VoiceComposerViewModel(speech: speech, tailGuardMs: 1_000)
        vm.observe(tts: tts)

        tts.state = .speaking(provider: .deepgram)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(vm.phase, .agentSpeaking, "precondition: TTS gate is held")

        vm.requestBargeIn()

        XCTAssertEqual(
            vm.phase,
            .listening,
            "Stop must clear the gate synchronously so the next tap-to-talk is not blocked"
        )
    }
}
