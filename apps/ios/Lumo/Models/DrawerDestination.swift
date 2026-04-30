import Foundation

/// Hashable destinations the side drawer pushes onto the chat
/// NavigationStack. Kept in a model file so test code (and the
/// notification routing layer) can hand the same values around
/// without depending on SwiftUI.
enum DrawerDestination: Hashable {
    case trips
    case receipts
    case receiptDetail(String)
    case profile
    case settings
}

/// One entry in the drawer's "Recent Chats" list.
struct RecentChatItem: Identifiable, Equatable, Hashable, Codable {
    let id: String         // session id
    let title: String      // best-effort summary, usually first user message
    let updatedAt: Date
}
