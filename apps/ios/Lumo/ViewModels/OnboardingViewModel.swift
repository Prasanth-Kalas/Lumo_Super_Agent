import Foundation
import SwiftUI

/// IOS-ONBOARDING-1 — drives the first-launch onboarding gate.
///
/// The signed-in branch in AppRootView calls `check()` on appear.
/// The result is one of three states:
///   - `.checking`: the membership check is in flight; show a
///     spinner so the chat shell doesn't flash before we know.
///   - `.needsOnboarding`: no `extra.onboarded_at` is set on the
///     server; render OnboardingView.
///   - `.complete`: the user has been onboarded (either earlier
///     or just now via `finish(via:)`); render the chat shell.
///
/// Source of truth is server-side via `GET /api/memory` — same
/// flag web reads, so cross-device behavior is consistent.
@MainActor
final class OnboardingViewModel: ObservableObject {
    enum State: Equatable {
        case checking
        case needsOnboarding
        case complete
    }

    @Published private(set) var state: State = .checking
    @Published var isFinishing: Bool = false

    private let fetcher: DrawerScreensFetching

    init(fetcher: DrawerScreensFetching) {
        self.fetcher = fetcher
    }

    /// Reads `/api/memory` and decides whether the user has already
    /// been onboarded. Network failures bias to `.complete` rather
    /// than `.needsOnboarding` — a transient hiccup shouldn't
    /// re-trigger the welcome flow on every launch. Re-checking
    /// after a user switch is supported by setting state back to
    /// `.checking` on entry, so AppRootView's `task(id: user.id)`
    /// can drive a fresh decision.
    func check() async {
        state = .checking
        do {
            let resp = try await fetcher.fetchMemory()
            state = (resp.profile?.isOnboarded == true) ? .complete : .needsOnboarding
        } catch {
            state = .complete
        }
    }

    /// PATCHes `extra.onboarded_at` and transitions to `.complete`.
    /// On failure we still transition (matches web's "best-effort
    /// PATCH" posture in apps/web/app/onboarding/page.tsx) so a
    /// dropped write doesn't trap the user on the welcome screen.
    func finish(via origin: String) async {
        if isFinishing { return }
        isFinishing = true
        defer { isFinishing = false }
        try? await fetcher.markUserOnboarded(via: origin)
        state = .complete
    }

    /// Test seam.
    func _seedForTest(state: State) {
        self.state = state
    }
}
