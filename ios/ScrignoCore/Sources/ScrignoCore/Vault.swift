import Foundation

/// Elementi del vault e ricerca dei login (come matchLogins in core.js).
enum Vault {
    static let sld: Set<String> = ["co.uk", "org.uk", "gov.uk", "ac.uk", "com.au", "net.au", "co.jp", "co.nz", "com.br", "com.mx", "co.in", "gov.it", "edu.it", "com.tr", "co.za"]

    static func nowMs() -> NSNumber { NSNumber(value: Int64(Date().timeIntervalSince1970 * 1000)) }

    static func live(_ items: [JSON]) -> [JSON] {
        items.filter { ($0["deleted"] as? Bool) != true && $0["trashed"] == nil && !type($0).hasPrefix("_") }
    }

    static func field(_ it: JSON, _ k: String) -> String { ((it["f"] as? JSON)?[k] as? String) ?? "" }
    static func id(_ it: JSON) -> String { it["id"] as? String ?? "" }
    static func type(_ it: JSON) -> String { it["type"] as? String ?? "" }
    static func title(_ it: JSON) -> String { it["title"] as? String ?? "" }

    static func hostOf(_ url: String) -> String {
        let s = url.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { return "" }
        let full = s.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*:", options: .regularExpression) != nil ? s : "https://" + s
        return URL(string: full)?.host?.lowercased() ?? ""
    }

    static func baseDomain(_ hostIn: String) -> String {
        var host = hostIn.lowercased()
        if host.hasPrefix("www.") { host.removeFirst(4) }
        while host.hasSuffix(".") { host.removeLast() }
        if !host.contains(".") || host.allSatisfy({ $0.isNumber || $0 == "." }) { return host }
        let p = host.split(separator: ".").map(String.init)
        let last2 = p.suffix(2).joined(separator: ".")
        return sld.contains(last2) && p.count >= 3 ? p.suffix(3).joined(separator: ".") : last2
    }

    static func matchLogins(_ all: [JSON], host: String?) -> [JSON] {
        guard let host, !host.isEmpty else { return [] }
        let bd = baseDomain(host)
        return all.filter { type($0) == "login" && !field($0, "url").isEmpty && baseDomain(hostOf(field($0, "url"))) == bd }
    }

    static func passkeys(_ all: [JSON], rpId: String) -> [JSON] {
        all.filter { type($0) == "passkey" && field($0, "rpId") == rpId && !field($0, "privateKey").isEmpty }
    }

    static func newItem(type: String, title: String, f: JSON) -> JSON {
        let t = nowMs()
        var o: JSON = ["id": UUID().uuidString.lowercased(), "type": type, "title": title.isEmpty ? "Senza titolo" : title,
                       "f": f, "custom": [Any](), "fav": false, "created": t, "updated": t]
        if !((f["password"] as? String) ?? "").isEmpty { o["pwChanged"] = t }
        return o
    }

    /// Aggiunge o aggiorna un login per un sito.
    @discardableResult
    static func upsertLogin(_ items: inout [JSON], host: String, username: String, password: String) -> String {
        if let i = items.firstIndex(where: { ($0["deleted"] as? Bool) != true && type($0) == "login" && field($0, "username") == username &&
            baseDomain(hostOf(field($0, "url"))) == baseDomain(host) }) {
            var it = items[i]
            var f = it["f"] as? JSON ?? [:]
            if (f["password"] as? String) != password { f["password"] = password; it["pwChanged"] = nowMs() }
            it["f"] = f
            it["updated"] = nowMs()
            items[i] = it
            return id(it)
        }
        let it = newItem(type: "login", title: baseDomain(host), f: ["username": username, "password": password, "url": "https://" + host])
        items.append(it)
        return id(it)
    }
}
