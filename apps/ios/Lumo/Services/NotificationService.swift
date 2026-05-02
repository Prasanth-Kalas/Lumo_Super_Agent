import Foundation
import UIKit
import UserNotifications

/// UNUserNotificationCenter wrapper + APNs registration + delegate
/// dispatch.
///
/// Lifecycle:
///  1. App launches → AppDelegate sets `UNUserNotificationCenter.delegate`
///     to the NotificationService instance and registers the four
///     `UNNotificationCategory` definitions.
///  2. The user enters the Notifications settings (or trips a path
///     that needs push) → `requestAuthorization()` shows the system
///     prompt.
///  3. On grant → `registerForRemoteNotifications()` → APNs returns a
///     device token → AppDelegate forwards via
///     `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
///     → service POSTs `/api/notifications/devices`.
///  4. Foreground notifications → `willPresent` delegate decides
///     in-app banner vs silent.
///  5. Notification tap → `didReceive` delegate forwards to
///     `NotificationActionHandler` (next deliverable).
///
/// State is process-volatile in v1 (the device id from the server lives
/// in UserDefaults so sign-out can DELETE it). MOBILE-API-1 will sync
/// authorization state across devices.

// MARK: - Models

enum NotificationAuthorizationStatus: Equatable {
    case notDetermined
    case denied
    case authorized
    case provisional
    /// User chose "ephemeral" (App Clip) — not relevant to a full app
    /// but the OS may surface this state.
    case ephemeral

    init(_ raw: UNAuthorizationStatus) {
        switch raw {
        case .notDetermined: self = .notDetermined
        case .denied:        self = .denied
        case .authorized:    self = .authorized
        case .provisional:   self = .provisional
        case .ephemeral:     self = .ephemeral
        @unknown default:    self = .notDetermined
        }
    }
}

enum NotificationServiceError: Error, LocalizedError, Equatable {
    case authorizationDenied
    case missingBundleID
    case invalidBaseURL
    case badStatus(Int, String?)
    case notRegistered

    var errorDescription: String? {
        switch self {
        case .authorizationDenied:
            return "Notifications are off. Enable them in Settings."
        case .missingBundleID:
            return "App bundle id is missing — push registration cannot proceed."
        case .invalidBaseURL:
            return "Invalid LumoAPIBase URL."
        case .badStatus(let code, let body):
            return "Notifications server returned HTTP \(code)\(body.map { ": \($0)" } ?? "")."
        case .notRegistered:
            return "Device not registered with the server yet."
        }
    }
}

struct RegisteredDevice: Codable, Equatable {
    let id: String
    let apnsToken: String
    let bundleId: String
    let environment: String
    let registeredAt: Date
}

// MARK: - Protocol

protocol NotificationServicing: AnyObject {
    /// Read the current OS-level authorization without prompting.
    func currentAuthorizationStatus() async -> NotificationAuthorizationStatus
    /// Show the system prompt if `.notDetermined`; otherwise no-op and
    /// return the current status.
    func requestAuthorization() async throws -> NotificationAuthorizationStatus
    /// Trigger UIApplication.shared.registerForRemoteNotifications. The
    /// APNs token arrives async via AppDelegate; the host calls
    /// `submitDeviceToken(_:)` with the bytes when it does.
    func registerForRemoteNotifications()
    /// POST `/api/notifications/devices` with the APNs token. Persists
    /// the returned `RegisteredDevice.id` so sign-out can unregister.
    func submitDeviceToken(_ token: Data) async throws -> RegisteredDevice
    /// DELETE `/api/notifications/devices/:id` for the most recently
    /// registered device. Called on sign-out.
    func unregisterCurrentDevice() async throws
    /// Register the four `UNNotificationCategory` definitions (called
    /// once at app launch). The action map lives in
    /// `NotificationCategoryRegistry`.
    func registerCategories()
}

// MARK: - Real implementation

final class NotificationService: NSObject, NotificationServicing {
    private let baseURL: URL
    private let session: URLSession
    private let userIDProvider: () -> String?
    private let accessTokenProvider: () -> String?
    private let environment: String
    private let bundleID: String

    /// Persisted between launches so sign-out can DELETE the right id.
    private static let storedDeviceIDKey = "lumo.notifications.deviceID"

    init(
        baseURL: URL,
        userIDProvider: @escaping () -> String?,
        accessTokenProvider: @escaping () -> String? = { nil },
        environment: String,
        bundleID: String,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
        self.userIDProvider = userIDProvider
        self.accessTokenProvider = accessTokenProvider
        self.environment = environment
        self.bundleID = bundleID
        super.init()
    }

    static func make(
        config: AppConfig,
        userIDProvider: @escaping () -> String?,
        accessTokenProvider: @escaping () -> String? = { nil },
        bundle: Bundle = .main
    ) -> NotificationService {
        let env = config.apnsUseSandbox ? "sandbox" : "production"
        let bundleID = bundle.bundleIdentifier ?? "com.lumo.rentals.ios"
        return NotificationService(
            baseURL: config.apiBaseURL,
            userIDProvider: userIDProvider,
            accessTokenProvider: accessTokenProvider,
            environment: env,
            bundleID: bundleID
        )
    }

    // MARK: - Authorization

    func currentAuthorizationStatus() async -> NotificationAuthorizationStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return NotificationAuthorizationStatus(settings.authorizationStatus)
    }

    func requestAuthorization() async throws -> NotificationAuthorizationStatus {
        let center = UNUserNotificationCenter.current()
        let current = await currentAuthorizationStatus()
        // Don't re-prompt if already determined; the system silently
        // returns the existing decision but our UI flow shouldn't
        // rely on that.
        switch current {
        case .notDetermined:
            let options: UNAuthorizationOptions = [.alert, .badge, .sound]
            _ = try await center.requestAuthorization(options: options)
            return await currentAuthorizationStatus()
        case .denied, .authorized, .provisional, .ephemeral:
            return current
        }
    }

    func registerForRemoteNotifications() {
        // Must run on main thread; UIApplication APIs require it.
        Task { @MainActor in
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    // MARK: - Token submit + unregister

    func submitDeviceToken(_ token: Data) async throws -> RegisteredDevice {
        let hexToken = token.map { String(format: "%02hhx", $0) }.joined()
        let body: [String: Any] = [
            "apnsToken": hexToken,
            "bundleId": bundleID,
            "environment": environment,
        ]
        let req = try makeRequest(
            path: "api/notifications/devices",
            method: "POST",
            jsonBody: body
        )
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response, expected: 201)
        struct DeviceResponse: Codable { let device: RegisteredDevice }
        let decoded = try decode(DeviceResponse.self, from: data)
        UserDefaults.standard.set(decoded.device.id, forKey: Self.storedDeviceIDKey)
        return decoded.device
    }

    func unregisterCurrentDevice() async throws {
        guard let id = UserDefaults.standard.string(forKey: Self.storedDeviceIDKey),
              !id.isEmpty else {
            throw NotificationServiceError.notRegistered
        }
        let req = try makeRequest(
            path: "api/notifications/devices/\(id)",
            method: "DELETE"
        )
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response)
        UserDefaults.standard.removeObject(forKey: Self.storedDeviceIDKey)
    }

    // MARK: - Categories

    func registerCategories() {
        UNUserNotificationCenter.current().setNotificationCategories(
            NotificationCategoryRegistry.allCategories()
        )
    }

    // MARK: - HTTP helpers

    private func makeRequest(
        path: String,
        method: String,
        jsonBody: [String: Any]? = nil
    ) throws -> URLRequest {
        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let token = accessTokenProvider(), !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body = jsonBody {
            req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }
        return req
    }

    private func ensureOK(
        data: Data,
        response: URLResponse,
        expected: Int = 200
    ) throws {
        guard let http = response as? HTTPURLResponse else {
            throw NotificationServiceError.badStatus(-1, nil)
        }
        let ok = http.statusCode == expected
            || (expected == 200 && (200..<300).contains(http.statusCode))
        if !ok {
            let body = String(data: data, encoding: .utf8)
            throw NotificationServiceError.badStatus(http.statusCode, body)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = Self.iso8601Fractional.date(from: raw) { return date }
            if let date = Self.iso8601Plain.date(from: raw) { return date }
            throw NotificationServiceError.badStatus(0, "invalid iso8601: \(raw)")
        }
        return try decoder.decode(type, from: data)
    }

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601Plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationService: UNUserNotificationCenterDelegate {
    /// Foreground display policy: show as banner + sound + badge for
    /// every category. v1 keeps this simple; per-category overrides
    /// (e.g. silent for low-priority proactive suggestions) can be
    /// added once we have data on user preferences.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    /// Tap-handling delegate. Forwards to `NotificationActionHandler`
    /// when one is wired by the host (LumoAppDelegate).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let handler = NotificationActionHandler.shared
        Task { @MainActor in
            handler.handle(response: response)
            completionHandler()
        }
    }
}

// MARK: - Test stub

final class FakeNotificationService: NotificationServicing {
    var status: NotificationAuthorizationStatus = .notDetermined
    var registerCallCount: Int = 0
    var registerCategoriesCallCount: Int = 0
    var submittedTokens: [Data] = []
    var unregisteredDeviceIDs: [String] = []
    var nextSubmitResult: Result<RegisteredDevice, Error> = .success(
        RegisteredDevice(
            id: "dev_fake_1",
            apnsToken: "deadbeef",
            bundleId: "com.lumo.rentals.ios.dev",
            environment: "sandbox",
            registeredAt: Date()
        )
    )
    var nextUnregisterError: Error?
    private(set) var lastSubmittedDevice: RegisteredDevice?

    func currentAuthorizationStatus() async -> NotificationAuthorizationStatus {
        status
    }

    func requestAuthorization() async throws -> NotificationAuthorizationStatus {
        if status == .notDetermined {
            // simulate user grant by default; tests can preset to .denied
            status = .authorized
        }
        return status
    }

    func registerForRemoteNotifications() {
        registerCallCount += 1
    }

    func submitDeviceToken(_ token: Data) async throws -> RegisteredDevice {
        submittedTokens.append(token)
        switch nextSubmitResult {
        case .success(let device):
            lastSubmittedDevice = device
            return device
        case .failure(let err):
            throw err
        }
    }

    func unregisterCurrentDevice() async throws {
        if let err = nextUnregisterError {
            nextUnregisterError = nil
            throw err
        }
        if let id = lastSubmittedDevice?.id {
            unregisteredDeviceIDs.append(id)
            lastSubmittedDevice = nil
        }
    }

    func registerCategories() {
        registerCategoriesCallCount += 1
    }
}
