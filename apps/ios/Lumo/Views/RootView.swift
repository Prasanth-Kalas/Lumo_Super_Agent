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
            wrappedValue: ChatViewModel(
                service: chatService,
                tts: tts,
                compoundStreamService: CompoundStreamService.makeFromBundle()
            )
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
        // Seed booking-confirmation card fixture
        // (IOS-BOOKING-CONFIRM-AUTOFILL-1). Renders the assistant
        // turn that emits a structured-itinerary summary so the
        // capture lands the pre-tap card state with Confirm + Cancel
        // both visible.
        if defaults.bool(forKey: "LumoSeedBookingConfirmation") {
            seedBookingConfirmationFixture()
        }
        // Seed compound-dispatch strip fixture
        // (IOS-COMPOUND-VIEW-1). The flag value drives the
        // settled-or-not state via CompoundLegStatus values:
        //   "live"    → flight committed, hotel in_flight, restaurant pending
        //   "settled" → all three committed
        if let raw = defaults.string(forKey: "LumoSeedCompoundDispatch"),
           !raw.isEmpty {
            seedCompoundDispatchFixture(state: raw)
        }
        // Seed compound-leg-detail fixture
        // (IOS-COMPOUND-LEG-DETAIL-1). The flag value picks which
        // detail-panel state renders by status:
        //   pending / in_flight / committed / failed / manual_review
        // The targeted leg is pre-expanded so the capture lands
        // the panel without scripting a tap.
        if let raw = defaults.string(forKey: "LumoSeedCompoundLegDetail"),
           !raw.isEmpty {
            seedCompoundLegDetailFixture(detailState: raw)
        }
        #endif
    }

    #if DEBUG
    private func seedCompoundDispatchFixture(state: String) {
        let user = ChatMessage(
            role: .user,
            text: "Plan a Vegas weekend — flight, hotel, dinner.",
            status: .sent
        )
        let assistant = ChatMessage(
            role: .assistant,
            text: "On it — three agents working in parallel.",
            status: .delivered
        )
        // Status mapping per fixture state. Initial dispatch
        // statuses populate the override layer through
        // _seedForTest so the rendered strip matches the
        // requested settled / live posture without spinning up
        // a real subscription.
        let legStatuses: (CompoundLegStatus, CompoundLegStatus, CompoundLegStatus)
        switch state {
        case "settled":
            legStatuses = (.committed, .committed, .committed)
        default:
            // "live" or anything else → mid-dispatch state.
            legStatuses = (.committed, .in_flight, .pending)
        }
        let dispatch = CompoundDispatchPayload(
            kind: "assistant_compound_dispatch",
            compound_transaction_id: "ct_vegas_fixture",
            legs: [
                CompoundLeg(
                    leg_id: "leg_flight",
                    agent_id: "lumo-flights",
                    agent_display_name: "Lumo Flights",
                    description: "Booking flight ORD → LAS",
                    status: legStatuses.0
                ),
                CompoundLeg(
                    leg_id: "leg_hotel",
                    agent_id: "lumo-hotels",
                    agent_display_name: "Lumo Hotels",
                    description: "Booking hotel near the Strip",
                    status: legStatuses.1
                ),
                CompoundLeg(
                    leg_id: "leg_restaurant",
                    agent_id: "lumo-restaurants",
                    agent_display_name: "Lumo Restaurants",
                    description: "Booking dinner reservation",
                    status: legStatuses.2
                ),
            ]
        )
        chatViewModel._seedForTest(
            messages: [user, assistant],
            compoundDispatches: [assistant.id: dispatch],
            compoundOverrides: [
                dispatch.compound_transaction_id: [
                    "leg_flight":     legStatuses.0,
                    "leg_hotel":      legStatuses.1,
                    "leg_restaurant": legStatuses.2,
                ]
            ]
        )
    }

    private func seedCompoundLegDetailFixture(detailState: String) {
        let user = ChatMessage(
            role: .user,
            text: "Plan a Vegas weekend — flight, hotel, dinner.",
            status: .sent
        )
        let assistant = ChatMessage(
            role: .assistant,
            text: "On it — three agents working in parallel.",
            status: .delivered
        )

        // Compose the 3-leg plan, then mutate per detailState so
        // the targeted leg sits in the requested status with the
        // matching metadata (provider_reference, evidence,
        // firstSeenInFlightAt). Other legs hold deterministic
        // background statuses.
        let compoundID = "ct_vegas_detail_fixture"
        var legStatuses: [String: CompoundLegStatus] = [
            "leg_flight":     .committed,
            "leg_hotel":      .pending,
            "leg_restaurant": .pending,
        ]
        var metadata: [String: CompoundLegMetadata] = [:]
        var expand: Set<String> = []

        switch detailState {
        case "pending":
            // Hotel is pending, waiting on flight. Expand hotel.
            expand = ["leg_hotel"]
        case "in_flight":
            // Hotel is in_flight with a 17 s elapsed stamp so the
            // ticker reads "Elapsed: 17s" at capture time.
            legStatuses["leg_hotel"] = .in_flight
            metadata["leg_hotel"] = CompoundLegMetadata(
                firstSeenInFlightAt: Date().addingTimeInterval(-17),
                lastUpdatedAt: Date(),
                provider_reference: nil,
                evidence: nil
            )
            expand = ["leg_hotel"]
        case "committed":
            // Flight is committed with a Duffel order ref + a
            // light evidence dict. Expand flight.
            metadata["leg_flight"] = CompoundLegMetadata(
                firstSeenInFlightAt: Date().addingTimeInterval(-90),
                lastUpdatedAt: Date(),
                provider_reference: "DUFFEL_ord_8c4f12a3",
                evidence: [
                    "route": "ORD → LAS",
                    "carrier": "United UA1234",
                    "depart": "Sat, May 9 · 7:15 AM",
                    "seats": "12C, 12D",
                ]
            )
            expand = ["leg_flight"]
        case "failed":
            // Hotel failed with a recognized reason that
            // humanizes into a clean copy.
            legStatuses["leg_hotel"] = .failed
            metadata["leg_hotel"] = CompoundLegMetadata(
                firstSeenInFlightAt: Date().addingTimeInterval(-25),
                lastUpdatedAt: Date(),
                provider_reference: nil,
                evidence: ["reason": "rate_unavailable"]
            )
            expand = ["leg_hotel"]
        case "manual_review":
            legStatuses["leg_hotel"] = .manual_review
            metadata["leg_hotel"] = CompoundLegMetadata(
                firstSeenInFlightAt: nil,
                lastUpdatedAt: Date(),
                provider_reference: nil,
                evidence: ["reason": "Provider returned an unexpected 5xx; saga escalated."]
            )
            expand = ["leg_hotel"]
        default:
            break
        }

        let dispatch = CompoundDispatchPayload(
            kind: "assistant_compound_dispatch",
            compound_transaction_id: compoundID,
            legs: [
                CompoundLeg(
                    leg_id: "leg_flight",
                    agent_id: "lumo-flights",
                    agent_display_name: "Lumo Flights",
                    description: "Booking flight ORD → LAS",
                    status: legStatuses["leg_flight"]!
                ),
                CompoundLeg(
                    leg_id: "leg_hotel",
                    agent_id: "lumo-hotels",
                    agent_display_name: "Lumo Hotels",
                    description: "Booking hotel near the Strip",
                    status: legStatuses["leg_hotel"]!
                ),
                CompoundLeg(
                    leg_id: "leg_restaurant",
                    agent_id: "lumo-restaurants",
                    agent_display_name: "Lumo Restaurants",
                    description: "Booking dinner reservation",
                    status: legStatuses["leg_restaurant"]!
                ),
            ]
        )

        chatViewModel._seedForTest(
            messages: [user, assistant],
            compoundDispatches: [assistant.id: dispatch],
            compoundOverrides: [compoundID: legStatuses],
            compoundMetadata: [compoundID: metadata],
            compoundExpanded: expand
        )
    }

    private func seedBookingConfirmationFixture() {
        let user = ChatMessage(
            role: .user,
            text: "Yes, the Frontier 9:30 nonstop.",
            status: .sent
        )
        let assistant = ChatMessage(
            role: .assistant,
            text: "Here's the final price — tap Confirm to book.",
            status: .delivered
        )
        let payload = ItineraryPayload(
            kind: "structured-itinerary",
            offer_id: "off_frontier_midmorning",
            total_amount: "189.00",
            total_currency: "USD",
            slices: [
                ItinerarySlice(
                    origin: "SFO",
                    destination: "LAS",
                    segments: [
                        ItinerarySegment(
                            origin: "SFO",
                            destination: "LAS",
                            departing_at: "2026-05-09T09:30:00Z",
                            arriving_at: "2026-05-09T11:00:00Z",
                            carrier: "F9",
                            flight_number: "1879"
                        )
                    ]
                )
            ],
            // IOS-CONFIRMATION-RICH-PAYLOAD-1: pre-filled autofill
            // metadata so the screenshot captures land the rich
            // (traveler row + payment row + Different-traveler) view.
            traveler_summary: "Prasanth Kalas · prasanth.kalas@lumo.rentals",
            payment_summary: "Visa ending in 4242",
            prefilled: true,
            missing_fields: []
        )
        let envelope = ConfirmationEnvelope(
            hash: "fixture-hash",
            session_id: "fixture-session",
            turn_id: "fixture-turn",
            rendered_at: "2026-05-01T15:30:00Z"
        )
        chatViewModel._seedForTest(
            messages: [user, assistant],
            summaries: [assistant.id: .itinerary(payload, envelope: envelope)]
        )
    }

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
