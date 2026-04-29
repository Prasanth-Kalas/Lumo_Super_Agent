import SwiftUI

struct ChatTab: View {
    let chatService: ChatService
    let tts: TextToSpeechServicing

    var body: some View {
        ChatView(service: chatService, tts: tts)
            .navigationTitle("Lumo")
            .navigationBarTitleDisplayMode(.inline)
    }
}
