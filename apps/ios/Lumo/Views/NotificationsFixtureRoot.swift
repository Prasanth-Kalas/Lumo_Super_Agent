#if DEBUG
import SwiftUI

/// DEBUG-only root for capturing notification + proactive-moments
/// screenshots deterministically. Activated by
/// `-LumoNotificationsFixture <name>` launch arg.
///
/// Fixtures:
///   proactive-cards   → Chat tab with two seeded proactive cards above the composer
///   settings          → Settings tab scrolled to the Notifications section
///   permission-denied → Settings tab with the Notifications section, master OFF, denied label

enum NotificationsFixture: String {
    case proactiveCards = "proactive-cards"
    case settings = "settings"
    case permissionDenied = "permission-denied"

    static var current: NotificationsFixture? {
        guard let raw = UserDefaults.standard.string(forKey: "LumoNotificationsFixture"),
              !raw.isEmpty else {
            return nil
        }
        return NotificationsFixture(rawValue: raw)
    }
}

struct NotificationsFixtureRoot: View {
    let fixture: NotificationsFixture
    let cache: ProactiveMomentsCache

    private let appConfig: AppConfig

    init(fixture: NotificationsFixture, cache: ProactiveMomentsCache) {
        self.fixture = fixture
        self.cache = cache
        self.appConfig = AppConfig(
            apiBaseURL: URL(string: "http://localhost:0")!,
            supabaseURL: nil,
            supabaseAnonKey: "",
            elevenLabsAPIKey: "",
            elevenLabsVoiceID: "",
            stripePublishableKey: "pk_test_fixture",
            stripeMerchantID: "merchant.com.lumo.rentals.ios",
            apnsUseSandbox: true
        )
        Self.seed(cache: cache, fixture: fixture)
    }

    var body: some View {
        NavigationStack {
            switch fixture {
            case .proactiveCards:
                proactiveCardsHost
            case .settings, .permissionDenied:
                settingsHost
            }
        }
        .tint(LumoColors.cyan)
    }

    @ViewBuilder
    private var proactiveCardsHost: some View {
        VStack(spacing: 0) {
            ProactiveMomentsView(
                viewModel: ProactiveMomentsViewModel(
                    cache: cache,
                    // Fixture fetcher echoes the seeded cache state on
                    // every refresh so onAppear's reload doesn't wipe
                    // the cards.
                    fetcher: SeedReplayFetcher(cache: cache)
                ),
                onMomentAccepted: { _ in }
            )
            // Stand-in for the chat composer + message list — keeps the
            // capture focused on the cards above an empty chat.
            ZStack {
                LumoColors.background.ignoresSafeArea()
                VStack(spacing: LumoSpacing.md) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 48, weight: .light))
                        .foregroundStyle(LumoColors.labelTertiary)
                    Text("Ask Lumo anything")
                        .font(LumoFonts.title)
                        .foregroundStyle(LumoColors.label)
                    Text("Trips, food, errands, anything you'd ask a great assistant.")
                        .font(LumoFonts.body)
                        .foregroundStyle(LumoColors.labelSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, LumoSpacing.xl)
                }
            }
        }
        .navigationTitle("Lumo")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var settingsHost: some View {
        if fixture == .permissionDenied {
            // Pre-flip the master toggle off so the section captures
            // the denied/disabled visual state.
            let _: () = NotificationSettings.isPushEnabled = false
        }
        SettingsTab(
            paymentService: PaymentServiceStub(),
            receiptStore: ReceiptStoreStub(),
            appConfig: appConfig,
            onSignOut: {}
        )
    }

    private static func seed(
        cache: ProactiveMomentsCache,
        fixture: NotificationsFixture
    ) {
        guard fixture == .proactiveCards else { return }
        let now = Date()
        let cards: [ProactiveMoment] = [
            ProactiveMoment(
                id: "mom_fixture_weekend",
                category: NotificationCategory.proactiveSuggestion.rawValue,
                headline: "You have a 3-day weekend coming up",
                body: "Memorial Day weekend is May 23–25. Want me to surface ~$800 trip ideas?",
                primaryAction: ProactiveMomentAction(
                    label: "Plan it",
                    deeplink: nil,
                    chatPrefill: "Plan a 3-day weekend trip for me May 23–25, around $800 all-in."
                ),
                createdAt: now.addingTimeInterval(-3_600),
                expiresAt: now.addingTimeInterval(24 * 3_600)
            ),
            ProactiveMoment(
                id: "mom_fixture_flight",
                category: NotificationCategory.tripUpdate.rawValue,
                headline: "Flight UA 234 to LAS departs in 3 hours",
                body: "Gate B12, on time. Tap to see your full itinerary.",
                primaryAction: ProactiveMomentAction(
                    label: "View trip",
                    deeplink: "lumo://trips/upcoming",
                    chatPrefill: nil
                ),
                createdAt: now.addingTimeInterval(-1_800),
                expiresAt: now.addingTimeInterval(3 * 3_600)
            ),
        ]
        cache.update(with: ProactiveMomentsResponse(generatedAt: now, moments: cards))
    }
}

/// Fixture fetcher that echoes the cache's current `moments` so the
/// view's onAppear-refresh doesn't wipe seeded data. The cache is
/// @MainActor so we capture-and-read on the main actor.
private final class SeedReplayFetcher: ProactiveMomentsFetching {
    private let cache: ProactiveMomentsCache
    init(cache: ProactiveMomentsCache) { self.cache = cache }

    func fetchRecent() async throws -> ProactiveMomentsResponse {
        let moments = await MainActor.run { cache.moments }
        return ProactiveMomentsResponse(generatedAt: Date(), moments: moments)
    }
}
#endif
