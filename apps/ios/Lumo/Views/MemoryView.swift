import SwiftUI

/// Stub. Web /memory shows the memory-facts table + structured profile.
/// iOS surface will land after the web equivalent stabilizes — for now
/// the drawer destination matches the web list, the empty state points
/// the user back to chat.

struct MemoryView: View {
    var body: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "brain.head.profile")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("Memory")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("What Lumo remembers about you — preferences, addresses, dietary flags, frequent flyer numbers. The full editor is on web at lumo.rentals/memory; an iOS surface is queued behind that.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.large)
    }
}
