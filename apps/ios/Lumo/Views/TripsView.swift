import SwiftUI

/// Trips destination — newest-first list of bookings the user has
/// initiated through Lumo, fetched from `GET /api/history` (the
/// same endpoint that powers HistoryView; we reuse the shared
/// HistoryScreenViewModel so cross-tab state — expansion,
/// in-flight cancel, success/error banners — stays consistent).
///
/// MOBILE-TRIP-1 — replaces the empty-state stub. Renders the same
/// HistoryTripRow / HistoryTripDetail components HistoryView uses,
/// minus the Sessions section. Filters, search, and grouping are
/// filed deferred (IOS-HISTORY-SEARCH-1, IOS-HISTORY-GROUPING-1).

struct TripsView: View {
    @ObservedObject var viewModel: HistoryScreenViewModel
    var onSelectSession: (String) -> Void

    init(
        viewModel: HistoryScreenViewModel,
        onSelectSession: @escaping (String) -> Void = { _ in }
    ) {
        self.viewModel = viewModel
        self.onSelectSession = onSelectSession
    }

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading:
                loadingSkeleton
            case .loaded where viewModel.trips.isEmpty:
                emptyState
            case .loaded:
                tripsList
            case .error(let message):
                errorState(message)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Trips")
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
                    .frame(height: 92)
            }
        }
        .padding(LumoSpacing.md)
        .accessibilityIdentifier("trips.loading")
    }

    private var emptyState: some View {
        VStack(spacing: LumoSpacing.lg) {
            Image(systemName: "airplane.circle")
                .font(.system(size: 64, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("No trips yet")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text("Trips you book through Lumo will appear here. Try saying \"plan a trip to Vegas\" to get started.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("trips.empty")
    }

    private var tripsList: some View {
        ScrollView {
            LazyVStack(spacing: LumoSpacing.sm) {
                ForEach(viewModel.trips) { trip in
                    HistoryTripRow(
                        trip: trip,
                        isExpanded: viewModel.expandedTripIDs.contains(trip.trip_id),
                        onToggle: { viewModel.toggleTripExpanded(trip.trip_id) },
                        onOpenSession: { onSelectSession(trip.session_id) },
                        viewModel: viewModel
                    )
                }
            }
            .padding(LumoSpacing.md)
        }
        .accessibilityIdentifier("trips.list")
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
        .accessibilityIdentifier("trips.error")
    }
}
