import Foundation
import CommonCrypto
import Security

// Chromium's cookie encryption on macOS: a Keychain password stretched with
// PBKDF2-SHA1 into an AES-128-CBC key, fixed IV of 16 spaces, "v10" prefix.
func deriveKey(password: Data) -> Data {
    var key = Data(count: kCCKeySizeAES128)
    let salt = Array("saltysalt".utf8)
    let status = key.withUnsafeMutableBytes { keyBytes in
        password.withUnsafeBytes { passwordBytes in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                 passwordBytes.bindMemory(to: Int8.self).baseAddress, password.count,
                                 salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003,
                                 keyBytes.bindMemory(to: UInt8.self).baseAddress, kCCKeySizeAES128)
        }
    }
    precondition(status == kCCSuccess, "PBKDF2 failed")
    return key
}

func sha256(_ data: Data) -> Data {
    var digest = Data(count: Int(CC_SHA256_DIGEST_LENGTH))
    digest.withUnsafeMutableBytes { out in
        data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), out.bindMemory(to: UInt8.self).baseAddress) }
    }
    return digest
}

func decryptCookie(_ encrypted: Data, key: Data, host: String, schema: Int) -> String? {
    guard encrypted.count > 3, encrypted.prefix(3) == Data("v10".utf8) else { return nil }
    let body = encrypted.dropFirst(3)
    let iv = Data(repeating: 0x20, count: kCCBlockSizeAES128)
    var out = Data(count: body.count + kCCBlockSizeAES128)
    var written = 0
    let capacity = out.count
    let status = out.withUnsafeMutableBytes { outBytes in
        body.withUnsafeBytes { bodyBytes in
            key.withUnsafeBytes { keyBytes in
                iv.withUnsafeBytes { ivBytes in
                    CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, key.count, ivBytes.baseAddress,
                            bodyBytes.baseAddress, body.count, outBytes.baseAddress, capacity, &written)
                }
            }
        }
    }
    guard status == kCCSuccess else { return nil }
    var plain = out.prefix(written)
    // From cookie database version 24 the value is preceded by the SHA-256 of its host.
    if schema >= 24 {
        guard plain.count >= 32, plain.prefix(32) == sha256(Data(host.utf8)) else { return nil }
        plain = plain.dropFirst(32)
    }
    return String(data: plain, encoding: .utf8)
}

enum KeychainError: LocalizedError {
    case denied, missing, failed(OSStatus)
    var errorDescription: String? {
        switch self {
        case .denied: return "Keychain access to Claude Safe Storage was not allowed, so quotas cannot be checked."
        case .missing: return "Claude's Safe Storage key is not in the Keychain. Open Claude once and sign in."
        case .failed(let status): return "The Keychain could not be read (\(status))."
        }
    }
}

// Reading this item makes macOS ask the user once; "Always Allow" stops repeat prompts.
func claudeCookieKey() throws -> Data {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: "Claude Safe Storage",
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
        guard let password = item as? Data else { throw KeychainError.missing }
        return deriveKey(password: password)
    case errSecItemNotFound: throw KeychainError.missing
    case errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed: throw KeychainError.denied
    default: throw KeychainError.failed(status)
    }
}
