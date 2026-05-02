import SwiftUI

/// Memory destination — what Lumo knows about the user, fetched from
/// `GET /api/memory`.
///
/// Three sections, mirroring web's `/memory` page:
///   1. Profile categories (Preferences, Addresses, Dietary, Traveler,
///      Frequent flyer) — taps open an inline edit form. Save calls
///      `PATCH /api/memory/profile`.
///   2. Facts — free-text memories grouped by category. Each row has
///      a "Forget" action that calls `DELETE /api/memory/facts/{id}`.
///      Soft-delete; recoverable for 30 days server-side.
///   3. Patterns — read-only inferences from the nightly pattern
///      detector. Only shown when the patterns array is non-empty.

struct MemoryView: View {
    @StateObject private var viewModel: MemoryScreenViewModel
    @State private var editingCategory: MemoryCategory? = nil
    /// DEBUG capture seam (IOS-DRAWER-EDIT-DETAIL-CAPTURES-1) — when
    /// non-nil on first appear, auto-presents the edit sheet for that
    /// category so the screenshot lands the form. Cleared after one
    /// use so subsequent navigations behave normally.
    @Binding private var autoOpenCategory: MemoryCategory?

    init(
        viewModel: MemoryScreenViewModel,
        autoOpenCategory: Binding<MemoryCategory?> = .constant(nil)
    ) {
        self._viewModel = StateObject(wrappedValue: viewModel)
        self._autoOpenCategory = autoOpenCategory
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
        .onAppear {
            if let cat = autoOpenCategory {
                editingCategory = cat
                autoOpenCategory = nil
            }
        }
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
            VStack(alignment: .leading, spacing: LumoSpacing.lg) {
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

                factsSection
                patternsSection

                if !viewModel.facts.isEmpty || !viewModel.patterns.isEmpty {
                    Text("Soft-deleted facts are recoverable for 30 days. To permanently erase everything Lumo knows about you, email support.")
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.labelTertiary)
                        .padding(.top, LumoSpacing.xs)
                        .accessibilityIdentifier("memory.softDeleteFooter")
                }
            }
            .padding(LumoSpacing.md)
        }
        .accessibilityIdentifier("memory.list")
    }

    @ViewBuilder
    private var factsSection: some View {
        if !viewModel.facts.isEmpty {
            VStack(alignment: .leading, spacing: LumoSpacing.sm) {
                HStack(alignment: .firstTextBaseline) {
                    Text("What Lumo remembers")
                        .font(LumoFonts.headline)
                        .foregroundStyle(LumoColors.label)
                    Spacer()
                    Text("\(viewModel.facts.count) fact\(viewModel.facts.count == 1 ? "" : "s")")
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.labelTertiary)
                }
                if let err = viewModel.factError {
                    Text(err)
                        .font(LumoFonts.caption)
                        .foregroundStyle(LumoColors.warning)
                        .accessibilityIdentifier("memory.facts.error")
                }
                ForEach(MemoryUI.groupedAndSorted(viewModel.facts), id: \.0) { entry in
                    let (categoryKey, factsInCategory) = entry
                    VStack(alignment: .leading, spacing: LumoSpacing.xxs) {
                        Text(MemoryUI.categoryLabel(for: categoryKey).uppercased())
                            .font(LumoFonts.caption)
                            .tracking(1.2)
                            .foregroundStyle(LumoColors.labelTertiary)
                        VStack(spacing: 0) {
                            ForEach(factsInCategory) { fact in
                                MemoryFactRow(
                                    fact: fact,
                                    isForgetting: viewModel.forgettingFactID == fact.id,
                                    onForget: { Task { await viewModel.forgetFact(id: fact.id) } }
                                )
                                if fact.id != factsInCategory.last?.id {
                                    Divider().background(LumoColors.separator)
                                }
                            }
                        }
                        .background(
                            RoundedRectangle(cornerRadius: LumoRadius.md).fill(LumoColors.surface)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: LumoRadius.md)
                                .stroke(LumoColors.separator, lineWidth: 1)
                        )
                    }
                }
            }
            .accessibilityIdentifier("memory.facts.section")
        }
    }

    @ViewBuilder
    private var patternsSection: some View {
        if !viewModel.patterns.isEmpty {
            VStack(alignment: .leading, spacing: LumoSpacing.sm) {
                Text("Observed patterns")
                    .font(LumoFonts.headline)
                    .foregroundStyle(LumoColors.label)
                VStack(spacing: LumoSpacing.sm) {
                    ForEach(viewModel.patterns) { pattern in
                        MemoryPatternRow(pattern: pattern)
                    }
                }
            }
            .accessibilityIdentifier("memory.patterns.section")
        }
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

// MARK: - Facts + Patterns rows

private struct MemoryFactRow: View {
    let fact: MemoryFactDTO
    let isForgetting: Bool
    let onForget: () -> Void
    @State private var showConfirm = false

    var body: some View {
        HStack(alignment: .top, spacing: LumoSpacing.md) {
            VStack(alignment: .leading, spacing: LumoSpacing.xxs) {
                Text(fact.fact)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.label)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: LumoSpacing.xxs) {
                    MemoryPill(label: MemoryUI.sourceLabel(fact.source))
                    MemoryPill(
                        label: MemoryUI.confidenceLabel(fact.confidence),
                        tone: MemoryUI.confidenceTone(fact.confidence)
                    )
                    MemoryPill(label: "confirmed \(MemoryUI.formatRelative(fact.last_confirmed_at))")
                }
            }
            Spacer(minLength: LumoSpacing.sm)
            Button(role: .destructive) {
                showConfirm = true
            } label: {
                Text(isForgetting ? "Forgetting" : "Forget")
                    .font(LumoFonts.caption.weight(.medium))
                    .padding(.horizontal, LumoSpacing.sm)
                    .padding(.vertical, LumoSpacing.xxs)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(isForgetting)
            .accessibilityLabel("Forget memory: \(fact.fact)")
            .accessibilityIdentifier("memory.fact.forget.\(fact.id)")
        }
        .padding(LumoSpacing.md)
        .alert("Forget this memory?", isPresented: $showConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Forget", role: .destructive) { onForget() }
        } message: {
            Text("Lumo will stop using \"\(fact.fact)\" in chat.")
        }
    }
}

private struct MemoryPatternRow: View {
    let pattern: MemoryPatternDTO

    var body: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.xxs) {
            HStack(alignment: .top) {
                Text(pattern.description)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.label)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: LumoSpacing.sm)
                MemoryPill(
                    label: MemoryUI.confidenceLabel(pattern.confidence),
                    tone: MemoryUI.confidenceTone(pattern.confidence)
                )
            }
            HStack(spacing: LumoSpacing.xxs) {
                MemoryPill(label: pattern.pattern_kind.replacingOccurrences(of: "_", with: " "))
                MemoryPill(label: "seen \(pattern.evidence_count)x")
                MemoryPill(label: "observed \(MemoryUI.formatRelative(pattern.last_observed_at))")
            }
        }
        .padding(LumoSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md).fill(LumoColors.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .stroke(LumoColors.separator, lineWidth: 1)
        )
    }
}

private struct MemoryPill: View {
    let label: String
    var tone: MemoryUI.ConfidenceTone? = nil

    var body: some View {
        Text(label)
            .font(LumoFonts.caption)
            .foregroundStyle(foreground)
            .padding(.horizontal, LumoSpacing.xs + 2)
            .padding(.vertical, LumoSpacing.xxs)
            .background(Capsule().fill(background))
            .overlay(Capsule().stroke(border, lineWidth: 1))
    }

    private var foreground: Color {
        switch tone {
        case .high: return LumoColors.cyan
        case .medium: return LumoColors.warning
        case .low: return LumoColors.error
        case nil: return LumoColors.labelSecondary
        }
    }

    private var background: Color {
        switch tone {
        case .high: return LumoColors.cyan.opacity(0.10)
        case .medium: return LumoColors.warning.opacity(0.10)
        case .low: return LumoColors.error.opacity(0.10)
        case nil: return LumoColors.background
        }
    }

    private var border: Color {
        switch tone {
        case .high: return LumoColors.cyan.opacity(0.30)
        case .medium: return LumoColors.warning.opacity(0.30)
        case .low: return LumoColors.error.opacity(0.30)
        case nil: return LumoColors.separator
        }
    }
}

// MARK: - UI helpers — mirror of apps/web/lib/memory-ui.ts

enum MemoryUI {
    enum ConfidenceTone { case high, medium, low }

    static func confidenceTone(_ confidence: Double) -> ConfidenceTone {
        if confidence >= 0.8 { return .high }
        if confidence >= 0.55 { return .medium }
        return .low
    }

    static func confidenceLabel(_ confidence: Double) -> String {
        let clamped = max(0, min(1, confidence))
        let pct = Int((clamped * 100).rounded())
        return confidenceTone(confidence) == .low
            ? "\(pct)% needs review"
            : "\(pct)% confidence"
    }

    static func sourceLabel(_ source: String) -> String {
        switch source {
        case "explicit": return "Told by you"
        case "inferred": return "Inferred"
        case "behavioral": return "Learned from activity"
        default:
            return source.isEmpty ? "Unknown source" : titleize(source)
        }
    }

    /// Mirrors web's `formatMemoryRelative` — minutes/hours/days/months/years.
    /// Distinct from `HistoryTimeFormatter` which serves a different
    /// (chat-history) tone. Keeping the two separate keeps each
    /// surface in lockstep with its web counterpart.
    static func formatRelative(_ iso: String, now: Date = Date()) -> String {
        guard let then = HistoryTimeFormatter.parseISO(iso) else { return "unknown" }
        let diff = max(0, now.timeIntervalSince(then))
        let minutes = Int(diff / 60)
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days == 1 { return "yesterday" }
        if days < 30 { return "\(days)d ago" }
        if days < 365 { return "\(days / 30)mo ago" }
        return "\(days / 365)y ago"
    }

    static func categoryLabel(for key: String) -> String {
        switch key {
        case "preference": return "Preferences"
        case "identity": return "About you"
        case "habit": return "Habits"
        case "location": return "Places"
        case "constraint": return "Dietary & accessibility"
        case "context": return "Current context"
        case "milestone": return "Dates & milestones"
        case "other": return "Other"
        default: return titleize(key)
        }
    }

    /// Bucket facts by category and emit deterministic ordering so
    /// the UI doesn't reshuffle on every render. Tuple form keeps
    /// the call site simple in a `ForEach`.
    static func groupedAndSorted(_ facts: [MemoryFactDTO]) -> [(String, [MemoryFactDTO])] {
        var buckets: [String: [MemoryFactDTO]] = [:]
        for f in facts { buckets[f.category, default: []].append(f) }
        return buckets.keys.sorted().map { key in (key, buckets[key] ?? []) }
    }

    private static func titleize(_ s: String) -> String {
        let cleaned = s.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        return cleaned
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
