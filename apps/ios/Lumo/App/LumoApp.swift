import SwiftUI

@main
struct LumoApp: App {
    private let chatService: ChatService
    private let authService: AuthService
    private let tts: TextToSpeechService
    private let paymentService: PaymentService
    private let receiptStore: ReceiptStore
    private let appConfig: AppConfig

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
    }

    var body: some Scene {
        WindowGroup {
            AppRootView(
                authService: authService,
                chatService: chatService,
                tts: tts,
                paymentService: paymentService,
                receiptStore: receiptStore,
                appConfig: appConfig
            )
        }
    }
}
