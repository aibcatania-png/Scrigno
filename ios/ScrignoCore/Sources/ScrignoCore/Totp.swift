import Foundation
import CryptoKit

/// Codici 2FA (RFC 6238).
enum Totp {
    struct Cfg { let secret: Data; let digits: Int; let period: Int; let algorithm: String }

    static func base32(_ s: String) throws -> Data {
        let a = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var bits = 0, v = 0
        var out = Data()
        for c in s.uppercased() where !" =-\t\n".contains(c) {
            guard let i = a.firstIndex(of: c) else { throw ScrignoError.message("Segreto 2FA non valido") }
            v = (v << 5) | i
            bits += 5
            if bits >= 8 { out.append(UInt8((v >> (bits - 8)) & 255)); bits -= 8 }
        }
        return out
    }

    static func parse(_ input: String) throws -> Cfg {
        let s = input.trimmingCharacters(in: .whitespaces)
        if s.lowercased().hasPrefix("otpauth://"), let c = URLComponents(string: s) {
            var q: [String: String] = [:]
            for item in c.queryItems ?? [] { q[item.name.lowercased()] = item.value ?? "" }
            let alg = ["SHA256": "SHA256", "SHA512": "SHA512"][(q["algorithm"] ?? "SHA1").uppercased()] ?? "SHA1"
            return Cfg(secret: try base32(q["secret"] ?? ""), digits: Int(q["digits"] ?? "6") ?? 6, period: Int(q["period"] ?? "30") ?? 30, algorithm: alg)
        }
        return Cfg(secret: try base32(s), digits: 6, period: 30, algorithm: "SHA1")
    }

    static func code(_ cfg: Cfg, date: Date = Date()) -> String {
        var counter = UInt64(date.timeIntervalSince1970) / UInt64(cfg.period)
        counter = counter.bigEndian
        let msg = withUnsafeBytes(of: &counter) { Data($0) }
        let key = SymmetricKey(data: cfg.secret)
        let h: Data
        switch cfg.algorithm {
        case "SHA256": h = Data(HMAC<SHA256>.authenticationCode(for: msg, using: key))
        case "SHA512": h = Data(HMAC<SHA512>.authenticationCode(for: msg, using: key))
        default: h = Data(HMAC<Insecure.SHA1>.authenticationCode(for: msg, using: key))
        }
        let b = [UInt8](h)
        let o = Int(b[b.count - 1] & 15)
        let bin = (Int(b[o] & 127) << 24) | (Int(b[o + 1]) << 16) | (Int(b[o + 2]) << 8) | Int(b[o + 3])
        var mod = 1
        for _ in 0..<cfg.digits { mod *= 10 }
        let s = String(bin % mod)
        return String(repeating: "0", count: max(0, cfg.digits - s.count)) + s
    }
}
