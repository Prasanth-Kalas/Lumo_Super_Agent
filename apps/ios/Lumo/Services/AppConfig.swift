import Foundation

/// Read-only access to build-time configuration baked into the app
/// bundle's Info.plist by xcconfig substitution. The xcconfig values
/// come from `~/.config/lumo/.env` via `scripts/ios-write-xcconfig.sh`;
/// missing values resolve to empty strings and surface as
/// `isAuthConfigured` / `isStripeConfigured` flags so callers can
/// render an explicit "configuration missing" UX instead of
/// crashing.
///
/// **Voice provider**: Deepgram. The long-lived
/// `LUMO_DEEPGRAM_API_KEY` lives only on the server — iOS calls
/// `POST /api/audio/deepgram-token` to mint a 60s bearer token. No
/// Deepgram key in this struct (privacy contract,
/// `docs/contracts/deepgram-token.md`). Voice picker preference
/// lives in `VoiceSettings.voiceId`.

struct AppConfig {
    let apiBaseURL: URL
    let supabaseURL: URL?
    let supabaseAnonKey: String
    let stripePublishableKey: String
    let stripeMerchantID: String
    /// True when the iOS client is targeting the APNs sandbox (the
    /// `aps-environment=development` entitlement). Flips off when the
    /// Apple Developer team registers the production APNs auth key
    /// and the entitlement is updated to `production`. Surfaces in
    /// Settings as a "sandbox notifications" indicator so QA can tell
    /// at a glance which APNs environment a build targets.
    let apnsUseSandbox: Bool

    var isAuthConfigured: Bool {
        supabaseURL != nil && !supabaseAnonKey.isEmpty
    }

    /// True when Stripe is configured. Test-mode publishable keys start
    /// with `pk_test_`; live-mode start with `pk_live_`. We only ship
    /// test mode in this sprint — `isStripeLiveMode` is exposed so
    /// PaymentMethodsView can render a "TEST MODE" banner. Real-money
    /// execution lands in MERCHANT-1.
    var isStripeConfigured: Bool {
        !stripePublishableKey.isEmpty
    }

    var isStripeLiveMode: Bool {
        stripePublishableKey.hasPrefix("pk_live_")
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
        let stripeKey = (bundle.object(forInfoDictionaryKey: "LumoStripePublishableKey") as? String) ?? ""
        let stripeMerchant = (bundle.object(forInfoDictionaryKey: "LumoStripeMerchantID") as? String) ?? ""
        let apnsSandboxRaw = (bundle.object(forInfoDictionaryKey: "LumoAPNsUseSandbox") as? String) ?? "true"
        // xcconfig values come through as strings; treat anything other
        // than literal "false" (case-insensitive) as truthy so the
        // default reads as sandbox.
        let apnsSandbox = apnsSandboxRaw.lowercased() != "false"

        return AppConfig(
            apiBaseURL: apiURL,
            supabaseURL: supabaseURL,
            supabaseAnonKey: anonKey,
            stripePublishableKey: stripeKey,
            stripeMerchantID: stripeMerchant,
            apnsUseSandbox: apnsSandbox
        )
    }
}
