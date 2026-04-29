import AVFoundation
import Foundation
import Speech

/// Apple Speech wrapper. Streams partial transcripts during recording
/// (so the UI can show "what you said" mid-utterance) and emits a final
/// transcript on stop. Auto-stops after a configurable silence window
/// — default 1.5s — so tap-to-talk feels natural without requiring the
/// user to tap stop.
///
/// The service is `@MainActor` because every public mutation flows
/// through SwiftUI bindings. Underlying `SFSpeechRecognizer` callbacks
/// hop back to MainActor before mutating state.

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
    /// Recognition wrapped up; final transcript is the canonical text
    /// the chat composer should send.
    case final(transcript: String)
    /// Permissions denied or revoked. UI shows a deep-link to Settings.
    case permissionDenied
    /// Hardware / network / framework error. UI surfaces the message;
    /// caller may retry.
    case error(String)
}

/// Result of the combined microphone + speech-recognition permission
/// dance. Either one can be denied independently of the other.
enum SpeechPermissionResult {
    case granted
    case microphoneDenied
    case speechRecognitionDenied
    case restrictedByDevice  // parental controls etc.
}

enum SpeechRecognitionError: Error, LocalizedError {
    case recognizerUnavailable
    case audioEngineFailed(String)
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            return "Speech recognition isn't available on this device or in this language."
        case .audioEngineFailed(let detail):
            return "Couldn't start the microphone: \(detail)"
        case .requestFailed(let detail):
            return "Speech recognition error: \(detail)"
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

    private let recognizer: SFSpeechRecognizer?
    private let audioSession: AudioSessionManager
    private let silenceThreshold: TimeInterval

    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTimer: Task<Void, Never>?

    init(
        locale: Locale = .current,
        audioSession: AudioSessionManager = .shared,
        silenceThreshold: TimeInterval = 1.5
    ) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
        self.audioSession = audioSession
        self.silenceThreshold = silenceThreshold
        var continuation: AsyncStream<SpeechRecognitionState>.Continuation!
        self.stateChange = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    // MARK: - Permissions

    func ensurePermissions() async -> SpeechPermissionResult {
        // Microphone first — speech recognition can't do anything
        // without it.
        let micGranted: Bool
        switch AVAudioApplication.shared.recordPermission {
        case .granted: micGranted = true
        case .denied:  return .microphoneDenied
        case .undetermined: micGranted = await audioSession.requestMicrophonePermission()
        @unknown default: micGranted = await audioSession.requestMicrophonePermission()
        }
        guard micGranted else { return .microphoneDenied }

        // Then speech-recognition. SFSpeechRecognizer.requestAuthorization
        // is callback-based; bridge to async.
        return await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                switch status {
                case .authorized:
                    cont.resume(returning: .granted)
                case .denied:
                    cont.resume(returning: .speechRecognitionDenied)
                case .restricted:
                    cont.resume(returning: .restrictedByDevice)
                case .notDetermined:
                    cont.resume(returning: .speechRecognitionDenied)
                @unknown default:
                    cont.resume(returning: .speechRecognitionDenied)
                }
            }
        }
    }

    // MARK: - Start / stop / cancel

    func start() async throws {
        guard let recognizer, recognizer.isAvailable else {
            state = .error(SpeechRecognitionError.recognizerUnavailable.localizedDescription)
            throw SpeechRecognitionError.recognizerUnavailable
        }

        // Stop anything in-flight before starting a new session.
        cancel()

        try audioSession.configureForVoiceConversation()

        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // On-device recognition where the device supports it — keeps
        // user audio off Apple's servers and removes the network round-
        // trip from the latency budget.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            throw SpeechRecognitionError.audioEngineFailed(error.localizedDescription)
        }

        self.audioEngine = engine
        self.recognitionRequest = request
        state = .listening(partial: "")

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // Hop to MainActor for state mutation.
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    self.state = .listening(partial: text)
                    self.armSilenceTimer(currentText: text)
                    if result.isFinal {
                        self.finalize(text: text)
                    }
                }
                if let error {
                    let nsErr = error as NSError
                    // 203 / 1110 / 1107 = user/no-speech "errors" that
                    // really just mean the user stopped talking. Treat
                    // them as a graceful end-of-turn rather than a
                    // failure.
                    let benign: Set<Int> = [203, 1110, 1107]
                    if benign.contains(nsErr.code) {
                        self.finalize(text: self.partialText)
                    } else {
                        self.state = .error(SpeechRecognitionError.requestFailed(error.localizedDescription).localizedDescription)
                        self.tearDown()
                    }
                }
            }
        }
    }

    func stop() {
        // Manual stop — finalize whatever partial we have.
        finalize(text: partialText)
    }

    func cancel() {
        silenceTimer?.cancel()
        silenceTimer = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        if let engine = audioEngine, engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        audioEngine = nil
        recognitionRequest = nil
    }

    // MARK: - Silence auto-stop

    private func armSilenceTimer(currentText: String) {
        silenceTimer?.cancel()
        silenceTimer = Task { [weak self, silenceThreshold] in
            try? await Task.sleep(nanoseconds: UInt64(silenceThreshold * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self else { return }
                if case .listening(let partial) = self.state, partial == currentText {
                    self.finalize(text: partial)
                }
            }
        }
    }

    // MARK: - Helpers

    private var partialText: String {
        if case .listening(let p) = state { return p }
        return ""
    }

    private func finalize(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Stop the audio engine + recognition task before flipping
        // state so the UI gets a clean signal.
        let request = recognitionRequest
        cancel()
        request?.endAudio()
        if trimmed.isEmpty {
            state = .idle
        } else {
            state = .final(transcript: trimmed)
        }
    }

    private func tearDown() {
        cancel()
    }
}

/// Test fake — drives downstream view-models without any
/// AVAudioEngine / SFSpeechRecognizer instantiation.
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
