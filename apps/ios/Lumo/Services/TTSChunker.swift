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
    ///
    /// Semantics:
    ///   * Wait until the buffer has at least `minChunkLength`
    ///     characters before considering a flush. Below that, the
    ///     buffer is "too short to make a natural-sounding TTS unit"
    ///     even if it ends in a terminator — let it accumulate.
    ///   * Once at or above the floor, flush up through the *latest*
    ///     sentence terminator in the buffer. This emits whole
    ///     multi-sentence runs in one chunk (good prosody) rather
    ///     than splitting them at every period.
    ///   * If the buffer is at or above `maxChunkLength` without any
    ///     terminator, force-flush at the last whitespace before the
    ///     ceiling. Bounds end-to-end TTS latency.
    private func nextChunkCut(in text: String) -> String.Index? {
        // Force-flush at max length first — it's a hard ceiling that
        // bounds latency for run-on text.
        if text.count >= maxChunkLength {
            let limit = text.index(text.startIndex, offsetBy: maxChunkLength)
            if let space = text[..<limit].lastIndex(where: { $0.isWhitespace }) {
                return text.index(after: space)
            }
            return limit
        }

        guard text.count >= minChunkLength else { return nil }

        // Walk backwards from the end looking for the latest terminator.
        var search = text.endIndex
        while search > text.startIndex {
            search = text.index(before: search)
            if Self.isSentenceTerminator(text[search]) {
                // Cut after the terminator and any trailing close-
                // quotes / whitespace that belong to the same sentence.
                var swept = text.index(after: search)
                while swept < text.endIndex,
                      let s = text[swept].unicodeScalars.first,
                      Self.followingPunctuation.contains(s) {
                    swept = text.index(after: swept)
                }
                return swept
            }
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
