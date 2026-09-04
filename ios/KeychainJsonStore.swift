import Foundation
import Security

final class KeychainJsonStore {
  private let service = "com.bandbbs.expoabcore"

  func string(for key: String, fallback: String) -> String {
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data,
          let value = String(data: data, encoding: .utf8)
    else {
      return fallback
    }
    return value
  }

  func set(_ value: String, for key: String) throws {
    let data = Data(value.utf8)
    let query = baseQuery(key)
    let update = [kSecValueData as String: data]
    let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let addStatus = SecItemAdd(add as CFDictionary, nil)
      guard addStatus == errSecSuccess else { throw KeychainError.status(addStatus) }
    } else if status != errSecSuccess {
      throw KeychainError.status(status)
    }
  }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }
}

enum KeychainError: Error {
  case status(OSStatus)
}
