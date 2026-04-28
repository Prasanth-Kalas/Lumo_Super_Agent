import SwiftUI

/// Elevation-style container. Use to group related rows or wrap a
/// section of content with subtle separation from the background.

struct LumoCard<Content: View>: View {
    var padding: CGFloat = LumoSpacing.lg
    var cornerRadius: CGFloat = LumoRadius.lg
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .fill(LumoColors.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(LumoColors.separator, lineWidth: 0.5)
            )
    }
}
