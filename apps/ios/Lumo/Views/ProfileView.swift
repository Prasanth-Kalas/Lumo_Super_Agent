import SwiftUI

/// /profile equivalent — display name + travel preferences. v1 stores
/// the values locally via `ProfileSettings`; future sprint syncs to
/// `/api/memory/profile`. Address + frequent-flyer-number editors
/// land in `MOBILE-PROFILE-RICH-FIELDS-1` (parity with the web
/// audit's deferred work).

struct ProfileView: View {
    @State private var displayName: String = ProfileSettings.displayName ?? ""
    @State private var cabinClass: ProfileSettings.CabinClass = ProfileSettings.cabinClass
    @State private var seatPreference: ProfileSettings.SeatPreference = ProfileSettings.seatPreference

    var body: some View {
        Form {
            Section {
                TextField("How should Lumo refer to you?", text: $displayName)
                    .textInputAutocapitalization(.words)
                    .onChange(of: displayName) { _, new in
                        ProfileSettings.displayName = new
                    }
                    .accessibilityIdentifier("profile.displayName")
            } header: {
                Text("Display name")
            } footer: {
                Text("Used in greetings and chat openers.")
            }

            Section {
                Picker("Cabin class", selection: $cabinClass) {
                    ForEach(ProfileSettings.CabinClass.allCases) { value in
                        Text(value.label).tag(value)
                    }
                }
                .onChange(of: cabinClass) { _, new in
                    ProfileSettings.cabinClass = new
                }
                .accessibilityIdentifier("profile.cabinClass")

                Picker("Seat preference", selection: $seatPreference) {
                    ForEach(ProfileSettings.SeatPreference.allCases) { value in
                        Text(value.label).tag(value)
                    }
                }
                .onChange(of: seatPreference) { _, new in
                    ProfileSettings.seatPreference = new
                }
                .accessibilityIdentifier("profile.seatPreference")
            } header: {
                Text("Travel")
            } footer: {
                Text("Lumo will favor these when planning trips. Say \"book me business class\" in chat to override for one trip.")
            }
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.large)
    }
}
