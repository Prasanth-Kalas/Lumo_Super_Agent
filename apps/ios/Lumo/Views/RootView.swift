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

    /// Injected by AppRootView when the user is signed in (see
    /// AppRootView.body). Drives the drawer's account-chip footer
    /// email + initial.
    @Environment(\.signedInUser) private var signedInUser

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
                accountEmail: signedInUser?.email,
                onNewChat: handleNewChat,
                onSelectRecent: handleSelectRecent,
                onSelectDestination: handleSelectDestination,
                onAccountSettings: handleAccountSettings,
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
        case .workspace:
            WorkspaceView()
        case .trips:
            TripsView()
        case .receipts:
            ReceiptHistoryView(store: receiptStore)
        case .receiptDetail(let receiptID):
            ReceiptDetailLookupView(receiptID: receiptID, store: receiptStore)
        case .history:
            HistoryView()
        case .memory:
            MemoryView()
        case .settings:
            SettingsView(
                paymentService: paymentService,
                receiptStore: receiptStore,
                appConfig: appConfig,
                onSignOut: onSignOut
            )
        case .marketplace:
            MarketplaceView()
        case .profile:
            // Not in EXPLORE today; reachable programmatically (e.g.
            // future Settings → Profile link, deep link from web).
            ProfileView()
        }
    }

    private func handleSelectDestination(_ destination: DrawerDestination) {
        path.append(destination)
    }

    /// Drawer's account-chip → "Account settings" tap. Pushes the
    /// SettingsView (the iOS analogue of /settings/account on web).
    private func handleAccountSettings() {
        path.append(DrawerDestination.settings)
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
        let resolution = NotificationRouteResolver.resolve(route)
        switch resolution {
        case .noChange:
            return
        case .replace(let destinations, let prefill):
            var newPath = NavigationPath()
            for d in destinations { newPath.append(d) }
            self.path = newPath
            if let prefill {
                chatViewModel.input = prefill
            }
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
        // Seed assistant_suggestions chip-strip fixture (CHAT-SUGGESTED-CHIPS-1-IOS).
        // Renders a user → assistant clarification turn with three
        // suggestion chips below, deterministic copy taken from the
        // canonical date-suggestion path in
        // apps/web/lib/chat-suggestions.ts.
        if defaults.bool(forKey: "LumoSeedChips") {
            seedChipsFixture()
        }
        // Seed flight-offers selection card fixture
        // (CHAT-FLIGHT-SELECT-CLICKABLE-1). Renders a user/assistant
        // pair plus a 3-offer FlightOffersSelectCard, with the
        // Frontier row pre-committed so the capture lands the post-
        // tap selected state.
        if defaults.bool(forKey: "LumoSeedFlightOffers") {
            seedFlightOffersFixture()
        }
        #endif
    }

    #if DEBUG
    private func seedFlightOffersFixture() {
        let user = ChatMessage(
            role: .user,
            text: "Find me a flight from SFO to Vegas on Saturday.",
            status: .sent
        )
        let assistant = ChatMessage(
            role: .assistant,
            text: "Here are the morning options.",
            status: .delivered
        )
        let payload = FlightOffersPayload(offers: [
            FlightOffer(
                offer_id: "off_united_morning",
                total_amount: "238.00",
                total_currency: "USD",
                owner: .init(name: "United", iata_code: "UA"),
                slices: [
                    .init(
                        origin: .init(iata_code: "SFO", city_name: "San Francisco"),
                        destination: .init(iata_code: "LAS", city_name: "Las Vegas"),
                        duration: "PT1H35M",
                        segments: [
                            .init(
                                departing_at: "2026-05-09T07:15:00Z",
                                arriving_at: "2026-05-09T08:50:00Z",
                                marketing_carrier_iata: "UA",
                                marketing_carrier_flight_number: "1234"
                            )
                        ]
                    )
                ]
            ),
            FlightOffer(
                offer_id: "off_frontier_midmorning",
                total_amount: "189.00",
                total_currency: "USD",
                owner: .init(name: "Frontier", iata_code: "F9"),
                slices: [
                    .init(
                        origin: .init(iata_code: "SFO", city_name: "San Francisco"),
                        destination: .init(iata_code: "LAS", city_name: "Las Vegas"),
                        duration: "PT1H30M",
                        segments: [
                            .init(
                                departing_at: "2026-05-09T09:30:00Z",
                                arriving_at: "2026-05-09T11:00:00Z",
                                marketing_carrier_iata: "F9",
                                marketing_carrier_flight_number: "1879"
                            )
                        ]
                    )
                ]
            ),
            FlightOffer(
                offer_id: "off_alaska_afternoon",
                total_amount: "274.50",
                total_currency: "USD",
                owner: .init(name: "Alaska", iata_code: "AS"),
                slices: [
                    .init(
                        origin: .init(iata_code: "SFO", city_name: "San Francisco"),
                        destination: .init(iata_code: "LAS", city_name: "Las Vegas"),
                        duration: "PT1H40M",
                        segments: [
                            .init(
                                departing_at: "2026-05-09T14:50:00Z",
                                arriving_at: "2026-05-09T16:30:00Z",
                                marketing_carrier_iata: "AS",
                                marketing_carrier_flight_number: "456"
                            )
                        ]
                    )
                ]
            ),
        ])
        chatViewModel._seedForTest(
            messages: [user, assistant],
            selections: [assistant.id: [.flightOffers(payload)]]
        )
    }

    private func seedChipsFixture() {
        let user = ChatMessage(
            role: .user,
            text: "Plan a weekend trip to Vegas",
            status: .sent
        )
        let assistant = ChatMessage(
            role: .assistant,
            text: "When are you traveling?",
            status: .delivered,
            suggestionsTurnId: "fixture-turn-1"
        )
        let chips = [
            AssistantSuggestion(id: "s1", label: "Next weekend", value: "May 9, 2026 to May 11, 2026"),
            AssistantSuggestion(id: "s2", label: "In 2 weeks", value: "May 16, 2026 to May 18, 2026"),
            AssistantSuggestion(id: "s3", label: "Memorial Day weekend", value: "May 23, 2026 to May 25, 2026"),
        ]
        chatViewModel._seedForTest(
            messages: [user, assistant],
            suggestions: ["fixture-turn-1": chips]
        )
    }

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
