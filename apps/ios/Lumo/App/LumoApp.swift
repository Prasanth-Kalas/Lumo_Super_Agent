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
            proactiveClient: proactiveClient
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
