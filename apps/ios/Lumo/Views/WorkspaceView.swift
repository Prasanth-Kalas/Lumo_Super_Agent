import SwiftUI

/// Stub. The web /workspace dashboard (Today / Content / Inbox / Co-pilot
/// / Operations) hasn't been ported to iOS yet — this empty state matches
/// the parity-mirror posture and points the user back to chat. Real view
/// ships when iOS gets a parallel workspace surface.

struct WorkspaceView: View {
    var body: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("Workspace")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Today, Content, Inbox, Co-pilot, and Operations land here. The web dashboard is at lumo.rentals/workspace; the iOS view ships in a follow-up sprint.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Workspace")
        .navigationBarTitleDisplayMode(.large)
    }
}
