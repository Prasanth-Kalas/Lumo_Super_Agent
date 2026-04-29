import SwiftUI

/// Top-level navigation shell shown after sign-in. Three tabs (Chat,
/// Trips, Settings), each with its own `NavigationStack` so push-style
/// sub-screens preserve their state when the user switches tabs.

struct RootView: View {
    private let chatService: ChatService
    private let tts: TextToSpeechServicing
    private let paymentService: PaymentServicing
    private let receiptStore: ReceiptStoring
    private let appConfig: AppConfig
    private let proactiveCache: ProactiveMomentsCache
    private let proactiveClient: ProactiveMomentsFetching
    private let onSignOut: () -> Void
    @State private var selection: Tab

    init(
        chatService: ChatService,
        tts: TextToSpeechServicing,
        paymentService: PaymentServicing,
        receiptStore: ReceiptStoring,
        appConfig: AppConfig,
        proactiveCache: ProactiveMomentsCache,
        proactiveClient: ProactiveMomentsFetching,
        onSignOut: @escaping () -> Void
    ) {
        self.chatService = chatService
        self.tts = tts
        self.paymentService = paymentService
        self.receiptStore = receiptStore
        self.appConfig = appConfig
        self.proactiveCache = proactiveCache
        self.proactiveClient = proactiveClient
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
                ChatTab(
                    chatService: chatService,
                    tts: tts,
                    proactiveCache: proactiveCache,
                    proactiveClient: proactiveClient
                )
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
                SettingsTab(
                    paymentService: paymentService,
                    receiptStore: receiptStore,
                    appConfig: appConfig,
                    onSignOut: onSignOut
                )
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape.fill")
            }
            .tag(Tab.settings)
        }
        .tint(LumoColors.cyan)
        .onReceive(NotificationActionHandler.shared.$lastRoute) { route in
            // Bridge notification routes into tab selection. Deep nav
            // (push to ReceiptDetailView, prefill chat composer)
            // remains TODO — for v1 we land on the right tab and the
            // user takes the next step.
            guard let route else { return }
            switch route {
            case .openTrips:
                selection = .trips
            case .openChatWithPrefill:
                selection = .chat
            case .openReceiptID:
                selection = .settings
            case .openAlertsCenter, .dismissed, .snoozedAcknowledged:
                break
            }
        }
    }
}

