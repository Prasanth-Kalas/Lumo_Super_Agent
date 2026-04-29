import Foundation

/// Read-only access to build-time configuration baked into the app
/// bundle's Info.plist by xcconfig substitution. The xcconfig values
/// come from `~/.config/lumo/.env` via `scripts/ios-write-xcconfig.sh`;
/// missing values resolve to empty strings and surface as
/// `isAuthConfigured` / `isElevenLabsConfigured` flags so callers can
/// render an explicit "configuration missing" UX instead of crashing.

struct AppConfig {
    let apiBaseURL: URL
    let supabaseURL: URL?
    let supabaseAnonKey: String
    let elevenLabsAPIKey: String
    let elevenLabsVoiceID: String

    var isAuthConfigured: Bool {
        supabaseURL != nil && !supabaseAnonKey.isEmpty
    }

    /// True when ElevenLabs Turbo TTS can be used as the primary voice.
    /// Without it, TextToSpeechService falls through the chain to
    /// AVSpeechSynthesizer.
    var isElevenLabsConfigured: Bool {
        !elevenLabsAPIKey.isEmpty
    }

    /// Default voice — Rachel (`21m00Tcm4TlvDq8ikWAM`). Pinned so
    /// missing-config still produces speech identity instead of
    /// rejecting the call. See progress note for rationale.
    static let defaultElevenLabsVoiceID = "21m00Tcm4TlvDq8ikWAM"

    /// Resolved voice ID — falls back to the default if the developer
    /// didn't set `LUMO_ELEVENLABS_VOICE_ID` in env.
    var resolvedVoiceID: String {
        elevenLabsVoiceID.isEmpty ? Self.defaultElevenLabsVoiceID : elevenLabsVoiceID
    }

    static func fromBundle(_ bundle: Bundle = .main) -> AppConfig {
        let apiRaw = bundle.object(forInfoDictionaryKey: "LumoAPIBase") as? String ?? "http://localhost:3000"
        let apiURL = URL(string: apiRaw) ?? URL(string: "http://localhost:3000")!

        // URL is split scheme/host in Info.plist because xcconfig
        // truncates at `//`. Reassemble here.
        let scheme = (bundle.object(forInfoDictionaryKey: "LumoSupabaseURLScheme") as? String) ?? ""
        let host = (bundle.object(forInfoDictionaryKey: "LumoSupabaseURLHost") as? String) ?? ""
        let supabaseURL: URL? = (!scheme.isEmpty && !host.isEmpty)
            ? URL(string: "\(scheme)://\(host)")
            : nil

        let anonKey = (bundle.object(forInfoDictionaryKey: "LumoSupabaseAnonKey") as? String) ?? ""
        let elevenKey = (bundle.object(forInfoDictionaryKey: "LumoElevenLabsAPIKey") as? String) ?? ""
        let elevenVoice = (bundle.object(forInfoDictionaryKey: "LumoElevenLabsVoiceID") as? String) ?? ""

        return AppConfig(
            apiBaseURL: apiURL,
            supabaseURL: supabaseURL,
            supabaseAnonKey: anonKey,
            elevenLabsAPIKey: elevenKey,
            elevenLabsVoiceID: elevenVoice
        )
    }
}
