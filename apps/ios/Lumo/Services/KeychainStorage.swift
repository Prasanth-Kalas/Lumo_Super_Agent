import Foundation
import Auth

/// Keychain-backed storage for the Supabase auth session. The default
/// `Auth.AuthClient.Configuration` reads from `UserDefaults`, which
/// would persist a refresh token in plaintext on disk. We override it
/// with this Keychain-backed adapter so tokens get the proper at-rest
/// encryption + per-device protection (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
///
/// The class is public-by-test-target for `AuthStateMachineTests`; the
/// production app talks to it only via the `AuthLocalStorage`
/// conformance.

final class KeychainStorage: AuthLocalStorage {
    private let service: String
    private let accessGroup: String?

    init(service: String = "com.lumo.rentals.ios.auth", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    func store(key: String, value: Data) throws {
        var query = baseQuery(key: key)
        query[kSecValueData as String] = value
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        // Upsert: try update first (item exists), fall through to add.
        let updateAttrs: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery(key: key) as CFDictionary, updateAttrs as CFDictionary)

        if updateStatus == errSecItemNotFound {
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unhandled(status: addStatus)
            }
        } else if updateStatus != errSecSuccess {
            throw KeychainError.unhandled(status: updateStatus)
        }
    }

    func retrieve(key: String) throws -> Data? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        switch status {
        case errSecSuccess:
            return item as? Data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unhandled(status: status)
        }
    }

    func remove(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandled(status: status)
        }
    }

    private func baseQuery(key: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}

enum KeychainError: Error, LocalizedError {
    case unhandled(status: OSStatus)

    var errorDescription: String? {
        switch self {
        case .unhandled(let status):
            return "Keychain error: \(status)"
        }
    }
}
