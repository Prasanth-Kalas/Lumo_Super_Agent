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

    /// Per-assistant-message interactive selections (flight offers
    /// today, food/time slots in follow-up sprints). Keyed by the
    /// assistant message UUID — the SSE handler attaches selections
    /// to the in-flight assistant bubble when the frame arrives.
    /// Same stale-suppression rule as suggestions: the view only
    /// renders selections for an assistant message that has no
    /// user message after it, mirroring web's `userMessageExistsAfter`.
    @Published private(set) var selectionsByMessage: [UUID: [InteractiveSelection]] = [:]

    /// Per-assistant-message confirmation summaries (the money-gate
    /// `summary` SSE frame — flight itineraries today; trips,
    /// reservations, carts in follow-up sprints). The card stays
    /// visible after the user confirms or cancels: the user message
    /// they sent ("Yes, book it." / "Cancel — don't book that.")
    /// flips it into a decided-label state, but the summary itself
    /// stays in the cache so the rendered card preserves its
    /// terminal copy. Mirrors web's `userMessageExistsAfter(m.id)`
    /// → decidedLabel pattern in apps/web/app/page.tsx.
    @Published private(set) var summariesByMessage: [UUID: ConfirmationSummary] = [:]

    /// Per-assistant-message compound-dispatch payloads (the
    /// `assistant_compound_dispatch` SSE frame — multi-agent trip
    /// orchestration). Like summary cards, the strip stays visible
    /// after the user moves on: the live URLSession subscription
    /// closes when all legs reach terminal status, and the strip
    /// renders as a static settled record.
    @Published private(set) var compoundDispatchByMessage: [UUID: CompoundDispatchPayload] = [:]
    /// Per-leg status overrides keyed by compound_transaction_id.
    /// Per-leg updates arrive via the per-compound stream and merge
    /// into the inner dictionary (leg_id → latest status). The view
    /// reads the override layered over the dispatch payload's
    /// initial status.
    @Published private(set) var compoundLegStatusOverrides: [String: [String: CompoundLegStatus]] = [:]

    /// Per-leg metadata captured from leg-status SSE updates —
    /// status-change timestamps + provider_reference + evidence
    /// dict. Keyed `compound_transaction_id → leg_id → CompoundLegMetadata`.
    /// The detail panel reads this to render booking refs,
    /// elapsed-time tickers, and failure reasons.
    @Published private(set) var compoundLegMetadata: [String: [String: CompoundLegMetadata]] = [:]

    /// Set of leg_ids currently expanded in the dispatch strip's
    /// detail panel. Multiple legs can be expanded simultaneously
    /// across re-renders (the user may want to compare two in-flight
    /// legs side by side). Toggled via
    /// `toggleCompoundLegDetail(legID:)`.
    @Published private(set) var compoundLegDetailExpandedFor: Set<String> = []

    /// Optional subscription handle for live per-leg updates.
    /// Injected by RootView so test paths can pass a no-op or fake.
    private let compoundStreamService: CompoundStreamService?
    /// Active per-compound subscription tasks, keyed by
    /// compound_transaction_id. Cancelled on reset() and on
    /// terminal compound state.
    private var compoundStreamTasks: [String: Task<Void, Never>] = [:]

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
        tts: TextToSpeechServicing? = nil,
        compoundStreamService: CompoundStreamService? = nil
    ) {
        self.service = service
        self.sessionID = sessionID
        self.tts = tts
        self.compoundStreamService = compoundStreamService
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
        cancelAllCompoundStreams()
        messages = []
        input = ""
        error = nil
        isStreaming = false
        lastFirstTokenLatency = nil
        suggestionsByTurn = [:]
        selectionsByMessage = [:]
        summariesByMessage = [:]
        compoundDispatchByMessage = [:]
        compoundLegStatusOverrides = [:]
        compoundLegMetadata = [:]
        compoundLegDetailExpandedFor = []
    }

    private func cancelAllCompoundStreams() {
        for (_, task) in compoundStreamTasks {
            task.cancel()
        }
        compoundStreamTasks = [:]
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
                case .selection(let selection):
                    attachSelection(selection, assistantID: assistantID)
                case .summary(let summary):
                    attachSummary(summary, assistantID: assistantID)
                case .compoundDispatch(let dispatch):
                    attachCompoundDispatch(dispatch, assistantID: assistantID)
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

    private func attachSelection(_ selection: InteractiveSelection, assistantID: UUID) {
        // The orchestrator emits at most one selection per kind per
        // turn (food/flight/time-slots are mutually exclusive in
        // practice today), but the storage allows a list to keep the
        // shape symmetric with web's `UIMessage.selections`. If a
        // future turn re-emits the same kind, the latest wins —
        // mirrors web's `selections.filter((x) => x.kind !== s.kind)`.
        var current = selectionsByMessage[assistantID] ?? []
        current.removeAll { existing in existing.sameKind(as: selection) }
        current.append(selection)
        selectionsByMessage[assistantID] = current
    }

    private func attachSummary(_ summary: ConfirmationSummary, assistantID: UUID) {
        // One summary per assistant turn; latest wins (the orchestrator
        // shouldn't emit a second summary on the same turn but defending
        // here keeps the view surface predictable on replay paths).
        summariesByMessage[assistantID] = summary
    }

    private func attachCompoundDispatch(_ dispatch: CompoundDispatchPayload, assistantID: UUID) {
        compoundDispatchByMessage[assistantID] = dispatch
        // Seed initial overrides from the dispatch's own statuses
        // so the override layer always has a value to read for
        // every leg (simpler view-side rendering).
        let initial = Dictionary(
            uniqueKeysWithValues: dispatch.legs.map { ($0.leg_id, $0.status) }
        )
        let existing = compoundLegStatusOverrides[dispatch.compound_transaction_id] ?? [:]
        // Don't clobber later updates that may already have arrived;
        // merge the dispatch statuses in only where the override is
        // missing.
        var merged = existing
        for (leg_id, status) in initial where merged[leg_id] == nil {
            merged[leg_id] = status
        }
        compoundLegStatusOverrides[dispatch.compound_transaction_id] = merged

        // Open the live per-leg subscription if the orchestrator
        // hasn't already settled all legs. The view's settled-state
        // pulse-suppression matches web exactly.
        if !CompoundDispatchHelpers.isSettled(legs: dispatch.legs, statuses: merged),
           let stream = compoundStreamService,
           compoundStreamTasks[dispatch.compound_transaction_id] == nil {
            startCompoundStream(stream: stream, dispatch: dispatch)
        }
    }

    private func startCompoundStream(stream: CompoundStreamService, dispatch: CompoundDispatchPayload) {
        let id = dispatch.compound_transaction_id
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                for try await update in stream.subscribe(compoundTransactionID: id) {
                    if Task.isCancelled { break }
                    self.applyCompoundLegStatusUpdate(update, compoundID: id)
                    // Close the subscription as soon as every leg has
                    // settled — mirrors web's `if (settled) return`
                    // gate that prevents the EventSource from
                    // reopening.
                    if let dispatch = self.compoundDispatchByMessage.values
                        .first(where: { $0.compound_transaction_id == id }),
                       CompoundDispatchHelpers.isSettled(
                        legs: dispatch.legs,
                        statuses: self.compoundLegStatusOverrides[id] ?? [:]
                       ) {
                        break
                    }
                }
            } catch {
                // Network/stream errors close the subscription
                // silently — the strip stays visible with whatever
                // statuses arrived. The user sees the last known
                // state rather than a spinner stuck forever.
            }
            self.compoundStreamTasks[id] = nil
        }
        compoundStreamTasks[id] = task
    }

    private func applyCompoundLegStatusUpdate(_ update: CompoundLegStatusUpdate, compoundID: String) {
        var overrides = compoundLegStatusOverrides[compoundID] ?? [:]
        let previous = overrides[update.leg_id]
        overrides[update.leg_id] = update.status
        compoundLegStatusOverrides[compoundID] = overrides

        // Metadata: stamp the first time we see in_flight, refresh
        // last-updated on every frame, and absorb provider_reference
        // / evidence when present. Older statuses without metadata
        // (the seed-from-dispatch path) leave the empty record alone.
        var metaForCompound = compoundLegMetadata[compoundID] ?? [:]
        var meta = metaForCompound[update.leg_id] ?? .empty
        if update.status == .in_flight && meta.firstSeenInFlightAt == nil {
            meta.firstSeenInFlightAt = Date()
        }
        if let ts = update.timestamp {
            meta.lastUpdatedAt = parseISO8601(ts) ?? meta.lastUpdatedAt
        }
        if let ref = update.provider_reference {
            meta.provider_reference = ref
        }
        if let evidence = update.evidence {
            meta.evidence = evidence
        }
        // Avoid clobbering an in_flight stamp on a benign re-emit
        // of the same status from a flaky stream.
        _ = previous
        metaForCompound[update.leg_id] = meta
        compoundLegMetadata[compoundID] = metaForCompound
    }

    private func parseISO8601(_ raw: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = parser.date(from: raw) { return d }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: raw)
    }

    /// Public helper for ChatView's render rule. True when this
    /// assistant message should currently surface its chip strip:
    /// it has a `suggestionsTurnId`, the strip is non-empty, and no
    /// user message exists *after* it in the thread (matching web's
    /// stale-suppression). Pure look-up — does not mutate state.
    func suggestions(for message: ChatMessage) -> [AssistantSuggestion] {
        guard message.role == .assistant, let turnID = message.suggestionsTurnId else { return [] }
        guard !hasUserMessageAfter(message) else { return [] }
        return suggestionsByTurn[turnID] ?? []
    }

    /// Mirror of `suggestions(for:)` for interactive-selection cards
    /// (flight offers today). Same stale-suppression rule: chips +
    /// selections both vanish once the user has moved past the
    /// assistant's offer turn.
    func selections(for message: ChatMessage) -> [InteractiveSelection] {
        guard message.role == .assistant else { return [] }
        guard !hasUserMessageAfter(message) else { return [] }
        return selectionsByMessage[message.id] ?? []
    }

    /// Confirmation summary attached to an assistant message, if any.
    /// Unlike chips and selection cards, summaries don't auto-suppress
    /// when a later user message lands — the card transitions into
    /// a `decidedLabel` state instead, mirroring the web shell's
    /// `userMessageExistsAfter(m.id)` → "Confirmed — booking…" /
    /// "Cancelled" footer copy. The view layer reads this plus
    /// `summaryDecision(for:)` to drive that transition.
    func summary(for message: ChatMessage) -> ConfirmationSummary? {
        guard message.role == .assistant else { return nil }
        return summariesByMessage[message.id]
    }

    /// Decided state for a summary's two terminal labels. `confirmed`
    /// when the next user message reads as an affirmative ("Yes, book
    /// it." / "Confirm" / etc.), `cancelled` when it cancels, nil
    /// while the user hasn't acted. Pure look-up against the message
    /// list — no separate decision cache needed because the user's
    /// own message is the source of truth.
    func summaryDecision(for message: ChatMessage) -> ConfirmationDecision? {
        guard message.role == .assistant else { return nil }
        guard let idx = messages.firstIndex(where: { $0.id == message.id }) else { return nil }
        let later = messages.suffix(from: messages.index(after: idx))
        guard let next = later.first(where: { $0.role == .user }) else { return nil }
        let trimmed = next.text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasPrefix("cancel") { return .cancelled }
        return .confirmed
    }

    private func hasUserMessageAfter(_ message: ChatMessage) -> Bool {
        guard let idx = messages.firstIndex(where: { $0.id == message.id }) else { return false }
        let later = messages.suffix(from: messages.index(after: idx))
        return later.contains(where: { $0.role == .user })
    }

    /// Compound-dispatch payload attached to an assistant message,
    /// if any. Like summaries, the strip stays visible after the
    /// user moves on — the live subscription closes when all legs
    /// reach terminal status, and the strip becomes a settled
    /// record. Mirrors web's `m.compoundDispatch` (page.tsx).
    func compoundDispatch(for message: ChatMessage) -> CompoundDispatchPayload? {
        guard message.role == .assistant else { return nil }
        return compoundDispatchByMessage[message.id]
    }

    /// Live status for a leg, reading the override layer first
    /// (most recent leg-status frame from the per-compound stream)
    /// and falling back to the dispatch's initial status. Pure
    /// look-up.
    func compoundLegStatus(compoundID: String, legID: String, fallback: CompoundLegStatus) -> CompoundLegStatus {
        compoundLegStatusOverrides[compoundID]?[legID] ?? fallback
    }

    /// Aggregate "settled" for a dispatch — convenience for the
    /// view to drive the badge + animation suppression. Same
    /// predicate web uses, applied over the override layer.
    func compoundSettled(_ dispatch: CompoundDispatchPayload) -> Bool {
        let overrides = compoundLegStatusOverrides[dispatch.compound_transaction_id] ?? [:]
        return CompoundDispatchHelpers.isSettled(legs: dispatch.legs, statuses: overrides)
    }

    /// Per-leg metadata for the detail panel (timestamps +
    /// provider_reference + evidence). Returns `.empty` when
    /// nothing has been captured for this leg, so the view layer
    /// always reads a value rather than branching on nil.
    func compoundLegMeta(compoundID: String, legID: String) -> CompoundLegMetadata {
        compoundLegMetadata[compoundID]?[legID] ?? .empty
    }

    /// True when the detail panel for `legID` should currently
    /// render (the user has tapped the row to expand).
    func isCompoundLegDetailExpanded(legID: String) -> Bool {
        compoundLegDetailExpandedFor.contains(legID)
    }

    /// Tap-to-expand handler. The CompoundLegStrip wires this
    /// into each row's onTap. Multiple legs may be expanded
    /// concurrently — toggling one doesn't collapse the others,
    /// matching the comparison-friendly UX the brief calls out.
    func toggleCompoundLegDetail(legID: String) {
        if compoundLegDetailExpandedFor.contains(legID) {
            compoundLegDetailExpandedFor.remove(legID)
        } else {
            compoundLegDetailExpandedFor.insert(legID)
        }
    }

    /// Test-only seam: prime the chat with a known message list and
    /// chip cache so tests can verify `suggestions(for:)`'s
    /// stale-suppression rule, the chip-tap → user-bubble path, and
    /// the clear-on-submit cascade without driving the real SSE
    /// stream. Production callers must not use this — the SSE path
    /// is the only legitimate way these get populated at runtime.
    func _seedForTest(
        messages: [ChatMessage],
        suggestions: [String: [AssistantSuggestion]] = [:],
        selections: [UUID: [InteractiveSelection]] = [:],
        summaries: [UUID: ConfirmationSummary] = [:],
        compoundDispatches: [UUID: CompoundDispatchPayload] = [:],
        compoundOverrides: [String: [String: CompoundLegStatus]] = [:],
        compoundMetadata: [String: [String: CompoundLegMetadata]] = [:],
        compoundExpanded: Set<String> = []
    ) {
        self.messages = messages
        self.suggestionsByTurn = suggestions
        self.selectionsByMessage = selections
        self.summariesByMessage = summaries
        self.compoundDispatchByMessage = compoundDispatches
        self.compoundLegStatusOverrides = compoundOverrides
        self.compoundLegMetadata = compoundMetadata
        self.compoundLegDetailExpandedFor = compoundExpanded
    }

    /// Test-only seam for driving a single leg-status update
    /// without spinning up the live URLSession subscription. Used
    /// by the status-transition tests.
    func _applyCompoundLegStatusForTest(_ update: CompoundLegStatusUpdate, compoundID: String) {
        applyCompoundLegStatusUpdate(update, compoundID: compoundID)
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
