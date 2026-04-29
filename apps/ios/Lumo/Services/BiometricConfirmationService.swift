import CryptoKit
import Foundation

/// Per-transaction biometric-confirmed signing.
///
/// Where `BiometricUnlockService` gates app entry on cold launch, this
/// service gates a single-use *transaction* confirmation. The user
/// performs Face ID / Touch ID against a prompt that names the
/// transaction (e.g. "Confirm payment of $42.18 to Acme Hotel"); on
/// success we produce a `SignedConfirmationToken` that travels to
/// `/api/payments/confirm-transaction` alongside the transaction
/// digest. The backend uses the (token, digest) pair to verify the
/// user authorized this exact payload.
///
/// In MOBILE-PAYMENTS-1 the token is HMAC-SHA256(digest || nonce, k)
/// where `k` is a fresh per-confirmation symmetric key. This is enough
/// to satisfy the stub backend's "well-formed token" check and mirror
/// the eventual real shape, but it is *not* a real device-bound
/// signature. MERCHANT-1 replaces this with a Secure Enclave
/// ECDSA-P256 keypair where the public key is registered server-side
/// at first sign-in and signatures are verified against it.

struct SignedConfirmationToken: Equatable {
    /// Opaque bytes — HMAC-SHA256 || nonce in v1; ECDSA signature in
    /// MERCHANT-1.
    let tokenData: Data
    /// The exact digest that was authorized. Sent alongside so the
    /// backend can re-derive what the user saw.
    let transactionDigest: Data
    let signedAt: Date

    /// Base64 encoding for HTTP transport. The backend's
    /// `confirm-transaction` route accepts any base64 of length ≥ 16.
    var base64: String { tokenData.base64EncodedString() }
}

enum BiometricConfirmationError: Error, LocalizedError, Equatable {
    case userCancelled
    case underlyingFailure(String)

    var errorDescription: String? {
        switch self {
        case .userCancelled:
            return "Confirmation cancelled."
        case .underlyingFailure(let message):
            return message
        }
    }
}

protocol BiometricConfirmationServicing {
    /// Run the biometric prompt with the given user-visible reason and,
    /// on success, produce a signed token bound to `transactionDigest`.
    /// Throws `BiometricConfirmationError.userCancelled` if the user
    /// cancels the prompt.
    func requestConfirmation(
        prompt: String,
        transactionDigest: Data
    ) async throws -> SignedConfirmationToken
}

final class BiometricConfirmationService: BiometricConfirmationServicing {
    private let unlock: BiometricUnlockServicing

    init(unlock: BiometricUnlockServicing) {
        self.unlock = unlock
    }

    convenience init() {
        self.init(unlock: BiometricUnlockService())
    }

    func requestConfirmation(
        prompt: String,
        transactionDigest: Data
    ) async throws -> SignedConfirmationToken {
        let success: Bool
        do {
            success = try await unlock.authenticate(reason: prompt)
        } catch {
            throw BiometricConfirmationError.underlyingFailure(
                error.localizedDescription
            )
        }
        guard success else {
            throw BiometricConfirmationError.userCancelled
        }
        return Self.makeToken(transactionDigest: transactionDigest)
    }

    /// Produce a token shape that satisfies the backend stub's
    /// well-formedness check. Pure function — extracted so tests can
    /// validate the encoding without touching biometrics.
    static func makeToken(transactionDigest: Data) -> SignedConfirmationToken {
        let nonce = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let key = SymmetricKey(size: .bits256)
        var hmac = HMAC<SHA256>(key: key)
        hmac.update(data: transactionDigest)
        hmac.update(data: nonce)
        let mac = Data(hmac.finalize())
        return SignedConfirmationToken(
            tokenData: mac + nonce,
            transactionDigest: transactionDigest,
            signedAt: Date()
        )
    }
}

/// Test fake — drives the confirmation flow without LAContext. Returns
/// a deterministic well-formed token by default; a `nextResult` knob
/// lets tests force success / cancellation / underlying failure.
final class BiometricConfirmationStub: BiometricConfirmationServicing {
    enum NextResult {
        case success
        case cancel
        case failure(String)
    }

    var nextResult: NextResult = .success
    /// Token bytes returned on success. Defaults to a recognizable
    /// 32-byte pattern so test assertions stay readable.
    var tokenBytes: Data = Data(repeating: 0xAB, count: 32)
    private(set) var lastPrompt: String?
    private(set) var lastDigest: Data?

    func requestConfirmation(
        prompt: String,
        transactionDigest: Data
    ) async throws -> SignedConfirmationToken {
        lastPrompt = prompt
        lastDigest = transactionDigest
        switch nextResult {
        case .success:
            return SignedConfirmationToken(
                tokenData: tokenBytes,
                transactionDigest: transactionDigest,
                signedAt: Date()
            )
        case .cancel:
            throw BiometricConfirmationError.userCancelled
        case .failure(let message):
            throw BiometricConfirmationError.underlyingFailure(message)
        }
    }
}

// MARK: - Digest helper

extension Data {
    /// SHA-256 of arbitrary bytes — the canonical transaction digest
    /// shape used across the confirmation surface.
    static func transactionDigest(of payload: Data) -> Data {
        Data(SHA256.hash(data: payload))
    }
}
