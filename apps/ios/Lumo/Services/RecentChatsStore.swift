import Foundation

/// Local cache of past chat sessions — populates the drawer's
/// "Recent Chats" list. Server-side history sync is a future sprint
/// (MOBILE-CHAT-2); for now we persist to UserDefaults so the list
/// survives app restart but doesn't cross devices.
///
/// Capped at a small number of entries to keep the drawer tight and
/// the JSON blob trivially small. Newer entries push older ones out.
@MainActor
final class RecentChatsStore: ObservableObject {
    @Published private(set) var items: [RecentChatItem] = []

    nonisolated static let defaultsKey = "LumoRecentChats.v1"
    nonisolated static let maxItems = 30

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = RecentChatsStore.defaultsKey) {
        self.defaults = defaults
        self.key = key
        load()
    }

    /// Insert-or-update the entry with the given session id, dedup by id,
    /// move to top. Trims to `maxItems`.
    func upsert(id: String, title: String, updatedAt: Date = Date()) {
        var next = items.filter { $0.id != id }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeTitle = trimmedTitle.isEmpty ? "New chat" : String(trimmedTitle.prefix(80))
        next.insert(
            RecentChatItem(id: id, title: safeTitle, updatedAt: updatedAt),
            at: 0
        )
        if next.count > Self.maxItems {
            next = Array(next.prefix(Self.maxItems))
        }
        items = next
        persist()
    }

    /// Drop the entry with the given session id. No-op if missing.
    func remove(id: String) {
        let next = items.filter { $0.id != id }
        guard next.count != items.count else { return }
        items = next
        persist()
    }

    /// Wipe everything. Wired to the Sign Out flow so a fresh sign-in
    /// doesn't see the prior account's recents.
    func clear() {
        items = []
        defaults.removeObject(forKey: key)
    }

    // MARK: - Persistence

    private func load() {
        guard let data = defaults.data(forKey: key) else { return }
        if let decoded = try? JSONDecoder().decode([RecentChatItem].self, from: data) {
            items = decoded
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(items) {
            defaults.set(data, forKey: key)
        }
    }
}
