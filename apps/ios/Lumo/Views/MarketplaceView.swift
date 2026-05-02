import SwiftUI

/// Marketplace destination — list of installable agents fetched from
/// `GET /api/marketplace`. Tap a row → detail view with description +
/// Install/Installed action.
///
/// IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase B2 wires the previously-
/// stub view to real backend data. iOS-v1 scope per brief: simple
/// row + detail flow with Install button. Web's richer surfaces
/// (risk badges, OAuth `connect_model`, MCP connections,
/// `coming_soon` placeholders) are filed deferred as
/// IOS-MARKETPLACE-RICH-CARDS-1.
///
/// Install round-trips `POST /api/lumo/mission/install` — the same
/// idempotent path the chat install-card uses, minus mission/session
/// context (standalone catalog install). The 409 oauth_required
/// path surfaces a "install via web for now" message until the iOS
/// OAuth flow lands in IOS-MARKETPLACE-RICH-CARDS-1.

struct MarketplaceView: View {
    @StateObject private var viewModel: MarketplaceScreenViewModel
    /// DEBUG capture seam (IOS-DRAWER-EDIT-DETAIL-CAPTURES-1) — when
    /// non-nil, the body renders `MarketplaceAgentDetailView` for the
    /// matching agent in place of the list so the screenshot lands
    /// the detail panel without a scripted tap. We render in-place
    /// rather than auto-push to avoid plumbing a nav-path binding
    /// through RootView's NavigationStack just for the capture.
    @Binding private var autoOpenAgentID: String?

    init(
        viewModel: MarketplaceScreenViewModel,
        autoOpenAgentID: Binding<String?> = .constant(nil)
    ) {
        self._viewModel = StateObject(wrappedValue: viewModel)
        self._autoOpenAgentID = autoOpenAgentID
    }

    var body: some View {
        Group {
            // Capture-only short-circuit. If a target agent is set
            // and we've loaded matching data, render its detail
            // directly. Real navigation still flows through the
            // NavigationLink in agentList(_:).
            if let target = autoOpenAgentID,
               case .loaded(let agents) = viewModel.state,
               let agent = agents.first(where: { $0.agent_id == target })
            {
                MarketplaceAgentDetailView(agent: agent, viewModel: viewModel)
            } else {
                switch viewModel.state {
                case .idle, .loading:
                    loadingSkeleton
                case .loaded(let agents) where agents.isEmpty:
                    emptyState
                case .loaded(let agents):
                    agentList(agents)
                case .error(let message):
                    errorState(message)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Marketplace")
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
        .accessibilityIdentifier("marketplace.loading")
    }

    private var emptyState: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "square.grid.3x2")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("No agents available")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Pull to refresh.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("marketplace.empty")
    }

    private func agentList(_ agents: [MarketplaceAgentDTO]) -> some View {
        ScrollView {
            LazyVStack(spacing: LumoSpacing.sm) {
                ForEach(agents) { agent in
                    NavigationLink {
                        MarketplaceAgentDetailView(agent: agent, viewModel: viewModel)
                    } label: {
                        MarketplaceAgentRow(agent: agent)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("marketplace.row.\(agent.agent_id)")
                }
            }
            .padding(LumoSpacing.md)
        }
        .accessibilityIdentifier("marketplace.list")
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
        .accessibilityIdentifier("marketplace.error")
    }
}

private struct MarketplaceAgentRow: View {
    let agent: MarketplaceAgentDTO

    var body: some View {
        HStack(alignment: .top, spacing: LumoSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: LumoRadius.sm)
                    .fill(LumoColors.cyan.opacity(0.15))
                    .frame(width: 44, height: 44)
                Image(systemName: agentGlyph(for: agent.domain))
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(LumoColors.cyan)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(agent.display_name)
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                Text(agent.one_liner)
                    .font(LumoFonts.callout)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .lineLimit(2)
            }

            Spacer()

            if agent.isInstalled {
                Text("Installed")
                    .font(LumoFonts.caption.weight(.medium))
                    .foregroundStyle(LumoColors.cyan)
                    .padding(.horizontal, LumoSpacing.sm)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(LumoColors.cyan.opacity(0.12))
                    )
            } else {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(LumoColors.labelTertiary)
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
        .contentShape(Rectangle())
    }

    private func agentGlyph(for domain: String) -> String {
        switch domain.lowercased() {
        case let d where d.contains("flight"): return "airplane"
        case let d where d.contains("hotel") || d.contains("rental"): return "bed.double.fill"
        case let d where d.contains("food") || d.contains("restaurant"): return "fork.knife"
        case let d where d.contains("ride") || d.contains("ground"): return "car.fill"
        default: return "square.grid.3x2.fill"
        }
    }
}

struct MarketplaceAgentDetailView: View {
    /// The agent as it was when the user navigated in. Used as
    /// the fallback render before the VM publishes its first
    /// post-install state, and after-install once the VM list is
    /// the source of truth.
    let initialAgent: MarketplaceAgentDTO
    @ObservedObject var viewModel: MarketplaceScreenViewModel

    init(agent: MarketplaceAgentDTO, viewModel: MarketplaceScreenViewModel) {
        self.initialAgent = agent
        self.viewModel = viewModel
    }

    /// Resolves to the freshest copy in the VM's loaded list, or
    /// falls back to the initial DTO if the catalog has been
    /// reloaded and the agent is no longer present.
    private var agent: MarketplaceAgentDTO {
        if case .loaded(let agents) = viewModel.state,
           let fresh = agents.first(where: { $0.agent_id == initialAgent.agent_id }) {
            return fresh
        }
        return initialAgent
    }

    private var isInstalled: Bool { agent.isInstalled }
    private var installInFlight: Bool { viewModel.installingAgentID == agent.agent_id }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LumoSpacing.lg) {
                HStack(alignment: .center, spacing: LumoSpacing.md) {
                    ZStack {
                        RoundedRectangle(cornerRadius: LumoRadius.md)
                            .fill(LumoColors.cyan.opacity(0.15))
                            .frame(width: 64, height: 64)
                        Image(systemName: "square.grid.3x2.fill")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(LumoColors.cyan)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(agent.display_name)
                            .font(LumoFonts.title)
                            .foregroundStyle(LumoColors.label)
                        Text(agent.domain)
                            .font(LumoFonts.caption)
                            .foregroundStyle(LumoColors.labelSecondary)
                    }
                }

                Text(agent.one_liner)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.labelSecondary)

                if !agent.intents.isEmpty {
                    VStack(alignment: .leading, spacing: LumoSpacing.sm) {
                        Text("INTENTS")
                            .font(LumoFonts.caption.weight(.semibold))
                            .foregroundStyle(LumoColors.labelTertiary)
                            .tracking(1.2)
                        FlowChips(items: agent.intents)
                    }
                }

                if let err = viewModel.installError {
                    Text(err)
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.warning)
                        .accessibilityIdentifier("marketplace.detail.installError")
                }

                Button(action: handleInstallTap) {
                    HStack(spacing: LumoSpacing.xs) {
                        if installInFlight {
                            ProgressView()
                                .controlSize(.small)
                                .tint(LumoColors.background)
                        }
                        Text(isInstalled ? "Installed" : "Install")
                            .font(LumoFonts.bodyEmphasized)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .foregroundStyle(LumoColors.background)
                    .background(
                        Capsule().fill(isInstalled ? LumoColors.labelTertiary : LumoColors.cyan)
                    )
                }
                .accessibilityIdentifier(isInstalled ? "marketplace.detail.installed" : "marketplace.detail.install")
                .disabled(installInFlight || isInstalled)
            }
            .padding(LumoSpacing.lg)
        }
        .frame(maxWidth: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle(agent.display_name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func handleInstallTap() {
        let id = agent.agent_id
        Task {
            await viewModel.installAgent(id: id)
            if viewModel.installError == nil {
                let h = UINotificationFeedbackGenerator()
                h.notificationOccurred(.success)
            }
        }
    }
}

private struct FlowChips: View {
    let items: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: LumoSpacing.xs) {
                ForEach(items, id: \.self) { item in
                    Text(item)
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.labelSecondary)
                        .padding(.horizontal, LumoSpacing.sm)
                        .padding(.vertical, 4)
                        .background(
                            Capsule().fill(LumoColors.surfaceElevated)
                        )
                        .overlay(
                            Capsule().stroke(LumoColors.separator, lineWidth: 0.5)
                        )
                }
            }
        }
    }
}
