import SwiftUI

/// A single chat message rendered with role-aware styling.
///
/// IOS-MIRROR-WEB-1 changed the visual posture to mirror the web chat
/// thread (apps/web/app/page.tsx):
///   • Assistant messages render as prose with a small "Lumo" label
///     above — no rounded bubble background. Matches web's
///     "messages are typographic, not bubbled" rule.
///   • User messages stay right-aligned but in a soft elevated pill
///     (LumoElevated) instead of the heavy filled cyanDeep bubble,
///     matching web's lighter user-message treatment.
///
/// `userBubble` / `userBubbleText` / `assistantBubble` /
/// `assistantBubbleText` tokens stay in LumoColors for any external
/// callers; the values they resolve to drive the new look.

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
                if message.role == .assistant {
                    assistantHeader
                }
                bubble
                footer
            }

            if message.role == .assistant { Spacer(minLength: LumoSpacing.xxxl) }
        }
        .contextMenu { menu }
    }

    /// Small "Lumo" label that sits above each assistant message.
    /// Matches web's `<div>Lumo</div>` row above the prose body.
    private var assistantHeader: some View {
        HStack(spacing: LumoSpacing.xs) {
            Text("Lumo")
                .font(LumoFonts.caption.weight(.medium))
                .foregroundStyle(LumoColors.labelTertiary)
                .textCase(.uppercase)
                .tracking(1.2)
        }
    }

    @ViewBuilder
    private var bubble: some View {
        if message.role == .assistant {
            // Typographic — no background, no padding outside the
            // text width. Prose flows naturally inside the column.
            MarkdownRenderer(text: message.text)
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.label)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            // Soft elevated pill for user messages — right-aligned,
            // muted background instead of saturated cyan-deep.
            Text(message.text)
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.label)
                .padding(.horizontal, LumoSpacing.md)
                .padding(.vertical, LumoSpacing.sm + 2)
                .background(
                    RoundedRectangle(cornerRadius: LumoRadius.bubble)
                        .fill(LumoColors.surfaceElevated)
                )
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
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
