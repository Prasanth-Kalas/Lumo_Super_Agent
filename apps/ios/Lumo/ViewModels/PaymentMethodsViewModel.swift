import Foundation

/// State machine + business logic for `PaymentMethodsView`. Owns the
/// list of saved methods, drives the add-card sheet, and handles
/// set-default / delete operations against PaymentService.

@MainActor
final class PaymentMethodsViewModel: ObservableObject {
    @Published private(set) var methods: [PaymentMethod] = []
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var actionError: String?
    @Published var showAddSheet: Bool = false
    @Published var addCardForm = AddCardFormState()

    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    private let service: PaymentServicing
    let isConfigured: Bool

    init(service: PaymentServicing, isConfigured: Bool) {
        self.service = service
        self.isConfigured = isConfigured
    }

    func reload() async {
        guard isConfigured else { return }
        loadState = .loading
        do {
            methods = try await service.listPaymentMethods()
            loadState = .loaded
        } catch {
            loadState = .error(error.localizedDescription)
        }
    }

    func setDefault(id: String) async {
        do {
            _ = try await service.setDefaultPaymentMethod(id: id)
            await reload()
        } catch {
            actionError = error.localizedDescription
        }
    }

    func remove(id: String) async {
        do {
            try await service.removePaymentMethod(id: id)
            await reload()
        } catch {
            actionError = error.localizedDescription
        }
    }

    func clearActionError() {
        actionError = nil
    }

    /// Submit the synthetic card-add form: validate, POST to backend
    /// stub, reload list. The backend is in stub mode so the card
    /// number isn't actually transmitted to Stripe — we only send brand
    /// + last 4 + expiry. CVV is collected for UX continuity with real
    /// PaymentSheet but never stored or sent.
    func submitAddCard() async {
        let form = addCardForm
        guard let input = form.validate() else {
            addCardForm.error = "Check your card details and try again."
            return
        }
        addCardForm.error = nil
        addCardForm.submitting = true
        do {
            _ = try await service.presentPaymentSheet(input: input)
            addCardForm.submitting = false
            addCardForm = AddCardFormState()
            showAddSheet = false
            await reload()
        } catch {
            addCardForm.submitting = false
            addCardForm.error = error.localizedDescription
        }
    }
}

/// Synthetic add-card form state. v1 ships this in place of real
/// PaymentSheet because the backend stubs don't issue real Stripe
/// SetupIntent client_secrets. MERCHANT-1 swaps the host view to
/// invoke `PaymentSheet.present(from:)` against a real client_secret.
struct AddCardFormState: Equatable {
    var cardNumber: String = ""
    var expMonth: String = ""
    var expYear: String = ""
    var cvv: String = ""
    var submitting: Bool = false
    var error: String?

    /// Returns nil if invalid. v1 only persists brand + last 4 +
    /// expiration; the card-number and CVV inputs exist for UX parity
    /// with PaymentSheet but never leave the device.
    func validate() -> AddPaymentMethodInput? {
        let digits = cardNumber.filter(\.isNumber)
        guard digits.count >= 12 && digits.count <= 19 else { return nil }
        guard let m = Int(expMonth), (1...12).contains(m) else { return nil }
        guard var y = Int(expYear), expYear.count == 2 || expYear.count == 4 else {
            return nil
        }
        if expYear.count == 2 { y += 2000 }
        guard (2024...2099).contains(y) else { return nil }
        let cvvDigits = cvv.filter(\.isNumber)
        guard (3...4).contains(cvvDigits.count) else { return nil }
        let last4 = String(digits.suffix(4))
        return AddPaymentMethodInput(
            brand: CardBrand.detect(fromCardNumber: digits),
            last4: last4,
            expMonth: m,
            expYear: y
        )
    }
}
