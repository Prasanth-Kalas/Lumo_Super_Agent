import SwiftUI

/// Stack of dismissible proactive-moment cards. Renders above the chat
/// composer (Chat tab only). Each card has icon + headline + body +
/// primary action button + dismiss X. Cards age out after their
/// server-issued `expiresAt` (default 24h) or on user dismiss.
///
/// The view subscribes to the host's `ProactiveMomentsViewModel`.
/// Tapping the primary action invokes the host's `onMomentAccepted`
/// closure, which the host wires to chat-prefill / deeplink dispatch.

struct ProactiveMomentsView: View {
    @ObservedObject var viewModel: ProactiveMomentsViewModel
    let onMomentAccepted: (ProactiveMoment) -> Void

    var body: some View {
        if viewModel.moments.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: LumoSpacing.sm) {
                ForEach(viewModel.moments) { moment in
                    ProactiveMomentCard(
                        moment: moment,
                        onAccept: { onMomentAccepted(moment) },
                        onDismiss: { viewModel.dismiss(moment.id) }
                    )
                }
            }
            .padding(.horizontal, LumoSpacing.md)
            .padding(.bottom, LumoSpacing.sm)
            .onAppear {
                viewModel.consumeCachedUpdate()
                Task { await viewModel.refresh() }
            }
        }
    }
}

private struct ProactiveMomentCard: View {
    let moment: ProactiveMoment
    let onAccept: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: LumoSpacing.md) {
            Image(systemName: glyph)
                .font(.system(size: 22))
                .foregroundStyle(LumoColors.cyanDeep)
                .frame(width: 28, alignment: .center)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: LumoSpacing.xs) {
                Text(moment.headline)
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(2)
                Text(moment.body)
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .lineLimit(3)
                Button(moment.primaryAction.label, action: onAccept)
                    .buttonStyle(.lumoPlain)
                    .padding(.top, 2)
                    .accessibilityIdentifier("proactive.accept.\(moment.id)")
            }

            Spacer(minLength: 0)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(LumoColors.labelTertiary)
                    .padding(LumoSpacing.xs)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("proactive.dismiss.\(moment.id)")
            .accessibilityLabel("Dismiss \(moment.headline)")
        }
        .padding(LumoSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .fill(LumoColors.surfaceElevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(LumoColors.separator, lineWidth: 0.5)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("proactive.card.\(moment.id)")
    }

    private var glyph: String {
        switch moment.typedCategory {
        case .tripUpdate:          return "airplane"
        case .proactiveSuggestion: return "sparkles"
        case .paymentReceipt:      return "doc.text"
        case .alert:               return "exclamationmark.triangle"
        case .none:                return "bell"
        }
    }
}
