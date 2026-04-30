import SwiftUI

/// Slide-in drawer from the left edge. Mirrors the web mobile drawer
/// (after WEB-REDESIGN-1 dropped the AGENTS section) — see
/// docs/notes/web-redesign-1-screenshots/04-mobile-drawer-{light,dark}.png
/// for the parity reference.
///
/// Layout (top → bottom, matches web):
///   • LUMO header + close button
///   • "+ New chat" primary CTA
///   • RECENT — scrollable list of past conversations
///   • EXPLORE — Workspace, Trips, Receipts, History, Memory,
///                Settings, Marketplace
///   • Account chip footer — avatar + email + chevron, taps to expand
///                            into a small menu (Account settings,
///                            Sign out). Only renders when signed in.
///
/// Width:
///   • iPhone — 80% of screen width.
///   • iPad — capped at 320 points so the drawer doesn't stretch
///     across the whole compact layout.
///
/// Animation: spring slide via `LumoAnimation.smooth`. The parent
/// drives `isOpen`; transitions happen inside an `.animation()`
/// modifier on the binding.
struct SideDrawerView: View {
    @Binding var isOpen: Bool
    let recents: [RecentChatItem]
    let signedIn: Bool
    /// Email shown on the account chip. Nil when no `/api/me` data is
    /// available yet — the chip falls back to "Signed in".
    let accountEmail: String?

    var onNewChat: () -> Void
    var onSelectRecent: (RecentChatItem) -> Void
    var onSelectDestination: (DrawerDestination) -> Void
    var onAccountSettings: () -> Void
    var onSignOut: () -> Void

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// Whether the account-chip footer is showing the (Account settings,
    /// Sign out) menu. Toggled by tapping the chip, dismissed by tapping
    /// either menu row or by re-tapping the chip.
    @State private var accountMenuOpen: Bool = false

    /// EXPLORE destinations in order. Locked here so future surfaces
    /// register in one place and match the web drawer's section.
    private static let exploreItems: [(DrawerDestination, String, String)] = [
        (.workspace,    "Workspace",   "square.grid.2x2"),
        (.trips,        "Trips",       "airplane"),
        (.receipts,     "Receipts",    "doc.text"),
        (.history,      "History",     "clock.arrow.circlepath"),
        (.memory,       "Memory",      "brain.head.profile"),
        (.settings,     "Settings",    "gearshape"),
        (.marketplace,  "Marketplace", "square.grid.3x2"),
    ]

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                // Backdrop — dimming layer that swallows taps.
                if isOpen {
                    Color.black.opacity(0.45)
                        .ignoresSafeArea()
                        .transition(.opacity)
                        .onTapGesture { close() }
                        .accessibilityIdentifier("drawer.backdrop")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityLabel("Close menu")
                }

                // Drawer panel
                if isOpen {
                    drawerPanel
                        .frame(width: drawerWidth(for: proxy.size.width))
                        .frame(maxHeight: .infinity)
                        .background(LumoColors.surface.ignoresSafeArea())
                        .overlay(alignment: .trailing) {
                            Rectangle()
                                .fill(LumoColors.separator)
                                .frame(width: 0.5)
                                .ignoresSafeArea()
                        }
                        .transition(.move(edge: .leading))
                        .accessibilityIdentifier("drawer.panel")
                }
            }
            .animation(LumoAnimation.smooth, value: isOpen)
        }
    }

    // MARK: - Panel content

    private var drawerPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    newChatRow
                    Divider().padding(.vertical, LumoSpacing.sm)
                    recentChatsSection
                    Divider().padding(.vertical, LumoSpacing.sm)
                    exploreSection
                }
                .padding(.horizontal, LumoSpacing.md)
            }
            accountChipFooter
        }
        .padding(.top, LumoSpacing.lg)
    }

    @ViewBuilder
    private var exploreSection: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.xxs) {
            Text("Explore")
                .font(LumoFonts.footnote)
                .foregroundStyle(LumoColors.labelTertiary)
                .padding(.vertical, LumoSpacing.xs)
                .accessibilityIdentifier("drawer.explore.header")
            ForEach(Self.exploreItems, id: \.1) { entry in
                destinationRow(entry.0, label: entry.1, icon: entry.2)
            }
        }
    }

    private var header: some View {
        HStack {
            Text("Lumo")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Spacer()
            Button {
                close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(LumoColors.labelSecondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Close menu")
            .accessibilityIdentifier("drawer.close")
        }
        .padding(.horizontal, LumoSpacing.lg)
        .padding(.bottom, LumoSpacing.md)
    }

    private var newChatRow: some View {
        Button {
            onNewChat()
            close()
        } label: {
            HStack(spacing: LumoSpacing.sm) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(LumoColors.cyan)
                    .frame(width: 28)
                Text("New chat")
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.label)
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.vertical, LumoSpacing.sm)
        }
        .accessibilityIdentifier("drawer.newChat")
    }

    @ViewBuilder
    private var recentChatsSection: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.xxs) {
            Text("Recent")
                .font(LumoFonts.footnote)
                .foregroundStyle(LumoColors.labelTertiary)
                .padding(.vertical, LumoSpacing.xs)

            if recents.isEmpty {
                Text("Conversations you start will appear here.")
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .padding(.vertical, LumoSpacing.xs)
            } else {
                ForEach(recents) { item in
                    Button {
                        onSelectRecent(item)
                        close()
                    } label: {
                        HStack(spacing: LumoSpacing.sm) {
                            Image(systemName: "bubble.left")
                                .font(.system(size: 14))
                                .foregroundStyle(LumoColors.labelSecondary)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title)
                                    .font(LumoFonts.body)
                                    .foregroundStyle(LumoColors.label)
                                    .lineLimit(1)
                                Text(item.updatedAt, style: .relative)
                                    .font(LumoFonts.footnote)
                                    .foregroundStyle(LumoColors.labelTertiary)
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                        .padding(.vertical, LumoSpacing.xs)
                    }
                    .accessibilityIdentifier("drawer.recent.\(item.id)")
                }
            }
        }
    }

    private func destinationRow(
        _ destination: DrawerDestination,
        label: String,
        icon: String
    ) -> some View {
        Button {
            onSelectDestination(destination)
            close()
        } label: {
            HStack(spacing: LumoSpacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(LumoColors.label)
                    .frame(width: 28)
                Text(label)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.label)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(LumoColors.labelTertiary)
            }
            .contentShape(Rectangle())
            .padding(.vertical, LumoSpacing.sm)
        }
        .accessibilityIdentifier("drawer.\(label.lowercased())")
    }

    /// Account chip footer — mirrors the web LeftRail profile chip.
    /// Tap the row to open a small menu (Account settings + Sign out);
    /// taps elsewhere collapse it. Hidden when signed-out (matches the
    /// web drawer's auth-footer split).
    @ViewBuilder
    private var accountChipFooter: some View {
        if signedIn {
            VStack(spacing: 0) {
                if accountMenuOpen {
                    accountMenu
                }
                Divider()
                Button {
                    withAnimation(LumoAnimation.quick) {
                        accountMenuOpen.toggle()
                    }
                } label: {
                    HStack(spacing: LumoSpacing.sm) {
                        avatarCircle
                        VStack(alignment: .leading, spacing: 0) {
                            Text(accountEmail ?? "Signed in")
                                .font(LumoFonts.footnote)
                                .foregroundStyle(LumoColors.label)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        Image(systemName: accountMenuOpen ? "chevron.down" : "chevron.up")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(LumoColors.labelTertiary)
                    }
                    .padding(.horizontal, LumoSpacing.md)
                    .padding(.vertical, LumoSpacing.md)
                    .contentShape(Rectangle())
                }
                .accessibilityIdentifier("drawer.accountChip")
            }
        }
    }

    private var avatarCircle: some View {
        Circle()
            .fill(LumoColors.cyan.opacity(0.18))
            .overlay(
                Text(accountInitial)
                    .font(LumoFonts.footnote.weight(.semibold))
                    .foregroundStyle(LumoColors.cyanDeep)
            )
            .frame(width: 28, height: 28)
    }

    private var accountInitial: String {
        guard let email = accountEmail, let first = email.first else { return "·" }
        return String(first).uppercased()
    }

    @ViewBuilder
    private var accountMenu: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(LumoAnimation.quick) { accountMenuOpen = false }
                onAccountSettings()
                close()
            } label: {
                accountMenuRow(label: "Account settings", icon: "person.crop.circle", destructive: false)
            }
            .accessibilityIdentifier("drawer.account.settings")

            Button(role: .destructive) {
                withAnimation(LumoAnimation.quick) { accountMenuOpen = false }
                onSignOut()
            } label: {
                accountMenuRow(label: "Sign out", icon: "rectangle.portrait.and.arrow.right", destructive: true)
            }
            .accessibilityIdentifier("drawer.signOut")
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm)
        .background(LumoColors.surfaceElevated)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private func accountMenuRow(label: String, icon: String, destructive: Bool) -> some View {
        HStack(spacing: LumoSpacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .frame(width: 24)
            Text(label)
                .font(LumoFonts.body)
            Spacer()
        }
        .foregroundStyle(destructive ? Color.red : LumoColors.label)
        .padding(.vertical, LumoSpacing.sm)
        .contentShape(Rectangle())
    }

    // MARK: - Helpers

    private func close() {
        withAnimation(LumoAnimation.smooth) {
            isOpen = false
        }
    }

    private func drawerWidth(for screen: CGFloat) -> CGFloat {
        if horizontalSizeClass == .regular {
            return min(320, screen * 0.45)
        }
        return min(screen * 0.8, 360)
    }
}
