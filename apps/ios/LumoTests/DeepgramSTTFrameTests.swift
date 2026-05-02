import XCTest
@testable import Lumo

/// DEEPGRAM-IOS-IMPL-1 Phase 2 — pure tests of the Deepgram STT JSON
/// frame parser. Anything live (URLSessionWebSocketTask /
/// AVAudioEngine) is exercised end-to-end manually on a real iPhone
/// per the lane brief's acceptance criteria; here we pin the
/// per-frame decode contract so a wire-shape change shows up in the
/// diff.
///
/// Three slices:
///   1. Interim frame (`is_final=false`) → `.interim(text)`.
///   2. Final frame (`is_final=true`, `speech_final=false`) →
///      `.final(text)`.
///   3. Speech-final frame (`speech_final=true`) → both `.final(text)`
///      AND `.speechFinal` so the receive loop captures the chunk
///      and then commits the turn.
@MainActor
final class DeepgramSTTFrameTests: XCTestCase {

    // MARK: - 1. Interim

    func test_parse_interim_returnsInterim() {
        let json = #"{"type":"Results","channel":{"alternatives":[{"transcript":"plan a wee"}]},"is_final":false,"speech_final":false}"#
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: json)
        XCTAssertEqual(messages, [.interim("plan a wee")])
    }

    func test_parse_emptyInterim_skipped() {
        // Deepgram emits empty-transcript frames during pure
        // silence. Skip them so the partial doesn't flicker to
        // empty between words.
        let json = #"{"type":"Results","channel":{"alternatives":[{"transcript":""}]},"is_final":false,"speech_final":false}"#
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: json)
        XCTAssertTrue(messages.isEmpty)
    }

    // MARK: - 2. Final

    func test_parse_final_returnsFinal() {
        let json = #"{"type":"Results","channel":{"alternatives":[{"transcript":"plan a weekend"}]},"is_final":true,"speech_final":false}"#
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: json)
        XCTAssertEqual(messages, [.final("plan a weekend")])
    }

    // MARK: - 3. Speech-final emits BOTH the chunk AND the sentinel

    func test_parse_speechFinal_emitsFinalThenSpeechFinal() {
        let json = #"{"type":"Results","channel":{"alternatives":[{"transcript":"to Vegas"}]},"is_final":true,"speech_final":true}"#
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: json)
        XCTAssertEqual(messages, [.final("to Vegas"), .speechFinal])
    }

    func test_parse_speechFinal_withEmptyTranscript_emitsOnlySentinel() {
        // Speech-final with no new transcript is a pure end-of-turn
        // signal — caller should commit the existing accumulator
        // without appending anything. Should still yield .speechFinal.
        let json = #"{"type":"Results","channel":{"alternatives":[{"transcript":""}]},"is_final":true,"speech_final":true}"#
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: json)
        XCTAssertEqual(messages, [.speechFinal])
    }

    // MARK: - 4. Garbage / metadata frames

    func test_parse_metadataFrameWithoutTranscript_returnsEmpty() {
        // Deepgram emits Metadata / open / close events that don't
        // carry a transcript. They should fall through silently.
        let json = #"{"type":"Metadata","duration":1.23}"#
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: json)
        XCTAssertTrue(messages.isEmpty)
    }

    func test_parse_malformedJSON_returnsEmpty() {
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: "not json")
        XCTAssertTrue(messages.isEmpty)
    }

    func test_parse_missingChannelButSpeechFinal_emitsOnlySentinel() {
        // Defensive: if the wire ever sends a speech_final without
        // the channel envelope, still surface end-of-turn.
        let json = #"{"speech_final":true}"#
        let messages = URLSessionDeepgramSTTWebSocket.parse(text: json)
        XCTAssertEqual(messages, [.speechFinal])
    }

    // MARK: - 5. Stream URL contract

    func test_streamURL_carriesFrozenContractParams() {
        let url = SpeechRecognitionService.streamURL()
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems
        else {
            XCTFail("expected URLComponents with queryItems")
            return
        }
        let params = Dictionary(uniqueKeysWithValues: items.compactMap { item in
            item.value.map { (item.name, $0) }
        })
        XCTAssertEqual(components.scheme, "wss")
        XCTAssertEqual(components.host, "api.deepgram.com")
        XCTAssertEqual(components.path, "/v1/listen")
        XCTAssertEqual(params["model"], "nova-3")
        XCTAssertEqual(params["smart_format"], "true")
        XCTAssertEqual(params["interim_results"], "true")
        XCTAssertEqual(params["endpointing"], "300")
        XCTAssertEqual(params["encoding"], "linear16")
        XCTAssertEqual(params["sample_rate"], "16000")
        XCTAssertEqual(params["channels"], "1")
    }
}
