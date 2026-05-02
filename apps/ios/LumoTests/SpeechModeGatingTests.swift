import XCTest
@testable import Lumo

/// IOS-VOICE-MODE-STT-GATING-1 — pure helper contract tests.
///
/// Mirrors codex's `apps/web/tests/voice-mode-stt-gating.test.mjs`
/// case-for-case so the cross-platform gate behaves identically:
///
///   1. expectedTtsResumeSequence — hands-free vs explicit-listen.
///   2. isMicPaused — gate per phase.
///   3. canResumeListeningAfterTts — five-input AND.
///   4. normalize — default + clamp behaviour.
final class SpeechModeGatingTests: XCTestCase {

    // MARK: - 1. expectedTtsResumeSequence

    func test_expectedTtsResumeSequence_handsFree_endsAtListening() {
        XCTAssertEqual(
            SpeechModeGating.expectedTtsResumeSequence(handsFree: true),
            [.agentThinking, .agentSpeaking, .postSpeakingGuard, .listening]
        )
    }

    func test_expectedTtsResumeSequence_explicitListen_endsAtPostSpeakingGuard() {
        XCTAssertEqual(
            SpeechModeGating.expectedTtsResumeSequence(handsFree: false),
            [.agentThinking, .agentSpeaking, .postSpeakingGuard]
        )
    }

    // MARK: - 2. isMicPaused

    func test_isMicPaused_isHeldDuring_agentSpeaking_and_postSpeakingGuard() {
        XCTAssertFalse(SpeechModeGating.isMicPaused(phase: .agentThinking))
        XCTAssertTrue(SpeechModeGating.isMicPaused(phase: .agentSpeaking))
        XCTAssertTrue(SpeechModeGating.isMicPaused(phase: .postSpeakingGuard))
        XCTAssertFalse(SpeechModeGating.isMicPaused(phase: .listening))
    }

    // MARK: - 3. canResumeListeningAfterTts

    func test_canResumeListeningAfterTts_happyPath_returnsTrue() {
        let base = CanResumeListeningInput(
            autoListenUnlocked: true,
            handsFree: true,
            userStoppedListening: false,
            enabled: true,
            busy: false,
            micPausedForTts: false
        )
        XCTAssertTrue(SpeechModeGating.canResumeListeningAfterTts(input: base))
    }

    func test_canResumeListeningAfterTts_blockedWhile_micPausedForTts() {
        let blocked = CanResumeListeningInput(
            autoListenUnlocked: true, handsFree: true,
            userStoppedListening: false, enabled: true, busy: false,
            micPausedForTts: true
        )
        XCTAssertFalse(SpeechModeGating.canResumeListeningAfterTts(input: blocked))
    }

    func test_canResumeListeningAfterTts_blockedWhile_busy() {
        let blocked = CanResumeListeningInput(
            autoListenUnlocked: true, handsFree: true,
            userStoppedListening: false, enabled: true, busy: true,
            micPausedForTts: false
        )
        XCTAssertFalse(SpeechModeGating.canResumeListeningAfterTts(input: blocked))
    }

    func test_canResumeListeningAfterTts_blockedWhile_userStoppedListening() {
        let blocked = CanResumeListeningInput(
            autoListenUnlocked: true, handsFree: true,
            userStoppedListening: true, enabled: true, busy: false,
            micPausedForTts: false
        )
        XCTAssertFalse(SpeechModeGating.canResumeListeningAfterTts(input: blocked))
    }

    func test_canResumeListeningAfterTts_blockedWhile_disabledOrLocked() {
        let baseLocked = CanResumeListeningInput(
            autoListenUnlocked: false, handsFree: true,
            userStoppedListening: false, enabled: true, busy: false,
            micPausedForTts: false
        )
        XCTAssertFalse(SpeechModeGating.canResumeListeningAfterTts(input: baseLocked))

        let baseDisabled = CanResumeListeningInput(
            autoListenUnlocked: true, handsFree: true,
            userStoppedListening: false, enabled: false, busy: false,
            micPausedForTts: false
        )
        XCTAssertFalse(SpeechModeGating.canResumeListeningAfterTts(input: baseDisabled))

        let baseExplicit = CanResumeListeningInput(
            autoListenUnlocked: true, handsFree: false,
            userStoppedListening: false, enabled: true, busy: false,
            micPausedForTts: false
        )
        XCTAssertFalse(
            SpeechModeGating.canResumeListeningAfterTts(input: baseExplicit),
            "non-hands-free callers must explicitly tap to listen — gate denies auto-resume"
        )
    }

    // MARK: - 4. normalize

    func test_normalize_nilOrEmpty_returnsDefault() {
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: nil), 300)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: ""), 300)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: "   "), 300)
    }

    func test_normalize_parsesIntegerStringsAndIntsAndDoubles() {
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: "275"), 275)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: 275), 275)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: "275.4"), 275)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: 275.4), 275)
    }

    func test_normalize_clampsToZeroOnNegative() {
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: "-40"), 0)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: -40), 0)
    }

    func test_normalize_clampsToMaxOnAbsurdlyLarge() {
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: "5000"), 2000)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: 5000), 2000)
    }

    func test_normalize_unparseableFallsBackToDefault() {
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: "not-a-number"), 300)
        XCTAssertEqual(SpeechModeGating.normalize(tailGuardMs: ["wrong-shape"]), 300)
    }

    // MARK: - 5. Phase raw values match cross-platform telemetry strings

    func test_phaseRawValues_matchWebContractStrings() {
        // Pinned so cross-platform telemetry can compare without a
        // translation table — must match codex's web string union.
        XCTAssertEqual(VoiceModeMachinePhase.agentThinking.rawValue, "AGENT_THINKING")
        XCTAssertEqual(VoiceModeMachinePhase.agentSpeaking.rawValue, "AGENT_SPEAKING")
        XCTAssertEqual(VoiceModeMachinePhase.postSpeakingGuard.rawValue, "POST_SPEAKING_GUARD")
        XCTAssertEqual(VoiceModeMachinePhase.listening.rawValue, "LISTENING")
    }
}
