import SwiftUI

/// Account, security, about, and support content. Reads the signed-in
/// user from the host (passed via environment so the tab doesn't need
/// to own a reference to AuthService directly).

struct SettingsTab: View {
    let paymentService: PaymentServicing
    let receiptStore: ReceiptStoring
    let appConfig: AppConfig
    let onSignOut: () -> Void
    @State private var biometricEnabled: Bool = AuthService.defaultBiometricGateGetter()
    @State private var biometricAvailable: Bool = BiometricUnlockService().isBiometryAvailable()
    @State private var speakResponses: Bool = VoiceSettings.speakResponses
    @State private var hasUsedVoice: Bool = VoiceSettings.hasUsedVoice
    @State private var showSignOutConfirm = false
    @State private var showTestPaymentSheet = false

    @Environment(\.openURL) private var openURL

    private let biometricKindLabel: String = BiometricUnlockService().biometryKind().label

    var body: some View {
        Form {
            accountSection
            securitySection
            paymentsSection
            voiceSection
            aboutSection
            supportSection
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
        .confirmationDialog(
            "Sign out of Lumo?",
            isPresented: $showSignOutConfirm,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive, action: onSignOut)
            Button("Cancel", role: .cancel, action: {})
        } message: {
            Text("You'll need to sign in again to use the app.")
        }
        #if DEBUG
        .sheet(isPresented: $showTestPaymentSheet) {
            TestPaymentSheet(
                paymentService: paymentService,
                receiptStore: receiptStore,
                onDismiss: { showTestPaymentSheet = false }
            )
        }
        #endif
    }

    // MARK: - Account

    @ViewBuilder
    private var accountSection: some View {
        Section("Account") {
            if let user = currentUser {
                if let email = user.email {
                    LabeledContent("Email", value: email)
                }
                if let name = user.displayName {
                    LabeledContent("Name", value: name)
                }
                LabeledContent("User ID", value: String(user.id.prefix(8)) + "…")
                    .font(.system(.body, design: .monospaced))
            }
            Button(role: .destructive) {
                showSignOutConfirm = true
            } label: {
                Text("Sign out")
            }
            .accessibilityIdentifier("settings.signOut")
        }
    }

    // MARK: - Security

    @ViewBuilder
    private var securitySection: some View {
        if biometricAvailable {
            Section("Security") {
                Toggle(isOn: Binding(
                    get: { biometricEnabled },
                    set: { newValue in
                        biometricEnabled = newValue
                        AuthService.setBiometricGateEnabled(newValue)
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Require \(biometricKindLabel)")
                        Text("Ask for \(biometricKindLabel) on cold launch.")
                            .font(LumoFonts.footnote)
                            .foregroundStyle(LumoColors.labelSecondary)
                    }
                }
                .accessibilityIdentifier("settings.biometric")
            }
        }
    }

    // MARK: - Payments

    @ViewBuilder
    private var paymentsSection: some View {
        Section("Payments") {
            NavigationLink {
                PaymentMethodsView(
                    viewModel: PaymentMethodsViewModel(
                        service: paymentService,
                        isConfigured: appConfig.isStripeConfigured
                    ),
                    isStripeLiveMode: appConfig.isStripeLiveMode
                )
            } label: {
                HStack {
                    Image(systemName: "creditcard")
                        .foregroundStyle(LumoColors.cyanDeep)
                        .frame(width: 26)
                    Text("Payment methods")
                }
            }
            .accessibilityIdentifier("settings.paymentMethods")

            NavigationLink {
                ReceiptHistoryView(store: receiptStore)
            } label: {
                HStack {
                    Image(systemName: "doc.text")
                        .foregroundStyle(LumoColors.cyanDeep)
                        .frame(width: 26)
                    Text("Receipts")
                }
            }
            .accessibilityIdentifier("settings.receipts")

            #if DEBUG
            // DEBUG-only entry point so screenshot capture can drive the
            // PaymentConfirmationCard without a real chat-side trigger
            // (compound trip flow ships in MOBILE-TRIP-1). Compiled out
            // of Release.
            Button {
                showTestPaymentSheet = true
            } label: {
                HStack {
                    Image(systemName: "wand.and.stars")
                        .foregroundStyle(LumoColors.warning)
                        .frame(width: 26)
                    Text("Try a test payment (DEBUG)")
                }
            }
            .accessibilityIdentifier("settings.testPayment")
            #endif
        }
    }

    // MARK: - Voice

    @ViewBuilder
    private var voiceSection: some View {
        // Section is hidden until the user has used voice at least
        // once — keeps the Settings surface uncluttered for the
        // text-only path. Once they've spoken, the section appears.
        if hasUsedVoice {
            Section("Voice") {
                Toggle(isOn: Binding(
                    get: { speakResponses },
                    set: { newValue in
                        speakResponses = newValue
                        VoiceSettings.speakResponses = newValue
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Speak responses aloud")
                        Text("Use Lumo's voice to read assistant replies.")
                            .font(LumoFonts.footnote)
                            .foregroundStyle(LumoColors.labelSecondary)
                    }
                }
                .accessibilityIdentifier("settings.speakResponses")

                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        openURL(url)
                    }
                } label: {
                    HStack {
                        Text("Reset voice permissions")
                        Spacer()
                        Image(systemName: "gearshape")
                            .foregroundStyle(LumoColors.labelTertiary)
                    }
                }
                .foregroundStyle(LumoColors.label)
                .accessibilityIdentifier("settings.resetVoicePerms")
            }
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("Version", value: appVersion)
            LabeledContent("Build", value: appBuild)
        }
    }

    // MARK: - Support

    private var supportSection: some View {
        Section("Support") {
            Button {
                openURL(URL(string: "https://lumo.rentals/privacy")!)
            } label: {
                HStack {
                    Text("Privacy policy")
                    Spacer()
                    Image(systemName: "arrow.up.right.square")
                        .foregroundStyle(LumoColors.labelTertiary)
                }
            }
            .foregroundStyle(LumoColors.label)

            Button {
                openURL(URL(string: "https://lumo.rentals/terms")!)
            } label: {
                HStack {
                    Text("Terms of service")
                    Spacer()
                    Image(systemName: "arrow.up.right.square")
                        .foregroundStyle(LumoColors.labelTertiary)
                }
            }
            .foregroundStyle(LumoColors.label)

            Button {
                if let url = URL(string: "mailto:support@lumo.rentals") {
                    openURL(url)
                }
            } label: {
                HStack {
                    Text("Contact support")
                    Spacer()
                    Image(systemName: "envelope")
                        .foregroundStyle(LumoColors.labelTertiary)
                }
            }
            .foregroundStyle(LumoColors.label)
        }
    }

    // MARK: - Helpers

    private var currentUser: LumoUser? {
        // Read out of an environment-injected AuthService when one is
        // wired by the host. AppRootView injects the live state via
        // the `signedInUser` preference key (below).
        signedInUser
    }

    @Environment(\.signedInUser) private var signedInUser

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    }

    private var appBuild: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    }
}

#if DEBUG
// MARK: - TestPaymentSheet (DEBUG only)

/// Picks the user's default payment method (or first available), then
/// presents a `PaymentConfirmationCard` against a synthetic transaction
/// so screenshot capture + manual smoke testing can drive the
/// confirmation flow without a real chat-side trigger.
private struct TestPaymentSheet: View {
    let paymentService: PaymentServicing
    let receiptStore: ReceiptStoring
    let onDismiss: () -> Void

    @State private var selectedMethod: PaymentMethod?
    @State private var loadError: String?

    var body: some View {
        ZStack {
            LumoColors.background.ignoresSafeArea()
            if let method = selectedMethod {
                let viewModel = PaymentConfirmationViewModel(
                    transaction: Self.demoTransaction,
                    paymentMethod: method,
                    biometric: BiometricConfirmationService(),
                    service: paymentService,
                    store: receiptStore
                )
                PaymentConfirmationCard(
                    viewModel: viewModel,
                    onComplete: { _ in onDismiss() },
                    onCancel: onDismiss
                )
            } else if let error = loadError {
                VStack(spacing: LumoSpacing.md) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 32))
                        .foregroundStyle(LumoColors.warning)
                    Text("Couldn't pick a payment method")
                        .font(LumoFonts.bodyEmphasized)
                    Text(error)
                        .font(LumoFonts.footnote)
                        .foregroundStyle(LumoColors.labelSecondary)
                        .multilineTextAlignment(.center)
                    Button("Dismiss", action: onDismiss)
                        .buttonStyle(.lumoPrimary)
                }
                .padding(LumoSpacing.lg)
            } else {
                ProgressView()
            }
        }
        .task { await pickDefaultMethod() }
    }

    private func pickDefaultMethod() async {
        do {
            let methods = try await paymentService.listPaymentMethods()
            if methods.isEmpty {
                loadError = "Add a payment method first."
                return
            }
            selectedMethod = methods.first { $0.isDefault } ?? methods.first
        } catch {
            loadError = error.localizedDescription
        }
    }

    private static var demoTransaction: PendingTransaction {
        PendingTransaction(
            title: "Acme Hotel — 2 nights",
            lineItems: [
                LineItem(label: "Room rate", amountCents: 39800),
                LineItem(label: "Taxes & fees", amountCents: 6420),
            ],
            currency: "usd"
        )
    }
}
#endif

// MARK: - SignedInUser environment key

private struct SignedInUserKey: EnvironmentKey {
    static let defaultValue: LumoUser? = nil
}

extension EnvironmentValues {
    var signedInUser: LumoUser? {
        get { self[SignedInUserKey.self] }
        set { self[SignedInUserKey.self] = newValue }
    }
}
