import SwiftUI

/// History destination — list of past chat sessions for the current
/// user, fetched from `GET /api/history?limit_sessions=30`.
///
/// IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase B3 wires the previously-
/// stub view to real backend data. iOS-v1 scope per brief: sessions
/// only, sorted by last_activity_at desc, with preview + relative
/// time + trip-count badge. The merged sessions+trips timeline +
/// search + grouping that web ships are filed deferred as
/// IOS-HISTORY-TIMELINE-1 / IOS-HISTORY-SEARCH-1 / IOS-HISTORY-GROUPING-1.
///
/// Tap-row → opens that session in chat. The actual session-load
/// hand-off requires `ChatViewModel.loadSession(id:)` which doesn't
/// exist yet (filed as MOBILE-CHAT-LOAD-SESSION-1); this view stubs
/// the tap to dismiss-and-flag-the-session-id so the wiring is
/// ready when the chat-side support lands.

struct HistoryView: View {
    @StateObject private var viewModel: HistoryScreenViewModel
    var onSelectSession: (String) -> Void

    init(
        viewModel: HistoryScreenViewModel,
        onSelectSession: @escaping (String) -> Void = { _ in }
    ) {
        self._viewModel = StateObject(wrappedValue: viewModel)
        self.onSelectSession = onSelectSession
    }

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading:
                loadingSkeleton
            case .loaded(let sessions) where sessions.isEmpty:
                emptyState
            case .loaded(let sessions):
                sessionsList(sessions)
            case .error(let message):
                errorState(message)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
    }

    // MARK: - States

    private var loadingSkeleton: some View {
        VStack(spacing: LumoSpacing.sm) {
            ForEach(0..<5, id: \.self) { _ in
                HStack {
                    RoundedRectangle(cornerRadius: LumoRadius.sm)
                        .fill(LumoColors.surfaceElevated)
                        .frame(height: 56)
                }
            }
        }
        .padding(LumoSpacing.md)
        .accessibilityIdentifier("history.loading")
    }

    private var emptyState: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("No conversations yet")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Your conversations will appear here.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("history.empty")
    }

    private func sessionsList(_ sessions: [HistorySessionDTO]) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(sessions) { session in
                    Button {
                        onSelectSession(session.session_id)
                    } label: {
                        HistorySessionRow(session: session)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("history.row.\(session.session_id)")
                    Divider()
                        .background(LumoColors.separator)
                }
            }
            .padding(.horizontal, LumoSpacing.md)
            .padding(.vertical, LumoSpacing.sm)
        }
        .accessibilityIdentifier("history.list")
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: LumoSpacing.md) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(LumoColors.warning)
            Text(message)
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("history.error")
    }
}

private struct HistorySessionRow: View {
    let session: HistorySessionDTO

    var body: some View {
        HStack(alignment: .top, spacing: LumoSpacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.preview ?? "(no preview)")
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(2)
                    .truncationMode(.tail)

                HStack(spacing: LumoSpacing.xs) {
                    Text(HistoryTimeFormatter.formatTimeSince(session.last_activity_at))
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.labelSecondary)
                    if session.tripCount > 0 {
                        Text("·")
                            .font(LumoFonts.caption)
                            .foregroundStyle(LumoColors.labelTertiary)
                        Text("\(session.tripCount) trip\(session.tripCount == 1 ? "" : "s")")
                            .font(LumoFonts.caption.weight(.medium))
                            .foregroundStyle(LumoColors.cyan)
                    }
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(LumoColors.labelTertiary)
        }
        .padding(.vertical, LumoSpacing.md - 2)
        .contentShape(Rectangle())
    }
}
