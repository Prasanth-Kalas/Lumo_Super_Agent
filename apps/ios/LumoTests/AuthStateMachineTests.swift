import XCTest
@testable import Lumo

/// Drives the auth state machine through its three primary paths
/// (fresh sign-in, restore-with-biometric, sign-out) using a
/// scripted fake `AuthServicing` so the real Supabase round-trip
/// stays out of the test target.
///
/// The tests are written against a `FakeAuthService` that mirrors the
/// public surface of the real `AuthService` and produces the same
/// state transitions, so this suite exercises the *transition rules*
/// rather than the Supabase wire format. The real AuthService delegates
/// transitions to the same enum values; if the fake and real diverge,
/// integration tests at the chat-stream level would catch it.

@MainActor
final class AuthStateMachineTests: XCTestCase {

    func test_initialState_isSignedOut() {
        let auth = FakeAuthService()
        XCTAssertEqual(auth.state, .signedOut)
        XCTAssertFalse(auth.state.isAuthenticated)
    }

    func test_signInWithApple_success_transitionsToSignedIn() async throws {
        let auth = FakeAuthService()
        let creds = AppleCredential(
            idTokenString: "id-token",
            rawNonce: "nonce",
            userID: "apple-user-1",
            email: "test@example.com",
            fullName: nil
        )
        try await auth.signInWithApple(creds)

        guard case .signedIn(let user) = auth.state else {
            XCTFail("expected signedIn after Apple success; got \(auth.state)")
            return
        }
        XCTAssertEqual(user.email, "test@example.com")
        XCTAssertTrue(auth.state.isAuthenticated)
    }

    func test_signInWithApple_failure_returnsToSignedOut() async {
        let auth = FakeAuthService()
        auth.nextSignInError = AuthServiceError.notConfigured
        let creds = AppleCredential(idTokenString: "x", rawNonce: "x", userID: "x", email: nil, fullName: nil)
        do {
            try await auth.signInWithApple(creds)
            XCTFail("expected throw")
        } catch {
            // expected
        }
        XCTAssertEqual(auth.state, .signedOut)
    }

    func test_signInWithApple_progressesThroughSigningIn() async throws {
        let auth = FakeAuthService()
        var observed: [AuthState] = []
        let task = Task {
            for await s in auth.stateChange {
                observed.append(s)
                if observed.count >= 2 { break }
            }
        }

        let creds = AppleCredential(idTokenString: "x", rawNonce: "x", userID: "x", email: "a@b.c", fullName: nil)
        try await auth.signInWithApple(creds)
        await task.value
        // The fake yields signingIn synchronously then signedIn on success.
        XCTAssertEqual(observed.first, .signingIn)
        if case .signedIn = observed.last { /* ok */ } else {
            XCTFail("expected signedIn at end; got \(String(describing: observed.last))")
        }
    }

    func test_restoreSession_withBiometricEnabled_transitionsToNeedsBiometric() async {
        let auth = FakeAuthService()
        auth.scriptedRestore = .needsBiometric(LumoUser(id: "u", email: "a@b.c", displayName: nil))
        await auth.restoreSession()
        guard case .needsBiometric(let user) = auth.state else {
            XCTFail("expected needsBiometric; got \(auth.state)")
            return
        }
        XCTAssertEqual(user.id, "u")
        XCTAssertFalse(auth.state.isAuthenticated)
    }

    func test_restoreSession_withBiometricDisabled_transitionsDirectlyToSignedIn() async {
        let auth = FakeAuthService()
        auth.scriptedRestore = .signedIn(LumoUser(id: "u", email: "a@b.c", displayName: nil))
        await auth.restoreSession()
        XCTAssertTrue(auth.state.isAuthenticated)
    }

    func test_restoreSession_noStoredSession_transitionsToSignedOut() async {
        let auth = FakeAuthService()
        auth.scriptedRestore = .signedOut
        await auth.restoreSession()
        XCTAssertEqual(auth.state, .signedOut)
    }

    func test_unlockWithBiometric_success_completesSession() async throws {
        let auth = FakeAuthService()
        let user = LumoUser(id: "u", email: "a@b.c", displayName: nil)
        auth.state = .needsBiometric(user)
        auth.nextBiometricResult = .success(true)

        try await auth.unlockWithBiometric()
        XCTAssertEqual(auth.state, .signedIn(user))
    }

    func test_unlockWithBiometric_userCancel_keepsLocked() async throws {
        let auth = FakeAuthService()
        let user = LumoUser(id: "u", email: "a@b.c", displayName: nil)
        auth.state = .needsBiometric(user)
        auth.nextBiometricResult = .success(false)

        try await auth.unlockWithBiometric()
        // Stays locked — user can retry.
        XCTAssertEqual(auth.state, .needsBiometric(user))
    }

    func test_unlockWithBiometric_whenSignedOut_isNoOp() async throws {
        let auth = FakeAuthService()
        // Default state is signedOut.
        try await auth.unlockWithBiometric()
        XCTAssertEqual(auth.state, .signedOut)
    }

    func test_signOut_clearsState() async throws {
        let auth = FakeAuthService()
        let creds = AppleCredential(idTokenString: "x", rawNonce: "x", userID: "x", email: "a@b.c", fullName: nil)
        try await auth.signInWithApple(creds)
        XCTAssertTrue(auth.state.isAuthenticated)

        await auth.signOut()
        XCTAssertEqual(auth.state, .signedOut)
    }

    func test_devSignIn_inDebugBuilds_synthesisesSession() async {
        let auth = FakeAuthService()
        await auth.devSignIn()
        XCTAssertTrue(auth.state.isAuthenticated)
    }

    func test_lumoUser_nameOrEmailPrefix_fallsBackThroughChain() {
        XCTAssertEqual(LumoUser(id: "x", email: "alice@b.c", displayName: "Alice").nameOrEmailPrefix, "Alice")
        XCTAssertEqual(LumoUser(id: "x", email: "alice@b.c", displayName: nil).nameOrEmailPrefix, "alice")
        XCTAssertEqual(LumoUser(id: "x", email: nil, displayName: "").nameOrEmailPrefix, "Lumo user")
    }
}

// MARK: - Fake AuthService

/// Mirrors AuthServicing without the SupabaseClient round-trip. Uses
/// scripted next-results so each test can deterministically drive the
/// state machine.
@MainActor
final class FakeAuthService: AuthServicing {
    var state: AuthState = .signedOut {
        didSet {
            if oldValue != state { stateContinuation?.yield(state) }
        }
    }

    let stateChange: AsyncStream<AuthState>
    private var stateContinuation: AsyncStream<AuthState>.Continuation?

    var scriptedRestore: AuthState = .signedOut
    var nextSignInError: Error?
    var nextGoogleSignInError: Error?
    var nextGoogleSignInUser: LumoUser = LumoUser(id: "google-fake", email: "alex@example.com", displayName: "Alex")
    var nextBiometricResult: Result<Bool, Error> = .success(true)

    init() {
        var c: AsyncStream<AuthState>.Continuation!
        self.stateChange = AsyncStream { c = $0 }
        self.stateContinuation = c
    }

    var scriptedAccessToken: String?
    func currentAccessToken() -> String? { scriptedAccessToken }

    func restoreSession() async {
        state = scriptedRestore
    }

    func signInWithApple(_ credential: AppleCredential) async throws {
        state = .signingIn
        if let error = nextSignInError {
            state = .signedOut
            throw error
        }
        let user = LumoUser(id: credential.userID, email: credential.email, displayName: nil)
        state = .signedIn(user)
    }

    func signInWithGoogle() async throws {
        state = .signingIn
        if let error = nextGoogleSignInError {
            state = .signedOut
            throw error
        }
        state = .signedIn(nextGoogleSignInUser)
    }

    func unlockWithBiometric() async throws {
        guard case .needsBiometric(let user) = state else { return }
        switch nextBiometricResult {
        case .success(let unlocked):
            if unlocked { state = .signedIn(user) }
        case .failure(let error):
            throw error
        }
    }

    func signOut() async {
        state = .signedOut
    }

    func devSignIn() async {
        state = .signedIn(LumoUser(id: "dev", email: "dev@lumo.local", displayName: "Dev User"))
    }
}
