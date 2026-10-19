'use strict';
/*
 * Eseguito nel contesto della pagina (world MAIN): intercetta navigator.credentials
 * per offrire le passkey di Scrigno. Se l'utente sceglie il browser, o Scrigno non può
 * gestire la richiesta, passa all'implementazione originale.
 */
(() => {
  if (!window.navigator.credentials || window.__scrignoPasskeys) return;
  Object.defineProperty(window, '__scrignoPasskeys', { value: true });
  const creds = navigator.credentials;
  const origCreate = creds.create.bind(creds);
  const origGet = creds.get.bind(creds);
  const CH = 'scrigno-pk-' + Math.random().toString(36).slice(2);
  const pending = new Map();
  let seq = 0;

  // Il canale viene comunicato allo script dell'estensione (anche se si carica dopo questo script).
  const hello = () => window.postMessage({ scrignoHello: CH }, '*');
  hello();
  window.addEventListener('message', e => { if (e.source === window && e.data && e.data.scrignoPing) hello(); });

  const toB64u = buf => {
    const u = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64u = s => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u.buffer;
  };
  const descList = l => (l || []).map(c => ({ type: c.type, id: toB64u(c.id) }));

  function ask(payload) {
    return new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      window.postMessage({ scrignoReq: CH, id, payload }, '*');
    });
  }
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.scrignoRes !== CH) return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    p.res(e.data.result);
  });

  function defineAll(obj, props) {
    for (const [k, v] of Object.entries(props)) Object.defineProperty(obj, k, { value: v, enumerable: true, configurable: true });
    return obj;
  }
  function makeCredential(c) {
    const rawId = fromB64u(c.id);
    let resp;
    if (c.kind === 'create') {
      resp = Object.create(window.AuthenticatorAttestationResponse ? AuthenticatorAttestationResponse.prototype : Object.prototype);
      defineAll(resp, {
        clientDataJSON: fromB64u(c.clientDataJSON), attestationObject: fromB64u(c.attestationObject),
        getTransports: () => c.transports.slice(), getAuthenticatorData: () => fromB64u(c.authenticatorData),
        getPublicKey: () => fromB64u(c.publicKey), getPublicKeyAlgorithm: () => c.publicKeyAlgorithm,
        toJSON: () => ({ clientDataJSON: c.clientDataJSON, attestationObject: c.attestationObject, authenticatorData: c.authenticatorData,
          publicKey: c.publicKey, publicKeyAlgorithm: c.publicKeyAlgorithm, transports: c.transports }),
      });
    } else {
      resp = Object.create(window.AuthenticatorAssertionResponse ? AuthenticatorAssertionResponse.prototype : Object.prototype);
      defineAll(resp, {
        clientDataJSON: fromB64u(c.clientDataJSON), authenticatorData: fromB64u(c.authenticatorData),
        signature: fromB64u(c.signature), userHandle: c.userHandle ? fromB64u(c.userHandle) : null,
        toJSON: () => ({ clientDataJSON: c.clientDataJSON, authenticatorData: c.authenticatorData, signature: c.signature, userHandle: c.userHandle }),
      });
    }
    const cred = Object.create(window.PublicKeyCredential ? PublicKeyCredential.prototype : Object.prototype);
    const ext = c.kind === 'create' ? { credProps: { rk: true } } : {};
    return defineAll(cred, {
      id: c.id, rawId, type: 'public-key', response: resp, authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ext,
      toJSON: () => ({ id: c.id, rawId: c.id, type: 'public-key', authenticatorAttachment: 'platform', response: resp.toJSON(), clientExtensionResults: ext }),
    });
  }
  function toError(r) {
    const e = new DOMException(r.message || 'Operazione non consentita', r.error || 'NotAllowedError');
    return e;
  }

  creds.create = async function (options) {
    if (!options || !options.publicKey) return origCreate(options);
    const pk = options.publicKey;
    let r;
    try {
      r = await ask({ kind: 'create', options: {
        rp: { id: pk.rp && pk.rp.id, name: pk.rp && pk.rp.name },
        user: { id: toB64u(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
        challenge: toB64u(pk.challenge), pubKeyCredParams: (pk.pubKeyCredParams || []).map(p => ({ alg: p.alg, type: p.type })),
        excludeCredentials: descList(pk.excludeCredentials),
      } });
    } catch { r = { fallback: true }; }
    if (!r || r.fallback) return origCreate(options);
    if (r.error) throw toError(r);
    return makeCredential(r.credential);
  };

  creds.get = async function (options) {
    if (!options || !options.publicKey) return origGet(options);
    const pk = options.publicKey;
    const req = { rpId: pk.rpId, challenge: toB64u(pk.challenge), allowCredentials: descList(pk.allowCredentials) };
    if (options.mediation === 'conditional') {
      // Compilazione automatica: la richiesta resta aperta finché l'utente non sceglie una passkey dal menu di Scrigno.
      const ac = new AbortController();
      if (options.signal) options.signal.addEventListener('abort', () => ac.abort(options.signal.reason));
      const ours = ask({ kind: 'get', conditional: true, options: req }).then(r => {
        if (!r || !r.credential) return new Promise(() => {});
        ac.abort();
        return makeCredential(r.credential);
      }, () => new Promise(() => {}));
      const theirs = origGet({ ...options, signal: ac.signal }).catch(e => {
        if (ac.signal.aborted && !(options.signal && options.signal.aborted)) return new Promise(() => {});
        throw e;
      });
      return Promise.race([ours, theirs]);
    }
    let r;
    try { r = await ask({ kind: 'get', options: req }); } catch { r = { fallback: true }; }
    if (!r || r.fallback) return origGet(options);
    if (r.error) throw toError(r);
    return makeCredential(r.credential);
  };
})();
