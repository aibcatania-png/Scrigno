import XCTest
import CryptoKit
@testable import ScrignoCore

/// Verifica la compatibilità con la web app usando il vault creato da tests/core.test.js.
final class CompatTests: XCTestCase {
    func fixture() throws -> JSON {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "fixture-vault", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? JSON)
    }

    func testUnlockAndRead() throws {
        let fx = try fixture()
        let file = try XCTUnwrap(fx["file"] as? JSON)
        let dek = try VaultCrypto.unlock(file, password: "fixture-password-123")
        XCTAssertEqual(B64.enc(dek), fx["dek"] as? String)
        let items = Vault.live(try VaultCrypto.readItems(file, dek: dek))
        let login = try XCTUnwrap(items.first { Vault.type($0) == "login" })
        XCTAssertEqual(Vault.field(login, "username"), "alice")
        XCTAssertEqual(Vault.field(login, "password"), "s3cret!")
        XCTAssertThrowsError(try VaultCrypto.unlock(file, password: "sbagliata"))
    }

    func testWriteRoundTrip() throws {
        let fx = try fixture()
        var file = try XCTUnwrap(fx["file"] as? JSON)
        let dek = try XCTUnwrap(B64.dec(fx["dek"] as! String))
        var items = try VaultCrypto.readItems(file, dek: dek)
        Vault.upsertLogin(&items, host: "www.example.org", username: "bob", password: "pw1")
        Vault.upsertLogin(&items, host: "example.org", username: "bob", password: "pw2")
        try VaultCrypto.writeItems(&file, dek: dek, items: items)
        let back = Vault.live(try VaultCrypto.readItems(file, dek: dek))
        XCTAssertEqual(back.count, 3)
        XCTAssertEqual(Vault.field(Vault.matchLogins(back, host: "example.org").first!, "password"), "pw2")
        if let out = ProcessInfo.processInfo.environment["SCRIGNO_SWIFT_OUT"] {
            let d = try JSONSerialization.data(withJSONObject: file)
            try d.write(to: URL(fileURLWithPath: out).appendingPathComponent("swift-vault.json"))
        }
    }

    func testPasskeyFromWebApp() throws {
        let fx = try fixture()
        let file = try XCTUnwrap(fx["file"] as? JSON)
        let items = Vault.live(try VaultCrypto.readItems(file, dek: B64.dec(fx["dek"] as! String)!))
        let pk = try XCTUnwrap(Vault.passkeys(items, rpId: "example.com").first)
        let cdh = Passkeys.sha256(Data("{}".utf8))
        let r = try Passkeys.assert(privateKeyB64: Vault.field(pk, "privateKey"), rpId: "example.com", clientDataHash: cdh)
        let pub = try P256.Signing.PublicKey(derRepresentation: B64.dec(fx["passkeySpki"] as! String)!)
        XCTAssertTrue(pub.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: r.signature), for: r.authData + cdh))
        XCTAssertEqual(r.authData[32], 0x1d)
    }

    func testPasskeyCreate() throws {
        let c = Passkeys.create(rpId: "example.com", userHandle: Data([1, 2, 3]), userName: "mario")
        XCTAssertEqual(B64.dec(c.fields["privateKey"] as! String)!.count, 138)
        XCTAssertEqual(c.attestationObject.first, 0xa3)
        let cdh = Passkeys.sha256(Data("x".utf8))
        let r = try Passkeys.assert(privateKeyB64: c.fields["privateKey"] as! String, rpId: "example.com", clientDataHash: cdh)
        let key = try Passkeys.privateKey(fromPKCS8: B64.dec(c.fields["privateKey"] as! String)!)
        XCTAssertTrue(key.publicKey.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: r.signature), for: r.authData + cdh))
        if let out = ProcessInfo.processInfo.environment["SCRIGNO_SWIFT_OUT"] {
            let o: JSON = ["privateKey": c.fields["privateKey"]!, "spki": B64.enc(key.publicKey.derRepresentation)]
            try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: out).appendingPathComponent("swift-passkey.json"))
        }
    }

    func testTotp() throws {
        let cfg = Totp.Cfg(secret: try Totp.base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), digits: 8, period: 30, algorithm: "SHA1")
        XCTAssertEqual(Totp.code(cfg, date: Date(timeIntervalSince1970: 59)), "94287082")
        XCTAssertEqual(Totp.code(cfg, date: Date(timeIntervalSince1970: 1111111109)), "07081804")
    }

    func testMatching() {
        XCTAssertEqual(Vault.baseDomain("a.b.co.uk"), "b.co.uk")
        XCTAssertEqual(Vault.baseDomain("www.accounts.google.com"), "google.com")
    }
}
