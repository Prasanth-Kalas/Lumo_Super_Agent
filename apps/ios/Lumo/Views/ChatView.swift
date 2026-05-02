import SwiftUI

/// The Chat tab's primary view. Backed by `ChatViewModel` for state;
/// renders the message list with `MessageBubble`, a typing indicator
/// while the assistant is forming a response, an error banner above
/// the input bar, and the send/retry/regenerate affordances per
/// message via context menus.
///
/// Layout: the message list (or empty state) is the main content; the
/// input bar lives in a `.safeAreaInset(edge: .bottom)` so SwiftUI
/// composes it as a system-managed bottom inset rather than as a
/// sibling in a VStack. The latter caused a cold-launch dark-mode
/// rendering artifact in 1A where the input chrome was duplicated
/// near the top of the screen during initial trait resolution.

struct ChatView: View {
    @StateObject private var viewModel: ChatViewModel
    @StateObject private var voiceComposer: VoiceComposerViewModel
    @FocusState private var inputFocused: Bool
    @State private var showPermissionAlert = false

    /// Hoisted-state initialiser — `RootView` owns the chat + voice
    /// view-models so the drawer's "New Chat" can call `reset()` and
    /// notification deep-links can mutate `input` without re-creating
    /// the view tree. Also used by unit tests to drive both pipelines
    /// without spinning up a real Deepgram WebSocket.
    init(viewModel: ChatViewModel, voiceComposer: VoiceComposerViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel)
        _voiceComposer = StateObject(wrappedValue: voiceComposer)
    }

    var body: some View {
        messageContainer
            .background(LumoColors.background.ignoresSafeArea())
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    errorBanner
                    voiceTranscriptBanner
                    inputBar
                }
            }
            .onDisappear { viewModel.cancelStream() }
            .onChange(of: voiceComposer.state) { _, new in handleVoiceStateChange(new) }
            .alert("Microphone access", isPresented: $showPermissionAlert) {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                Button("Cancel", role: .cancel) { voiceComposer.cancel() }
            } message: {
                Text(voiceComposer.state.permissionDeniedMessage ?? "")
            }
    }

    // MARK: - Message container

    @ViewBuilder
    private var messageContainer: some View {
        if viewModel.messages.isEmpty {
            emptyState
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            messageList
        }
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: LumoSpacing.lg) {
                    ForEach(viewModel.messages) { message in
                        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
                            MessageBubble(
                                message: message,
                                onCopy: { copyToPasteboard(message.text) },
                                onShare: nil,
                                onRegenerate: regenerateAction(for: message),
                                onRetry: retryAction(for: message)
                            )

                            // Interactive selection cards (flight
                            // offers today). Same stale-suppression
                            // rule as suggestions — only the latest
                            // assistant message before any user
                            // message surfaces them.
                            ForEach(Array(viewModel.selections(for: message).enumerated()), id: \.offset) { _, selection in
                                if case .flightOffers(let payload) = selection {
                                    FlightOffersSelectCard(
                                        payload: payload,
                                        isDisabled: viewModel.isStreaming,
                                        onSubmit: { text in
                                            viewModel.sendSuggestion(text)
                                        },
                                        initialSelectedID: fixtureInitialSelectedID
                                    )
                                }
                            }

                            // Booking confirmation card — money gate
                            // for `flight_price_offer`. Lands on the
                            // turn AFTER offer selection. Confirm /
                            // Cancel both route through the same
                            // sendSuggestion path so the orchestrator's
                            // isAffirmative regex sees an
                            // indistinguishable confirm-turn whether
                            // the user typed "Yes, book it." or
                            // tapped Confirm.
                            if case let .itinerary(itinerary, _) = viewModel.summary(for: message) {
                                BookingConfirmationCard(
                                    payload: itinerary,
                                    decision: viewModel.summaryDecision(for: message),
                                    isDisabled: viewModel.isStreaming,
                                    onConfirm: {
                                        viewModel.sendSuggestion(BookingConfirmationSubmit.confirmText)
                                    },
                                    onCancel: {
                                        viewModel.sendSuggestion(BookingConfirmationSubmit.cancelText)
                                    },
                                    onDifferentTraveler: {
                                        viewModel.sendSuggestion(BookingConfirmationSubmit.differentTravelerText)
                                    },
                                    onMissingFieldsSubmit: { text in
                                        viewModel.sendSuggestion(text)
                                    }
                                )
                            }

                            // Compound-dispatch strip — multi-agent
                            // trip orchestration. Lives below the
                            // assistant message that triggered it
                            // and stays visible after the user
                            // moves on (mirrors web's CompoundLegStrip
                            // sticking around as a settled record).
                            if let dispatch = viewModel.compoundDispatch(for: message) {
                                CompoundLegStrip(
                                    payload: dispatch,
                                    overrides: viewModel.compoundLegStatusOverrides[dispatch.compound_transaction_id] ?? [:],
                                    metadataFor: { legID in
                                        viewModel.compoundLegMeta(
                                            compoundID: dispatch.compound_transaction_id,
                                            legID: legID
                                        )
                                    },
                                    isExpanded: { legID in
                                        viewModel.isCompoundLegDetailExpanded(legID: legID)
                                    },
                                    onTapLeg: { legID in
                                        withAnimation(.easeInOut(duration: 0.18)) {
                                            viewModel.toggleCompoundLegDetail(legID: legID)
                                        }
                                    }
                                )
                            }

                            // Suggestion chips render only on the
                            // latest assistant message before any
                            // user message — `suggestions(for:)`
                            // applies that rule, so an empty list
                            // means "stale, suppress".
                            let chips = viewModel.suggestions(for: message)
                            if !chips.isEmpty {
                                SuggestionChips(
                                    suggestions: chips,
                                    isDisabled: viewModel.isStreaming,
                                    onSelect: { suggestion in
                                        viewModel.sendSuggestion(suggestion.value)
                                    }
                                )
                            }
                        }
                        .id(message.id)
                    }
                    if showTypingIndicator {
                        typingBubble
                            .id("typing-indicator")
                    }
                }
                .padding(.horizontal, LumoSpacing.md)
                .padding(.top, LumoSpacing.lg)
                .padding(.bottom, LumoSpacing.md)
            }
            .refreshable {
                // Pull-to-refresh stub. Real history sync lands when
                // server-side persistence ships in MOBILE-CHAT-2.
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
            .onChange(of: viewModel.messages.last?.id) { _, _ in scrollToBottom(proxy) }
            .onChange(of: viewModel.messages.last?.text) { _, _ in scrollToBottom(proxy) }
            .onChange(of: viewModel.isStreaming) { _, _ in scrollToBottom(proxy) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        let target: AnyHashable? = showTypingIndicator
            ? "typing-indicator"
            : viewModel.messages.last?.id
        guard let target else { return }
        withAnimation(LumoAnimation.standard) {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    private var showTypingIndicator: Bool {
        guard viewModel.isStreaming, let last = viewModel.messages.last else { return false }
        return last.role == .assistant && last.text.isEmpty
    }

    private var typingBubble: some View {
        HStack {
            TypingIndicator()
                .padding(.horizontal, LumoSpacing.md)
                .padding(.vertical, LumoSpacing.sm + 2)
                .background(
                    RoundedRectangle(cornerRadius: LumoRadius.bubble)
                        .fill(LumoColors.assistantBubble)
                )
            Spacer(minLength: LumoSpacing.xxxl)
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        // Cleaner, less-decorated stance per the ChatGPT-style nav
        // refactor — single brand-cyan glyph + a one-line prompt. The
        // longer "ask me to plan a trip..." copy moved into the chat
        // composer's placeholder ("Ask Lumo…") so the empty surface
        // doesn't compete with the input bar for attention.
        VStack(spacing: LumoSpacing.md) {
            Image(systemName: "sparkles")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(LumoColors.cyan)
                .accessibilityHidden(true)
            Text("How can I help today?")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("chat.empty.prompt")
        }
        .padding(.bottom, LumoSpacing.xxl)
    }

    // MARK: - Error banner

    @ViewBuilder
    private var errorBanner: some View {
        if let error = viewModel.error {
            HStack(spacing: LumoSpacing.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(error)
                    .font(LumoFonts.footnote)
                    .lineLimit(2)
                Spacer()
                Button("Dismiss") { viewModel.clearError() }
                    .font(LumoFonts.footnote.weight(.medium))
            }
            .foregroundStyle(LumoColors.error)
            .padding(.horizontal, LumoSpacing.md)
            .padding(.vertical, LumoSpacing.sm)
            .background(LumoColors.error.opacity(0.1))
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: - Voice transcript banner

    @ViewBuilder
    private var voiceTranscriptBanner: some View {
        if let partial = voiceComposer.state.partialTranscript, !partial.isEmpty {
            HStack(alignment: .top, spacing: LumoSpacing.sm) {
                Image(systemName: "waveform")
                    .foregroundStyle(LumoColors.cyan)
                Text(partial)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(3)
                Spacer()
            }
            .padding(.horizontal, LumoSpacing.md)
            .padding(.vertical, LumoSpacing.sm)
            .background(LumoColors.cyan.opacity(0.08))
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: - Input bar
    //
    // IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase A re-pivots from the
    // IOS-MIRROR-WEB-1 always-both layout (mic + Send always visible
    // in a toolbar row) to the WhatsApp / Telegram / Signal pattern:
    // single rounded text field with one trailing icon that swaps
    // based on input state. Empty → mic; non-empty → paperplane.
    // Listening overlays a pulsing waveform icon in the same slot.
    //
    // The decision is documented in
    // docs/doctrines/mic-vs-send-button.md as the canonical Lumo
    // posture; rationale baked into ChatComposerTrailingButton's doc
    // comment too. Voice + send wiring behaviour is unchanged — only
    // the icon's position and visibility flips.

    private var inputBar: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: LumoSpacing.sm) {
                LumoTextField(
                    "Ask Lumo to book a flight, order dinner, plan a trip…",
                    text: $viewModel.input,
                    submitLabel: .send,
                    onSubmit: { viewModel.send(mode: .text) }
                )
                .focused($inputFocused)
                .frame(minHeight: 28)
                // CHIP-A11Y-VOICEOVER-1 — explicit accessibility
                // label that signals both reply paths (free-text +
                // chip-tap). The default TextField a11y label is just
                // the placeholder, which doesn't tell the user that
                // tapping a chip above is a valid alternative.
                .accessibilityLabel(
                    Text("Ask Lumo to book a flight, order dinner, plan a trip. Or pick a suggestion above.")
                )
                .accessibilityIdentifier("chat.composer.input")

                ChatComposerTrailingButton(
                    mode: ChatComposerTrailingButton.Mode.from(
                        input: viewModel.input,
                        isListening: voiceComposer.state.isListening
                    ),
                    isDisabled: viewModel.isStreaming && !voiceComposer.state.isListening,
                    onTap: handleTrailingTap,
                    onLongPressBegan: { Task { await voiceComposer.pressBegan() } },
                    onLongPressEnded: { voiceComposer.release() }
                )
            }
            .padding(.horizontal, LumoSpacing.md)
            .padding(.vertical, LumoSpacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: LumoRadius.lg)
                    .fill(LumoColors.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: LumoRadius.lg)
                    .stroke(LumoColors.separator, lineWidth: 1)
            )
            .padding(.horizontal, LumoSpacing.md)
            .padding(.bottom, LumoSpacing.sm)
        }
        .background(LumoColors.background.ignoresSafeArea(edges: .bottom))
    }

    private func handleTrailingTap() {
        let mode = ChatComposerTrailingButton.Mode.from(
            input: viewModel.input,
            isListening: voiceComposer.state.isListening
        )
        switch mode {
        case .mic, .waveform:
            Task { await voiceComposer.tapToTalk() }
        case .send:
            handleSendTap()
        }
    }

    // MARK: - Voice → chat handoff

    private func handleVoiceStateChange(_ newState: VoiceComposerViewModel.State) {
        switch newState {
        case .ready:
            if let transcript = voiceComposer.consumeReadyTranscript() {
                viewModel.sendVoiceTranscript(transcript)
            }
        case .permissionDenied:
            showPermissionAlert = true
        default:
            break
        }
    }

    private var canSend: Bool {
        !viewModel.input.trimmingCharacters(in: .whitespaces).isEmpty && !viewModel.isStreaming
    }

    private func handleSendTap() {
        viewModel.send(mode: .text)
        inputFocused = false
    }

    // MARK: - Action wiring

    private func retryAction(for message: ChatMessage) -> (() -> Void)? {
        guard message.status == .failed, message.role == .user else { return nil }
        return { [weak viewModel] in viewModel?.retry() }
    }

    private func regenerateAction(for message: ChatMessage) -> (() -> Void)? {
        guard message.role == .assistant, !viewModel.isStreaming else { return nil }
        guard message.id == viewModel.messages.last?.id else { return nil }
        return { [weak viewModel] in viewModel?.regenerate() }
    }

    private func copyToPasteboard(_ text: String) {
        UIPasteboard.general.string = text
    }

    /// DEBUG fixture seam — when `-LumoFlightOffersSelectedID` is
    /// passed at launch, the FlightOffersSelectCard mounts with that
    /// row pre-selected so screenshot captures land the post-tap
    /// state without scripting a tap event. nil in production.
    private var fixtureInitialSelectedID: String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: "LumoFlightOffersSelectedID")
        #else
        return nil
        #endif
    }
}
