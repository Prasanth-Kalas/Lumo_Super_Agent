import AuthenticationServices
import Foundation
import UIKit

/// Drives the Google sign-in OAuth flow on iOS via Supabase's web
/// /authorize endpoint and ASWebAuthenticationSession. Avoids pulling
/// in the GoogleSignIn SDK — the brief explicitly wants the bundle
/// kept clean, and the entire flow is six lines of Apple SDK code.
///
/// Flow:
///   1. Build the Supabase OAuth authorize URL for `provider=google`,
///      with `redirect_to=lumo://auth/callback`.
///   2. Present an ASWebAuthenticationSession bound to the `lumo`
///      callback scheme — iOS draws an in-app Safari sheet, the user
///      signs in to Google, Google → Supabase → 302 to lumo://auth/callback?code=…
///   3. Pull the `code` query item out of the callback URL.
///   4. AuthService calls `client.auth.exchangeCodeForSession` to mint
///      the session and updates state. Token persistence is owned by
///      KeychainStorage (same path as Apple Sign-In).
///
/// `prefersEphemeralWebBrowserSession` is left at the system default
/// (false) so users who are already signed in to Google in Safari
/// don't have to re-enter credentials. The trade-off is that signing
/// out of Lumo doesn't sign them out of Google in Safari — which is
/// the correct behavior; we don't own their Google session.
protocol GoogleSignInServicing: AnyObject {
    /// Pure helper — builds the Supabase OAuth /authorize URL for
    /// Google. Tested directly without spinning up the web session.
    nonisolated func authorizeURL(supabaseURL: URL) -> URL

    /// Presents the auth session and returns the callback URL on
    /// success. Throws on user cancel, system error, or no callback.
    func presentAuthSession(authorizeURL: URL) async throws -> URL
}

@MainActor
final class GoogleSignInService: NSObject, GoogleSignInServicing,
    ASWebAuthenticationPresentationContextProviding
{
    /// Custom URL scheme registered in Info.plist (CFBundleURLTypes).
    /// Must match the `redirect_to` query param passed to Supabase.
    nonisolated static let callbackScheme = "lumo"
    nonisolated static let callbackHostPath = "auth/callback"

    nonisolated func authorizeURL(supabaseURL: URL) -> URL {
        var components = URLComponents(
            url: supabaseURL.appendingPathComponent("auth/v1/authorize"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "provider", value: "google"),
            URLQueryItem(
                name: "redirect_to",
                value: "\(Self.callbackScheme)://\(Self.callbackHostPath)"
            ),
        ]
        return components.url!
    }

    func presentAuthSession(authorizeURL: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizeURL,
                callbackURLScheme: Self.callbackScheme
            ) { callback, error in
                if let error {
                    if let asError = error as? ASWebAuthenticationSessionError,
                       asError.code == .canceledLogin
                    {
                        continuation.resume(throwing: GoogleSignInError.userCancelled)
                    } else {
                        continuation.resume(throwing: error)
                    }
                    return
                }
                guard let callback else {
                    continuation.resume(throwing: GoogleSignInError.missingCallback)
                    return
                }
                continuation.resume(returning: callback)
            }
            session.presentationContextProvider = self
            session.start()
        }
    }

    /// Pure helper — extracts the OAuth `code` query item from a
    /// callback URL. Returns nil if the URL is malformed or doesn't
    /// carry a code (e.g. provider returned an error).
    nonisolated static func extractAuthCode(from url: URL) -> String? {
        guard
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let items = comps.queryItems
        else {
            return nil
        }
        return items.first(where: { $0.name == "code" })?.value
    }

    /// Pure helper — extracts an OAuth `error` query item from a
    /// callback URL. Used to surface provider-side errors to the user
    /// (e.g. "access_denied", "invalid_client").
    nonisolated static func extractError(from url: URL) -> String? {
        guard
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let items = comps.queryItems
        else {
            return nil
        }
        if let desc = items.first(where: { $0.name == "error_description" })?.value {
            return desc
        }
        return items.first(where: { $0.name == "error" })?.value
    }

    // MARK: - ASWebAuthenticationPresentationContextProviding

    func presentationAnchor(
        for session: ASWebAuthenticationSession
    ) -> ASPresentationAnchor {
        // Resolve the foreground key window so the auth sheet renders
        // anchored to the active scene, even on iPad with multiple
        // windows.
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        if let key = scene?.windows.first(where: { $0.isKeyWindow }) {
            return key
        }
        return scene?.windows.first ?? ASPresentationAnchor()
    }
}

enum GoogleSignInError: Error, LocalizedError {
    case missingCallback
    case missingAuthCode
    case userCancelled
    case provider(String)

    var errorDescription: String? {
        switch self {
        case .missingCallback:
            return "Google sign-in returned no callback URL."
        case .missingAuthCode:
            return "Google sign-in callback was missing the authorization code."
        case .userCancelled:
            return "Sign in cancelled."
        case .provider(let detail):
            return detail
        }
    }
}

#if DEBUG
/// Test stub — pre-canned responses without a real ASWebAuthenticationSession.
final class FakeGoogleSignInService: GoogleSignInServicing {
    var nextCallback: Result<URL, Error> = .failure(GoogleSignInError.missingCallback)
    private(set) var presentCallCount = 0

    nonisolated func authorizeURL(supabaseURL: URL) -> URL {
        // Mirror the real shape so tests can assert against the same
        // builder when wiring AuthService.
        var components = URLComponents(
            url: supabaseURL.appendingPathComponent("auth/v1/authorize"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "provider", value: "google"),
            URLQueryItem(name: "redirect_to", value: "lumo://auth/callback"),
        ]
        return components.url!
    }

    func presentAuthSession(authorizeURL: URL) async throws -> URL {
        presentCallCount += 1
        switch nextCallback {
        case .success(let url): return url
        case .failure(let err): throw err
        }
    }
}
#endif
