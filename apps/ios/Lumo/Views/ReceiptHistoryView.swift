import SwiftUI

/// List of saved receipts, grouped by month. Tapping a row navigates
/// to `ReceiptDetailView`. Reads from the host-injected `ReceiptStore`
/// on appear and again on `.onChange` of a published trigger so newly
/// confirmed transactions surface without a manual reload.

struct ReceiptHistoryView: View {
    let store: ReceiptStoring

    @State private var receipts: [Receipt] = []
    @State private var loadError: String?

    var body: some View {
        Group {
            if let error = loadError {
                emptyState(systemImage: "exclamationmark.triangle",
                           title: "Couldn't load receipts",
                           message: error)
            } else if receipts.isEmpty {
                emptyState(systemImage: "doc.text",
                           title: "No receipts yet",
                           message: "Confirmed payments will appear here.")
            } else {
                List {
                    ForEach(groupedByMonth, id: \.title) { group in
                        Section(group.title) {
                            ForEach(group.receipts) { receipt in
                                NavigationLink {
                                    ReceiptDetailView(receipt: receipt)
                                } label: {
                                    ReceiptRow(receipt: receipt)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle("Receipts")
        .navigationBarTitleDisplayMode(.large)
        .onAppear(perform: reload)
    }

    // MARK: - Data

    private func reload() {
        do {
            receipts = try store.load()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private var groupedByMonth: [(title: String, receipts: [Receipt])] {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        let groups = Dictionary(grouping: receipts) { receipt in
            formatter.string(from: receipt.createdAt)
        }
        return groups
            .map { (title: $0.key, receipts: $0.value) }
            .sorted { lhs, rhs in
                let lhsDate = lhs.receipts.first?.createdAt ?? .distantPast
                let rhsDate = rhs.receipts.first?.createdAt ?? .distantPast
                return lhsDate > rhsDate
            }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func emptyState(systemImage: String, title: String, message: String) -> some View {
        VStack(spacing: LumoSpacing.md) {
            Image(systemName: systemImage)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(LumoColors.labelTertiary)
            Text(title)
                .font(LumoFonts.title)
                .foregroundStyle(LumoColors.label)
            Text(message)
                .font(LumoFonts.body)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background)
    }
}

private struct ReceiptRow: View {
    let receipt: Receipt

    var body: some View {
        HStack(spacing: LumoSpacing.md) {
            statusGlyph
            VStack(alignment: .leading, spacing: 2) {
                Text(receipt.lineItems.first?.label ?? "Payment")
                    .font(LumoFonts.bodyEmphasized)
                    .foregroundStyle(LumoColors.label)
                    .lineLimit(1)
                Text(receipt.paymentMethodLabel)
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(formattedAmount)
                    .font(LumoFonts.bodyEmphasized)
                    .monospacedDigit()
                    .foregroundStyle(LumoColors.label)
                Text(formattedDate)
                    .font(LumoFonts.caption)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var statusGlyph: some View {
        Image(systemName: statusGlyphName)
            .font(.system(size: 22))
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

    private var formattedAmount: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = receipt.currency.uppercased()
        return formatter.string(from: NSNumber(value: Double(receipt.amountCents) / 100)) ?? "—"
    }

    private var formattedDate: String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: receipt.createdAt)
    }
}
