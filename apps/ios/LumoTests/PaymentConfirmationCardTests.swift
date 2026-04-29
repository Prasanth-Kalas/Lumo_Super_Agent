import XCTest
@testable import Lumo

@MainActor
final class PaymentConfirmationCardTests: XCTestCase {

    func test_initialState_isReady() {
        let vm = makeViewModel()
        XCTAssertEqual(vm.state, .ready)
    }

    func test_confirm_happyPath_landsSucceeded_andPersistsReceipt() async {
        let stubBio = BiometricConfirmationStub()
        stubBio.nextResult = .success
        let stubService = PaymentServiceStub()
        let visa = try! await stubService.presentPaymentSheet(input: .init(
            brand: .visa, last4: "4242", expMonth: 12, expYear: 2030
        ))
        let store = ReceiptStoreStub()
        let vm = PaymentConfirmationViewModel(
            transaction: demoTransaction,
            paymentMethod: visa,
            biometric: stubBio,
            service: stubService,
            store: store
        )
        await vm.confirm()
        guard case .succeeded(let receipt) = vm.state else {
            return XCTFail("expected .succeeded, got \(vm.state)")
        }
        XCTAssertEqual(receipt.amountCents, demoTransaction.totalCents)
        XCTAssertEqual(try? store.load().count, 1, "receipt should be persisted locally")
    }

    func test_confirm_userCancelledBiometric_landsCancelled() async {
        let stubBio = BiometricConfirmationStub()
        stubBio.nextResult = .cancel
        let stubService = PaymentServiceStub()
        let visa = try! await stubService.presentPaymentSheet(input: .init(
            brand: .visa, last4: "4242", expMonth: 12, expYear: 2030
        ))
        let vm = PaymentConfirmationViewModel(
            transaction: demoTransaction,
            paymentMethod: visa,
            biometric: stubBio,
            service: stubService,
            store: ReceiptStoreStub()
        )
        await vm.confirm()
        XCTAssertEqual(vm.state, .cancelled)
    }

    func test_confirm_biometricFailure_landsFailed() async {
        let stubBio = BiometricConfirmationStub()
        stubBio.nextResult = .failure("hardware error")
        let stubService = PaymentServiceStub()
        let visa = try! await stubService.presentPaymentSheet(input: .init(
            brand: .visa, last4: "4242", expMonth: 12, expYear: 2030
        ))
        let vm = PaymentConfirmationViewModel(
            transaction: demoTransaction,
            paymentMethod: visa,
            biometric: stubBio,
            service: stubService,
            store: ReceiptStoreStub()
        )
        await vm.confirm()
        guard case .failed(let message) = vm.state else {
            return XCTFail("expected .failed, got \(vm.state)")
        }
        XCTAssertTrue(message.contains("hardware"), "message should surface underlying detail; got \(message)")
    }

    func test_confirm_serviceFailure_landsFailed() async {
        let stubBio = BiometricConfirmationStub()
        stubBio.nextResult = .success
        let stubService = PaymentServiceStub()
        // Do not add any methods → confirmTransaction throws.
        let phantom = PaymentMethod(
            id: "pm_phantom", brand: .visa, last4: "0000",
            expMonth: 1, expYear: 2030, isDefault: true, addedAt: Date()
        )
        let vm = PaymentConfirmationViewModel(
            transaction: demoTransaction,
            paymentMethod: phantom,
            biometric: stubBio,
            service: stubService,
            store: ReceiptStoreStub()
        )
        await vm.confirm()
        guard case .failed = vm.state else {
            return XCTFail("expected .failed, got \(vm.state)")
        }
    }

    func test_reset_returnsToReady_fromCancelled() async {
        let stubBio = BiometricConfirmationStub()
        stubBio.nextResult = .cancel
        let stubService = PaymentServiceStub()
        let visa = try! await stubService.presentPaymentSheet(input: .init(
            brand: .visa, last4: "4242", expMonth: 12, expYear: 2030
        ))
        let vm = PaymentConfirmationViewModel(
            transaction: demoTransaction,
            paymentMethod: visa,
            biometric: stubBio,
            service: stubService,
            store: ReceiptStoreStub()
        )
        await vm.confirm()
        XCTAssertEqual(vm.state, .cancelled)
        vm.reset()
        XCTAssertEqual(vm.state, .ready)
    }

    func test_reset_doesNotEscapeSucceeded() async {
        let stubBio = BiometricConfirmationStub()
        stubBio.nextResult = .success
        let stubService = PaymentServiceStub()
        let visa = try! await stubService.presentPaymentSheet(input: .init(
            brand: .visa, last4: "4242", expMonth: 12, expYear: 2030
        ))
        let vm = PaymentConfirmationViewModel(
            transaction: demoTransaction,
            paymentMethod: visa,
            biometric: stubBio,
            service: stubService,
            store: ReceiptStoreStub()
        )
        await vm.confirm()
        guard case .succeeded = vm.state else {
            return XCTFail("expected .succeeded as setup")
        }
        vm.reset()
        if case .ready = vm.state {
            XCTFail("reset should not escape terminal .succeeded")
        }
    }

    // MARK: - PendingTransaction.digest

    func test_pendingTransaction_digest_isStableForSamePayload() {
        let a = PendingTransaction(
            title: "Acme",
            lineItems: [LineItem(label: "Room", amountCents: 1000)],
            currency: "usd"
        )
        let b = PendingTransaction(
            title: "Acme",
            lineItems: [LineItem(label: "Room", amountCents: 1000)],
            currency: "usd"
        )
        XCTAssertEqual(a.digest, b.digest)
    }

    func test_pendingTransaction_digest_differsWhenPayloadDiffers() {
        let a = PendingTransaction(
            title: "Acme",
            lineItems: [LineItem(label: "Room", amountCents: 1000)],
            currency: "usd"
        )
        let b = PendingTransaction(
            title: "Acme",
            lineItems: [LineItem(label: "Room", amountCents: 1001)],
            currency: "usd"
        )
        XCTAssertNotEqual(a.digest, b.digest, "1¢ difference must produce a distinct digest")
    }

    func test_pendingTransaction_total_sumsLineItems() {
        let txn = PendingTransaction(
            title: "Acme",
            lineItems: [
                LineItem(label: "Room", amountCents: 39800),
                LineItem(label: "Tax", amountCents: 6420),
            ],
            currency: "usd"
        )
        XCTAssertEqual(txn.totalCents, 46220)
    }

    // MARK: - Helpers

    private func makeViewModel() -> PaymentConfirmationViewModel {
        let stubService = PaymentServiceStub()
        let placeholder = PaymentMethod(
            id: "pm_test_placeholder",
            brand: .visa,
            last4: "4242",
            expMonth: 12,
            expYear: 2030,
            isDefault: true,
            addedAt: Date()
        )
        return PaymentConfirmationViewModel(
            transaction: demoTransaction,
            paymentMethod: placeholder,
            biometric: BiometricConfirmationStub(),
            service: stubService,
            store: ReceiptStoreStub()
        )
    }

    private var demoTransaction: PendingTransaction {
        PendingTransaction(
            title: "Acme Hotel — 2 nights",
            lineItems: [
                LineItem(label: "Room", amountCents: 39800),
                LineItem(label: "Tax", amountCents: 6420),
            ],
            currency: "usd"
        )
    }
}
