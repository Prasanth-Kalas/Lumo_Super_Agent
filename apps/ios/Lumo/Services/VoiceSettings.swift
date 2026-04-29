import Foundation

/// User preferences for the voice path. Persisted to UserDefaults.
///
/// `speakResponses` defaults to true so that as soon as the user uses
/// the voice path once, subsequent assistant replies are read aloud
/// automatically. The user can flip this off in Settings.
///
/// `hasUsedVoice` is set to true the first time
/// `VoiceComposerViewModel.consumeReadyTranscript()` returns a
/// non-nil transcript — i.e. the user actually completed a voice
/// turn. Settings reads it to decide whether to surface the Voice
/// section at all (kept hidden for first-time users).

enum VoiceSettings {
    private static let speakResponsesKey = "lumo.voice.speakResponses"
    private static let hasUsedVoiceKey = VoiceComposerViewModel.voiceUsageDefaultsKey

    static var speakResponses: Bool {
        get {
            // First-time default: true. When the toggle hasn't been
            // touched, UserDefaults returns false for `bool(forKey:)`,
            // so route through `object(forKey:)` to distinguish "not
            // set" from "explicitly off."
            if UserDefaults.standard.object(forKey: speakResponsesKey) == nil {
                return true
            }
            return UserDefaults.standard.bool(forKey: speakResponsesKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: speakResponsesKey)
        }
    }

    static var hasUsedVoice: Bool {
        UserDefaults.standard.object(forKey: hasUsedVoiceKey) != nil
    }
}
