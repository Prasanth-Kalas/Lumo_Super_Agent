import Combine
import Foundation
import UserNotifications

/// Central dispatch for notification taps + action buttons.
///
/// `NotificationService` (the UNUserNotificationCenter delegate) calls
/// `handle(response:)` on the shared instance. The handler decodes
/// the action identifier, performs side-effect work (e.g. POST
/// /api/proactive/snooze), and publishes a `NotificationRoute` for
/// the host UI to consume.
///
/// The host (RootView via @StateObject of an observer) subscribes to
/// `routePublisher` and applies the route — switch tab, push view,
/// prefill chat, etc. Keeping the navigation effect out of this
/// handler lets unit tests verify routing without instantiating
/// SwiftUI.
///
/// Singleton because the UNUserNotificationCenter delegate has no
/// natural injection point and the routes must survive across view
/// re-creation. The shared instance is constructed by `LumoApp` at
/// boot with the live snooze API client; tests can swap via
/// `installForTesting(...)`.

enum NotificationRoute: Equatable {
    case openTrips
    case openChatWithPrefill(String)
    case openReceiptID(String?)
    case openAlertsCenter
    case dismissed
    case snoozedAcknowledged
}

/// Side-effect surface — extracted so tests don't hit the network.
protocol NotificationSnoozing: AnyObject {
    func snooze(momentID: String, until: Date) async throws
}

final class NotificationActionHandler: ObservableObject {
    static let shared = NotificationActionHandler()

    @Published private(set) var lastRoute: NotificationRoute?

    private(set) var snoozer: NotificationSnoozing?

    private init() {}

    /// Wire dependencies. Called once from `LumoApp.init()` after
    /// constructing the live `NotificationSnoozeClient`.
    func install(snoozer: NotificationSnoozing) {
        self.snoozer = snoozer
    }

    /// Test-only injection.
    func installForTesting(snoozer: NotificationSnoozing) {
        self.snoozer = snoozer
        self.lastRoute = nil
    }

    /// Decode an `UNNotificationResponse` into a `NotificationRoute`,
    /// fire any side effects, and publish.
    @MainActor
    func handle(response: UNNotificationResponse) {
        let userInfo = response.notification.request.content.userInfo
        let categoryRaw = response.notification.request.content.categoryIdentifier
        let actionRaw = response.actionIdentifier
        handle(categoryIdentifier: categoryRaw, actionIdentifier: actionRaw, userInfo: userInfo)
    }

    /// Test-friendly entry point — the response decoding is trivial,
    /// so unit tests bypass UNNotificationResponse (which has no
    /// public init) and call this method directly with the unpacked
    /// triple.
    @MainActor
    func handle(
        categoryIdentifier categoryRaw: String,
        actionIdentifier actionRaw: String,
        userInfo: [AnyHashable: Any]
    ) {
        // System-default actions: tap-to-open and explicit dismiss.
        switch actionRaw {
        case UNNotificationDefaultActionIdentifier:
            // Tap on the body. Use the category to decide where to land.
            handleDefaultTap(categoryRaw: categoryRaw, userInfo: userInfo)
            return
        case UNNotificationDismissActionIdentifier:
            publish(.dismissed)
            return
        default:
            break
        }

        guard let action = NotificationAction(rawValue: actionRaw) else {
            // Unknown action id — fall through to default tap to avoid
            // swallowing the user's gesture entirely.
            handleDefaultTap(categoryRaw: categoryRaw, userInfo: userInfo)
            return
        }
        handleExplicit(action: action, userInfo: userInfo)
    }

    // MARK: - Routing

    private func handleDefaultTap(
        categoryRaw: String,
        userInfo: [AnyHashable: Any]
    ) {
        guard let category = NotificationCategory(rawValue: categoryRaw) else {
            return
        }
        switch category {
        case .tripUpdate:
            publish(.openTrips)
        case .proactiveSuggestion:
            let prefill = (userInfo["chatPrefill"] as? String)
                ?? (userInfo["headline"] as? String)
                ?? "Tell me more about that proactive suggestion."
            publish(.openChatWithPrefill(prefill))
        case .paymentReceipt:
            publish(.openReceiptID(userInfo["receiptID"] as? String))
        case .alert:
            publish(.openAlertsCenter)
        }
    }

    private func handleExplicit(
        action: NotificationAction,
        userInfo: [AnyHashable: Any]
    ) {
        switch action {
        case .tripUpdateView:
            publish(.openTrips)
        case .tripUpdateDismiss:
            publish(.dismissed)

        case .proactiveAccept:
            let prefill = (userInfo["chatPrefill"] as? String)
                ?? (userInfo["headline"] as? String)
                ?? "Yes, plan that for me."
            publish(.openChatWithPrefill(prefill))
        case .proactiveDismiss:
            publish(.dismissed)
        case .proactiveRemindLater:
            // Fire-and-forget snooze 4h from now (matches default
            // background-fetch cadence). The receipt-publishing has
            // to happen even if the snooze request fails — the user
            // tapped the button.
            if let momentID = userInfo["momentID"] as? String,
               let snoozer {
                Task {
                    try? await snoozer.snooze(
                        momentID: momentID,
                        until: Date().addingTimeInterval(4 * 3_600)
                    )
                }
            }
            publish(.snoozedAcknowledged)

        case .paymentReceiptView:
            publish(.openReceiptID(userInfo["receiptID"] as? String))
        case .paymentReceiptDismiss:
            publish(.dismissed)

        case .alertAcknowledge:
            publish(.openAlertsCenter)
        }
    }

    private func publish(_ route: NotificationRoute) {
        lastRoute = route
    }
}

// MARK: - Live snooze client

/// Default `NotificationSnoozing` implementation — POSTs the
/// /api/proactive/snooze stub. MERCHANT-1-style swap path is
/// documented on the server stub: replace the route body with a
/// PATCH to `/api/proactive-moments/:id` once `snoozed` is an
/// accepted status.
final class NotificationSnoozeClient: NotificationSnoozing {
    private let baseURL: URL
    private let session: URLSession
    private let userIDProvider: () -> String?

    init(
        baseURL: URL,
        userIDProvider: @escaping () -> String?,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.userIDProvider = userIDProvider
        self.session = session
    }

    func snooze(momentID: String, until: Date) async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let body: [String: Any] = [
            "momentId": momentID,
            "snoozeUntilISO": formatter.string(from: until),
        ]
        let url = baseURL.appendingPathComponent("api/proactive/snooze")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        let (_, response) = try await session.data(for: req)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw NotificationServiceError.badStatus(http.statusCode, nil)
        }
    }
}

/// Test stub — records calls without hitting the network.
final class FakeNotificationSnoozer: NotificationSnoozing {
    private(set) var snoozeCalls: [(momentID: String, until: Date)] = []
    var nextError: Error?

    func snooze(momentID: String, until: Date) async throws {
        if let err = nextError { nextError = nil; throw err }
        snoozeCalls.append((momentID: momentID, until: until))
    }
}
