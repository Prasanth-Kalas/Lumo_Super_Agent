import SwiftUI

/// Single source of truth for design tokens. UI code reads colors,
/// fonts, spacing, radii, and animation timing from these enums.
/// Hardcoding hex values, font sizes, or spacing literals at call
/// sites is a code smell in this app — promote to a token first.

enum LumoColors {
    // Brand
    static let cyan = Color("LumoCyan")            // primary brand cyan
    static let cyanDeep = Color("LumoCyanDeep")    // darker accent (wordmark fold)

    // Surfaces — IOS-MIRROR-WEB-1 ports the exact hex values from
    // apps/web/app/globals.css so iOS matches web's dark-first
    // posture. Light variants come from the same file's
    // `[data-theme="light"]` block.
    static let background = Color("LumoBg")          // page canvas
    static let surface = Color("LumoSurface")        // cards, composer, sidebars
    static let surfaceElevated = Color("LumoElevated") // hover states, popovers
    static let separator = Color("LumoHair")         // 1px hairlines

    // Foreground
    static let label = Color("LumoFg")               // primary body
    static let labelSecondary = Color("LumoFgMid")   // captions, secondary
    static let labelTertiary = Color("LumoFgLow")    // tertiary / disabled

    // Semantic — kept on UIKit system colors. Web's --lumo-ok / -warn
    // / -err map to the same Material accent palette these resolve to,
    // so the visual diff is sub-perceptual and the system colors give
    // automatic high-contrast / accessibility variants for free.
    static let error = Color(.systemRed)
    static let warning = Color(.systemOrange)
    static let success = Color(.systemGreen)

    // Chat-specific
    //
    // userBubble uses `cyanDeep` (the darker brand cyan) rather than
    // the primary `cyan`. The primary cyan is too light to give white
    // text the WCAG AA contrast (4.5:1) it needs at body size; the
    // deep variant is calibrated for it. See ThemeContrastTests.
    static let userBubble = cyanDeep
    static let userBubbleText = Color.white
    static let assistantBubble = Color("LumoElevated")
    static let assistantBubbleText = Color("LumoFg")
}

enum LumoFonts {
    // All sizes derived from system text styles so Dynamic Type scales correctly.
    static let largeTitle: Font = .largeTitle.weight(.bold)
    static let title: Font = .title2.weight(.semibold)
    static let headline: Font = .headline
    static let body: Font = .body
    static let bodyEmphasized: Font = .body.weight(.medium)
    static let callout: Font = .callout
    static let footnote: Font = .footnote
    static let caption: Font = .caption
    static let monospaceCode: Font = .system(.callout, design: .monospaced)
    static let monospaceInline: Font = .system(.body, design: .monospaced)
}

enum LumoSpacing {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let xxxl: CGFloat = 48
}

enum LumoRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let bubble: CGFloat = 20
    static let full: CGFloat = 999
}

enum LumoAnimation {
    static let quick: Animation = .easeInOut(duration: 0.15)
    static let standard: Animation = .easeInOut(duration: 0.25)
    static let smooth: Animation = .spring(response: 0.4, dampingFraction: 0.85)
}
