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

/// How the current turn was initiated. Drives whether the assistant
/// response gets read back via TTS:
///   .text  — user typed; render text only.
///   .voice — user spoke; speak the response back.
///   .both  — accessibility / mixed-input mode; render AND speak.
enum VoiceMode: String {
    case text
    case voice
    case both

    /// Whether this turn should produce TTS output.
    var shouldSpeak: Bool {
        self == .voice || self == .both
    }
}

@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var messages: [ChatMessage] = []
    @Published var input: String = ""
    @Published private(set) var error: String?
    @Published private(set) var isStreaming: Bool = false

    /// First-token latency from `send()` to the first non-empty
    /// `.text` SSE frame, in seconds. Reset on every send. Used by
    /// the voice-mode latency probe in `scripts/ios-measure-perf.sh`
    /// — surfaced through a debug-only HUD (Phase 5 perf observability).
    @Published private(set) var lastFirstTokenLatency: TimeInterval?

    /// Per-turn suggested-reply chips. Keyed by the server's
    /// `turn_id` so historical replay can reattach chips to the
    /// matching assistant message without re-streaming. The view
    /// only renders chips for the LAST assistant message before any
    /// user message (matching web's stale-suppression rule), so older
    /// turns naturally fall out of the strip without any explicit
    /// expiration.
    @Published private(set) var suggestionsByTurn: [String: [AssistantSuggestion]] = [:]

    private let service: ChatService
    private let sessionID: String
    private let tts: TextToSpeechServicing?
    private var streamingTask: Task<Void, Never>?
    private var lastUserPrompt: String?
    private var lastVoiceMode: VoiceMode = .text
    /// Captured at the moment send() begins so we can record
    /// first-token latency on the matching .text event.
    private var streamStartTime: Date?

    init(
        service: ChatService,
        sessionID: String = UUID().uuidString,
        tts: TextToSpeechServicing? = nil
    ) {
        self.service = service
        self.sessionID = sessionID
        self.tts = tts
    }

    func send(mode: VoiceMode = .text) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming else { return }
        input = ""
        lastVoiceMode = mode
        startStream(prompt: text, addUserBubble: true)
    }

    /// Convenience entry point used by the voice composer — pushes
    /// the transcript directly into the input field and sends in
    /// voice mode without a tap on the text field.
    func sendVoiceTranscript(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }
        input = trimmed
        send(mode: .voice)
    }

    /// Submit a suggestion chip's `value` as if the user had typed
    /// it. Mirrors the web behaviour where chip-tap and typed reply
    /// are indistinguishable downstream — the chip's `label` is only
    /// the chip face, never the submitted text. Suggestions clear
    /// implicitly because the rendering rule hides chips on any
    /// assistant message that has a user message after it.
    func sendSuggestion(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }
        lastVoiceMode = .text
        startStream(prompt: trimmed, addUserBubble: true)
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

    /// Wipe the thread back to a clean slate. Wired to the drawer's
    /// "New Chat" affordance: cancels any in-flight stream, drops all
    /// messages, clears the composer + error, and resets the latency
    /// probe so the next turn measures from a true cold start.
    func reset() {
        cancelStream()
        messages = []
        input = ""
        error = nil
        isStreaming = false
        lastFirstTokenLatency = nil
        suggestionsByTurn = [:]
    }

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
        streamStartTime = Date()
        lastFirstTokenLatency = nil

        if lastVoiceMode.shouldSpeak {
            tts?.beginStreaming()
        }

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
                    if !sawFirstToken {
                        if addUserBubble { markUserSent() }
                        if let start = streamStartTime, !chunk.isEmpty {
                            lastFirstTokenLatency = Date().timeIntervalSince(start)
                        }
                    }
                    sawFirstToken = true
                    appendAssistantText(chunk, id: assistantID)
                    if lastVoiceMode.shouldSpeak {
                        tts?.appendToken(chunk)
                    }
                case .error(let detail):
                    error = detail
                    markAssistantFailed(id: assistantID)
                    if addUserBubble { markUserFailed() }
                    if lastVoiceMode.shouldSpeak {
                        tts?.cancel()
                    }
                case .done:
                    markAssistantDelivered(id: assistantID)
                    if lastVoiceMode.shouldSpeak {
                        tts?.finishStreaming()
                    }
                case .suggestions(let turnID, let items):
                    attachSuggestions(turnID: turnID, items: items, assistantID: assistantID)
                case .other:
                    continue
                }
            }
        } catch is CancellationError {
            // user navigated away or restarted; leave state as-is
            if lastVoiceMode.shouldSpeak { tts?.cancel() }
        } catch {
            self.error = error.localizedDescription
            markAssistantFailed(id: assistantID)
            if addUserBubble { markUserFailed() }
            if lastVoiceMode.shouldSpeak { tts?.cancel() }
        }
        isStreaming = false
        streamingTask = nil
    }

    // MARK: - Mutations (run on @MainActor by class isolation)

    private func appendAssistantText(_ chunk: String, id: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[idx].text += chunk
    }

    private func attachSuggestions(turnID: String, items: [AssistantSuggestion], assistantID: UUID) {
        suggestionsByTurn[turnID] = items
        guard let idx = messages.firstIndex(where: { $0.id == assistantID }) else { return }
        messages[idx].suggestionsTurnId = turnID
    }

    /// Public helper for ChatView's render rule. True when this
    /// assistant message should currently surface its chip strip:
    /// it has a `suggestionsTurnId`, the strip is non-empty, and no
    /// user message exists *after* it in the thread (matching web's
    /// stale-suppression). Pure look-up — does not mutate state.
    func suggestions(for message: ChatMessage) -> [AssistantSuggestion] {
        guard message.role == .assistant, let turnID = message.suggestionsTurnId else { return [] }
        guard let idx = messages.firstIndex(where: { $0.id == message.id }) else { return [] }
        let later = messages.suffix(from: messages.index(after: idx))
        if later.contains(where: { $0.role == .user }) { return [] }
        return suggestionsByTurn[turnID] ?? []
    }

    /// Test-only seam: prime the chat with a known message list and
    /// chip cache so tests can verify `suggestions(for:)`'s
    /// stale-suppression rule, the chip-tap → user-bubble path, and
    /// the clear-on-submit cascade without driving the real SSE
    /// stream. Production callers must not use this — the SSE path
    /// is the only legitimate way these get populated at runtime.
    func _seedForTest(messages: [ChatMessage], suggestions: [String: [AssistantSuggestion]]) {
        self.messages = messages
        self.suggestionsByTurn = suggestions
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
