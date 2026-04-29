import SwiftUI

/// Single-receipt detail. Shows line items, total, payment method,
/// transaction id (truncated, copyable), date, and status. Read-only —
/// MERCHANT-1 will add the refund-initiation entry point here.

struct ReceiptDetailView: View {
    let receipt: Receipt

    var body: some View {
        Form {
            statusSection
            lineItemsSection
            paymentSection
            transactionSection
        }
        .navigationTitle("Receipt")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    @ViewBuilder
    private var statusSection: some View {
        Section {
            HStack(spacing: LumoSpacing.md) {
                statusGlyph
                VStack(alignment: .leading, spacing: 2) {
                    Text(statusLabel)
                        .font(LumoFonts.title)
                    Text(formattedDateTime)
                        .font(LumoFonts.footnote)
                        .foregroundStyle(LumoColors.labelSecondary)
                }
                Spacer()
                Text(formattedTotal)
                    .font(LumoFonts.title)
                    .monospacedDigit()
            }
            .padding(.vertical, LumoSpacing.xs)
        }
    }

    private var lineItemsSection: some View {
        Section("Items") {
            if receipt.lineItems.isEmpty {
                LabeledContent("Subtotal", value: formattedTotal)
                    .monospacedDigit()
            } else {
                ForEach(Array(receipt.lineItems.enumerated()), id: \.offset) { _, item in
                    LabeledContent(item.label, value: format(cents: item.amountCents))
                        .monospacedDigit()
                }
                LabeledContent("Total", value: formattedTotal)
                    .font(LumoFonts.bodyEmphasized)
                    .monospacedDigit()
            }
        }
    }

    private var paymentSection: some View {
        Section("Payment") {
            LabeledContent("Method", value: receipt.paymentMethodLabel)
        }
    }

    private var transactionSection: some View {
        Section("Transaction") {
            LabeledContent("ID", value: shortID(receipt.transactionId))
                .font(.system(.body, design: .monospaced))
            LabeledContent("Receipt", value: shortID(receipt.id))
                .font(.system(.body, design: .monospaced))
        }
    }

    // MARK: - Helpers

    private var statusGlyph: some View {
        Image(systemName: statusGlyphName)
            .font(.system(size: 30))
            .foregroundStyle(statusTint)
    }

    private var statusGlyphName: String {
        switch receipt.status {
        case .succeeded: return "checkmark.circle.fill"
        case .failed:    return "xmark.circle.fill"
        }
    }

    private var statusTint: Color {
        switch receipt.status {
        case .succeeded: return LumoColors.success
        case .failed:    return LumoColors.error
        }
    }

    private var statusLabel: String {
        switch receipt.status {
        case .succeeded: return "Paid"
        case .failed:    return "Failed"
        }
    }

    private var formattedTotal: String {
        format(cents: receipt.amountCents)
    }

    private func format(cents: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = receipt.currency.uppercased()
        return formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "—"
    }

    private var formattedDateTime: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: receipt.createdAt)
    }

    private func shortID(_ id: String) -> String {
        guard id.count > 16 else { return id }
        let prefix = id.prefix(12)
        let suffix = id.suffix(4)
        return "\(prefix)…\(suffix)"
    }
}
