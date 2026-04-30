import SwiftUI

/// Slide-in drawer from the left edge — ChatGPT-style navigation
/// surface for the iOS app. Hosted by `RootView`; rendered as an
/// overlay above the chat content with a dim backdrop that dismisses
/// on tap.
///
/// Layout (top → bottom):
///   • "New Chat" button.
///   • "Recent Chats" header + scrollable list.
///   • Divider.
///   • Trips, Receipts, Profile, Settings rows.
///   • Sign Out button (only when signed in; destructive style).
///
/// Width:
///   • iPhone — 80% of screen width.
///   • iPad — capped at 320 points so the drawer doesn't stretch
///     across the whole compact layout. SwiftUI's
///     horizontalSizeClass distinguishes the two.
///
/// Animation: spring slide via `LumoAnimation.smooth`. The parent
/// drives `isOpen`; transitions happen inside an `.animation()`
/// modifier on the binding.
struct SideDrawerView: View {
    @Binding var isOpen: Bool
    let recents: [RecentChatItem]
    let signedIn: Bool

    var onNewChat: () -> Void
    var onSelectRecent: (RecentChatItem) -> Void
    var onSelectDestination: (DrawerDestination) -> Void
    var onSignOut: () -> Void

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

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
                    destinationRow(.trips, label: "Trips", icon: "airplane")
                    destinationRow(.receipts, label: "Receipts", icon: "doc.text")
                    destinationRow(.profile, label: "Profile", icon: "person.crop.circle")
                    destinationRow(.settings, label: "Settings", icon: "gearshape")
                }
                .padding(.horizontal, LumoSpacing.md)
            }
            footer
        }
        .padding(.top, LumoSpacing.lg)
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

    @ViewBuilder
    private var footer: some View {
        if signedIn {
            VStack(spacing: 0) {
                Divider()
                Button(role: .destructive) {
                    onSignOut()
                } label: {
                    HStack(spacing: LumoSpacing.sm) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .font(.system(size: 16))
                            .frame(width: 28)
                        Text("Sign out")
                            .font(LumoFonts.body)
                        Spacer()
                    }
                    .padding(.horizontal, LumoSpacing.md)
                    .padding(.vertical, LumoSpacing.md)
                    .contentShape(Rectangle())
                }
                .accessibilityIdentifier("drawer.signOut")
            }
        }
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
