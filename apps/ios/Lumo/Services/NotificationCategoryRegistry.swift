import Foundation
import UserNotifications

/// The four notification categories Lumo recognizes. Each maps to a
/// `UNNotificationCategory` with action buttons that surface in the
/// notification long-press / lock-screen swipe UI. Identifiers are
/// stable strings — server-side push payloads reference them in the
/// `aps.category` field — so don't rename without server coordination.

enum NotificationCategory: String, CaseIterable, Codable {
    case tripUpdate = "trip-update"
    case proactiveSuggestion = "proactive-suggestion"
    case paymentReceipt = "payment-receipt"
    case alert = "alert"

    /// Title shown in Settings → Notifications per-category toggles.
    var settingsTitle: String {
        switch self {
        case .tripUpdate:          return "Trip updates"
        case .proactiveSuggestion: return "Proactive suggestions"
        case .paymentReceipt:      return "Payment receipts"
        case .alert:               return "Security alerts"
        }
    }

    var settingsBlurb: String {
        switch self {
        case .tripUpdate:
            return "Flight, hotel, and ground status as your trip executes."
        case .proactiveSuggestion:
            return "Surface trip ideas and ways Lumo can help on session boundaries."
        case .paymentReceipt:
            return "Receipts after a payment lands."
        case .alert:
            return "Account security and system alerts. Recommended on."
        }
    }
}

enum NotificationAction: String, Codable {
    // Trip update
    case tripUpdateView = "trip-update.view"
    case tripUpdateDismiss = "trip-update.dismiss"

    // Proactive suggestion
    case proactiveAccept = "proactive-suggestion.accept"
    case proactiveDismiss = "proactive-suggestion.dismiss"
    case proactiveRemindLater = "proactive-suggestion.remind-later"

    // Payment receipt — Option A: no dispute action in v1.
    // MOBILE-PAYMENTS-2 will add `payment-receipt.dispute` →
    // `RefundFlowView` once MERCHANT-1 ships refund execution.
    case paymentReceiptView = "payment-receipt.view-receipt"
    case paymentReceiptDismiss = "payment-receipt.dismiss"

    // Alert
    case alertAcknowledge = "alert.acknowledge"
}

enum NotificationCategoryRegistry {
    /// Build the four `UNNotificationCategory` definitions for
    /// `UNUserNotificationCenter.setNotificationCategories(_:)`.
    static func allCategories() -> Set<UNNotificationCategory> {
        Set([
            tripUpdateCategory,
            proactiveSuggestionCategory,
            paymentReceiptCategory,
            alertCategory,
        ])
    }

    private static var tripUpdateCategory: UNNotificationCategory {
        UNNotificationCategory(
            identifier: NotificationCategory.tripUpdate.rawValue,
            actions: [
                UNNotificationAction(
                    identifier: NotificationAction.tripUpdateView.rawValue,
                    title: "View trip",
                    options: [.foreground]
                ),
                UNNotificationAction(
                    identifier: NotificationAction.tripUpdateDismiss.rawValue,
                    title: "Dismiss",
                    options: []
                ),
            ],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
    }

    private static var proactiveSuggestionCategory: UNNotificationCategory {
        UNNotificationCategory(
            identifier: NotificationCategory.proactiveSuggestion.rawValue,
            actions: [
                UNNotificationAction(
                    identifier: NotificationAction.proactiveAccept.rawValue,
                    title: "Plan it",
                    options: [.foreground]
                ),
                UNNotificationAction(
                    identifier: NotificationAction.proactiveRemindLater.rawValue,
                    title: "Remind me later",
                    options: []
                ),
                UNNotificationAction(
                    identifier: NotificationAction.proactiveDismiss.rawValue,
                    title: "Dismiss",
                    options: [.destructive]
                ),
            ],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
    }

    /// Per Option A confirmed by the reviewer on 2026-04-30:
    /// view-receipt + dismiss. Dispute action belongs to
    /// MOBILE-PAYMENTS-2 once MERCHANT-1's refund execution lands.
    /// The `aps.category` payload value stays `payment-receipt` so
    /// the notification routes through this registry; if MOBILE-
    /// PAYMENTS-2 needs a separate category, it can add
    /// `payment-receipt-with-refund` or extend this one.
    private static var paymentReceiptCategory: UNNotificationCategory {
        UNNotificationCategory(
            identifier: NotificationCategory.paymentReceipt.rawValue,
            actions: [
                UNNotificationAction(
                    identifier: NotificationAction.paymentReceiptView.rawValue,
                    title: "View receipt",
                    options: [.foreground]
                ),
                UNNotificationAction(
                    identifier: NotificationAction.paymentReceiptDismiss.rawValue,
                    title: "Dismiss",
                    options: []
                ),
            ],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
    }

    private static var alertCategory: UNNotificationCategory {
        UNNotificationCategory(
            identifier: NotificationCategory.alert.rawValue,
            actions: [
                UNNotificationAction(
                    identifier: NotificationAction.alertAcknowledge.rawValue,
                    title: "Acknowledge",
                    options: [.foreground, .authenticationRequired]
                ),
            ],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
    }
}
