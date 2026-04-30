import SwiftUI

/// Stub. Mirrors the web /history page concept — chat thread history.
/// iOS sessions are local-only today (RecentChatsStore); cross-device
/// sync ships in MOBILE-CHAT-2. The drawer's RECENT list already shows
/// recent sessions, so this destination is a fuller-page surface that
/// will get search + grouping later.

struct HistoryView: View {
    var body: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("History")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Your past conversations show up in the drawer's Recent list. Full search + grouping comes with cross-device session sync (MOBILE-CHAT-2).")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.large)
    }
}
