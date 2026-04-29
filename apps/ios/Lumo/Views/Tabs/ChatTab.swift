import SwiftUI

struct ChatTab: View {
    let chatService: ChatService
    let tts: TextToSpeechServicing
    let proactiveCache: ProactiveMomentsCache
    let proactiveClient: ProactiveMomentsFetching

    @StateObject private var proactiveViewModel: ProactiveMomentsViewModel

    init(
        chatService: ChatService,
        tts: TextToSpeechServicing,
        proactiveCache: ProactiveMomentsCache,
        proactiveClient: ProactiveMomentsFetching
    ) {
        self.chatService = chatService
        self.tts = tts
        self.proactiveCache = proactiveCache
        self.proactiveClient = proactiveClient
        _proactiveViewModel = StateObject(
            wrappedValue: ProactiveMomentsViewModel(
                cache: proactiveCache,
                fetcher: proactiveClient
            )
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            // Proactive cards stack — only on Chat tab. Cards age out
            // server-side via expiresAt; the view model also filters
            // dismissed ids. When the list is empty, ProactiveMomentsView
            // renders EmptyView so this VStack collapses cleanly.
            ProactiveMomentsView(viewModel: proactiveViewModel) { moment in
                handleAccept(moment)
            }
            ChatView(service: chatService, tts: tts)
        }
        .navigationTitle("Lumo")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func handleAccept(_ moment: ProactiveMoment) {
        // For v1 we just dismiss the card. The chat-prefill / deeplink
        // dispatch is wired in the notification action handler path
        // (where the system delivers the same moment as a push); the
        // in-app accept here keeps the card from re-surfacing while
        // the user navigates manually. MOBILE-API-1 will route the
        // accept into the chat composer prefill directly.
        proactiveViewModel.dismiss(moment.id)
    }
}
