import SwiftUI

/// A single chat message rendered with role-aware styling. The view
/// renders plain text by default; pass `markdown: true` to route the
/// content through the lightweight `MarkdownRenderer`.

struct MessageBubble: View {
    let message: ChatMessage
    var onCopy: (() -> Void)? = nil
    var onShare: (() -> Void)? = nil
    var onRegenerate: (() -> Void)? = nil
    var onRetry: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .bottom, spacing: LumoSpacing.sm) {
            if message.role == .user { Spacer(minLength: LumoSpacing.xxxl) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: LumoSpacing.xxs) {
                bubble
                footer
            }

            if message.role == .assistant { Spacer(minLength: LumoSpacing.xxxl) }
        }
        .contextMenu { menu }
    }

    @ViewBuilder
    private var bubble: some View {
        Group {
            if message.role == .assistant {
                MarkdownRenderer(text: message.text)
            } else {
                Text(message.text)
            }
        }
        .font(LumoFonts.body)
        .foregroundStyle(message.role == .user ? LumoColors.userBubbleText : LumoColors.assistantBubbleText)
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 2)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.bubble)
                .fill(message.role == .user ? LumoColors.userBubble : LumoColors.assistantBubble)
        )
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    }

    private var footer: some View {
        HStack(spacing: LumoSpacing.xs) {
            Text(timestamp)
                .font(LumoFonts.caption)
                .foregroundStyle(LumoColors.labelTertiary)
            if let icon = statusIcon {
                Image(systemName: icon)
                    .font(LumoFonts.caption)
                    .foregroundStyle(statusColor)
                    .accessibilityLabel(statusAccessibilityLabel)
            }
            if message.status == .failed, let onRetry {
                Button(action: onRetry) {
                    Text("Retry")
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.cyan)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, LumoSpacing.sm)
    }

    @ViewBuilder
    private var menu: some View {
        if let onCopy {
            Button {
                onCopy()
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
        if let onShare {
            Button {
                onShare()
            } label: {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        }
        if message.role == .assistant, let onRegenerate {
            Button {
                onRegenerate()
            } label: {
                Label("Regenerate", systemImage: "arrow.clockwise")
            }
        }
    }

    private var timestamp: String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: message.createdAt)
    }

    private var statusIcon: String? {
        switch message.status {
        case .sending: return "circle.dotted"
        case .sent: return "checkmark"
        case .streaming: return nil  // typing indicator handles this elsewhere
        case .delivered: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }

    private var statusColor: Color {
        switch message.status {
        case .failed: return LumoColors.error
        case .delivered: return LumoColors.success
        default: return LumoColors.labelTertiary
        }
    }

    private var statusAccessibilityLabel: String {
        switch message.status {
        case .sending: return "Sending"
        case .sent: return "Sent"
        case .streaming: return "Streaming"
        case .delivered: return "Delivered"
        case .failed: return "Failed to send"
        }
    }
}
