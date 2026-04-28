import SwiftUI

/// Three button styles. Use the modifier form on a SwiftUI Button:
///   Button("Send") { ... }.buttonStyle(.lumoPrimary)

struct LumoPrimaryButtonStyle: ButtonStyle {
    var isLoading: Bool = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        ZStack {
            configuration.label
                .font(LumoFonts.bodyEmphasized)
                .opacity(isLoading ? 0 : 1)
            if isLoading {
                ProgressView().tint(LumoColors.userBubbleText)
            }
        }
        .foregroundStyle(LumoColors.userBubbleText)
        .padding(.horizontal, LumoSpacing.lg)
        .padding(.vertical, LumoSpacing.md)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.md)
                .fill(isEnabled ? LumoColors.cyan : LumoColors.labelTertiary)
        )
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .animation(LumoAnimation.quick, value: configuration.isPressed)
    }
}

struct LumoSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(LumoFonts.bodyEmphasized)
            .foregroundStyle(isEnabled ? LumoColors.cyan : LumoColors.labelTertiary)
            .padding(.horizontal, LumoSpacing.lg)
            .padding(.vertical, LumoSpacing.md)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: LumoRadius.md)
                    .stroke(isEnabled ? LumoColors.cyan : LumoColors.labelTertiary, lineWidth: 1.5)
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(LumoAnimation.quick, value: configuration.isPressed)
    }
}

struct LumoPlainButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(LumoFonts.bodyEmphasized)
            .foregroundStyle(LumoColors.cyan)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .animation(LumoAnimation.quick, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == LumoPrimaryButtonStyle {
    static var lumoPrimary: LumoPrimaryButtonStyle { .init() }
    static func lumoPrimary(loading: Bool) -> LumoPrimaryButtonStyle { .init(isLoading: loading) }
}

extension ButtonStyle where Self == LumoSecondaryButtonStyle {
    static var lumoSecondary: LumoSecondaryButtonStyle { .init() }
}

extension ButtonStyle where Self == LumoPlainButtonStyle {
    static var lumoPlain: LumoPlainButtonStyle { .init() }
}
