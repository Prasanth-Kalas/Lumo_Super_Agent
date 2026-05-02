import XCTest
@testable import Lumo

/// IOS-VOICE-MODE-STT-GATING-1 — VoiceComposerViewModel state-machine
/// assertions for TTS-driven mic gating.
///
/// Covers the integration between TextToSpeechServicing.stateChange
/// and the parallel `phase` track on VoiceComposerViewModel:
///
///   1. Default phase is `.listening` (gate off) on construction.
///   2. TTS `.speaking` flips phase to `.agentSpeaking` (gate ON).
///   3. TTS `.finished` flips phase to `.postSpeakingGuard`, then
///      after the configured tail-guard window → `.listening`
///      (gate OFF).
///   4. tapToTalk + pressBegan are no-ops while the gate is held.
///   5. Defensive — TTS `.error` clears the gate immediately so
///      tap-to-talk can't get stuck blocked. (Codex review edge.)
///   6. Defensive — TTS `.fallback` clears the gate immediately.
///   7. tap-to-talk after the tail guard expires works normally.
@MainActor
final class VoiceComposerSttGatingTests: XCTestCase {

    private func makeVM(tailGuardMs: Int = 50) -> (VoiceComposerViewModel, SpeechRecognitionStub, TextToSpeechStub) {
        let speech = SpeechRecognitionStub()
        let tts = TextToSpeechStub()
        let vm = VoiceComposerViewModel(speech: speech, tailGuardMs: tailGuardMs)
        vm.observe(tts: tts)
        // Allow the observer task one tick to attach.
        return (vm, speech, tts)
    }

    private func waitForPhase(
        _ vm: VoiceComposerViewModel,
        _ expected: VoiceModeMachinePhase,
        timeout: TimeInterval = 1.0
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if vm.phase == expected { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    // MARK: - 1. Default state

    func test_defaultPhase_isListening() {
        let (vm, _, _) = makeVM()
        XCTAssertEqual(vm.phase, .listening)
        XCTAssertFalse(vm.isMicPausedForTts)
    }

    // MARK: - 2. Speaking → agentSpeaking

    func test_ttsSpeaking_flipsPhaseToAgentSpeaking_gateOn() async {
        let (vm, _, tts) = makeVM()
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)
        XCTAssertEqual(vm.phase, .agentSpeaking)
        XCTAssertTrue(vm.isMicPausedForTts)
    }

    // MARK: - 3. Finished → postSpeakingGuard → (tail guard) → listening

    func test_ttsFinished_entersGuardThenListensAfterTailGuard() async {
        let (vm, _, tts) = makeVM(tailGuardMs: 50)
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)

        tts.state = .finished(provider: .deepgram)
        await waitForPhase(vm, .postSpeakingGuard)
        XCTAssertEqual(vm.phase, .postSpeakingGuard)
        XCTAssertTrue(vm.isMicPausedForTts, "gate stays held during tail guard window")

        await waitForPhase(vm, .listening, timeout: 1.0)
        XCTAssertEqual(vm.phase, .listening)
        XCTAssertFalse(vm.isMicPausedForTts, "gate releases after tail guard expires")
    }

    // MARK: - 4. Gate suppresses tap-to-talk + push-to-talk

    func test_tapToTalk_duringAgentSpeaking_isDropped() async {
        let (vm, speech, tts) = makeVM()
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)

        // Mic gate is on; tapping should NOT transition to listening.
        await vm.tapToTalk()
        XCTAssertEqual(vm.state, .idle,
                       "tap-to-talk during AGENT_SPEAKING must be a no-op (gate enforced)")
        XCTAssertEqual(speech.state, .idle,
                       "underlying SpeechRecognitionService must not have been started")
    }

    func test_pressBegan_duringPostSpeakingGuard_isDropped() async {
        let (vm, speech, tts) = makeVM(tailGuardMs: 1_000)
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)
        tts.state = .finished(provider: .deepgram)
        await waitForPhase(vm, .postSpeakingGuard)

        await vm.pressBegan()
        XCTAssertEqual(vm.state, .idle,
                       "press during POST_SPEAKING_GUARD must be a no-op")
        XCTAssertEqual(speech.state, .idle)
    }

    // MARK: - 5/6. Defensive — error/fallback clears gate immediately

    func test_ttsError_midSpeaking_clearsGateImmediately() async {
        // Codex caught this edge during their review: a dropped TTS
        // mid-stream must not leave the gate stuck on AGENT_SPEAKING.
        // The fix mirrors web's cancelTts: clear tail guard + reset
        // phase to .listening before returning from the error path.
        let (vm, _, tts) = makeVM(tailGuardMs: 1_000)
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)
        XCTAssertTrue(vm.isMicPausedForTts)

        tts.state = .error("connection lost")
        await waitForPhase(vm, .listening, timeout: 0.5)
        XCTAssertEqual(vm.phase, .listening,
                       "TTS error must clear the gate immediately (defensive)")
        XCTAssertFalse(vm.isMicPausedForTts)
    }

    func test_ttsFallback_midSpeaking_clearsGateImmediately() async {
        let (vm, _, tts) = makeVM(tailGuardMs: 1_000)
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)

        tts.state = .fallback(
            from: .deepgram,
            to: .systemSynthesizer,
            reason: "test"
        )
        await waitForPhase(vm, .listening, timeout: 0.5)
        XCTAssertEqual(vm.phase, .listening,
                       "TTS fallback must clear the gate immediately so tap-to-talk works")
    }

    func test_ttsIdle_whileInGuardOrSpeaking_clearsGate() async {
        // Cancel/teardown of the TTS session should also drop the gate.
        let (vm, _, tts) = makeVM(tailGuardMs: 1_000)
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)

        tts.state = .idle
        await waitForPhase(vm, .listening, timeout: 0.5)
        XCTAssertEqual(vm.phase, .listening)
    }

    // MARK: - 7. Tap-to-talk after tail guard works

    func test_tapToTalk_afterTailGuardExpires_succeeds() async {
        let (vm, speech, tts) = makeVM(tailGuardMs: 50)
        tts.state = .speaking(provider: .deepgram)
        await waitForPhase(vm, .agentSpeaking)
        tts.state = .finished(provider: .deepgram)
        await waitForPhase(vm, .listening, timeout: 1.0)

        await vm.tapToTalk()
        // Allow the speech observer task one tick to forward the
        // .listening event from the stub into vm.state.
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(vm.state.isListening,
                      "tap-to-talk after the tail guard expires must reach .listening")
        if case .listening = speech.state { /* ok */ } else {
            XCTFail("underlying SpeechRecognitionService must have been started; got \(speech.state)")
        }
    }

    // MARK: - 8. Stop button still works (manual barge-in)

    func test_cancel_duringListening_returnsToIdle_evenIfPhaseUnchanged() async {
        // Manual Stop / barge-in semantics are preserved: cancel()
        // pulls state back to idle regardless of phase. The phase
        // tracks AGENT-side; cancel() acts on the USER-side state.
        let (vm, speech, _) = makeVM()
        speech.state = .listening(partial: "plan a trip")
        // Allow the observer to forward the listening event.
        try? await Task.sleep(nanoseconds: 50_000_000)

        vm.cancel()
        XCTAssertEqual(vm.state, .idle, "cancel() returns user state to idle")
    }
}
