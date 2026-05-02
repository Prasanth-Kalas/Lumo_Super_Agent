import SwiftUI

/// History destination — list of past chat sessions and bookings,
/// fetched from `GET /api/history?limit_sessions=30`.
///
/// Two sections, both newest-first:
///   1. Trips — tap to expand → reveals leg list with agent + tool.
///      Status pill + total amount on the row. (Trip cancel is a
///      separate lane.)
///   2. Sessions — preview + relative time + trip-count badge.
///      Tap-row signals onSelectSession with the session_id.
///
/// IOS-HISTORY-SEARCH-1 added filter chips + search.
/// IOS-HISTORY-GROUPING-1 + IOS-HISTORY-TIMELINE-1 added the
/// merged sessions+trips chronological list grouped by day
/// (Today / Yesterday / Earlier this week / month-name for older).
///
/// Tap-session → calls onSelectSession. The chat-side hand-off
/// requires `ChatViewModel.loadSession(id:)` which is filed as
/// MOBILE-CHAT-LOAD-SESSION-1; this view just emits the id.

struct HistoryView: View {
    @StateObject private var viewModel: HistoryScreenViewModel
    var onSelectSession: (String) -> Void
    @State private var query: String = ""
    @State private var filter: HistoryFilter = .all

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
            case .loaded(let sessions) where sessions.isEmpty && viewModel.trips.isEmpty:
                emptyState
            case .loaded(let sessions):
                let filteredSessions = HistoryFilters.matching(
                    sessions: sessions, query: query, filter: filter
                )
                let filteredTrips = HistoryFilters.matching(
                    trips: viewModel.trips, query: query, filter: filter
                )
                let merged = HistoryDayGrouper.merge(
                    sessions: filteredSessions, trips: filteredTrips
                )
                if merged.isEmpty {
                    noMatchesState
                } else {
                    let groups = HistoryDayGrouper.group(merged)
                    timelineList(groups: groups)
                }
            case .error(let message):
                errorState(message)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("History")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search history")
        .toolbar {
            // Filter picker as a navigation-bar-trailing menu so the
            // segmented control doesn't push the chevron-affordance
            // height around. Compact + accessible.
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Picker("Filter", selection: $filter) {
                        ForEach(HistoryFilter.allCases) { f in
                            Text(f.label).tag(f)
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "line.3.horizontal.decrease.circle\(filter == .all ? "" : ".fill")")
                        Text(filter.label)
                    }
                }
                .accessibilityIdentifier("history.filter.menu")
            }
        }
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
    }

    private var noMatchesState: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("No matches")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text(query.isEmpty
                ? "Nothing in this view yet."
                : "Nothing matches \"\(query)\" in \(filter.label).")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("history.noMatches")
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

    private func timelineList(groups: [HistoryDayGroup]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: LumoSpacing.lg) {
                ForEach(groups, id: \.label) { group in
                    sectionHeader(group.label)
                    VStack(spacing: 0) {
                        ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                            timelineRow(item)
                            if index < group.items.count - 1 {
                                if case .session = item, case .session = group.items[index + 1] {
                                    Divider().background(LumoColors.separator)
                                } else {
                                    Spacer().frame(height: LumoSpacing.sm)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, LumoSpacing.md)
            .padding(.vertical, LumoSpacing.sm)
        }
        .accessibilityIdentifier("history.list")
    }

    @ViewBuilder
    private func timelineRow(_ item: HistoryTimelineItem) -> some View {
        switch item {
        case .trip(let trip):
            HistoryTripRow(
                trip: trip,
                isExpanded: viewModel.expandedTripIDs.contains(trip.trip_id),
                onToggle: { viewModel.toggleTripExpanded(trip.trip_id) },
                onOpenSession: { onSelectSession(trip.session_id) },
                viewModel: viewModel
            )
        case .session(let session):
            Button {
                onSelectSession(session.session_id)
            } label: {
                HistorySessionRow(session: session)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("history.row.\(session.session_id)")
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(LumoFonts.caption)
            .tracking(1.2)
            .foregroundStyle(LumoColors.labelTertiary)
            .padding(.top, LumoSpacing.xs)
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

// MARK: - Trip rendering

// MARK: - Reusable trip row (consumed by TripsView)

struct HistoryTripRow: View {
    let trip: HistoryTripDTO
    let isExpanded: Bool
    let onToggle: () -> Void
    let onOpenSession: () -> Void
    @ObservedObject var viewModel: HistoryScreenViewModel

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onToggle) {
                HStack(alignment: .top, spacing: LumoSpacing.md) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: LumoSpacing.xs) {
                            Image(systemName: "arrow.right.circle")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(LumoColors.labelTertiary)
                            Text("TRIP")
                                .font(LumoFonts.caption.weight(.semibold))
                                .tracking(1.4)
                                .foregroundStyle(LumoColors.labelTertiary)
                            HistoryTripStatusPill(status: trip.status)
                        }
                        Text(trip.payload.trip_title ?? "Untitled trip")
                            .font(LumoFonts.bodyEmphasized)
                            .foregroundStyle(LumoColors.label)
                            .lineLimit(2)
                        HStack(spacing: LumoSpacing.xs) {
                            Text(HistoryTimeFormatter.formatTimeSince(trip.updated_at))
                            if let count = trip.payload.legs?.count, count > 0 {
                                Text("·")
                                    .foregroundStyle(LumoColors.labelTertiary)
                                Text("\(count) leg\(count == 1 ? "" : "s")")
                            }
                        }
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.labelSecondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: LumoSpacing.xs) {
                        if let amount = trip.payload.total_amount {
                            Text(HistoryMoneyFormatter.formatMoney(amount, currency: trip.payload.currency))
                                .font(LumoFonts.bodyEmphasized)
                                .foregroundStyle(LumoColors.label)
                        }
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(LumoColors.labelTertiary)
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                            .animation(.easeInOut(duration: 0.15), value: isExpanded)
                    }
                }
                .padding(LumoSpacing.md)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("history.trip.row.\(trip.trip_id)")
            .accessibilityLabel("Trip: \(trip.payload.trip_title ?? "Untitled trip")")
            .accessibilityHint(isExpanded ? "Collapse trip details" : "Expand trip details")

            if isExpanded {
                Divider().background(LumoColors.separator)
                HistoryTripDetail(trip: trip, onOpenSession: onOpenSession, viewModel: viewModel)
                    .padding(LumoSpacing.md)
                    .accessibilityIdentifier("history.trip.detail.\(trip.trip_id)")
            }
        }
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md).fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
    }
}

struct HistoryTripDetail: View {
    let trip: HistoryTripDTO
    let onOpenSession: () -> Void
    @ObservedObject var viewModel: HistoryScreenViewModel
    @State private var showCancelConfirm: Bool = false

    private var isCanceling: Bool {
        viewModel.cancellingTripID == trip.trip_id
    }

    private var canCancel: Bool {
        HistoryScreenViewModel.canCancel(status: trip.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
            Text("Trip \(HistoryTripFormatter.shortID(trip.trip_id)) · started \(HistoryTimeFormatter.formatTimeSince(trip.created_at))")
                .font(LumoFonts.caption)
                .foregroundStyle(LumoColors.labelTertiary)

            if let legs = trip.payload.legs, !legs.isEmpty {
                VStack(spacing: 0) {
                    ForEach(legs) { leg in
                        HStack(alignment: .top, spacing: LumoSpacing.md) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Leg \(leg.order) · \(HistoryTripFormatter.legFriendly(leg.agent_id))")
                                    .font(LumoFonts.caption.weight(.medium))
                                    .foregroundStyle(LumoColors.label)
                                if let tool = leg.tool_name, !tool.isEmpty {
                                    Text(tool)
                                        .font(LumoFonts.caption)
                                        .foregroundStyle(LumoColors.labelTertiary)
                                        .lineLimit(1)
                                }
                            }
                            Spacer()
                        }
                        .padding(.vertical, LumoSpacing.sm)
                        if leg.id != legs.last?.id {
                            Divider().background(LumoColors.separator)
                        }
                    }
                }
                .padding(.horizontal, LumoSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: LumoRadius.sm).fill(LumoColors.background)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: LumoRadius.sm)
                        .stroke(LumoColors.separator, lineWidth: 1)
                )
            }

            HStack(spacing: LumoSpacing.xs) {
                Button(action: onOpenSession) {
                    HStack(spacing: LumoSpacing.xs) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 12, weight: .semibold))
                        Text("Open conversation")
                            .font(LumoFonts.caption.weight(.medium))
                    }
                    .padding(.horizontal, LumoSpacing.sm)
                    .padding(.vertical, LumoSpacing.xs)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .background(
                        RoundedRectangle(cornerRadius: LumoRadius.sm)
                            .stroke(LumoColors.separator, lineWidth: 1)
                    )
                }
                .accessibilityIdentifier("history.trip.openConversation.\(trip.trip_id)")

                if canCancel {
                    Button(role: .destructive) {
                        showCancelConfirm = true
                    } label: {
                        HStack(spacing: LumoSpacing.xs) {
                            if isCanceling {
                                ProgressView()
                                    .controlSize(.mini)
                            }
                            Text(isCanceling ? "Cancelling…" : "Cancel / refund")
                                .font(LumoFonts.caption.weight(.medium))
                        }
                        .padding(.horizontal, LumoSpacing.sm)
                        .padding(.vertical, LumoSpacing.xs)
                        .foregroundStyle(LumoColors.error)
                        .background(
                            RoundedRectangle(cornerRadius: LumoRadius.sm)
                                .stroke(LumoColors.error.opacity(0.4), lineWidth: 1)
                        )
                    }
                    .disabled(isCanceling)
                    .accessibilityIdentifier("history.trip.cancel.\(trip.trip_id)")
                }
            }

            if let msg = viewModel.tripCancelMessage, msg.tripID == trip.trip_id {
                Text(msg.text)
                    .font(LumoFonts.caption)
                    .foregroundStyle(LumoColors.success)
                    .accessibilityIdentifier("history.trip.cancel.success.\(trip.trip_id)")
            }
            if let err = viewModel.tripCancelError, err.tripID == trip.trip_id {
                Text(err.text)
                    .font(LumoFonts.caption)
                    .foregroundStyle(LumoColors.warning)
                    .accessibilityIdentifier("history.trip.cancel.error.\(trip.trip_id)")
            }
        }
        .alert("Cancel this trip?", isPresented: $showCancelConfirm) {
            Button("Keep trip", role: .cancel) {}
            Button("Cancel trip", role: .destructive) {
                Task { await viewModel.cancelTrip(id: trip.trip_id) }
            }
        } message: {
            Text(cancelConfirmMessage(for: trip.status))
        }
    }

    private func cancelConfirmMessage(for status: String) -> String {
        switch status {
        case "draft", "confirmed":
            return "Nothing has been booked yet, but the cancel intent will be recorded."
        case "dispatching":
            return "Lumo is booking this trip right now. Cancelling stops it at the next leg boundary and rolls back any committed legs."
        case "committed":
            return "This trip is already booked. Cancelling runs a refund through each provider where possible."
        default:
            return "This will cancel the trip."
        }
    }
}

struct HistoryTripStatusPill: View {
    let status: String

    var body: some View {
        let style = HistoryTripFormatter.statusStyle(status)
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

// MARK: - Trip helpers (mirror of apps/web/app/history/page.tsx)

enum HistoryTripFormatter {
    struct StatusStyle {
        let label: String
        let foreground: Color
        let background: Color
        let border: Color
    }

    static func statusStyle(_ status: String) -> StatusStyle {
        switch status {
        case "committed":
            return StatusStyle(
                label: "booked",
                foreground: LumoColors.success,
                background: LumoColors.success.opacity(0.10),
                border: LumoColors.success.opacity(0.30)
            )
        case "dispatching":
            return StatusStyle(
                label: "booking…",
                foreground: LumoColors.warning,
                background: LumoColors.warning.opacity(0.10),
                border: LumoColors.warning.opacity(0.30)
            )
        case "confirmed":
            return StatusStyle(
                label: "confirmed",
                foreground: LumoColors.cyan,
                background: LumoColors.cyan.opacity(0.10),
                border: LumoColors.cyan.opacity(0.30)
            )
        case "rolled_back":
            return StatusStyle(
                label: "refunded",
                foreground: LumoColors.labelTertiary,
                background: LumoColors.surfaceElevated,
                border: LumoColors.separator
            )
        case "rollback_failed":
            return StatusStyle(
                label: "needs attention",
                foreground: LumoColors.error,
                background: LumoColors.error.opacity(0.10),
                border: LumoColors.error.opacity(0.30)
            )
        case "draft":
            return StatusStyle(
                label: "draft",
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

    static func legFriendly(_ agentID: String) -> String {
        switch agentID {
        case "flight-agent", "lumo.flight": return "Flight"
        case "hotel-agent", "lumo.hotel": return "Hotel"
        case "food-agent", "lumo.food": return "Food"
        case "restaurant-agent", "lumo.restaurant": return "Restaurant"
        default: return agentID
        }
    }

    static func shortID(_ id: String) -> String {
        id.count > 12 ? String(id.prefix(12)) + "…" : id
    }
}

// MARK: - IOS-HISTORY-SEARCH-1 — filter + search helpers

enum HistoryFilter: String, CaseIterable, Identifiable {
    case all
    case conversations
    case trips

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All"
        case .conversations: return "Conversations"
        case .trips: return "Trips"
        }
    }
}

enum HistoryFilters {
    /// Returns the sessions that match both the active filter and
    /// the (case-insensitive) query. Empty query passes everything
    /// in the filter scope. Mirrors web's
    /// `apps/web/app/history/page.tsx` filter behavior.
    static func matching(
        sessions: [HistorySessionDTO],
        query: String,
        filter: HistoryFilter
    ) -> [HistorySessionDTO] {
        if filter == .trips { return [] }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return sessions }
        return sessions.filter { session in
            (session.preview ?? "").lowercased().contains(q)
        }
    }

    static func matching(
        trips: [HistoryTripDTO],
        query: String,
        filter: HistoryFilter
    ) -> [HistoryTripDTO] {
        if filter == .conversations { return [] }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return trips }
        return trips.filter { trip in
            let title = (trip.payload.trip_title ?? "").lowercased()
            let status = trip.status.lowercased()
            return title.contains(q) || status.contains(q)
        }
    }
}

// MARK: - IOS-HISTORY-GROUPING-1 / IOS-HISTORY-TIMELINE-1

/// A single item on the merged history timeline. Sessions and trips
/// flow through the same chronological list so the user sees a
/// continuous "what I did when" view rather than two parallel
/// streams. Mirrors web's `TimelineItem` discriminated union.
enum HistoryTimelineItem: Identifiable, Equatable {
    case session(HistorySessionDTO)
    case trip(HistoryTripDTO)

    var id: String {
        switch self {
        case .session(let s): return "s:\(s.session_id)"
        case .trip(let t): return "t:\(t.trip_id)"
        }
    }

    /// Date the row sorts/groups by. Sessions use last_activity_at
    /// (the "last time we touched this conversation"), trips use
    /// updated_at (mirrors web; the row already shows it as the
    /// relative time stamp).
    var displayDateISO: String {
        switch self {
        case .session(let s): return s.last_activity_at
        case .trip(let t): return t.updated_at
        }
    }
}

struct HistoryDayGroup: Equatable {
    let label: String
    let items: [HistoryTimelineItem]
}

enum HistoryDayGrouper {
    /// Merge sessions + trips into a single newest-first timeline.
    static func merge(
        sessions: [HistorySessionDTO],
        trips: [HistoryTripDTO]
    ) -> [HistoryTimelineItem] {
        var items: [HistoryTimelineItem] = []
        items.reserveCapacity(sessions.count + trips.count)
        items.append(contentsOf: sessions.map(HistoryTimelineItem.session))
        items.append(contentsOf: trips.map(HistoryTimelineItem.trip))
        items.sort { lhs, rhs in
            // Newest first. Falls back to id stability when dates
            // don't parse — keeps the order deterministic in tests.
            let lDate = HistoryTimeFormatter.parseISO(lhs.displayDateISO) ?? .distantPast
            let rDate = HistoryTimeFormatter.parseISO(rhs.displayDateISO) ?? .distantPast
            if lDate != rDate { return lDate > rDate }
            return lhs.id > rhs.id
        }
        return items
    }

    /// Bucket items by Today / Yesterday / Earlier this week / month-name.
    /// Mirrors web's `groupByDay` in apps/web/app/history/page.tsx
    /// — `now` is injected for tests.
    static func group(
        _ items: [HistoryTimelineItem],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [HistoryDayGroup] {
        let today = calendar.startOfDay(for: now)
        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: today),
              let weekStart = calendar.date(byAdding: .day, value: -6, to: today)
        else { return [HistoryDayGroup(label: "All", items: items)] }

        var groups: [HistoryDayGroup] = []
        var byLabel: [String: Int] = [:]

        for item in items {
            let date = HistoryTimeFormatter.parseISO(item.displayDateISO) ?? .distantPast
            let label = labelFor(date: date, today: today, yesterday: yesterday, weekStart: weekStart, calendar: calendar)
            if let i = byLabel[label] {
                groups[i] = HistoryDayGroup(label: label, items: groups[i].items + [item])
            } else {
                byLabel[label] = groups.count
                groups.append(HistoryDayGroup(label: label, items: [item]))
            }
        }
        return groups
    }

    static func labelFor(
        date: Date,
        today: Date,
        yesterday: Date,
        weekStart: Date,
        calendar: Calendar = .current
    ) -> String {
        if calendar.isDate(date, inSameDayAs: today) { return "Today" }
        if calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        if date >= weekStart { return "Earlier this week" }
        let f = DateFormatter()
        f.dateFormat = "LLLL yyyy"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: date)
    }
}

enum HistoryMoneyFormatter {
    static func formatMoney(_ amount: String, currency: String?) -> String {
        guard let value = Double(amount) else {
            return [amount, currency].compactMap { $0 }.joined(separator: " ")
        }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = (currency?.isEmpty == false) ? currency! : "USD"
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: value)) ?? "\(amount) \(currency ?? "")"
    }
}
