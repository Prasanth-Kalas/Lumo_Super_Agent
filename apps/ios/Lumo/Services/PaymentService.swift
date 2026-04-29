import Foundation

/// HTTP client for `/api/payments/*` plus protocol seam for tests.
///
/// In v1 (MOBILE-PAYMENTS-1) the backend is stubbed and this service
/// drives a synthetic add-card flow. The Stripe PaymentSheet hookup is
/// wired (the SDK is linked, the publishable key flows through
/// `AppConfig`) but inert — `createSetupIntent` returns
/// `clientSecret == nil`, so the iOS UI knows to render its synthetic
/// add-card sheet rather than invoking real PaymentSheet (which would
/// fail without a real client_secret from a server-side Stripe API
/// call). MERCHANT-1 flips on the real path.

// MARK: - Models

enum CardBrand: String, Codable, Equatable, CaseIterable {
    case visa
    case mastercard
    case amex
    case discover
    case unknown

    var displayName: String {
        switch self {
        case .visa: return "Visa"
        case .mastercard: return "Mastercard"
        case .amex: return "American Express"
        case .discover: return "Discover"
        case .unknown: return "Card"
        }
    }

    /// Detect brand from a card-number prefix using the standard IIN
    /// ranges. We only need rough buckets — the real authority lives on
    /// Stripe's server.
    static func detect(fromCardNumber number: String) -> CardBrand {
        let digits = number.filter(\.isNumber)
        guard !digits.isEmpty else { return .unknown }
        if digits.first == "4" { return .visa }
        if let prefix2 = Int(digits.prefix(2)) {
            if (51...55).contains(prefix2) { return .mastercard }
            if [34, 37].contains(prefix2) { return .amex }
        }
        if let prefix4 = Int(digits.prefix(4)),
           (2221...2720).contains(prefix4) {
            return .mastercard
        }
        if digits.hasPrefix("6011") || digits.hasPrefix("65") {
            return .discover
        }
        return .unknown
    }
}

struct PaymentMethod: Codable, Identifiable, Equatable {
    let id: String
    let brand: CardBrand
    let last4: String
    let expMonth: Int
    let expYear: Int
    let isDefault: Bool
    let addedAt: Date

    var expirationLabel: String {
        String(format: "%02d/%02d", expMonth, expYear % 100)
    }
}

struct LineItem: Codable, Equatable {
    let label: String
    let amountCents: Int
}

enum ReceiptStatus: String, Codable, Equatable {
    case succeeded
    case failed
}

struct Receipt: Codable, Identifiable, Equatable {
    let id: String
    let transactionId: String
    let amountCents: Int
    let currency: String
    let paymentMethodId: String
    let paymentMethodLabel: String
    let lineItems: [LineItem]
    let createdAt: Date
    let status: ReceiptStatus
}

struct SetupIntentResponse: Codable, Equatable {
    let stub: Bool
    let setupIntentId: String
    let clientSecret: String?
    let customerId: String
}

struct AddPaymentMethodInput: Equatable {
    let brand: CardBrand
    let last4: String
    let expMonth: Int
    let expYear: Int
}

struct ConfirmTransactionInput: Equatable {
    let amountCents: Int
    let currency: String
    let paymentMethodId: String
    let lineItems: [LineItem]
    /// Hash of the canonical transaction payload the user is authorizing
    /// (line items + total + payment method). The biometric prompt
    /// signs over this digest so a tampered-with payload can't reuse a
    /// valid signature.
    let transactionDigest: Data
    /// Base64-or-hex-encoded signature returned by
    /// BiometricConfirmationService.requestConfirmation.
    let signedConfirmationToken: Data
}

// MARK: - Errors

enum PaymentServiceError: Error, LocalizedError, Equatable {
    case notConfigured
    case invalidBaseURL
    case missingUser
    case badStatus(Int, String?)
    case decodingFailed(String)
    case applePayUnavailable

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Payments are not configured. Add LUMO_STRIPE_PUBLISHABLE_KEY_TEST to your env."
        case .invalidBaseURL:
            return "Invalid LumoAPIBase URL."
        case .missingUser:
            return "Sign in before using Payments."
        case .badStatus(let code, let body):
            return "Payments server returned HTTP \(code)\(body.map { ": \($0)" } ?? "")."
        case .decodingFailed(let detail):
            return "Failed to decode payments response: \(detail)."
        case .applePayUnavailable:
            return "Apple Pay isn't available on this device."
        }
    }
}

// MARK: - Protocol

protocol PaymentServicing {
    func createSetupIntent() async throws -> SetupIntentResponse
    /// For v1 this records a synthetic added card. The function name
    /// matches the brief (`presentPaymentSheet`); the actual sheet
    /// presentation lives in the SwiftUI layer (PaymentMethodsView)
    /// because PaymentService is intentionally UI-free for testability.
    func presentPaymentSheet(input: AddPaymentMethodInput) async throws -> PaymentMethod
    func listPaymentMethods() async throws -> [PaymentMethod]
    func setDefaultPaymentMethod(id: String) async throws -> PaymentMethod
    func removePaymentMethod(id: String) async throws
    func confirmTransaction(_ input: ConfirmTransactionInput) async throws -> Receipt
}

// MARK: - Real implementation

final class PaymentService: PaymentServicing {
    private let baseURL: URL
    private let session: URLSession
    private let userIDProvider: () -> String?
    private let isConfigured: Bool

    init(
        baseURL: URL,
        userIDProvider: @escaping () -> String?,
        isConfigured: Bool,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.session = session
        self.userIDProvider = userIDProvider
        self.isConfigured = isConfigured
    }

    static func make(config: AppConfig, userIDProvider: @escaping () -> String?) -> PaymentService {
        PaymentService(
            baseURL: config.apiBaseURL,
            userIDProvider: userIDProvider,
            isConfigured: config.isStripeConfigured
        )
    }

    func createSetupIntent() async throws -> SetupIntentResponse {
        try ensureConfigured()
        let req = try makeRequest(path: "api/payments/setup-intent", method: "POST")
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response)
        return try decode(SetupIntentResponse.self, from: data)
    }

    func presentPaymentSheet(input: AddPaymentMethodInput) async throws -> PaymentMethod {
        try ensureConfigured()
        let body: [String: Any] = [
            "brand": input.brand.rawValue,
            "last4": input.last4,
            "expMonth": input.expMonth,
            "expYear": input.expYear,
        ]
        let req = try makeRequest(
            path: "api/payments/methods",
            method: "POST",
            jsonBody: body
        )
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response, expected: 201)
        struct AddMethodResponse: Codable { let method: PaymentMethod }
        let decoded = try decode(AddMethodResponse.self, from: data)
        return decoded.method
    }

    func listPaymentMethods() async throws -> [PaymentMethod] {
        try ensureConfigured()
        let req = try makeRequest(path: "api/payments/methods", method: "GET")
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response)
        struct ListResponse: Codable { let methods: [PaymentMethod] }
        return try decode(ListResponse.self, from: data).methods
    }

    func setDefaultPaymentMethod(id: String) async throws -> PaymentMethod {
        try ensureConfigured()
        let req = try makeRequest(
            path: "api/payments/methods/\(id)/set-default",
            method: "POST"
        )
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response)
        struct DefaultResponse: Codable { let method: PaymentMethod }
        return try decode(DefaultResponse.self, from: data).method
    }

    func removePaymentMethod(id: String) async throws {
        try ensureConfigured()
        let req = try makeRequest(
            path: "api/payments/methods/\(id)",
            method: "DELETE"
        )
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response)
    }

    func confirmTransaction(_ input: ConfirmTransactionInput) async throws -> Receipt {
        try ensureConfigured()
        let body: [String: Any] = [
            "paymentMethodId": input.paymentMethodId,
            "amountCents": input.amountCents,
            "currency": input.currency,
            "lineItems": input.lineItems.map {
                ["label": $0.label, "amountCents": $0.amountCents]
            },
            "transactionDigest": input.transactionDigest.lumoHexString,
            "signedConfirmationToken": input.signedConfirmationToken.base64EncodedString(),
        ]
        let req = try makeRequest(
            path: "api/payments/confirm-transaction",
            method: "POST",
            jsonBody: body
        )
        let (data, response) = try await session.data(for: req)
        try ensureOK(data: data, response: response)
        struct ConfirmResponse: Codable { let ok: Bool; let receipt: Receipt }
        return try decode(ConfirmResponse.self, from: data).receipt
    }

    // MARK: - Helpers

    private func ensureConfigured() throws {
        guard isConfigured else { throw PaymentServiceError.notConfigured }
    }

    private func makeRequest(
        path: String,
        method: String,
        jsonBody: [String: Any]? = nil
    ) throws -> URLRequest {
        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let userID = userIDProvider(), !userID.isEmpty {
            req.setValue(userID, forHTTPHeaderField: "x-lumo-user-id")
        }
        if let body = jsonBody {
            req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }
        return req
    }

    private func ensureOK(
        data: Data,
        response: URLResponse,
        expected: Int = 200
    ) throws {
        guard let http = response as? HTTPURLResponse else {
            throw PaymentServiceError.badStatus(-1, nil)
        }
        let ok = http.statusCode == expected
            || (expected == 200 && (200..<300).contains(http.statusCode))
        if !ok {
            let body = String(data: data, encoding: .utf8)
            throw PaymentServiceError.badStatus(http.statusCode, body)
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        // Backend stub serializes with `Date.toISOString()` which includes
        // fractional seconds (`...123Z`). Stock `.iso8601` rejects them;
        // we match both shapes via a custom strategy.
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = PaymentService.iso8601Fractional.date(from: raw) {
                return date
            }
            if let date = PaymentService.iso8601Plain.date(from: raw) {
                return date
            }
            throw PaymentServiceError.decodingFailed("invalid iso8601: \(raw)")
        }
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw PaymentServiceError.decodingFailed(String(describing: error))
        }
    }

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601Plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

// MARK: - Test stub

/// In-memory PaymentServicing for tests + previews. Deterministic,
/// no network, mirrors the same shape PaymentService produces against
/// the live backend stubs.
final class PaymentServiceStub: PaymentServicing {
    var methods: [PaymentMethod] = []
    private(set) var receipts: [Receipt] = []
    var nextError: Error?
    var setupIntentResponse: SetupIntentResponse = .init(
        stub: true,
        setupIntentId: "seti_test_stub",
        clientSecret: nil,
        customerId: "cus_test_stub"
    )

    func createSetupIntent() async throws -> SetupIntentResponse {
        if let err = nextError { nextError = nil; throw err }
        return setupIntentResponse
    }

    func presentPaymentSheet(input: AddPaymentMethodInput) async throws -> PaymentMethod {
        if let err = nextError { nextError = nil; throw err }
        let method = PaymentMethod(
            id: "pm_test_stub_\(methods.count + 1)",
            brand: input.brand,
            last4: input.last4,
            expMonth: input.expMonth,
            expYear: input.expYear,
            isDefault: methods.isEmpty,
            addedAt: Date()
        )
        methods.append(method)
        return method
    }

    func listPaymentMethods() async throws -> [PaymentMethod] {
        if let err = nextError { nextError = nil; throw err }
        return methods
    }

    func setDefaultPaymentMethod(id: String) async throws -> PaymentMethod {
        if let err = nextError { nextError = nil; throw err }
        guard methods.contains(where: { $0.id == id }) else {
            throw PaymentServiceError.badStatus(404, "not_found")
        }
        methods = methods.map {
            PaymentMethod(
                id: $0.id,
                brand: $0.brand,
                last4: $0.last4,
                expMonth: $0.expMonth,
                expYear: $0.expYear,
                isDefault: $0.id == id,
                addedAt: $0.addedAt
            )
        }
        return methods.first { $0.id == id }!
    }

    func removePaymentMethod(id: String) async throws {
        if let err = nextError { nextError = nil; throw err }
        guard methods.contains(where: { $0.id == id }) else {
            throw PaymentServiceError.badStatus(404, "not_found")
        }
        methods.removeAll { $0.id == id }
        if !methods.contains(where: { $0.isDefault }), let first = methods.first {
            methods = methods.map {
                $0.id == first.id
                    ? PaymentMethod(
                        id: $0.id,
                        brand: $0.brand,
                        last4: $0.last4,
                        expMonth: $0.expMonth,
                        expYear: $0.expYear,
                        isDefault: true,
                        addedAt: $0.addedAt
                    )
                    : $0
            }
        }
    }

    func confirmTransaction(_ input: ConfirmTransactionInput) async throws -> Receipt {
        if let err = nextError { nextError = nil; throw err }
        guard let method = methods.first(where: { $0.id == input.paymentMethodId }) else {
            throw PaymentServiceError.badStatus(404, "payment_method_not_found")
        }
        let receipt = Receipt(
            id: "rcpt_test_stub_\(receipts.count + 1)",
            transactionId: "txn_test_stub_\(receipts.count + 1)",
            amountCents: input.amountCents,
            currency: input.currency,
            paymentMethodId: input.paymentMethodId,
            paymentMethodLabel: "\(method.brand.rawValue.uppercased()) •• \(method.last4)",
            lineItems: input.lineItems,
            createdAt: Date(),
            status: .succeeded
        )
        receipts.insert(receipt, at: 0)
        return receipt
    }
}

// MARK: - Data → hex helper

private extension Data {
    /// Lowercase hex encoding for transport. Matches the regex the
    /// backend stub validates against (`/^[0-9a-f]{32,}$/`).
    var lumoHexString: String {
        map { String(format: "%02hhx", $0) }.joined()
    }
}
