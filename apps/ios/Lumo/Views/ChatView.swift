import SwiftUI

struct ChatView: View {
    private let service: ChatService

    @State private var input: String = ""
    @State private var streamedResponse: String = ""
    @State private var isStreaming: Bool = false
    @State private var errorMessage: String?
    @State private var lastSentMessage: String?
    @State private var streamingTask: Task<Void, Never>?
    @State private var sessionID: String = UUID().uuidString

    init(service: ChatService) {
        self.service = service
    }

    var body: some View {
        VStack(spacing: 12) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let lastSentMessage {
                        userBubble(text: lastSentMessage)
                    }
                    if !streamedResponse.isEmpty || isStreaming {
                        assistantBubble(text: streamedResponse, isStreaming: isStreaming)
                    }
                    if let errorMessage {
                        errorBubble(text: errorMessage)
                    }
                    if streamedResponse.isEmpty && !isStreaming && lastSentMessage == nil && errorMessage == nil {
                        emptyState
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
            }
            inputBar
        }
        .padding(.vertical, 16)
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
    }

    private var header: some View {
        VStack(spacing: 4) {
            Text("Lumo")
                .font(.title2).bold()
            Text("hello iOS — streaming /api/chat")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var emptyState: some View {
        VStack(alignment: .center, spacing: 8) {
            Text("Type a message to test the chat stream.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Make sure `npm run dev` is running in apps/web.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Ask Lumo…", text: $input, axis: .horizontal)
                .textFieldStyle(.roundedBorder)
                .disabled(isStreaming)
                .submitLabel(.send)
                .onSubmit(sendMessage)
            Button(action: sendMessage) {
                if isStreaming {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "paperplane.fill")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty || isStreaming)
        }
        .padding(.horizontal, 16)
    }

    private func userBubble(text: String) -> some View {
        HStack {
            Spacer(minLength: 32)
            Text(text)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.accentColor)
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }

    private func assistantBubble(text: String, isStreaming: Bool) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(text.isEmpty ? " " : text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                if isStreaming {
                    Text("streaming…")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 12)
                }
            }
            Spacer(minLength: 32)
        }
    }

    private func errorBubble(text: String) -> some View {
        HStack {
            Text("Error: \(text)")
                .font(.footnote)
                .foregroundStyle(.red)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.red.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            Spacer(minLength: 0)
        }
    }

    private func sendMessage() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }
        lastSentMessage = trimmed
        streamedResponse = ""
        errorMessage = nil
        isStreaming = true
        input = ""

        streamingTask = Task {
            do {
                for try await event in service.stream(message: trimmed, sessionID: sessionID) {
                    switch event {
                    case .text(let chunk):
                        streamedResponse += chunk
                    case .error(let detail):
                        errorMessage = detail
                    case .done:
                        break
                    case .other:
                        break
                    }
                }
            } catch is CancellationError {
                // user dismissed or restarted; nothing to do
            } catch {
                errorMessage = error.localizedDescription
            }
            isStreaming = false
        }
    }
}

#Preview {
    if let service = ChatService.makeFromBundle() {
        ChatView(service: service)
    } else {
        Text("Bad LumoAPIBase config")
    }
}
