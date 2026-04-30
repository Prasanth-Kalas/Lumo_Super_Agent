import XCTest
@testable import Lumo

/// AUTH-OAUTH-1b — GoogleSignInService pure helpers.
///
/// The presentation path (ASWebAuthenticationSession) needs a real
/// scene anchor and isn't unit-testable on the simulator without UI.
/// What IS testable — and what regressions are most likely to break —
/// are the URL builder and the callback parsers.
@MainActor
final class GoogleSignInTests: XCTestCase {

    private let supabaseURL = URL(string: "https://ohtjjusrwxmdvzkuhaxn.supabase.co")!

    // MARK: - authorizeURL

    func test_authorizeURL_pointsAtSupabaseAuthorizeEndpoint() {
        let svc = GoogleSignInService()
        let url = svc.authorizeURL(supabaseURL: supabaseURL)
        XCTAssertEqual(url.host, "ohtjjusrwxmdvzkuhaxn.supabase.co")
        XCTAssertEqual(url.path, "/auth/v1/authorize")
    }

    func test_authorizeURL_carriesProviderGoogleQueryItem() {
        let svc = GoogleSignInService()
        let url = svc.authorizeURL(supabaseURL: supabaseURL)
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let provider = comps.queryItems?.first(where: { $0.name == "provider" })?.value
        XCTAssertEqual(provider, "google")
    }

    func test_authorizeURL_redirectToUsesLumoCallbackScheme() {
        let svc = GoogleSignInService()
        let url = svc.authorizeURL(supabaseURL: supabaseURL)
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let redirectTo = comps.queryItems?.first(where: { $0.name == "redirect_to" })?.value
        XCTAssertEqual(redirectTo, "lumo://auth/callback")
    }

    func test_callbackScheme_constantIsLumo() {
        // The Info.plist URL-scheme registration and the redirect_to
        // value must agree. Lock the constant so a future refactor
        // doesn't drift one without the other.
        XCTAssertEqual(GoogleSignInService.callbackScheme, "lumo")
        XCTAssertEqual(GoogleSignInService.callbackHostPath, "auth/callback")
    }

    // MARK: - extractAuthCode

    func test_extractAuthCode_pullsCodeQueryItem() {
        let url = URL(string: "lumo://auth/callback?code=abc123")!
        XCTAssertEqual(GoogleSignInService.extractAuthCode(from: url), "abc123")
    }

    func test_extractAuthCode_handlesMultipleQueryItems() {
        let url = URL(string: "lumo://auth/callback?state=xyz&code=abc&extra=qq")!
        XCTAssertEqual(GoogleSignInService.extractAuthCode(from: url), "abc")
    }

    func test_extractAuthCode_returnsNilWhenMissing() {
        let url = URL(string: "lumo://auth/callback?error=access_denied")!
        XCTAssertNil(GoogleSignInService.extractAuthCode(from: url))
    }

    func test_extractAuthCode_returnsNilForMalformedURL() {
        let url = URL(string: "lumo://auth/callback")!
        XCTAssertNil(GoogleSignInService.extractAuthCode(from: url))
    }

    // MARK: - extractError

    func test_extractError_prefersDescription() {
        let url = URL(string: "lumo://auth/callback?error=access_denied&error_description=user%20declined")!
        XCTAssertEqual(GoogleSignInService.extractError(from: url), "user declined")
    }

    func test_extractError_fallsBackToShortError() {
        let url = URL(string: "lumo://auth/callback?error=access_denied")!
        XCTAssertEqual(GoogleSignInService.extractError(from: url), "access_denied")
    }

    func test_extractError_returnsNilOnHappyPath() {
        let url = URL(string: "lumo://auth/callback?code=abc")!
        XCTAssertNil(GoogleSignInService.extractError(from: url))
    }

    // MARK: - FakeGoogleSignInService

    func test_fake_recordsPresentCallCount() async throws {
        let fake = FakeGoogleSignInService()
        fake.nextCallback = .success(URL(string: "lumo://auth/callback?code=abc")!)
        let url = fake.authorizeURL(supabaseURL: supabaseURL)
        _ = try await fake.presentAuthSession(authorizeURL: url)
        XCTAssertEqual(fake.presentCallCount, 1)
    }

    func test_fake_propagatesUserCancelledError() async {
        let fake = FakeGoogleSignInService()
        fake.nextCallback = .failure(GoogleSignInError.userCancelled)
        do {
            _ = try await fake.presentAuthSession(authorizeURL: supabaseURL)
            XCTFail("expected throw")
        } catch let err as GoogleSignInError {
            XCTAssertEqual(err.localizedDescription, "Sign in cancelled.")
        } catch {
            XCTFail("unexpected error type: \(error)")
        }
    }

    // MARK: - AuthService.signInWithGoogle — fail-closed when not configured

    func test_authService_throwsNotConfigured_whenSupabaseEnvMissing() async {
        let unconfigured = AppConfig(
            apiBaseURL: URL(string: "http://localhost:3000")!,
            supabaseURL: nil,
            supabaseAnonKey: "",
            elevenLabsAPIKey: "",
            elevenLabsVoiceID: "",
            stripePublishableKey: "",
            stripeMerchantID: "",
            apnsUseSandbox: true
        )
        let auth = AuthService(
            config: unconfigured,
            biometric: BiometricUnlockServiceStub(available: false),
            isBiometricGateEnabled: { false },
            google: FakeGoogleSignInService()
        )
        do {
            try await auth.signInWithGoogle()
            XCTFail("expected throw")
        } catch AuthServiceError.notConfigured {
            // ok
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

/// Tiny stand-in for BiometricUnlockServicing so AuthService can be
/// constructed in unit tests without a real LAContext.
private final class BiometricUnlockServiceStub: BiometricUnlockServicing {
    let available: Bool
    init(available: Bool) { self.available = available }
    func isBiometryAvailable() -> Bool { available }
    func biometryKind() -> BiometryKind { .none }
    func authenticate(reason: String) async throws -> Bool { false }
}
