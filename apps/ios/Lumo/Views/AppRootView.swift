import SwiftUI

/// Picks the right tree based on auth state. Wraps the original
/// `RootView` (the three-tab shell) so all signed-in surfaces live
/// behind the same gate.

struct AppRootView: View {
    @StateObject private var authViewModel: AuthViewModel
    @StateObject private var onboardingViewModel: OnboardingViewModel
    private let authService: AuthServicing
    private let chatService: ChatService
    private let tts: TextToSpeechServicing
    private let paymentService: PaymentServicing
    private let receiptStore: ReceiptStoring
    private let appConfig: AppConfig
    private let proactiveCache: ProactiveMomentsCache
    private let proactiveClient: ProactiveMomentsFetching
    private let drawerScreensFetcher: DrawerScreensFetching
    private let deepgramTokenService: DeepgramTokenServicing
    /// Tracks the user_id we last triggered an onboarding check for,
    /// so a sign-out → sign-in cycle re-checks (the new user might
    /// have a different onboarded flag).
    @State private var checkedOnboardingForUserID: String? = nil

    init(
        authService: AuthServicing,
        chatService: ChatService,
        tts: TextToSpeechServicing,
        paymentService: PaymentServicing,
        receiptStore: ReceiptStoring,
        appConfig: AppConfig,
        proactiveCache: ProactiveMomentsCache,
        proactiveClient: ProactiveMomentsFetching,
        drawerScreensFetcher: DrawerScreensFetching,
        deepgramTokenService: DeepgramTokenServicing
    ) {
        self.authService = authService
        self.chatService = chatService
        self.tts = tts
        self.paymentService = paymentService
        self.receiptStore = receiptStore
        self.appConfig = appConfig
        self.proactiveCache = proactiveCache
        self.proactiveClient = proactiveClient
        self.drawerScreensFetcher = drawerScreensFetcher
        self.deepgramTokenService = deepgramTokenService
        _authViewModel = StateObject(wrappedValue: AuthViewModel(auth: authService))
        _onboardingViewModel = StateObject(
            wrappedValue: OnboardingViewModel(fetcher: drawerScreensFetcher)
        )
    }

    var body: some View {
        Group {
            switch authViewModel.state {
            case .signedIn(let user):
                signedInGate(user: user)
                    .environment(\.signedInUser, user)
                    .transition(.opacity)
                    .task(id: user.id) {
                        // Trigger the onboarding check the first time
                        // we see this user_id; reset on user switch.
                        if checkedOnboardingForUserID != user.id {
                            checkedOnboardingForUserID = user.id
                            await onboardingViewModel.check()
                        }
                    }
            case .needsBiometric(let user):
                BiometricUnlockView(
                    user: user,
                    kindLabel: biometricKindLabel(),
                    onUnlock: handleUnlock,
                    onSwitchAccount: handleSignOut
                )
                .transition(.opacity)
            case .signedOut, .signingIn:
                AuthView(viewModel: authViewModel)
                    .transition(.opacity)
            }
        }
        .animation(LumoAnimation.standard, value: authViewModel.state)
        .task { await bootstrap() }
    }

    @ViewBuilder
    private func signedInGate(user: LumoUser) -> some View {
        switch onboardingViewModel.state {
        case .checking:
            // Match RootView's chrome so there's no flash of content
            // before the gate decides. A simple background + spinner
            // is enough — the check is a single GET that finishes
            // in <100ms on a warm cache.
            ZStack {
                LumoColors.background.ignoresSafeArea()
                ProgressView()
                    .controlSize(.regular)
            }
            .accessibilityIdentifier("appRoot.onboardingCheck")
        case .needsOnboarding:
            OnboardingView(viewModel: onboardingViewModel)
        case .complete:
            RootView(
                chatService: chatService,
                tts: tts,
                paymentService: paymentService,
                receiptStore: receiptStore,
                appConfig: appConfig,
                proactiveCache: proactiveCache,
                proactiveClient: proactiveClient,
                drawerScreensFetcher: drawerScreensFetcher,
                deepgramTokenService: deepgramTokenService,
                onSignOut: handleSignOut
            )
        }
    }

    private func bootstrap() async {
        #if DEBUG
        // Debug-only deterministic entry path used by automated screenshot
        // capture and CI snapshot runs. Activated by launching the app
        // with `-LumoAutoSignIn YES` (or setting the user-default of
        // the same name); compiled out in Release.
        if UserDefaults.standard.bool(forKey: "LumoAutoSignIn") {
            await authService.devSignIn()
            return
        }
        #endif
        await authService.restoreSession()
    }

    private func handleUnlock() {
        Task {
            try? await authService.unlockWithBiometric()
        }
    }

    private func handleSignOut() {
        Task { await authService.signOut() }
    }

    private func biometricKindLabel() -> String {
        // Best-effort label for the unlock screen. The real LAContext
        // will surface the right system prompt regardless.
        BiometricUnlockService().biometryKind().label
    }
}
