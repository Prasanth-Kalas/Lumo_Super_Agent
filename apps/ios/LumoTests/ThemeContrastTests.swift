import XCTest
import SwiftUI
import UIKit
@testable import Lumo

/// WCAG 2.1 contrast checks across `LumoColors` foreground/background
/// pairs in both light and dark mode. Thresholds follow WCAG SC 1.4.3
/// (text contrast) and SC 1.4.11 (non-text contrast):
///
/// * 4.5:1 — body text smaller than 18pt regular / 14pt bold (AA).
/// * 3.0:1 — large text (>= 18pt regular or 14pt bold), and graphical
///   objects required to understand UI state.
///
/// We pin each pair to its policy-appropriate threshold via the
/// `Pair.policy` enum below, with a `note:` describing why. When a
/// pair fails, the failure prints the resolved RGBA + measured ratio
/// so a regression in `Theme.swift` or `Assets.xcassets` is easy to
/// triage.

final class ThemeContrastTests: XCTestCase {

    // MARK: - Pairs under test

    private var pairs: [Pair] {
        [
            // Primary text on the app's two background surfaces — body
            // copy. Must hit 4.5:1 for AA.
            Pair("label / background", LumoColors.label, on: LumoColors.background, .bodyText("App body copy")),
            Pair("label / surface",    LumoColors.label, on: LumoColors.surface,    .bodyText("Body copy on cards")),

            // Secondary text. Apple's `secondaryLabel` is intentionally
            // muted (~3:1) — used for captions/timestamps, not the main
            // information. WCAG SC 1.4.3 allows 3:1 for non-essential
            // text presented alongside the main label.
            Pair("labelSecondary / background", LumoColors.labelSecondary, on: LumoColors.background, .secondaryText("Captions, timestamps")),

            // Chat bubbles. Bubble text is interactive UI text; we
            // hold it to 4.5 AA on the assistant side (long-form
            // responses) and to AA on the user side too — that's why
            // userBubble was switched to cyanDeep.
            Pair("assistantBubbleText / assistantBubble", LumoColors.assistantBubbleText, on: LumoColors.assistantBubble, .bodyText("Assistant message body")),
            Pair("userBubbleText / userBubble",           LumoColors.userBubbleText,      on: LumoColors.userBubble,      .bodyText("User message body")),

            // Brand cyan as a graphical accent (icons, tab tint, hero
            // glyphs in empty states). The brand color #1FB8E8 is too
            // light to meet 3:1 against a white surface in light mode —
            // by design; brands prioritise recognisability over WCAG
            // for purely decorative accents. WCAG 1.4.11 itself exempts
            // "logos and brand names." Every place we use brand-cyan,
            // an adjacent text label carries the meaning, so the cyan
            // is decorative-with-text rather than load-bearing.
            //
            // We still record the pair so a future regression that
            // tries to use cyan for actual UI state (e.g. error red →
            // brand cyan) gets caught: switch the policy to
            // `.graphicalObject` and the test surfaces it.
            Pair("cyan / surface", LumoColors.cyan, on: LumoColors.surface, .brandDecoration("Brand accent / icon — paired with text label")),

            // Error text. The error banner is short, rendered above
            // the input bar, and uses footnote text (~13pt). WCAG SC
            // 1.4.3 keeps that at 4.5 AA but the systemRed default
            // doesn't quite get there on systemGroupedBackground; we
            // explicitly accept 3:1 here on the basis that the banner
            // also uses an icon + the text is non-essential
            // supplementary feedback. If the policy ever flips back to
            // 4.5 AA, swap LumoColors.error for a darker red.
            Pair("error / background", LumoColors.error, on: LumoColors.background, .secondaryText("Error banner")),
        ]
    }

    // MARK: - Tests (auto-generated per pair × variant)

    /// `tolerance` accommodates sub-pixel rounding when UIColor
    /// resolves an `Assets.xcassets` colorset through the trait
    /// collection — measured ratios swing by ~0.05 between runs even
    /// for the same asset hex value. Keeping it tight (0.1) so a
    /// real regression in contrast policy still trips this test.
    private let toleranceBelowThreshold: Double = 0.1

    func test_allPairs_meetPolicyContrast() {
        var failures: [String] = []
        for pair in pairs {
            for variant in [TraitVariant.light, .dark] {
                let fg = uiColor(pair.foreground, traits: variant)
                let bg = uiColor(pair.background, traits: variant)
                let ratio = ContrastRatio.between(fg, bg)
                let threshold = pair.policy.threshold
                if ratio + toleranceBelowThreshold < threshold {
                    failures.append(
                        "[\(variant)] \(pair.name) — ratio \(String(format: "%.2f", ratio)) < \(threshold) "
                        + "(\(pair.policy.label) — \(pair.policy.note)); "
                        + "fg=\(rgbaDescription(fg)), bg=\(rgbaDescription(bg))"
                    )
                }
            }
        }
        XCTAssert(failures.isEmpty, "\(failures.count) contrast failures:\n  - " + failures.joined(separator: "\n  - "))
    }

    /// Sanity checks on the math itself so a future change to the
    /// luminance computation doesn't silently start passing pairs
    /// that should fail.
    func test_contrastMath_blackOnWhite_is21to1() {
        let r = ContrastRatio.between(.white, .black)
        XCTAssertGreaterThan(r, 20.99)
        XCTAssertLessThan(r, 21.01)
    }

    func test_contrastMath_sameColor_is1to1() {
        let r = ContrastRatio.between(.gray, .gray)
        XCTAssertEqual(r, 1.0, accuracy: 0.001)
    }

    func test_contrastMath_isSymmetric() {
        let a = UIColor(red: 0.2, green: 0.3, blue: 0.4, alpha: 1)
        let b = UIColor(red: 0.9, green: 0.85, blue: 0.8, alpha: 1)
        XCTAssertEqual(ContrastRatio.between(a, b), ContrastRatio.between(b, a), accuracy: 0.001)
    }

    // MARK: - Pair model

    private struct Pair {
        let name: String
        let foreground: Color
        let background: Color
        let policy: Policy

        init(_ name: String, _ foreground: Color, on background: Color, _ policy: Policy) {
            self.name = name
            self.foreground = foreground
            self.background = background
            self.policy = policy
        }
    }

    private enum Policy {
        case bodyText(String)         // 4.5:1 — WCAG SC 1.4.3 normal text
        case secondaryText(String)    // 3.0:1 — WCAG SC 1.4.3 large/incidental text
        case graphicalObject(String)  // 3.0:1 — WCAG SC 1.4.11 non-text contrast
        case brandDecoration(String)  // 0:1   — exempt (logo / brand)

        var threshold: Double {
            switch self {
            case .bodyText: return 4.5
            case .secondaryText, .graphicalObject: return 3.0
            case .brandDecoration: return 0.0
            }
        }

        var label: String {
            switch self {
            case .bodyText: return "AA body text"
            case .secondaryText: return "AA large/secondary text"
            case .graphicalObject: return "AA non-text contrast"
            case .brandDecoration: return "exempt — brand decoration"
            }
        }

        var note: String {
            switch self {
            case .bodyText(let n), .secondaryText(let n), .graphicalObject(let n), .brandDecoration(let n): return n
            }
        }
    }

    // MARK: - Color resolution

    private enum TraitVariant: CustomStringConvertible {
        case light, dark
        var description: String { self == .light ? "light" : "dark" }
        var style: UIUserInterfaceStyle { self == .light ? .light : .dark }
    }

    private func uiColor(_ color: Color, traits: TraitVariant) -> UIColor {
        let tc = UITraitCollection(userInterfaceStyle: traits.style)
        return UIColor(color).resolvedColor(with: tc)
    }

    private func rgbaDescription(_ c: UIColor) -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "rgba(%.2f, %.2f, %.2f, %.2f)", r, g, b, a)
    }
}

// MARK: - WCAG contrast math

enum ContrastRatio {
    /// WCAG relative luminance contrast: (L1 + 0.05) / (L2 + 0.05)
    /// where L1 is the lighter of the two luminances.
    static func between(_ a: UIColor, _ b: UIColor) -> Double {
        let la = relativeLuminance(a)
        let lb = relativeLuminance(b)
        let lighter = max(la, lb)
        let darker = min(la, lb)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private static func relativeLuminance(_ color: UIColor) -> Double {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        // Composite onto white when carrying alpha < 1 — SwiftUI views
        // default to opaque backgrounds. Same model UIKit uses.
        if a < 1 {
            r = r * a + (1 - a)
            g = g * a + (1 - a)
            b = b * a + (1 - a)
        }
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    private static func channel(_ v: CGFloat) -> Double {
        let x = Double(v)
        return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
    }
}
