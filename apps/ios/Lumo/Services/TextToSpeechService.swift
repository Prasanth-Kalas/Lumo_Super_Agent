import AVFoundation
import Foundation

/// Streaming text-to-speech via Deepgram Aura-2 over WebSocket.
///
/// **DEEPGRAM-IOS-IMPL-1 Phase 3.** Replaces the previous third-
/// party-TTS-plus-AVSpeechSynthesizer fallback chain with a single
/// Deepgram path. The `TextToSpeechServicing` protocol surface is
/// preserved so `ChatViewModel`'s streaming-reply hookup
/// (`beginStreaming` / `appendToken(_:)` / `finishStreaming`) works
/// unchanged.
///
/// **Architectural mirror of web's audio hotfix.** Codex's
/// DEEPGRAM-WEB-AUDIO-HOTFIX-1 fixed multi-chunk truncation by
/// keeping ONE MediaSource alive across all chunks of a multi-
/// sentence reply, only calling endOfStream() on the last chunk.
/// iOS WSS Speak streams PCM continuously rather than as HTTP-
/// bounded chunks, so the bug class is different — but the principle
/// holds: keep ONE `AVAudioPlayerNode` (and ONE `AVAudioEngine`)
/// alive for the duration of a multi-sentence assistant reply.
/// Don't tear down the player between sentence chunks. The "premium
/// TTS session" concept from web's `VoiceMode.tsx` has a 1:1 iOS
/// analog in `DeepgramTTSSession` below.
///
/// **Wire contract** (`docs/contracts/ios-deepgram-integration.md`):
/// - WSS `wss://api.deepgram.com/v1/speak?model=<voiceID>&encoding=linear16&sample_rate=48000`
/// - `Authorization: Bearer <temporary token>`
/// - Send: JSON text frames `{"type":"Speak","text":"..."}` per phrase
///   chunk; `{"type":"Flush"}` to commit the running text; `{"type":"Close"}`
///   to wind down.
/// - Receive: binary linear16 PCM at 48 kHz mono. Feed each chunk
///   into a persistent `AVAudioPlayerNode` as it arrives — start
///   playback on the first chunk, do NOT wait for stream close.
/// - Halt on: mute, barge-in, route change, push-to-talk start.
///   Caller invokes `cancel()` from those entry points.
///
/// **Retry policy** (matches Codex's web-side retry-once-on-5xx):
/// - WSS handshake transient close → retry once with 250 ms backoff
///   before surfacing user-visible error.
/// - Mid-stream close → state goes to `.error`; caller falls back
///   to text-mode for the turn (no audio replay).

@MainActor
protocol TextToSpeechServicing: AnyObject {
    var state: TTSState { get }
    var stateChange: AsyncStream<TTSState> { get }
    var lastUsedFallback: TTSProvider? { get }

    /// Speak a complete piece of text. Use for short messages or
    /// when the LLM stream has already finished.
    func speak(_ text: String) async

    /// Begin a streaming utterance. Push tokens via
    /// `appendToken(_:)`, then call `finishStreaming()` when the
    /// LLM stream completes. ONE TTS session covers all tokens.
    func beginStreaming()
    func appendToken(_ text: String)
    func finishStreaming()

    /// Cancel any in-flight speech; the player goes silent
    /// immediately. Used for mute / barge-in / route change /
    /// push-to-talk start.
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

/// Provider tag preserved for API stability with `TextToSpeechStub`
/// + `lastUsedFallback`. With the legacy-provider purge in Phase 5 the
/// `.systemSynthesizer` case stays only as the test-stub default;
/// `.disabled` covers the "no provider configured" surface.
enum TTSProvider: String, Equatable {
    case deepgram
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

    private(set) var lastUsedFallback: TTSProvider?

    private let tokenService: DeepgramTokenServicing
    private let audioSession: AudioSessionManager
    private let websocketFactoryOverride: DeepgramTTSWebSocketFactory?
    private var chunker: TTSChunker!
    private var streamingActive = false

    /// **Single persistent session** for one streaming reply.
    /// Created on `beginStreaming()` (or implicitly on `speak(_:)`),
    /// kept alive across every `appendToken` → `dispatchChunk`
    /// emission, torn down on `finishStreaming` end-of-stream OR
    /// `cancel()`. Mirrors web's "premium TTS session" pattern
    /// (DEEPGRAM-WEB-AUDIO-HOTFIX-1).
    private var session: DeepgramTTSSession?

    init(
        tokenService: DeepgramTokenServicing,
        audioSession: AudioSessionManager = .shared,
        websocketFactory: DeepgramTTSWebSocketFactory? = nil
    ) {
        self.tokenService = tokenService
        self.audioSession = audioSession
        self.websocketFactoryOverride = websocketFactory
        var continuation: AsyncStream<TTSState>.Continuation!
        self.stateChange = AsyncStream { continuation = $0 }
        super.init()
        self.stateContinuation = continuation
        self.chunker = TTSChunker { [weak self] chunk in
            self?.dispatchChunk(chunk)
        }
    }

    // MARK: - One-shot

    func speak(_ text: String) async {
        cancel()
        let session = ensureSession()
        await session.send(text: text)
        await session.flushAndDrain()
        teardownSession(finalState: .finished(provider: .deepgram))
        lastUsedFallback = .deepgram
    }

    // MARK: - Streaming

    func beginStreaming() {
        cancel()
        streamingActive = true
        _ = ensureSession()
        state = .speaking(provider: .deepgram)
    }

    func appendToken(_ text: String) {
        guard streamingActive else { return }
        chunker.append(text)
    }

    func finishStreaming() {
        guard streamingActive else { return }
        streamingActive = false
        chunker.finish()
        Task { [weak self] in
            await self?.session?.flushAndDrain()
            await MainActor.run {
                self?.teardownSession(finalState: .finished(provider: .deepgram))
                self?.lastUsedFallback = .deepgram
            }
        }
    }

    func cancel() {
        streamingActive = false
        chunker.reset()
        teardownSession(finalState: .idle)
    }

    // MARK: - Session lifecycle

    private func ensureSession() -> DeepgramTTSSession {
        if let session { return session }
        let factory = websocketFactoryOverride ?? URLSessionDeepgramTTSWebSocketFactory()
        let session = DeepgramTTSSession(
            tokenService: tokenService,
            audioSession: audioSession,
            voiceID: VoiceSettings.voiceId,
            websocketFactory: factory,
            onError: { [weak self] reason in
                self?.handleSessionError(reason: reason)
            }
        )
        self.session = session
        Task { await session.start() }
        return session
    }

    private func teardownSession(finalState: TTSState) {
        session?.cancel()
        session = nil
        state = finalState
    }

    private func dispatchChunk(_ chunk: String) {
        guard let session = session else { return }
        Task { await session.send(text: chunk) }
    }

    private func handleSessionError(reason: String) {
        state = .error(reason)
        session = nil
        streamingActive = false
        chunker.reset()
    }
}

enum TTSError: Error, LocalizedError {
    case providerNotConfigured
    case handshakeFailed(reason: String)
    case audioEngineFailed(String)
    case tokenFailed(String)

    var errorDescription: String? {
        switch self {
        case .providerNotConfigured:
            return "TTS provider is not configured."
        case .handshakeFailed(let reason):
            return "Couldn't connect to voice service: \(reason)"
        case .audioEngineFailed(let detail):
            return "Couldn't start audio playback: \(detail)"
        case .tokenFailed(let detail):
            return "Couldn't get a voice token: \(detail)"
        }
    }
}

// MARK: - DeepgramTTSSession — the persistent "premium TTS session"

/// Encapsulates the per-reply state that must stay alive across
/// every phrase chunk: the WebSocket, the AVAudioEngine, and the
/// AVAudioPlayerNode. ONE instance per reply turn.
///
/// Public surface from `TextToSpeechService`:
///   - `start()` async — open WSS + audio engine. Retry-once-on-5xx
///     at handshake before surfacing error.
///   - `send(text:)` async — push a phrase chunk to Deepgram via
///     `{"type":"Speak","text":"..."}`.
///   - `flushAndDrain()` async — send `{"type":"Flush"}` and wait
///     until the player's queued buffers drain (signalling end of
///     audio).
///   - `cancel()` — tear down everything immediately. Used for
///     barge-in, route change, push-to-talk start, etc.
@MainActor
final class DeepgramTTSSession {
    private let tokenService: DeepgramTokenServicing
    private let audioSession: AudioSessionManager
    private let voiceID: String
    private let websocketFactory: DeepgramTTSWebSocketFactory
    private let onError: (String) -> Void

    private var websocket: DeepgramTTSWebSocket?
    private var audioEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var receiveTask: Task<Void, Never>?
    private var bufferCount: Int = 0
    private var flushed: Bool = false

    init(
        tokenService: DeepgramTokenServicing,
        audioSession: AudioSessionManager,
        voiceID: String,
        websocketFactory: DeepgramTTSWebSocketFactory,
        onError: @escaping (String) -> Void
    ) {
        self.tokenService = tokenService
        self.audioSession = audioSession
        self.voiceID = voiceID
        self.websocketFactory = websocketFactory
        self.onError = onError
    }

    func start() async {
        do {
            try audioSession.configureForVoiceConversation()
            try setupAudioEngine()
            try await openSocket(attempt: 0)
        } catch {
            onError((error as? LocalizedError)?.errorDescription ?? "\(error)")
            cancel()
        }
    }

    func send(text: String) async {
        let payload: [String: Any] = ["type": "Speak", "text": text]
        await sendJSON(payload)
    }

    func flushAndDrain() async {
        await sendJSON(["type": "Flush"])
        flushed = true
        // Generous timeout — the player drains naturally as
        // scheduled buffers complete. We poll bufferCount; the
        // receive loop decrements it via scheduleBuffer's
        // completion handler.
        let deadline = Date().addingTimeInterval(20)
        while bufferCount > 0 && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    func cancel() {
        receiveTask?.cancel()
        receiveTask = nil
        websocket?.close()
        websocket = nil
        playerNode?.stop()
        playerNode = nil
        audioEngine?.stop()
        audioEngine = nil
        bufferCount = 0
        flushed = false
        tokenService.markStreamActive(false)
    }

    // MARK: - WebSocket open with retry-once-on-5xx

    private func openSocket(attempt: Int) async throws {
        let token: String
        do {
            token = try await tokenService.currentToken()
        } catch {
            throw TTSError.tokenFailed(String(describing: error))
        }
        tokenService.markStreamActive(true)

        let url = DeepgramTTSSession.streamURL(voiceID: voiceID)
        let ws = websocketFactory.make(url: url, token: token)
        websocket = ws

        do {
            try await ws.waitForOpen()
        } catch {
            // Retry-once-on-5xx pattern matching Codex's web-side
            // retry. WSS handshake failures map to .handshakeFailed
            // here; a single 250 ms-backoff retry before surfacing.
            if attempt == 0 {
                tokenService.invalidate()
                tokenService.markStreamActive(false)
                ws.close()
                websocket = nil
                try? await Task.sleep(nanoseconds: 250_000_000)
                try await openSocket(attempt: attempt + 1)
                return
            }
            throw TTSError.handshakeFailed(reason: String(describing: error))
        }

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(ws: ws)
        }
    }

    private func receiveLoop(ws: DeepgramTTSWebSocket) async {
        do {
            for try await message in ws.incoming {
                handle(message: message)
            }
        } catch {
            // Mid-stream close. Per RISK 2, we don't replay audio;
            // surface the error and let the caller fall back to text.
            onError("Voice playback connection lost.")
        }
    }

    private func handle(message: DeepgramTTSIncomingMessage) {
        switch message {
        case .audio(let data):
            schedule(audioData: data)
        case .flushed:
            // Server confirmed flush; pending audio is in flight.
            // No-op — the buffer-count drain in flushAndDrain()
            // handles end-of-audio detection.
            break
        }
    }

    // MARK: - Audio engine

    private func setupAudioEngine() throws {
        // ONE engine + ONE player node, kept alive across all
        // chunks of the reply. Mirror of web's persistent
        // MediaSource.
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 48000,
            channels: 1,
            interleaved: true
        ) else {
            throw TTSError.audioEngineFailed("could not create 48kHz Int16 format")
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
        } catch {
            throw TTSError.audioEngineFailed(error.localizedDescription)
        }
        player.play()
        self.audioEngine = engine
        self.playerNode = player
    }

    private func schedule(audioData data: Data) {
        guard let player = playerNode,
              let format = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: 48000,
                channels: 1,
                interleaved: true
              ),
              !data.isEmpty
        else { return }
        let frameCount = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
        else { return }
        buffer.frameLength = frameCount
        data.withUnsafeBytes { rawBytes in
            guard let src = rawBytes.bindMemory(to: Int16.self).baseAddress,
                  let dst = buffer.int16ChannelData?[0]
            else { return }
            dst.update(from: src, count: Int(frameCount))
        }
        bufferCount += 1
        player.scheduleBuffer(buffer) { [weak self] in
            Task { @MainActor in
                self?.bufferCount = max(0, (self?.bufferCount ?? 1) - 1)
            }
        }
    }

    // MARK: - WebSocket send

    private func sendJSON(_ payload: [String: Any]) async {
        guard let ws = websocket,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8)
        else { return }
        await ws.send(text: text)
    }

    // MARK: - URL builder

    static func streamURL(voiceID: String) -> URL {
        var components = URLComponents()
        components.scheme = "wss"
        components.host = "api.deepgram.com"
        components.path = "/v1/speak"
        components.queryItems = [
            URLQueryItem(name: "model", value: voiceID),
            URLQueryItem(name: "encoding", value: "linear16"),
            URLQueryItem(name: "sample_rate", value: "48000"),
        ]
        return components.url!
    }
}

// MARK: - WebSocket abstraction

enum DeepgramTTSIncomingMessage: Equatable {
    case audio(Data)
    case flushed
}

@MainActor
protocol DeepgramTTSWebSocket: AnyObject {
    var incoming: AsyncThrowingStream<DeepgramTTSIncomingMessage, Error> { get }
    /// Resolves once the WSS handshake completes, throws on
    /// transient close (used for the retry-once-on-5xx path).
    func waitForOpen() async throws
    func send(text: String) async
    func close()
}

@MainActor
protocol DeepgramTTSWebSocketFactory: AnyObject {
    func make(url: URL, token: String) -> DeepgramTTSWebSocket
}

@MainActor
final class URLSessionDeepgramTTSWebSocketFactory: DeepgramTTSWebSocketFactory {
    func make(url: URL, token: String) -> DeepgramTTSWebSocket {
        URLSessionDeepgramTTSWebSocket(url: url, token: token)
    }
}

@MainActor
final class URLSessionDeepgramTTSWebSocket: NSObject, DeepgramTTSWebSocket {
    let incoming: AsyncThrowingStream<DeepgramTTSIncomingMessage, Error>
    private var continuation: AsyncThrowingStream<DeepgramTTSIncomingMessage, Error>.Continuation?
    private let session: URLSession
    private let task: URLSessionWebSocketTask
    private var openContinuation: CheckedContinuation<Void, Error>?

    init(url: URL, token: String) {
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .default)
        self.session = session
        self.task = session.webSocketTask(with: req)
        var localContinuation: AsyncThrowingStream<DeepgramTTSIncomingMessage, Error>.Continuation!
        self.incoming = AsyncThrowingStream { localContinuation = $0 }
        super.init()
        self.continuation = localContinuation
    }

    func waitForOpen() async throws {
        // URLSessionWebSocketTask doesn't surface "open" directly;
        // we resume the task and probe with a sendPing whose
        // pong-receive handler closes our wait. A failed handshake
        // surfaces here as a thrown error, letting the
        // retry-once-on-5xx layer in DeepgramTTSSession handle
        // transient closes uniformly.
        task.resume()
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.task.sendPing { error in
                if let error {
                    cont.resume(throwing: TTSError.handshakeFailed(reason: String(describing: error)))
                } else {
                    cont.resume()
                }
            }
        }
        Task { @MainActor in await self.receiveLoop() }
    }

    func send(text: String) async {
        do {
            try await task.send(.string(text))
        } catch {
            continuation?.finish(throwing: error)
        }
    }

    func close() {
        continuation?.finish()
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func receiveLoop() async {
        while true {
            do {
                let message = try await task.receive()
                switch message {
                case .data(let data):
                    continuation?.yield(.audio(data))
                case .string(let text):
                    if Self.isFlushedMessage(text: text) {
                        continuation?.yield(.flushed)
                    }
                @unknown default:
                    break
                }
            } catch {
                continuation?.finish(throwing: error)
                return
            }
        }
    }

    static func isFlushedMessage(text: String) -> Bool {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        // Deepgram emits `{"type":"Flushed"}` (or similar) once the
        // server has finished generating audio for the queued text.
        if let type = obj["type"] as? String, type == "Flushed" {
            return true
        }
        return false
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
