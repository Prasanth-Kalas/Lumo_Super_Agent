import AVFoundation
import Foundation

/// Streaming speech-to-text via Deepgram Nova-3 over WebSocket.
///
/// **DEEPGRAM-IOS-IMPL-1 Phase 2.** Replaces the previous
/// SFSpeechRecognizer + on-device-recognition path. The
/// `SpeechRecognitionServicing` protocol surface is preserved so
/// `VoiceComposerViewModel` and the chat composer's PTT mode-pick
/// rule (mic-vs-send-button doctrine) keep working unchanged. Only
/// the implementation of `SpeechRecognitionService` swaps from
/// Apple's recognizer to Deepgram.
///
/// The class name is intentionally retained ("SpeechRecognition")
/// even though the brand is now Deepgram — call sites pin the
/// symbol and the swap is internal. Future rename to
/// `DeepgramSTTService` is a separate, mechanical PR.
///
/// **Wire contract** (`docs/contracts/ios-deepgram-integration.md`):
/// - WSS `wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=true&endpointing=300&encoding=linear16&sample_rate=16000&channels=1`
/// - `Authorization: Bearer <temporary token>`
/// - Audio frames: 16 kHz mono linear16 PCM, sent as binary WS messages.
/// - Transcript frames: JSON text WS messages.
///   - `is_final=false` → `state = .listening(partial:)`
///   - `is_final=true` → append to running transcript
///   - `speech_final=true` → end-of-turn, emit `state = .final(...)`
///
/// **Reconnect** (RISK 2 reviewer answer):
/// - Up to 3 retries per turn with exponential backoff (250 ms,
///   500 ms, 1000 ms).
/// - Token refresh-ahead suppressed during in-flight stream;
///   mid-stream 401 surfaces "Reconnecting…" toast and continues
///   from the next utterance — partial transcript IS lost (rare:
///   only on > 60s continuous mic-hold).
/// - After 3 failures, state transitions to `.error` with a user-
///   surfaceable message; caller falls back to text-mode for the turn.

@MainActor
protocol SpeechRecognitionServicing: AnyObject {
    var state: SpeechRecognitionState { get }
    var stateChange: AsyncStream<SpeechRecognitionState> { get }

    func ensurePermissions() async -> SpeechPermissionResult
    func start() async throws
    func stop()
    func cancel()
}

enum SpeechRecognitionState: Equatable {
    /// Idle — nothing recording, no transcript yet.
    case idle
    /// Mic open and capturing audio. The associated string is the
    /// rolling partial transcript.
    case listening(partial: String)
    /// Recognition wrapped up; final transcript is the canonical
    /// text the chat composer should send.
    case final(transcript: String)
    /// Permissions denied or revoked. UI shows a deep-link to Settings.
    case permissionDenied
    /// Hardware / network / framework error. UI surfaces the
    /// message; caller may retry.
    case error(String)
}

/// Result of the microphone permission dance. With Deepgram replacing
/// SFSpeechRecognizer, only microphone access is now strictly needed —
/// `.speechRecognitionDenied` and `.restrictedByDevice` cases stay in
/// the enum for API stability with VoiceComposerViewModel but are
/// unreachable from the Deepgram path.
enum SpeechPermissionResult {
    case granted
    case microphoneDenied
    case speechRecognitionDenied
    case restrictedByDevice
}

enum SpeechRecognitionError: Error, LocalizedError {
    case recognizerUnavailable
    case audioEngineFailed(String)
    case requestFailed(String)
    case tokenFailed(String)

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            return "Voice transcription isn't available right now."
        case .audioEngineFailed(let detail):
            return "Couldn't start the microphone: \(detail)"
        case .requestFailed(let detail):
            return "Voice transcription error: \(detail)"
        case .tokenFailed(let detail):
            return "Couldn't get a voice token: \(detail)"
        }
    }
}

@MainActor
final class SpeechRecognitionService: SpeechRecognitionServicing {
    private(set) var state: SpeechRecognitionState = .idle {
        didSet { if oldValue != state { stateContinuation?.yield(state) } }
    }
    let stateChange: AsyncStream<SpeechRecognitionState>
    private var stateContinuation: AsyncStream<SpeechRecognitionState>.Continuation?

    private let tokenService: DeepgramTokenServicing
    private let audioSession: AudioSessionManager
    private let silenceThreshold: TimeInterval
    /// Injected for tests so the WebSocket layer can be stubbed.
    /// Production callers leave this nil and the service uses a
    /// real URLSession.
    private let websocketFactoryOverride: DeepgramSTTWebSocketFactory?

    private var audioEngine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var websocket: DeepgramSTTWebSocket?
    private var receiveTask: Task<Void, Never>?
    private var silenceTimer: Task<Void, Never>?

    /// Final-transcript accumulator — `is_final=true` chunks are
    /// concatenated until `speech_final=true` (or the silence
    /// timer / explicit stop) commits the turn.
    private var finalAccumulator: String = ""

    init(
        tokenService: DeepgramTokenServicing,
        audioSession: AudioSessionManager = .shared,
        silenceThreshold: TimeInterval = 1.5,
        websocketFactory: DeepgramSTTWebSocketFactory? = nil
    ) {
        self.tokenService = tokenService
        self.audioSession = audioSession
        self.silenceThreshold = silenceThreshold
        self.websocketFactoryOverride = websocketFactory
        var continuation: AsyncStream<SpeechRecognitionState>.Continuation!
        self.stateChange = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    // MARK: - Permissions

    func ensurePermissions() async -> SpeechPermissionResult {
        // Deepgram only needs microphone access — Apple Speech
        // permission is gone. Permission flow is otherwise unchanged.
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return .granted
        case .denied:
            return .microphoneDenied
        case .undetermined:
            let granted = await audioSession.requestMicrophonePermission()
            return granted ? .granted : .microphoneDenied
        @unknown default:
            let granted = await audioSession.requestMicrophonePermission()
            return granted ? .granted : .microphoneDenied
        }
    }

    // MARK: - Start / stop / cancel

    func start() async throws {
        // Stop anything in-flight before starting a new session.
        cancel()
        finalAccumulator = ""

        try audioSession.configureForVoiceConversation()

        // Mint token before opening the WSS so a token failure doesn't
        // race with audio-engine start. While the stream is active,
        // refresh-ahead suppresses itself (RISK 2 answer).
        let token: String
        do {
            token = try await tokenService.currentToken()
        } catch {
            state = .error(SpeechRecognitionError.tokenFailed(String(describing: error)).localizedDescription)
            throw SpeechRecognitionError.tokenFailed(String(describing: error))
        }

        try await openStream(token: token, attempt: 0)
    }

    func stop() {
        // Mirrors the original SFSpeech path: `stop()` is a graceful
        // wrap-up. The audio tap closes, the WS closes, the silence
        // timer cancels, and the accumulated final transcript (if
        // any) commits as the canonical text.
        silenceTimer?.cancel()
        silenceTimer = nil
        teardownAudio()
        receiveTask?.cancel()
        receiveTask = nil
        websocket?.close()
        websocket = nil
        tokenService.markStreamActive(false)

        if !finalAccumulator.isEmpty {
            state = .final(transcript: finalAccumulator.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    func cancel() {
        silenceTimer?.cancel()
        silenceTimer = nil
        teardownAudio()
        receiveTask?.cancel()
        receiveTask = nil
        websocket?.close()
        websocket = nil
        tokenService.markStreamActive(false)
        state = .idle
        finalAccumulator = ""
    }

    // MARK: - Stream lifecycle

    private func openStream(token: String, attempt: Int) async throws {
        let url = SpeechRecognitionService.streamURL()
        let factory = websocketFactoryOverride ?? URLSessionDeepgramSTTWebSocketFactory()
        let ws = factory.make(url: url, token: token)
        websocket = ws
        tokenService.markStreamActive(true)

        // Audio engine: install a 16 kHz linear16 PCM tap and ship
        // each tap buffer as a binary WS frame. AVAudioConverter
        // handles the resample from the input's native rate
        // (typically 44.1 / 48 kHz) to 16 kHz mono Int16. The
        // engine itself routes via AVAudioMixerNode internally per
        // the RISK 1 answer.
        let engine = AVAudioEngine()
        audioEngine = engine

        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: true
        ) else {
            throw SpeechRecognitionError.audioEngineFailed("could not create 16kHz Int16 format")
        }
        let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        self.converter = converter

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self,
                  let converter = self.converter,
                  let outBuffer = AVAudioPCMBuffer(
                    pcmFormat: outputFormat,
                    frameCapacity: AVAudioFrameCount(outputFormat.sampleRate) / 10
                  )
            else { return }
            var error: NSError?
            converter.convert(to: outBuffer, error: &error) { _, status in
                status.pointee = .haveData
                return buffer
            }
            if error != nil { return }
            guard let data = SpeechRecognitionService.pcmData(from: outBuffer), !data.isEmpty else { return }
            let ws = self.websocket
            Task { await ws?.send(audio: data) }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            teardownAudio()
            tokenService.markStreamActive(false)
            throw SpeechRecognitionError.audioEngineFailed(error.localizedDescription)
        }

        state = .listening(partial: "")

        // Spawn the receive loop; closes drive reconnect logic.
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(ws: ws, attempt: attempt)
        }
    }

    private func receiveLoop(ws: DeepgramSTTWebSocket, attempt: Int) async {
        do {
            for try await message in ws.incoming {
                handle(message: message)
            }
            // Stream closed cleanly — if we still have audio in
            // flight, this is a reconnect candidate. Falling out
            // of the loop here means the user (or the silence
            // timer) closed it; nothing else to do.
        } catch {
            // Mid-stream 401 — RISK 2 answer: lose the partial,
            // refresh token, surface "Reconnecting…", retry once.
            // Other errors fall into the exponential-backoff path.
            if case DeepgramSTTReceiveError.unauthorized = error {
                await reconnectAfterAuth(attempt: attempt)
            } else {
                await reconnectWithBackoff(attempt: attempt, reason: String(describing: error))
            }
        }
    }

    private func reconnectAfterAuth(attempt: Int) async {
        tokenService.invalidate()
        state = .listening(partial: "Reconnecting…")
        teardownAudio()
        websocket?.close()
        websocket = nil
        tokenService.markStreamActive(false)
        do {
            let token = try await tokenService.currentToken()
            try await openStream(token: token, attempt: attempt + 1)
        } catch {
            state = .error("Voice connection lost. Please try again.")
        }
    }

    private func reconnectWithBackoff(attempt: Int, reason: String) async {
        guard attempt < 3 else {
            state = .error("Voice connection lost after 3 retries. Please try again.")
            cancel()
            return
        }
        let delays: [UInt64] = [250_000_000, 500_000_000, 1_000_000_000]
        try? await Task.sleep(nanoseconds: delays[attempt])
        teardownAudio()
        websocket?.close()
        websocket = nil
        tokenService.markStreamActive(false)
        state = .listening(partial: "Reconnecting…")
        do {
            let token = try await tokenService.currentToken()
            try await openStream(token: token, attempt: attempt + 1)
        } catch {
            state = .error("Voice connection lost. Please try again.")
        }
    }

    // MARK: - Frame handling

    private func handle(message: DeepgramSTTIncomingMessage) {
        switch message {
        case .interim(let text):
            // Interim: render under the rolling final accumulator.
            let combined = (finalAccumulator + " " + text).trimmingCharacters(in: .whitespacesAndNewlines)
            state = .listening(partial: combined)
            armSilenceTimer()
        case .final(let text):
            finalAccumulator = (finalAccumulator + " " + text).trimmingCharacters(in: .whitespacesAndNewlines)
            // Show the new running text as the partial too — UX-
            // continuous (no flash to empty between final and next
            // interim).
            state = .listening(partial: finalAccumulator)
            armSilenceTimer()
        case .speechFinal:
            // Deepgram-side end-of-turn signal; commit immediately.
            silenceTimer?.cancel()
            silenceTimer = nil
            stop()
        }
    }

    private func armSilenceTimer() {
        silenceTimer?.cancel()
        silenceTimer = Task { [weak self] in
            guard let self = self else { return }
            try? await Task.sleep(nanoseconds: UInt64(self.silenceThreshold * 1_000_000_000))
            if Task.isCancelled { return }
            self.stop()
        }
    }

    private func teardownAudio() {
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        audioEngine = nil
        converter = nil
    }

    // MARK: - Helpers

    static func streamURL() -> URL {
        var components = URLComponents()
        components.scheme = "wss"
        components.host = "api.deepgram.com"
        components.path = "/v1/listen"
        components.queryItems = [
            URLQueryItem(name: "model", value: "nova-3"),
            URLQueryItem(name: "smart_format", value: "true"),
            URLQueryItem(name: "interim_results", value: "true"),
            URLQueryItem(name: "endpointing", value: "300"),
            URLQueryItem(name: "encoding", value: "linear16"),
            URLQueryItem(name: "sample_rate", value: "16000"),
            URLQueryItem(name: "channels", value: "1"),
        ]
        return components.url!
    }

    static func pcmData(from buffer: AVAudioPCMBuffer) -> Data? {
        guard let channelData = buffer.int16ChannelData else { return nil }
        let frameLength = Int(buffer.frameLength)
        let byteCount = frameLength * MemoryLayout<Int16>.size
        return Data(bytes: channelData[0], count: byteCount)
    }
}

// MARK: - WebSocket abstraction

/// Inbound STT messages decoded from Deepgram's JSON frames.
enum DeepgramSTTIncomingMessage: Equatable {
    /// Rolling partial — `is_final=false`. Render in place of the
    /// last partial.
    case interim(String)
    /// Stable transcript chunk — `is_final=true`, `speech_final=false`.
    /// Append to the accumulator; more interims may follow.
    case final(String)
    /// End-of-turn — `speech_final=true`. Caller should commit the
    /// accumulator and stop the stream.
    case speechFinal
}

/// Errors the receive loop can throw.
enum DeepgramSTTReceiveError: Error {
    case unauthorized
    case decode(String)
    case transport(String)
    case closed(reason: String?)
}

@MainActor
protocol DeepgramSTTWebSocket: AnyObject {
    var incoming: AsyncThrowingStream<DeepgramSTTIncomingMessage, Error> { get }
    func send(audio: Data) async
    func close()
}

@MainActor
protocol DeepgramSTTWebSocketFactory: AnyObject {
    func make(url: URL, token: String) -> DeepgramSTTWebSocket
}

// MARK: - Production WebSocket

@MainActor
final class URLSessionDeepgramSTTWebSocketFactory: DeepgramSTTWebSocketFactory {
    func make(url: URL, token: String) -> DeepgramSTTWebSocket {
        URLSessionDeepgramSTTWebSocket(url: url, token: token)
    }
}

@MainActor
final class URLSessionDeepgramSTTWebSocket: NSObject, DeepgramSTTWebSocket {
    let incoming: AsyncThrowingStream<DeepgramSTTIncomingMessage, Error>
    private var continuation: AsyncThrowingStream<DeepgramSTTIncomingMessage, Error>.Continuation?
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    init(url: URL, token: String) {
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .default)
        self.session = session
        self.task = session.webSocketTask(with: req)
        var localContinuation: AsyncThrowingStream<DeepgramSTTIncomingMessage, Error>.Continuation!
        self.incoming = AsyncThrowingStream { localContinuation = $0 }
        super.init()
        self.continuation = localContinuation
        self.task.resume()
        Task { @MainActor in await self.receiveLoop() }
    }

    func send(audio: Data) async {
        do {
            try await task.send(.data(audio))
        } catch {
            continuation?.finish(throwing: DeepgramSTTReceiveError.transport(String(describing: error)))
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
                case .string(let text):
                    for parsed in Self.parse(text: text) {
                        continuation?.yield(parsed)
                    }
                case .data:
                    // STT direction is text-only for transcripts.
                    // Binary frames are reserved for future use;
                    // ignore for now.
                    break
                @unknown default:
                    break
                }
            } catch {
                let nsError = error as NSError
                if nsError.code == NSURLErrorUserAuthenticationRequired
                    || nsError.code == 401
                {
                    continuation?.finish(throwing: DeepgramSTTReceiveError.unauthorized)
                } else {
                    continuation?.finish(throwing: DeepgramSTTReceiveError.transport(String(describing: error)))
                }
                return
            }
        }
    }

    /// Parses one Deepgram JSON frame and returns 0..2 messages
    /// for the receive loop. A `speech_final=true` frame carries
    /// both a stable chunk AND the end-of-turn signal — we emit
    /// `.final(...)` first so the accumulator captures the chunk,
    /// then `.speechFinal` so the loop calls stop().
    static func parse(text: String) -> [DeepgramSTTIncomingMessage] {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [] }
        // Deepgram's transcript frame shape:
        //   { type: "Results",
        //     channel: { alternatives: [{ transcript: "..." }] },
        //     is_final: Bool, speech_final: Bool, ... }
        let isFinal = obj["is_final"] as? Bool ?? false
        let speechFinal = obj["speech_final"] as? Bool ?? false

        var messages: [DeepgramSTTIncomingMessage] = []
        if let channel = obj["channel"] as? [String: Any],
           let alternatives = channel["alternatives"] as? [[String: Any]],
           let first = alternatives.first,
           let transcript = first["transcript"] as? String,
           !transcript.isEmpty
        {
            messages.append(isFinal ? .final(transcript) : .interim(transcript))
        }
        if speechFinal {
            messages.append(.speechFinal)
        }
        return messages
    }
}

// MARK: - Test stub

/// Test fake — drives downstream view-models without any
/// AVAudioEngine / Deepgram WebSocket instantiation. Preserved
/// across the SFSpeech → Deepgram swap so the existing
/// VoiceStateMachineTests run unchanged.
@MainActor
final class SpeechRecognitionStub: SpeechRecognitionServicing {
    var state: SpeechRecognitionState = .idle {
        didSet { if oldValue != state { stateContinuation?.yield(state) } }
    }
    let stateChange: AsyncStream<SpeechRecognitionState>
    private var stateContinuation: AsyncStream<SpeechRecognitionState>.Continuation?

    var nextPermission: SpeechPermissionResult = .granted
    var nextStartError: Error?

    init() {
        var c: AsyncStream<SpeechRecognitionState>.Continuation!
        self.stateChange = AsyncStream { c = $0 }
        self.stateContinuation = c
    }

    func ensurePermissions() async -> SpeechPermissionResult { nextPermission }

    func start() async throws {
        if let nextStartError {
            state = .error((nextStartError as? LocalizedError)?.errorDescription ?? "\(nextStartError)")
            throw nextStartError
        }
        state = .listening(partial: "")
    }

    func stop() {
        if case .listening(let partial) = state {
            state = partial.isEmpty ? .idle : .final(transcript: partial)
        }
    }

    func cancel() {
        state = .idle
    }

    /// Test helper — push a partial / final transcript through.
    func emitPartial(_ text: String) { state = .listening(partial: text) }
    func emitFinal(_ text: String) { state = .final(transcript: text) }
}
