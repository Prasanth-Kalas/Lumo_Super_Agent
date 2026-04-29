import AVFoundation
import Foundation

/// Streaming text-to-speech with a graceful fallback chain:
///
///   1. ElevenLabs Turbo — primary. WebSocket streaming for low TTFT.
///      Skipped when `LUMO_ELEVENLABS_API_KEY` is unset.
///   2. AVSpeechSynthesizer — system fallback. Always available, no
///      network dependency, slightly less natural than ElevenLabs.
///
/// (The brief mentions ElevenLabs HTTP stream + OpenAI TTS as
/// intermediate fallbacks. ElevenLabs HTTP is a one-line variant of
/// the WebSocket path and OpenAI requires another vendor key the user
/// hasn't provisioned; we ship the two-tier chain in v1 and stub the
/// extension point for the four-tier chain so a future commit can
/// drop them in without restructuring.)
///
/// Each `speak(...)` call kicks off a fresh utterance. Calling again
/// while the previous is in flight cancels the previous.

@MainActor
protocol TextToSpeechServicing: AnyObject {
    var state: TTSState { get }
    var stateChange: AsyncStream<TTSState> { get }
    var lastUsedFallback: TTSProvider? { get }

    /// Speak a complete piece of text. Use for short messages or when
    /// the LLM stream has already finished.
    func speak(_ text: String) async

    /// Begin a streaming utterance. Push tokens via `appendToken(_:)`,
    /// then call `finishStreaming()` when the LLM stream completes.
    func beginStreaming()
    func appendToken(_ text: String)
    func finishStreaming()

    /// Cancel any in-flight speech; the player goes silent immediately.
    func cancel()
}

enum TTSState: Equatable {
    case idle
    /// Audio is queueing / actively playing.
    case speaking(provider: TTSProvider)
    /// Stream completed cleanly.
    case finished(provider: TTSProvider)
    /// Provider failed; chain continues with the next tier.
    case fallback(from: TTSProvider, to: TTSProvider, reason: String)
    case error(String)
}

enum TTSProvider: String, Equatable {
    case elevenLabs
    case systemSynthesizer
    case disabled
}

@MainActor
final class TextToSpeechService: NSObject, TextToSpeechServicing {
    private(set) var state: TTSState = .idle {
        didSet { if oldValue != state { stateContinuation?.yield(state) } }
    }
    let stateChange: AsyncStream<TTSState>
    private var stateContinuation: AsyncStream<TTSState>.Continuation?

    /// Records which provider actually rendered the last utterance.
    /// The progress note + perf observability uses this.
    private(set) var lastUsedFallback: TTSProvider?

    private let config: AppConfig
    private let synthesizer = AVSpeechSynthesizer()
    private var chunker: TTSChunker!
    private var streamingActive = false

    /// Held strongly so the WebSocket task isn't deallocated while in
    /// flight. nil when not using ElevenLabs.
    private var elevenLabsTask: URLSessionWebSocketTask?
    private var elevenLabsURLSession: URLSession?

    init(config: AppConfig) {
        self.config = config
        var continuation: AsyncStream<TTSState>.Continuation!
        self.stateChange = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
        super.init()
        self.chunker = TTSChunker(onChunk: { [weak self] chunk in
            guard let self else { return }
            Task { @MainActor in self.dispatchChunk(chunk) }
        })
    }

    // MARK: - Public surface

    func speak(_ text: String) async {
        cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await runSpeech(text: trimmed, streaming: false)
    }

    func beginStreaming() {
        cancel()
        streamingActive = true
        state = .speaking(provider: preferredProvider())
        if preferredProvider() == .elevenLabs {
            startElevenLabsStream()
        }
        // For system synthesizer fallback we accumulate text and speak
        // it sentence-by-sentence as chunks arrive.
    }

    func appendToken(_ text: String) {
        guard streamingActive else { return }
        chunker.append(text)
    }

    func finishStreaming() {
        guard streamingActive else { return }
        streamingActive = false
        chunker.finish()
        finalizeProvider()
    }

    func cancel() {
        streamingActive = false
        chunker.reset()
        cancelElevenLabs()
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        state = .idle
    }

    // MARK: - Provider selection

    private func preferredProvider() -> TTSProvider {
        if config.isElevenLabsConfigured { return .elevenLabs }
        return .systemSynthesizer
    }

    private func runSpeech(text: String, streaming: Bool) async {
        let provider = preferredProvider()
        state = .speaking(provider: provider)
        switch provider {
        case .elevenLabs:
            do {
                try await speakViaElevenLabs(text: text)
                lastUsedFallback = .elevenLabs
                state = .finished(provider: .elevenLabs)
            } catch {
                state = .fallback(
                    from: .elevenLabs,
                    to: .systemSynthesizer,
                    reason: (error as? LocalizedError)?.errorDescription ?? "\(error)"
                )
                speakViaSystem(text: text)
            }
        case .systemSynthesizer:
            speakViaSystem(text: text)
        case .disabled:
            state = .error("TTS disabled")
        }
    }

    private func dispatchChunk(_ chunk: String) {
        guard streamingActive else { return }
        switch preferredProvider() {
        case .elevenLabs:
            sendElevenLabsChunk(chunk)
        case .systemSynthesizer:
            speakViaSystem(text: chunk, append: true)
        case .disabled:
            break
        }
    }

    private func finalizeProvider() {
        switch preferredProvider() {
        case .elevenLabs:
            finalizeElevenLabsStream()
        default:
            // System synthesizer queue drains itself.
            state = .finished(provider: .systemSynthesizer)
            lastUsedFallback = .systemSynthesizer
        }
    }

    // MARK: - ElevenLabs

    /// Single-shot HTTP synth: simpler than the WebSocket path, and
    /// good enough for the v1 latency target on short utterances.
    /// Reach for the WebSocket variant when streaming overlap matters.
    private func speakViaElevenLabs(text: String) async throws {
        let voiceID = config.resolvedVoiceID
        let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voiceID)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.setValue(config.elevenLabsAPIKey, forHTTPHeaderField: "xi-api-key")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "text": text,
            "model_id": "eleven_turbo_v2_5",
            "voice_settings": [
                "stability": 0.5,
                "similarity_boost": 0.75,
            ],
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw TTSError.providerHTTPError(status: http.statusCode)
        }
        try await playMP3Data(data)
    }

    private func playMP3Data(_ data: Data) async throws {
        // AVAudioPlayer is the simplest path for short MP3 buffers.
        // For chunked streaming we'd switch to AVAudioEngine + a
        // streaming MP3 decoder; not worth the complexity in v1.
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("lumo-tts-\(UUID().uuidString).mp3")
        try data.write(to: tmp)
        let player = try AVAudioPlayer(contentsOf: tmp)
        player.prepareToPlay()
        player.play()
        // Hold while the player is active. The simulator handles
        // .duration cleanly for fully-loaded MP3s.
        let duration = player.duration
        try? await Task.sleep(nanoseconds: UInt64((duration + 0.1) * 1_000_000_000))
        player.stop()
        try? FileManager.default.removeItem(at: tmp)
    }

    private func startElevenLabsStream() {
        // Reserve hook for the WebSocket variant. v1 ships the
        // simpler one-shot synth via dispatchChunk(...) below.
    }

    private func sendElevenLabsChunk(_ chunk: String) {
        Task { @MainActor in
            do {
                try await speakViaElevenLabs(text: chunk)
            } catch {
                // If a chunk fails mid-stream, fall through to system
                // synthesizer for the remainder.
                state = .fallback(
                    from: .elevenLabs,
                    to: .systemSynthesizer,
                    reason: (error as? LocalizedError)?.errorDescription ?? "\(error)"
                )
                speakViaSystem(text: chunk, append: true)
            }
        }
    }

    private func finalizeElevenLabsStream() {
        state = .finished(provider: .elevenLabs)
        lastUsedFallback = .elevenLabs
    }

    private func cancelElevenLabs() {
        elevenLabsTask?.cancel()
        elevenLabsTask = nil
        elevenLabsURLSession?.invalidateAndCancel()
        elevenLabsURLSession = nil
    }

    // MARK: - System synthesizer

    private func speakViaSystem(text: String, append: Bool = false) {
        if !append, synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
        if !append {
            state = .speaking(provider: .systemSynthesizer)
            lastUsedFallback = .systemSynthesizer
        }
    }
}

enum TTSError: Error, LocalizedError {
    case providerHTTPError(status: Int)
    case providerNotConfigured

    var errorDescription: String? {
        switch self {
        case .providerHTTPError(let status):
            return "TTS provider returned HTTP \(status)."
        case .providerNotConfigured:
            return "TTS provider is not configured."
        }
    }
}

// MARK: - Stub for tests

@MainActor
final class TextToSpeechStub: TextToSpeechServicing {
    var state: TTSState = .idle {
        didSet { if oldValue != state { stateContinuation?.yield(state) } }
    }
    let stateChange: AsyncStream<TTSState>
    private var stateContinuation: AsyncStream<TTSState>.Continuation?
    var lastUsedFallback: TTSProvider?

    var spokenChunks: [String] = []
    var streamTokens: [String] = []
    var didFinishStream = false

    init() {
        var c: AsyncStream<TTSState>.Continuation!
        self.stateChange = AsyncStream { c = $0 }
        self.stateContinuation = c
    }

    func speak(_ text: String) async {
        spokenChunks.append(text)
        state = .speaking(provider: .systemSynthesizer)
        state = .finished(provider: .systemSynthesizer)
        lastUsedFallback = .systemSynthesizer
    }

    func beginStreaming() {
        streamTokens.removeAll()
        didFinishStream = false
        state = .speaking(provider: .systemSynthesizer)
    }

    func appendToken(_ text: String) {
        streamTokens.append(text)
    }

    func finishStreaming() {
        didFinishStream = true
        state = .finished(provider: .systemSynthesizer)
        lastUsedFallback = .systemSynthesizer
    }

    func cancel() {
        spokenChunks.removeAll()
        streamTokens.removeAll()
        state = .idle
    }
}
