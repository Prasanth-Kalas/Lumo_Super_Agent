import SwiftUI

@main
struct LumoApp: App {
    private let chatService: ChatService
    private let authService: AuthService
    private let tts: TextToSpeechService

    @MainActor
    init() {
        let config = AppConfig.fromBundle()
        self.chatService = ChatService(baseURL: config.apiBaseURL)
        self.authService = AuthService(config: config)
        self.tts = TextToSpeechService(config: config)
    }

    var body: some Scene {
        WindowGroup {
            AppRootView(
                authService: authService,
                chatService: chatService,
                tts: tts
            )
        }
    }
}
