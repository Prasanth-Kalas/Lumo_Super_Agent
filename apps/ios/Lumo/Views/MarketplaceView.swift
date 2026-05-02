import SwiftUI

/// Marketplace destination — App Store-style browse surface for the
/// agents the user can install or connect.
///
/// Layout:
///   • Featured hero card pinned to the top.
///   • Per-category horizontal-scroll rails for the rest, grouped
///     by `listing.category` (with a friendly fallback when listing
///     is sparse: domain → category label).
///
/// Install round-trips `POST /api/lumo/mission/install` (the same
/// idempotent path the chat install-card uses, minus mission/session
/// context). MCP servers route through `McpConnectSheet`. OAuth
/// agents surface a "Connect via web" hint until the iOS OAuth
/// start flow lands in IOS-MARKETPLACE-OAUTH-START-1.
///
/// Risk badges are intentionally not rendered — the certified
/// publish flow makes per-agent risk pills noisy for end users.
/// `risk_badge` stays on the DTO for forward compat but the UI
/// ignores it.

struct MarketplaceView: View {
    @StateObject private var viewModel: MarketplaceScreenViewModel
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
                    browseLayout(agents)
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
        VStack(spacing: LumoSpacing.lg) {
            RoundedRectangle(cornerRadius: LumoRadius.lg)
                .fill(LumoColors.surfaceElevated)
                .frame(height: 200)
            ForEach(0..<2, id: \.self) { _ in
                VStack(alignment: .leading, spacing: LumoSpacing.sm) {
                    RoundedRectangle(cornerRadius: LumoRadius.sm)
                        .fill(LumoColors.surfaceElevated)
                        .frame(width: 120, height: 18)
                    HStack(spacing: LumoSpacing.md) {
                        ForEach(0..<3, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: LumoRadius.md)
                                .fill(LumoColors.surfaceElevated)
                                .frame(width: 240, height: 96)
                        }
                    }
                }
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

    // MARK: - Browse layout

    private func browseLayout(_ agents: [MarketplaceAgentDTO]) -> some View {
        let featured = MarketplaceUI.featured(from: agents)
        let groups = MarketplaceUI.groupByCategory(agents.filter { $0.agent_id != featured?.agent_id })
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: LumoSpacing.xl) {
                if let featured {
                    sectionHeader("FEATURED")
                    NavigationLink {
                        MarketplaceAgentDetailView(agent: featured, viewModel: viewModel)
                    } label: {
                        MarketplaceFeaturedCard(agent: featured)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("marketplace.featured.\(featured.agent_id)")
                }
                ForEach(groups, id: \.label) { group in
                    rail(label: group.label, agents: group.agents)
                }
            }
            .padding(.horizontal, LumoSpacing.md)
            .padding(.vertical, LumoSpacing.lg)
        }
        .accessibilityIdentifier("marketplace.list")
    }

    private func rail(label: String, agents: [MarketplaceAgentDTO]) -> some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
            sectionHeader(label.uppercased())
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: LumoSpacing.md) {
                    ForEach(agents) { agent in
                        NavigationLink {
                            MarketplaceAgentDetailView(agent: agent, viewModel: viewModel)
                        } label: {
                            MarketplaceRailCard(agent: agent)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("marketplace.row.\(agent.agent_id)")
                    }
                }
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(LumoFonts.caption.weight(.semibold))
            .tracking(1.4)
            .foregroundStyle(LumoColors.labelTertiary)
    }
}

// MARK: - Featured hero

private struct MarketplaceFeaturedCard: View {
    let agent: MarketplaceAgentDTO

    var body: some View {
        let tint = MarketplaceUI.tint(for: agent.agent_id)
        VStack(alignment: .leading, spacing: LumoSpacing.lg) {
            HStack(alignment: .top) {
                MarketplaceAgentIcon(agent: agent, size: 92, cornerRadius: 22)
                Spacer()
                if agent.isInstalled {
                    Text("INSTALLED")
                        .font(LumoFonts.caption.weight(.semibold))
                        .tracking(1.2)
                        .foregroundStyle(LumoColors.cyan)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(MarketplaceUI.categoryLabel(for: agent))
                    .font(LumoFonts.caption.weight(.semibold))
                    .tracking(1.4)
                    .foregroundStyle(tint.opacity(0.9))
                Text(agent.display_name)
                    .font(LumoFonts.largeTitle)
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                Text(agent.one_liner)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(LumoSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.lg, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [tint.opacity(0.18), tint.opacity(0.05)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.lg, style: .continuous)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
    }
}

// MARK: - Rail card (horizontal scroll)

private struct MarketplaceRailCard: View {
    let agent: MarketplaceAgentDTO

    var body: some View {
        HStack(alignment: .center, spacing: LumoSpacing.md) {
            MarketplaceAgentIcon(agent: agent, size: 56, cornerRadius: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.display_name)
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(1)
                Text(agent.one_liner)
                    .font(LumoFonts.caption)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            MarketplaceActionPill(agent: agent)
        }
        .padding(LumoSpacing.md)
        .frame(width: 280, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md, style: .continuous)
                .fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md, style: .continuous)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
        .contentShape(Rectangle())
    }
}

// MARK: - Compact action pill (used in rail cards)

private struct MarketplaceActionPill: View {
    let agent: MarketplaceAgentDTO

    var body: some View {
        Group {
            if agent.isComingSoon {
                Text("SOON")
                    .font(LumoFonts.caption.weight(.semibold))
                    .tracking(1.2)
                    .foregroundStyle(LumoColors.labelTertiary)
                    .padding(.horizontal, LumoSpacing.sm)
                    .padding(.vertical, 4)
                    .overlay(
                        Capsule()
                            .strokeBorder(LumoColors.separator, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                    )
            } else if agent.isInstalled {
                Text("OPEN")
                    .font(LumoFonts.caption.weight(.semibold))
                    .tracking(1.2)
                    .foregroundStyle(LumoColors.cyan)
                    .padding(.horizontal, LumoSpacing.sm)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(LumoColors.cyan.opacity(0.12)))
            } else {
                Text("GET")
                    .font(LumoFonts.caption.weight(.semibold))
                    .tracking(1.2)
                    .foregroundStyle(LumoColors.label)
                    .padding(.horizontal, LumoSpacing.sm + 2)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(LumoColors.surfaceElevated))
            }
        }
    }
}

// MARK: - Shared icon component

private struct MarketplaceAgentIcon: View {
    let agent: MarketplaceAgentDTO
    let size: CGFloat
    let cornerRadius: CGFloat

    var body: some View {
        let tint = MarketplaceUI.tint(for: agent.agent_id)
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [tint.opacity(0.85), tint.opacity(0.55)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            Image(systemName: MarketplaceUI.glyph(for: agent.domain))
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .shadow(color: tint.opacity(0.25), radius: 6, x: 0, y: 4)
    }
}

// MARK: - Detail

struct MarketplaceAgentDetailView: View {
    let initialAgent: MarketplaceAgentDTO
    @ObservedObject var viewModel: MarketplaceScreenViewModel
    @State private var showMcpSheet: Bool = false

    init(agent: MarketplaceAgentDTO, viewModel: MarketplaceScreenViewModel) {
        self.initialAgent = agent
        self.viewModel = viewModel
    }

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
                // Hero header — large icon + name + category + small CTA.
                HStack(alignment: .center, spacing: LumoSpacing.lg) {
                    MarketplaceAgentIcon(agent: agent, size: 96, cornerRadius: 22)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(agent.display_name)
                            .font(LumoFonts.title)
                            .foregroundStyle(LumoColors.label)
                            .lineLimit(2)
                        Text(MarketplaceUI.categoryLabel(for: agent))
                            .font(LumoFonts.caption)
                            .foregroundStyle(LumoColors.labelSecondary)
                        primaryCta
                            .padding(.top, LumoSpacing.xs)
                    }
                    Spacer(minLength: 0)
                }

                // Description block.
                Text(agent.one_liner)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.label)
                    .fixedSize(horizontal: false, vertical: true)

                // Information section — App Store-style metadata grid.
                infoSection

                if !agent.intents.isEmpty {
                    VStack(alignment: .leading, spacing: LumoSpacing.sm) {
                        Text("WHAT IT DOES")
                            .font(LumoFonts.caption.weight(.semibold))
                            .foregroundStyle(LumoColors.labelTertiary)
                            .tracking(1.4)
                        FlowChips(items: agent.intents)
                    }
                }

                if let err = viewModel.installError {
                    Text(err)
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.warning)
                        .accessibilityIdentifier("marketplace.detail.installError")
                }

                if let success = viewModel.mcpConnectSuccessAgentID, success == agent.agent_id {
                    Text("Connected. Manage from Settings → Connections.")
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.success)
                        .accessibilityIdentifier("marketplace.detail.mcpSuccess")
                }
            }
            .padding(LumoSpacing.lg)
        }
        .frame(maxWidth: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle(agent.display_name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showMcpSheet) {
            McpConnectSheet(
                agent: agent,
                viewModel: viewModel,
                onDismiss: { showMcpSheet = false }
            )
        }
        .onChange(of: viewModel.mcpConnectSuccessAgentID) { _, newValue in
            guard newValue == agent.agent_id else { return }
            Task {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if viewModel.mcpConnectSuccessAgentID == agent.agent_id {
                    viewModel.clearMcpConnectSuccess()
                }
            }
        }
    }

    @ViewBuilder
    private var primaryCta: some View {
        if agent.isComingSoon {
            Text(agent.coming_soon_label ?? "Coming soon")
                .font(LumoFonts.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(LumoColors.labelTertiary)
                .padding(.horizontal, LumoSpacing.md)
                .padding(.vertical, 6)
                .overlay(
                    Capsule()
                        .strokeBorder(LumoColors.separator, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                )
                .accessibilityIdentifier("marketplace.detail.comingSoon")
        } else if agent.requiresMcpToken {
            Button {
                showMcpSheet = true
            } label: {
                Text("CONNECT")
                    .font(LumoFonts.caption.weight(.semibold))
                    .tracking(1.2)
                    .foregroundStyle(LumoColors.label)
                    .padding(.horizontal, LumoSpacing.md)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(LumoColors.surfaceElevated))
            }
            .disabled(viewModel.mcpConnectingAgentID == agent.agent_id)
            .accessibilityIdentifier("marketplace.detail.connectMcp")
        } else if agent.requiresOAuth && !agent.isInstalled {
            Text("OAUTH · WEB")
                .font(LumoFonts.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(LumoColors.warning)
                .padding(.horizontal, LumoSpacing.md)
                .padding(.vertical, 6)
                .overlay(Capsule().stroke(LumoColors.warning.opacity(0.45), lineWidth: 1))
                .accessibilityIdentifier("marketplace.detail.oauthHint")
        } else {
            Button(action: handleInstallTap) {
                HStack(spacing: 6) {
                    if installInFlight {
                        ProgressView()
                            .controlSize(.mini)
                    }
                    Text(isInstalled ? "OPEN" : "GET")
                        .font(LumoFonts.caption.weight(.semibold))
                        .tracking(1.2)
                }
                .foregroundStyle(isInstalled ? LumoColors.cyan : LumoColors.label)
                .padding(.horizontal, LumoSpacing.md)
                .padding(.vertical, 6)
                .background(
                    Capsule().fill(isInstalled ? LumoColors.cyan.opacity(0.12) : LumoColors.surfaceElevated)
                )
            }
            .accessibilityIdentifier(isInstalled ? "marketplace.detail.installed" : "marketplace.detail.install")
            .disabled(installInFlight || isInstalled)
        }
    }

    @ViewBuilder
    private var infoSection: some View {
        let rows: [(String, String)] = [
            ("Category", MarketplaceUI.categoryLabel(for: agent)),
            ("Connect", MarketplaceUI.connectLabel(for: agent)),
            ("Status", isInstalled ? "Installed" : (agent.isComingSoon ? "Coming soon" : "Available")),
        ]
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                HStack {
                    Text(row.0)
                        .font(LumoFonts.callout)
                        .foregroundStyle(LumoColors.labelSecondary)
                    Spacer()
                    Text(row.1)
                        .font(LumoFonts.callout)
                        .foregroundStyle(LumoColors.label)
                }
                .padding(.vertical, LumoSpacing.sm)
                .padding(.horizontal, LumoSpacing.md)
                if index < rows.count - 1 {
                    Divider().background(LumoColors.separator)
                        .padding(.leading, LumoSpacing.md)
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md, style: .continuous)
                .fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md, style: .continuous)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
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

// MARK: - Intents flow chips (carried over from prior layout)

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

// MARK: - IOS-MARKETPLACE-RICH-CARDS-1 — connect-model pill (kept for
// detail header use elsewhere if needed; risk pill removed).

struct MarketplaceConnectModelPill: View {
    let label: String

    var body: some View {
        Text(label.uppercased())
            .font(LumoFonts.caption.weight(.semibold))
            .tracking(1.2)
            .foregroundStyle(LumoColors.labelTertiary)
            .padding(.horizontal, LumoSpacing.xs)
            .padding(.vertical, 2)
            .background(Capsule().fill(LumoColors.surfaceElevated))
            .overlay(Capsule().stroke(LumoColors.separator, lineWidth: 1))
    }
}

// MARK: - UI helpers

enum MarketplaceUI {
    struct CategoryGroup: Equatable {
        let label: String
        let agents: [MarketplaceAgentDTO]
    }

    /// Picks the agent that should sit in the featured hero slot.
    /// Prefers the first installed agent (so users see their own
    /// space first); falls back to the first agent in the catalog.
    static func featured(from agents: [MarketplaceAgentDTO]) -> MarketplaceAgentDTO? {
        if let installed = agents.first(where: { $0.isInstalled }) { return installed }
        return agents.first
    }

    /// Buckets agents by listing.category, falling back to a friendly
    /// label derived from `domain` when `listing.category` is nil.
    /// Bucket order is stable across renders (alphabetical labels).
    static func groupByCategory(_ agents: [MarketplaceAgentDTO]) -> [CategoryGroup] {
        var buckets: [String: [MarketplaceAgentDTO]] = [:]
        for agent in agents {
            let label = categoryLabel(for: agent)
            buckets[label, default: []].append(agent)
        }
        return buckets.keys.sorted().map { key in
            CategoryGroup(label: key, agents: buckets[key] ?? [])
        }
    }

    /// Friendly category label for an agent. Uses listing.category
    /// when present; otherwise maps domain → human label.
    static func categoryLabel(for agent: MarketplaceAgentDTO) -> String {
        if let raw = agent.listing?.category, !raw.isEmpty {
            return titleize(raw)
        }
        return categoryFromDomain(agent.domain)
    }

    static func categoryFromDomain(_ domain: String) -> String {
        switch domain.lowercased() {
        case let d where d.contains("flight"): return "Travel"
        case let d where d.contains("hotel") || d.contains("rental") || d.contains("stay"): return "Travel"
        case let d where d.contains("food") || d.contains("restaurant"): return "Food & Drink"
        case let d where d.contains("ride") || d.contains("ground") || d.contains("car"): return "Travel"
        case let d where d.contains("calendar") || d.contains("mail") || d.contains("messag"): return "Productivity"
        case let d where d.contains("media") || d.contains("music") || d.contains("video"): return "Entertainment"
        case let d where d.contains("finance") || d.contains("pay") || d.contains("bank"): return "Finance"
        case let d where d.contains("shop") || d.contains("retail"): return "Shopping"
        default: return "Lifestyle"
        }
    }

    static func connectLabel(for agent: MarketplaceAgentDTO) -> String {
        if agent.requiresOAuth { return "OAuth (web)" }
        if agent.requiresMcpToken { return "MCP token" }
        if agent.source == "mcp" { return "MCP" }
        if agent.connect_model == "lumo_id" { return "Built-in" }
        return "No setup"
    }

    /// SF Symbol glyph keyed off the agent's domain. The icon
    /// renders white on a tinted background so the visual variety
    /// comes from the domain → tint mapping rather than the glyph
    /// alone.
    static func glyph(for domain: String) -> String {
        switch domain.lowercased() {
        case let d where d.contains("flight"): return "airplane"
        case let d where d.contains("hotel") || d.contains("rental") || d.contains("stay"): return "bed.double.fill"
        case let d where d.contains("food") || d.contains("restaurant"): return "fork.knife"
        case let d where d.contains("ride") || d.contains("ground") || d.contains("car"): return "car.fill"
        case let d where d.contains("calendar"): return "calendar"
        case let d where d.contains("mail"): return "envelope.fill"
        case let d where d.contains("messag") || d.contains("chat"): return "bubble.left.and.bubble.right.fill"
        case let d where d.contains("music"): return "music.note"
        case let d where d.contains("video"): return "play.rectangle.fill"
        case let d where d.contains("finance") || d.contains("pay") || d.contains("bank"): return "creditcard.fill"
        case let d where d.contains("shop") || d.contains("retail"): return "bag.fill"
        default: return "square.grid.3x2.fill"
        }
    }

    /// Deterministic per-agent tint from a small brand-aligned
    /// palette. Hashed off agent_id so the same agent always lands
    /// on the same tile color across renders.
    static func tint(for agentID: String) -> Color {
        let palette: [Color] = [
            LumoColors.cyan,
            LumoColors.cyanDeep,
            Color(red: 0.40, green: 0.62, blue: 0.95),
            Color(red: 0.55, green: 0.45, blue: 0.95),
            Color(red: 0.95, green: 0.55, blue: 0.40),
            Color(red: 0.30, green: 0.75, blue: 0.55),
        ]
        let hash = agentID.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return palette[abs(hash) % palette.count]
    }

    private static func titleize(_ s: String) -> String {
        let cleaned = s.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        return cleaned
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
