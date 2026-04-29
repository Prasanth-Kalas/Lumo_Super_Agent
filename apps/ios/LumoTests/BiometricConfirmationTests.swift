import XCTest
import CryptoKit
@testable import Lumo

final class BiometricConfirmationTests: XCTestCase {

    // MARK: - makeToken (pure)

    func test_makeToken_producesAtLeast48Bytes() {
        let digest = Data(repeating: 0xCC, count: 32)
        let token = BiometricConfirmationService.makeToken(transactionDigest: digest)
        // 32-byte HMAC-SHA256 + 16-byte nonce = 48 bytes minimum
        XCTAssertEqual(token.tokenData.count, 48)
        XCTAssertEqual(token.transactionDigest, digest)
    }

    func test_makeToken_isNotDeterministic_acrossCalls() {
        let digest = Data(repeating: 0x42, count: 32)
        let a = BiometricConfirmationService.makeToken(transactionDigest: digest)
        let b = BiometricConfirmationService.makeToken(transactionDigest: digest)
        XCTAssertNotEqual(a.tokenData, b.tokenData,
                          "fresh per-call symmetric key + nonce should make tokens differ")
    }

    func test_makeToken_base64_isWellFormed() {
        let token = BiometricConfirmationService.makeToken(
            transactionDigest: Data(repeating: 0x01, count: 32)
        )
        let b64 = token.base64
        XCTAssertGreaterThanOrEqual(b64.count, 16, "backend stub requires token length >= 16")
        XCTAssertNotNil(Data(base64Encoded: b64))
    }

    // MARK: - Stub behavior

    func test_stub_success_returnsToken() async throws {
        let stub = BiometricConfirmationStub()
        stub.nextResult = .success
        let digest = Data.transactionDigest(of: Data("hello".utf8))
        let token = try await stub.requestConfirmation(prompt: "Confirm", transactionDigest: digest)
        XCTAssertEqual(token.transactionDigest, digest)
        XCTAssertEqual(stub.lastPrompt, "Confirm")
        XCTAssertEqual(stub.lastDigest, digest)
    }

    func test_stub_cancel_throwsUserCancelled() async {
        let stub = BiometricConfirmationStub()
        stub.nextResult = .cancel
        do {
            _ = try await stub.requestConfirmation(prompt: "x", transactionDigest: Data())
            XCTFail("expected throw")
        } catch let error as BiometricConfirmationError {
            XCTAssertEqual(error, .userCancelled)
        } catch {
            XCTFail("unexpected: \(error)")
        }
    }

    func test_stub_failure_throwsUnderlyingFailure() async {
        let stub = BiometricConfirmationStub()
        stub.nextResult = .failure("hardware busy")
        do {
            _ = try await stub.requestConfirmation(prompt: "x", transactionDigest: Data())
            XCTFail("expected throw")
        } catch let error as BiometricConfirmationError {
            XCTAssertEqual(error, .underlyingFailure("hardware busy"))
        } catch {
            XCTFail("unexpected: \(error)")
        }
    }

    // MARK: - Service against unlock stub

    func test_service_unlockSuccess_returnsToken() async throws {
        let unlock = BiometricUnlockStub()
        unlock.nextAuthResult = .success(true)
        let svc = BiometricConfirmationService(unlock: unlock)
        let digest = Data(repeating: 0x55, count: 32)
        let token = try await svc.requestConfirmation(prompt: "Pay", transactionDigest: digest)
        XCTAssertEqual(token.transactionDigest, digest)
        XCTAssertEqual(token.tokenData.count, 48)
    }

    func test_service_unlockReturnsFalse_throwsUserCancelled() async {
        let unlock = BiometricUnlockStub()
        unlock.nextAuthResult = .success(false)
        let svc = BiometricConfirmationService(unlock: unlock)
        do {
            _ = try await svc.requestConfirmation(prompt: "Pay", transactionDigest: Data())
            XCTFail("expected throw")
        } catch let error as BiometricConfirmationError {
            XCTAssertEqual(error, .userCancelled)
        } catch {
            XCTFail("unexpected: \(error)")
        }
    }

    func test_service_unlockThrows_propagatesAsUnderlying() async {
        struct LocalError: Error, LocalizedError { var errorDescription: String? { "kaboom" } }
        let unlock = BiometricUnlockStub()
        unlock.nextAuthResult = .failure(LocalError())
        let svc = BiometricConfirmationService(unlock: unlock)
        do {
            _ = try await svc.requestConfirmation(prompt: "Pay", transactionDigest: Data())
            XCTFail("expected throw")
        } catch BiometricConfirmationError.underlyingFailure(let msg) {
            XCTAssertEqual(msg, "kaboom")
        } catch {
            XCTFail("unexpected: \(error)")
        }
    }

    // MARK: - Digest helper

    func test_transactionDigest_isSHA256() {
        let payload = Data("acme:usd:room:39800".utf8)
        let d = Data.transactionDigest(of: payload)
        XCTAssertEqual(d.count, 32)
        let expected = Data(SHA256.hash(data: payload))
        XCTAssertEqual(d, expected)
    }
}
