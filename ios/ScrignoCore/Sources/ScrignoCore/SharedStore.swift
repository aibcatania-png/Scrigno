import Foundation
import Security
import LocalAuthentication

/// File condivisi tra l'app e l'estensione AutoFill (contenitore App Group).
final class SharedStore {
    static let shared = SharedStore()
    private let lock = NSLock()
    let dir: URL

    init(directory: URL? = nil) {
        if let directory {
            dir = directory
        } else {
            let group = Bundle.main.object(forInfoDictionaryKey: "ScrignoAppGroup") as? String ?? ""
            let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
                ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            dir = base.appendingPathComponent("kv", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    private func url(_ key: String) throws -> URL {
        guard key.range(of: "^[a-zA-Z0-9_-]{1,40}$", options: .regularExpression) != nil else { throw ScrignoError.message("Chiave non valida") }
        return dir.appendingPathComponent(key + ".json")
    }

    func get(_ key: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        let u = try url(key)
        guard FileManager.default.fileExists(atPath: u.path) else { return nil }
        return try String(contentsOf: u, encoding: .utf8)
    }

    func set(_ key: String, _ json: String) throws {
        lock.lock(); defer { lock.unlock() }
        try Data(json.utf8).write(to: try url(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func del(_ key: String) throws {
        lock.lock(); defer { lock.unlock() }
        try? FileManager.default.removeItem(at: try url(key))
    }

    func vault() -> JSON? {
        guard let s = try? get("vault"), let d = s.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? JSON
    }

    func items(dek: Data) throws -> [JSON] {
        guard let f = vault() else { return [] }
        return Vault.live(try VaultCrypto.readItems(f, dek: dek))
    }

    /// Legge, modifica e riscrive il vault.
    func update(dek: Data, _ fn: (inout [JSON]) throws -> Void) throws {
        guard var f = vault() else { throw ScrignoError.message("Nessun vault su questo dispositivo") }
        var items = try VaultCrypto.readItems(f, dek: dek)
        try fn(&items)
        try VaultCrypto.writeItems(&f, dek: dek, items: items)
        let data = try JSONSerialization.data(withJSONObject: f)
        try set("vault", String(decoding: data, as: UTF8.self))
    }
}

/// Portachiavi condiviso (gruppo predefinito dell'app): sessione temporanea e chiave per la biometria.
enum Keychain {
    private static let service = "app.scrigno"

    static func save(_ account: String, _ data: Data, access: SecAccessControl? = nil) -> Bool {
        delete(account)
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecValueData as String: data]
        if let access { q[kSecAttrAccessControl as String] = access } else { q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func load(_ account: String, context: LAContext? = nil) -> Data? {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        if let context { q[kSecUseAuthenticationContext as String] = context }
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func exists(_ account: String) -> Bool {
        let ctx = LAContext()
        ctx.interactionNotAllowed = true
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecUseAuthenticationContext as String: ctx]
        let s = SecItemCopyMatching(q as CFDictionary, nil)
        return s == errSecSuccess || s == errSecInteractionNotAllowed
    }

    @discardableResult static func delete(_ account: String) -> Bool {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        return SecItemDelete(q as CFDictionary) == errSecSuccess
    }
}

/// Vault sbloccato: la chiave resta nel portachiavi per il tempo del blocco automatico, così l'estensione AutoFill la trova.
enum Session {
    static func set(_ dek: Data, ttlMin: Int) {
        let exp = ttlMin > 0 ? Date().timeIntervalSince1970 + Double(ttlMin * 60) : Date().timeIntervalSince1970 + 30 * 24 * 3600
        let obj: JSON = ["dek": B64.enc(dek), "exp": exp, "ttl": ttlMin]
        if let d = try? JSONSerialization.data(withJSONObject: obj) { _ = Keychain.save("session", d) }
    }

    static func get() -> Data? {
        guard let d = Keychain.load("session"), let o = (try? JSONSerialization.jsonObject(with: d)) as? JSON,
              let exp = o["exp"] as? Double, let dek = B64.dec(o["dek"] as? String ?? "") else { return nil }
        if Date().timeIntervalSince1970 > exp { clear(); return nil }
        return dek
    }

    static func ttl() -> Int {
        guard let d = Keychain.load("session"), let o = (try? JSONSerialization.jsonObject(with: d)) as? JSON else { return 5 }
        return (o["ttl"] as? Int) ?? 5
    }

    static func clear() { Keychain.delete("session") }
}

/// Sblocco con Face ID / Touch ID: la chiave del vault è protetta dalla biometria nel portachiavi.
enum Bio {
    static var available: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) }
    static var enrolled: Bool { Keychain.exists("bio") }

    static func enroll(dek: Data) throws {
        var err: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &err) else {
            throw ScrignoError.message("Biometria non disponibile")
        }
        guard Keychain.save("bio", dek, access: access) else { throw ScrignoError.message("Impossibile attivare la biometria") }
    }

    static func unlock(reason: String, completion: @escaping (Data?, String?) -> Void) {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Usa la master password"
        ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
            if !ok { DispatchQueue.main.async { completion(nil, error?.localizedDescription ?? "Annullato") }; return }
            let dek = Keychain.load("bio", context: ctx)
            DispatchQueue.main.async { completion(dek, dek == nil ? "Biometria cambiata: sblocca con la master password e riattivala." : nil) }
        }
    }

    static func disable() { Keychain.delete("bio") }
}
