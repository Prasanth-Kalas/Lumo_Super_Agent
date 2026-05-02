import SwiftUI

/// Connections destination — list of OAuth + system-level apps the
/// user has connected to Lumo, fetched from `GET /api/connections`.
///
/// IOS-CONNECTIONS-1 — iOS-v1 surface. Lists each connection with
/// status pill, scopes, source label, connected/last-used dates,
/// and a Disconnect action gated on `source == "oauth"`. Reconnect
/// for expired/error states is deferred until iOS gets the OAuth
/// start flow (IOS-MARKETPLACE-RICH-CARDS-1); for now those rows
/// surface a "Reconnect via web" hint.

struct ConnectionsView: View {
    @StateObject private var viewModel: ConnectionsScreenViewModel

    init(viewModel: ConnectionsScreenViewModel) {
        self._viewModel = StateObject(wrappedValue: viewModel)
    }

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading:
                loadingSkeleton
            case .loaded(let list) where list.isEmpty:
                emptyState
            case .loaded(let list):
                connectionsList(list)
            case .error(let message):
                errorState(message)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Connections")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
    }

    // MARK: - States

    private var loadingSkeleton: some View {
        VStack(spacing: LumoSpacing.sm) {
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: LumoRadius.md)
                    .fill(LumoColors.surfaceElevated)
                    .frame(height: 84)
            }
        }
        .padding(LumoSpacing.md)
        .accessibilityIdentifier("connections.loading")
    }

    private var emptyState: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "link.circle")
                .font(.system(size: 64, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("No connections yet")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Apps you connect to Lumo from Marketplace will appear here.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("connections.empty")
    }

    private func connectionsList(_ items: [ConnectionMetaDTO]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LumoSpacing.sm) {
                if let err = viewModel.disconnectError {
                    Text(err)
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.warning)
                        .accessibilityIdentifier("connections.error.banner")
                }
                ForEach(items) { connection in
                    ConnectionRow(
                        connection: connection,
                        isDisconnecting: viewModel.disconnectingID == connection.id,
                        onDisconnect: { Task { await viewModel.disconnect(id: connection.id) } }
                    )
                }
            }
            .padding(LumoSpacing.md)
        }
        .accessibilityIdentifier("connections.list")
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
        .accessibilityIdentifier("connections.error")
    }
}

// MARK: - Row

private struct ConnectionRow: View {
    let connection: ConnectionMetaDTO
    let isDisconnecting: Bool
    let onDisconnect: () -> Void
    @State private var showConfirm: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
            HStack(alignment: .top, spacing: LumoSpacing.md) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: LumoSpacing.xs) {
                        Text(connection.display_name ?? connection.agent_id)
                            .font(LumoFonts.bodyEmphasized)
                            .foregroundStyle(LumoColors.label)
                        ConnectionStatusPill(status: connection.status)
                        if connection.isSystem {
                            Text("SYSTEM")
                                .font(LumoFonts.caption.weight(.semibold))
                                .tracking(1.4)
                                .foregroundStyle(LumoColors.labelTertiary)
                                .padding(.horizontal, LumoSpacing.xs)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(LumoColors.surfaceElevated))
                                .overlay(Capsule().stroke(LumoColors.separator, lineWidth: 1))
                        }
                    }
                    if let oneLiner = connection.one_liner, !oneLiner.isEmpty {
                        Text(oneLiner)
                            .font(LumoFonts.caption)
                            .foregroundStyle(LumoColors.labelSecondary)
                            .lineLimit(2)
                    }
                    metadataRow
                }
                Spacer()
            }

            if !connection.isSystem {
                HStack(spacing: LumoSpacing.xs) {
                    if connection.status == "expired" || connection.status == "error" {
                        Text("Reconnect via web for now")
                            .font(LumoFonts.caption)
                            .foregroundStyle(LumoColors.warning)
                    }
                    Spacer()
                    Button(role: .destructive) {
                        showConfirm = true
                    } label: {
                        HStack(spacing: LumoSpacing.xs) {
                            if isDisconnecting {
                                ProgressView().controlSize(.mini)
                            }
                            Text(isDisconnecting ? "Disconnecting…" : "Disconnect")
                                .font(LumoFonts.caption.weight(.medium))
                        }
                        .padding(.horizontal, LumoSpacing.sm)
                        .padding(.vertical, LumoSpacing.xs)
                        .foregroundStyle(connection.status == "revoked" ? LumoColors.labelTertiary : LumoColors.error)
                        .background(
                            RoundedRectangle(cornerRadius: LumoRadius.sm)
                                .stroke(
                                    (connection.status == "revoked" ? LumoColors.separator : LumoColors.error.opacity(0.4)),
                                    lineWidth: 1
                                )
                        )
                    }
                    .disabled(isDisconnecting || connection.status == "revoked")
                    .accessibilityIdentifier("connections.disconnect.\(connection.id)")
                }
            }
        }
        .padding(LumoSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md).fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
        .alert("Disconnect this app?", isPresented: $showConfirm) {
            Button("Keep connected", role: .cancel) {}
            Button("Disconnect", role: .destructive, action: onDisconnect)
        } message: {
            Text("Lumo will lose access to this app. You can reconnect later from Marketplace.")
        }
    }

    @ViewBuilder
    private var metadataRow: some View {
        HStack(spacing: LumoSpacing.xs) {
            Text("Connected \(MemoryUI.formatRelative(connection.connected_at))")
            if let lastUsed = connection.last_used_at {
                Text("·")
                    .foregroundStyle(LumoColors.labelTertiary)
                Text("Used \(MemoryUI.formatRelative(lastUsed))")
            }
            if !connection.scopes.isEmpty && !connection.isSystem {
                Text("·")
                    .foregroundStyle(LumoColors.labelTertiary)
                Text("\(connection.scopes.count) scope\(connection.scopes.count == 1 ? "" : "s")")
            }
        }
        .font(LumoFonts.caption)
        .foregroundStyle(LumoColors.labelTertiary)
    }
}

// MARK: - Status pill

struct ConnectionStatusPill: View {
    let status: String

    var body: some View {
        let style = ConnectionsUI.statusStyle(status)
        Text(style.label.uppercased())
            .font(LumoFonts.caption.weight(.semibold))
            .tracking(1.4)
            .foregroundStyle(style.foreground)
            .padding(.horizontal, LumoSpacing.xs + 2)
            .padding(.vertical, 2)
            .background(Capsule().fill(style.background))
            .overlay(Capsule().stroke(style.border, lineWidth: 1))
    }
}

// MARK: - UI helpers

enum ConnectionsUI {
    struct StatusStyle {
        let label: String
        let foreground: Color
        let background: Color
        let border: Color
    }

    static func statusStyle(_ status: String) -> StatusStyle {
        switch status {
        case "active":
            return StatusStyle(
                label: "active",
                foreground: LumoColors.success,
                background: LumoColors.success.opacity(0.10),
                border: LumoColors.success.opacity(0.30)
            )
        case "expired":
            return StatusStyle(
                label: "expired",
                foreground: LumoColors.warning,
                background: LumoColors.warning.opacity(0.10),
                border: LumoColors.warning.opacity(0.30)
            )
        case "error":
            return StatusStyle(
                label: "error",
                foreground: LumoColors.error,
                background: LumoColors.error.opacity(0.10),
                border: LumoColors.error.opacity(0.30)
            )
        case "revoked":
            return StatusStyle(
                label: "revoked",
                foreground: LumoColors.labelTertiary,
                background: LumoColors.surfaceElevated,
                border: LumoColors.separator
            )
        default:
            return StatusStyle(
                label: status,
                foreground: LumoColors.labelTertiary,
                background: LumoColors.surfaceElevated,
                border: LumoColors.separator
            )
        }
    }
}
