import Foundation

/// Splits a stream of LLM text tokens into TTS-friendly chunks.
///
/// Why this exists: ElevenLabs Turbo will happily synthesize per-token
/// input but the resulting audio sounds choppy because the engine
/// re-prosodies on every push. Aggregating tokens into sentence-shaped
/// chunks (with a hard size ceiling so we don't wait forever for the
/// terminal punctuation in a long bullet point) gives natural-sounding
/// speech with minimal latency.
///
/// Strategy:
///   * Append every incoming chunk to a rolling buffer.
///   * Flush when the buffer ends with a sentence-terminating
///     punctuation (`.`, `!`, `?`, `…`, newline, em-dash) AND the
///     buffer is at or above `minChunkLength`.
///   * Force-flush when the buffer reaches `maxChunkLength` to keep
///     latency bounded.
///   * On stream completion, flush whatever remains regardless of
///     length.
///
/// `flush(text:)` is the only output channel — wire it to the TTS
/// service. The chunker is intentionally not @MainActor; it's a pure
/// state machine.

final class TTSChunker {
    private(set) var buffer: String = ""
    private let minChunkLength: Int
    private let maxChunkLength: Int
    private let onChunk: (String) -> Void

    init(
        minChunkLength: Int = 60,
        maxChunkLength: Int = 200,
        onChunk: @escaping (String) -> Void
    ) {
        precondition(minChunkLength > 0)
        precondition(maxChunkLength >= minChunkLength)
        self.minChunkLength = minChunkLength
        self.maxChunkLength = maxChunkLength
        self.onChunk = onChunk
    }

    /// Feed a token (or many tokens — the caller doesn't have to align
    /// boundaries). Emits zero or more chunks via `onChunk`.
    func append(_ text: String) {
        guard !text.isEmpty else { return }
        buffer += text
        flushReadyChunks()
    }

    /// Stream is finished. Flush whatever's left.
    func finish() {
        let remainder = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
        buffer = ""
        if !remainder.isEmpty {
            onChunk(remainder)
        }
    }

    /// Discard the buffered tokens without emitting (e.g. user
    /// cancelled mid-stream).
    func reset() {
        buffer = ""
    }

    // MARK: - Internals

    private func flushReadyChunks() {
        // Flush at sentence boundaries that satisfy minChunkLength.
        while let cut = nextChunkCut(in: buffer) {
            let chunk = String(buffer[..<cut]).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer = String(buffer[cut...])
            if !chunk.isEmpty {
                onChunk(chunk)
            }
        }
    }

    /// Find the index *after* the next valid chunk boundary, or nil if
    /// the buffer doesn't yet have a flushable chunk.
    private func nextChunkCut(in text: String) -> String.Index? {
        // Force-flush at max length.
        if text.count >= maxChunkLength {
            // Cut at the last whitespace before the limit if possible
            // so we don't split mid-word.
            let limit = text.index(text.startIndex, offsetBy: maxChunkLength)
            if let space = text[..<limit].lastIndex(where: { $0.isWhitespace }) {
                return text.index(after: space)
            }
            return limit
        }

        // Otherwise look for a sentence-end boundary >= minChunkLength.
        guard text.count >= minChunkLength else { return nil }
        let earliest = text.index(text.startIndex, offsetBy: minChunkLength)
        var idx = earliest
        while idx < text.endIndex {
            let ch = text[idx]
            if Self.isSentenceTerminator(ch) {
                let next = text.index(after: idx)
                // Include the punctuation in the chunk — and any
                // trailing whitespace/quotes that belong to the same
                // sentence.
                var swept = next
                while swept < text.endIndex,
                      let s = text[swept].unicodeScalars.first,
                      Self.followingPunctuation.contains(s) {
                    swept = text.index(after: swept)
                }
                return swept
            }
            idx = text.index(after: idx)
        }
        return nil
    }

    private static let followingPunctuation: Set<Unicode.Scalar> = [
        " ", "\n", "\t", "\"", "'", "”", "’", ")", "]", "}"
    ]

    private static func isSentenceTerminator(_ c: Character) -> Bool {
        switch c {
        case ".", "!", "?", "…", "\n":
            return true
        default:
            return false
        }
    }
}
