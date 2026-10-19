'use strict';
/*
 * Autenticatore WebAuthn software (ES256) usato dall'estensione browser.
 * Lo stesso formato è implementato in Kotlin (Android) e Swift (iOS):
 *  - chiave privata P-256 in PKCS#8 (base64), credentialId 16 byte casuali (base64url)
 *  - attestazione "none", contatore sempre 0, flag BE/BS (passkey sincronizzabile)
 */

const PK_AAGUID = Uint8Array.from([0x5c, 0x7a, 0x3f, 0x20, 0x9b, 0x1e, 0x4d, 0x8a, 0xa6, 0xc3, 0x2f, 0x0e, 0x8b, 0x4d, 0x1a, 0x77]);
const PK_FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// CBOR minimale: interi, byte, stringhe, array, Map (chiavi nell'ordine dato).
function cborEncode(v) {
  const head = (major, n) => {
    if (n < 24) return Uint8Array.of((major << 5) | n);
    if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
    if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
    return Uint8Array.of((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return concatBytes(head(2, v.length), v);
  if (typeof v === 'string') { const b = enc.encode(v); return concatBytes(head(3, b.length), b); }
  if (Array.isArray(v)) return concatBytes(head(4, v.length), ...v.map(cborEncode));
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cborEncode(k), cborEncode(x));
    return concatBytes(...parts);
  }
  throw new Error('CBOR: tipo non supportato');
}

// Firma ECDSA da formato grezzo r||s (WebCrypto) a DER (WebAuthn).
function ecdsaRawToDer(raw) {
  const int = b => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    if (b[0] & 0x80) b = concatBytes(Uint8Array.of(0), b);
    return concatBytes(Uint8Array.of(0x02, b.length), b);
  };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32, 64));
  return concatBytes(Uint8Array.of(0x30, r.length + s.length), r, s);
}

const sha256 = async data => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

function clientDataJSON(type, challengeB64u, origin) {
  return enc.encode(JSON.stringify({ type, challenge: challengeB64u, origin, crossOrigin: false }));
}

async function authData(rpId, flags, attested) {
  const parts = [await sha256(rpId), Uint8Array.of(flags), Uint8Array.of(0, 0, 0, 0)];
  if (attested) parts.push(attested);
  return concatBytes(...parts);
}

/*
 * Crea una passkey.
 * Ritorna i campi per l'elemento del vault e la risposta da consegnare al sito.
 */
async function passkeyCreate({ rpId, userId, userName, clientDataHash }) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const credId = rand(16);
  const cose = cborEncode(new Map([[1, 2], [3, -7], [-1, 1], [-2, b64u.from(jwk.x)], [-3, b64u.from(jwk.y)]]));
  const attested = concatBytes(PK_AAGUID, Uint8Array.of(credId.length >> 8, credId.length & 255), credId, cose);
  const ad = await authData(rpId, PK_FLAGS.UP | PK_FLAGS.UV | PK_FLAGS.BE | PK_FLAGS.BS | PK_FLAGS.AT, attested);
  const attObj = cborEncode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  void clientDataHash;
  return {
    fields: { rpId, username: userName || '', credentialId: b64u.to(credId), userHandle: userId || '', privateKey: toB64(pkcs8) },
    credentialId: credId, attestationObject: attObj, authenticatorData: ad, publicKey: spki,
  };
}

async function passkeyAssert({ privateKey, rpId, clientDataHash }) {
  const key = await crypto.subtle.importKey('pkcs8', fromB64(privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const ad = await authData(rpId, PK_FLAGS.UP | PK_FLAGS.UV | PK_FLAGS.BE | PK_FLAGS.BS);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concatBytes(ad, clientDataHash)));
  return { authenticatorData: ad, signature: ecdsaRawToDer(raw) };
}
