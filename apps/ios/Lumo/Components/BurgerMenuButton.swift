import SwiftUI

/// Top-left navigation-bar item that toggles the side drawer.
///
/// Bound to a single `Bool` so the parent owns drawer state and can
/// also dismiss programmatically (e.g. when a drawer row pushes a
/// destination).
struct BurgerMenuButton: View {
    @Binding var isOpen: Bool

    var body: some View {
        Button {
            withAnimation(LumoAnimation.standard) {
                isOpen.toggle()
            }
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(LumoColors.label)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(isOpen ? "Close menu" : "Open menu")
        .accessibilityIdentifier("burger.menu")
    }
}
