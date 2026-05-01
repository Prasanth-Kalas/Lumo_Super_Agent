import SwiftUI

@main
struct LumoApp: App {
    @UIApplicationDelegateAdaptor(LumoAppDelegate.self) private var appDelegate

    private let chatService: ChatService
    private let authService: AuthService
    private let tts: TextToSpeechService
    private let paymentService: PaymentService
    private let receiptStore: ReceiptStore
    private let appConfig: AppConfig
    private let notificationService: NotificationService
    private let proactiveCache: ProactiveMomentsCache
    private let proactiveClient: ProactiveMomentsClient
    private let backgroundFetch: BackgroundFetchService
    /// Drawer-screens fetcher (Memory / Marketplace / History). The
    /// concrete `DrawerScreensClient` hits the real backend; the
    /// DEBUG fixture seam in RootView swaps the same wire-shape with
    /// `FakeDrawerScreensFetcher` for screenshot capture.
    private let drawerScreensFetcher: DrawerScreensFetching

    @MainActor
    init() {
        let config = AppConfig.fromBundle()
        self.appConfig = config
        self.chatService = ChatService(baseURL: config.apiBaseURL)
        let auth = AuthService(config: config)
        self.authService = auth
        self.tts = TextToSpeechService(config: config)
        // PaymentService reads the current user id from AuthService each
        // call (closure capture so the value reflects sign-in/sign-out
        // transitions without re-instantiating the service).
        self.paymentService = PaymentService.make(
            config: config,
            userIDProvider: { [weak auth] in auth?.state.userID }
        )
        self.receiptStore = ReceiptStore.makeDefault()
        // Notification stack — same userID-provider closure capture.
        let notif = NotificationService.make(
            config: config,
            userIDProvider: { [weak auth] in auth?.state.userID }
        )
        self.notificationService = notif
        let cache = ProactiveMomentsCache()
        self.proactiveCache = cache
        let client = ProactiveMomentsClient(
            baseURL: config.apiBaseURL,
            userIDProvider: { [weak auth] in auth?.state.userID }
        )
        self.proactiveClient = client
        self.backgroundFetch = BackgroundFetchService(
            cache: cache,
            fetcher: client
        )
        // Wire NotificationActionHandler's snooze client.
        let snoozer = NotificationSnoozeClient(
            baseURL: config.apiBaseURL,
            userIDProvider: { [weak auth] in auth?.state.userID }
        )
        NotificationActionHandler.shared.install(snoozer: snoozer)

        // Drawer-screens client. DEBUG-only `-LumoSeedDrawerScreens`
        // launch arg substitutes a `FakeDrawerScreensFetcher` so
        // screenshot capture is deterministic; otherwise the real
        // client hits `/api/{memory,marketplace,history}`.
        let realDrawerClient = DrawerScreensClient(
            baseURL: config.apiBaseURL,
            userIDProvider: { [weak auth] in auth?.state.userID }
        )
        #if DEBUG
        if let fakeMode = ProcessInfo.processInfo
            .arguments.firstIndex(of: "-LumoSeedDrawerScreens").map({ $0 + 1 })
            .flatMap({ ProcessInfo.processInfo.arguments[safe: $0] })
        {
            self.drawerScreensFetcher = makeSeededFakeDrawerScreensFetcher(mode: fakeMode)
        } else {
            self.drawerScreensFetcher = realDrawerClient
        }
        #else
        self.drawerScreensFetcher = realDrawerClient
        #endif
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if let fixture = PaymentsFixture.current {
                PaymentsFixtureRoot(fixture: fixture)
            } else if let fixture = NotificationsFixture.current {
                NotificationsFixtureRoot(fixture: fixture, cache: proactiveCache)
            } else {
                normalRoot
            }
            #else
            normalRoot
            #endif
        }
    }

    private var normalRoot: some View {
        AppRootView(
            authService: authService,
            chatService: chatService,
            tts: tts,
            paymentService: paymentService,
            receiptStore: receiptStore,
            appConfig: appConfig,
            proactiveCache: proactiveCache,
            proactiveClient: proactiveClient,
            drawerScreensFetcher: drawerScreensFetcher
        )
        .onAppear {
            // The delegate is constructed by UIKit before our init's
            // services exist; install them now so notification + bg-task
            // hooks have backing implementations.
            appDelegate.install(
                notificationService: notificationService,
                backgroundFetch: backgroundFetch
            )
        }
    }
}

#if DEBUG
/// Test fixture for `-LumoSeedDrawerScreens <mode>` launch arg.
///
/// Modes:
///   "YES"   → populated profile, 4 marketplace agents, 5 history sessions
///   "empty" → nil profile, no agents, no sessions (empty-state shots)
///
/// The seeded data is deterministic; it doesn't depend on wall-clock,
/// network, or auth state. The fixture seam is DEBUG-only so it's
/// stripped from Release builds (same gate doctrine as
/// IOS-DEV-BYPASS-GATE-1's #if DEBUG bypass button).
@MainActor
private func makeSeededFakeDrawerScreensFetcher(mode: String) -> DrawerScreensFetching {
    let fake = FakeDrawerScreensFetcher()
    if mode.lowercased() == "empty" {
        fake.memoryResult = .success(MemoryResponseDTO(profile: nil))
        fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: []))
        fake.historyResult = .success(HistoryResponseDTO(sessions: []))
        return fake
    }
    // Populated default — used for "YES", "memory-edit", "marketplace-detail", etc.
    fake.memoryResult = .success(MemoryResponseDTO(profile: MemoryProfileDTO(
        display_name: "Alex",
        timezone: "America/Chicago",
        preferred_language: "en",
        home_address: MemoryAddressDTO(line1: "1 Market St", city: "San Francisco", region: "CA", country: "US"),
        work_address: nil,
        dietary_flags: ["vegetarian", "gluten_free"],
        allergies: ["shellfish"],
        preferred_airline_class: "economy",
        preferred_airline_seat: "aisle",
        preferred_hotel_chains: [],
        budget_tier: "standard",
        preferred_payment_hint: nil
    )))
    fake.marketplaceResult = .success(MarketplaceResponseDTO(agents: [
        MarketplaceAgentDTO(
            agent_id: "lumo-flights",
            display_name: "Lumo Flights",
            one_liner: "Search and book flights via Duffel.",
            domain: "flights",
            intents: ["book_flight", "search_flights"],
            install: MarketplaceInstallStateDTO(status: "installed", installed_at: nil),
            listing: MarketplaceListingDTO(category: "travel", pricing_note: nil)
        ),
        MarketplaceAgentDTO(
            agent_id: "lumo-hotels",
            display_name: "Lumo Hotels",
            one_liner: "Find hotel rooms across major chains.",
            domain: "hotels",
            intents: ["book_hotel"],
            install: MarketplaceInstallStateDTO(status: "installed", installed_at: nil),
            listing: MarketplaceListingDTO(category: "travel", pricing_note: nil)
        ),
        MarketplaceAgentDTO(
            agent_id: "lumo-restaurants",
            display_name: "Lumo Restaurants",
            one_liner: "Reserve dinner at restaurants on OpenTable.",
            domain: "restaurants",
            intents: ["book_restaurant"],
            install: nil,
            listing: MarketplaceListingDTO(category: "dining", pricing_note: nil)
        ),
        MarketplaceAgentDTO(
            agent_id: "lumo-rides",
            display_name: "Lumo Rides",
            one_liner: "Ground transport via Uber and Lyft.",
            domain: "ground",
            intents: ["book_ride"],
            install: nil,
            listing: MarketplaceListingDTO(category: "travel", pricing_note: nil)
        ),
    ]))
    let now = Date()
    let isoFmt = ISO8601DateFormatter()
    isoFmt.formatOptions = [.withInternetDateTime]
    fake.historyResult = .success(HistoryResponseDTO(sessions: [
        HistorySessionDTO(
            session_id: "fix-1",
            started_at: isoFmt.string(from: now.addingTimeInterval(-60 * 12)),
            last_activity_at: isoFmt.string(from: now.addingTimeInterval(-60 * 8)),
            user_message_count: 4,
            preview: "Plan a weekend trip to Vegas",
            trip_ids: ["t1", "t2"]
        ),
        HistorySessionDTO(
            session_id: "fix-2",
            started_at: isoFmt.string(from: now.addingTimeInterval(-3_600 * 4)),
            last_activity_at: isoFmt.string(from: now.addingTimeInterval(-3_600 * 4)),
            user_message_count: 6,
            preview: "Find a Japanese restaurant near work",
            trip_ids: []
        ),
        HistorySessionDTO(
            session_id: "fix-3",
            started_at: isoFmt.string(from: now.addingTimeInterval(-3_600 * 26)),
            last_activity_at: isoFmt.string(from: now.addingTimeInterval(-3_600 * 26)),
            user_message_count: 3,
            preview: "Rebook the SFO→LAX flight on the morning of the 12th",
            trip_ids: ["t3"]
        ),
        HistorySessionDTO(
            session_id: "fix-4",
            started_at: isoFmt.string(from: now.addingTimeInterval(-86_400 * 3)),
            last_activity_at: isoFmt.string(from: now.addingTimeInterval(-86_400 * 3)),
            user_message_count: 2,
            preview: "Cancel the Tuesday hotel — moving to Wednesday",
            trip_ids: []
        ),
        HistorySessionDTO(
            session_id: "fix-5",
            started_at: isoFmt.string(from: now.addingTimeInterval(-86_400 * 9)),
            last_activity_at: isoFmt.string(from: now.addingTimeInterval(-86_400 * 9)),
            user_message_count: 5,
            preview: "Boarding pass and receipt for the Frontier flight to LAS",
            trip_ids: ["t4"]
        ),
    ]))
    return fake
}
#endif

private extension Array {
    /// Bounds-checked subscript used by the launch-arg parser. Returns
    /// nil when the index is out of range so we don't crash on the
    /// trailing `-LumoSeedDrawerScreens` with no value.
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
