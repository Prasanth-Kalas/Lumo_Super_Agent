import AuthenticationServices
import CryptoKit
import Foundation

/// Bridges SwiftUI's `SignInWithAppleButton` result into the values
/// Supabase needs (`identityToken`, raw nonce). Apple returns a hashed
/// nonce in the JWT; Supabase verifies it against the raw nonce we
/// passed at request time. We have to keep the raw nonce around between
/// request and completion — `currentNonce` holds it.

struct AppleCredential: Equatable {
    let idTokenString: String
    let rawNonce: String
    let userID: String
    let email: String?
    let fullName: PersonNameComponents?
}

enum AppleSignInError: Error, LocalizedError {
    case missingIdentityToken
    case unexpectedCredentialType
    case userCancelled
    case other(String)

    var errorDescription: String? {
        switch self {
        case .missingIdentityToken:
            return "Apple did not return an identity token. Please try again."
        case .unexpectedCredentialType:
            return "Unexpected Apple credential type."
        case .userCancelled:
            return "Sign in cancelled."
        case .other(let detail):
            return detail
        }
    }
}

/// Generate a cryptographically-strong random nonce. Lifted from
/// Apple's "Sign in with Apple" sample code; the SHA-256 hash gets
/// passed in the request, the raw form gets sent to Supabase.
enum AppleNonce {
    static func random(length: Int = 32) -> String {
        precondition(length > 0)
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remaining = length
        while remaining > 0 {
            var randoms = [UInt8](repeating: 0, count: 16)
            let status = SecRandomCopyBytes(kSecRandomDefault, randoms.count, &randoms)
            if status != errSecSuccess {
                fatalError("Unable to generate nonce: \(status)")
            }
            for r in randoms {
                if remaining == 0 { break }
                if r < charset.count {
                    result.append(charset[Int(r) % charset.count])
                    remaining -= 1
                }
            }
        }
        return result
    }

    static func sha256(_ input: String) -> String {
        let inputData = Data(input.utf8)
        let hashed = SHA256.hash(data: inputData)
        return hashed.compactMap { String(format: "%02x", $0) }.joined()
    }
}

extension ASAuthorization {
    /// Extract the Lumo-relevant fields plus rebind the raw nonce that
    /// was generated alongside the request.
    func toAppleCredential(rawNonce: String) throws -> AppleCredential {
        guard let credential = credential as? ASAuthorizationAppleIDCredential else {
            throw AppleSignInError.unexpectedCredentialType
        }
        guard let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            throw AppleSignInError.missingIdentityToken
        }
        return AppleCredential(
            idTokenString: token,
            rawNonce: rawNonce,
            userID: credential.user,
            email: credential.email,
            fullName: credential.fullName
        )
    }
}
