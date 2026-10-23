import SwiftUI
import UIKit
import WebKit
import AuthenticationServices
import UniformTypeIdentifiers
import LocalAuthentication
import Network

@main
struct ScrignoApp: App {
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            WebContainer().ignoresSafeArea(.container, edges: .bottom)
        }
        .onChange(of: phase) { _, p in if p == .active { WebHost.shared.event("resume") } }
    }
}

struct WebContainer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebHost { WebHost.shared }
    func updateUIViewController(_ vc: WebHost, context: Context) {}
}

/// Serve i file della web app dal bundle su http://127.0.0.1 (indirizzo locale: contesto sicuro per WebCrypto, niente rete esterna).
final class LocalServer {
    static let shared = LocalServer()
    private let root = Bundle.main.url(forResource: "web", withExtension: nil)!.standardizedFileURL
    private let queue = DispatchQueue(label: "scrigno.server")
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    func start(_ ready: @escaping (UInt16) -> Void) {
        start(port: 47812, ready: ready)
    }

    private func start(port wanted: UInt16, ready: @escaping (UInt16) -> Void) {
        let params = NWParameters.tcp
        params.acceptLocalOnly = true
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: wanted) ?? .any)
        guard let l = try? NWListener(using: params) else { if wanted != 0 { start(port: 0, ready: ready) }; return }
        listener = l
        l.newConnectionHandler = { [weak self] c in
            c.start(queue: self?.queue ?? .main)
            self?.serve(c)
        }
        l.stateUpdateHandler = { [weak self] st in
            switch st {
            case .ready:
                let p = l.port?.rawValue ?? wanted
                self?.port = p
                DispatchQueue.main.async { ready(p) }
            case .failed:
                l.cancel()
                if wanted != 0 { self?.start(port: 0, ready: ready) }
            default: break
            }
        }
        l.start(queue: queue)
    }

    private func serve(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let req = String(data: data, encoding: .utf8), let line = req.split(separator: "\r\n").first else { c.cancel(); return }
            let parts = line.split(separator: " ")
            var path = parts.count > 1 ? String(parts[1]) : "/"
            if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
            if path == "/" { path = "/index.html" }
            let file = self.root.appendingPathComponent(path.removingPercentEncoding ?? path).standardizedFileURL
            var head: String
            var body = Data()
            if parts.first == "GET", file.path.hasPrefix(self.root.path), let d = try? Data(contentsOf: file) {
                let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "svg": "image/svg+xml",
                             "png": "image/png", "json": "application/json", "webmanifest": "application/manifest+json"]
                head = "HTTP/1.1 200 OK\r\nContent-Type: \(types[file.pathExtension] ?? "application/octet-stream")\r\n"
                body = d
            } else {
                head = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n"
            }
            head += "Content-Length: \(body.count)\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
            c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
        }
    }
}

final class WebHost: UIViewController, WKScriptMessageHandlerWithReply, WKUIDelegate, WKNavigationDelegate,
                     ASWebAuthenticationPresentationContextProviding, UIDocumentPickerDelegate {
    static let shared = WebHost()
    private var web: WKWebView!
    private var authSession: ASWebAuthenticationSession?
    private var pickerDone: (([URL]?) -> Void)?
    private var tempExport: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "scrigno")
        web = WKWebView(frame: view.bounds, configuration: cfg)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isInspectable = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        view.backgroundColor = UIColor(red: 0.047, green: 0.075, blue: 0.09, alpha: 1)
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        view.addSubview(web)
        LocalServer.shared.start { [weak self] port in
            self?.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/index.html")!))
        }
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        web.frame = view.bounds.inset(by: UIEdgeInsets(top: view.safeAreaInsets.top, left: 0, bottom: 0, right: 0))
    }

    func event(_ name: String, _ json: String = "null") {
        guard web != nil else { return }
        let n = String(data: try! JSONSerialization.data(withJSONObject: [name, json]), encoding: .utf8)!
        web.evaluateJavaScript("(function(a){ window.__scrignoEvent && window.__scrignoEvent(a[0], a[1]); })(\(n))")
    }

    // ------------------------------------------------------------ navigazione e finestre JS
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http" && url.host == "127.0.0.1" && url.port.map(UInt16.init) == LocalServer.shared.port { decisionHandler(.allow); return }
        if url.scheme == "about" { decisionHandler(.allow); return }
        if url.scheme == "https" || url.scheme == "http" { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        LocalServer.shared.start { port in webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/index.html")!)) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Annulla", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText; $0.isSecureTextEntry = prompt.lowercased().contains("password") }
        a.addAction(UIAlertAction(title: "Annulla", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        present(a, animated: true)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { view.window ?? ASPresentationAnchor() }

    // ------------------------------------------------------------ ponte con la web app
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "http", message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == Int(LocalServer.shared.port),
              let body = message.body as? [String: Any], let method = body["method"] as? String else { replyHandler(nil, "Non consentito"); return }
        let argsText = body["args"] as? String ?? "null"
        let args = ((try? JSONSerialization.jsonObject(with: Data(argsText.utf8), options: [.fragmentsAllowed])) as? JSON) ?? [:]
        Task { @MainActor in
            do {
                let r = try await self.dispatch(method, args)
                replyHandler(r, nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }

    private func json(_ o: Any) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: o, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data("null".utf8), as: UTF8.self)
    }

    @MainActor
    private func dispatch(_ method: String, _ a: JSON) async throws -> String {
        let store = SharedStore.shared
        switch method {
        case "kvGet": return try store.get(a["key"] as? String ?? "") ?? "null"
        case "kvSet":
            let value = a["value"] ?? NSNull()
            try store.set(a["key"] as? String ?? "", json(value))
            return "null"
        case "kvDel": try store.del(a["key"] as? String ?? ""); return "null"
        case "session":
            if let d = B64.dec(a["dek"] as? String ?? "") { Session.set(d, ttlMin: (a["ttlMin"] as? Int) ?? 5) }
            return "null"
        case "lock": Session.clear(); return "null"
        case "http": return try await http(a)
        case "oauth": return json(try await oauth(a["url"] as? String ?? ""))
        case "oauthCancel": authSession?.cancel(); authSession = nil; return "null"
        case "copy":
            let text = a["text"] as? String ?? ""
            let sec = (a["clearSec"] as? Int) ?? 0
            var opts: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
            if sec > 0 { opts[.expirationDate] = Date().addingTimeInterval(TimeInterval(sec)) }
            UIPasteboard.general.setItems([[UTType.plainText.identifier: text]], options: opts)
            return "null"
        case "saveFile":
            let data = (a["b64"] as? String).flatMap { B64.dec($0) } ?? Data((a["text"] as? String ?? "").utf8)
            return json(try await saveFile(name: a["name"] as? String ?? "scrigno-backup.json", data: data))
        case "openUrl":
            if let u = URL(string: a["url"] as? String ?? ""), u.scheme == "https" || u.scheme == "http" { await UIApplication.shared.open(u) }
            return "null"
        case "bioStatus": return json(["available": Bio.available, "enrolled": Bio.enrolled])
        case "bioEnroll":
            guard let d = B64.dec(a["dek"] as? String ?? "") else { throw ScrignoError.message("Chiave non valida") }
            try Bio.enroll(dek: d)
            return "null"
        case "bioUnlock":
            let dek: Data = try await withCheckedThrowingContinuation { c in
                Bio.unlock(reason: "Sblocca Scrigno") { d, e in if let d { c.resume(returning: d) } else { c.resume(throwing: ScrignoError.message(e ?? "Annullato")) } }
            }
            return json(["dek": B64.enc(dek)])
        case "bioDisable": Bio.disable(); return "null"
        case "identities": await Identities.replace(a["list"] as? [JSON] ?? []); return "null"
        case "folderPick": return json(try await Folder.pick(from: self) ?? NSNull())
        case "folderRead": return json(try Folder.read(id: a["id"] as? String ?? "", name: a["name"] as? String ?? "") ?? NSNull())
        case "folderWrite": try Folder.write(id: a["id"] as? String ?? "", name: a["name"] as? String ?? "", text: a["text"] as? String ?? ""); return "null"
        case "openAutofillSettings":
            if #available(iOS 18.0, *) { ASSettingsHelper.openCredentialProviderAppSettings { _ in } }
            else if let u = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(u) }
            return "null"
        default: throw ScrignoError.message("Funzione non disponibile: \(method)")
        }
    }

    private func http(_ a: JSON) async throws -> String {
        guard let s = a["url"] as? String, s.hasPrefix("https://"), let url = URL(string: s) else { throw ScrignoError.message("Sono consentite solo connessioni HTTPS") }
        var req = URLRequest(url: url)
        req.httpMethod = (a["method"] as? String) ?? "GET"
        req.cachePolicy = .reloadIgnoringLocalCacheData
        for (k, v) in (a["headers"] as? JSON) ?? [:] { req.setValue("\(v)", forHTTPHeaderField: k) }
        if let b = a["body"] as? String { req.httpBody = Data(b.utf8) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return json(["status": status, "body": String(decoding: data, as: UTF8.self)])
    }

    @MainActor
    private func oauth(_ s: String) async throws -> String {
        guard let url = URL(string: s), url.scheme == "https" else { throw ScrignoError.message("Indirizzo non valido") }
        authSession?.cancel()
        return try await withCheckedThrowingContinuation { c in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "scrigno") { cb, err in
                if let cb { c.resume(returning: cb.absoluteString) } else { c.resume(throwing: ScrignoError.message(err?.localizedDescription ?? "Accesso annullato")) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.authSession = session
            if !session.start() { c.resume(throwing: ScrignoError.message("Impossibile avviare l'accesso")) }
        }
    }

    @MainActor
    private func saveFile(name: String, data: Data) async throws -> Bool {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent((name as NSString).lastPathComponent)
        try data.write(to: url, options: .atomic)
        defer { try? FileManager.default.removeItem(at: url) }
        let picked = await pick(UIDocumentPickerViewController(forExporting: [url], asCopy: true))
        return picked != nil
    }

    @MainActor
    func pick(_ picker: UIDocumentPickerViewController) async -> [URL]? {
        await withCheckedContinuation { c in
            pickerDone = { c.resume(returning: $0) }
            picker.delegate = self
            present(picker, animated: true)
        }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { pickerDone?(urls); pickerDone = nil }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { pickerDone?(nil); pickerDone = nil }
}

/// Elenco mostrato da iOS sopra la tastiera (QuickType): solo nomi utente e siti, mai le password.
enum Identities {
    static func replace(_ list: [JSON]) async {
        let store = ASCredentialIdentityStore.shared
        guard await store.state().isEnabled else { return }
        var ids: [ASCredentialIdentity] = []
        for o in list {
            let rec = o["id"] as? String
            if (o["type"] as? String) == "passkey" {
                guard let rp = o["rpId"] as? String, let cid = B64.urlDec(o["credentialId"] as? String ?? "") else { continue }
                let uh = B64.urlDec(o["userHandle"] as? String ?? "") ?? Data()
                ids.append(ASPasskeyCredentialIdentity(relyingPartyIdentifier: rp, userName: o["user"] as? String ?? "", credentialID: cid, userHandle: uh, recordIdentifier: rec))
            } else if let host = o["host"] as? String, !host.isEmpty {
                ids.append(ASPasswordCredentialIdentity(serviceIdentifier: ASCredentialServiceIdentifier(identifier: host, type: .domain), user: o["user"] as? String ?? "", recordIdentifier: rec))
            }
        }
        try? await store.replaceCredentialIdentities(ids)
    }
}

/// Cartella scelta in File (es. iCloud Drive), ricordata con un segnalibro di sicurezza.
enum Folder {
    @MainActor
    static func pick(from host: WebHost) async throws -> JSON? {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.directoryURL = FileManager.default.url(forUbiquityContainerIdentifier: nil)
        guard let url = await host.pick(picker)?.first else { return nil }
        guard url.startAccessingSecurityScopedResource() else { throw ScrignoError.message("Accesso alla cartella negato") }
        defer { url.stopAccessingSecurityScopedResource() }
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        let id = UUID().uuidString
        UserDefaults.standard.set(bookmark, forKey: "folder-" + id)
        let label = url.path.contains("Mobile Documents") ? "iCloud Drive · " + url.lastPathComponent : url.lastPathComponent
        return ["id": id, "label": label]
    }

    private static func resolve(_ id: String) throws -> URL {
        guard let data = UserDefaults.standard.data(forKey: "folder-" + id) else { throw ScrignoError.message("Cartella non più disponibile: ricollegala") }
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: "folder-" + id)
        }
        return url
    }

    static func read(id: String, name: String) throws -> String? {
        let dir = try resolve(id)
        let file = dir.appendingPathComponent((name as NSString).lastPathComponent)
        guard dir.startAccessingSecurityScopedResource() else { throw ScrignoError.message("Accesso alla cartella negato") }
        defer { dir.stopAccessingSecurityScopedResource() }
        if !FileManager.default.fileExists(atPath: file.path) {
            try? FileManager.default.startDownloadingUbiquitousItem(at: file)
            return nil
        }
        var err: NSError?
        var out: String?
        NSFileCoordinator().coordinate(readingItemAt: file, options: [], error: &err) { u in out = try? String(contentsOf: u, encoding: .utf8) }
        if let err { throw err }
        return out
    }

    static func write(id: String, name: String, text: String) throws {
        let dir = try resolve(id)
        let file = dir.appendingPathComponent((name as NSString).lastPathComponent)
        guard dir.startAccessingSecurityScopedResource() else { throw ScrignoError.message("Accesso alla cartella negato") }
        defer { dir.stopAccessingSecurityScopedResource() }
        var err: NSError?
        var werr: Error?
        NSFileCoordinator().coordinate(writingItemAt: file, options: .forReplacing, error: &err) { u in
            do { try Data(text.utf8).write(to: u, options: .atomic) } catch { werr = error }
        }
        if let err { throw err }
        if let werr { throw werr }
    }
}
