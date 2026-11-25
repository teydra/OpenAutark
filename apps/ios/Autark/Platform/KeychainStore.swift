// Owns: where the phone's secrets live – the pairing keys and token of every company, the gate secret – in the iOS
// keychain, device-only and not synced (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly: reachable after the first unlock
// so the connection may come back while the phone is locked, never leaving this phone through iCloud or a backup restore).
// One exception: an unsigned simulator build has no keychain entitlement (errSecMissingEntitlement); there a file in the
// app's own support folder (no backup, protected until first unlock) stands in, so the unsigned CI build runs the same code.
// Never: syncs, shares with another app, or logs a value.
import Foundation
import Security
import AutarkCore

public final class KeychainStore: StringStore {
    private let service: String
    private let fallbackFolder: URL

    public init(service: String = "com.teydralab.autark") {
        self.service = service
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        self.fallbackFolder = base.appendingPathComponent("autark-store", isDirectory: true)
    }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    public func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecSuccess, let data = out as? Data { return String(data: data, encoding: .utf8) }
        if status == errSecMissingEntitlement { return try? String(contentsOf: fileURL(key), encoding: .utf8) }
        return nil
    }

    public func put(_ key: String, _ value: String?) {
        SecItemDelete(query(key) as CFDictionary)
        guard let value = value else { try? FileManager.default.removeItem(at: fileURL(key)); return }
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecMissingEntitlement { writeFile(key, value) }
    }

    private func fileURL(_ key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber ? String($0) : "_" }.joined()
        return fallbackFolder.appendingPathComponent(safe)
    }

    private func writeFile(_ key: String, _ value: String) {
        let manager = FileManager.default
        try? manager.createDirectory(at: fallbackFolder, withIntermediateDirectories: true,
                                     attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var url = fileURL(key)
        try? Data(value.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}
