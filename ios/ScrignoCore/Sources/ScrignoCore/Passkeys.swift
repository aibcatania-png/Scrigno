import Foundation
import CryptoKit

/// Autenticatore WebAuthn software (ES256), stesso formato di passkey.js e Passkeys.kt.
enum Passkeys {
    static let aaguid = Data([0x5c, 0x7a, 0x3f, 0x20, 0x9b, 0x1e, 0x4d, 0x8a, 0xa6, 0xc3, 0x2f, 0x0e, 0x8b, 0x4d, 0x1a, 0x77])
    static let UP: UInt8 = 0x01, UV: UInt8 = 0x04, BE: UInt8 = 0x08, BS: UInt8 = 0x10, AT: UInt8 = 0x40

    // ------------------------------------------------------------ CBOR minimale
    enum CBOR {
        case int(Int), bytes(Data), text(String), map([(CBOR, CBOR)])
    }
    private static func head(_ major: UInt8, _ n: UInt64) -> Data {
        let m = major << 5
        if n < 24 { return Data([m | UInt8(n)]) }
        if n < 0x100 { return Data([m | 24, UInt8(n)]) }
        if n < 0x10000 { return Data([m | 25, UInt8(n >> 8), UInt8(n & 255)]) }
        return Data([m | 26, UInt8((n >> 24) & 255), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)])
    }
    static func encode(_ v: CBOR) -> Data {
        switch v {
        case .int(let i): return i >= 0 ? head(0, UInt64(i)) : head(1, UInt64(-1 - i))
        case .bytes(let d): return head(2, UInt64(d.count)) + d
        case .text(let s): let b = Data(s.utf8); return head(3, UInt64(b.count)) + b
        case .map(let pairs):
            var out = head(5, UInt64(pairs.count))
            for (k, x) in pairs { out += encode(k); out += encode(x) }
            return out
        }
    }

    static func sha256(_ d: Data) -> Data { Data(SHA256.hash(data: d)) }

    /// PKCS#8 per P-256 con chiave pubblica (come WebCrypto).
    static func pkcs8(d: Data, x: Data, y: Data) -> Data {
        let prefix = Data([0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                           0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20])
        return prefix + d + Data([0xa1, 0x44, 0x03, 0x42, 0x00, 0x04]) + x + y
    }

    static func privateKey(fromPKCS8 der: Data) throws -> P256.Signing.PrivateKey {
        if let k = try? P256.Signing.PrivateKey(derRepresentation: der) { return k }
        // forma standard di WebCrypto: la chiave privata (32 byte) segue "04 20" all'offset 36
        if der.count >= 68 {
            return try P256.Signing.PrivateKey(rawRepresentation: der.subdata(in: 36..<68))
        }
        throw ScrignoError.message("Chiave della passkey non valida")
    }

    static func authData(rpId: String, flags: UInt8, attested: Data? = nil) -> Data {
        var d = sha256(Data(rpId.utf8)) + Data([flags, 0, 0, 0, 0])
        if let attested { d += attested }
        return d
    }

    struct Created {
        let fields: JSON
        let credentialId: Data
        let attestationObject: Data
        let authenticatorData: Data
    }

    static func create(rpId: String, userHandle: Data, userName: String, uv: Bool = true) -> Created {
        let key = P256.Signing.PrivateKey()
        let raw = key.publicKey.rawRepresentation   // x || y
        let x = raw.prefix(32), y = raw.suffix(32)
        let credId = VaultCrypto.random(16)
        let cose = encode(.map([(.int(1), .int(2)), (.int(3), .int(-7)), (.int(-1), .int(1)), (.int(-2), .bytes(Data(x))), (.int(-3), .bytes(Data(y)))]))
        let attested = aaguid + Data([UInt8(credId.count >> 8), UInt8(credId.count & 255)]) + credId + cose
        let ad = authData(rpId: rpId, flags: UP | (uv ? UV : 0) | BE | BS | AT, attested: attested)
        let att = encode(.map([(.text("fmt"), .text("none")), (.text("attStmt"), .map([])), (.text("authData"), .bytes(ad))]))
        let fields: JSON = ["rpId": rpId, "username": userName, "credentialId": B64.urlEnc(credId),
                            "userHandle": B64.urlEnc(userHandle), "privateKey": B64.enc(pkcs8(d: key.rawRepresentation, x: Data(x), y: Data(y)))]
        return Created(fields: fields, credentialId: credId, attestationObject: att, authenticatorData: ad)
    }

    static func assert(privateKeyB64: String, rpId: String, clientDataHash: Data, uv: Bool = true) throws -> (authData: Data, signature: Data) {
        guard let der = B64.dec(privateKeyB64) else { throw ScrignoError.message("Chiave della passkey non valida") }
        let key = try privateKey(fromPKCS8: der)
        let ad = authData(rpId: rpId, flags: UP | (uv ? UV : 0) | BE | BS)
        let sig = try key.signature(for: ad + clientDataHash)
        return (ad, sig.derRepresentation)
    }
}
