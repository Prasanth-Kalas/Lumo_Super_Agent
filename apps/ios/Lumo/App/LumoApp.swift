import SwiftUI

@main
struct LumoApp: App {
    private let chatService: ChatService

    init() {
        if let service = ChatService.makeFromBundle() {
            self.chatService = service
        } else {
            // Hard-fail rather than silently start with a junk URL — surfaces
            // misconfiguration loudly during dev.
            fatalError("LumoAPIBase missing or invalid in Info.plist.")
        }
    }

    var body: some Scene {
        WindowGroup {
            ChatView(service: chatService)
        }
    }
}
