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

    init(service: ChatService, tts: TextToSpeechServicing? = nil) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(service: service, tts: tts))
        _voiceComposer = StateObject(wrappedValue: VoiceComposerViewModel(speech: SpeechRecognitionService()))
    }

    /// Hoisted-state initialiser — `RootView` owns the chat + voice
    /// view-models so the drawer's "New Chat" can call `reset()` and
    /// notification deep-links can mutate `input` without re-creating
    /// the view tree. Also used by unit tests to drive both pipelines
    /// without spinning up a real `SFSpeechRecognizer`.
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
                        MessageBubble(
                            message: message,
                            onCopy: { copyToPasteboard(message.text) },
                            onShare: nil,
                            onRegenerate: regenerateAction(for: message),
                            onRetry: retryAction(for: message)
                        )
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

    private var inputBar: some View {
        HStack(spacing: LumoSpacing.sm) {
            LumoTextField(
                "Ask Lumo…",
                text: $viewModel.input,
                submitLabel: .send,
                onSubmit: { viewModel.send(mode: .text) }
            )
            .focused($inputFocused)

            // Voice button only when the text field is empty — the
            // common chat-app pattern: type to type, hold to speak.
            // Once the user has typed anything the button swaps to
            // the send affordance.
            if viewModel.input.trimmingCharacters(in: .whitespaces).isEmpty {
                VoicePushToTalkButton(
                    isListening: voiceComposer.state.isListening,
                    isDisabled: viewModel.isStreaming,
                    onTap: { Task { await voiceComposer.tapToTalk() } },
                    onLongPressBegan: { Task { await voiceComposer.pressBegan() } },
                    onLongPressEnded: { voiceComposer.release() }
                )
            } else {
                Button(action: handleSendTap) {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(sendButtonBackground)
                }
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("chat.send")
                .disabled(!canSend)
            }
        }
        .padding(LumoSpacing.md)
        .background(
            LumoColors.surface
                .overlay(
                    Rectangle()
                        .fill(LumoColors.separator)
                        .frame(height: 0.5),
                    alignment: .top
                )
                .ignoresSafeArea(edges: .bottom)
        )
        .animation(LumoAnimation.quick, value: viewModel.input.isEmpty)
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

    private var sendButtonBackground: some View {
        Circle().fill(canSend ? LumoColors.cyan : LumoColors.labelTertiary)
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
}
