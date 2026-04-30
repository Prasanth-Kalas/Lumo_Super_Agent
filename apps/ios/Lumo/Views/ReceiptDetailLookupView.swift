import SwiftUI

/// Resolves a receipt id from the store, then renders ReceiptDetailView.
/// Used by the notification deep-link path: a payment-receipt push
/// carries the receipt id, the chat NavigationStack pushes
/// `.receiptDetail(id)`, and this wrapper does the load + find.
///
/// Falls through to the receipt-history view's "no receipt found"
/// pattern (visible empty card) if the id can't be matched. We keep
/// the not-found path visible rather than auto-popping so the user
/// understands the deep link was received but the data isn't local.
struct ReceiptDetailLookupView: View {
    let receiptID: String
    let store: ReceiptStoring

    @State private var receipt: Receipt?
    @State private var loadFailed: Bool = false

    var body: some View {
        Group {
            if let receipt {
                ReceiptDetailView(receipt: receipt)
            } else if loadFailed {
                notFound
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { resolve() }
        .navigationTitle("Receipt")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func resolve() {
        do {
            let receipts = try store.load()
            self.receipt = receipts.first { $0.id == receiptID }
            self.loadFailed = (self.receipt == nil)
        } catch {
            self.loadFailed = true
        }
    }

    private var notFound: some View {
        VStack(spacing: LumoSpacing.md) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 40))
                .foregroundStyle(LumoColors.labelTertiary)
            Text("Receipt not found")
                .font(LumoFonts.bodyEmphasized)
            Text("This receipt isn't in your local history. It may have been cleared on this device.")
                .font(LumoFonts.footnote)
                .foregroundStyle(LumoColors.labelSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, LumoSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LumoColors.background.ignoresSafeArea())
    }
}
