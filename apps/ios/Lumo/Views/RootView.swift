import SwiftUI

/// Top-level navigation shell. Three tabs (Chat, Trips, Settings),
/// each owns its own `NavigationStack` so push-style sub-screens
/// preserve their own state when the user switches tabs and returns.

struct RootView: View {
    private let chatService: ChatService
    @State private var selection: Tab = .chat

    init(chatService: ChatService) {
        self.chatService = chatService
    }

    enum Tab: Hashable {
        case chat
        case trips
        case settings
    }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                ChatTab(chatService: chatService)
            }
            .tabItem {
                Label("Chat", systemImage: "bubble.left.and.bubble.right.fill")
            }
            .tag(Tab.chat)

            NavigationStack {
                TripsTab()
            }
            .tabItem {
                Label("Trips", systemImage: "airplane")
            }
            .tag(Tab.trips)

            NavigationStack {
                SettingsTab()
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape.fill")
            }
            .tag(Tab.settings)
        }
        .tint(LumoColors.cyan)
    }
}
