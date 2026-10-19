import AuthenticationServices
import LocalAuthentication
import SwiftUI

/// Estensione AutoFill di iOS: password e passkey di Scrigno in Safari e nelle app.
final class CredentialProviderViewController: ASCredentialProviderViewController {
    private let model = ProviderModel()
    private let store = SharedStore.shared

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ProviderView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        model.onCancel = { [weak self] in self?.cancel(.userCanceled) }
    }

    private func cancel(_ code: ASExtensionError.Code) {
        extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
    }

    private func hostOf(_ s: ASCredentialServiceIdentifier) -> String {
        s.type == .URL ? Vault.hostOf(s.identifier) : s.identifier.lowercased()
    }

    // ------------------------------------------------------------ elenco password (icona chiave sopra la tastiera)
    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        let host = serviceIdentifiers.first.map(hostOf)
        model.begin(reason: host.map { "Sblocca per compilare \($0)" } ?? "Sblocca Scrigno") { [weak self] dek, _ in
            self?.showPasswords(dek: dek, host: host)
        }
    }

    private func showPasswords(dek: Data, host: String?) {
        let items = (try? store.items(dek: dek)) ?? []
        let logins = items.filter { Vault.type($0) == "login" && !Vault.field($0, "password").isEmpty }
        let preferred = Set(Vault.matchLogins(logins, host: host).map(Vault.id))
        model.showList(title: "Scegli un login", subtitle: host, items: logins, preferred: preferred) { [weak self] item in
            let cred = ASPasswordCredential(user: Vault.field(item, "username"), password: Vault.field(item, "password"))
            self?.extensionContext.completeRequest(withSelectedCredential: cred, completionHandler: nil)
        }
    }

    // ------------------------------------------------------------ elenco passkey (iOS 17)
    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier], requestParameters: ASPasskeyCredentialRequestParameters) {
        let rpId = requestParameters.relyingPartyIdentifier
        let allowed = Set(requestParameters.allowedCredentials.map(B64.urlEnc))
        model.begin(reason: "Sblocca per accedere a \(rpId)") { [weak self] dek, verified in
            guard let self else { return }
            let all = (try? self.store.items(dek: dek)) ?? []
            let keys = Vault.passkeys(all, rpId: rpId).filter { allowed.isEmpty || allowed.contains(Vault.field($0, "credentialId")) }
            let logins = Vault.matchLogins(all, host: rpId).filter { !Vault.field($0, "password").isEmpty }
            self.model.showList(title: "Accedi a \(rpId)", subtitle: keys.isEmpty ? "Nessuna passkey in Scrigno per questo sito" : nil,
                                items: keys + logins, preferred: Set(keys.map(Vault.id))) { item in
                if Vault.type(item) == "passkey" {
                    self.assertPasskey(item, rpId: rpId, clientDataHash: requestParameters.clientDataHash, verified: verified)
                } else {
                    let cred = ASPasswordCredential(user: Vault.field(item, "username"), password: Vault.field(item, "password"))
                    self.extensionContext.completeRequest(withSelectedCredential: cred, completionHandler: nil)
                }
            }
        }
    }

    // ------------------------------------------------------------ suggerimento scelto dalla barra QuickType
    override func provideCredentialWithoutUserInteraction(for credentialRequest: ASCredentialRequest) {
        guard credentialRequest.type == .password, let dek = Session.get() else { cancel(.userInteractionRequired); return }
        complete(credentialRequest, dek: dek, verified: false)
    }

    override func prepareInterfaceToProvideCredential(for credentialRequest: ASCredentialRequest) {
        model.begin(reason: "Sblocca Scrigno") { [weak self] dek, verified in self?.complete(credentialRequest, dek: dek, verified: verified) }
    }

    private func complete(_ request: ASCredentialRequest, dek: Data, verified: Bool) {
        let items = (try? store.items(dek: dek)) ?? []
        let rec = request.credentialIdentity.recordIdentifier
        if request.type == .password {
            guard let item = items.first(where: { Vault.id($0) == rec }) else { cancel(.credentialIdentityNotFound); return }
            let cred = ASPasswordCredential(user: Vault.field(item, "username"), password: Vault.field(item, "password"))
            extensionContext.completeRequest(withSelectedCredential: cred, completionHandler: nil)
            return
        }
        guard let req = request as? ASPasskeyCredentialRequest, let ident = request.credentialIdentity as? ASPasskeyCredentialIdentity else { cancel(.failed); return }
        let cid = B64.urlEnc(ident.credentialID)
        guard let item = items.first(where: { Vault.id($0) == rec || (Vault.type($0) == "passkey" && Vault.field($0, "credentialId") == cid) }) else {
            cancel(.credentialIdentityNotFound); return
        }
        assertPasskey(item, rpId: ident.relyingPartyIdentifier, clientDataHash: req.clientDataHash, verified: verified)
    }

    private func assertPasskey(_ item: JSON, rpId: String, clientDataHash: Data, verified: Bool) {
        model.withUserVerification(already: verified, reason: "Accedi con la passkey") { [weak self] uv in
            guard let self else { return }
            guard uv || !LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { self.cancel(.userCanceled); return }
            do {
                guard Vault.field(item, "rpId") == rpId else { throw ScrignoError.message("La passkey non appartiene a questo sito") }
                let r = try Passkeys.assert(privateKeyB64: Vault.field(item, "privateKey"), rpId: rpId, clientDataHash: clientDataHash, uv: uv)
                let cred = ASPasskeyAssertionCredential(
                    userHandle: B64.urlDec(Vault.field(item, "userHandle")) ?? Data(), relyingParty: rpId, signature: r.signature,
                    clientDataHash: clientDataHash, authenticatorData: r.authData, credentialID: B64.urlDec(Vault.field(item, "credentialId")) ?? Data())
                self.extensionContext.completeAssertionRequest(using: cred, completionHandler: nil)
            } catch {
                self.model.show(message: error.localizedDescription)
            }
        }
    }

    // ------------------------------------------------------------ nuova passkey
    override func prepareInterface(forPasskeyRegistration registrationRequest: ASCredentialRequest) {
        guard let req = registrationRequest as? ASPasskeyCredentialRequest, let ident = req.credentialIdentity as? ASPasskeyCredentialIdentity else { cancel(.failed); return }
        guard req.supportedAlgorithms.contains(ASCOSEAlgorithmIdentifier.ES256) else { cancel(.failed); return }
        model.begin(reason: "Sblocca per salvare la passkey di \(ident.relyingPartyIdentifier)") { [weak self] dek, verified in
            guard let self else { return }
            self.model.withUserVerification(already: verified, reason: "Crea la passkey") { uv in
                do {
                    let c = Passkeys.create(rpId: ident.relyingPartyIdentifier, userHandle: ident.userHandle, userName: ident.userName, uv: uv)
                    try self.store.update(dek: dek) { items in
                        items.append(Vault.newItem(type: "passkey", title: ident.relyingPartyIdentifier, f: c.fields))
                    }
                    let cred = ASPasskeyRegistrationCredential(relyingParty: ident.relyingPartyIdentifier, clientDataHash: req.clientDataHash,
                                                               credentialID: c.credentialId, attestationObject: c.attestationObject)
                    self.extensionContext.completeRegistrationRequest(using: cred, completionHandler: nil)
                } catch {
                    self.model.show(message: error.localizedDescription)
                }
            }
        }
    }
}

// ---------------------------------------------------------------- interfaccia
@MainActor
final class ProviderModel: ObservableObject {
    enum Stage { case working, unlock, list, message }
    @Published var stage: Stage = .working
    @Published var password = ""
    @Published var error: String?
    @Published var query = ""
    @Published var title = "Scrigno"
    @Published var subtitle: String?
    @Published var items: [JSON] = []
    @Published var message = ""
    var reason = ""
    var preferred: Set<String> = []
    var onCancel: () -> Void = {}
    private var unlocked: ((Data, Bool) -> Void)?
    private var picked: ((JSON) -> Void)?

    func begin(reason: String, then: @escaping (Data, Bool) -> Void) {
        if let dek = Session.get() { then(dek, false); return }
        guard SharedStore.shared.vault() != nil else { show(message: "Apri l'app Scrigno e crea o scarica il tuo vault."); return }
        self.reason = reason
        unlocked = then
        stage = .unlock
        if Bio.enrolled { useBio() }
    }

    func useBio() {
        Bio.unlock(reason: reason) { [weak self] dek, err in
            guard let self else { return }
            if let dek { Session.set(dek, ttlMin: Session.ttl()); self.finishUnlock(dek) } else if let err { self.error = err }
        }
    }

    func submitPassword() {
        guard let file = SharedStore.shared.vault() else { return }
        let pw = password
        stage = .working
        Task.detached {
            do {
                let dek = try VaultCrypto.unlock(file, password: pw)
                await MainActor.run { Session.set(dek, ttlMin: Session.ttl()); self.finishUnlock(dek) }
            } catch {
                await MainActor.run { self.error = error.localizedDescription; self.stage = .unlock }
            }
        }
    }

    private func finishUnlock(_ dek: Data) {
        password = ""
        error = nil
        stage = .working
        unlocked?(dek, true)
    }

    func showList(title: String, subtitle: String?, items: [JSON], preferred: Set<String>, pick: @escaping (JSON) -> Void) {
        self.title = title
        self.subtitle = subtitle
        self.preferred = preferred
        self.items = items.sorted {
            let a = preferred.contains(Vault.id($0)), b = preferred.contains(Vault.id($1))
            return a != b ? a : Vault.title($0).localizedCaseInsensitiveCompare(Vault.title($1)) == .orderedAscending
        }
        picked = pick
        stage = .list
    }

    var filtered: [JSON] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return items }
        return items.filter { (Vault.title($0) + " " + Vault.field($0, "username") + " " + Vault.field($0, "url")).lowercased().contains(q) }
    }

    func pick(_ item: JSON) { stage = .working; picked?(item) }

    func show(message: String) { self.message = message; stage = .message }

    /// Verifica dell'utente (Face ID o codice) prima di usare o creare una passkey, se non è appena avvenuta.
    func withUserVerification(already: Bool, reason: String, then: @escaping (Bool) -> Void) {
        if already { then(true); return }
        let ctx = LAContext()
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { then(false); return }
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            DispatchQueue.main.async { if ok { then(true) } else { self.onCancel() } }
        }
    }
}

struct ProviderView: View {
    @ObservedObject var model: ProviderModel

    var body: some View {
        NavigationStack {
            Group {
                switch model.stage {
                case .working:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .message:
                    VStack(spacing: 16) {
                        Image(systemName: "lock.shield").font(.system(size: 44)).foregroundStyle(.teal)
                        Text(model.message).multilineTextAlignment(.center)
                    }.padding()
                case .unlock:
                    Form {
                        Section {
                            Text(model.reason).font(.subheadline).foregroundStyle(.secondary)
                            SecureField("Master password", text: $model.password)
                                .textContentType(.password)
                                .onSubmit { model.submitPassword() }
                            if let e = model.error { Text(e).foregroundStyle(.red).font(.footnote) }
                        }
                        Section {
                            Button("Sblocca") { model.submitPassword() }.disabled(model.password.isEmpty)
                            if Bio.enrolled { Button("Usa Face ID / Touch ID") { model.useBio() } }
                        }
                    }
                case .list:
                    List {
                        if let s = model.subtitle { Text(s).font(.footnote).foregroundStyle(.secondary) }
                        ForEach(Array(model.filtered.enumerated()), id: \.offset) { _, item in
                            Button { model.pick(item) } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: Vault.type(item) == "passkey" ? "person.badge.key.fill" : "key.fill")
                                        .foregroundStyle(model.preferred.contains(Vault.id(item)) ? .teal : .secondary)
                                    VStack(alignment: .leading) {
                                        Text(Vault.title(item)).foregroundStyle(.primary)
                                        Text(Vault.field(item, "username")).font(.footnote).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    .searchable(text: $model.query, prompt: "Cerca")
                }
            }
            .navigationTitle(model.stage == .list ? model.title : "Scrigno")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annulla") { model.onCancel() } } }
        }
    }
}
