import SwiftUI

/// Lightweight markdown renderer for assistant messages. Handles:
///   - inline bold (**text**), italic (*text* or _text_), and code (`text`)
///   - fenced code blocks (```... ```)
///   - bullet lists (- or *)
///   - links ([label](url))
///
/// Built on Apple's `AttributedString(markdown:)` initializer for inline
/// elements, with a custom block parser for code fences and lists. The
/// goal is "good enough for chat" not "full CommonMark" — a future sprint
/// can swap in a real renderer if the orchestrator starts emitting more
/// exotic syntax.

struct MarkdownRenderer: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: LumoSpacing.sm) {
            ForEach(Array(blocks(from: text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let attr):
                    Text(attr)
                        .textSelection(.enabled)
                case .codeBlock(let body, let language):
                    codeBlock(body: body, language: language)
                case .bulletList(let items):
                    VStack(alignment: .leading, spacing: LumoSpacing.xs) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .top, spacing: LumoSpacing.sm) {
                                Text("•").foregroundStyle(LumoColors.labelSecondary)
                                Text(item).textSelection(.enabled)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func codeBlock(body: String, language: String?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(LumoFonts.caption)
                    .foregroundStyle(LumoColors.labelSecondary)
                    .padding(.horizontal, LumoSpacing.sm)
                    .padding(.vertical, LumoSpacing.xs)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(body)
                    .font(LumoFonts.monospaceCode)
                    .textSelection(.enabled)
                    .padding(LumoSpacing.sm)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: LumoRadius.sm)
                .fill(LumoColors.surfaceElevated)
        )
    }

    // MARK: - Block parser

    fileprivate enum Block {
        case paragraph(AttributedString)
        case codeBlock(body: String, language: String?)
        case bulletList(items: [AttributedString])
    }

    fileprivate func blocks(from text: String) -> [Block] {
        var result: [Block] = []
        let lines = text.components(separatedBy: "\n")
        var i = 0
        var paragraphBuffer: [String] = []
        var bulletBuffer: [String] = []

        func flushParagraph() {
            if !paragraphBuffer.isEmpty {
                let combined = paragraphBuffer.joined(separator: " ")
                result.append(.paragraph(Self.attributedInline(combined)))
                paragraphBuffer.removeAll()
            }
        }

        func flushBullets() {
            if !bulletBuffer.isEmpty {
                result.append(.bulletList(items: bulletBuffer.map(Self.attributedInline)))
                bulletBuffer.removeAll()
            }
        }

        while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                flushParagraph()
                flushBullets()
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var bodyLines: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    bodyLines.append(lines[i])
                    i += 1
                }
                result.append(.codeBlock(
                    body: bodyLines.joined(separator: "\n"),
                    language: language.isEmpty ? nil : language
                ))
                if i < lines.count { i += 1 }  // skip closing fence
                continue
            }

            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                flushParagraph()
                bulletBuffer.append(String(trimmed.dropFirst(2)))
                i += 1
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                flushBullets()
                i += 1
                continue
            }

            flushBullets()
            paragraphBuffer.append(trimmed)
            i += 1
        }

        flushParagraph()
        flushBullets()
        return result
    }

    static func attributedInline(_ source: String) -> AttributedString {
        // AttributedString's markdown initializer handles **, *, _, `,
        // and [label](url). It throws on malformed input — fall back to
        // plain text so we never blow up rendering.
        if let attr = try? AttributedString(
            markdown: source,
            options: AttributedString.MarkdownParsingOptions(
                allowsExtendedAttributes: false,
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) {
            return attr
        }
        return AttributedString(source)
    }
}
