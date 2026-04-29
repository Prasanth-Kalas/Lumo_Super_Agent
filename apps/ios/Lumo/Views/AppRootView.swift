import SwiftUI

/// Picks the right tree based on auth state. Wraps the original
/// `RootView` (the three-tab shell) so all signed-in surfaces live
/// behind the same gate.

struct AppRootView: View {
    @StateObject private var authViewModel: AuthViewModel
    private let authService: AuthServicing
    private let chatService: ChatService
    private let tts: TextToSpeechServicing
    private let paymentService: PaymentServicing
    private let receiptStore: ReceiptStoring
    private let appConfig: AppConfig

    init(
        authService: AuthServicing,
        chatService: ChatService,
        tts: TextToSpeechServicing,
        paymentService: PaymentServicing,
        receiptStore: ReceiptStoring,
        appConfig: AppConfig
    ) {
        self.authService = authService
        self.chatService = chatService
        self.tts = tts
        self.paymentService = paymentService
        self.receiptStore = receiptStore
        self.appConfig = appConfig
        _authViewModel = StateObject(wrappedValue: AuthViewModel(auth: authService))
    }

    var body: some View {
        Group {
            switch authViewModel.state {
            case .signedIn(let user):
                RootView(
                    chatService: chatService,
                    tts: tts,
                    paymentService: paymentService,
                    receiptStore: receiptStore,
                    appConfig: appConfig,
                    onSignOut: handleSignOut
                )
                    .environment(\.signedInUser, user)
                    .transition(.opacity)
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
