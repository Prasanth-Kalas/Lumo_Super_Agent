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
struct SuggestionChips: View {
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
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested replies")
        .accessibilityIdentifier("chat.suggestion.strip")
    }
}
