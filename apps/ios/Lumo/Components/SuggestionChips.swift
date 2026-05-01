import SwiftUI

/// Horizontal strip of assistant-suggested reply chips. Mirrors the
/// web component at `apps/web/components/SuggestionChips.tsx`. Tap a
/// chip and its `value` is submitted as if the user had typed it; the
/// strip then disappears via the parent's render rule (chips only
/// surface on the latest assistant message before any user message).
///
/// Sizing + tone follow the web pill exactly: pill border on the
/// elevated surface, mid-weight label, hover-equivalent press
/// affordance via SwiftUI's default button feedback.
///
/// Overflow handling: the strip is a horizontal ScrollView (matches
/// Claude Desktop / ChatGPT). When the chip count overflows the
/// viewport, a fixed-width trailing-edge gradient overlay fades the
/// rightmost `trailingFadeWidth` points to the chat background, so
/// the user sees that the row is scrollable rather than guessing
/// whether a chip got clipped. The overlay is non-interactive
/// (`.allowsHitTesting(false)`) so chip taps still register near the
/// right edge.
struct SuggestionChips: View {
    /// Width of the trailing-edge fade overlay used as the scroll
    /// affordance. Exposed for the `chip-strip-trailing-fade` test
    /// so the regression catcher fails when the overlay is removed.
    static let trailingFadeWidth: CGFloat = 32

    let suggestions: [AssistantSuggestion]
    let isDisabled: Bool
    let onSelect: (AssistantSuggestion) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: LumoSpacing.sm) {
                ForEach(suggestions) { suggestion in
                    Button {
                        onSelect(suggestion)
                    } label: {
                        Text(suggestion.label)
                            .font(LumoFonts.callout.weight(.medium))
                            .foregroundStyle(LumoColors.labelSecondary)
                            .padding(.horizontal, LumoSpacing.md + 2)
                            .padding(.vertical, LumoSpacing.sm)
                            .background(
                                Capsule().fill(LumoColors.surface.opacity(0.7))
                            )
                            .overlay(
                                Capsule().stroke(LumoColors.separator, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(isDisabled)
                    .opacity(isDisabled ? 0.5 : 1)
                    .accessibilityLabel(Text(suggestion.label))
                    .accessibilityHint(Text("Sends \(suggestion.value)"))
                    .accessibilityIdentifier("chat.suggestion.\(suggestion.id)")
                }
            }
            .padding(.horizontal, LumoSpacing.xs)
            .padding(.vertical, LumoSpacing.xxs)
        }
        .overlay(alignment: .trailing) {
            LinearGradient(
                colors: [
                    LumoColors.background.opacity(0),
                    LumoColors.background,
                ],
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(width: Self.trailingFadeWidth)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested replies")
        .accessibilityIdentifier("chat.suggestion.strip")
    }
}
