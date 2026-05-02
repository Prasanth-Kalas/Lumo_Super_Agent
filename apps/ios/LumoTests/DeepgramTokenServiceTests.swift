import XCTest
@testable import Lumo

/// DEEPGRAM-IOS-IMPL-1 Phase 1 — DeepgramTokenService contract tests.
///
/// Five slices:
///   1. Mint — POST `/api/audio/deepgram-token` decodes
///      `{ token, expires_at }` and caches.
///   2. Cache reuse — second `currentToken()` within the freshness
///      window does NOT hit the network.
///   3. Refresh-ahead — calling `currentToken()` near expiry mints
///      a new one. Refresh policy is 50s elapsed for 60s TTL =
///      10s lead-time.
///   4. Stream-active gating — when `markStreamActive(true)` is
///      set, refresh-ahead suppresses itself; only fully-expired
///      tokens trigger a mint. Mirrors the RISK 2 answer.
///   5. Errors — 401 / 403 / 429 / 502 / 503 each map to typed
///      DeepgramTokenError cases.
@MainActor
final class DeepgramTokenServiceTests: XCTestCase {

    private let baseURL = URL(string: "https://lumo.test")!

    private func okResult(token: String, expiresAt: Date) -> (Data, URLResponse) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let body: [String: Any] = [
            "token": token,
            "expires_at": iso.string(from: expiresAt),
        ]
        let data = try! JSONSerialization.data(withJSONObject: body)
        let resp = HTTPURLResponse(
            url: baseURL.appendingPathComponent("api/audio/deepgram-token"),
            statusCode: 200, httpVersion: nil, headerFields: nil
        )!
        return (data, resp)
    }

    private func errorResult(status: Int, body: [String: Any] = [:],
                             headers: [String: String] = [:]) -> (Data, URLResponse) {
        let data = try! JSONSerialization.data(withJSONObject: body)
        let resp = HTTPURLResponse(
            url: baseURL.appendingPathComponent("api/audio/deepgram-token"),
            statusCode: status, httpVersion: nil, headerFields: headers
        )!
        return (data, resp)
    }

    // MARK: - 1. Mint

    func test_mint_decodesTokenAndCaches() async throws {
        let session = FakeURLSession()
        let expiresAt = Date().addingTimeInterval(60)
        session.nextResults = [okResult(token: "tok-1", expiresAt: expiresAt)]

        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        let token = try await svc.currentToken()

        XCTAssertEqual(token, "tok-1")
        XCTAssertEqual(session.requests.count, 1)
        XCTAssertEqual(session.requests.first?.httpMethod, "POST")
        XCTAssertEqual(session.requests.first?.url?.path, "/api/audio/deepgram-token")
    }

    // MARK: - 2. Cache reuse

    func test_cacheReuse_secondCallWithinWindow_skipsNetwork() async throws {
        let session = FakeURLSession()
        // 60s expiry, well beyond the 10s lead. Second call must reuse.
        session.nextResults = [okResult(token: "tok-1", expiresAt: Date().addingTimeInterval(60))]

        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        _ = try await svc.currentToken()
        let second = try await svc.currentToken()

        XCTAssertEqual(second, "tok-1")
        XCTAssertEqual(session.requests.count, 1, "second call should reuse cached token")
    }

    // MARK: - 3. Refresh-ahead

    func test_refreshAhead_mintsNewWhenWithinLeadWindow() async throws {
        let session = FakeURLSession()
        // First mint expires in 5 seconds — well inside the 10s
        // lead-time, so the very next call must mint again.
        session.nextResults = [
            okResult(token: "tok-old", expiresAt: Date().addingTimeInterval(5)),
            okResult(token: "tok-new", expiresAt: Date().addingTimeInterval(60)),
        ]

        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        _ = try await svc.currentToken()
        let second = try await svc.currentToken()

        XCTAssertEqual(second, "tok-new", "refresh-ahead must mint a new token within the lead window")
        XCTAssertEqual(session.requests.count, 2)
    }

    func test_invalidate_forcesNextCallToMint() async throws {
        let session = FakeURLSession()
        session.nextResults = [
            okResult(token: "tok-1", expiresAt: Date().addingTimeInterval(60)),
            okResult(token: "tok-2", expiresAt: Date().addingTimeInterval(60)),
        ]

        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        _ = try await svc.currentToken()
        svc.invalidate()
        let after = try await svc.currentToken()

        XCTAssertEqual(after, "tok-2", "invalidate() must force re-mint on next call")
        XCTAssertEqual(session.requests.count, 2)
    }

    // MARK: - 4. Stream-active gating (RISK 2)

    func test_streamActive_suppressesRefreshAhead_butAllowsExpiredMint() {
        let svc = DeepgramTokenService(baseURL: baseURL, session: FakeURLSession())
        let now = Date()

        // Idle state: 5s remaining is INSIDE the 10s lead window →
        // refresh-ahead fires.
        svc.markStreamActive(false)
        XCTAssertTrue(svc.needsRefresh(expiresAt: now.addingTimeInterval(5), now: now))

        // Stream active: 5s remaining must NOT trigger refresh
        // (the rule "refresh only at idle"). Fully-expired token
        // (now >= expiresAt) still triggers because there's no
        // valid token to use.
        svc.markStreamActive(true)
        XCTAssertFalse(svc.needsRefresh(expiresAt: now.addingTimeInterval(5), now: now),
                       "stream-active must suppress refresh-ahead at 5s remaining")
        XCTAssertTrue(svc.needsRefresh(expiresAt: now.addingTimeInterval(-1), now: now),
                      "fully-expired token must still mint even when stream-active (no valid token to use)")

        // Idle again: 30s remaining is OUTSIDE the lead window —
        // never refresh.
        svc.markStreamActive(false)
        XCTAssertFalse(svc.needsRefresh(expiresAt: now.addingTimeInterval(30), now: now))
    }

    // MARK: - 5. Errors map to typed cases

    func test_401_mapsTo_notAuthenticated() async {
        let session = FakeURLSession()
        session.nextResults = [errorResult(status: 401, body: ["error": "not_authenticated"])]
        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        do {
            _ = try await svc.currentToken()
            XCTFail("expected 401 throw")
        } catch let e as DeepgramTokenError {
            XCTAssertEqual(e, .notAuthenticated)
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    func test_403_mapsTo_forbidden() async {
        let session = FakeURLSession()
        session.nextResults = [errorResult(status: 403, body: ["error": "forbidden"])]
        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        do {
            _ = try await svc.currentToken()
            XCTFail("expected 403 throw")
        } catch let e as DeepgramTokenError {
            XCTAssertEqual(e, .forbidden)
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    func test_429_mapsTo_rateLimited_withRetryAfter_fromHeader() async {
        let session = FakeURLSession()
        session.nextResults = [errorResult(
            status: 429,
            body: ["error": "rate_limited"],
            headers: ["Retry-After": "42"]
        )]
        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        do {
            _ = try await svc.currentToken()
            XCTFail("expected 429 throw")
        } catch let e as DeepgramTokenError {
            XCTAssertEqual(e, .rateLimited(retryAfter: 42))
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    func test_429_mapsTo_rateLimited_withRetryAfter_fromBody() async {
        let session = FakeURLSession()
        session.nextResults = [errorResult(
            status: 429,
            body: ["error": "rate_limited", "retry_after_seconds": 30]
        )]
        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        do {
            _ = try await svc.currentToken()
            XCTFail("expected 429 throw")
        } catch let e as DeepgramTokenError {
            XCTAssertEqual(e, .rateLimited(retryAfter: 30))
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    func test_502_mapsTo_deepgramMintFailed() async {
        let session = FakeURLSession()
        session.nextResults = [errorResult(status: 502, body: ["error": "deepgram_token_error"])]
        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        do {
            _ = try await svc.currentToken()
            XCTFail("expected 502 throw")
        } catch let e as DeepgramTokenError {
            XCTAssertEqual(e, .deepgramMintFailed)
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    func test_503_mapsTo_deepgramNotConfigured() async {
        let session = FakeURLSession()
        session.nextResults = [errorResult(status: 503, body: ["error": "deepgram_not_configured"])]
        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        do {
            _ = try await svc.currentToken()
            XCTFail("expected 503 throw")
        } catch let e as DeepgramTokenError {
            XCTAssertEqual(e, .deepgramNotConfigured)
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }

    func test_transportError_mapsTo_transport() async {
        let session = FakeURLSession()
        session.nextErrors = [URLError(.notConnectedToInternet)]
        let svc = DeepgramTokenService(baseURL: baseURL, session: session)
        do {
            _ = try await svc.currentToken()
            XCTFail("expected transport throw")
        } catch let e as DeepgramTokenError {
            if case .transport = e { /* ok */ } else {
                XCTFail("expected .transport; got \(e)")
            }
        } catch {
            XCTFail("wrong error type: \(error)")
        }
    }
}
