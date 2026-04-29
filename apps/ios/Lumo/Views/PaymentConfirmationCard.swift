import SwiftUI

/// Modal card that asks the user to biometric-confirm a payment.
/// Renders line items + total + payment method, then a Confirm button
/// that drives `PaymentConfirmationViewModel` through:
///   ready → authorizing → processing → succeeded/failed/cancelled.
/// On success, the host calls `onComplete(receipt)` to dismiss + show
/// the new receipt; on cancel/fail the user can retry or dismiss.

struct PaymentConfirmationCard: View {
    @StateObject var viewModel: PaymentConfirmationViewModel

    let biometricLabel: String
    let onComplete: (Receipt) -> Void
    let onCancel: () -> Void

    init(
        viewModel: PaymentConfirmationViewModel,
        biometricLabel: String = BiometricUnlockService().biometryKind().label,
        onComplete: @escaping (Receipt) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self._viewModel = StateObject(wrappedValue: viewModel)
        self.biometricLabel = biometricLabel
        self.onComplete = onComplete
        self.onCancel = onCancel
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
                .padding(.vertical, LumoSpacing.md)
            lineItemsList
            Divider()
                .padding(.vertical, LumoSpacing.md)
            paymentMethodRow
            Spacer(minLength: LumoSpacing.lg)
            footer
        }
        .padding(LumoSpacing.lg)
        .background(LumoColors.surface)
        .cornerRadius(LumoRadius.lg)
        .shadow(color: .black.opacity(0.12), radius: 18, y: 6)
        .padding(.horizontal, LumoSpacing.lg)
        .accessibilityIdentifier("payments.confirmCard")
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.xs) {
            Text("Confirm payment")
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text(viewModel.transaction.title)
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .lineLimit(2)
        }
    }

    private var lineItemsList: some View {
        VStack(spacing: LumoSpacing.sm) {
            ForEach(Array(viewModel.transaction.lineItems.enumerated()), id: \.offset) { _, item in
                HStack {
                    Text(item.label)
                        .font(LumoFonts.body)
                        .foregroundStyle(LumoColors.label)
                    Spacer()
                    Text(format(cents: item.amountCents))
                        .font(LumoFonts.body)
                        .monospacedDigit()
                        .foregroundStyle(LumoColors.label)
                }
            }
            HStack {
                Text("Total")
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                Spacer()
                Text(format(cents: viewModel.transaction.totalCents))
                    .font(LumoFonts.bodyEmphasized)
                    .monospacedDigit()
                    .foregroundStyle(LumoColors.label)
            }
            .padding(.top, LumoSpacing.xs)
        }
    }

    private var paymentMethodRow: some View {
        HStack(spacing: LumoSpacing.sm) {
            Image(systemName: brandGlyph(viewModel.paymentMethod.brand))
                .font(.system(size: 22))
                .foregroundStyle(LumoColors.cyanDeep)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(viewModel.paymentMethod.brand.displayName) •• \(viewModel.paymentMethod.last4)")
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                Text("Expires \(viewModel.paymentMethod.expirationLabel)")
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var footer: some View {
        switch viewModel.state {
        case .ready:
            VStack(spacing: LumoSpacing.sm) {
                Button("Confirm with \(biometricLabel)") {
                    Task { await viewModel.confirm() }
                }
                .buttonStyle(.lumoPrimary)
                .accessibilityIdentifier("payments.confirmCard.confirm")
                Button("Cancel", role: .cancel, action: onCancel)
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
        case .authorizing:
            HStack(spacing: LumoSpacing.sm) {
                ProgressView()
                Text("Waiting for \(biometricLabel)…")
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, LumoSpacing.md)
        case .processing:
            HStack(spacing: LumoSpacing.sm) {
                ProgressView()
                Text("Processing payment…")
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, LumoSpacing.md)
        case .succeeded(let receipt):
            VStack(spacing: LumoSpacing.sm) {
                HStack(spacing: LumoSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(LumoColors.success)
                    Text("Payment confirmed")
                        .font(LumoFonts.bodyEmphasized)
                        .foregroundStyle(LumoColors.label)
                }
                Text(format(cents: receipt.amountCents))
                    .font(LumoFonts.title)
                    .foregroundStyle(LumoColors.label)
                Button("Done") { onComplete(receipt) }
                    .buttonStyle(.lumoPrimary)
                    .accessibilityIdentifier("payments.confirmCard.done")
            }
        case .failed(let message):
            VStack(spacing: LumoSpacing.sm) {
                HStack(spacing: LumoSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(LumoColors.warning)
                    Text("Payment failed")
                        .font(LumoFonts.bodyEmphasized)
                        .foregroundStyle(LumoColors.label)
                }
                Text(message)
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .multilineTextAlignment(.center)
                HStack(spacing: LumoSpacing.sm) {
                    Button("Cancel", role: .cancel, action: onCancel)
                        .font(LumoFonts.body)
                        .frame(maxWidth: .infinity)
                    Button("Try again", action: viewModel.reset)
                        .buttonStyle(.lumoPrimary)
                }
            }
        case .cancelled:
            VStack(spacing: LumoSpacing.sm) {
                Text("Confirmation cancelled.")
                    .font(LumoFonts.body)
                    .foregroundStyle(LumoColors.labelSecondary)
                HStack(spacing: LumoSpacing.sm) {
                    Button("Dismiss", role: .cancel, action: onCancel)
                        .font(LumoFonts.body)
                        .frame(maxWidth: .infinity)
                    Button("Try again", action: viewModel.reset)
                        .buttonStyle(.lumoPrimary)
                }
            }
        }
    }

    // MARK: - Helpers

    private func format(cents: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = viewModel.transaction.currency.uppercased()
        return formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "—"
    }

    private func brandGlyph(_ brand: CardBrand) -> String {
        switch brand {
        case .visa, .mastercard, .amex, .discover:
            return "creditcard.fill"
        case .unknown:
            return "creditcard"
        }
    }
}
