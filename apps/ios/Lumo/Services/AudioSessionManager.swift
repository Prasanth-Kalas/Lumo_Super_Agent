import AVFoundation
import Foundation

/// Centralised AVAudioSession management for voice flows.
///
/// We use `.playAndRecord` so a single session covers both the user's
/// microphone capture and the assistant's TTS playback — switching
/// transparently between record and playback as the conversation
/// alternates. `.duckOthers` lowers other audio (Spotify, Apple
/// Music, podcast apps) while Lumo is speaking, then restores it.
///
/// The manager is a singleton because there's exactly one
/// AVAudioSession.sharedInstance() and racing two configurers across
/// the app would just toggle the route options against each other.

final class AudioSessionManager {
    static let shared = AudioSessionManager()

    private let session: AVAudioSession
    private var configured = false

    init(session: AVAudioSession = .sharedInstance()) {
        self.session = session
    }

    /// Configure once before the first record/playback. Idempotent.
    func configureForVoiceConversation() throws {
        guard !configured else { return }
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.duckOthers, .defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: [])
        configured = true
    }

    /// Tear down — used by tests and on explicit "exit voice mode."
    /// In normal use the session stays active for the app lifetime.
    func deactivate() {
        configured = false
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// True if the user has granted microphone permission. With
    /// Deepgram replacing the old recognizer, only microphone access
    /// is strictly needed; the separate speech-recognition permission
    /// has been removed.
    var hasMicrophonePermission: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    /// Modern iOS 17+ permission API. Resolves false on denial.
    func requestMicrophonePermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }
}
