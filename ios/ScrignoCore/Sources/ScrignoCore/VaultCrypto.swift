import Foundation
import CryptoKit
import CommonCrypto
import Security

typealias JSON = [String: Any]

enum B64 {
    static func enc(_ d: Data) -> String { d.base64EncodedString() }
    static func dec(_ s: String) -> Data? { Data(base64Encoded: s) }
    static func urlEnc(_ d: Data) -> String {
        enc(d).replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func urlDec(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/").replacingOccurrences(of: "=", with: "")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }
}

enum ScrignoError: LocalizedError {
    case wrongPassword
    case message(String)
    var errorDescription: String? {
        switch self {
        case .wrongPassword: return "Password errata"
        case .message(let m): return m
        }
    }
}

/// Stesso formato della web app: PBKDF2-SHA256 avvolge la DEK (AES-GCM senza AAD), la DEK cifra {"items":[...]} con AAD "scrigno-v1".
enum VaultCrypto {
    static let aad = Data("scrigno-v1".utf8)

    static func random(_ n: Int) -> Data {
        var d = Data(count: n)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
        return d
    }

    static func pbkdf2(_ password: String, salt: Data, iterations: Int) -> Data {
        var out = Data(count: 32)
        let pwLen = password.utf8.count
        let status = out.withUnsafeMutableBytes { outPtr in
            salt.withUnsafeBytes { saltPtr in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password, pwLen,
                                     saltPtr.bindMemory(to: UInt8.self).baseAddress, salt.count,
                                     CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations),
                                     outPtr.bindMemory(to: UInt8.self).baseAddress, 32)
            }
        }
        precondition(status == Int32(kCCSuccess), "PBKDF2 non riuscito")
        return out
    }

    static func open(key: Data, iv: Data, ct: Data, aad: Data?) throws -> Data {
        let box = try AES.GCM.SealedBox(combined: iv + ct)
        let k = SymmetricKey(data: key)
        if let aad { return try AES.GCM.open(box, using: k, authenticating: aad) }
        return try AES.GCM.open(box, using: k)
    }

    static func seal(key: Data, plain: Data, aad: Data?) throws -> JSON {
        let k = SymmetricKey(data: key)
        let nonce = AES.GCM.Nonce()
        let box = aad != nil ? try AES.GCM.seal(plain, using: k, nonce: nonce, authenticating: aad!) : try AES.GCM.seal(plain, using: k, nonce: nonce)
        let iv = nonce.withUnsafeBytes { Data($0) }
        return ["iv": B64.enc(iv), "ct": B64.enc(box.ciphertext + box.tag)]
    }

    static func unlock(_ file: JSON, password: String) throws -> Data {
        guard let kdf = file["kdf"] as? JSON, let saltS = kdf["salt"] as? String, let salt = B64.dec(saltS),
              let iter = (kdf["iter"] as? NSNumber)?.intValue,
              let keys = file["keys"] as? JSON, let w = keys["pw"] as? JSON,
              let iv = B64.dec(w["iv"] as? String ?? ""), let ct = B64.dec(w["ct"] as? String ?? "") else {
            throw ScrignoError.message("File del vault non valido")
        }
        if (kdf["keyfile"] as? Bool) == true {
            throw ScrignoError.message("Questo vault usa un keyfile: sbloccalo con Face ID oppure dall'app")
        }
        let kek = pbkdf2(password, salt: salt, iterations: iter)
        do { return try open(key: kek, iv: iv, ct: ct, aad: nil) } catch { throw ScrignoError.wrongPassword }
    }

    static func readItems(_ file: JSON, dek: Data) throws -> [JSON] {
        guard let data = file["data"] as? JSON else { return [] }
        guard let iv = B64.dec(data["iv"] as? String ?? ""), let ct = B64.dec(data["ct"] as? String ?? "") else { throw ScrignoError.message("Dati del vault non validi") }
        let plain = try open(key: dek, iv: iv, ct: ct, aad: aad)
        let obj = try JSONSerialization.jsonObject(with: plain) as? JSON
        return obj?["items"] as? [JSON] ?? []
    }

    static func writeItems(_ file: inout JSON, dek: Data, items: [JSON]) throws {
        let plain = try JSONSerialization.data(withJSONObject: ["items": items])
        file["data"] = try seal(key: dek, plain: plain, aad: aad)
        file["updatedAt"] = NSNumber(value: Int64(Date().timeIntervalSince1970 * 1000))
    }
}
