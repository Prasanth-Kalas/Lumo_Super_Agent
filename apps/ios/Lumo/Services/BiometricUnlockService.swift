import Foundation
import LocalAuthentication

/// Thin wrapper around `LAContext` for the post-cold-launch unlock step.
/// When a Supabase session exists in the Keychain we still require
/// Face-ID / Touch-ID before showing the rest of the app — same UX
/// expectation users have from banking and password-manager apps. The
/// gate is opt-out via Settings (`isBiometricGateEnabled`).

protocol BiometricUnlockServicing {
    /// True when the device has biometric hardware and the user has
    /// enrolled at least one biometric.
    func isBiometryAvailable() -> Bool
    /// The flavor of biometric available; used to label the prompt.
    func biometryKind() -> BiometryKind
    /// Run the unlock prompt. Resolves true on success, false on the
    /// user cancelling, throws on a hardware error.
    func authenticate(reason: String) async throws -> Bool
}

enum BiometryKind {
    case faceID
    case touchID
    case opticID
    case none

    var label: String {
        switch self {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        case .none: return "Biometric"
        }
    }
}

final class BiometricUnlockService: BiometricUnlockServicing {
    private func makeContext() -> LAContext {
        let ctx = LAContext()
        ctx.localizedFallbackTitle = ""
        return ctx
    }

    func isBiometryAvailable() -> Bool {
        var error: NSError?
        let canEval = makeContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        return canEval && error == nil
    }

    func biometryKind() -> BiometryKind {
        let ctx = makeContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
            return .none
        }
        switch ctx.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        default: return .none
        }
    }

    func authenticate(reason: String) async throws -> Bool {
        let ctx = makeContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
            // No biometric hardware / no enrolment → treat as success so
            // we don't lock the user out of their own app on a device
            // that cannot biometric. The session token in Keychain is
            // still gated by device passcode at OS level.
            return true
        }
        do {
            return try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel {
            return false
        }
    }
}

/// Test fake — drives `AuthStateMachine` without touching real LAContext.
final class BiometricUnlockStub: BiometricUnlockServicing {
    var available: Bool = true
    var kind: BiometryKind = .faceID
    var nextAuthResult: Result<Bool, Error> = .success(true)

    func isBiometryAvailable() -> Bool { available }
    func biometryKind() -> BiometryKind { kind }
    func authenticate(reason: String) async throws -> Bool {
        switch nextAuthResult {
        case .success(let value): return value
        case .failure(let error): throw error
        }
    }
}
