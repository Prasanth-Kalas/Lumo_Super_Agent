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
/// Install uses the existing `POST /api/lumo/mission/install` path
/// (the same idempotent route the chat install card uses) — wiring
/// hook is left as a closure on the detail view so the lane doesn't
/// pull in the install-card payload shape; IOS-MARKETPLACE-INSTALL-1
/// will close that loop. For now Install is a placeholder that
/// flips state locally and surfaces a haptic.

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
                MarketplaceAgentDetailView(agent: agent)
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
                        MarketplaceAgentDetailView(agent: agent)
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
    let agent: MarketplaceAgentDTO
    @State private var isInstalled: Bool = false
    @State private var installInFlight: Bool = false

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
        .onAppear {
            isInstalled = agent.isInstalled
        }
    }

    private func handleInstallTap() {
        // IOS-MARKETPLACE-INSTALL-1 follow-up wires the real
        // POST /api/lumo/mission/install round-trip. For now the
        // tap surfaces success haptic + flips local state so the
        // capture's two states (Install / Installed) both render
        // deterministically.
        installInFlight = true
        Task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            await MainActor.run {
                isInstalled = true
                installInFlight = false
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
