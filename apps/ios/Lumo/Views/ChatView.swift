import SwiftUI

/// The Chat tab's primary view. Backed by `ChatViewModel` for state;
/// renders the message list with `MessageBubble`, a typing indicator
/// while the assistant is forming a response, an error banner above
/// the input bar, and the send/retry/regenerate affordances per
/// message via context menus.

struct ChatView: View {
    @StateObject private var viewModel: ChatViewModel
    @FocusState private var inputFocused: Bool

    init(service: ChatService) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(service: service))
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList
            errorBanner
            inputBar
        }
        .background(LumoColors.background.ignoresSafeArea())
        .onDisappear { viewModel.cancelStream() }
    }

    // MARK: - Message list

    @ViewBuilder
    private var messageList: some View {
        if viewModel.messages.isEmpty {
            emptyState
        } else {
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
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 56))
                .foregroundStyle(LumoColors.cyan)
            Text("Hi, I'm Lumo")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Ask me to plan a trip, find a restaurant, or anything else.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

    // MARK: - Input bar

    private var inputBar: some View {
        HStack(spacing: LumoSpacing.sm) {
            LumoTextField(
                "Ask Lumo…",
                text: $viewModel.input,
                submitLabel: .send,
                onSubmit: viewModel.send
            )
            .focused($inputFocused)

            Button(action: handleSendTap) {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(sendButtonBackground)
            }
            .accessibilityLabel("Send message")
            .disabled(!canSend)
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
        )
    }

    private var canSend: Bool {
        !viewModel.input.trimmingCharacters(in: .whitespaces).isEmpty && !viewModel.isStreaming
    }

    private var sendButtonBackground: some View {
        Circle().fill(canSend ? LumoColors.cyan : LumoColors.labelTertiary)
    }

    private func handleSendTap() {
        viewModel.send()
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

