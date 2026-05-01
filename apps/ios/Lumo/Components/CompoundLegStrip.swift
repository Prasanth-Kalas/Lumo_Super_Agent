import SwiftUI

/// CompoundLegStrip — SwiftUI counterpart to the web component
/// at `apps/web/components/CompoundLegStrip.tsx`. Renders the
/// `assistant_compound_dispatch` SSE frame as an in-thread
/// per-leg dispatch strip. The view is read-only — leg statuses
/// flow in from the parent ChatViewModel's per-compound override
/// layer (live updates from the `/api/compound/transactions/:id/stream`
/// SSE subscription managed by `CompoundStreamService`).
///
/// Layout parity with web:
///   - Header: micro-label "MULTI-AGENT DISPATCH" + subtitle
///     "Planning the trip across N agents", with a Live/Settled
///     pill on the right.
///   - N rows: agent glyph (✈ for flights, ⌂ for hotels, ◆ else)
///     in an inset chip + description (single-line truncated) +
///     agent_display_name (caption) + status pill.
///   - Status pill colours match web's tokens — `.success` (ok)
///     for committed, `.error` (danger) for failed/rollback_failed,
///     `.warning` for rolled_back/manual_review, elevated/edge
///     for in_flight/rollback_pending (with a pulse dot), inset
///     for pending.
///
/// IOS-COMPOUND-VIEW-1.
struct CompoundLegStrip: View {
    let payload: CompoundDispatchPayload
    /// Live overrides keyed by leg_id; missing → use the leg's
    /// initial status. The parent passes the merged override dict
    /// from `ChatViewModel.compoundLegStatusOverrides[compound_id]`.
    let overrides: [String: CompoundLegStatus]
    /// Per-leg metadata lookup used by the expanded detail panel
    /// — booking refs, evidence dict, in-flight start time. Pure
    /// closure read so the strip stays cheap to recompute.
    /// IOS-COMPOUND-LEG-DETAIL-1.
    var metadataFor: (String) -> CompoundLegMetadata = { _ in .empty }
    /// Returns true when the row's detail panel should currently
    /// render. Read-only — the parent (ChatViewModel) owns the
    /// `Set<String>` and toggles via `onTapLeg`.
    var isExpanded: (String) -> Bool = { _ in false }
    /// Tap handler — flip the expanded set for this leg_id. nil
    /// disables tap-to-expand (older callers without an integrated
    /// view-model).
    var onTapLeg: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(LumoColors.separator)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(payload.legs.enumerated()), id: \.element.leg_id) { idx, leg in
                    legCell(leg)
                    if idx < payload.legs.count - 1 {
                        Divider().background(LumoColors.separator)
                    }
                }
            }
        }
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.lg)
                .fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.lg)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Multi-agent dispatch")
        .accessibilityIdentifier("compound-leg-strip")
    }

    // MARK: - Header

    private var settled: Bool {
        CompoundDispatchHelpers.isSettled(legs: payload.legs, statuses: overrides)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: LumoSpacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                Text("MULTI-AGENT DISPATCH")
                    .font(LumoFonts.caption.weight(.medium))
                    .tracking(1.4)
                    .foregroundStyle(LumoColors.labelTertiary)
                Text("Planning the trip across \(payload.legs.count) agents")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(2)
            }
            Spacer(minLength: LumoSpacing.sm)
            statusBadge
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 4)
    }

    private var statusBadge: some View {
        Text(settled ? "Settled" : "Live")
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(settled ? LumoColors.labelSecondary : LumoColors.label)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(settled ? LumoColors.surfaceElevated.opacity(0.5) : LumoColors.surfaceElevated)
            )
            .overlay(
                Capsule().stroke(settled ? LumoColors.separator : LumoColors.separator, lineWidth: 1)
            )
            .accessibilityIdentifier("compound-leg-strip-badge")
    }

    // MARK: - Leg cell (row + optional expanded detail)

    @ViewBuilder
    private func legCell(_ leg: CompoundLeg) -> some View {
        let status = overrides[leg.leg_id] ?? leg.status
        let expanded = isExpanded(leg.leg_id)
        VStack(alignment: .leading, spacing: 0) {
            legRow(leg, status: status, expanded: expanded)
            if expanded {
                Divider()
                    .background(LumoColors.separator)
                CompoundLegDetailContent(
                    leg: leg,
                    status: status,
                    metadata: metadataFor(leg.leg_id),
                    settled: settled,
                    allLegs: payload.legs
                )
            }
        }
    }

    private func legRow(_ leg: CompoundLeg, status: CompoundLegStatus, expanded: Bool) -> some View {
        HStack(alignment: .center, spacing: LumoSpacing.sm + 2) {
            // Agent glyph chip — mirrors web's
            // `h-9 w-9 rounded-lg border bg-lumo-inset` look.
            Text(CompoundDispatchHelpers.glyph(for: leg.agent_id))
                .font(.system(size: 17))
                .foregroundStyle(LumoColors.label)
                .frame(width: 36, height: 36)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(LumoColors.surfaceElevated)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(LumoColors.separator, lineWidth: 1)
                )
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(leg.description)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(leg.agent_display_name)
                    .font(.system(size: 11.5))
                    .foregroundStyle(LumoColors.labelTertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 4)

            statusPill(status)
                .accessibilityIdentifier("compound-leg-strip-row-\(leg.leg_id)-status")

            // Chevron — rotates 90° on expand. Hidden when there's
            // no tap handler so older non-interactive callers
            // render the original look.
            if onTapLeg != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(LumoColors.labelTertiary)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .animation(.easeInOut(duration: 0.18), value: expanded)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 2)
        .contentShape(Rectangle())
        .onTapGesture {
            if let handler = onTapLeg {
                handler(leg.leg_id)
            }
        }
        .accessibilityIdentifier("compound-leg-strip-row-\(leg.leg_id)")
        .accessibilityAddTraits(onTapLeg != nil ? .isButton : [])
        .accessibilityHint(Text(expanded ? "Collapse leg detail" : "Expand leg detail"))
    }

    // MARK: - Status pill

    private func statusPill(_ status: CompoundLegStatus) -> some View {
        HStack(spacing: 4) {
            if status.isPulsing && !settled {
                Circle()
                    .fill(pillFor(status).foreground)
                    .frame(width: 6, height: 6)
                    .opacity(pulseOn ? 1 : 0.35)
            }
            Text(status.label)
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(pillFor(status).foreground)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(
            Capsule().fill(pillFor(status).background)
        )
        .overlay(
            Capsule().stroke(pillFor(status).border, lineWidth: 1)
        )
        .onAppear { pulseOn = false; if status.isPulsing && !settled { animatePulse() } }
        .onChange(of: status) { _, newStatus in
            if newStatus.isPulsing && !settled { animatePulse() } else { pulseOn = false }
        }
    }

    @State private var pulseOn: Bool = false

    private func animatePulse() {
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            pulseOn = true
        }
    }

    private struct PillTokens {
        let foreground: Color
        let background: Color
        let border: Color
    }

    private func pillFor(_ status: CompoundLegStatus) -> PillTokens {
        switch status {
        case .committed:
            return PillTokens(
                foreground: LumoColors.success,
                background: LumoColors.success.opacity(0.10),
                border: LumoColors.success.opacity(0.40)
            )
        case .failed, .rollback_failed:
            return PillTokens(
                foreground: LumoColors.error,
                background: LumoColors.error.opacity(0.10),
                border: LumoColors.error.opacity(0.40)
            )
        case .rolled_back, .manual_review:
            return PillTokens(
                foreground: LumoColors.warning,
                background: LumoColors.warning.opacity(0.10),
                border: LumoColors.warning.opacity(0.40)
            )
        case .in_flight, .rollback_pending:
            return PillTokens(
                foreground: LumoColors.label,
                background: LumoColors.surfaceElevated,
                border: LumoColors.separator
            )
        case .pending:
            return PillTokens(
                foreground: LumoColors.labelSecondary,
                background: LumoColors.surfaceElevated.opacity(0.5),
                border: LumoColors.separator
            )
        }
    }
}
