import Foundation

/// Local-only receipt persistence for MOBILE-PAYMENTS-1.
///
/// Stores `Receipt` records as JSON under `Application Support/Lumo/
/// receipts.json`. v1 ships local-only — the server-side
/// `transactions` table that MERCHANT-1 ships will be the eventual
/// source of truth, with this local store becoming a write-through
/// cache + offline-history surface.
///
/// Single store per process, single user (we don't have multi-user
/// switching on the same device). Atomic writes via `Data.write(to:
/// options: .atomic)`.

protocol ReceiptStoring {
    func load() throws -> [Receipt]
    func append(_ receipt: Receipt) throws
    func clear() throws
}

enum ReceiptStoreError: Error, LocalizedError {
    case decodingFailed(String)
    case writeFailed(String)

    var errorDescription: String? {
        switch self {
        case .decodingFailed(let detail):
            return "Failed to read receipts: \(detail)."
        case .writeFailed(let detail):
            return "Failed to save receipt: \(detail)."
        }
    }
}

final class ReceiptStore: ReceiptStoring {
    private let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// Default store backed by `Application Support/Lumo/receipts.json`.
    /// The directory is created lazily on first write.
    static func makeDefault() -> ReceiptStore {
        let fm = FileManager.default
        let support: URL
        do {
            support = try fm.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
        } catch {
            // Tmp fallback; persistence becomes session-volatile but the
            // store still functions. Useful in test/sandbox contexts.
            support = fm.temporaryDirectory
        }
        let dir = support.appendingPathComponent("Lumo", isDirectory: true)
        return ReceiptStore(fileURL: dir.appendingPathComponent("receipts.json"))
    }

    func load() throws -> [Receipt] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return []
        }
        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch {
            throw ReceiptStoreError.decodingFailed(error.localizedDescription)
        }
        guard !data.isEmpty else { return [] }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let envelope = try decoder.decode(ReceiptStoreFile.self, from: data)
            return envelope.receipts
        } catch {
            throw ReceiptStoreError.decodingFailed(String(describing: error))
        }
    }

    func append(_ receipt: Receipt) throws {
        var current = (try? load()) ?? []
        // De-dupe by transaction id — confirm-transaction is supposed to
        // be idempotent on retry; we don't double-record the same txn.
        if !current.contains(where: { $0.transactionId == receipt.transactionId }) {
            current.insert(receipt, at: 0)
        }
        try write(current)
    }

    func clear() throws {
        try write([])
    }

    private func write(_ receipts: [Receipt]) throws {
        let dir = fileURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: true
            )
        } catch {
            throw ReceiptStoreError.writeFailed(error.localizedDescription)
        }
        let envelope = ReceiptStoreFile(version: 1, receipts: receipts)
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(envelope)
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            throw ReceiptStoreError.writeFailed(error.localizedDescription)
        }
    }
}

private struct ReceiptStoreFile: Codable {
    let version: Int
    let receipts: [Receipt]
}

/// In-memory store for tests + previews.
final class ReceiptStoreStub: ReceiptStoring {
    private(set) var receipts: [Receipt] = []
    var nextError: Error?

    init(seed: [Receipt] = []) {
        self.receipts = seed
    }

    func load() throws -> [Receipt] {
        if let err = nextError { nextError = nil; throw err }
        return receipts
    }

    func append(_ receipt: Receipt) throws {
        if let err = nextError { nextError = nil; throw err }
        if !receipts.contains(where: { $0.transactionId == receipt.transactionId }) {
            receipts.insert(receipt, at: 0)
        }
    }

    func clear() throws {
        if let err = nextError { nextError = nil; throw err }
        receipts = []
    }
}
