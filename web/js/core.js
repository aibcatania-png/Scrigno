'use strict';
/*
 * Scrigno — nucleo condiviso (web app, app native, estensione browser).
 * Nessun riferimento al DOM: funziona anche in service worker.
 *
 * Formato del vault (identico in JS, Kotlin e Swift):
 *  - DEK casuale AES-256-GCM cifra { items: [...] } con AAD "scrigno-v1".
 *  - La DEK è avvolta (AES-GCM, senza AAD) da una chiave PBKDF2-SHA256 della master password.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const now = () => Date.now();
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => crypto.randomUUID();

function toB64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
const b64u = {
  to: buf => toB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  from: s => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
};
const fmtDate = ts => ts ? new Date(ts).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const clone = o => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- IndexedDB (chiave/valore)
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('scrigno', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k)),
    del: k => tx('readwrite', s => s.delete(k)),
  };
})();

// ---------------------------------------------------------------- crittografia
const KDF_ITER = 600000;
const AAD = enc.encode('scrigno-v1');

async function deriveKEK(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
const newDEK = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
async function wrapKey(dek, kek) {
  const iv = rand(12);
  const ct = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { iv: toB64(iv), ct: toB64(ct) };
}
function unwrapKey(w, kek) {
  return crypto.subtle.unwrapKey('raw', fromB64(w.ct), kek, { name: 'AES-GCM', iv: fromB64(w.iv) },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
const importDEK = raw => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const exportDEK = async dek => toB64(await crypto.subtle.exportKey('raw', dek));
async function encryptJSON(key, obj) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function decryptJSON(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: AAD }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// ---------------------------------------------------------------- vault (funzioni pure)
const FILE_NAME = 'scrigno-vault.json';

// Keyfile: un file qualsiasi, richiesto oltre alla master password. Si usa la sua impronta SHA-256.
async function keyfileHash(bytes) { return toB64(await crypto.subtle.digest('SHA-256', bytes)); }
const kdfSecret = (password, kf) => (kf ? password + '\u0000scrigno-keyfile\u0000' + kf : password);

async function vaultCreate(password, kf = null) {
  const salt = rand(16);
  const dek = await newDEK();
  const kek = await deriveKEK(kdfSecret(password, kf), salt, KDF_ITER);
  const t = now();
  const file = {
    format: 'scrigno', v: 1, vaultId: uuid(),
    kdf: { alg: 'PBKDF2-SHA256', iter: KDF_ITER, salt: toB64(salt), ...(kf ? { keyfile: true } : {}) },
    keys: { pw: await wrapKey(dek, kek) },
    keysUpdatedAt: t, data: null, updatedAt: t,
  };
  file.data = await encryptJSON(dek, { items: [] });
  return { file, dek };
}
async function vaultUnlock(file, password, kf = null) {
  if (!file || file.format !== 'scrigno' || !file.keys) throw new Error('File del vault non valido');
  if (file.kdf.keyfile && !kf) throw Object.assign(new Error('Questo vault richiede anche il keyfile'), { code: 'keyfile' });
  const kek = await deriveKEK(kdfSecret(password, file.kdf.keyfile ? kf : null), fromB64(file.kdf.salt), file.kdf.iter);
  try { return await unwrapKey(file.keys.pw, kek); } catch { throw new Error(file.kdf.keyfile ? 'Password o keyfile errati' : 'Password errata'); }
}
async function vaultRead(file, dek) {
  const d = file.data ? await decryptJSON(dek, file.data) : { items: [] };
  return d.items || [];
}
async function vaultWrite(file, dek, items) {
  file.data = await encryptJSON(dek, { items });
  file.updatedAt = now();
  return file;
}
// Cambia master password e/o keyfile (newKf: impronta del nuovo keyfile, oppure null per non usarlo).
async function vaultChangePassword(file, dek, cur, nw, curKf = null, newKf = null) {
  await vaultUnlock(file, cur, curKf).catch(e => { throw new Error(e.code === 'keyfile' ? e.message : 'La password attuale (o il keyfile) non è corretta'); });
  const salt = rand(16);
  const kek = await deriveKEK(kdfSecret(nw, newKf), salt, KDF_ITER);
  file.kdf = { alg: 'PBKDF2-SHA256', iter: KDF_ITER, salt: toB64(salt), ...(newKf ? { keyfile: true } : {}) };
  file.keys = { pw: await wrapKey(dek, kek) };
  file.keysUpdatedAt = now();
  return file;
}

function mergeItems(local, remote) {
  const map = new Map(local.map(i => [i.id, i]));
  const remoteIds = new Set();
  let localNewer = false, remoteNewer = false;
  for (const r of remote) {
    remoteIds.add(r.id);
    const l = map.get(r.id);
    if (!l || r.updated > l.updated) { map.set(r.id, r); remoteNewer = true; } else if (l.updated > r.updated) localNewer = true;
  }
  for (const l of local) if (!remoteIds.has(l.id)) localNewer = true;
  return { items: [...map.values()], localNewer, remoteNewer };
}

/*
 * Unisce un'altra copia dello stesso vault (cloud, file su disco, altra scheda).
 * Restituisce: items uniti, se la copia locale è cambiata, se l'altra copia va aggiornata.
 */
async function vaultMerge(file, dek, items, other) {
  if (other.format !== 'scrigno') throw new Error('Il file non è un vault Scrigno.');
  if (other.vaultId !== file.vaultId) throw Object.assign(new Error('Il file contiene un vault diverso da questo.'), { code: 'other-vault' });
  let changedLocal = false, updateOther = false;
  const rk = other.keysUpdatedAt || 0, lk = file.keysUpdatedAt || 0;
  if (rk > lk) { file.kdf = other.kdf; file.keys = other.keys; file.keysUpdatedAt = rk; changedLocal = true; }
  if (lk > rk) updateOther = true;
  const m = mergeItems(items, await vaultRead(other, dek));
  if (m.remoteNewer) changedLocal = true;
  if (m.localNewer) updateOther = true;
  return { items: m.items, changedLocal, updateOther };
}

// ---------------------------------------------------------------- tipi di elemento
const TYPES = {
  login: { label: 'Login', plural: 'Login', icon: '🔑', fields: [
    ['username', 'Nome utente o email'], ['password', 'Password', 'secret'], ['url', 'Sito web', 'url'],
    ['totp', 'Segreto 2FA (TOTP)', 'totp'], ['notes', 'Note', 'multi']] },
  card: { label: 'Carta', plural: 'Carte', icon: '💳', fields: [
    ['holder', 'Intestatario'], ['number', 'Numero', 'secret'], ['expiry', 'Scadenza (MM/AA)'],
    ['cvv', 'CVV', 'secret'], ['pin', 'PIN', 'secret'], ['notes', 'Note', 'multi']] },
  identity: { label: 'Identità', plural: 'Identità', icon: '🪪', fields: [
    ['firstName', 'Nome'], ['lastName', 'Cognome'], ['email', 'Email'], ['phone', 'Telefono'],
    ['address', 'Indirizzo', 'multi'], ['birthDate', 'Data di nascita'], ['taxCode', 'Codice fiscale'],
    ['docNumber', 'Numero documento', 'secret'], ['notes', 'Note', 'multi']] },
  note: { label: 'Nota sicura', plural: 'Note sicure', icon: '📝', fields: [['notes', 'Testo', 'multi']] },
  wifi: { label: 'Wi-Fi', plural: 'Wi-Fi', icon: '📶', fields: [
    ['ssid', 'Nome rete (SSID)'], ['password', 'Password', 'secret'], ['security', 'Sicurezza (WPA2, WPA3…)'], ['notes', 'Note', 'multi']] },
  bank: { label: 'Conto bancario', plural: 'Conti bancari', icon: '🏦', fields: [
    ['bankName', 'Banca'], ['holder', 'Intestatario'], ['iban', 'IBAN'], ['bic', 'BIC / SWIFT'], ['username', 'Utente home banking'],
    ['password', 'Password', 'secret'], ['pin', 'PIN', 'secret'], ['url', 'Sito web', 'url'], ['notes', 'Note', 'multi']] },
  document: { label: 'Documento', plural: 'Documenti', icon: '🛂', fields: [
    ['docType', 'Tipo (carta d\'identità, passaporto, patente…)'], ['number', 'Numero', 'secret'], ['name', 'Intestatario'],
    ['issued', 'Rilasciato il'], ['expires', 'Scadenza'], ['authority', 'Rilasciato da'], ['notes', 'Note', 'multi']] },
  license: { label: 'Licenza software', plural: 'Licenze', icon: '💿', fields: [
    ['product', 'Prodotto'], ['key', 'Chiave di licenza', 'secret'], ['email', 'Email registrata'], ['purchased', 'Data di acquisto'],
    ['url', 'Sito web', 'url'], ['notes', 'Note', 'multi']] },
  server: { label: 'Server / SSH', plural: 'Server', icon: '🖥️', fields: [
    ['host', 'Indirizzo'], ['port', 'Porta'], ['username', 'Utente'], ['password', 'Password', 'secret'],
    ['privateKey', 'Chiave privata', 'secret-multi'], ['notes', 'Note', 'multi']] },
  email: { label: 'Account email', plural: 'Account email', icon: '✉️', fields: [
    ['email', 'Indirizzo email'], ['password', 'Password', 'secret'], ['imap', 'Server in entrata (IMAP)'], ['smtp', 'Server in uscita (SMTP)'],
    ['url', 'Webmail', 'url'], ['notes', 'Note', 'multi']] },
  passkey: { label: 'Passkey', plural: 'Passkey', icon: '🔐', fields: [
    ['rpId', 'Sito (rpId)'], ['username', 'Nome utente'], ['credentialId', 'ID credenziale'],
    ['userHandle', 'User handle'], ['privateKey', 'Chiave privata', 'secret-multi'], ['notes', 'Note', 'multi']] },
};
const APP_FIELD = 'App Android';

// Elementi interni (chiavi di altri vault, modelli personalizzati) hanno il tipo che inizia con "_".
const isInternal = i => String((i && i.type) || '').startsWith('_');
const isActive = i => !!i && !i.deleted && !i.trashed && !isInternal(i);
const TRASH_DAYS = 30;

function trashItem(it) { it.trashed = now(); it.updated = now(); return it; }
function restoreItem(it) { delete it.trashed; it.updated = now(); return it; }
const tombstone = it => ({ id: it.id, deleted: true, updated: now() });
// Elimina definitivamente gli elementi nel cestino da più di 30 giorni. Ritorna true se qualcosa è cambiato.
function purgeTrash(items, days = TRASH_DAYS) {
  let changed = false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].trashed && now() - items[i].trashed > days * 864e5) { items[i] = tombstone(items[i]); changed = true; }
  }
  return changed;
}
// Conserva le password precedenti (al massimo 15) quando cambiano.
function withHistory(old, item) {
  const hist = (old && old.history) ? old.history.slice() : [];
  const before = old && old.f && old.f.password;
  if (before && before !== item.f.password) hist.unshift({ password: before, until: now() });
  if (hist.length) item.history = hist.slice(0, 15);
  return item;
}

// Modelli personalizzati: elementi interni "_template" con l'elenco dei campi. Gli elementi creati da un modello hanno tipo "tpl:<id>".
const FIELD_KINDS = { text: 'Testo', secret: 'Segreto', url: 'Indirizzo web', multi: 'Testo lungo', totp: 'Segreto 2FA' };
function customTypes(items) {
  const out = {};
  for (const t of items) {
    if (t.deleted || t.type !== '_template') continue;
    let fields = [];
    try { fields = JSON.parse(t.f.fields || '[]'); } catch { fields = []; }
    out['tpl:' + t.id] = { label: t.title, plural: t.title, icon: t.f.icon || '📁', custom: true,
      fields: fields.map(([k, l, kind]) => [k, l, kind === 'text' ? undefined : kind]) };
  }
  return out;
}
function allTypes(items) { return { ...TYPES, ...customTypes(items || []) }; }

// Tag: etichette libere, più d'una per elemento.
function normTags(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(list.map(t => t.trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 20);
}
function allTags(items) {
  const m = new Map();
  for (const i of items) for (const t of i.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'it'));
}

function makeItem(type, title, f, custom = [], fav = false) {
  const t = now();
  return { id: uuid(), type, title: (title || '').trim() || 'Senza titolo', f, custom, fav: !!fav,
    created: t, updated: t, pwChanged: f.password ? t : undefined };
}
function getVal(it, k) {
  if (/^c\d+$/.test(k)) return (it.custom && it.custom[+k.slice(1)] && it.custom[+k.slice(1)].value) || '';
  return (it.f && it.f[k]) || '';
}
function safeUrl(u) {
  if (!u) return '';
  const s = u.trim();
  const w = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s;
  return /^https?:/i.test(w) ? w : '#';
}
function hostOf(u) { try { return new URL(safeUrl(u)).hostname; } catch { return u || ''; } }

// Dominio "principale" approssimato (gestisce i più comuni suffissi a due livelli).
const SLD = new Set(['co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'co.jp', 'co.nz', 'com.br', 'com.mx', 'co.in', 'gov.it', 'edu.it', 'com.tr', 'co.za']);
function baseDomain(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || !host.includes('.')) return host;
  const p = host.split('.');
  const last2 = p.slice(-2).join('.');
  return SLD.has(last2) && p.length >= 3 ? p.slice(-3).join('.') : last2;
}
// Elementi adatti a un sito (host) o a un'app Android (package).
function matchLogins(items, { host, pkg }) {
  const bd = host ? baseDomain(host) : '';
  return items.filter(i => isActive(i) && i.type === 'login').filter(i => {
    if (pkg && (i.custom || []).some(c => c.label === APP_FIELD && c.value === pkg)) return true;
    if (pkg && i.f.url && i.f.url.trim() === 'androidapp://' + pkg) return true;
    if (bd && i.f.url) return baseDomain(hostOf(i.f.url)) === bd;
    return false;
  });
}
function rpIdAllowed(rpId, host) {
  rpId = String(rpId || '').toLowerCase();
  host = String(host || '').toLowerCase();
  if (!rpId) return false;
  if (rpId !== 'localhost' && !rpId.includes('.')) return false;
  if (SLD.has(rpId)) return false;
  return host === rpId || host.endsWith('.' + rpId);
}

// ---------------------------------------------------------------- generatore e robustezza
const CHARS = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.?/~' };
function randInt(n) {
  const lim = Math.floor(0x100000000 / n) * n;
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= lim);
  return a[0] % n;
}
function genPassword(o) {
  const sets = Object.keys(CHARS).filter(k => o[k]).map(k => o.noAmbig ? CHARS[k].replace(/[Il1O0o|]/g, '') : CHARS[k]);
  if (!sets.length) sets.push(CHARS.lower);
  const all = sets.join('');
  const len = Math.max(o.length || 16, sets.length);
  const out = sets.map(s => s[randInt(s.length)]);
  while (out.length < len) out.push(all[randInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}
const GEN_DEFAULT = { length: 20, lower: true, upper: true, digits: true, symbols: true, noAmbig: false };
const COMMON = new Set(['password', 'password1', '123456', '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123',
  'iloveyou', 'admin', 'welcome', 'letmein', '111111', '000000', 'abc123', 'juventus', 'napoli', 'milan', 'inter',
  'ciao123', 'ciao', 'amore', 'roma', 'passw0rd', 'asdfgh', 'qwertyuiop']);
function strength(pw) {
  if (!pw) return { bits: 0, lvl: 0, label: '—' };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(pool || 1);
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) bits = Math.min(bits, 10);
  if (/(.)\1\1/.test(pw)) bits *= 0.85;
  if (/^\d+$/.test(pw)) bits = Math.min(bits, 30);
  const lvl = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { bits: Math.round(bits), lvl, label: ['', 'Debole', 'Discreta', 'Buona', 'Ottima'][lvl] };
}

// ---------------------------------------------------------------- TOTP (RFC 6238)
function base32Decode(s) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const i = a.indexOf(c);
    if (i < 0) throw new Error('Segreto 2FA non valido');
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
function parseTotp(input) {
  const s = String(input || '').trim();
  let cfg = { secret: s, digits: 6, period: 30, algorithm: 'SHA-1' };
  if (/^otpauth:\/\//i.test(s)) {
    const p = new URL(s).searchParams;
    cfg = {
      secret: p.get('secret') || '',
      digits: +(p.get('digits') || 6),
      period: +(p.get('period') || 30),
      algorithm: { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[(p.get('algorithm') || 'SHA1').toUpperCase()] || 'SHA-1',
    };
  }
  let ok = false;
  try { ok = base32Decode(cfg.secret).length >= 5; } catch { ok = false; }
  if (!ok) throw new Error('Segreto 2FA non valido: incolla il codice segreto o il link otpauth://');
  if (![6, 7, 8].includes(cfg.digits) || !(cfg.period > 0)) throw new Error('Parametri 2FA non supportati');
  return cfg;
}
async function totp(cfg, t = now()) {
  const counter = Math.floor(t / 1000 / cfg.period);
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 0x100000000));
  dv.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', base32Decode(cfg.secret), { name: 'HMAC', hash: cfg.algorithm }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const o = h[h.length - 1] & 15;
  const code = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** cfg.digits;
  return String(code).padStart(cfg.digits, '0');
}

// ---------------------------------------------------------------- importazione
function parseCSV(t) {
  t = t.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = names => head.findIndex(h => names.includes(h));
  const ix = {
    title: col(['name', 'title', 'titolo', 'nome']), url: col(['url', 'login_uri', 'website', 'sito']),
    user: col(['username', 'login_username', 'user', 'email', 'utente']), pw: col(['password', 'login_password']),
    notes: col(['note', 'notes', 'extra']), totp: col(['totp', 'login_totp', 'otpauth']), fav: col(['favorite', 'preferito']),
  };
  if (ix.pw < 0 && ix.user < 0) throw new Error('CSV non riconosciuto: servono almeno le colonne username e password.');
  const g = (r, i) => (i >= 0 ? (r[i] || '').trim() : '');
  return rows.slice(1).map(r => {
    const f = {};
    if (g(r, ix.user)) f.username = g(r, ix.user);
    if (ix.pw >= 0 && r[ix.pw]) f.password = r[ix.pw];
    if (g(r, ix.url)) f.url = g(r, ix.url);
    if (g(r, ix.totp)) f.totp = g(r, ix.totp);
    if (g(r, ix.notes)) f.notes = g(r, ix.notes);
    return makeItem('login', g(r, ix.title) || hostOf(f.url) || f.username, f, [], g(r, ix.fav) === '1');
  });
}
function importEnpass(json) {
  const MAP = {
    login: { username: 'username', email: 'username', password: 'password', url: 'url', totp: 'totp' },
    card: { ccName: 'holder', ccNumber: 'number', ccExpiry: 'expiry', ccCvc: 'cvv', ccPin: 'pin' },
    identity: {}, note: {},
  };
  if (!Array.isArray(json.items)) throw new Error('File Enpass non riconosciuto: esporta in formato .json.');
  // le cartelle di Enpass diventano tag
  const folders = new Map((json.folders || []).map(fo => [fo.uuid, fo.title]));
  const out = [];
  for (const e of json.items) {
    if (e.trashed || e.archived) continue;
    const type = e.category === 'creditcard' ? 'card' : e.category === 'note' ? 'note' : e.category === 'identity' ? 'identity' : 'login';
    const f = {}, custom = [];
    for (const fl of e.fields || []) {
      if (!fl.value || fl.deleted || fl.type === 'section') continue;
      const target = MAP[type][fl.type];
      if (target && !f[target]) f[target] = fl.value;
      else custom.push({ label: fl.label || fl.type, value: fl.value, secret: !!fl.sensitive });
    }
    if (e.note) f.notes = e.note;
    const it = makeItem(type, e.title, f, custom, !!e.favorite);
    const tags = (e.folders || []).map(id => folders.get(id)).filter(Boolean);
    if (tags.length) it.tags = [...new Set(tags)];
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------- controlli online (nessun dato del vault esce dal dispositivo)
// Have I Been Pwned: si invia solo l'inizio (5 caratteri) dell'impronta SHA-1 della password.
const pwnedCache = new Map();
async function pwnedCount(password, fetchFn) {
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(password)))]
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const pre = h.slice(0, 5), suf = h.slice(5);
  let body = pwnedCache.get(pre);
  if (body == null) {
    const r = await fetchFn('https://api.pwnedpasswords.com/range/' + pre);
    if (!r.ok) throw new Error('Servizio di controllo violazioni non raggiungibile (' + r.status + ')');
    body = await r.text();
    pwnedCache.set(pre, body);
  }
  for (const line of body.split('\n')) {
    const [sx, c] = line.trim().split(':');
    if (sx === suf) return +c || 0;
  }
  return 0;
}

// Elenchi pubblici di 2fa.directory: siti che offrono codici 2FA (TOTP) e siti che supportano le passkey.
async function loadDirectories(fetchFn, cache) {
  let c = null;
  try { c = await cache.get('cache-dirs'); } catch { c = null; }
  if (c && c.ts && now() - c.ts < 7 * 864e5 && c.tfa && c.pk) return c;
  const get = url => fetchFn(url).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
  const [tfa, pk] = await Promise.allSettled([get('https://api.2fa.directory/v3/totp.json'), get('https://passkeys-api.2fa.directory/v1/supported.json')]);
  if (tfa.status === 'rejected' && pk.status === 'rejected') {
    if (c) return c;
    throw new Error('Elenchi di 2fa.directory non raggiungibili');
  }
  const out = { ts: now(), tfa: (c && c.tfa) || {}, pk: (c && c.pk) || {} };
  if (tfa.status === 'fulfilled') {
    out.tfa = {};
    for (const [name, d] of tfa.value || []) {
      for (const dom of [d.domain, ...(d['additional-domains'] || [])]) if (dom) out.tfa[baseDomain(dom)] = [name, d.documentation || d.url || ''];
    }
  }
  if (pk.status === 'fulfilled') {
    out.pk = {};
    for (const [dom, d] of Object.entries(pk.value || {})) {
      for (const x of [dom, ...((d && d['additional-domains']) || [])]) out.pk[baseDomain(x)] = (d && d.documentation) || '';
    }
  }
  try { await cache.set('cache-dirs', out); } catch { /* ignora */ }
  return out;
}
