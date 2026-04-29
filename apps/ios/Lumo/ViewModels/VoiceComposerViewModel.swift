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

    private let speech: SpeechRecognitionServicing
    /// Bumped every time the user finishes a successful voice turn.
    /// `SettingsTab` reads this to decide whether to show the voice
    /// section (default OFF until first use).
    static let voiceUsageDefaultsKey = "lumo.voice.lastUsedAt"

    init(speech: SpeechRecognitionServicing) {
        self.speech = speech
        Task { await observeSpeech() }
        applyDebugFixtureIfPresent()
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

    /// Begin a tap-to-talk turn. Auto-stops on silence.
    func tapToTalk() async {
        await ensureAndStart()
    }

    /// Hold-to-talk press began. Mic stays open until `release()`.
    func pressBegan() async {
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
}

extension VoiceComposerViewModel.State {
    /// Reason text for the permission-denied alert. nil when not
    /// currently in a denied state.
    var permissionDeniedMessage: String? {
        if case .permissionDenied(let reason) = self { return reason.userMessage }
        return nil
    }
}
