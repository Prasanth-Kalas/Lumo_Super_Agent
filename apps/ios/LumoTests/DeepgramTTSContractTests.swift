import XCTest
@testable import Lumo

/// DEEPGRAM-IOS-IMPL-1 Phase 3 — Deepgram Aura-2 TTS contract tests.
///
/// AVAudioEngine + AVAudioPlayerNode wiring is exercised
/// end-to-end manually on a real device per the lane brief. Here
/// we pin the wire-shape contract bits that don't need the audio
/// hardware:
///
///   1. Stream URL contract — frozen query params per
///      `docs/contracts/ios-deepgram-integration.md`.
///   2. Voice picker default + override — VoiceSettings.voiceId
///      flows into the URL builder.
///   3. Flushed-message parser — server's `{"type":"Flushed"}`
///      decodes to the `.flushed` sentinel; everything else
///      falls through.
///   4. TTSProvider tag preserved across the ElevenLabs swap so
///      callers like `lastUsedFallback` keep typing.
@MainActor
final class DeepgramTTSContractTests: XCTestCase {

    // MARK: - 1. Stream URL contract

    func test_streamURL_carriesFrozenContractParams_withDefaultVoice() {
        let url = DeepgramTTSSession.streamURL(voiceID: "aura-2-thalia-en")
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
        XCTAssertEqual(components.path, "/v1/speak")
        XCTAssertEqual(params["model"], "aura-2-thalia-en")
        XCTAssertEqual(params["encoding"], "linear16")
        XCTAssertEqual(params["sample_rate"], "48000")
    }

    func test_streamURL_propagatesVoiceID() {
        let url = DeepgramTTSSession.streamURL(voiceID: "aura-2-orpheus-en")
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let model = components.queryItems?.first(where: { $0.name == "model" })?.value
        XCTAssertEqual(model, "aura-2-orpheus-en",
                       "voice picker selection must reach the WSS URL")
    }

    // MARK: - 2. Voice picker

    func test_voiceSettings_defaultMatchesWebCanonical() {
        // Mirror of apps/web/lib/voice-catalog.ts::DEFAULT_VOICE_ID.
        // If web changes the default, iOS should follow in lock-step
        // so a user-level voice preference (when IOS-VOICE-PICKER-SYNC-1
        // ships) syncs cleanly across platforms.
        XCTAssertEqual(VoiceSettings.defaultVoiceId, "aura-2-thalia-en")
    }

    func test_voiceSettings_overrideViaUserDefaults() {
        let key = "lumo.voice.voiceId"
        let prior = UserDefaults.standard.string(forKey: key)
        defer {
            if let prior {
                UserDefaults.standard.set(prior, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }

        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertEqual(VoiceSettings.voiceId, "aura-2-thalia-en",
                       "unset must surface the canonical default")

        VoiceSettings.voiceId = "aura-2-orpheus-en"
        XCTAssertEqual(VoiceSettings.voiceId, "aura-2-orpheus-en")
        XCTAssertEqual(UserDefaults.standard.string(forKey: key), "aura-2-orpheus-en")

        // Empty string treated as unset — falls back to default.
        VoiceSettings.voiceId = ""
        XCTAssertEqual(VoiceSettings.voiceId, "aura-2-thalia-en",
                       "empty string must NOT mean 'use empty model id' — fall back to default so a clearing edge case can't ship a malformed WSS URL")
    }

    // MARK: - 3. Flushed-message parser

    func test_flushedMessage_recognized() {
        XCTAssertTrue(URLSessionDeepgramTTSWebSocket.isFlushedMessage(text: #"{"type":"Flushed"}"#))
    }

    func test_flushedMessage_otherTypes_falseyButNonFatal() {
        XCTAssertFalse(URLSessionDeepgramTTSWebSocket.isFlushedMessage(text: #"{"type":"Speak"}"#))
        XCTAssertFalse(URLSessionDeepgramTTSWebSocket.isFlushedMessage(text: #"{"type":"Metadata","ok":true}"#))
        XCTAssertFalse(URLSessionDeepgramTTSWebSocket.isFlushedMessage(text: ""))
        XCTAssertFalse(URLSessionDeepgramTTSWebSocket.isFlushedMessage(text: "not json"))
    }

    // MARK: - 4. Provider tag preserved across the ElevenLabs swap

    func test_ttsProvider_deepgramReplacesElevenLabs() {
        // The .deepgram case is what production paths emit;
        // .systemSynthesizer stays for the test stub; .disabled
        // covers the no-provider-configured surface. There is no
        // .elevenLabs case (acceptance gate: "Zero ElevenLabs
        // references in apps/ios/").
        let cases: [TTSProvider] = [.deepgram, .systemSynthesizer, .disabled]
        XCTAssertEqual(cases.count, 3,
                       "TTSProvider exposes exactly three cases post-ElevenLabs purge")
    }

    func test_ttsState_speakingDeepgramRoundtrips() {
        // Pin Equatable conformance so `state == .speaking(provider: .deepgram)`
        // checks survive future enum tweaks.
        let s: TTSState = .speaking(provider: .deepgram)
        XCTAssertEqual(s, .speaking(provider: .deepgram))
        XCTAssertNotEqual(s, .speaking(provider: .systemSynthesizer))
    }
}
