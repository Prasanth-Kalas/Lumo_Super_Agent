import Foundation
import SwiftUI

/// Drives the push-to-talk button + live transcript view.
///
/// State machine:
///
///   idle ─────────────► requestingPermissions
///     │                       │
///     │ ◄───── permissionDenied (terminal until user retries)
///     │
///     ▼
///   listening (partial transcript shown)
///     │
///     │ user releases / silence-auto-stop
///     ▼
///   ready (final transcript ready to send)
///     │
///     │ host (ChatView) consumes the transcript
///     ▼
///   idle
///
/// Errors transition to `.error` with a description; UI offers retry.

@MainActor
final class VoiceComposerViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case requestingPermissions
        case permissionDenied(reason: PermissionDenialReason)
        case listening(partial: String)
        case ready(transcript: String)
        case error(String)

        var isListening: Bool {
            if case .listening = self { return true }
            return false
        }

        var partialTranscript: String? {
            if case .listening(let p) = self { return p }
            return nil
        }
    }

    enum PermissionDenialReason: Equatable {
        case microphone
        case speechRecognition
        case restricted

        var userMessage: String {
            switch self {
            case .microphone:
                return "Lumo needs microphone access. Open Settings to enable."
            case .speechRecognition:
                return "Lumo needs speech-recognition access. Open Settings to enable."
            case .restricted:
                return "Speech recognition is restricted on this device."
            }
        }
    }

    @Published private(set) var state: State = .idle

    /// IOS-VOICE-MODE-STT-GATING-1 — parallel phase track for the
    /// TTS-driven mic gate. Mirrors codex's
    /// `voiceMachinePhase` from web's VoiceMode.tsx. State and
    /// phase are orthogonal: state tracks what the USER is doing
    /// (listening / ready / idle); phase tracks what the AGENT
    /// VOICE subsystem is doing (thinking / speaking / guarding /
    /// listening-allowed). The mic gate is derived from phase via
    /// `SpeechModeGating.isMicPaused(phase:)`.
    @Published private(set) var phase: VoiceModeMachinePhase = .listening

    /// True while the TTS mic gate is held. Derived from phase;
    /// exposed for view-layer convenience (e.g., showing a
    /// "speaking…" hint on the mic affordance during the gate
    /// window).
    var isMicPausedForTts: Bool {
        SpeechModeGating.isMicPaused(phase: phase)
    }

    private let speech: SpeechRecognitionServicing
    private let tailGuardMs: Int
    private var ttsObserveTask: Task<Void, Never>?
    private var tailGuardTask: Task<Void, Never>?
    /// Held weakly so cancellation reaches the TTS service when
    /// the user taps the Stop affordance during AGENT_SPEAKING.
    /// IOS-VOICE-MODE-CONTROLS-REGRESSION-1 — without this hook
    /// the user would be locked out of barge-in (same UX bug
    /// codex caught on web in b65ca9d).
    private weak var ttsRef: AnyObject?
    /// Bumped every time the user finishes a successful voice turn.
    /// `SettingsView` reads this to decide whether to show the voice
    /// section (default OFF until first use).
    static let voiceUsageDefaultsKey = "lumo.voice.lastUsedAt"

    init(
        speech: SpeechRecognitionServicing,
        tailGuardMs: Int = LumoVoiceConfig.ttsTailGuardMs
    ) {
        self.speech = speech
        self.tailGuardMs = tailGuardMs
        Task { await observeSpeech() }
        applyDebugFixtureIfPresent()
    }

    /// Subscribe to a TextToSpeechServicing's stateChange stream so
    /// the phase machine tracks TTS lifecycle. Called by RootView
    /// after both view-models exist. Idempotent — multiple calls
    /// replace the prior observer.
    ///
    /// Phase transitions on TTS state:
    /// - `.speaking` → `.agentSpeaking` (gate ON)
    /// - `.finished` → `.postSpeakingGuard`, then after
    ///   `tailGuardMs` → `.listening` (gate OFF)
    /// - `.error` / `.idle` (after speaking) → `.listening`
    ///   IMMEDIATELY (defensive: dropped TTS clears the gate so
    ///   tap-to-talk can't get stuck blocked — the edge codex
    ///   caught during their review).
    func observe(tts: TextToSpeechServicing) {
        ttsObserveTask?.cancel()
        ttsRef = tts
        ttsObserveTask = Task { [weak self] in
            for await ttsState in tts.stateChange {
                await MainActor.run { self?.applyTTS(state: ttsState) }
            }
        }
    }

    /// Explicit barge-in entry point for the Stop affordance on
    /// the trailing composer button. Cancels in-flight TTS; the
    /// resulting `.idle` state propagates through `applyTTS` and
    /// clears the gate to `.listening`. We also clear the phase
    /// synchronously so the button recovers even if the TTS observer
    /// is detached or its `.idle` event is delayed.
    func requestBargeIn() {
        cancelTailGuard()
        phase = .listening
        if !state.isListening {
            state = .idle
        }
        (ttsRef as? TextToSpeechServicing)?.cancel()
    }

    /// DEBUG-only path that pre-seeds the composer state from a launch
    /// argument (`-LumoVoiceFixture {listening|transcript|denied}`).
    /// Used by `scripts/ios-capture-screenshots.sh` to render the
    /// listening / live-transcript / permission-denied states
    /// deterministically without a real mic on the simulator.
    /// Compiled out in Release.
    private func applyDebugFixtureIfPresent() {
        #if DEBUG
        let raw = (UserDefaults.standard.string(forKey: "LumoVoiceFixture") ?? "").lowercased()
        switch raw {
        case "listening":
            state = .listening(partial: "")
        case "transcript":
            state = .listening(partial: "Plan a Vegas trip for May 5 to 12, around two thousand all-in.")
        case "denied":
            state = .permissionDenied(reason: .microphone)
        default:
            break
        }
        #endif
    }

    private func observeSpeech() async {
        for await event in speech.stateChange {
            apply(event)
        }
    }

    // MARK: - Public actions

    /// Begin a tap-to-talk turn. Auto-stops on silence. Gated by
    /// the TTS mic-pause: while the agent is speaking or the post-
    /// speaking guard is active, the tap is dropped (no-op) so the
    /// user's voice doesn't bleed into Lumo's own audio playback.
    func tapToTalk() async {
        if SpeechModeGating.isMicPaused(phase: phase) { return }
        await ensureAndStart()
    }

    /// Hold-to-talk press began. Same gate as tapToTalk — a press
    /// during AGENT_SPEAKING / POST_SPEAKING_GUARD is dropped.
    func pressBegan() async {
        if SpeechModeGating.isMicPaused(phase: phase) { return }
        await ensureAndStart()
    }

    /// Hold-to-talk press released. Finalize whatever we have.
    func release() {
        if state.isListening {
            speech.stop()
        }
    }

    /// User dismissed the live transcript without sending — drop the
    /// in-flight partial.
    func cancel() {
        speech.cancel()
        state = .idle
    }

    /// Host confirmed the transcript was consumed (sent to chat). Reset
    /// to idle so the next press starts fresh.
    func consumeReadyTranscript() -> String? {
        guard case .ready(let t) = state else { return nil }
        state = .idle
        UserDefaults.standard.set(Date().timeIntervalSinceReferenceDate, forKey: Self.voiceUsageDefaultsKey)
        return t
    }

    // MARK: - Internals

    private func ensureAndStart() async {
        state = .requestingPermissions
        let result = await speech.ensurePermissions()
        switch result {
        case .granted:
            do {
                try await speech.start()
                // SpeechRecognitionService will yield .listening soon;
                // observeSpeech() picks it up.
            } catch {
                state = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
            }
        case .microphoneDenied:
            state = .permissionDenied(reason: .microphone)
        case .speechRecognitionDenied:
            state = .permissionDenied(reason: .speechRecognition)
        case .restrictedByDevice:
            state = .permissionDenied(reason: .restricted)
        }
    }

    private func apply(_ event: SpeechRecognitionState) {
        switch event {
        case .idle:
            // Only flip to idle if we're not already past the
            // recognition stage — a stale .idle event after .ready
            // would otherwise reset before the host consumes.
            if !isPostRecognition { state = .idle }
        case .listening(let partial):
            state = .listening(partial: partial)
        case .final(let transcript):
            state = .ready(transcript: transcript)
        case .permissionDenied:
            state = .permissionDenied(reason: .speechRecognition)
        case .error(let message):
            state = .error(message)
        }
    }

    private var isPostRecognition: Bool {
        switch state {
        case .ready, .error: return true
        default: return false
        }
    }

    // MARK: - TTS phase tracking (IOS-VOICE-MODE-STT-GATING-1)

    /// Maps TTSState transitions onto the four phase values.
    /// The `agentThinking` phase isn't used today (TTS service
    /// doesn't surface a separate "thinking" tier), so we move
    /// straight `listening → agentSpeaking` on the first
    /// `.speaking` event and back via `postSpeakingGuard` on
    /// `.finished`. Defensive transitions — `.error`, dropped
    /// `.idle` while we were speaking — clear the gate
    /// immediately so the user isn't stuck unable to tap-to-talk
    /// after a TTS hiccup.
    private func applyTTS(state ttsState: TTSState) {
        switch ttsState {
        case .speaking:
            cancelTailGuard()
            phase = .agentSpeaking
        case .finished:
            phase = .postSpeakingGuard
            scheduleTailGuardClear()
        case .error, .fallback:
            // Defensive: TTS errored or fell back mid-stream. The
            // gate clears immediately so the user can tap to talk.
            // (Codex caught this edge during their review — without
            // this branch a dropped TTS connection would leave the
            // gate stuck on AGENT_SPEAKING forever.)
            cancelTailGuard()
            phase = .listening
        case .idle:
            // Cancel/teardown of the TTS session. If we were in
            // speaking or guard, clear the gate; if we were
            // already listening, no-op.
            if SpeechModeGating.isMicPaused(phase: phase) {
                cancelTailGuard()
                phase = .listening
            }
        }
    }

    private func scheduleTailGuardClear() {
        cancelTailGuard()
        let delay = max(0, tailGuardMs)
        tailGuardTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            if Task.isCancelled { return }
            await MainActor.run {
                guard let self = self else { return }
                if self.phase == .postSpeakingGuard {
                    self.phase = .listening
                }
            }
        }
    }

    private func cancelTailGuard() {
        tailGuardTask?.cancel()
        tailGuardTask = nil
    }

    deinit {
        ttsObserveTask?.cancel()
        tailGuardTask?.cancel()
    }
}

extension VoiceComposerViewModel.State {
    /// Reason text for the permission-denied alert. nil when not
    /// currently in a denied state.
    var permissionDeniedMessage: String? {
        if case .permissionDenied(let reason) = self { return reason.userMessage }
        return nil
    }
}
