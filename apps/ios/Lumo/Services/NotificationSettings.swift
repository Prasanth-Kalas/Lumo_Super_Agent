import Foundation

/// User preferences for notifications. UserDefaults-backed for v1;
/// MOBILE-API-1 will sync across devices.
///
/// The system-level OS toggle (the one the iOS Settings app shows)
/// always takes precedence over these — these are app-side filters
/// applied when we decide whether to *render* a payload that the OS
/// already permitted to be shown. The notification arrives at the OS
/// regardless of these preferences; the app suppresses content based
/// on `isCategoryEnabled(_:)` and `isInQuietHours(at:)`.

enum NotificationSettings {
    private enum Keys {
        static let masterEnabled = "lumo.notifications.masterEnabled"
        static let categoryPrefix = "lumo.notifications.category."
        static let quietStart = "lumo.notifications.quietStart"
        static let quietEnd = "lumo.notifications.quietEnd"
    }

    // MARK: - Master toggle

    static var isPushEnabled: Bool {
        get {
            // Default to true so first-time users don't have to opt in
            // again after granting OS-level authorization.
            (UserDefaults.standard.object(forKey: Keys.masterEnabled) as? Bool) ?? true
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Keys.masterEnabled)
        }
    }

    // MARK: - Per-category toggles

    static func isCategoryEnabled(_ category: NotificationCategory) -> Bool {
        let key = Keys.categoryPrefix + category.rawValue
        // Default to true — same rationale as master.
        return (UserDefaults.standard.object(forKey: key) as? Bool) ?? true
    }

    static func setCategoryEnabled(_ category: NotificationCategory, _ enabled: Bool) {
        let key = Keys.categoryPrefix + category.rawValue
        UserDefaults.standard.set(enabled, forKey: key)
    }

    // MARK: - Quiet hours

    /// Start of quiet hours as minutes-since-midnight (0–1439). nil
    /// when the user hasn't configured quiet hours.
    static var quietHoursStart: Int? {
        get {
            guard UserDefaults.standard.object(forKey: Keys.quietStart) != nil else {
                return nil
            }
            return UserDefaults.standard.integer(forKey: Keys.quietStart)
        }
        set {
            if let v = newValue {
                UserDefaults.standard.set(v, forKey: Keys.quietStart)
            } else {
                UserDefaults.standard.removeObject(forKey: Keys.quietStart)
            }
        }
    }

    static var quietHoursEnd: Int? {
        get {
            guard UserDefaults.standard.object(forKey: Keys.quietEnd) != nil else {
                return nil
            }
            return UserDefaults.standard.integer(forKey: Keys.quietEnd)
        }
        set {
            if let v = newValue {
                UserDefaults.standard.set(v, forKey: Keys.quietEnd)
            } else {
                UserDefaults.standard.removeObject(forKey: Keys.quietEnd)
            }
        }
    }

    /// Returns true when the given moment falls inside the configured
    /// quiet-hours range. Wraps midnight correctly (e.g. 22:00 → 07:00).
    static func isInQuietHours(at date: Date = Date()) -> Bool {
        guard let start = quietHoursStart, let end = quietHoursEnd, start != end else {
            return false
        }
        let cal = Calendar.current
        let comps = cal.dateComponents([.hour, .minute], from: date)
        let now = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
        if start < end {
            // Same-day window: e.g. 13:00–17:00.
            return now >= start && now < end
        } else {
            // Wraps midnight: e.g. 22:00–07:00.
            return now >= start || now < end
        }
    }

    /// Convenience encode/decode — Date↔minutes-since-midnight in the
    /// device's local calendar.
    static func minutesSinceMidnight(_ date: Date, calendar: Calendar = .current) -> Int {
        let comps = calendar.dateComponents([.hour, .minute], from: date)
        return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    }

    static func dateFromMinutesSinceMidnight(_ minutes: Int, calendar: Calendar = .current) -> Date {
        var comps = DateComponents()
        comps.hour = minutes / 60
        comps.minute = minutes % 60
        return calendar.date(from: comps) ?? Date()
    }

    // MARK: - Test helpers

    static func resetForTesting() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: Keys.masterEnabled)
        for category in NotificationCategory.allCases {
            defaults.removeObject(forKey: Keys.categoryPrefix + category.rawValue)
        }
        defaults.removeObject(forKey: Keys.quietStart)
        defaults.removeObject(forKey: Keys.quietEnd)
    }
}
