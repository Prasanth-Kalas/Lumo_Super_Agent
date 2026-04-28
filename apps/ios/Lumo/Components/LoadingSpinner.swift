import SwiftUI

/// Indeterminate progress indicator that sizes to its container. Used
/// while the chat stream is in flight, while auth is round-tripping,
/// etc.

struct LoadingSpinner: View {
    var label: String?
    var tint: Color = LumoColors.cyan

    var body: some View {
        VStack(spacing: LumoSpacing.sm) {
            ProgressView()
                .progressViewStyle(.circular)
                .tint(tint)
            if let label {
                Text(label)
                    .font(LumoFonts.footnote)
                    .foregroundStyle(LumoColors.labelSecondary)
            }
        }
    }
}

/// Three animated dots — used as the assistant typing indicator while
/// a stream is open but no tokens have arrived yet.
struct TypingIndicator: View {
    @State private var phase: Int = 0
    private let timer = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: LumoSpacing.xs) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(LumoColors.labelSecondary)
                    .frame(width: 6, height: 6)
                    .opacity(phase == index ? 1 : 0.3)
                    .animation(LumoAnimation.standard, value: phase)
            }
        }
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
        .accessibilityLabel("Lumo is typing")
    }
}
