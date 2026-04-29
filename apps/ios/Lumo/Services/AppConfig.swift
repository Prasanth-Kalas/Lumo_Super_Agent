import Foundation

/// Read-only access to build-time configuration baked into the app
/// bundle's Info.plist by xcconfig substitution. The xcconfig values
/// come from `~/.config/lumo/.env` via `scripts/ios-write-xcconfig.sh`;
/// missing values resolve to empty strings and surface as
/// `isAuthConfigured == false` so callers can render an explicit
/// "configuration missing" UX instead of crashing.

struct AppConfig {
    let apiBaseURL: URL
    let supabaseURL: URL?
    let supabaseAnonKey: String

    var isAuthConfigured: Bool {
        supabaseURL != nil && !supabaseAnonKey.isEmpty
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

        return AppConfig(
            apiBaseURL: apiURL,
            supabaseURL: supabaseURL,
            supabaseAnonKey: anonKey
        )
    }
}
