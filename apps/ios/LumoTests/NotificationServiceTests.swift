import XCTest
@testable import Lumo

final class NotificationServiceTests: XCTestCase {

    // MARK: - FakeNotificationService

    func test_fake_currentAuthorizationStatus_defaultsToNotDetermined() async {
        let fake = FakeNotificationService()
        let status = await fake.currentAuthorizationStatus()
        XCTAssertEqual(status, .notDetermined)
    }

    func test_fake_requestAuthorization_simulatesGrantWhenNotDetermined() async throws {
        let fake = FakeNotificationService()
        let result = try await fake.requestAuthorization()
        XCTAssertEqual(result, .authorized)
    }

    func test_fake_requestAuthorization_returnsCurrentWhenAlreadyDecided() async throws {
        let fake = FakeNotificationService()
        fake.status = .denied
        let result = try await fake.requestAuthorization()
        XCTAssertEqual(result, .denied)
    }

    func test_fake_registerForRemoteNotifications_incrementsCallCount() {
        let fake = FakeNotificationService()
        fake.registerForRemoteNotifications()
        fake.registerForRemoteNotifications()
        XCTAssertEqual(fake.registerCallCount, 2)
    }

    func test_fake_submitDeviceToken_recordsBytes() async throws {
        let fake = FakeNotificationService()
        let token = Data(repeating: 0xAB, count: 32)
        let device = try await fake.submitDeviceToken(token)
        XCTAssertEqual(fake.submittedTokens, [token])
        XCTAssertEqual(device.id, "dev_fake_1")
        XCTAssertEqual(fake.lastSubmittedDevice?.id, "dev_fake_1")
    }

    func test_fake_unregisterCurrentDevice_clearsLastSubmittedDevice() async throws {
        let fake = FakeNotificationService()
        _ = try await fake.submitDeviceToken(Data(repeating: 0x01, count: 32))
        XCTAssertNotNil(fake.lastSubmittedDevice)
        try await fake.unregisterCurrentDevice()
        XCTAssertNil(fake.lastSubmittedDevice)
        XCTAssertEqual(fake.unregisteredDeviceIDs, ["dev_fake_1"])
    }

    func test_fake_registerCategories_increments() {
        let fake = FakeNotificationService()
        fake.registerCategories()
        XCTAssertEqual(fake.registerCategoriesCallCount, 1)
    }

    // MARK: - Real service against URLProtocol mock

    func test_service_submitDeviceToken_postsHexEncodedToken() async throws {
        let json = #"""
        {"device":{"id":"dev_test_xyz","apnsToken":"deadbeef","bundleId":"com.lumo.rentals.ios.dev","environment":"sandbox","registeredAt":"2026-04-30T12:00:00.000Z"}}
        """#
        let session = mockSession([
            .init(method: "POST", path: "/api/notifications/devices", status: 201, body: json),
        ])
        let svc = makeService(session: session)
        let token = Data([0xDE, 0xAD, 0xBE, 0xEF])
        let device = try await svc.submitDeviceToken(token)
        XCTAssertEqual(device.id, "dev_test_xyz")
        // Validate the wire body included a hex token.
        guard let recorded = NotifURLProtocolMock.recorded.first else {
            return XCTFail("no recorded request")
        }
        let body = String(data: recorded.bodyData ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("\"apnsToken\":\"deadbeef\""), "body=\(body)")
        XCTAssertTrue(body.contains("\"environment\":\"sandbox\""), "body=\(body)")
    }

    func test_service_unregisterCurrentDevice_throwsWhenNoStoredID() async {
        // Ensure the UserDefaults key is empty for this test.
        UserDefaults.standard.removeObject(forKey: "lumo.notifications.deviceID")
        let svc = makeService(session: mockSession([]))
        do {
            try await svc.unregisterCurrentDevice()
            XCTFail("expected throw")
        } catch let error as NotificationServiceError {
            XCTAssertEqual(error, .notRegistered)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func test_service_submitDeviceToken_badStatus_throws() async {
        let session = mockSession([
            .init(method: "POST", path: "/api/notifications/devices", status: 503, body: #"{"error":"db_unavailable"}"#),
        ])
        let svc = makeService(session: session)
        do {
            _ = try await svc.submitDeviceToken(Data([0x01, 0x02, 0x03, 0x04]))
            XCTFail("expected throw")
        } catch let error as NotificationServiceError {
            if case .badStatus(let code, _) = error {
                XCTAssertEqual(code, 503)
            } else {
                XCTFail("expected .badStatus, got \(error)")
            }
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - Helpers

    private func makeService(session: URLSession) -> NotificationService {
        NotificationService(
            baseURL: URL(string: "http://localhost:9999")!,
            userIDProvider: { "test-user" },
            environment: "sandbox",
            bundleID: "com.lumo.rentals.ios.dev",
            session: session
        )
    }

    private func mockSession(_ responses: [NotifURLProtocolMock.Stub]) -> URLSession {
        NotifURLProtocolMock.queue = responses
        NotifURLProtocolMock.recorded = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NotifURLProtocolMock.self]
        return URLSession(configuration: config)
    }
}

// MARK: - URLProtocol mock

final class NotifURLProtocolMock: URLProtocol {
    struct Stub {
        let method: String
        let path: String
        let status: Int
        let body: String
    }
    struct Recorded {
        let url: URL?
        let httpMethod: String?
        let bodyData: Data?
    }

    static var queue: [Stub] = []
    static var recorded: [Recorded] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let bodyData: Data? = {
            if let stream = request.httpBodyStream {
                stream.open()
                defer { stream.close() }
                var data = Data()
                let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
                defer { buffer.deallocate() }
                while stream.hasBytesAvailable {
                    let n = stream.read(buffer, maxLength: 1024)
                    if n <= 0 { break }
                    data.append(buffer, count: n)
                }
                return data
            }
            return request.httpBody
        }()
        Self.recorded.append(.init(
            url: request.url,
            httpMethod: request.httpMethod,
            bodyData: bodyData
        ))

        guard let stub = Self.matchAndConsume(for: request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(stub.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func matchAndConsume(for request: URLRequest) -> Stub? {
        guard let path = request.url?.path else { return nil }
        if let idx = queue.firstIndex(where: { $0.method == request.httpMethod && $0.path == path }) {
            return queue.remove(at: idx)
        }
        return nil
    }
}
