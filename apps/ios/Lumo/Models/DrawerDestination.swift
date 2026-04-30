import Foundation

/// Hashable destinations the side drawer pushes onto the chat
/// NavigationStack. Kept in a model file so test code (and the
/// notification routing layer) can hand the same values around
/// without depending on SwiftUI.
///
/// IOS-MIRROR-WEB-1 expanded the set to match the web mobile drawer's
/// EXPLORE section (Workspace, Trips, Receipts, History, Memory,
/// Settings, Marketplace). `profile` and `receiptDetail` aren't in
/// EXPLORE — they're pushed programmatically (notification deep-link
/// for receipts, future Settings → Profile link for profile).
enum DrawerDestination: Hashable {
    case workspace
    case trips
    case receipts
    case receiptDetail(String)
    case history
    case memory
    case settings
    case marketplace
    case profile
}

/// One entry in the drawer's "Recent Chats" list.
struct RecentChatItem: Identifiable, Equatable, Hashable, Codable {
    let id: String         // session id
    let title: String      // best-effort summary, usually first user message
    let updatedAt: Date
}
