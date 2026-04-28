import SwiftUI

/// Stub for Phase E expansion. Account info, sign-out, version,
/// privacy/support links land in the same sprint as the auth flow
/// since they read from the auth state.

struct SettingsTab: View {
    private var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }

    var body: some View {
        Form {
            Section("About") {
                HStack {
                    Text("Version")
                    Spacer()
                    Text(appVersion).foregroundStyle(LumoColors.labelSecondary)
                }
            }
            Section {
                Text("Account, sign-out, and support links arrive in the next sprint with the auth flow.")
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
    }
}
