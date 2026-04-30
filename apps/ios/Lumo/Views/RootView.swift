import SwiftUI

/// Top-level shell for signed-in users — ChatGPT-style single chat
/// surface with a slide-in drawer from the left for navigation.
///
/// Architecture:
///   • Root = `NavigationStack` hosting the chat surface (proactive
///     cards above the composer, ChatView fills the rest). The chat
///     surface gets a `BurgerMenuButton` as its leading toolbar item.
///   • Sub-screens (`TripsView`, `ReceiptHistoryView`, `ProfileView`,
///     `SettingsView`) are pushed via `navigationDestination(for:
///     DrawerDestination.self)`. Each shows a system back button —
///     the burger only lives on the chat root.
///   • `SideDrawerView` is overlaid on top of the NavigationStack.
///     Tap a row → `path.append(destination)` + close drawer.
///   • `NotificationActionHandler` route subscriptions are wired to
///     the same `path` so deep links from a notification land on the
///     correct destination via the new arch instead of the old tab-
///     selection switch.
///
/// State ownership:
///   • `chatViewModel` lives here (not inside `ChatView`) so the
///     drawer's "New Chat" can call `reset()` and a notification
///     prefill can mutate `input` without re-creating the view tree.
///   • `recentChats` is a `RecentChatsStore` so the drawer can render
///     past sessions without spinning up the chat thread first.
struct RootView: View {
    private let chatService: ChatService
    private let tts: TextToSpeechServicing
    private let paymentService: PaymentServicing
    private let receiptStore: ReceiptStoring
    private let appConfig: AppConfig
    private let proactiveClient: ProactiveMomentsFetching
    private let onSignOut: () -> Void

    @StateObject private var chatViewModel: ChatViewModel
    @StateObject private var voiceComposer: VoiceComposerViewModel
    @StateObject private var proactiveViewModel: ProactiveMomentsViewModel
    @StateObject private var recentChats = RecentChatsStore()

    @State private var path = NavigationPath()
    @State private var drawerOpen: Bool = false
    @State private var showSignOutConfirm: Bool = false

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
        self.proactiveClient = proactiveClient
        self.onSignOut = onSignOut

        _chatViewModel = StateObject(
            wrappedValue: ChatViewModel(service: chatService, tts: tts)
        )
        _voiceComposer = StateObject(
            wrappedValue: VoiceComposerViewModel(speech: SpeechRecognitionService())
        )
        _proactiveViewModel = StateObject(
            wrappedValue: ProactiveMomentsViewModel(
                cache: proactiveCache,
                fetcher: proactiveClient
            )
        )
    }

    var body: some View {
        ZStack {
            NavigationStack(path: $path) {
                chatRoot
                    .navigationTitle("Lumo")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .navigationBarLeading) {
                            BurgerMenuButton(isOpen: $drawerOpen)
                        }
                    }
                    .navigationDestination(for: DrawerDestination.self) { dest in
                        destinationView(for: dest)
                    }
            }

            SideDrawerView(
                isOpen: $drawerOpen,
                recents: recentChats.items,
                signedIn: true,
                onNewChat: handleNewChat,
                onSelectRecent: handleSelectRecent,
                onSelectDestination: handleSelectDestination,
                onSignOut: { showSignOutConfirm = true }
            )
        }
        .confirmationDialog(
            "Sign out of Lumo?",
            isPresented: $showSignOutConfirm,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                recentChats.clear()
                onSignOut()
            }
            Button("Cancel", role: .cancel, action: {})
        } message: {
            Text("You'll need to sign in again to use the app.")
        }
        .onReceive(NotificationActionHandler.shared.$lastRoute) { route in
            handleNotificationRoute(route)
        }
        .task { await applyDebugLaunchArgs() }
    }

    // MARK: - Chat root

    private var chatRoot: some View {
        VStack(spacing: 0) {
            // Proactive cards above the composer — ChatView's safeAreaInset
            // pins the composer to the bottom, so the cards naturally
            // appear above it. No layout change from the pre-redesign
            // ChatTab.
            ProactiveMomentsView(viewModel: proactiveViewModel) { moment in
                proactiveViewModel.dismiss(moment.id)
            }
            ChatView(viewModel: chatViewModel, voiceComposer: voiceComposer)
        }
    }

    // MARK: - Destination routing

    @ViewBuilder
    private func destinationView(for destination: DrawerDestination) -> some View {
        switch destination {
        case .trips:
            TripsView()
        case .receipts:
            ReceiptHistoryView(store: receiptStore)
        case .receiptDetail(let receiptID):
            ReceiptDetailLookupView(receiptID: receiptID, store: receiptStore)
        case .profile:
            ProfileView()
        case .settings:
            SettingsView(
                paymentService: paymentService,
                receiptStore: receiptStore,
                appConfig: appConfig,
                onSignOut: onSignOut
            )
        }
    }

    private func handleSelectDestination(_ destination: DrawerDestination) {
        path.append(destination)
    }

    private func handleSelectRecent(_ item: RecentChatItem) {
        // Without server-side history sync (MOBILE-CHAT-2), opening a
        // recent doesn't restore its messages — it just bumps the
        // entry's timestamp and pops to the chat root. Future sprint
        // will swap this for a real session-restore path.
        recentChats.upsert(id: item.id, title: item.title, updatedAt: Date())
        path = NavigationPath()
    }

    private func handleNewChat() {
        chatViewModel.reset()
        path = NavigationPath()
    }

    // MARK: - Notification route bridge

    private func handleNotificationRoute(_ route: NotificationRoute?) {
        guard let route else { return }
        switch route {
        case .openTrips:
            path = NavigationPath()
            path.append(DrawerDestination.trips)
        case .openChatWithPrefill(let prefill):
            path = NavigationPath()
            chatViewModel.input = prefill
        case .openReceiptID(let id):
            path = NavigationPath()
            path.append(DrawerDestination.receipts)
            if let id, !id.isEmpty {
                path.append(DrawerDestination.receiptDetail(id))
            }
        case .openAlertsCenter:
            // No dedicated alerts surface yet. Settings is the closest
            // related landing (notification preferences live there).
            path = NavigationPath()
            path.append(DrawerDestination.settings)
        case .dismissed, .snoozedAcknowledged:
            break
        }
    }

    // MARK: - DEBUG launch args

    @MainActor
    private func applyDebugLaunchArgs() async {
        #if DEBUG
        let defaults = UserDefaults.standard
        // Seed deterministic recent chats for screenshot capture.
        if defaults.bool(forKey: "LumoSeedRecents") {
            seedFixtureRecents()
        }
        // Open drawer on cold launch (drawer-state shots).
        if defaults.bool(forKey: "LumoStartDrawerOpen") {
            drawerOpen = true
        }
        // Pre-seed composer with text for the composer-with-text shot.
        if let prefill = defaults.string(forKey: "LumoStartChatInput"),
           !prefill.isEmpty {
            chatViewModel.input = prefill
        }
        // Drop straight into a drawer destination on cold launch.
        if let raw = defaults.string(forKey: "LumoStartDestination") {
            switch raw.lowercased() {
            case "trips":    path.append(DrawerDestination.trips)
            case "receipts": path.append(DrawerDestination.receipts)
            case "profile":  path.append(DrawerDestination.profile)
            case "settings": path.append(DrawerDestination.settings)
            default:         break
            }
        }
        #endif
    }

    #if DEBUG
    private func seedFixtureRecents() {
        // Idempotent: only seed once per cold launch, regardless of how
        // many times this view appears.
        guard recentChats.items.isEmpty else { return }
        let now = Date()
        recentChats.upsert(
            id: "fixture-1",
            title: "Plan a Vegas trip next month",
            updatedAt: now.addingTimeInterval(-60 * 12)
        )
        recentChats.upsert(
            id: "fixture-2",
            title: "Find a Japanese restaurant near work",
            updatedAt: now.addingTimeInterval(-3_600 * 4)
        )
        recentChats.upsert(
            id: "fixture-3",
            title: "Rebook the SFO→LAX flight",
            updatedAt: now.addingTimeInterval(-3_600 * 26)
        )
    }
    #endif
}
