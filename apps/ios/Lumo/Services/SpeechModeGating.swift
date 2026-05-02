import Foundation

/// IOS-VOICE-MODE-STT-GATING-1 — pure helpers for the voice-mode
/// state machine that gates STT input while TTS owns the speaker.
///
/// **iOS mirror of codex's `apps/web/lib/voice-mode-stt-gating.ts`**
/// (commit b65ca9d). Lives in its own module so the helpers are
/// directly unit-testable without spinning up a `VoiceComposerViewModel`,
/// matching the web factoring exactly.
///
/// Why this exists: production voice mode was letting STT restart
/// during TTS playback, so Lumo's own audio (or room noise during
/// the brief gap between TTS chunks) could interrupt a multi-
/// sentence assistant reply. The gate keeps the mic paused while a
/// TTS chunk is fetching, appending, or playing, plus a
/// configurable tail-guard window after the last chunk drains
/// before hands-free auto-resume can fire.
///
/// The phase machine is **parallel** to `VoiceComposerViewModel.State`,
/// not a replacement. State tracks what the user is doing
/// (listening / ready / idle); phase tracks what the agent voice
/// subsystem is doing (thinking / speaking / guarding / listening-
/// allowed). A single boolean derived from phase
/// (`isMicPaused(phase:)`) drives the actual gate.

/// The four phases of the voice-mode subsystem. Same string raw
/// values as web so cross-platform telemetry can compare without a
/// translation table.
enum VoiceModeMachinePhase: String, Equatable {
    case agentThinking = "AGENT_THINKING"
    case agentSpeaking = "AGENT_SPEAKING"
    case postSpeakingGuard = "POST_SPEAKING_GUARD"
    case listening = "LISTENING"
}

/// Build-time configuration knobs for the voice mode subsystem.
/// The TTS tail guard is the dwell time between TTS audio drain and
/// the moment hands-free listening can resume. Default 300 ms;
/// clamped to [0, 2000] ms. Override at app boot via the
/// `LUMO_VOICE_TTS_TAIL_GUARD_MS` Info.plist key (the build
/// pipeline can substitute it via xcconfig if a future tuning
/// session wants to A/B the dwell on real hardware without an
/// app-store rebuild).
enum LumoVoiceConfig {
    static let defaultTtsTailGuardMs: Int = 300
    static let maxTtsTailGuardMs: Int = 2_000

    /// Resolved tail-guard value — reads the Info.plist override
    /// once, then caches. Failsafe to default on any parse error.
    static let ttsTailGuardMs: Int = {
        let raw = Bundle.main.object(forInfoDictionaryKey: "LumoVoiceTTSTailGuardMs")
        return SpeechModeGating.normalize(tailGuardMs: raw)
    }()
}

/// Inputs for the auto-resume gate. Mirrors codex's
/// `CanResumeListeningInput`. iOS doesn't have a hands-free
/// auto-listen path today (we have explicit tap-to-talk and hold-
/// to-talk), so the `handsFree` flag is false in practice for now —
/// but the contract is preserved so a future hands-free addition
/// just flips the flag without re-deriving the gate.
struct CanResumeListeningInput: Equatable {
    /// True once the user has interacted with voice at least once
    /// in the session — gates against waking the mic on cold launch.
    var autoListenUnlocked: Bool
    /// True when the user has opted into hands-free auto-resume.
    var handsFree: Bool
    /// True when the user explicitly stopped listening (e.g.
    /// pressed Stop). Suppresses auto-resume until the user
    /// re-engages.
    var userStoppedListening: Bool
    /// True when voice mode is generally enabled.
    var enabled: Bool
    /// True when the chat surface is busy with a non-voice path
    /// (mid-stream LLM reply that's text-only, etc.) — suppresses
    /// auto-resume so we don't open the mic over text.
    var busy: Bool
    /// True while the TTS gate is holding the mic shut.
    var micPausedForTts: Bool
}

/// Pure helpers — match codex's web functions name-for-name so a
/// future shared-types codegen pass could lift them onto a single
/// contract.
enum SpeechModeGating {
    /// Mic gate is HELD during AGENT_SPEAKING (TTS playing) and
    /// POST_SPEAKING_GUARD (tail guard window). Released during
    /// AGENT_THINKING (no audio yet) and LISTENING (gate is the
    /// off state).
    static func isMicPaused(phase: VoiceModeMachinePhase) -> Bool {
        phase == .agentSpeaking || phase == .postSpeakingGuard
    }

    /// All five gates AND'd together. Matches codex's
    /// `canResumeListeningAfterTts` exactly.
    static func canResumeListeningAfterTts(input: CanResumeListeningInput) -> Bool {
        input.autoListenUnlocked
            && input.handsFree
            && !input.userStoppedListening
            && input.enabled
            && !input.busy
            && !input.micPausedForTts
    }

    /// Expected phase sequence when a TTS turn lands and resolves.
    /// Hands-free includes the terminal LISTENING that cues auto-
    /// resume; explicit-listen ends at POST_SPEAKING_GUARD and
    /// waits for the user's next tap.
    static func expectedTtsResumeSequence(handsFree: Bool) -> [VoiceModeMachinePhase] {
        var sequence: [VoiceModeMachinePhase] = [
            .agentThinking,
            .agentSpeaking,
            .postSpeakingGuard,
        ]
        if handsFree {
            sequence.append(.listening)
        }
        return sequence
    }

    /// Tail-guard parsing/clamping. Accepts:
    ///   - String: parsed as Int via `Int(_:)` first (codex's web
    ///     impl uses `Number()` then `Math.round`); we tolerate
    ///     decimals via `Double(_:)`.
    ///   - Int: used as-is.
    ///   - nil / unparseable: defaults to
    ///     `LumoVoiceConfig.defaultTtsTailGuardMs`.
    /// Result is clamped to [0, `LumoVoiceConfig.maxTtsTailGuardMs`].
    static func normalize(tailGuardMs raw: Any?) -> Int {
        let parsed: Int? = {
            if let n = raw as? Int { return n }
            if let s = raw as? String {
                let trimmed = s.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { return nil }
                if let n = Int(trimmed) { return n }
                if let d = Double(trimmed), d.isFinite {
                    return Int(d.rounded())
                }
                return nil
            }
            if let d = raw as? Double, d.isFinite {
                return Int(d.rounded())
            }
            return nil
        }()
        guard let value = parsed else {
            return LumoVoiceConfig.defaultTtsTailGuardMs
        }
        return max(0, min(LumoVoiceConfig.maxTtsTailGuardMs, value))
    }
}
