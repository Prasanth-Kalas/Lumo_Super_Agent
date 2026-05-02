#if DEBUG
import SwiftUI

/// DEBUG-only root that renders one of the payment screens directly,
/// driven by a `-LumoPaymentsFixture <name>` launch arg. Bypasses
/// auth + nav so the screenshot script can capture each state in a
/// single launch without simulating taps. Compiled out of Release.
///
/// Fixture names:
///   empty-methods       → PaymentMethodsView with no saved cards
///   saved-cards         → PaymentMethodsView with one Visa card
///   add-card            → PaymentMethodsView + AddPaymentMethodSheet
///   confirm-ready       → PaymentConfirmationCard in `.ready` state
///   confirm-success     → PaymentConfirmationCard in `.succeeded` state
///   receipt-history     → ReceiptHistoryView with two seeded receipts
///   receipt-detail      → ReceiptDetailView for one seeded receipt

enum PaymentsFixture: String {
    case emptyMethods = "empty-methods"
    case savedCards = "saved-cards"
    case addCard = "add-card"
    case confirmReady = "confirm-ready"
    case confirmSuccess = "confirm-success"
    case receiptHistory = "receipt-history"
    case receiptDetail = "receipt-detail"

    static var current: PaymentsFixture? {
        guard let raw = UserDefaults.standard.string(forKey: "LumoPaymentsFixture"),
              !raw.isEmpty else {
            return nil
        }
        return PaymentsFixture(rawValue: raw)
    }
}

struct PaymentsFixtureRoot: View {
    let fixture: PaymentsFixture
    private let service: PaymentServicing
    private let store: ReceiptStoring
    private let appConfig: AppConfig

    init(fixture: PaymentsFixture) {
        self.fixture = fixture
        // Synthetic config — Stripe configured (test mode) so the views
        // don't render the not-configured fallback during capture.
        self.appConfig = AppConfig(
            apiBaseURL: URL(string: "http://localhost:0")!,
            supabaseURL: nil,
            supabaseAnonKey: "",
            stripePublishableKey: "pk_test_fixture",
            stripeMerchantID: "merchant.com.lumo.rentals.ios",
            apnsUseSandbox: true
        )
        let paymentStub = PaymentServiceStub()
        let receiptStub = ReceiptStoreStub()
        Self.seed(paymentStub, receiptStub, fixture: fixture)
        self.service = paymentStub
        self.store = receiptStub
    }

    var body: some View {
        NavigationStack {
            Group {
                switch fixture {
                case .emptyMethods, .savedCards, .addCard:
                    paymentMethodsHost
                case .confirmReady, .confirmSuccess:
                    confirmHost
                case .receiptHistory:
                    ReceiptHistoryView(store: store)
                case .receiptDetail:
                    if let receipt = (try? store.load())?.first {
                        ReceiptDetailView(receipt: receipt)
                    } else {
                        Text("(no seeded receipt)")
                    }
                }
            }
        }
        .tint(LumoColors.cyan)
    }

    // MARK: - Hosts

    @ViewBuilder
    private var paymentMethodsHost: some View {
        PaymentMethodsView(
            viewModel: makePaymentMethodsViewModel(),
            isStripeLiveMode: false
        )
    }

    private func makePaymentMethodsViewModel() -> PaymentMethodsViewModel {
        let vm = PaymentMethodsViewModel(
            service: service,
            isConfigured: appConfig.isStripeConfigured
        )
        if fixture == .addCard {
            // Pre-fill the form so the sheet renders fully populated.
            vm.addCardForm.cardNumber = "4242 4242 4242 4242"
            vm.addCardForm.expMonth = "12"
            vm.addCardForm.expYear = "30"
            vm.addCardForm.cvv = "123"
            vm.showAddSheet = true
        }
        return vm
    }

    @ViewBuilder
    private var confirmHost: some View {
        PaymentsFixtureConfirmHost(
            fixture: fixture,
            service: service,
            store: store
        )
    }

    // MARK: - Seeding

    private static func seed(
        _ paymentStub: PaymentServiceStub,
        _ receiptStub: ReceiptStoreStub,
        fixture: PaymentsFixture
    ) {
        switch fixture {
        case .emptyMethods:
            break
        case .savedCards, .addCard:
            seedDefaultCards(paymentStub)
        case .confirmReady, .confirmSuccess:
            seedDefaultCards(paymentStub)
        case .receiptHistory:
            seedDefaultCards(paymentStub)
            seedDefaultReceipts(receiptStub)
        case .receiptDetail:
            seedDefaultCards(paymentStub)
            seedDefaultReceipts(receiptStub)
        }
    }

    private static func seedDefaultCards(_ stub: PaymentServiceStub) {
        let visa = PaymentMethod(
            id: "pm_test_fixture_visa",
            brand: .visa, last4: "4242",
            expMonth: 12, expYear: 2030,
            isDefault: true,
            addedAt: Date(timeIntervalSinceNow: -86_400 * 7)
        )
        let mc = PaymentMethod(
            id: "pm_test_fixture_mc",
            brand: .mastercard, last4: "5555",
            expMonth: 1, expYear: 2031,
            isDefault: false,
            addedAt: Date(timeIntervalSinceNow: -86_400 * 2)
        )
        stub.injectMethods([visa, mc])
    }

    private static func seedDefaultReceipts(_ stub: ReceiptStoreStub) {
        let acme = Receipt(
            id: "rcpt_fixture_1",
            transactionId: "txn_fixture_1",
            amountCents: 46220,
            currency: "usd",
            paymentMethodId: "pm_test_fixture_visa",
            paymentMethodLabel: "VISA •• 4242",
            lineItems: [
                LineItem(label: "Room rate", amountCents: 39800),
                LineItem(label: "Taxes & fees", amountCents: 6420),
            ],
            createdAt: Date(timeIntervalSinceNow: -86_400),
            status: .succeeded
        )
        let coffee = Receipt(
            id: "rcpt_fixture_2",
            transactionId: "txn_fixture_2",
            amountCents: 1850,
            currency: "usd",
            paymentMethodId: "pm_test_fixture_visa",
            paymentMethodLabel: "VISA •• 4242",
            lineItems: [
                LineItem(label: "Latte", amountCents: 650),
                LineItem(label: "Croissant", amountCents: 1200),
            ],
            createdAt: Date(timeIntervalSinceNow: -86_400 * 14),
            status: .succeeded
        )
        try? stub.append(coffee)
        try? stub.append(acme)
    }
}

// MARK: - Confirm host (auto-drives the success state when needed)

private struct PaymentsFixtureConfirmHost: View {
    let fixture: PaymentsFixture
    let service: PaymentServicing
    let store: ReceiptStoring

    var body: some View {
        ZStack {
            LumoColors.background.ignoresSafeArea()
            confirmCard
        }
        .navigationTitle("Confirm payment")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var confirmCard: some View {
        let demoTxn = PendingTransaction(
            title: "Acme Hotel — 2 nights",
            lineItems: [
                LineItem(label: "Room rate", amountCents: 39800),
                LineItem(label: "Taxes & fees", amountCents: 6420),
            ],
            currency: "usd"
        )
        let demoMethod = PaymentMethod(
            id: "pm_test_fixture_visa",
            brand: .visa, last4: "4242",
            expMonth: 12, expYear: 2030,
            isDefault: true,
            addedAt: Date(timeIntervalSinceNow: -86_400 * 7)
        )
        let bio = BiometricConfirmationStub()
        bio.nextResult = .success
        let viewModel = PaymentConfirmationViewModel(
            transaction: demoTxn,
            paymentMethod: demoMethod,
            biometric: bio,
            service: service,
            store: store
        )
        return PaymentConfirmationCard(
            viewModel: viewModel,
            onComplete: { _ in },
            onCancel: { }
        )
        .task {
            if fixture == .confirmSuccess {
                await viewModel.confirm()
            }
        }
    }
}

// MARK: - PaymentServiceStub seeding helper

extension PaymentServiceStub {
    /// Replace the in-memory methods list with a deterministic fixture
    /// set. Used only by `PaymentsFixtureRoot`; not used by tests
    /// (tests build state via `presentPaymentSheet` to also exercise
    /// the default-promotion logic).
    func injectMethods(_ seed: [PaymentMethod]) {
        self.methods = seed
    }
}
#endif
