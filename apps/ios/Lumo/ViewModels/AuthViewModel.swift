import AuthenticationServices
import Foundation
import SwiftUI

/// Drives the AuthView. Holds the in-flight nonce that needs to round-
/// trip from the Apple request to the Apple completion (so we can hand
/// the raw nonce to Supabase).

@MainActor
final class AuthViewModel: ObservableObject {
    @Published private(set) var state: AuthState = .signedOut
    @Published private(set) var error: String?

    private let auth: AuthServicing
    /// The raw nonce captured at request time. The hashed form goes
    /// into the Apple request; the raw form goes into Supabase's
    /// `signInWithIdToken` call.
    private var pendingNonce: String?

    init(auth: AuthServicing) {
        self.auth = auth
        self.state = auth.state
        Task { await observe() }
    }

    private func observe() async {
        for await next in auth.stateChange {
            self.state = next
        }
    }

    /// Returns the SHA-256-hashed nonce that the SignInWithAppleButton
    /// configuration should pass through to ASAuthorization. The raw
    /// form is captured internally for the completion step.
    func makeAppleNonce() -> String {
        let raw = AppleNonce.random()
        pendingNonce = raw
        return AppleNonce.sha256(raw)
    }

    func handleAppleCompletion(result: Result<ASAuthorization, Error>) {
        Task { await handleAppleCompletionAsync(result: result) }
    }

    private func handleAppleCompletionAsync(result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let error):
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        case .success(let authorization):
            guard let raw = pendingNonce else {
                self.error = "Apple sign-in completed without a request nonce."
                return
            }
            pendingNonce = nil
            do {
                let credential = try authorization.toAppleCredential(rawNonce: raw)
                try await auth.signInWithApple(credential)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    func clearError() { error = nil }

    func devSignIn() {
        Task { await auth.devSignIn() }
    }
}
