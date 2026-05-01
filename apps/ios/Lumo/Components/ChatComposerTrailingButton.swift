import SwiftUI

/// Single-button trailing affordance for the chat composer. Mirrors
/// the WhatsApp / Telegram / Signal pattern: one icon, content-aware.
///
///   • Empty input        → mic icon (tap → voice mode)
///   • Listening          → waveform icon (pulsing — long-press in
///                          progress, or tap-to-stop a listening
///                          session)
///   • Non-empty input    → paperplane icon (tap → submit message)
///
/// The mode-pick logic lives in `Mode.from(input:isListening:)` as a
/// pure helper so it's directly unit-testable without rendering the
/// view. Listening always wins — once the mic is open, we don't want
/// the icon to flicker to send the moment a partial transcript starts
/// populating the text field.
///
/// Listening behaviour layered on top of mode:
///   • Tap when in `.mic`       → onTap (voice composer's
///                                tap-to-talk path)
///   • Tap when in `.waveform`  → onTap (voice composer's stop path)
///   • Tap when in `.send`      → onTap (submit handler)
///   • Long-press hold/release  → onLongPressBegan / onLongPressEnded
///                                (push-to-talk; suppressed in `.send`
///                                mode by the parent so a long press on
///                                a populated field doesn't start
///                                voice)
///
/// Sized to fit beside the text field — 36pt round, well above
/// Apple's 44pt minimum tap target via SwiftUI's button hit-test
/// padding.
struct ChatComposerTrailingButton: View {
    enum Mode: Equatable {
        case mic
        case waveform
        case send

        static func from(input: String, isListening: Bool) -> Mode {
            if isListening { return .waveform }
            let trimmed = input.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? .mic : .send
        }

        var systemImage: String {
            switch self {
            case .mic: return "mic.fill"
            case .waveform: return "waveform"
            case .send: return "paperplane.fill"
            }
        }

        var accessibilityLabel: String {
            switch self {
            case .mic: return "Start voice"
            case .waveform: return "Listening — tap to stop"
            case .send: return "Send message"
            }
        }

        var accessibilityIdentifier: String {
            switch self {
            case .mic: return "chat.composer.mic"
            case .waveform: return "chat.composer.listening"
            case .send: return "chat.send"
            }
        }
    }

    let mode: Mode
    let isDisabled: Bool
    let onTap: () -> Void
    let onLongPressBegan: () -> Void
    let onLongPressEnded: () -> Void

    @State private var pulse = false
    @State private var isHolding = false

    var body: some View {
        ZStack {
            Circle()
                .fill(buttonFill)
                .frame(width: 36, height: 36)
                .overlay(
                    Image(systemName: mode.systemImage)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                )
                .scaleEffect(isHolding ? 1.08 : (pulse && mode == .waveform ? 1.05 : 1.0))
                .animation(LumoAnimation.quick, value: isHolding)
                .animation(
                    mode == .waveform
                        ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
                        : .easeOut(duration: 0.2),
                    value: pulse
                )
        }
        .contentShape(Rectangle())
        .frame(width: 44, height: 44)
        .gesture(
            LongPressGesture(minimumDuration: 0.18)
                .onChanged { _ in
                    guard !isDisabled, mode != .send else { return }
                    if !isHolding {
                        isHolding = true
                        onLongPressBegan()
                    }
                }
                .onEnded { _ in
                    if isHolding {
                        isHolding = false
                        onLongPressEnded()
                    }
                }
                .simultaneously(
                    with: TapGesture().onEnded {
                        guard !isDisabled, !isHolding else { return }
                        onTap()
                    }
                )
        )
        .opacity(isDisabled ? 0.5 : 1)
        .accessibilityLabel(Text(mode.accessibilityLabel))
        .accessibilityIdentifier(mode.accessibilityIdentifier)
        .accessibilityAddTraits(.isButton)
        .onAppear {
            if mode == .waveform { pulse = true }
        }
        .onChange(of: mode) { _, newValue in
            pulse = newValue == .waveform
        }
    }

    private var buttonFill: Color {
        if isDisabled { return LumoColors.labelTertiary }
        return LumoColors.cyan
    }
}
