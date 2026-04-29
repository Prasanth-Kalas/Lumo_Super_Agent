import SwiftUI

/// Account, security, about, and support content. Reads the signed-in
/// user from the host (passed via environment so the tab doesn't need
/// to own a reference to AuthService directly).

struct SettingsTab: View {
    let onSignOut: () -> Void
    @State private var biometricEnabled: Bool = AuthService.defaultBiometricGateGetter()
    @State private var biometricAvailable: Bool = BiometricUnlockService().isBiometryAvailable()
    @State private var showSignOutConfirm = false

    @Environment(\.openURL) private var openURL

    private let biometricKindLabel: String = BiometricUnlockService().biometryKind().label

    var body: some View {
        Form {
            accountSection
            securitySection
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
