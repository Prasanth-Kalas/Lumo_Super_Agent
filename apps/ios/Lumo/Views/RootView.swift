import SwiftUI

/// Top-level navigation shell shown after sign-in. Three tabs (Chat,
/// Trips, Settings), each with its own `NavigationStack` so push-style
/// sub-screens preserve their state when the user switches tabs.

struct RootView: View {
    private let chatService: ChatService
    private let onSignOut: () -> Void
    @State private var selection: Tab = .chat

    init(chatService: ChatService, onSignOut: @escaping () -> Void) {
        self.chatService = chatService
        self.onSignOut = onSignOut
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
                SettingsTab(onSignOut: onSignOut)
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape.fill")
            }
            .tag(Tab.settings)
        }
        .tint(LumoColors.cyan)
    }
}
