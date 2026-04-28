import Foundation
import SwiftUI

/// Owns the chat list state machine. The view binds to `messages`,
/// `input`, `error`, and `isStreaming`; everything else (status
/// transitions, retry, regenerate, cancellation on view teardown) is
/// driven from here.
///
/// State machine per message:
///   user:      sending → sent → (delivered if needed) | failed
///   assistant: streaming → delivered | failed
///
/// `lastUserPrompt` lets `regenerate()` re-issue the previous prompt
/// without requiring the user to retype.

@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var messages: [ChatMessage] = []
    @Published var input: String = ""
    @Published private(set) var error: String?
    @Published private(set) var isStreaming: Bool = false

    private let service: ChatService
    private let sessionID: String
    private var streamingTask: Task<Void, Never>?
    private var lastUserPrompt: String?

    init(service: ChatService, sessionID: String = UUID().uuidString) {
        self.service = service
        self.sessionID = sessionID
    }

    func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming else { return }
        input = ""
        startStream(prompt: text, addUserBubble: true)
    }

    /// Re-issue the most recent failed user message.
    func retry() {
        guard let failed = messages.last(where: { $0.role == .user && $0.status == .failed }) else { return }
        let text = failed.text
        messages.removeAll { $0.id == failed.id }
        // Also drop any assistant bubble that was failed in-flight after it.
        if let last = messages.last, last.role == .assistant, last.status == .failed {
            messages.removeLast()
        }
        startStream(prompt: text, addUserBubble: true)
    }

    /// Re-run the last user prompt without adding a new user bubble.
    /// Drops the most recent assistant message if present.
    func regenerate() {
        guard let prompt = lastUserPrompt, !isStreaming else { return }
        if let last = messages.last, last.role == .assistant {
            messages.removeLast()
        }
        startStream(prompt: prompt, addUserBubble: false)
    }

    func clearError() { error = nil }

    /// Cancel any in-flight stream. Called when the view disappears
    /// or the user starts a new message.
    func cancelStream() {
        streamingTask?.cancel()
        streamingTask = nil
    }

    private func startStream(prompt: String, addUserBubble: Bool) {
        cancelStream()
        isStreaming = true
        error = nil
        lastUserPrompt = prompt

        if addUserBubble {
            messages.append(ChatMessage(role: .user, text: prompt, status: .sending))
        }
        let assistantID = UUID()
        messages.append(ChatMessage(id: assistantID, role: .assistant, text: "", status: .streaming))

        streamingTask = Task { [weak self] in
            await self?.runStream(prompt: prompt, assistantID: assistantID, addUserBubble: addUserBubble)
        }
    }

    private func runStream(prompt: String, assistantID: UUID, addUserBubble: Bool) async {
        var sawFirstToken = false
        do {
            for try await event in service.stream(message: prompt, sessionID: sessionID) {
                if Task.isCancelled { break }
                switch event {
                case .text(let chunk):
                    if !sawFirstToken, addUserBubble {
                        markUserSent()
                    }
                    sawFirstToken = true
                    appendAssistantText(chunk, id: assistantID)
                case .error(let detail):
                    error = detail
                    markAssistantFailed(id: assistantID)
                    if addUserBubble { markUserFailed() }
                case .done:
                    markAssistantDelivered(id: assistantID)
                case .other:
                    continue
                }
            }
        } catch is CancellationError {
            // user navigated away or restarted; leave state as-is
        } catch {
            self.error = error.localizedDescription
            markAssistantFailed(id: assistantID)
            if addUserBubble { markUserFailed() }
        }
        isStreaming = false
        streamingTask = nil
    }

    // MARK: - Mutations (run on @MainActor by class isolation)

    private func appendAssistantText(_ chunk: String, id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].text += chunk
    }

    private func markAssistantDelivered(id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].status = .delivered
    }

    private func markAssistantFailed(id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].status = .failed
    }

    private func markUserSent() {
        guard let idx = messages.lastIndex(where: { $0.role == .user && $0.status == .sending }) else { return }
        messages[idx].status = .sent
    }

    private func markUserFailed() {
        guard let idx = messages.lastIndex(where: { $0.role == .user && $0.status == .sending }) else { return }
        messages[idx].status = .failed
    }
}
