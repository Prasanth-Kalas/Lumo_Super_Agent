import SwiftUI

struct ChatTab: View {
    let chatService: ChatService

    var body: some View {
        ChatView(service: chatService)
            .navigationTitle("Lumo")
            .navigationBarTitleDisplayMode(.inline)
    }
}
