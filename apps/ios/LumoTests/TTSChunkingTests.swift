import XCTest
@testable import Lumo

/// Verify the TTSChunker produces sentence-shaped chunks rather than
/// per-token snippets, with both the "min length + sentence boundary"
/// and the "force-flush at max length" paths exercised. The chunker
/// is intentionally pure (no main-actor isolation) so these tests
/// run synchronously without a runloop.

final class TTSChunkingTests: XCTestCase {

    private func collect(_ feed: [String], min: Int = 60, max: Int = 200) -> [String] {
        var out: [String] = []
        let chunker = TTSChunker(minChunkLength: min, maxChunkLength: max) { out.append($0) }
        for piece in feed { chunker.append(piece) }
        chunker.finish()
        return out
    }

    // MARK: - Sentence-boundary path

    func test_singleSentence_longerThanMin_emittedOnPunctuation() {
        let chunks = collect(
            ["I'll book ", "the flight for ", "Tuesday morning at 7 AM", "."]
        )
        XCTAssertEqual(chunks, ["I'll book the flight for Tuesday morning at 7 AM."])
    }

    func test_twoSentences_eachExceedingMin_emittedSeparately() {
        // With min=8 and per-character feed, each sentence on its own
        // exceeds min. The chunker emits each at its terminator —
        // good prosody and bounded TTS latency.
        let text = "Booked the flight. Hotel is next on the list, finalising now."
        let pieces = text.map { String($0) }
        let chunks = collect(pieces, min: 8, max: 200)
        XCTAssertEqual(chunks.count, 2)
        XCTAssertEqual(chunks[0], "Booked the flight.")
        XCTAssertEqual(chunks[1], "Hotel is next on the list, finalising now.")
    }

    func test_shortSentencesBelowMin_aggregatedUntilMinHit() {
        // "Yes." "OK." "Done." individually are below the min length
        // floor of 60 — the chunker should aggregate them rather than
        // emit single-word chunks. The whole stream becomes one chunk
        // because all sentences fit before the buffer hits the
        // min-length threshold and the next terminator is the very
        // last char of the buffer.
        let chunks = collect(["Yes.", " OK.", " Done.", " Booked the flight, hotel, and ground transport."])
        XCTAssertEqual(chunks.count, 1)
        XCTAssertTrue(chunks[0].hasPrefix("Yes. OK."))
        XCTAssertTrue(chunks[0].hasSuffix("transport."))
    }

    func test_singleLongSentenceArrivesAfterMinHit_emittedImmediately() {
        // First sentence longer than min on its own. Buffer reaches
        // min mid-sentence; once the terminator arrives, flush.
        let text = "This is a single sentence that's longer than the min chunk length floor."
        let pieces = text.map { String($0) }
        let chunks = collect(pieces, min: 30, max: 200)
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0], text)
    }

    // MARK: - Max-length force-flush path

    func test_runOnText_withoutSentenceTerminator_forceFlushesAtMax() {
        let runOn = String(repeating: "word ", count: 80)  // 400 chars no punctuation
        let chunks = collect([runOn], min: 60, max: 200)
        XCTAssertGreaterThan(chunks.count, 1)
        // No chunk should exceed max + 1 (we cut at last whitespace
        // before the limit, which can include the trailing space).
        for c in chunks {
            XCTAssertLessThanOrEqual(c.count, 200)
        }
    }

    func test_forceFlush_prefersWordBoundary() {
        let text = "supercalifragilisticexpialidocious " + String(repeating: "x", count: 250)
        let chunks = collect([text], min: 30, max: 50)
        // The first chunk should be just the long word (split at the
        // word boundary), not split mid-word.
        XCTAssertEqual(chunks.first, "supercalifragilisticexpialidocious")
    }

    // MARK: - Finish/reset/edge cases

    func test_finish_flushesTrailingPartialBelowMin() {
        let chunks = collect(["Booked"])  // 6 chars, below min
        XCTAssertEqual(chunks, ["Booked"])
    }

    func test_reset_dropsBufferedTokens() {
        var emitted: [String] = []
        let chunker = TTSChunker(minChunkLength: 60, maxChunkLength: 200) { emitted.append($0) }
        chunker.append("This is a partial that hasn't reached min length yet")
        chunker.reset()
        chunker.finish()
        XCTAssertTrue(emitted.isEmpty)
    }

    func test_emptyFeed_emitsNothing() {
        XCTAssertTrue(collect([]).isEmpty)
    }

    func test_whitespaceOnly_dropped() {
        let chunks = collect(["   ", "\n\n", "\t"])
        XCTAssertTrue(chunks.isEmpty)
    }

    // MARK: - Real-world LLM-shaped stream

    func test_realisticLlmStream_producesNaturalChunks() {
        // Simulate token-by-token streaming of a realistic assistant
        // reply. Token sizes intentionally varied.
        let tokens = [
            "Plan", "ned", " a", " round", "-", "trip", " to", " Vegas",
            " May", " 5", "-", "12", ".", " J", "FK", "→", "L", "AS",
            " on", " Tuesday", " morning", ",", " ais", "le", " seat",
            ",", " $", "340", ".", " Cosmo", "politan", " for", " $",
            "215", "/night", ".", " Total", " $", "1", ",", "925",
            ".", " Want", " me", " to", " book", "?",
        ]
        let chunks = collect(tokens, min: 50, max: 200)
        XCTAssertGreaterThan(chunks.count, 1, "expected multiple sentences")
        XCTAssertTrue(chunks.first?.hasSuffix(".") == true || chunks.first?.hasSuffix(",") == true)
        XCTAssertTrue(chunks.last?.hasSuffix("?") == true || chunks.last?.contains("book") == true)
    }
}
