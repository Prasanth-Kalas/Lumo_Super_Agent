import XCTest
@testable import Lumo

final class ChatServiceTests: XCTestCase {

    // MARK: - parseFrame

    func test_parseFrame_textEvent_returnsTextEvent() {
        let line = #"data: {"type":"text","value":"hello"}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .text("hello"))
    }

    func test_parseFrame_textWithEmptyValue_returnsEmptyTextEvent() {
        let line = #"data: {"type":"text","value":""}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .text(""))
    }

    func test_parseFrame_doneEvent_returnsDone() {
        let line = #"data: {"type":"done"}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .done)
    }

    func test_parseFrame_errorEvent_unwrapsServerMessage() {
        let line = #"data: {"type":"error","value":{"message":"rate limited"}}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .error("rate limited"))
    }

    func test_parseFrame_unknownType_isNotFatal() {
        let line = #"data: {"type":"summary","value":{"foo":"bar"}}"#
        XCTAssertEqual(ChatService.parseFrame(line: line), .other(type: "summary"))
    }

    func test_parseFrame_ignoresBlankLines() {
        XCTAssertNil(ChatService.parseFrame(line: ""))
    }

    func test_parseFrame_ignoresCommentLines() {
        XCTAssertNil(ChatService.parseFrame(line: ": keepalive"))
    }

    func test_parseFrame_ignoresEventLines() {
        XCTAssertNil(ChatService.parseFrame(line: "event: ping"))
    }

    func test_parseFrame_malformedJSON_surfacesError() {
        let line = "data: {not-json}"
        guard case .error = ChatService.parseFrame(line: line) else {
            XCTFail("expected .error for malformed json")
            return
        }
    }

    func test_parseFrame_missingType_surfacesError() {
        let line = #"data: {"value":"oops"}"#
        guard case .error = ChatService.parseFrame(line: line) else {
            XCTFail("expected .error for frame missing type")
            return
        }
    }

    // MARK: - end-to-end stream against an in-memory mock

    func test_stream_collectsTextChunksInOrder_andTerminatesOnDone() async throws {
        let server = MockSSEServer(frames: [
            #"{"type":"text","value":"Hel"}"#,
            #"{"type":"text","value":"lo"}"#,
            #"{"type":"text","value":" world"}"#,
            #"{"type":"done"}"#,
        ])
        URLProtocolMock.handler = server
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolMock.self]
        let session = URLSession(configuration: config)
        let service = ChatService(baseURL: URL(string: "http://localhost:9999")!, session: session)

        var collected: [ChatEvent] = []
        for try await event in service.stream(message: "hi", sessionID: "test-session") {
            collected.append(event)
        }
        XCTAssertEqual(collected, [
            .text("Hel"),
            .text("lo"),
            .text(" world"),
            .done,
        ])
    }
}

// MARK: - URLProtocol mock

private struct MockSSEServer {
    let frames: [String]

    func encodedBody() -> Data {
        var s = ""
        for f in frames { s += "data: \(f)\n\n" }
        return Data(s.utf8)
    }
}

private final class URLProtocolMock: URLProtocol {
    static var handler: MockSSEServer?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: handler.encodedBody())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
