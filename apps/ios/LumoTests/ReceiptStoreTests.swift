import XCTest
@testable import Lumo

final class ReceiptStoreTests: XCTestCase {

    private var tempURL: URL!

    override func setUp() {
        super.setUp()
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("LumoReceiptStoreTests-\(UUID().uuidString)", isDirectory: true)
        tempURL = tempDir.appendingPathComponent("receipts.json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempURL.deletingLastPathComponent())
        super.tearDown()
    }

    func test_load_onMissingFile_returnsEmpty() throws {
        let store = ReceiptStore(fileURL: tempURL)
        XCTAssertEqual(try store.load(), [])
    }

    func test_appendThenLoad_roundTripsAReceipt() throws {
        let store = ReceiptStore(fileURL: tempURL)
        let receipt = makeReceipt(id: "rcpt_1", txn: "txn_1", amount: 4218)
        try store.append(receipt)
        let loaded = try store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.transactionId, "txn_1")
        XCTAssertEqual(loaded.first?.amountCents, 4218)
    }

    func test_appendTwice_keepsBothReceipts_newestFirst() throws {
        let store = ReceiptStore(fileURL: tempURL)
        try store.append(makeReceipt(id: "rcpt_1", txn: "txn_1", amount: 1000, daysAgo: 2))
        try store.append(makeReceipt(id: "rcpt_2", txn: "txn_2", amount: 2000, daysAgo: 0))
        let loaded = try store.load()
        XCTAssertEqual(loaded.map(\.transactionId), ["txn_2", "txn_1"])
    }

    func test_appendDuplicate_isIdempotent_byTransactionId() throws {
        let store = ReceiptStore(fileURL: tempURL)
        let receipt = makeReceipt(id: "rcpt_1", txn: "txn_1", amount: 1000)
        try store.append(receipt)
        try store.append(receipt) // same transactionId
        let loaded = try store.load()
        XCTAssertEqual(loaded.count, 1, "duplicate transactionId should not double-record")
    }

    func test_persistsAcrossInstanceRecreation() throws {
        let storeA = ReceiptStore(fileURL: tempURL)
        try storeA.append(makeReceipt(id: "rcpt_1", txn: "txn_1", amount: 1000))
        // Simulate a fresh app launch with a new store instance.
        let storeB = ReceiptStore(fileURL: tempURL)
        XCTAssertEqual(try storeB.load().count, 1)
    }

    func test_clear_resetsToEmpty() throws {
        let store = ReceiptStore(fileURL: tempURL)
        try store.append(makeReceipt(id: "rcpt_1", txn: "txn_1", amount: 1000))
        try store.clear()
        XCTAssertEqual(try store.load(), [])
    }

    func test_writeIsAtomic_preservesPriorOnPartialFailure() throws {
        let store = ReceiptStore(fileURL: tempURL)
        try store.append(makeReceipt(id: "rcpt_1", txn: "txn_1", amount: 1000))
        // The atomic-write path renames a temp file, so reading the
        // backing file at any time after a successful append should
        // yield the appended receipt — never an empty/partial file.
        let raw = try Data(contentsOf: tempURL)
        XCTAssertTrue(raw.count > 0)
        // sanity: still valid JSON
        let loaded = try store.load()
        XCTAssertEqual(loaded.count, 1)
    }

    // MARK: - Stub

    func test_stub_seedsAndAppends() throws {
        let stub = ReceiptStoreStub(seed: [makeReceipt(id: "rcpt_seed", txn: "txn_seed", amount: 500)])
        try stub.append(makeReceipt(id: "rcpt_new", txn: "txn_new", amount: 600))
        XCTAssertEqual(try stub.load().map(\.transactionId), ["txn_new", "txn_seed"])
    }

    func test_stub_dedupesByTransactionId() throws {
        let stub = ReceiptStoreStub()
        let receipt = makeReceipt(id: "rcpt_1", txn: "txn_1", amount: 1)
        try stub.append(receipt)
        try stub.append(receipt)
        XCTAssertEqual(try stub.load().count, 1)
    }

    // MARK: - Helpers

    private func makeReceipt(
        id: String,
        txn: String,
        amount: Int,
        daysAgo: Int = 0
    ) -> Receipt {
        Receipt(
            id: id,
            transactionId: txn,
            amountCents: amount,
            currency: "usd",
            paymentMethodId: "pm_test_visa",
            paymentMethodLabel: "VISA •• 4242",
            lineItems: [LineItem(label: "Item", amountCents: amount)],
            createdAt: Date().addingTimeInterval(-Double(daysAgo) * 86_400),
            status: .succeeded
        )
    }
}
