import SwiftUI

/// Stub. Web /marketplace shows installable agents (Phase 4 substrate).
/// iOS will get a tap-through-to-web flow first, native browse later.
/// For now this destination matches the web drawer entry and surfaces
/// the empty-state copy.

struct MarketplaceView: View {
    var body: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "square.grid.3x2")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("Marketplace")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Browse installable agents that extend what Lumo can book and orchestrate. The catalog lives on web at lumo.rentals/marketplace; a native iOS browser ships in a follow-up sprint.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Marketplace")
        .navigationBarTitleDisplayMode(.large)
    }
}
