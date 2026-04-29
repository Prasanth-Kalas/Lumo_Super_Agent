import SwiftUI

/// Top-level navigation shell shown after sign-in. Three tabs (Chat,
/// Trips, Settings), each with its own `NavigationStack` so push-style
/// sub-screens preserve their state when the user switches tabs.

struct RootView: View {
    private let chatService: ChatService
    private let onSignOut: () -> Void
    @State private var selection: Tab

    init(chatService: ChatService, onSignOut: @escaping () -> Void) {
        self.chatService = chatService
        self.onSignOut = onSignOut
        // DEBUG-only `-LumoStartTab` launch arg lets the screenshot
        // script select Trips / Settings on cold-launch without
        // simulating a tap. Default is Chat. Compiled out in Release.
        #if DEBUG
        let raw = (UserDefaults.standard.string(forKey: "LumoStartTab") ?? "").lowercased()
        switch raw {
        case "trips":    self._selection = State(initialValue: .trips)
        case "settings": self._selection = State(initialValue: .settings)
        default:         self._selection = State(initialValue: .chat)
        }
        #else
        self._selection = State(initialValue: .chat)
        #endif
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
