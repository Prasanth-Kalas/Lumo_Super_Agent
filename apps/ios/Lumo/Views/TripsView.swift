import SwiftUI

/// Stub. The real Trips view ships in MOBILE-TRIP-1. The empty-state
/// copy points the user back to chat so the value of the orchestrator
/// booking flow is still discoverable.

struct TripsView: View {
    var body: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "airplane.circle")
                .font(.system(size: 64))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("No trips yet")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Trips you book through Lumo will appear here. Try saying \"plan a trip to Vegas\" to get started.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Trips")
        .navigationBarTitleDisplayMode(.large)
    }
}
