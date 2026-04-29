import Foundation

/// Drives the `PaymentConfirmationCard` state machine. Pulled out of
/// the view so unit tests can exercise transitions without instantiating
/// SwiftUI.

struct PendingTransaction: Equatable {
    /// User-facing one-line description ("Acme Hotel — 2 nights").
    let title: String
    let lineItems: [LineItem]
    /// Currency in ISO-4217 lowercase (matches backend).
    let currency: String

    var totalCents: Int {
        lineItems.reduce(0) { $0 + $1.amountCents }
    }

    /// SHA-256 over the canonical text representation of the
    /// transaction. Re-derivable on the server given the same payload.
    var digest: Data {
        let canonical = "\(title)|\(currency)|" + lineItems
            .map { "\($0.label):\($0.amountCents)" }
            .joined(separator: ",")
        return .transactionDigest(of: Data(canonical.utf8))
    }
}

enum PaymentConfirmationState: Equatable {
    case ready
    case authorizing
    case processing
    case succeeded(Receipt)
    case failed(String)
    case cancelled
}

@MainActor
final class PaymentConfirmationViewModel: ObservableObject {
    @Published private(set) var state: PaymentConfirmationState = .ready

    let transaction: PendingTransaction
    let paymentMethod: PaymentMethod

    private let biometric: BiometricConfirmationServicing
    private let service: PaymentServicing
    private let store: ReceiptStoring
    private let promptText: String

    init(
        transaction: PendingTransaction,
        paymentMethod: PaymentMethod,
        biometric: BiometricConfirmationServicing,
        service: PaymentServicing,
        store: ReceiptStoring,
        biometricKind: BiometryKind = BiometricUnlockService().biometryKind()
    ) {
        self.transaction = transaction
        self.paymentMethod = paymentMethod
        self.biometric = biometric
        self.service = service
        self.store = store
        self.promptText = Self.makePrompt(
            transaction: transaction,
            biometricKind: biometricKind
        )
    }

    /// Run the full confirm flow: biometric → confirm-transaction →
    /// receipt persisted → `.succeeded`.
    func confirm() async {
        guard case .ready = state else { return }
        state = .authorizing
        let token: SignedConfirmationToken
        do {
            token = try await biometric.requestConfirmation(
                prompt: promptText,
                transactionDigest: transaction.digest
            )
        } catch BiometricConfirmationError.userCancelled {
            state = .cancelled
            return
        } catch {
            state = .failed(error.localizedDescription)
            return
        }

        state = .processing
        let receipt: Receipt
        do {
            let input = ConfirmTransactionInput(
                amountCents: transaction.totalCents,
                currency: transaction.currency,
                paymentMethodId: paymentMethod.id,
                lineItems: transaction.lineItems,
                transactionDigest: transaction.digest,
                signedConfirmationToken: token.tokenData
            )
            receipt = try await service.confirmTransaction(input)
        } catch {
            state = .failed(error.localizedDescription)
            return
        }

        do {
            try store.append(receipt)
        } catch {
            // Receipt landed on the server but failed to persist locally.
            // Surface the success — the user did pay — and let the next
            // history reload re-pull from server when MOBILE-API-1 syncs.
            // Don't undo the success state on a local-cache miss.
        }
        state = .succeeded(receipt)
    }

    /// Reset to `.ready` after a non-terminal outcome (cancel, fail).
    /// Doesn't touch `.succeeded` — that's terminal; the host dismisses
    /// the card.
    func reset() {
        switch state {
        case .cancelled, .failed:
            state = .ready
        case .ready, .authorizing, .processing, .succeeded:
            return
        }
    }

    // MARK: - Helpers

    private static func makePrompt(
        transaction: PendingTransaction,
        biometricKind: BiometryKind
    ) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = transaction.currency.uppercased()
        let amount = formatter.string(
            from: NSNumber(value: Double(transaction.totalCents) / 100)
        ) ?? "—"
        return "Confirm payment of \(amount) for \(transaction.title)."
    }
}
