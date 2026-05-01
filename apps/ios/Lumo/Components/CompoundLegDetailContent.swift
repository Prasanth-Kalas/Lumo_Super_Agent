import SwiftUI

/// Inline-expand detail panel for a single leg in the compound
/// dispatch strip. Renders below the row when the user taps it
/// (chevron rotates 90°). Pure view — the parent owns expansion
/// state via ChatViewModel.compoundLegDetailExpandedFor.
///
/// IOS-COMPOUND-LEG-DETAIL-1.
///
/// Content is keyed on the leg's current status:
///   - pending          → "Queued — waiting for [dep leg name]"
///   - in_flight        → "Searching [provider] for [activity]"
///                        plus a live elapsed-time ticker
///                        (TimelineView, ~1 s resolution).
///   - committed        → Booking summary lines (provider_reference,
///                        the metadata evidence dict) with a
///                        Confirmed-style success tone.
///   - failed /
///     rollback_pending /
///     rolled_back /
///     rollback_failed  → Failure reason (from evidence) +
///                        what the saga runner did in plain
///                        copy ("Rolled back the dependent
///                        flight booking. Will retry once the
///                        downstream provider stabilizes.").
///   - manual_review    → "Awaiting manual review — Lumo team
///                        will follow up." with the reason.
///
/// The dependency-name resolution for `pending` reads from the
/// dispatch payload's leg list using a simple "the previous
/// non-terminal leg" heuristic. The orchestrator doesn't
/// currently emit an explicit dependency graph in the
/// `assistant_compound_dispatch` frame, so this is a best-effort
/// rendering that matches what users typically see (legs roughly
/// in dispatch order). When the orchestrator-side payload
/// extension lands (filed as a future follow-up), the heuristic
/// flips to the real graph.
struct CompoundLegDetailContent: View {
    let leg: CompoundLeg
    let status: CompoundLegStatus
    let metadata: CompoundLegMetadata
    /// True when the entire compound transaction has settled.
    /// Drives ticker suppression for terminal-but-still-displayed
    /// states (a leg that committed shouldn't keep ticking).
    let settled: Bool
    /// Used for resolving the pending-dep label and the rollback
    /// cascade enumeration on the failed-leg detail panel.
    let allLegs: [CompoundLeg]
    /// Per-leg override layer — used by the failure branch to
    /// resolve cascade target descriptions against the live status
    /// rather than the dispatch payload's stale initial.
    /// IOS-COMPOUND-ROLLBACK-VIEW-1.
    var overrides: [String: CompoundLegStatus] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch status {
            case .pending:
                pendingContent
            case .in_flight, .rollback_pending:
                inFlightContent
            case .committed:
                committedContent
            case .failed, .rolled_back, .rollback_failed:
                failureContent
            case .manual_review:
                manualReviewContent
            }
        }
        .padding(.horizontal, LumoSpacing.md)
        .padding(.vertical, LumoSpacing.sm + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LumoColors.surfaceElevated.opacity(0.4))
        .accessibilityIdentifier("compound-leg-strip-row-\(leg.leg_id)-detail")
    }

    // MARK: - Status branches

    @ViewBuilder
    private var pendingContent: some View {
        let depName = previousLegDescription()
        labeledLine(
            label: "QUEUED",
            text: depName.map { "Waiting for \($0)" } ?? "Waiting for an earlier leg to commit",
            tone: .secondary
        )
    }

    @ViewBuilder
    private var inFlightContent: some View {
        let activity = activityForAgent(leg.agent_id)
        labeledLine(
            label: status == .rollback_pending ? "ROLLING BACK" : "SEARCHING",
            text: "\(providerLabel) — \(activity)",
            tone: .primary
        )
        // Live elapsed-time ticker. TimelineView re-renders the
        // body once per second so we don't need a Timer/Task.
        // Suppresses on settled (the ticker is meaningless once
        // the saga has reached terminal state for this compound).
        if let started = metadata.firstSeenInFlightAt, !settled {
            TimelineView(.periodic(from: .now, by: 1.0)) { context in
                Text(elapsedLabel(from: started, now: context.date))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(LumoColors.labelTertiary)
                    .accessibilityIdentifier("compound-leg-strip-row-\(leg.leg_id)-elapsed")
            }
        }
    }

    @ViewBuilder
    private var committedContent: some View {
        labeledLine(label: "CONFIRMED", text: "Booking complete.", tone: .success)
        if let ref = metadata.provider_reference {
            labeledLine(label: "REFERENCE", text: ref, tone: .secondary, mono: true)
        }
        // Render evidence dict verbatim (e.g. flight: route,
        // hotel: check-in/out). Sorted for stable ordering across
        // re-renders.
        if let evidence = metadata.evidence, !evidence.isEmpty {
            ForEach(evidence.keys.sorted(), id: \.self) { key in
                if let value = evidence[key] {
                    labeledLine(label: key.uppercased().replacingOccurrences(of: "_", with: " "), text: value, tone: .secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var failureContent: some View {
        let title = status == .failed ? "FAILED"
            : status == .rolled_back ? "ROLLED BACK"
            : "ROLLBACK FAILED"
        labeledLine(
            label: title,
            text: failureReason(),
            tone: .error
        )
        labeledLine(
            label: "SAGA",
            text: sagaActionDescription(for: status),
            tone: .secondary
        )
        // Rollback-plan enumeration on the failed-leg detail panel:
        // when this leg is the saga root failure (status == .failed
        // or .rollback_failed), list the dependents the saga is
        // rolling back. IOS-COMPOUND-ROLLBACK-VIEW-1.
        if status == .failed || status == .rollback_failed {
            let plan = rollbackPlanText()
            if !plan.isEmpty {
                labeledLine(
                    label: "ROLLBACK PLAN",
                    text: plan,
                    tone: .warning
                )
            }
        }
    }

    @ViewBuilder
    private var manualReviewContent: some View {
        labeledLine(
            label: "MANUAL REVIEW",
            text: "Awaiting manual review — the Lumo team will follow up shortly.",
            tone: .warning
        )
        if let reason = (metadata.evidence?["reason"]) {
            labeledLine(label: "REASON", text: reason, tone: .secondary)
        }
    }

    // MARK: - Building blocks

    private enum Tone {
        case primary, secondary, success, warning, error
    }

    private func toneColor(_ tone: Tone) -> Color {
        switch tone {
        case .primary:   return LumoColors.label
        case .secondary: return LumoColors.labelSecondary
        case .success:   return LumoColors.success
        case .warning:   return LumoColors.warning
        case .error:     return LumoColors.error
        }
    }

    private func labeledLine(label: String, text: String, tone: Tone, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(LumoFonts.caption.weight(.medium))
                .tracking(1.4)
                .foregroundStyle(LumoColors.labelTertiary)
            Text(text)
                .font(mono ? .system(.footnote, design: .monospaced) : .system(size: 13))
                .foregroundStyle(toneColor(tone))
                .lineLimit(3)
        }
    }

    // MARK: - Copy helpers

    /// Best-effort dependency lookup — name the previous leg in
    /// the dispatch list as the pending leg's wait target. The
    /// orchestrator doesn't ship an explicit dependency graph in
    /// the dispatch frame today, so this approximates what the
    /// user sees (legs in dispatch order). Returns nil for the
    /// first leg.
    private func previousLegDescription() -> String? {
        guard let idx = allLegs.firstIndex(where: { $0.leg_id == leg.leg_id }), idx > 0 else { return nil }
        return allLegs[idx - 1].description
    }

    /// Provider label — Duffel for flights, Booking.com for
    /// hotels, OpenTable for restaurants, agent_display_name
    /// otherwise.
    private var providerLabel: String {
        let id = leg.agent_id
        if id.contains("flight") { return "Duffel" }
        if id.contains("hotel")  { return "Booking.com" }
        if id.contains("restaurant") || id.contains("dining") { return "OpenTable" }
        return leg.agent_display_name
    }

    private func activityForAgent(_ agentID: String) -> String {
        if agentID.contains("flight") { return "available flights" }
        if agentID.contains("hotel") { return "available rooms" }
        if agentID.contains("restaurant") { return "open reservation slots" }
        if agentID.contains("food") { return "menu options" }
        return "matching options"
    }

    private func failureReason() -> String {
        if let reason = metadata.evidence?["reason"], !reason.isEmpty {
            return humanizeReason(reason)
        }
        if let providerStatus = metadata.evidence?["provider_status"], !providerStatus.isEmpty {
            return "Provider returned \(providerStatus)."
        }
        return "The booking step couldn't complete."
    }

    private func humanizeReason(_ raw: String) -> String {
        // Light snake_case → readable mapping. Unknown reasons
        // pass through as-is rather than risk hiding signal.
        switch raw {
        case "rate_unavailable":      return "Rate unavailable — provider re-quoted between price-lock and book."
        case "card_declined":         return "Card declined."
        case "provider_timeout":      return "Provider timed out before confirming."
        case "inventory_changed":     return "Inventory changed mid-flight."
        case "policy_blocked":        return "Blocked by booking policy."
        case "duplicate_idempotency": return "Duplicate idempotency key — booking may already exist."
        default:
            return raw.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// Build the "hotel and dinner are being rolled back" copy
    /// for the failed leg's detail panel. Uses the cascade
    /// helper against the override layer so descriptions reflect
    /// the live status (a dependent that's already
    /// `rollback_failed` reads as such, distinct from the
    /// majority that are still `rollback_pending` /
    /// `rolled_back`). Returns "" when there are no dependents,
    /// so the labeledLine is suppressed.
    func rollbackPlanText() -> String {
        let cascadeIDs = CompoundDispatchHelpers.cascade(
            failedLegID: leg.leg_id,
            legs: allLegs
        )
        if cascadeIDs.isEmpty { return "" }

        // Group dependents by their live status so the copy can
        // distinguish "rolled back" from "rolling back" from
        // "escalated".
        var rolled: [String] = []
        var rolling: [String] = []
        var escalated: [String] = []
        for legID in cascadeIDs {
            guard let dep = allLegs.first(where: { $0.leg_id == legID }) else { continue }
            let s = overrides[dep.leg_id] ?? dep.status
            switch s {
            case .rolled_back:
                rolled.append(humanizedLegName(dep))
            case .rollback_pending:
                rolling.append(humanizedLegName(dep))
            case .rollback_failed, .manual_review:
                escalated.append(humanizedLegName(dep))
            default:
                // Pre-rollback statuses — saga hasn't started
                // compensation yet. Treat as "rolling back" for
                // the user-facing copy since that's the saga's
                // intent.
                rolling.append(humanizedLegName(dep))
            }
        }

        var sentences: [String] = []
        if !rolling.isEmpty {
            sentences.append("\(joinNames(rolling)) \(verb(for: rolling)) being rolled back.")
        }
        if !rolled.isEmpty {
            sentences.append("\(joinNames(rolled)) \(verb(for: rolled)) already rolled back.")
        }
        if !escalated.isEmpty {
            sentences.append("\(joinNames(escalated)) escalated to manual review.")
        }
        return sentences.joined(separator: " ")
    }

    /// "Booking flight ORD → LAS" → "the flight". Falls back to
    /// the agent display name for unknown shapes. Keeps the
    /// rollback copy readable rather than echoing full
    /// descriptions verbatim.
    private func humanizedLegName(_ dep: CompoundLeg) -> String {
        let id = dep.agent_id
        if id.contains("flight") { return "the flight" }
        if id.contains("hotel") { return "the hotel" }
        if id.contains("restaurant") || id.contains("dining") { return "the dinner reservation" }
        if id.contains("food") { return "the food order" }
        return dep.agent_display_name
    }

    private func joinNames(_ names: [String]) -> String {
        switch names.count {
        case 0:  return ""
        case 1:  return names[0].capitalizedFirst
        case 2:  return "\(names[0].capitalizedFirst) and \(names[1])"
        default:
            let head = names.dropLast().joined(separator: ", ")
            return "\(head.capitalizedFirst), and \(names.last!)"
        }
    }

    private func verb(for names: [String]) -> String {
        names.count == 1 ? "is" : "are"
    }

    private func sagaActionDescription(for status: CompoundLegStatus) -> String {
        switch status {
        case .failed:
            return "Saga halted; dependent legs will roll back."
        case .rolled_back:
            return "This leg was rolled back as part of a saga compensation; the booking did not commit."
        case .rollback_failed:
            return "Compensating rollback could not complete — escalated to the Lumo team."
        default:
            return ""
        }
    }

    private func elapsedLabel(from start: Date, now: Date) -> String {
        let secs = max(0, Int(now.timeIntervalSince(start)))
        if secs < 60 { return "Elapsed: \(secs)s" }
        let m = secs / 60
        let s = secs % 60
        return "Elapsed: \(m)m \(s)s"
    }
}

private extension String {
    /// Uppercase the first character only — for sentence-case
    /// joining of leg-name fragments ("the flight" → "The flight").
    /// Keeps the rest of the string verbatim.
    var capitalizedFirst: String {
        guard let first = first else { return self }
        return String(first).uppercased() + dropFirst()
    }
}
