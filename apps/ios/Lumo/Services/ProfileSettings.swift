import Foundation

/// Persisted user profile preferences. Mirrors the web app's
/// UserProfile shape on the parts the iOS surface edits today
/// (display name + travel preferences). Storage = UserDefaults; the
/// real swap to the server-side `/api/memory/profile` endpoint will
/// be a future sprint (`MOBILE-PROFILE-SYNC-1` or later).
///
/// Same UserDefaults pattern as `NotificationSettings` and
/// `VoiceSettings` for consistency. Static API on the type — the
/// view binds directly through small @State mirrors.
enum ProfileSettings {
    private static let displayNameKey = "LumoProfile.displayName"
    private static let cabinClassKey  = "LumoProfile.cabinClass"
    private static let seatPrefKey    = "LumoProfile.seatPreference"

    static var displayName: String? {
        get { UserDefaults.standard.string(forKey: displayNameKey) }
        set {
            if let newValue, !newValue.isEmpty {
                UserDefaults.standard.set(newValue, forKey: displayNameKey)
            } else {
                UserDefaults.standard.removeObject(forKey: displayNameKey)
            }
        }
    }

    static var cabinClass: CabinClass {
        get {
            if let raw = UserDefaults.standard.string(forKey: cabinClassKey),
               let parsed = CabinClass(rawValue: raw) {
                return parsed
            }
            return .noPreference
        }
        set {
            if newValue == .noPreference {
                UserDefaults.standard.removeObject(forKey: cabinClassKey)
            } else {
                UserDefaults.standard.set(newValue.rawValue, forKey: cabinClassKey)
            }
        }
    }

    static var seatPreference: SeatPreference {
        get {
            if let raw = UserDefaults.standard.string(forKey: seatPrefKey),
               let parsed = SeatPreference(rawValue: raw) {
                return parsed
            }
            return .noPreference
        }
        set {
            if newValue == .noPreference {
                UserDefaults.standard.removeObject(forKey: seatPrefKey)
            } else {
                UserDefaults.standard.set(newValue.rawValue, forKey: seatPrefKey)
            }
        }
    }

    enum CabinClass: String, CaseIterable, Identifiable {
        case noPreference     = "no_preference"
        case economy          = "economy"
        case premiumEconomy   = "premium_economy"
        case business         = "business"
        case first            = "first"

        var id: String { rawValue }
        var label: String {
            switch self {
            case .noPreference:   return "No preference"
            case .economy:        return "Economy"
            case .premiumEconomy: return "Premium economy"
            case .business:       return "Business"
            case .first:          return "First"
            }
        }
    }

    enum SeatPreference: String, CaseIterable, Identifiable {
        case noPreference = "no_preference"
        case aisle        = "aisle"
        case window       = "window"

        var id: String { rawValue }
        var label: String {
            switch self {
            case .noPreference: return "No preference"
            case .aisle:        return "Aisle"
            case .window:       return "Window"
            }
        }
    }
}
