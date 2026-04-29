import SwiftUI

/// Large circular push-to-talk button. Brand-cyan idle, animated
/// pulse when listening, scaled up under press. Sized for thumb reach
/// — 56pt outer, well above Apple's 44pt minimum tap target.
///
/// Two interaction modes are exposed via callbacks:
///   - `onTap` (regular tap) — single utterance, auto-stops on silence
///   - `onLongPressBegan` / `onLongPressEnded` — hold-to-talk
///
/// The host (ChatView's voice composer) decides which mode the user
/// is in by inspecting the gesture; this button just emits both
/// signals.

struct VoicePushToTalkButton: View {
    let isListening: Bool
    let isDisabled: Bool
    let onTap: () -> Void
    let onLongPressBegan: () -> Void
    let onLongPressEnded: () -> Void

    @State private var pulse = false
    @State private var isHolding = false

    var body: some View {
        ZStack {
            // Outer pulsing ring shows while listening.
            Circle()
                .stroke(LumoColors.cyan.opacity(0.45), lineWidth: 3)
                .frame(width: 64, height: 64)
                .scaleEffect(pulse ? 1.15 : 1.0)
                .opacity(isListening ? 1 : 0)
                .animation(
                    isListening
                        ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
                        : .easeOut(duration: 0.2),
                    value: pulse
                )

            // Solid button.
            Circle()
                .fill(buttonColor)
                .frame(width: 56, height: 56)
                .overlay(
                    Image(systemName: isListening ? "waveform" : "mic.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.white)
                )
                .scaleEffect(isHolding ? 1.08 : 1.0)
                .animation(LumoAnimation.quick, value: isHolding)
        }
        .accessibilityLabel(isListening ? "Stop voice input" : "Voice input")
        .accessibilityIdentifier("voice.pushToTalk")
        .accessibilityAddTraits(.isButton)
        .contentShape(Circle())
        .opacity(isDisabled ? 0.4 : 1.0)
        .allowsHitTesting(!isDisabled)
        .onTapGesture { onTap() }
        .gesture(
            LongPressGesture(minimumDuration: 0.25)
                .onEnded { _ in
                    isHolding = true
                    onLongPressBegan()
                }
                .sequenced(before: DragGesture(minimumDistance: 0).onEnded { _ in
                    if isHolding {
                        isHolding = false
                        onLongPressEnded()
                    }
                })
        )
        .onChange(of: isListening) { _, listening in
            pulse = listening
            if !listening { isHolding = false }
        }
    }

    private var buttonColor: Color {
        if isListening { return LumoColors.cyanDeep }
        return LumoColors.cyan
    }
}
