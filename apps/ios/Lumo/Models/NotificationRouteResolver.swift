import Foundation

/// Pure resolver — turns a `NotificationRoute` into a path-mutation
/// instruction for the ChatGPT-style nav arch (NavigationStack + drawer
/// destinations). Extracted from `RootView` so unit tests can verify
/// the deep-link semantics without spinning up SwiftUI.
///
/// Resolution rules:
///   • `.openTrips`                → path = [.trips]
///   • `.openReceiptID(nil)`       → path = [.receipts]
///   • `.openReceiptID("rcpt_42")` → path = [.receipts, .receiptDetail("rcpt_42")]
///   • `.openChatWithPrefill("…")` → path = [], chat input = "…"
///   • `.openAlertsCenter`         → path = [.settings]
///       (no dedicated alerts surface today; settings owns notification prefs)
///   • `.dismissed`, `.snoozedAcknowledged` → no change (kind=noChange).
///
/// The caller (RootView) is responsible for actually applying the
/// resolution to its `NavigationPath` + `chatViewModel.input`.
enum NotificationRouteResolver {
    enum Resolution: Equatable {
        case noChange
        case replace(path: [DrawerDestination], chatInput: String?)
    }

    static func resolve(_ route: NotificationRoute) -> Resolution {
        switch route {
        case .openTrips:
            return .replace(path: [.trips], chatInput: nil)
        case .openReceiptID(let id):
            if let id, !id.isEmpty {
                return .replace(path: [.receipts, .receiptDetail(id)], chatInput: nil)
            }
            return .replace(path: [.receipts], chatInput: nil)
        case .openChatWithPrefill(let prefill):
            return .replace(path: [], chatInput: prefill)
        case .openAlertsCenter:
            return .replace(path: [.settings], chatInput: nil)
        case .dismissed, .snoozedAcknowledged:
            return .noChange
        }
    }
}
