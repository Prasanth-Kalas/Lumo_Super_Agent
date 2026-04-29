import SwiftUI

/// Cold-launch unlock gate. Shown when a session was restored from
/// Keychain but the biometric gate (defaulted on, opt-out in Settings)
/// hasn't been satisfied yet for this session. The user taps once;
/// LAContext handles the actual Face-ID / Touch-ID prompt.

struct BiometricUnlockView: View {
    let user: LumoUser
    let kindLabel: String
    let onUnlock: () -> Void
    let onSwitchAccount: () -> Void

    var body: some View {
        VStack(spacing: LumoSpacing.xl) {
            Spacer()
            VStack(spacing: LumoSpacing.lg) {
                Image(systemName: kindLabel == "Face ID" ? "faceid" : "touchid")
                    .font(.system(size: 72))
                    .foregroundStyle(LumoColors.cyan)
                Text("Welcome back, \(user.nameOrEmailPrefix)")
                    .font(LumoFonts.title)
                    .foregroundStyle(LumoColors.label)
                Text("Unlock with \(kindLabel) to continue.")
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .multilineTextAlignment(.center)
            }

            Button(action: onUnlock) {
                Text("Unlock with \(kindLabel)")
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(LumoColors.cyan)
                    .clipShape(RoundedRectangle(cornerRadius: LumoRadius.md))
            }
            .accessibilityIdentifier("biometric.unlock")

            Spacer()

            Button("Switch account", action: onSwitchAccount)
                .font(LumoFonts.callout)
                .foregroundStyle(LumoColors.labelSecondary)
        }
        .padding(.horizontal, LumoSpacing.xl)
        .padding(.bottom, LumoSpacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
    }
}
