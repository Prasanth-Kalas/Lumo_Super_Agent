import SwiftUI

/// Settings sub-screen: list saved cards with brand icon + last 4 +
/// expiration + default badge. "Add payment method" presents a
/// synthetic add-card sheet (v1 stub mode) that mirrors PaymentSheet
/// UX. MERCHANT-1 replaces the sheet body with real
/// `PaymentSheet.present(from:)` once a real Stripe SetupIntent
/// client_secret is available from the backend.

struct PaymentMethodsView: View {
    @StateObject var viewModel: PaymentMethodsViewModel
    let isStripeLiveMode: Bool

    init(viewModel: PaymentMethodsViewModel, isStripeLiveMode: Bool = false) {
        self._viewModel = StateObject(wrappedValue: viewModel)
        self.isStripeLiveMode = isStripeLiveMode
    }

    var body: some View {
        Group {
            if !viewModel.isConfigured {
                notConfiguredEmptyState
            } else {
                methodsList
            }
        }
        .navigationTitle("Payment Methods")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.reload() }
        .sheet(isPresented: $viewModel.showAddSheet) {
            AddPaymentMethodSheet(viewModel: viewModel)
        }
        .alert(
            "Couldn't update payment methods",
            isPresented: Binding(
                get: { viewModel.actionError != nil },
                set: { if !$0 { viewModel.clearActionError() } }
            ),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(viewModel.actionError ?? "") }
        )
    }

    // MARK: - Configured states

    @ViewBuilder
    private var methodsList: some View {
        Form {
            if !isStripeLiveMode {
                Section {
                    HStack(spacing: LumoSpacing.sm) {
                        Image(systemName: "info.circle")
                            .foregroundStyle(LumoColors.warning)
                        Text("Test mode — no real charges. MERCHANT-1 enables live payments.")
                            .font(LumoFonts.footnote)
                            .foregroundStyle(LumoColors.labelSecondary)
                    }
                }
                .listRowBackground(LumoColors.surfaceElevated)
            }

            switch viewModel.loadState {
            case .idle, .loading:
                Section {
                    HStack {
                        ProgressView()
                        Text("Loading…")
                            .font(LumoFonts.body)
                            .foregroundStyle(LumoColors.labelSecondary)
                            .padding(.leading, LumoSpacing.sm)
                    }
                }
            case .error(let message):
                Section {
                    HStack(spacing: LumoSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(LumoColors.error)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Couldn't load payment methods")
                                .font(LumoFonts.bodyEmphasized)
                            Text(message)
                                .font(LumoFonts.footnote)
                                .foregroundStyle(LumoColors.labelSecondary)
                        }
                    }
                    Button("Retry") { Task { await viewModel.reload() } }
                }
            case .loaded:
                if viewModel.methods.isEmpty {
                    Section {
                        emptyMethodsRow
                    }
                } else {
                    Section("Saved cards") {
                        ForEach(viewModel.methods) { method in
                            PaymentMethodRow(
                                method: method,
                                onSetDefault: {
                                    Task { await viewModel.setDefault(id: method.id) }
                                },
                                onDelete: {
                                    Task { await viewModel.remove(id: method.id) }
                                }
                            )
                        }
                    }
                }
            }

            Section {
                Button {
                    viewModel.showAddSheet = true
                } label: {
                    HStack {
                        Image(systemName: "plus.circle.fill")
                            .foregroundStyle(LumoColors.cyan)
                        Text("Add payment method")
                            .foregroundStyle(LumoColors.label)
                        Spacer()
                    }
                }
                .accessibilityIdentifier("payments.addMethod")
            }
        }
    }

    private var emptyMethodsRow: some View {
        VStack(spacing: LumoSpacing.sm) {
            Image(systemName: "creditcard")
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("No payment methods saved")
                .font(LumoFonts.bodyEmphasized)
                .foregroundStyle(LumoColors.label)
            Text("Add a card to confirm trips and bookings with Face ID.")
                .font(LumoFonts.footnote)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, LumoSpacing.md)
    }

    private var notConfiguredEmptyState: some View {
        VStack(spacing: LumoSpacing.md) {
            Image(systemName: "creditcard.trianglebadge.exclamationmark")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("Payments not configured")
                .font(LumoFonts.title)
            Text("Set LUMO_STRIPE_PUBLISHABLE_KEY_TEST in your env, then re-run the build pipeline.")
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background)
    }
}

// MARK: - Row

private struct PaymentMethodRow: View {
    let method: PaymentMethod
    let onSetDefault: () -> Void
    let onDelete: () -> Void

    @State private var showRemoveConfirm = false

    var body: some View {
        HStack(spacing: LumoSpacing.md) {
            Image(systemName: brandGlyph)
                .font(.system(size: 26))
                .foregroundStyle(LumoColors.cyanDeep)
                .frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: LumoSpacing.xs) {
                    Text("\(method.brand.displayName) •• \(method.last4)")
                        .font(LumoFonts.bodyEmphasized)
                    if method.isDefault {
                        Text("Default")
                            .font(LumoFonts.caption)
                            .padding(.horizontal, LumoSpacing.xs)
                            .padding(.vertical, 2)
                            .background(
                                Capsule()
                                    .fill(LumoColors.cyan.opacity(0.18))
                            )
                            .foregroundStyle(LumoColors.cyanDeep)
                    }
                }
                Text("Expires \(method.expirationLabel)")
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
            Spacer()
        }
        .contentShape(Rectangle())
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                showRemoveConfirm = true
            } label: {
                Label("Remove", systemImage: "trash")
            }
            if !method.isDefault {
                Button(action: onSetDefault) {
                    Label("Default", systemImage: "checkmark.circle")
                }
                .tint(LumoColors.cyanDeep)
            }
        }
        .confirmationDialog(
            "Remove \(method.brand.displayName) ending in \(method.last4)?",
            isPresented: $showRemoveConfirm,
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive, action: onDelete)
            Button("Cancel", role: .cancel) {}
        }
    }

    private var brandGlyph: String {
        switch method.brand {
        case .visa, .mastercard, .amex, .discover:
            return "creditcard.fill"
        case .unknown:
            return "creditcard"
        }
    }
}

// MARK: - Add card sheet

private struct AddPaymentMethodSheet: View {
    @ObservedObject var viewModel: PaymentMethodsViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        "Card number",
                        text: $viewModel.addCardForm.cardNumber
                    )
                    .keyboardType(.numberPad)
                    .textContentType(.creditCardNumber)
                    .accessibilityIdentifier("payments.addCard.number")

                    HStack(spacing: LumoSpacing.md) {
                        TextField("MM", text: $viewModel.addCardForm.expMonth)
                            .keyboardType(.numberPad)
                            .frame(maxWidth: 60)
                            .accessibilityIdentifier("payments.addCard.expMonth")
                        TextField("YY", text: $viewModel.addCardForm.expYear)
                            .keyboardType(.numberPad)
                            .frame(maxWidth: 80)
                            .accessibilityIdentifier("payments.addCard.expYear")
                        TextField("CVV", text: $viewModel.addCardForm.cvv)
                            .keyboardType(.numberPad)
                            .frame(maxWidth: 70)
                            .accessibilityIdentifier("payments.addCard.cvv")
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: LumoSpacing.xs) {
                        Text("Test mode. Use 4242 4242 4242 4242, any future expiry, any 3-digit CVV.")
                            .foregroundStyle(LumoColors.labelSecondary)
                        if let error = viewModel.addCardForm.error {
                            Text(error)
                                .foregroundStyle(LumoColors.error)
                        }
                    }
                }

                Section {
                    Button {
                        Task { await viewModel.submitAddCard() }
                    } label: {
                        HStack {
                            Spacer()
                            if viewModel.addCardForm.submitting {
                                ProgressView()
                                    .padding(.trailing, LumoSpacing.sm)
                            }
                            Text(viewModel.addCardForm.submitting ? "Saving…" : "Save card")
                                .font(LumoFonts.bodyEmphasized)
                            Spacer()
                        }
                    }
                    .disabled(viewModel.addCardForm.submitting)
                    .accessibilityIdentifier("payments.addCard.save")
                }
            }
            .navigationTitle("Add card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
