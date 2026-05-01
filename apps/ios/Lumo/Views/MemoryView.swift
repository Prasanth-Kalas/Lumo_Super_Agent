import SwiftUI

/// Memory destination — what Lumo knows about the user, fetched from
/// `GET /api/memory` (we only consume the `profile` field for iOS-v1
/// per IOS-COMPOSER-AND-DRAWER-SCREENS-1 Phase B1).
///
/// The brief asks for five categories (Preferences, Addresses,
/// Dietary, Traveler Profiles, Frequent Flyer). We map the structured
/// profile fields onto those buckets — recon flagged that web's
/// schema is richer (profile + facts + patterns); the facts +
/// patterns sections are filed deferred as IOS-MEMORY-FACTS-1.
///
/// Tap a category row → inline edit form. Save calls
/// `PATCH /api/memory/profile` (NOT `PUT /api/memory` as the brief
/// stated; recon found web only exposes PATCH on the profile path).

struct MemoryView: View {
    @StateObject private var viewModel: MemoryScreenViewModel
    @State private var editingCategory: MemoryCategory? = nil

    init(viewModel: MemoryScreenViewModel) {
        self._viewModel = StateObject(wrappedValue: viewModel)
    }

    var body: some View {
        Group {
            switch viewModel.state {
            case .idle, .loading:
                loadingSkeleton
            case .loaded(let profile):
                profileList(profile)
            case .error(let message):
                errorState(message)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
        .navigationTitle("Memory")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
        .sheet(item: $editingCategory) { category in
            NavigationStack {
                MemoryEditForm(
                    category: category,
                    viewModel: viewModel,
                    onDismiss: { editingCategory = nil }
                )
            }
        }
    }

    // MARK: - States

    private var loadingSkeleton: some View {
        VStack(spacing: LumoSpacing.sm) {
            ForEach(0..<5, id: \.self) { _ in
                RoundedRectangle(cornerRadius: LumoRadius.md)
                    .fill(LumoColors.surfaceElevated)
                    .frame(height: 64)
            }
        }
        .padding(LumoSpacing.md)
        .accessibilityIdentifier("memory.loading")
    }

    private func profileList(_ profile: MemoryProfileDTO) -> some View {
        ScrollView {
            VStack(spacing: LumoSpacing.sm) {
                ForEach(MemoryCategory.allCases) { category in
                    Button {
                        editingCategory = category
                    } label: {
                        MemoryCategoryRow(
                            category: category,
                            summary: category.summary(from: profile)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("memory.row.\(category.rawValue)")
                }
            }
            .padding(LumoSpacing.md)
        }
        .accessibilityIdentifier("memory.list")
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
        .accessibilityIdentifier("memory.error")
    }
}

// MARK: - Categories

enum MemoryCategory: String, CaseIterable, Identifiable {
    case preferences = "preferences"
    case addresses = "addresses"
    case dietary = "dietary"
    case travelerProfile = "traveler-profile"
    case frequentFlyer = "frequent-flyer"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .preferences: return "Preferences"
        case .addresses: return "Addresses"
        case .dietary: return "Dietary"
        case .travelerProfile: return "Traveler profile"
        case .frequentFlyer: return "Frequent flyer"
        }
    }

    var icon: String {
        switch self {
        case .preferences: return "slider.horizontal.3"
        case .addresses: return "house.fill"
        case .dietary: return "leaf.fill"
        case .travelerProfile: return "person.crop.circle.fill"
        case .frequentFlyer: return "airplane"
        }
    }

    func summary(from profile: MemoryProfileDTO) -> String {
        switch self {
        case .preferences:
            let parts = [
                profile.preferred_airline_class,
                profile.preferred_airline_seat,
                profile.budget_tier,
            ].compactMap { $0 }.filter { !$0.isEmpty }
            return parts.isEmpty ? "Not set" : parts.joined(separator: " · ")
        case .addresses:
            let home = profile.home_address?.summary ?? ""
            return home.isEmpty ? "Not set" : home
        case .dietary:
            let combined = (profile.dietary_flags + profile.allergies).filter { !$0.isEmpty }
            return combined.isEmpty ? "Not set" : combined.joined(separator: ", ")
        case .travelerProfile:
            let parts = [profile.display_name, profile.preferred_language, profile.timezone]
                .compactMap { $0 }.filter { !$0.isEmpty }
            return parts.isEmpty ? "Not set" : parts.joined(separator: " · ")
        case .frequentFlyer:
            return profile.preferred_hotel_chains.isEmpty ? "Not set" : profile.preferred_hotel_chains.joined(separator: ", ")
        }
    }
}

private struct MemoryCategoryRow: View {
    let category: MemoryCategory
    let summary: String

    var body: some View {
        HStack(alignment: .center, spacing: LumoSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: LumoRadius.sm)
                    .fill(LumoColors.cyan.opacity(0.15))
                    .frame(width: 36, height: 36)
                Image(systemName: category.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(LumoColors.cyan)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(category.label)
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                Text(summary)
                    .font(LumoFonts.caption)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(LumoColors.labelTertiary)
        }
        .padding(LumoSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md).fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
        .contentShape(Rectangle())
    }
}

// MARK: - Edit form

struct MemoryEditForm: View {
    let category: MemoryCategory
    @ObservedObject var viewModel: MemoryScreenViewModel
    var onDismiss: () -> Void

    @State private var fieldA: String = ""
    @State private var fieldB: String = ""
    @State private var fieldC: String = ""

    var body: some View {
        Form {
            Section(category.label) {
                fields
            }
            if let err = viewModel.saveError {
                Section {
                    Text(err)
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.warning)
                }
            }
        }
        .navigationTitle("Edit \(category.label.lowercased())")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { onDismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task {
                        await viewModel.save(currentPatch())
                        if viewModel.saveError == nil { onDismiss() }
                    }
                }
                .disabled(viewModel.isSaving)
                .accessibilityIdentifier("memory.edit.save")
            }
        }
        .onAppear {
            seedFields()
        }
    }

    @ViewBuilder
    private var fields: some View {
        switch category {
        case .preferences:
            TextField("Airline class (economy / business / first)", text: $fieldA)
            TextField("Seat (aisle / window / any)", text: $fieldB)
            TextField("Budget (budget / standard / premium)", text: $fieldC)
        case .addresses:
            TextField("Home address (line 1, city, region)", text: $fieldA, axis: .vertical)
                .lineLimit(2...3)
        case .dietary:
            TextField("Dietary flags (vegetarian, gluten_free, …)", text: $fieldA)
            TextField("Allergies (shellfish, peanuts, …)", text: $fieldB)
        case .travelerProfile:
            TextField("Display name", text: $fieldA)
        case .frequentFlyer:
            Text("Frequent flyer numbers ship in IOS-MEMORY-FACTS-1.")
                .font(LumoFonts.caption)
                .foregroundStyle(LumoColors.labelSecondary)
        }
    }

    private func seedFields() {
        guard case .loaded(let profile) = viewModel.state else { return }
        switch category {
        case .preferences:
            fieldA = profile.preferred_airline_class ?? ""
            fieldB = profile.preferred_airline_seat ?? ""
            fieldC = profile.budget_tier ?? ""
        case .addresses:
            fieldA = profile.home_address?.line1 ?? ""
        case .dietary:
            fieldA = profile.dietary_flags.joined(separator: ", ")
            fieldB = profile.allergies.joined(separator: ", ")
        case .travelerProfile:
            fieldA = profile.display_name ?? ""
        case .frequentFlyer:
            break
        }
    }

    private func currentPatch() -> MemoryProfilePatchDTO {
        switch category {
        case .preferences:
            return MemoryProfilePatchDTO(
                preferred_airline_class: .some(fieldA.isEmpty ? nil : fieldA),
                preferred_airline_seat: .some(fieldB.isEmpty ? nil : fieldB),
                budget_tier: .some(fieldC.isEmpty ? nil : fieldC)
            )
        case .addresses:
            return MemoryProfilePatchDTO()  // address PATCH ships in IOS-MEMORY-FACTS-1
        case .dietary:
            return MemoryProfilePatchDTO(
                dietary_flags: tags(from: fieldA),
                allergies: tags(from: fieldB)
            )
        case .travelerProfile:
            return MemoryProfilePatchDTO(
                display_name: .some(fieldA.isEmpty ? nil : fieldA)
            )
        case .frequentFlyer:
            return MemoryProfilePatchDTO()
        }
    }

    private func tags(from raw: String) -> [String] {
        raw.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
    }
}
