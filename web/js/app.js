'use strict';
/* Scrigno — interfaccia (web app e app native). Usa core.js, native.js, cloud.js, vaults.js. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CONFIG = self.SCRIGNO_CONFIG || { pagesUrl: '' };
const MAIN = 'main';
const MAX_ATTACHMENT = 5 * 1024 * 1024;

function toast(msg, ms = 2400) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------------------------------------------------------- stato
const S = {
  file: null, dek: null, items: [], settings: null,
  extra: [],               // vault aggiuntivi: { id, name, keyId, dek, file, items, cfg, err }
  sync: null, syncState: 'idle', syncErr: null, pendingSync: null,
  bio: null, bioAvail: false,
  view: { section: 'all', id: null, edit: false, q: '', newType: null, vault: 'all' },
  setupTab: 'new', gen: { ...GEN_DEFAULT }, genVal: '',
  autotype: null,
  kf: null,                // impronta del keyfile scelta per lo sblocco
  editAtt: [],             // allegati dell'elemento in modifica
  tplEdit: null,           // modello personalizzato in modifica
  pwned: null, pwnedBusy: false, dirs: null, dirsBusy: false, dirsErr: null,
};

function loadSettings() {
  const def = { autoLockMin: 5, clipClearSec: 30, mainName: 'Personale', sort: 'az' };
  try { return { ...def, ...JSON.parse(localStorage.getItem('scrigno-settings') || '{}') }; } catch { return def; }
}
function saveSettings() {
  try { localStorage.setItem('scrigno-settings', JSON.stringify(S.settings)); } catch { /* ignora */ }
  if (S.dek) shareSession();
}
function loadIds() { try { return JSON.parse(localStorage.getItem('scrigno-oauth-ids') || '{}'); } catch { return {}; } }
function saveIds(o) { try { localStorage.setItem('scrigno-oauth-ids', JSON.stringify({ ...loadIds(), ...o })); } catch { /* ignora */ } }
const kfKey = () => 'scrigno-kf-' + (S.file && S.file.vaultId);
function rememberedKf() { try { return localStorage.getItem(kfKey()); } catch { return null; } }
function rememberKf(h) { try { if (h) localStorage.setItem(kfKey(), h); else localStorage.removeItem(kfKey()); } catch { /* ignora */ } }

// ---------------------------------------------------------------- elementi di tutti i vault
const vaultName = id => (id === MAIN ? S.settings.mainName || 'Personale' : (S.extra.find(v => v.id === id) || {}).name || '?');
const vaultIds = () => [MAIN, ...S.extra.filter(v => v.file).map(v => v.id)];
function arrOf(vid) { return vid === MAIN ? S.items : ((S.extra.find(v => v.id === vid) || {}).items || []); }
function vaultOf(id) {
  if (S.items.some(i => i.id === id)) return MAIN;
  const v = S.extra.find(x => x.items.some(i => i.id === id));
  return v ? v.id : MAIN;
}
function inScope(pred) {
  const vf = S.view.vault;
  const ids = vf && vf !== 'all' ? [vf] : vaultIds();
  return ids.flatMap(id => arrOf(id).filter(pred));
}
const live = () => inScope(isActive);
const allLive = () => vaultIds().flatMap(id => arrOf(id).filter(isActive));
const trashedItems = () => inScope(i => i.trashed && !i.deleted && !isInternal(i));
const findItem = id => vaultIds().flatMap(v => arrOf(v)).find(i => i.id === id && !i.deleted);
const types = () => allTypes(S.items);
const typeOf = it => types()[it.type] || { label: 'Elemento', plural: 'Elementi', icon: '📄', fields: [] };
const templates = () => S.items.filter(i => !i.deleted && i.type === '_template');

function replaceItem(vid, item) {
  const arr = arrOf(vid);
  const ix = arr.findIndex(i => i.id === item.id);
  if (ix >= 0) arr[ix] = item; else arr.push(item);
}
async function saveVaultOf(vid) {
  if (vid === MAIN) return saveVault();
  const v = S.extra.find(x => x.id === vid);
  await saveExtraVault(store, v);
  scheduleSync();
}

// ---------------------------------------------------------------- vault principale
async function createVault(password) {
  const v = await vaultCreate(password);
  S.file = v.file; S.dek = v.dek; S.items = []; S.extra = [];
  await store.del('sync');
  await bioReset();
  await store.set('vault', S.file);
}

async function openWithDEK(dek) {
  S.items = await vaultRead(S.file, dek);
  S.dek = dek;
}

// Salva sul dispositivo, unendo eventuali modifiche fatte altrove (compilazione automatica, altra scheda).
async function persist() {
  await mergeFromDisk();
  await vaultWrite(S.file, S.dek, S.items);
  await store.set('vault', S.file);
  pushIdentities();
}
async function mergeFromDisk() {
  let disk = null;
  try { disk = await store.get('vault'); } catch { return false; }
  if (!disk || !S.file || disk.vaultId !== S.file.vaultId || disk.updatedAt === S.file.updatedAt) return false;
  try {
    const m = await vaultMerge(S.file, S.dek, S.items, disk);
    S.items = m.items;
    return m.changedLocal;
  } catch { return false; }
}
async function saveVault() { await persist(); scheduleSync(); }

async function loadSyncCfg() {
  const box = await store.get('sync');
  if (!box) return null;
  try { return await decryptJSON(S.dek, box); } catch { return null; }
}
async function saveSyncCfg(cfg) {
  S.sync = cfg;
  if (cfg) await store.set('sync', await encryptJSON(S.dek, cfg));
  else await store.del('sync');
}

// Allinea l'elenco dei vault aggiuntivi alle chiavi presenti nel vault principale.
async function loadExtras() {
  const keys = vaultKeyItems(S.items);
  const next = [];
  for (const k of keys) {
    const have = S.extra.find(v => v.keyId === k.id);
    if (have) { have.name = k.title; next.push(have); continue; }
    try { next.push(await openExtraVault(store, k)); } catch (e) { next.push({ id: k.f.vaultId, name: k.title, keyId: k.id, items: [], file: null, err: e.message }); }
  }
  S.extra = next;
  if (S.view.vault !== 'all' && !vaultIds().includes(S.view.vault)) S.view.vault = 'all';
}

function lock() {
  S.dek = null; S.items = []; S.extra = []; S.sync = null; S.syncErr = null; S.syncState = 'idle';
  S.view = { section: 'all', id: null, edit: false, q: '', newType: null, vault: 'all' };
  S.genVal = ''; S.kf = null; S.editAtt = []; S.tplEdit = null; S.pwned = null; S.pwnedChecked = false;
  if (Native.available) Native.call('lock').catch(() => {});
  render();
}

// Le app native ricevono la chiave del vault sbloccato, per la compilazione automatica (scade col blocco automatico).
async function shareSession() {
  if (!Native.available || !S.dek) return;
  try { await Native.call('session', { dek: await exportDEK(S.dek), ttlMin: +S.settings.autoLockMin || 0 }); } catch { /* ignora */ }
}

let idTimer = null;
function pushIdentities() {
  if (Native.platform !== 'ios') return;
  clearTimeout(idTimer);
  idTimer = setTimeout(() => {
    const list = allLive().flatMap(i => {
      if (i.type === 'login' && i.f.url && (i.f.username || i.f.password)) return [{ type: 'password', id: i.id, host: hostOf(i.f.url), user: i.f.username || i.title }];
      if (i.type === 'passkey' && i.f.rpId && i.f.credentialId) return [{ type: 'passkey', id: i.id, rpId: i.f.rpId, user: i.f.username || '', credentialId: i.f.credentialId, userHandle: i.f.userHandle || '' }];
      return [];
    });
    Native.call('identities', { list }).catch(() => {});
  }, 800);
}

// ---------------------------------------------------------------- biometria
async function bioSupportedWeb() {
  return !!(self.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
    await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
}
async function bioInit() {
  if (Native.available) {
    try {
      const r = await Native.call('bioStatus');
      S.bioAvail = !!(r && r.available);
      S.bio = r && r.enrolled ? { native: true } : null;
    } catch { S.bioAvail = false; S.bio = null; }
    return;
  }
  try { S.bioAvail = await bioSupportedWeb(); } catch { S.bioAvail = false; }
  try { S.bio = (await store.get('bio')) || null; } catch { S.bio = null; }
}
async function bioReset() {
  S.bio = null;
  if (Native.available) await Native.call('bioDisable').catch(() => {});
  else await store.del('bio');
}
async function prfToKey(out) {
  const k = await crypto.subtle.importKey('raw', out, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('scrigno-bio-v1') },
    k, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
async function bioGetPRF(credId, salt) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), allowCredentials: [{ type: 'public-key', id: credId }], userVerification: 'required',
    extensions: { prf: { eval: { first: salt } } },
  } });
  const r = a.getClientExtensionResults().prf;
  if (!r || !r.results || !r.results.first) throw new Error('Il dispositivo non ha restituito la chiave biometrica.');
  return r.results.first;
}
async function bioEnroll() {
  if (Native.available) {
    await Native.call('bioEnroll', { dek: await exportDEK(S.dek) });
    S.bio = { native: true };
    return;
  }
  const salt = rand(32);
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'Scrigno' },
    user: { id: rand(16), name: 'scrigno', displayName: 'Scrigno' },
    challenge: rand(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    extensions: { prf: { eval: { first: salt } } },
  } });
  const ext = cred.getClientExtensionResults().prf;
  if (!ext || ext.enabled === false) throw new Error('Questo dispositivo o browser non supporta lo sblocco biometrico per le web app.');
  let out = ext.results && ext.results.first;
  if (!out) out = await bioGetPRF(cred.rawId, salt);
  const kek = await prfToKey(out);
  S.bio = { credId: toB64(cred.rawId), salt: toB64(salt), wrapped: await wrapKey(S.dek, kek) };
  await store.set('bio', S.bio);
}
async function bioUnlock() {
  let dek;
  if (Native.available) {
    const r = await Native.call('bioUnlock');
    dek = await importDEK(fromB64(r.dek));
  } else {
    const b = S.bio;
    const kek = await prfToKey(await bioGetPRF(fromB64(b.credId), fromB64(b.salt)));
    try { dek = await unwrapKey(b.wrapped, kek); } catch { dek = null; }
  }
  try { if (!dek) throw new Error(); await openWithDEK(dek); } catch {
    throw new Error('Sblocco biometrico non più valido: usa la master password e riattivalo.');
  }
  await afterUnlock();
}

// ---------------------------------------------------------------- cloud: ambiente
function webOAuthWait(state) {
  return new Promise((res, rej) => {
    const bc = new BroadcastChannel('scrigno-oauth');
    const to = setTimeout(() => { bc.close(); rej(new Error('Tempo scaduto per l\'accesso.')); }, 300000);
    bc.onmessage = e => {
      if (!e.data || e.data.state !== state) return;
      clearTimeout(to);
      bc.close();
      res(e.data);
    };
  });
}
function paramsFromUrl(u) {
  const url = new URL(u);
  const p = Object.fromEntries(new URLSearchParams(url.search));
  Object.assign(p, Object.fromEntries(new URLSearchParams(url.hash.slice(1))));
  return p;
}
function checkOAuth(p, state) {
  if (!p || p.state !== state) throw new Error('Risposta di accesso non valida.');
  if (p.error) throw new Error('Accesso negato: ' + (p.error_description || p.error));
  return p;
}
// Se il browser non torna all'app, l'utente può incollare il codice mostrato dalla pagina di ritorno.
function pasteCodeDialog() {
  let d;
  const promise = new Promise((res, rej) => {
    d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form class="stack"><h3>Accesso in corso…</h3>
      <p class="hint">Completa l'accesso nel browser. Se alla fine il browser non torna a Scrigno, copia il codice che ti mostra e incollalo qui.</p>
      <input placeholder="Codice di ritorno" autocomplete="off" spellcheck="false">
      <div class="row-btns end"><button class="btn primary" value="ok">Conferma</button><button class="btn ghost" value="no" formnovalidate>Annulla</button></div></form>`;
    document.body.append(d);
    d.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.submitter && e.submitter.value === 'no') { d.close(); rej(new Error('Accesso annullato.')); return; }
      try { res(JSON.parse(dec.decode(b64u.from(d.querySelector('input').value.trim())))); d.close(); } catch { toast('Codice non valido'); }
    });
    d.addEventListener('cancel', () => rej(new Error('Accesso annullato.')));
    d.showModal();
  });
  return { promise, close: () => { if (d && d.open) d.close(); if (d) d.remove(); } };
}
function setupCloudEnv() {
  if (!Native.available) {
    Cloud.env = {
      fetch: (u, o) => fetch(u, o),
      redirect: () => new URL('oauth.html', location.href).href,
      folder: false,
      begin() {
        const w = window.open('about:blank', 'scrigno-oauth', 'width=520,height=720');
        if (!w) throw new Error('Il browser ha bloccato la finestra di accesso: consenti i popup.');
        return { w, close() { try { w.close(); } catch { /* ignora */ } } };
      },
      async authorize(h, url, state) {
        const wait = webOAuthWait(state);
        h.w.location = url;
        return checkOAuth(await wait, state);
      },
    };
    return;
  }
  Cloud.env = {
    fetch: httpFetch,
    redirect() {
      if (!CONFIG.pagesUrl) throw new Error('Indirizzo della pagina di ritorno non configurato in questa build.');
      return CONFIG.pagesUrl.replace(/\/?$/, '/') + 'oauth-app.html';
    },
    folder: Native.desktop || Native.platform === 'ios',
    begin: () => null,
    async authorize(h, url, state) {
      const dlg = pasteCodeDialog();
      try {
        const p = await Promise.race([Native.call('oauth', { url, scheme: 'scrigno' }).then(paramsFromUrl), dlg.promise]);
        return checkOAuth(p, state);
      } finally {
        dlg.close();
        Native.call('oauthCancel').catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------- sincronizzazione
let syncTimer = null, syncing = false;
const hasAnySync = () => !!S.sync || S.extra.some(v => v.cfg);
function scheduleSync(ms = 1500) {
  if (!hasAnySync()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), ms);
}
async function syncNow(silent = false) {
  if (!S.dek || !hasAnySync()) return;
  if (syncing) { scheduleSync(3000); return; }
  syncing = true;
  setSync('busy');
  let changed = false;
  const errors = [];
  try {
    if (S.sync) {
      try {
        await mergeFromDisk();
        const r = await cloudSync({ file: S.file, dek: S.dek, items: S.items, cfg: S.sync });
        S.items = r.items;
        if (r.changedLocal || r.uploaded) { await store.set('vault', S.file); pushIdentities(); }
        changed = changed || r.changedLocal;
        S.sync.lastSync = now();
        await saveSyncCfg(S.sync);
      } catch (e) { errors.push({ message: e.message, code: e.code }); }
    }
    await loadExtras();
    let keysChanged = false;
    for (const v of S.extra) {
      if (!v.cfg || !v.dek) continue;
      const key = S.items.find(i => i.id === v.keyId);
      const before = key ? stableCfg(vaultCloudCfg(key)) : '';
      try {
        const r = await syncExtraVault(store, v);
        changed = changed || r.changed;
        v.err = null;
      } catch (e) { v.err = e.message; errors.push({ message: `${v.name}: ${e.message}`, code: e.code }); }
      if (key && stableCfg(v.cfg) !== before) { key.f.cloud = JSON.stringify(v.cfg); key.updated = now(); keysChanged = true; }
    }
    if (keysChanged) { await persist(); if (S.sync) await cloudSync({ file: S.file, dek: S.dek, items: S.items, cfg: S.sync }).catch(() => {}); }
    S.syncErr = errors[0] || null;
    setSync(errors.length ? 'err' : 'ok');
    if (errors.length && !silent) toast(errors[0].message, 4500);
    if (changed && S.dek && !S.view.edit) renderMain();
  } finally {
    syncing = false;
  }
}
function syncLabel() {
  const [i, t] = !hasAnySync() ? ['cloud', 'Collega cloud']
    : ({ busy: ['refresh', 'Sincronizzo…'], ok: ['cloudOk', 'Sincronizzato'], err: ['cloudErr', 'Errore di sincronizzazione'], idle: ['cloud', 'Cloud collegato'] }[S.syncState] || ['cloud', 'Cloud']);
  return `${ic(i, S.syncState === 'busy' ? 'spin' : '')}<span class="nl">${t}</span>`;
}
function setSync(st) {
  S.syncState = st;
  const p = $('#syncPill');
  if (p) { p.innerHTML = syncLabel(); p.dataset.state = st; }
}

// ---------------------------------------------------------------- interfaccia
const PAGES = ['audit', 'gen', 'settings', 'template'];
const BASE_SECTIONS = ['login', 'card', 'identity', 'note', 'passkey'];
function issueCount() {
  const logins = allLive().filter(i => i.f && i.f.password);
  const counts = new Map();
  logins.forEach(i => counts.set(i.f.password, (counts.get(i.f.password) || 0) + 1));
  return logins.filter(i => strength(i.f.password).lvl <= 1 || counts.get(i.f.password) > 1 ||
    now() - (i.pwChanged || i.created) > 365 * 864e5 || (S.pwned && S.pwned.get(i.id))).length;
}
// Barra laterale: [chiave, etichetta, icona] oppure ['-h', titolo del gruppo].
function sections() {
  const all = types();
  const items = live();
  const used = new Set(items.map(i => i.type));
  const typeKeys = Object.keys(all).filter(k => BASE_SECTIONS.includes(k) || used.has(k) || all[k].custom);
  const tags = allTags(items);
  const n = trashedItems().length;
  return [
    ['all', 'Tutti gli elementi', ic('grid')], ['fav', 'Preferiti', ic('star')],
    ['-h', 'Categorie'],
    ...typeKeys.map(k => [k, all[k].plural, typeIc(k, all[k])]),
    ...(tags.length ? [['-h', 'Tag'], ...tags.map(([t]) => ['tag:' + t, t, ic('tag')])] : []),
    ['-h', 'Strumenti'],
    ['audit', 'Sicurezza', ic('shield')], ['gen', 'Generatore', ic('wand')],
    ...(n ? [['trash', 'Cestino', ic('trash')]] : []),
  ];
}
const LOGO = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6cc0ff"/><stop offset="1" stop-color="#1f78cc"/></linearGradient></defs><rect x="2" y="2" width="28" height="28" rx="8" fill="url(#lg)"/><path d="M11 14.5v-3a5 5 0 0 1 10 0v3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><rect x="8.5" y="14.5" width="15" height="10.5" rx="2.5" fill="#fff"/><circle cx="16" cy="19" r="1.8" fill="#1f78cc"/><rect x="15.2" y="19.6" width="1.6" height="3" rx=".8" fill="#1f78cc"/></svg>`;

function subtitle(i) {
  const f = i.f || {};
  switch (i.type) {
    case 'login': return f.username || hostOf(f.url);
    case 'card': return f.number ? '•••• ' + f.number.replace(/\s/g, '').slice(-4) : (f.holder || '');
    case 'identity': return [f.firstName, f.lastName].filter(Boolean).join(' ') || f.email || '';
    case 'note': return (f.notes || '').split('\n')[0].slice(0, 60);
    case 'passkey': return [f.username, f.rpId].filter(Boolean).join(' · ');
    case 'wifi': return f.ssid || '';
    case 'bank': return f.bankName || f.iban || '';
    case 'document': return [f.docType, f.expires && 'scade ' + f.expires].filter(Boolean).join(' · ');
    case 'license': return f.product || f.email || '';
    case 'server': return [f.username, f.host].filter(Boolean).join('@');
    case 'email': return f.email || '';
  }
  const first = typeOf(i).fields.find(([k, , kind]) => f[k] && !(kind || '').startsWith('secret'));
  return first ? f[first[0]] : '';
}
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
const TILE = ['#2F80C9', '#3A6EA5', '#2B9BB0', '#5468C4', '#3D8F7A', '#7A5BB8', '#C0703A', '#B5506A', '#4F7A93', '#6B8E3D'];
function letterIcon(it, big = false) {
  const ch = (it.title || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="ricon${big ? ' big' : ''}" style="--tile:${TILE[hue(it.title || '') % TILE.length]}">${esc(ch)}</span>`;
}
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

function render() {
  if (!S.file) return renderSetup();
  if (!S.dek) return renderLock();
  renderMain();
}

function meterHTML() { return '<span class="meter" data-lvl="0"></span>'; }
function updateMeter(inp) {
  const m = inp.closest('label') && inp.closest('label').querySelector('.meter');
  if (!m) return;
  const s = strength(inp.value);
  m.dataset.lvl = s.lvl;
  m.textContent = inp.value ? `${s.label} · ~${s.bits} bit` : '';
}

function renderSetup() {
  const tab = S.setupTab;
  const body = tab === 'new' ? `
    <form id="createForm" class="stack">
      <label class="lbl">Master password<input type="password" name="pw" autocomplete="new-password" required minlength="10">${meterHTML()}</label>
      <label class="lbl">Ripeti la master password<input type="password" name="pw2" autocomplete="new-password" required></label>
      <label class="chk"><input type="checkbox" name="ack" required> Ho capito che se dimentico la master password i dati non sono recuperabili.</label>
      <button class="btn primary wide" type="submit">Crea il vault</button>
    </form>`
    : tab === 'cloud' ? cloudForm('setup-cloud', 'Scarica il vault')
    : `<p class="hint">Scegli un file di backup Scrigno (.json) esportato da un altro dispositivo.</p>
       <button class="btn primary wide" data-act="pick" data-kind="setup">Scegli file…</button>`;
  $('#app').innerHTML = `<div class="center"><div class="card auth">
    <div class="brand big">${LOGO}<span>Scrigno</span></div>
    <p class="tagline">Password, passkey, carte e codici 2FA, cifrati sui tuoi dispositivi.</p>
    <div class="tabs">${[['new', 'Nuovo vault'], ['cloud', 'Dal cloud'], ['file', 'Da backup']].map(([k, l]) =>
      `<button class="tab ${tab === k ? 'on' : ''}" data-act="setup-tab" data-k="${k}">${l}</button>`).join('')}</div>
    ${body}</div></div>`;
}

function keyfileRow() {
  if (!S.file.kdf || !S.file.kdf.keyfile) return '';
  const rem = rememberedKf();
  if (rem && !S.kf) S.kf = rem;
  return `<div class="kfbox">
    <span class="kfline">${ic('keyfile')} Keyfile: <b id="kfState">${S.kf ? (rem ? 'memorizzato su questo dispositivo' : 'scelto') : 'non scelto'}</b></span>
    <div class="row-btns"><button type="button" class="btn" data-act="pick-kf" data-mode="unlock">Scegli keyfile…</button>
    ${rem ? '<button type="button" class="btn ghost" data-act="forget-kf">Dimentica</button>' : ''}</div>
    ${rem ? '' : '<label class="chk small"><input type="checkbox" id="kfRemember"> Ricorda il keyfile su questo dispositivo</label>'}
  </div>`;
}

function renderLock() {
  $('#app').innerHTML = `<div class="center"><div class="card auth">
    <div class="brand big">${LOGO}<span>Scrigno</span></div>
    <form id="unlockForm" class="stack">
      <label class="lbl">Master password<input type="password" id="mp" autocomplete="current-password" required></label>
      ${keyfileRow()}
      <p class="err" id="unlockErr" hidden></p>
      <button class="btn primary wide" type="submit">Sblocca</button>
    </form>
    ${S.bio ? `<button class="btn wide" data-act="bio-unlock">${ic('fingerprint')} Sblocca con la biometria</button>` : ''}
    ${S.pendingSync ? '<p class="hint">Vault scaricato dal cloud: inserisci la sua master password.</p>' : ''}
    ${S.autotype ? '<p class="hint">Sblocca per compilare nell\'app in primo piano.</p>' : ''}
    <button class="link" data-act="wipe">Rimuovi il vault da questo dispositivo</button>
  </div></div>`;
  const mp = $('#mp');
  if (mp) mp.focus();
}

function inSection(i, k) {
  if (k === 'all') return true;
  if (k === 'fav') return !!i.fav;
  if (k.startsWith('tag:')) return (i.tags || []).includes(k.slice(4));
  return i.type === k;
}
function countFor(k) {
  if (k === 'audit') { const n = issueCount(); return n ? `<span class="cnt warn">${n}</span>` : ''; }
  if (PAGES.includes(k)) return '';
  const list = k === 'trash' ? trashedItems() : live().filter(i => inSection(i, k));
  return list.length ? `<span class="cnt">${list.length}</span>` : '';
}

function vaultPicker() {
  if (!S.extra.length) return `<div class="vaultname" title="Vault">${ic('vault')}<span class="nl">${esc(vaultName(MAIN))}</span></div>`;
  const ids = vaultIds();
  return `<select id="vaultSel" class="vaultsel" title="Vault">
    <option value="all" ${S.view.vault === 'all' ? 'selected' : ''}>Tutti i vault</option>
    ${ids.map(id => `<option value="${id}" ${S.view.vault === id ? 'selected' : ''}>${esc(vaultName(id))}</option>`).join('')}
  </select>`;
}

function renderMain() {
  const v = S.view;
  const page = PAGES.includes(v.section);
  const pageHtml = v.section === 'audit' ? renderAudit() : v.section === 'gen' ? renderGen() : v.section === 'template' ? renderTemplateEditor() : renderSettings();
  $('#app').innerHTML = `<div class="shell ${page ? 'pagemode' : ''} ${v.id || v.edit ? 'show-detail' : ''}">
    <aside class="nav">
      <div class="brand">${LOGO}<span>Scrigno</span></div>
      ${vaultPicker()}
      <nav>${sections().map(([k, l, i]) => k === '-h' ? `<div class="nav-h">${esc(l)}</div>`
        : `<button class="nav-btn ${v.section === k ? 'on' : ''}" data-act="section" data-k="${esc(k)}" title="${esc(l)}"><span class="ni">${i}</span><span class="nl">${esc(l)}</span>${countFor(k)}</button>`).join('')}</nav>
      <div class="nav-foot">
        <button class="nav-btn ${v.section === 'settings' ? 'on' : ''}" data-act="section" data-k="settings" title="Impostazioni"><span class="ni">${ic('settings')}</span><span class="nl">Impostazioni</span></button>
        <div class="nav-row">
          <button class="sync-pill" id="syncPill" data-act="sync" data-state="${S.syncState}" title="Sincronizzazione">${syncLabel()}</button>
          <button class="btn ghost lockbtn" data-act="lock" title="Blocca (Ctrl+L)">${ic('lock')}</button>
        </div>
      </div>
    </aside>
    ${page ? `<section class="page">${pageHtml}</section>`
      : `<section class="list">
          <div class="list-head"><input id="q" type="search" placeholder="Cerca" value="${esc(v.q)}" autocomplete="off" title="Cerca (Ctrl+F)">${v.section === 'trash' ? '' : `<button class="btn primary addbtn" data-act="new" title="Nuovo elemento (Ctrl+N)">${ic('plus')}<span class="nl">Nuovo</span></button>`}</div>
          <div class="list-sub"><b>${esc(sectionTitle())}</b><span>${visibleItems().length}</span>
            <select id="sortSel" title="Ordina">${[['az', 'Nome A–Z'], ['za', 'Nome Z–A'], ['recent', 'Modificati di recente'], ['created', 'Creati di recente']].map(([k, l]) => `<option value="${k}" ${S.settings.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div id="items">${renderList()}</div>
        </section>
        <section class="detail">${renderDetail()}</section>`}
  </div>`;
  $$('input[name=f_password]').forEach(updateMeter);
  if ($('#genOut')) updateGenOut();
  tickTotp();
  if (S.autotype) showAutotype();
}

function visibleItems() {
  const { section, q } = S.view;
  const ql = q.trim().toLowerCase();
  const base = section === 'trash' ? trashedItems() : live().filter(i => inSection(i, section));
  const sort = S.settings.sort || 'az';
  const cmp = {
    az: (a, b) => a.title.localeCompare(b.title, 'it'),
    za: (a, b) => b.title.localeCompare(a.title, 'it'),
    recent: (a, b) => (b.updated || 0) - (a.updated || 0),
    created: (a, b) => (b.created || 0) - (a.created || 0),
  }[sort] || ((a, b) => a.title.localeCompare(b.title, 'it'));
  return base
    .filter(i => !ql || [i.title, ...(i.tags || []), ...Object.values(i.f || {})].some(x => x && typeof x === 'string' && x.toLowerCase().includes(ql)))
    .sort((a, b) => (section === 'trash' ? b.trashed - a.trashed : 0) || cmp(a, b));
}
function sectionTitle() {
  const k = S.view.section;
  if (k === 'all') return 'Tutti gli elementi';
  if (k === 'fav') return 'Preferiti';
  if (k === 'trash') return 'Cestino';
  if (k.startsWith('tag:')) return k.slice(4);
  return (types()[k] || {}).plural || '';
}
function renderList() {
  const items = visibleItems();
  if (!items.length) {
    if (S.view.section === 'trash') return '<p class="empty">Il cestino è vuoto.</p>';
    return `<p class="empty">${allLive().length ? 'Nessun risultato.' : 'Il vault è vuoto.<br>Premi Nuovo per aggiungere il primo elemento, oppure importa da Enpass in Impostazioni.'}</p>`;
  }
  const many = S.extra.length && S.view.vault === 'all';
  return items.map(i => `<button class="row ${S.view.id === i.id ? 'on' : ''}" data-act="open" data-id="${i.id}">
      ${letterIcon(i)}<span class="rtext"><b>${esc(i.title)}</b><small>${esc(subtitle(i))}${many && vaultOf(i.id) !== MAIN ? ' · ' + esc(vaultName(vaultOf(i.id))) : ''}</small></span>
      ${(i.attachments || []).length ? `<span class="clip" title="Allegati">${ic('clip')}</span>` : ''}${i.fav ? `<span class="star" title="Preferito">${ic('starFill')}</span>` : ''}
    </button>`).join('');
}

function fieldRow(it, k, label, kind, val = getVal(it, k)) {
  if (kind === 'totp') {
    return `<div class="field"><label>${esc(label)}</label><div class="fv">
      <span class="totp" data-totp="${it.id}">··· ···</span><span class="ring" data-ring></span>
      <button class="icon" data-act="copy-totp" data-id="${it.id}" title="Copia codice">${ic('copy')}</button></div></div>`;
  }
  const secret = !!kind && kind.startsWith('secret');
  const multi = kind === 'multi' || kind === 'secret-multi';
  let shown = secret ? '••••••••' : esc(val);
  if (kind === 'url') shown = `<a href="${esc(safeUrl(val))}" target="_blank" rel="noopener noreferrer" data-act="open-url">${esc(val)}</a>`;
  let badge = '';
  if (k === 'password') {
    const s = strength(val);
    badge = ` <span class="badge l${s.lvl}">${s.label}</span>`;
    const pw = S.pwned && S.pwned.get(it.id);
    if (pw) badge += ` <span class="badge l1">Violata ${pw.toLocaleString('it-IT')} volte</span>`;
  }
  return `<div class="field"><label>${esc(label)}${badge}</label><div class="fv">
    <span class="val ${multi ? 'multi' : ''} ${secret ? 'mono' : ''}">${shown}</span>
    ${secret ? `<button class="icon" data-act="reveal" data-k="${k}" title="Mostra">${ic('eye')}</button>` : ''}
    <button class="icon" data-act="copy" data-k="${k}" title="Copia">${ic('copy')}</button></div></div>`;
}

function historyBlock(it) {
  if (!(it.history || []).length) return '';
  return `<details class="fields hist"><summary>Password precedenti (${it.history.length})</summary>
    ${it.history.map((h, ix) => `<div class="field"><label>Usata fino al ${fmtDate(h.until)}</label><div class="fv">
      <span class="val mono">••••••••</span>
      <button class="icon" data-act="reveal-h" data-ix="${ix}" title="Mostra">${ic('eye')}</button>
      <button class="icon" data-act="copy-h" data-ix="${ix}" title="Copia">${ic('copy')}</button></div></div>`).join('')}
  </details>`;
}

function attachmentsBlock(list, editable) {
  if (!list.length && !editable) return '';
  return `<div class="fields atts"><div class="field"><label>Allegati</label>
    ${list.map((a, ix) => `<div class="att">
      ${/^image\//.test(a.type) ? `<img src="data:${esc(a.type)};base64,${a.data}" alt="">` : `<span class="atticon">${ic('file')}</span>`}
      <span class="rtext"><b>${esc(a.name)}</b><small>${fmtSize(a.size || 0)}</small></span>
      ${editable ? `<button type="button" class="icon" data-act="att-del" data-ix="${ix}" title="Rimuovi">${ic('x')}</button>`
        : `<button class="icon" data-act="att-open" data-ix="${ix}" title="Apri">${ic('open')}</button><button class="icon" data-act="att-save" data-ix="${ix}" title="Scarica">${ic('download')}</button>`}
    </div>`).join('') || '<p class="hint">Nessun allegato.</p>'}
    ${editable ? `<button type="button" class="btn ghost left" data-act="att-add">${ic('clip')} Aggiungi allegato</button>` : ''}
  </div></div>`;
}

function renderDetail() {
  const v = S.view;
  if (v.edit) return renderEdit();
  const it = findItem(v.id);
  if (!it || (!isActive(it) && !it.trashed)) return `<div class="placeholder">${LOGO}<p>Seleziona un elemento</p></div>`;
  const T = typeOf(it);
  const rows = T.fields.filter(([k]) => it.f[k]).map(([k, l, kind]) => fieldRow(it, k, l, kind)).join('');
  const known = new Set(T.fields.map(([k]) => k));
  const orphan = Object.keys(it.f || {}).filter(k => !known.has(k) && it.f[k]).map(k => fieldRow(it, k, k, 'text')).join('');
  const custom = (it.custom || []).map((c, ix) => c.value ? fieldRow(it, 'c' + ix, c.label || 'Campo', c.secret ? 'secret' : 'text') : '').join('');
  const vid = vaultOf(it.id);
  if (it.trashed) {
    return `<div class="dhead"><button class="btn ghost back" data-act="back" title="Indietro">${ic('back')}</button>
        <div class="dtitle">${letterIcon(it, true)}<div><h2>${esc(it.title)}</h2><small>Nel cestino dal ${fmtDate(it.trashed)}</small></div></div></div>
      <p class="hint">Gli elementi nel cestino vengono eliminati definitivamente dopo ${TRASH_DAYS} giorni.</p>
      <div class="row-btns"><button class="btn primary" data-act="restore">Ripristina</button><button class="btn danger" data-act="purge">Elimina definitivamente</button></div>
      <div class="fields">${rows + orphan + custom || '<p class="hint">Nessun campo.</p>'}</div>`;
  }
  return `<div class="dhead">
      <button class="btn ghost back" data-act="back" title="Indietro">${ic('back')}</button>
      <div class="dtitle">${letterIcon(it, true)}<div><h2>${esc(it.title)}</h2><small class="dmeta">${typeIc(it.type, T)}${esc(T.label)}${S.extra.length ? `<span class="sep"></span>${ic('vault')}${esc(vaultName(vid))}` : ''}</small></div></div>
      <div class="dactions"><button class="btn ghost favbtn ${it.fav ? 'on' : ''}" data-act="fav" title="${it.fav ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'} (Ctrl+D)">${ic(it.fav ? 'starFill' : 'star')}</button><button class="btn" data-act="edit" title="Modifica (Ctrl+E)">Modifica</button></div>
    </div>
    ${(it.tags || []).length ? `<div class="tags">${it.tags.map(t => `<button class="tag" data-act="section" data-k="tag:${esc(t)}">${ic('tag')}${esc(t)}</button>`).join('')}</div>` : ''}
    <div class="fields">${rows + orphan + custom || '<p class="hint">Nessun campo compilato.</p>'}</div>
    ${attachmentsBlock(it.attachments || [], false)}
    ${historyBlock(it)}
    ${it.type === 'passkey' ? '<p class="hint">Questa passkey si usa dall\'estensione Scrigno nel browser e dalla compilazione automatica di Android.</p>' : ''}
    <p class="meta">Creato ${fmtDate(it.created)} · Modificato ${fmtDate(it.updated)}${it.pwChanged ? ` · Password cambiata ${fmtDate(it.pwChanged)}` : ''}</p>
    <button class="btn danger" data-act="delete">Sposta nel cestino</button>`;
}

function editField(k, label, kind, val = '') {
  if (kind === 'multi' || kind === 'secret-multi') {
    return `<label class="lbl">${esc(label)}<textarea name="f_${k}" rows="4" spellcheck="false" ${kind === 'secret-multi' ? 'class="mono"' : ''}>${esc(val)}</textarea></label>`;
  }
  const isPw = k === 'password';
  return `<label class="lbl">${esc(label)}<span class="inrow">
      <input name="f_${k}" type="${kind === 'secret' ? 'password' : 'text'}" value="${esc(val)}" autocomplete="${isPw ? 'new-password' : 'off'}" spellcheck="false" ${kind === 'url' ? 'inputmode="url"' : ''}${kind === 'totp' ? ' placeholder="JBSW Y3DP… oppure otpauth://…"' : ''}>
      ${kind === 'secret' ? `<button type="button" class="icon" data-act="toggle-input" title="Mostra">${ic('eye')}</button>` : ''}
      ${isPw ? `<button type="button" class="icon" data-act="gen-into" title="Genera password">${ic('wand')}</button>` : ''}
    </span>${isPw ? meterHTML() : ''}</label>`;
}
function customRow(c = { label: '', value: '', secret: false }) {
  return `<div class="crow">
    <input data-c="label" placeholder="Etichetta" value="${esc(c.label)}" autocomplete="off">
    <input data-c="value" placeholder="Valore" type="${c.secret ? 'password' : 'text'}" value="${esc(c.value)}" autocomplete="off">
    <label class="chk small"><input type="checkbox" data-c="secret" ${c.secret ? 'checked' : ''}> Segreto</label>
    <button type="button" class="icon" data-act="del-custom" title="Rimuovi">${ic('x')}</button></div>`;
}
function renderEdit() {
  const v = S.view;
  const it = v.id ? findItem(v.id) : null;
  const type = it ? it.type : v.newType;
  const all = types();
  if (!type) {
    return `<div class="dhead"><button class="btn ghost" data-act="cancel">${ic('back')} Annulla</button><h2>Nuovo elemento</h2><span></span></div>
      <div class="typegrid">${Object.entries(all).filter(([k]) => k !== 'passkey').map(([k, t]) => `<button class="typecard" data-act="newtype" data-k="${esc(k)}"><span class="tci">${typeIc(k, t)}</span>${esc(t.label)}</button>`).join('')}
        <button class="typecard dashed" data-act="tpl-new"><span class="tci">${ic('plus')}</span>Nuovo modello</button></div>
      <p class="hint">Le passkey si creano da sole quando un sito o un'app te ne propone una e scegli Scrigno.</p>`;
  }
  const T = all[type] || typeOf({ type });
  const f = it ? it.f : {};
  const curVault = it ? vaultOf(it.id) : (S.view.vault !== 'all' ? S.view.vault : MAIN);
  return `<form id="editForm" class="edit stack" data-type="${esc(type)}" autocomplete="off">
    <div class="dhead"><button type="button" class="btn ghost" data-act="cancel">${ic('back')} Annulla</button><h2 class="eh">${typeIc(type, T)}${it ? 'Modifica' : 'Nuovo'} · ${esc(T.label)}</h2><button class="btn primary" type="submit" title="Salva (Ctrl+S)">Salva</button></div>
    <label class="lbl">Titolo<input name="title" required value="${esc(it ? it.title : '')}" autocomplete="off"></label>
    ${S.extra.length ? `<label class="lbl">Vault<select name="vault">${vaultIds().map(id => `<option value="${id}" ${id === curVault ? 'selected' : ''}>${esc(vaultName(id))}</option>`).join('')}</select></label>` : ''}
    ${T.fields.map(([k, l, kind]) => editField(k, l, kind, f[k])).join('')}
    <div class="custom" id="customList">${(it ? it.custom || [] : []).map(customRow).join('')}</div>
    <button type="button" class="btn ghost left" data-act="add-custom">${ic('plus')} Campo personalizzato</button>
    <div id="attList">${attachmentsBlock(S.editAtt, true)}</div>
    <label class="lbl">Tag (separati da virgola)<input name="tags" list="tagList" value="${esc((it ? it.tags || [] : S.view.section.startsWith('tag:') ? [S.view.section.slice(4)] : []).join(', '))}" autocomplete="off" placeholder="Es. lavoro, banca">
      <datalist id="tagList">${allTags(allLive()).map(([t]) => `<option value="${esc(t)}">`).join('')}</datalist></label>
    <label class="chk"><input type="checkbox" name="fav" ${it && it.fav ? 'checked' : ''}> Preferito</label>
  </form>`;
}

async function saveEdit(form) {
  const type = form.dataset.type;
  const T = types()[type];
  const fd = new FormData(form);
  const old = S.view.id ? findItem(S.view.id) : null;
  const oldVault = old ? vaultOf(old.id) : null;
  const target = fd.get('vault') || oldVault || (S.view.vault !== 'all' ? S.view.vault : MAIN);
  const f = {};
  for (const [k, , kind] of T.fields) {
    let val = fd.get('f_' + k) || '';
    if (!kind || !kind.startsWith('secret')) val = val.trim();
    if (val) f[k] = val;
  }
  if (f.totp) parseTotp(f.totp);
  const custom = $$('.crow', form).map(r => ({
    label: r.querySelector('[data-c=label]').value.trim(),
    value: r.querySelector('[data-c=value]').value,
    secret: r.querySelector('[data-c=secret]').checked,
  })).filter(c => c.label || c.value);
  const t = now();
  const item = withHistory(old, {
    id: old ? old.id : uuid(), type, title: (fd.get('title') || '').trim() || 'Senza titolo', f, custom,
    fav: !!fd.get('fav'), created: old ? old.created : t, updated: t,
    pwChanged: f.password && f.password !== (old && old.f.password) ? t : old && old.pwChanged,
  });
  if (S.editAtt.length) item.attachments = S.editAtt;
  const tags = normTags(fd.get('tags'));
  if (tags.length) item.tags = tags;
  if (old && oldVault !== target) {
    // spostato in un altro vault: nuovo id nel vault di destinazione, eliminazione nel vecchio
    replaceItem(oldVault, tombstone(old));
    item.id = uuid();
    await saveVaultOf(oldVault);
  }
  replaceItem(target, item);
  S.view = { ...S.view, id: item.id, edit: false, newType: null };
  S.editAtt = [];
  await saveVaultOf(target);
  renderMain();
  toast('Salvato');
  if (f.password && (!old || old.f.password !== f.password)) checkOnePassword(item);
}

// Controlla in background una password appena salvata.
async function checkOnePassword(item) {
  try {
    const n = await pwnedCount(item.f.password, Cloud.env.fetch);
    if (!S.pwned) S.pwned = new Map();
    if (n) { S.pwned.set(item.id, n); toast(`⚠ Questa password compare in ${n.toLocaleString('it-IT')} violazioni di dati: meglio cambiarla.`, 6000); }
    else S.pwned.delete(item.id);
  } catch { /* controllo non disponibile */ }
}

// ---------------------------------------------------------------- modelli personalizzati
function renderTemplateEditor() {
  const t = S.tplEdit || { title: '', icon: '📁', fields: [['f1', '', 'text']] };
  return `<div class="pagewrap"><h1>${t.id ? 'Modifica modello' : 'Nuovo modello'}</h1>
    <form id="tplForm" class="card stack">
      <div class="inrow"><label class="lbl" style="width:90px">Icona<input name="icon" value="${esc(t.icon)}" maxlength="4"></label>
        <label class="lbl" style="flex:1">Nome del modello<input name="title" required value="${esc(t.title)}" placeholder="Es. Tessera palestra"></label></div>
      <p class="hint">Campi del modello:</p>
      <div id="tplFields">${t.fields.map(tplRow).join('')}</div>
      <button type="button" class="btn ghost left" data-act="tpl-add-field">${ic('plus')} Campo</button>
      <div class="row-btns"><button class="btn primary" type="submit">Salva modello</button>
        <button type="button" class="btn ghost" data-act="section" data-k="settings">Annulla</button>
        ${t.id ? '<button type="button" class="btn danger" data-act="tpl-del">Elimina modello</button>' : ''}</div>
    </form></div>`;
}
function tplRow([k, label, kind] = ['f' + b64u.to(rand(4)), '', 'text']) {
  return `<div class="crow tplrow" data-key="${esc(k)}">
    <input data-t="label" placeholder="Nome del campo" value="${esc(label)}">
    <select data-t="kind">${Object.entries(FIELD_KINDS).map(([v, l]) => `<option value="${v}" ${v === (kind || 'text') ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button type="button" class="icon" data-act="tpl-del-field" title="Rimuovi">${ic('x')}</button></div>`;
}
async function saveTemplate(form) {
  const fields = $$('.tplrow', form).map(r => [r.dataset.key, r.querySelector('[data-t=label]').value.trim(), r.querySelector('[data-t=kind]').value]).filter(x => x[1]);
  if (!fields.length) throw new Error('Aggiungi almeno un campo');
  const fd = new FormData(form);
  const t = S.tplEdit || {};
  const old = t.id ? S.items.find(i => i.id === t.id) : null;
  const f = { icon: (fd.get('icon') || '📁').trim() || '📁', fields: JSON.stringify(fields) };
  if (old) { old.title = fd.get('title').trim(); old.f = f; old.updated = now(); } else S.items.push(makeItem('_template', fd.get('title').trim(), f));
  S.tplEdit = null;
  await saveVault();
  S.view = { ...S.view, section: 'settings', id: null, edit: false };
  renderMain();
  toast('Modello salvato');
}

// ---------------------------------------------------------------- sicurezza
function renderAudit() {
  const logins = live().filter(i => i.f.password);
  const weak = logins.filter(i => strength(i.f.password).lvl <= 1);
  const counts = new Map();
  logins.forEach(i => counts.set(i.f.password, (counts.get(i.f.password) || 0) + 1));
  const reused = logins.filter(i => counts.get(i.f.password) > 1);
  const old = logins.filter(i => now() - (i.pwChanged || i.created) > 365 * 864e5);
  const breached = S.pwned ? logins.filter(i => S.pwned.get(i.id)) : [];
  const bad = new Set([...weak, ...reused, ...old, ...breached].map(i => i.id));
  const score = logins.length ? Math.round(100 * (1 - bad.size / logins.length)) : 100;
  const rowOf = (i, extra = '') => `<button class="row" data-act="open-in" data-id="${i.id}">${letterIcon(i)}<span class="rtext"><b>${esc(i.title)}</b><small>${esc(subtitle(i))}${extra}</small></span></button>`;
  const block = (title, list, desc, tone, extra = () => '') => `<div class="card"><h3>${title} <span class="badge ${list.length ? tone : 'l4'}">${list.length}</span></h3>
    <p class="hint">${desc}</p>${list.map(i => rowOf(i, extra(i))).join('')}</div>`;

  // monitoraggio 2FA e passkey
  const siteLogins = live().filter(i => i.type === 'login' && i.f.url);
  const passkeyRps = new Set(allLive().filter(i => i.type === 'passkey').map(i => baseDomain(i.f.rpId || '')));
  let dirBlocks;
  if (S.dirs) {
    const tfaMissing = siteLogins.filter(i => !i.f.totp && S.dirs.tfa[baseDomain(hostOf(i.f.url))]);
    const pkMissing = siteLogins.filter(i => { const d = baseDomain(hostOf(i.f.url)); return d in S.dirs.pk && !passkeyRps.has(d); });
    const doc = (map, i) => { const v = map[baseDomain(hostOf(i.f.url))]; const u = Array.isArray(v) ? v[1] : v; return u ? ' · <a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer" data-act="open-url">come attivarla</a>' : ''; };
    dirBlocks = `${block('Verifica in due passaggi disponibile', tfaMissing, 'Questi siti offrono i codici 2FA ma in Scrigno non hai salvato il segreto. Attivala sul sito e incolla il codice nel login.', 'l2', i => doc(S.dirs.tfa, i))}
      ${block('Passkey disponibili', pkMissing, 'Questi siti supportano le passkey e non ne hai ancora una in Scrigno: sono più sicure delle password e non si possono rubare con il phishing.', 'l2', i => doc(S.dirs.pk, i))}
      <p class="hint">Elenchi di <a href="https://2fa.directory" target="_blank" rel="noopener noreferrer" data-act="open-url">2fa.directory</a>, aggiornati il ${fmtDate(S.dirs.ts)}.</p>`;
  } else {
    dirBlocks = `<div class="card stack"><h3>Verifica in due passaggi e passkey</h3>
      <p class="hint">Scrigno può confrontare i tuoi login con gli elenchi pubblici di 2fa.directory e dirti dove attivare i codici 2FA o le passkey. Si scarica solo l'elenco dei siti: nessun dato del vault esce dal dispositivo.</p>
      ${S.dirsErr ? `<p class="err">${esc(S.dirsErr)}</p>` : ''}
      <button class="btn left" data-act="load-dirs" ${S.dirsBusy ? 'disabled' : ''}>${S.dirsBusy ? 'Scarico gli elenchi…' : 'Controlla i siti'}</button></div>`;
  }
  const pwnedCard = S.pwnedChecked
    ? block('Password trovate in violazioni', breached, 'Queste password compaiono in furti di dati noti (Have I Been Pwned): cambiale subito.', 'l1', i => ' · ' + S.pwned.get(i.id).toLocaleString('it-IT') + ' volte')
    : `<div class="card stack"><h3>Violazioni di dati</h3>
      <p class="hint">Controlla se le tue password compaiono in furti di dati noti, con il servizio Have I Been Pwned. Le password non lasciano il dispositivo: viene inviato solo l'inizio della loro impronta cifrata, in forma anonima.</p>
      <button class="btn primary left" data-act="check-pwned" ${S.pwnedBusy ? 'disabled' : ''}>${S.pwnedBusy ? 'Controllo in corso…' : 'Controlla le password'}</button></div>`;
  return `<div class="pagewrap"><h1>Controllo sicurezza</h1>
    <div class="card score"><div class="big-num" data-lvl="${score >= 90 ? 4 : score >= 70 ? 3 : score >= 50 ? 2 : 1}">${score}</div>
      <div><b>Punteggio ${S.view.vault !== 'all' && S.extra.length ? 'del vault ' + esc(vaultName(S.view.vault)) : 'dei tuoi vault'}</b><p class="hint">${logins.length} password analizzate, ${bad.size} da sistemare.</p></div></div>
    ${pwnedCard}
    ${block('Password deboli', weak, 'Troppo corte o prevedibili: sostituiscile con una generata.', 'l1')}
    ${block('Password riutilizzate', reused, 'Se un sito viene violato, gli altri account con la stessa password sono a rischio.', 'l1')}
    ${block('Password vecchie', old, 'Non cambiate da più di un anno.', 'l2')}
    ${dirBlocks}
  </div>`;
}

async function checkAllPasswords() {
  S.pwnedBusy = true;
  if (S.view.section === 'audit') renderMain();
  const res = new Map();
  try {
    const list = allLive().filter(i => i.f && i.f.password);
    const byPw = new Map();
    for (const i of list) { if (!byPw.has(i.f.password)) byPw.set(i.f.password, []); byPw.get(i.f.password).push(i.id); }
    for (const [pw, ids] of byPw) {
      const n = await pwnedCount(pw, Cloud.env.fetch);
      if (n) ids.forEach(id => res.set(id, n));
    }
    S.pwned = res;
    S.pwnedChecked = true;
    toast(res.size ? `${res.size} password trovate in violazioni` : 'Nessuna password trovata in violazioni note');
  } finally {
    S.pwnedBusy = false;
    if (S.view.section === 'audit') renderMain();
  }
}
async function loadDirs() {
  S.dirsBusy = true; S.dirsErr = null;
  if (S.view.section === 'audit') renderMain();
  try { S.dirs = await loadDirectories(Cloud.env.fetch, store); } catch (e) { S.dirsErr = e.message; } finally {
    S.dirsBusy = false;
    if (S.view.section === 'audit') renderMain();
  }
}

function renderGen() {
  if (!S.genVal) S.genVal = genPassword(S.gen);
  const g = S.gen;
  return `<div class="pagewrap"><h1>Generatore di password</h1>
    <div class="card genout"><code id="genOut"></code><span class="meter" id="genMeter"></span>
      <div class="row-btns"><button class="btn primary" data-act="gen-copy">Copia</button><button class="btn" data-act="gen-new">Rigenera</button></div></div>
    <div class="card stack">
      <label class="lbl">Lunghezza: <b id="genLen">${g.length}</b><input type="range" min="8" max="64" value="${g.length}" data-gen="length"></label>
      ${[['lower', 'Minuscole (a-z)'], ['upper', 'Maiuscole (A-Z)'], ['digits', 'Numeri (0-9)'], ['symbols', 'Simboli (!@#…)'], ['noAmbig', 'Escludi caratteri ambigui (I l 1 O 0)']]
        .map(([k, l]) => `<label class="chk"><input type="checkbox" data-gen="${k}" ${g[k] ? 'checked' : ''}> ${l}</label>`).join('')}
    </div></div>`;
}
function updateGenOut() {
  const out = $('#genOut');
  if (!out) return;
  out.textContent = S.genVal;
  const s = strength(S.genVal);
  const m = $('#genMeter');
  m.dataset.lvl = s.lvl;
  m.textContent = `${s.label} · ~${s.bits} bit`;
  $('#genLen').textContent = S.gen.length;
}

function redirectHint() {
  try { return `<code>${esc(Cloud.env.redirect())}</code>`; } catch (e) { return `<span class="err">${esc(e.message)}</span>`; }
}
function provFields(p) {
  const ids = loadIds();
  if (p === 'dropbox') {
    return `<label class="lbl">App key Dropbox<input data-c="appKey" value="${esc(ids.appKey || '')}" autocomplete="off"></label>
      <p class="hint">App creata su dropbox.com/developers (accesso “App folder”) con questo Redirect URI: ${redirectHint()}</p>`;
  }
  if (p === 'onedrive') {
    return `<label class="lbl">ID applicazione Microsoft (client)<input data-c="clientId" value="${esc(ids.msClientId || '')}" autocomplete="off"></label>
      <p class="hint">App registrata nel portale Microsoft Entra, con questo URI di reindirizzamento: ${redirectHint()}</p>`;
  }
  if (p === 'gdrive') {
    return `<label class="lbl">Client ID OAuth Google<input data-c="clientId" value="${esc(ids.clientId || '')}" autocomplete="off"></label>
      <p class="hint">Client ID “Applicazione web” con l'API Google Drive abilitata e questo URI di reindirizzamento: ${redirectHint()}. Con Google l'accesso va rinnovato ogni ora: per le app meglio Dropbox o OneDrive.</p>`;
  }
  if (p === 'folder') {
    return `<p class="hint">${Native.platform === 'ios'
      ? 'Scegli una cartella in iCloud Drive: il file del vault verrà sincronizzato da iCloud tra i tuoi dispositivi Apple.'
      : 'Scegli una cartella sincronizzata dal sistema: iCloud Drive sul Mac, oppure la cartella di OneDrive o Dropbox sul computer.'}</p>`;
  }
  return `<label class="lbl">Indirizzo completo del file<input data-c="url" placeholder="https://cloud.esempio.it/remote.php/dav/files/UTENTE/${FILE_NAME}" autocomplete="off" inputmode="url"></label>
    <label class="lbl">Utente<input data-c="user" autocomplete="off"></label>
    <label class="lbl">Password per app<input data-c="pass" type="password" autocomplete="off"></label>`;
}
function cloudForm(act, label) {
  const list = providerList();
  return `<div class="cloudform stack">
    <label class="lbl">Servizio<select data-role="prov">${list.map(k => `<option value="${k}">${PROVIDERS[k].name}</option>`).join('')}</select></label>
    <div data-role="pf" class="stack">${provFields(list[0])}</div>
    <button class="btn primary wide" data-act="${act}">${label}</button></div>`;
}
function readCloudForm(root) {
  const cfg = { provider: root.querySelector('[data-role=prov]').value };
  root.querySelectorAll('[data-c]').forEach(i => { cfg[i.dataset.c] = i.value.trim(); });
  if (cfg.provider === 'dropbox') saveIds({ appKey: cfg.appKey });
  if (cfg.provider === 'onedrive') saveIds({ msClientId: cfg.clientId });
  if (cfg.provider === 'gdrive') saveIds({ clientId: cfg.clientId });
  return cfg;
}

function autofillCard() {
  if (Native.platform === 'android') {
    return `<div class="card stack"><h3>Compilazione automatica e passkey</h3>
      <p class="hint">Attiva Scrigno come servizio di compilazione automatica: compilerà login in app e browser e ti proporrà di salvare quelli nuovi.</p>
      <button class="btn primary left" data-act="native" data-m="openAutofillSettings">Imposta compilazione automatica</button>
      <p class="hint">Per le passkey (Android 14 o successivo) abilita Scrigno in Impostazioni › Password, passkey e account.</p>
      <button class="btn left" data-act="native" data-m="openCredentialSettings">Apri impostazioni passkey</button></div>`;
  }
  if (Native.platform === 'ios') {
    return `<div class="card stack"><h3>Compilazione automatica e passkey</h3>
      <p class="hint">Apri Impostazioni › Generali › Compilazione automatica e password e attiva Scrigno.</p>
      <button class="btn left" data-act="native" data-m="openAutofillSettings">Apri Impostazioni</button></div>`;
  }
  if (Native.desktop) {
    const keys = Native.platform === 'darwin' ? '⌘ ⌥ A' : 'Ctrl Alt A';
    return `<div class="card stack"><h3>Compilazione automatica</h3>
      <p class="hint"><b>Nei siti:</b> installa l'estensione Scrigno per Chrome, Edge o Firefox. Compila i login, salva quelli nuovi e gestisce le passkey.</p>
      <p class="hint"><b>Nelle app:</b> metti il cursore nel campo utente e premi <b>${keys}</b>. Scrigno ti fa scegliere il login e lo digita al posto tuo.
      ${Native.platform === 'darwin' ? 'La prima volta macOS chiede il permesso di Accessibilità per Scrigno.' : ''}
      ${Native.platform === 'linux' ? 'Su Linux serve <code>xdotool</code> (sessioni X11).' : ''}</p></div>`;
  }
  return `<div class="card stack"><h3>Compilazione automatica</h3>
    <p class="hint">Nel browser usa l'estensione Scrigno; sul telefono e sul computer installa l'app Scrigno.</p></div>`;
}

function vaultsCard() {
  const rows = [`<div class="vrow"><span class="rtext"><b>${esc(vaultName(MAIN))}</b><small>Vault principale · ${S.items.filter(isActive).length} elementi${S.sync ? ' · ' + PROVIDERS[S.sync.provider].name : ''}</small></span>
      <button class="icon" data-act="vault-rename" data-id="${MAIN}" title="Rinomina">${ic('edit')}</button></div>`,
    ...S.extra.map(v => `<div class="vrow"><span class="rtext"><b>${esc(v.name)}</b><small>${v.file ? v.items.filter(isActive).length + ' elementi' : 'non ancora scaricato su questo dispositivo'}${v.cfg ? ' · ' + PROVIDERS[v.cfg.provider].name : ' · solo su questo dispositivo'}${v.err ? ' · ⚠ ' + esc(v.err) : ''}</small></span>
      <button class="icon" data-act="vault-rename" data-id="${v.id}" title="Rinomina">${ic('edit')}</button>
      <button class="icon" data-act="vault-export" data-id="${v.id}" title="Esporta backup">${ic('download')}</button>
      <button class="icon" data-act="vault-remove" data-id="${v.id}" title="Rimuovi">${ic('x')}</button></div>`)];
  return `<div class="card stack"><h3>Vault</h3>
    <p class="hint">Tieni separati, per esempio, Personale e Lavoro. Sbloccando il vault principale si aprono anche gli altri; ognuno ha la sua password e può stare su un cloud diverso.</p>
    <div class="vlist">${rows.join('')}</div>
    <details><summary class="btn ghost left">${ic('plus')} Nuovo vault</summary>
      <form id="newVaultForm" class="stack" style="margin-top:10px">
        <label class="lbl">Nome<input name="name" required placeholder="Es. Lavoro"></label>
        <label class="lbl">Password del vault<input name="pw" type="password" required minlength="10" autocomplete="new-password">${meterHTML()}</label>
        <label class="lbl">Ripeti la password<input name="pw2" type="password" required autocomplete="new-password"></label>
        <label class="chk"><input type="checkbox" name="cloud" ${S.sync ? 'checked' : 'disabled'}> Sincronizza sullo stesso cloud del vault principale (in un file separato)</label>
        <p class="hint">La password serve per aprire questo vault da solo, per esempio se lo condividi. Conservala: è anche dentro il vault principale.</p>
        <button class="btn primary left" type="submit">Crea vault</button>
      </form></details>
    <button class="btn ghost left" data-act="pick" data-kind="vault-backup">Aggiungi un vault da backup…</button>
  </div>`;
}

function templatesCard() {
  const list = templates();
  return `<div class="card stack"><h3>Modelli personalizzati</h3>
    <p class="hint">Crea categorie con i campi che ti servono (tessere, assicurazioni, codici…). Oltre ai modelli già pronti: Wi-Fi, conto bancario, documento, licenza, server, account email.</p>
    ${list.map(t => `<div class="vrow"><span class="rtext"><b>${esc((t.f.icon || '📁') + ' ' + t.title)}</b><small>${(() => { try { return JSON.parse(t.f.fields).length; } catch { return 0; } })()} campi</small></span>
      <button class="icon" data-act="tpl-edit" data-id="${t.id}" title="Modifica">${ic('edit')}</button></div>`).join('')}
    <button class="btn left" data-act="tpl-new">${ic('plus')} Nuovo modello</button></div>`;
}

function keyfileCard() {
  const on = !!(S.file.kdf && S.file.kdf.keyfile);
  const rem = rememberedKf();
  return `<div class="card stack"><h3>Keyfile</h3>
    ${on ? `<p>Attivo: per sbloccare servono master password <b>e</b> keyfile${rem ? ' (memorizzato su questo dispositivo)' : ''}.</p>
      <p class="hint">Sui dispositivi dove il keyfile non è memorizzato dovrai sceglierlo a ogni sblocco. La biometria continua a funzionare.</p>
      <div class="row-btns">${rem ? '<button class="btn" data-act="forget-kf">Dimentica su questo dispositivo</button>' : '<button class="btn" data-act="pick-kf" data-mode="remember">Memorizza su questo dispositivo…</button>'}
        <button class="btn danger" data-act="kf-off">Disattiva keyfile</button></div>`
    : `<p class="hint">Un keyfile è un file che tieni su una chiavetta o sul telefono: oltre alla master password servirà anche lui per aprire il vault. Se lo perdi e non è memorizzato da nessuna parte, il vault non si apre più: tienine una copia.</p>
      <div class="row-btns"><button class="btn primary" data-act="kf-gen">Genera un keyfile</button><button class="btn" data-act="pick-kf" data-mode="enable">Usa un file esistente…</button></div>`}
  </div>`;
}

function renderSettings() {
  const st = S.settings, sy = S.sync;
  const opt = (vals, cur, fmt) => vals.map(v => `<option value="${v}" ${+cur === v ? 'selected' : ''}>${fmt(v)}</option>`).join('');
  const reauth = sy && ['gdrive', 'onedrive', 'dropbox'].includes(sy.provider);
  return `<div class="pagewrap"><h1>Impostazioni</h1>
    <div class="card stack"><h3>Sincronizzazione cloud</h3>
      ${sy ? `<p>Collegato a <b>${PROVIDERS[sy.provider].name}</b>${sy.label ? ` (${esc(sy.label)})` : ''}${sy.lastSync ? ` · ultima sincronizzazione ${fmtDate(sy.lastSync)}` : ''}</p>
        ${S.syncErr ? `<p class="err">${esc(S.syncErr.message)}</p>` : ''}
        <div class="row-btns"><button class="btn primary" data-act="sync">Sincronizza ora</button>
          ${reauth ? '<button class="btn" data-act="reauth">Riconnetti</button>' : ''}
          ${S.syncErr && S.syncErr.code === 'other-vault' ? '<button class="btn danger" data-act="cloud-overwrite">Sovrascrivi il cloud con questo vault</button>' : ''}
          <button class="btn ghost" data-act="cloud-off">Disconnetti</button></div>`
      : `<p class="hint">Il vault viene caricato già cifrato: il servizio cloud vede solo dati illeggibili.</p>${cloudForm('connect-cloud', 'Connetti')}`}
    </div>
    ${vaultsCard()}
    ${autofillCard()}
    ${templatesCard()}
    <div class="card stack"><h3>Sblocco biometrico</h3>
      ${S.bio ? '<p>Attivo su questo dispositivo.</p><button class="btn left" data-act="bio-off">Disattiva</button>'
        : S.bioAvail ? '<p class="hint">Usa impronta o volto per sbloccare su questo dispositivo, anche durante la compilazione automatica. Sugli altri dispositivi resta necessaria la master password.</p><button class="btn primary left" data-act="bio-on">Attiva</button>'
        : '<p class="hint">Non disponibile su questo dispositivo.</p>'}
    </div>
    ${keyfileCard()}
    <div class="card stack"><h3>Scorciatoie da tastiera</h3>
      <p class="hint">Sul computer: Ctrl (⌘ su Mac) + F per cercare, + N per un nuovo elemento, + E per modificare, + S per salvare, + L per bloccare. Premi <kbd>?</kbd> per l'elenco completo.</p>
      <button class="btn left" data-act="shortcuts">Mostra tutte le scorciatoie</button></div>
    <div class="card stack"><h3>Blocco e appunti</h3>
      <label class="lbl">Blocca automaticamente dopo<select data-setting="autoLockMin">${opt([1, 5, 15, 30, 60, 0], st.autoLockMin, v => v ? v + ' min di inattività' : 'Mai')}</select></label>
      <label class="lbl">Svuota gli appunti dopo<select data-setting="clipClearSec">${opt([15, 30, 60, 0], st.clipClearSec, v => v ? v + ' secondi' : 'Mai')}</select></label>
    </div>
    <form class="card stack" id="pwForm"><h3>Master password</h3>
      <label class="lbl">Password attuale<input type="password" name="cur" autocomplete="current-password" required></label>
      <label class="lbl">Nuova password<input type="password" name="nw" autocomplete="new-password" required minlength="10">${meterHTML()}</label>
      <label class="lbl">Ripeti la nuova password<input type="password" name="nw2" autocomplete="new-password" required></label>
      ${S.file.kdf && S.file.kdf.keyfile && !rememberedKf() ? '<p class="hint">Ti verrà chiesto anche il keyfile.</p>' : ''}
      <button class="btn primary left" type="submit">Cambia password</button>
    </form>
    <div class="card stack"><h3>Backup e importazione</h3>
      <div class="row-btns"><button class="btn" data-act="export">Esporta backup cifrato</button>
        <button class="btn" data-act="pick" data-kind="backup">Importa backup Scrigno</button></div>
      <div class="row-btns"><button class="btn" data-act="pick" data-kind="enpass">Importa da Enpass (.json)</button>
        <button class="btn" data-act="pick" data-kind="csv">Importa CSV</button></div>
      <p class="hint">In Enpass: Impostazioni › Esporta › formato .json. Il CSV può venire da Chrome, Bitwarden o simili. Dopo l'importazione elimina il file esportato, perché non è cifrato. Gli elementi importati finiscono nel vault ${S.extra.length ? 'selezionato in alto nell\'elenco' : 'principale'}.</p>
    </div>
    <div class="card stack"><h3>Zona pericolosa</h3>
      <button class="btn danger left" data-act="wipe">Rimuovi il vault da questo dispositivo</button>
    </div>
  </div>`;
}

async function tickTotp() {
  for (const el of $$('[data-totp]')) {
    const it = findItem(el.dataset.totp);
    if (!it || !it.f.totp) continue;
    try {
      const cfg = parseTotp(it.f.totp);
      const code = await totp(cfg);
      el.textContent = code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
      const left = cfg.period - (Math.floor(now() / 1000) % cfg.period);
      const ring = el.parentElement.querySelector('[data-ring]');
      ring.textContent = left;
      ring.style.setProperty('--p', (left / cfg.period) * 100);
      ring.classList.toggle('low', left <= 5);
    } catch { el.textContent = 'Segreto non valido'; }
  }
}

async function copy(text, label = 'Copiato') {
  if (!text) return;
  const sec = +S.settings.clipClearSec;
  if (Native.available) {
    await Native.call('copy', { text, clearSec: sec });
  } else {
    try { await navigator.clipboard.writeText(text); } catch { toast('Copia non riuscita'); return; }
    clearTimeout(copy._t);
    if (sec) copy._t = setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), sec * 1000);
  }
  toast(sec ? `${label} · gli appunti si svuotano tra ${sec}s` : label);
}

// data: testo, oppure { b64, type } per i file binari (allegati, keyfile).
async function downloadFile(name, data, type = 'application/json') {
  const bin = typeof data === 'object';
  if (Native.available) {
    if (await Native.call('saveFile', bin ? { name, b64: data.b64 } : { name, text: data })) toast('File salvato');
    return;
  }
  const blob = bin ? new Blob([fromB64(data.b64)], { type: data.type || 'application/octet-stream' }) : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function askPassword(msg) {
  return new Promise(res => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form class="stack"><p>${esc(msg)}</p><input type="password" autocomplete="off" required>
      <div class="row-btns end"><button class="btn primary" value="ok">OK</button><button class="btn ghost" value="no" formnovalidate>Annulla</button></div></form>`;
    document.body.append(d);
    let val = null;
    d.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.submitter || e.submitter.value === 'ok') val = d.querySelector('input').value;
      d.close();
    });
    d.addEventListener('close', () => { d.remove(); res(val); });
    d.showModal();
  });
}
function askText(msg, value = '') {
  return new Promise(res => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form class="stack"><p>${esc(msg)}</p><input autocomplete="off" required value="${esc(value)}">
      <div class="row-btns end"><button class="btn primary" value="ok">OK</button><button class="btn ghost" value="no" formnovalidate>Annulla</button></div></form>`;
    document.body.append(d);
    let val = null;
    d.querySelector('form').addEventListener('submit', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.submitter || e.submitter.value === 'ok') val = d.querySelector('input').value.trim();
      d.close();
    });
    d.addEventListener('close', () => { d.remove(); res(val); });
    d.showModal();
  });
}

// Sceglie un file e ne restituisce il contenuto (per keyfile e allegati).
function pickFile(accept = '') {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file';
    if (accept) inp.accept = accept;
    inp.style.display = 'none';
    inp.addEventListener('change', () => { res(inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

// ---------------------------------------------------------------- keyfile
async function currentKf() {
  const rem = rememberedKf();
  if (rem) return rem;
  toast('Scegli il keyfile attuale');
  const f = await pickFile();
  if (!f) throw new Error('Keyfile non scelto');
  return keyfileHash(await f.arrayBuffer());
}
async function enableKeyfile(hash) {
  const pw = await askPassword('Master password attuale');
  if (!pw) return false;
  await vaultChangePassword(S.file, S.dek, pw, pw, null, hash);
  await saveVault();
  rememberKf(hash);
  renderMain();
  toast('Keyfile attivato e memorizzato su questo dispositivo');
  return true;
}

// ---------------------------------------------------------------- Auto-Type (app desktop)
function autotypeCandidates(title) {
  const t = String(title || '').toLowerCase();
  const logins = allLive().filter(i => i.type === 'login' && (i.f.username || i.f.password));
  const scored = logins.map(i => {
    const host = hostOf(i.f.url || '').replace(/^www\./, '');
    const name = baseDomain(host).split('.')[0];
    let s = 0;
    if (host && t.includes(host)) s += 3;
    if (name && name.length > 2 && t.includes(name)) s += 2;
    if (i.title && t.includes(i.title.toLowerCase())) s += 2;
    return [s, i];
  }).sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title, 'it'));
  return scored.map(x => x[1]);
}
function showAutotype() {
  const req = S.autotype;
  if (!req || $('#atDlg')) return;
  const d = document.createElement('dialog');
  d.className = 'dlg wide';
  d.id = 'atDlg';
  const list = q => {
    const ql = q.toLowerCase();
    return autotypeCandidates(req.title).filter(i => !ql || (i.title + ' ' + (i.f.username || '') + ' ' + (i.f.url || '')).toLowerCase().includes(ql)).slice(0, 30);
  };
  const draw = q => list(q).map(i => `<button type="button" class="row" data-at="${i.id}">${letterIcon(i)}<span class="rtext"><b>${esc(i.title)}</b><small>${esc(i.f.username || '')}</small></span></button>`).join('') || '<p class="empty">Nessun login.</p>';
  d.innerHTML = `<div class="stack"><h3>Compila in: ${esc(req.title || 'app in primo piano')}</h3>
    <input id="atQ" type="search" placeholder="Cerca…" autocomplete="off">
    <label class="chk small"><input type="checkbox" id="atEnter" checked> Premi Invio alla fine</label>
    <div id="atList" class="atlist">${draw('')}</div>
    <div class="row-btns end"><button type="button" class="btn ghost" data-at-cancel>Annulla</button></div></div>`;
  document.body.append(d);
  const done = () => { S.autotype = null; if (d.open) d.close(); d.remove(); };
  d.addEventListener('input', e => { if (e.target.id === 'atQ') $('#atList', d).innerHTML = draw(e.target.value); });
  d.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'atQ') { e.preventDefault(); const b = $('[data-at]', d); if (b) b.click(); }
  });
  d.addEventListener('click', async e => {
    if (e.target.closest('[data-at-cancel]')) { done(); Native.call('autotypeCancel').catch(() => {}); return; }
    const b = e.target.closest('[data-at]');
    if (!b) return;
    const it = findItem(b.dataset.at);
    const enter = $('#atEnter', d).checked;
    done();
    try { await Native.call('autotype', { username: it.f.username || '', password: it.f.password || '', enter }); } catch (err) { toast(err.message, 5000); }
  });
  d.addEventListener('cancel', () => { done(); Native.call('autotypeCancel').catch(() => {}); });
  d.showModal();
  $('#atQ', d).focus();
}

// ---------------------------------------------------------------- flussi
async function afterUnlock() {
  lastAct = now();
  S.view = { section: 'all', id: null, edit: false, q: '', newType: null, vault: 'all' };
  if (S.pendingSync) { await saveSyncCfg(S.pendingSync); S.pendingSync = null; } else S.sync = await loadSyncCfg();
  S.syncState = 'idle';
  await shareSession();
  let dirty = await mergeFromDisk();
  if (purgeTrash(S.items)) dirty = true;
  if (dirty) await persist();
  await loadExtras();
  for (const v of S.extra) if (v.file && purgeTrash(v.items)) await saveExtraVault(store, v).catch(() => {});
  pushIdentities();
  renderMain();
  if (hasAnySync()) syncNow(true);
}

async function wipe() {
  if (!confirm('Rimuovere il vault da questo dispositivo? Se non hai un backup o una copia nel cloud, i dati andranno persi.')) return;
  for (const k of vaultKeyItems(S.items)) await store.del(vaultFileKey(k.f.vaultId)).catch(() => {});
  await store.del('vault'); await store.del('sync');
  await bioReset();
  rememberKf(null);
  if (Native.platform === 'ios') Native.call('identities', { list: [] }).catch(() => {});
  S.file = null; S.pendingSync = null;
  lock();
}

async function handleFile(file, kind) {
  const text = await file.text();
  if (kind === 'setup') {
    const f = JSON.parse(text);
    if (f.format !== 'scrigno' || !f.keys) throw new Error('Questo file non è un backup Scrigno.');
    await store.set('vault', f);
    await store.del('sync');
    await bioReset();
    S.file = f;
    render();
    return toast('Backup caricato: inserisci la master password');
  }
  if (kind === 'vault-backup') {
    const f = JSON.parse(text);
    if (f.format !== 'scrigno') throw new Error('Questo file non è un backup Scrigno.');
    if (f.vaultId === S.file.vaultId) throw new Error('Questo è il backup del vault principale: usa “Importa backup Scrigno”.');
    const pw = await askPassword('Password del vault da aggiungere');
    if (!pw) return;
    const name = await askText('Nome del vault', file.name.replace(/\.json$/i, ''));
    if (!name) return;
    const v = await adoptExtraVault({ file: f, password: pw, name }).catch(e => { throw new Error(e.message === 'Password errata' ? 'Password del vault errata' : e.message); });
    S.items.push(v.key);
    await store.set(vaultFileKey(v.id), v.file);
    await saveVault();
    await loadExtras();
    renderMain();
    return toast(`Vault “${name}” aggiunto`);
  }
  const target = S.view.vault !== 'all' ? S.view.vault : MAIN;
  let items = [];
  if (kind === 'enpass') items = importEnpass(JSON.parse(text));
  else if (kind === 'csv') items = importCSV(text);
  else if (kind === 'backup') {
    const f = JSON.parse(text);
    if (f.format !== 'scrigno') throw new Error('Questo file non è un backup Scrigno.');
    if (f.vaultId === S.file.vaultId) {
      S.items = (await vaultMerge(S.file, S.dek, S.items, f)).items;
      await saveVault(); renderMain();
      return toast('Backup unito al vault');
    }
    const pw = await askPassword('Master password del backup da importare');
    if (!pw) return;
    const dek = await vaultUnlock(f, pw).catch(() => { throw new Error('Password del backup errata'); });
    items = (await vaultRead(f, dek)).filter(isActive).map(i => ({ ...i, id: uuid(), updated: now() }));
  }
  if (!items.length) return toast('Nessun elemento trovato nel file');
  arrOf(target).push(...items);
  await saveVaultOf(target);
  renderMain();
  toast(`Importati ${items.length} elementi in “${vaultName(target)}”`);
}

async function addAttachment() {
  const file = await pickFile();
  if (!file) return;
  if (file.size > MAX_ATTACHMENT) throw new Error(`Il file supera ${fmtSize(MAX_ATTACHMENT)}: gli allegati vengono cifrati e sincronizzati insieme al vault.`);
  const data = toB64(new Uint8Array(await file.arrayBuffer()));
  S.editAtt = [...S.editAtt, { id: uuid(), name: file.name, type: file.type || 'application/octet-stream', size: file.size, data, added: now() }];
  $('#attList').innerHTML = attachmentsBlock(S.editAtt, true);
}

// ---------------------------------------------------------------- eventi
const guard = fn => async e => {
  try { await fn(e); } catch (err) { console.error(err); toast((err && err.message) || String(err), 4500); }
};

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const cur = () => findItem(S.view.id);
  switch (act) {
    case 'section': S.view = { ...S.view, section: b.dataset.k, id: null, edit: false, newType: null }; renderMain(); break;
    case 'open': S.view.id = b.dataset.id; S.view.edit = false; renderMain(); break;
    case 'open-in': S.view = { ...S.view, section: 'all', id: b.dataset.id, edit: false, q: '', newType: null, vault: 'all' }; renderMain(); break;
    case 'open-url': if (Native.available) { e.preventDefault(); Native.call('openUrl', { url: b.href }).catch(() => {}); } break;
    case 'back': S.view.id = null; renderMain(); break;
    case 'new': {
      S.view.edit = true; S.view.id = null; S.editAtt = [];
      const sec = S.view.section;
      S.view.newType = !sec.startsWith('tag:') && types()[sec] && sec !== 'passkey' ? sec : null;
      renderMain();
      break;
    }
    case 'newtype': S.view.newType = b.dataset.k; renderMain(); break;
    case 'edit': S.view.edit = true; S.editAtt = (cur().attachments || []).slice(); renderMain(); break;
    case 'cancel': S.view.edit = false; S.view.newType = null; S.editAtt = []; renderMain(); break;
    case 'fav': { const x = cur(); x.fav = !x.fav; x.updated = now(); await saveVaultOf(vaultOf(x.id)); renderMain(); break; }
    case 'delete': {
      const x = cur();
      trashItem(x);
      S.view.id = null;
      await saveVaultOf(vaultOf(x.id)); renderMain(); toast('Spostato nel cestino');
      break;
    }
    case 'restore': { const x = cur(); restoreItem(x); await saveVaultOf(vaultOf(x.id)); S.view.id = null; renderMain(); toast('Ripristinato'); break; }
    case 'purge': {
      const x = cur();
      if (!confirm(`Eliminare definitivamente “${x.title}”? Non si potrà recuperare.`)) return;
      const vid = vaultOf(x.id);
      replaceItem(vid, tombstone(x));
      S.view.id = null;
      await saveVaultOf(vid); renderMain(); toast('Eliminato definitivamente');
      break;
    }
    case 'copy': await copy(getVal(cur(), b.dataset.k)); break;
    case 'reveal': {
      const span = b.parentElement.querySelector('.val');
      if (span.dataset.shown) { span.textContent = '••••••••'; delete span.dataset.shown; } else { span.textContent = getVal(cur(), b.dataset.k); span.dataset.shown = '1'; }
      break;
    }
    case 'reveal-h': {
      const span = b.parentElement.querySelector('.val');
      if (span.dataset.shown) { span.textContent = '••••••••'; delete span.dataset.shown; } else { span.textContent = cur().history[+b.dataset.ix].password; span.dataset.shown = '1'; }
      break;
    }
    case 'copy-h': await copy(cur().history[+b.dataset.ix].password); break;
    case 'att-add': await addAttachment(); break;
    case 'att-del': S.editAtt = S.editAtt.filter((_, i) => i !== +b.dataset.ix); $('#attList').innerHTML = attachmentsBlock(S.editAtt, true); break;
    case 'att-save': case 'att-open': {
      const a = cur().attachments[+b.dataset.ix];
      if (act === 'att-open' && !Native.available) {
        const url = URL.createObjectURL(new Blob([fromB64(a.data)], { type: a.type }));
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else await downloadFile(a.name, { b64: a.data, type: a.type });
      break;
    }
    case 'copy-totp': { const x = findItem(b.dataset.id); await copy(await totp(parseTotp(x.f.totp)), 'Codice copiato'); break; }
    case 'toggle-input': { const inp = b.parentElement.querySelector('input'); inp.type = inp.type === 'password' ? 'text' : 'password'; break; }
    case 'gen-into': { const inp = b.parentElement.querySelector('input'); inp.value = genPassword(S.gen); inp.type = 'text'; updateMeter(inp); break; }
    case 'add-custom': $('#customList').insertAdjacentHTML('beforeend', customRow()); break;
    case 'del-custom': b.closest('.crow').remove(); break;
    case 'lock': lock(); break;
    case 'shortcuts': showShortcuts(); break;
    case 'native': await Native.call(b.dataset.m); break;
    case 'sync':
      if (!hasAnySync()) { S.view = { ...S.view, section: 'settings', id: null, edit: false, newType: null }; renderMain(); } else { await syncNow(false); if (S.view.section === 'settings') renderMain(); }
      break;
    case 'gen-new': S.genVal = genPassword(S.gen); updateGenOut(); break;
    case 'gen-copy': await copy(S.genVal); break;
    case 'bio-unlock': await bioUnlock(); break;
    case 'bio-on': await bioEnroll(); toast('Sblocco biometrico attivato'); renderMain(); break;
    case 'bio-off': await bioReset(); renderMain(); toast('Sblocco biometrico disattivato'); break;
    case 'check-pwned': await checkAllPasswords(); break;
    case 'load-dirs': await loadDirs(); break;
    // modelli
    case 'tpl-new': S.tplEdit = null; S.view = { ...S.view, section: 'template', id: null, edit: false }; renderMain(); break;
    case 'tpl-edit': {
      const t = S.items.find(i => i.id === b.dataset.id);
      let fields = [];
      try { fields = JSON.parse(t.f.fields); } catch { fields = []; }
      S.tplEdit = { id: t.id, title: t.title, icon: t.f.icon || '📁', fields };
      S.view = { ...S.view, section: 'template', id: null, edit: false };
      renderMain();
      break;
    }
    case 'tpl-add-field': $('#tplFields').insertAdjacentHTML('beforeend', tplRow()); break;
    case 'tpl-del-field': b.closest('.tplrow').remove(); break;
    case 'tpl-del': {
      const t = S.items.find(i => i.id === S.tplEdit.id);
      const used = allLive().some(i => i.type === 'tpl:' + t.id);
      if (!confirm(used ? 'Ci sono elementi creati con questo modello: resteranno, ma senza i nomi dei campi. Eliminare il modello?' : 'Eliminare il modello?')) return;
      replaceItem(MAIN, tombstone(t));
      S.tplEdit = null;
      await saveVault();
      S.view = { ...S.view, section: 'settings' };
      renderMain();
      break;
    }
    // vault
    case 'vault-rename': {
      const id = b.dataset.id;
      const name = await askText('Nuovo nome del vault', vaultName(id));
      if (!name) return;
      if (id === MAIN) { S.settings.mainName = name; saveSettings(); } else {
        const v = S.extra.find(x => x.id === id);
        const key = S.items.find(i => i.id === v.keyId);
        key.title = name; key.updated = now(); v.name = name;
        await saveVault();
      }
      renderMain();
      break;
    }
    case 'vault-export': {
      const v = S.extra.find(x => x.id === b.dataset.id);
      if (!v.file) throw new Error('Questo vault non è ancora su questo dispositivo');
      await downloadFile(`scrigno-${v.name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(v.file));
      break;
    }
    case 'vault-remove': {
      const v = S.extra.find(x => x.id === b.dataset.id);
      if (!confirm(`Rimuovere il vault “${v.name}” da Scrigno? Sparirà da tutti i tuoi dispositivi. ${v.cfg ? 'Il file nel cloud resta dov\'è.' : 'Non è sincronizzato: esporta prima un backup se vuoi conservarlo.'}`)) return;
      const key = S.items.find(i => i.id === v.keyId);
      replaceItem(MAIN, tombstone(key));
      await store.del(vaultFileKey(v.id)).catch(() => {});
      await saveVault();
      await loadExtras();
      S.view.vault = 'all';
      renderMain();
      toast('Vault rimosso');
      break;
    }
    // keyfile
    case 'pick-kf': {
      const f = await pickFile();
      if (!f) return;
      const h = await keyfileHash(await f.arrayBuffer());
      const mode = b.dataset.mode;
      if (mode === 'unlock') { S.kf = h; const st = $('#kfState'); if (st) st.textContent = 'scelto: ' + f.name; }
      else if (mode === 'enable') await enableKeyfile(h);
      else if (mode === 'remember') {
        await vaultUnlock(S.file, await askPassword('Master password, per verificare il keyfile') || '', h).catch(() => { throw new Error('Password o keyfile errati'); });
        rememberKf(h); renderMain(); toast('Keyfile memorizzato');
      }
      break;
    }
    case 'forget-kf': rememberKf(null); S.kf = null; render(); toast('Keyfile dimenticato su questo dispositivo'); break;
    case 'kf-gen': {
      const bytes = rand(64);
      const h = await keyfileHash(bytes);
      if (await enableKeyfile(h)) await downloadFile('scrigno.keyfile', { b64: toB64(bytes), type: 'application/octet-stream' });
      break;
    }
    case 'kf-off': {
      const kf = await currentKf();
      const pw = await askPassword('Master password attuale');
      if (!pw) return;
      await vaultChangePassword(S.file, S.dek, pw, pw, kf, null);
      await saveVault();
      rememberKf(null);
      renderMain();
      toast('Keyfile disattivato');
      break;
    }
    case 'connect-cloud': {
      const c = await connectCloud(readCloudForm(b.closest('.cloudform')));
      const remote = await PROVIDERS[c.provider].download(c);
      if (remote && remote.vaultId !== S.file.vaultId) {
        if (!confirm('Nel cloud c\'è già un vault Scrigno diverso da questo. Sovrascriverlo con quello di questo dispositivo? Il vault nel cloud andrà perso.\n\nSe invece vuoi usare quello del cloud, rimuovi il vault da questo dispositivo e scegli “Dal cloud”.')) return;
        await PROVIDERS[c.provider].upload(c, S.file);
      }
      await saveSyncCfg(c);
      S.syncErr = null;
      toast('Cloud collegato');
      await syncNow(false);
      renderMain();
      break;
    }
    case 'reauth': {
      const old = S.sync;
      const c = await connectCloud({ provider: old.provider, clientId: old.clientId, appKey: old.appKey });
      await saveSyncCfg({ ...old, ...c });
      // aggiorna anche i vault aggiuntivi sullo stesso servizio
      for (const v of S.extra) if (v.cfg && v.cfg.provider === c.provider) Object.assign(v.cfg, { access: c.access, exp: c.exp, refresh: c.refresh || v.cfg.refresh });
      S.syncErr = null;
      await syncNow(false);
      renderMain();
      break;
    }
    case 'cloud-off':
      if (!confirm('Scollegare il cloud? Il file nel cloud resta dov\'è.')) return;
      await saveSyncCfg(null); S.syncErr = null; S.syncState = 'idle'; renderMain();
      break;
    case 'cloud-overwrite':
      if (!confirm('Sovrascrivere il vault nel cloud con quello di questo dispositivo?')) return;
      await PROVIDERS[S.sync.provider].upload(S.sync, S.file);
      S.syncErr = null; setSync('ok'); renderMain(); toast('Cloud aggiornato');
      break;
    case 'export': await downloadFile(`scrigno-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(S.file)); break;
    case 'pick': { const fi = $('#fileIn'); fi.dataset.kind = b.dataset.kind; fi.click(); break; }
    case 'wipe': await wipe(); break;
    case 'setup-tab': S.setupTab = b.dataset.k; renderSetup(); break;
    case 'setup-cloud': {
      const c = await connectCloud(readCloudForm(b.closest('.cloudform')));
      const remote = await PROVIDERS[c.provider].download(c);
      if (!remote) throw new Error('Nel cloud non c\'è ancora un vault Scrigno.');
      if (remote.format !== 'scrigno') throw new Error('Il file nel cloud non è un vault Scrigno.');
      await store.set('vault', remote);
      await bioReset();
      S.file = remote; S.pendingSync = c;
      render();
      break;
    }
  }
}

async function onSubmit(e) {
  const fm = e.target;
  if (fm.closest('dialog')) return;
  e.preventDefault();
  if (fm.id === 'unlockForm') {
    const btn = fm.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sblocco…';
    try {
      const kf = S.file.kdf && S.file.kdf.keyfile ? S.kf : null;
      await openWithDEK(await vaultUnlock(S.file, $('#mp').value, kf));
      if (kf && $('#kfRemember') && $('#kfRemember').checked) rememberKf(kf);
      await afterUnlock();
    } catch (err) {
      const p = $('#unlockErr'); p.textContent = err.message; p.hidden = false;
      btn.disabled = false; btn.textContent = 'Sblocca';
      $('#mp').select();
    }
  } else if (fm.id === 'createForm') {
    const pw = fm.pw.value;
    if (pw !== fm.pw2.value) throw new Error('Le due password non coincidono');
    if (strength(pw).lvl < 2) throw new Error('Master password troppo debole: allungala o usa una frase di più parole');
    const btn = fm.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Creazione…';
    try { await createVault(pw); } finally { btn.disabled = false; btn.textContent = 'Crea il vault'; }
    await afterUnlock();
    toast('Vault creato');
  } else if (fm.id === 'editForm') {
    await saveEdit(fm);
  } else if (fm.id === 'tplForm') {
    await saveTemplate(fm);
  } else if (fm.id === 'newVaultForm') {
    if (fm.pw.value !== fm.pw2.value) throw new Error('Le due password non coincidono');
    if (strength(fm.pw.value).lvl < 2) throw new Error('Password troppo debole');
    const btn = fm.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Creazione…';
    try {
      const v = await createExtraVault({ name: fm.name.value.trim(), password: fm.pw.value, cloudCfg: fm.cloud.checked && S.sync ? S.sync : null });
      S.items.push(v.key);
      await store.set(vaultFileKey(v.id), v.file);
      await saveVault();
      await loadExtras();
      S.view.vault = v.id;
      renderMain();
      toast(`Vault “${v.name}” creato`);
      if (v.cfg) syncNow(true);
    } finally { btn.disabled = false; }
  } else if (fm.id === 'pwForm') {
    if (fm.nw.value !== fm.nw2.value) throw new Error('Le due password non coincidono');
    if (strength(fm.nw.value).lvl < 2) throw new Error('Nuova password troppo debole');
    const kf = S.file.kdf && S.file.kdf.keyfile ? await currentKf() : null;
    await vaultChangePassword(S.file, S.dek, fm.cur.value, fm.nw.value, kf, kf);
    await saveVault();
    fm.reset();
    toast('Master password cambiata');
  }
}

function onInput(e) {
  const t = e.target;
  if (t.id === 'q') {
    S.view.q = t.value;
    $('#items').innerHTML = renderList();
    const n = $('.list-sub span'); if (n) n.textContent = visibleItems().length;
    return;
  }
  if (t.name === 'f_password' || t.name === 'pw' || t.name === 'nw') { updateMeter(t); return; }
  if (t.dataset.gen) {
    S.gen[t.dataset.gen] = t.type === 'checkbox' ? t.checked : +t.value;
    S.genVal = genPassword(S.gen);
    updateGenOut();
  }
}

async function onChange(e) {
  const t = e.target;
  if (t.id === 'vaultSel') { S.view.vault = t.value; S.view.id = null; renderMain(); return; }
  if (t.id === 'sortSel') { S.settings.sort = t.value; saveSettings(); $('#items').innerHTML = renderList(); return; }
  if (t.dataset.role === 'prov') { t.closest('.cloudform').querySelector('[data-role=pf]').innerHTML = provFields(t.value); return; }
  if (t.dataset.setting) { S.settings[t.dataset.setting] = +t.value; saveSettings(); toast('Impostazione salvata'); return; }
  if (t.id === 'fileIn' && t.files[0]) {
    const file = t.files[0];
    t.value = '';
    await handleFile(file, t.dataset.kind);
  }
}

async function onResume() {
  if (!S.file) return;
  if (!S.dek) {
    // Il vault potrebbe essere stato creato o sostituito altrove (es. compilazione automatica): ricarica.
    try { const f = await store.get('vault'); if (f) S.file = f; } catch { /* ignora */ }
    return;
  }
  if (await mergeFromDisk()) { await persist(); await loadExtras(); if (!S.view.edit) renderMain(); }
  scheduleSync(300);
}

// ---------------------------------------------------------------- scorciatoie da tastiera
const SHORTCUTS = [
  ['Ctrl/⌘ + F', 'Cerca'], ['Ctrl/⌘ + N', 'Nuovo elemento'], ['Ctrl/⌘ + E', 'Modifica l\'elemento aperto'],
  ['Ctrl/⌘ + S', 'Salva le modifiche'], ['Esc', 'Annulla la modifica o chiudi l\'elemento'], ['↑ / ↓', 'Elemento precedente / successivo'],
  ['Ctrl/⌘ + B', 'Copia il nome utente'], ['Ctrl/⌘ + Maiusc + C', 'Copia la password'], ['Ctrl/⌘ + Maiusc + O', 'Copia il codice 2FA'],
  ['Ctrl/⌘ + D', 'Aggiungi o togli dai preferiti'], ['Canc', 'Sposta nel cestino'], ['Ctrl/⌘ + L', 'Blocca Scrigno'], ['?', 'Mostra le scorciatoie'],
];
function showShortcuts() {
  if ($('#scDlg')) return;
  const d = document.createElement('dialog');
  d.className = 'dlg wide';
  d.id = 'scDlg';
  d.innerHTML = `<div class="stack"><h3>Scorciatoie da tastiera</h3>
    <table class="sc">${SHORTCUTS.map(([k, l]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(l)}</td></tr>`).join('')}</table>
    <div class="row-btns end"><button class="btn primary" data-close>OK</button></div></div>`;
  document.body.append(d);
  d.addEventListener('click', e => { if (e.target.closest('[data-close]')) d.close(); });
  d.addEventListener('close', () => d.remove());
  d.showModal();
}
function onKey(e) {
  if (!S.dek || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const k = e.key.toLowerCase();
  const cur = S.view.id ? findItem(S.view.id) : null;
  const click = sel => { const b = $(sel); if (b) { e.preventDefault(); b.click(); return true; } return false; };
  if (mod && k === 'f') { const q = $('#q'); if (!q) { S.view = { ...S.view, section: 'all', id: null, edit: false }; renderMain(); } e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  if (mod && k === 'n' && !e.shiftKey) { e.preventDefault(); if (PAGES.includes(S.view.section)) S.view = { ...S.view, section: 'all' }; S.view.id = null; S.view.edit = true; S.editAtt = []; S.view.newType = null; renderMain(); return; }
  if (mod && k === 's') { const f = $('#editForm') || $('#tplForm'); if (f) { e.preventDefault(); f.requestSubmit(); } return; }
  if (mod && k === 'l') { e.preventDefault(); lock(); return; }
  if (mod && k === 'e' && cur && !S.view.edit) { click('[data-act=edit]'); return; }
  if (mod && k === 'd' && cur && !S.view.edit && !cur.trashed) { click('[data-act=fav]'); return; }
  if (mod && k === 'b' && cur && !S.view.edit) { e.preventDefault(); copy(cur.f.username || cur.f.email || '', 'Nome utente copiato'); return; }
  if (mod && e.shiftKey && k === 'c' && cur && !S.view.edit) { e.preventDefault(); copy(cur.f.password || '', 'Password copiata'); return; }
  if (mod && e.shiftKey && k === 'o' && cur && cur.f.totp) { e.preventDefault(); totp(parseTotp(cur.f.totp)).then(c => copy(c, 'Codice copiato')); return; }
  if (e.key === 'Escape') {
    if (S.view.edit) { click('[data-act=cancel]'); return; }
    if (S.view.id) { e.preventDefault(); S.view.id = null; renderMain(); return; }
    if (typing && t.id === 'q' && t.value) { t.value = ''; S.view.q = ''; $('#items').innerHTML = renderList(); }
    return;
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !S.view.edit && (!typing || t.id === 'q') && !PAGES.includes(S.view.section)) {
    const list = visibleItems();
    if (!list.length) return;
    e.preventDefault();
    let ix = list.findIndex(i => i.id === S.view.id);
    ix = e.key === 'ArrowDown' ? Math.min(list.length - 1, ix + 1) : Math.max(0, ix - 1);
    S.view.id = list[ix].id;
    const keepSearch = t && t.id === 'q';
    renderMain();
    const row = $(`.row[data-id="${list[ix].id}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
    if (keepSearch) { const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    return;
  }
  if (typing) return;
  if (e.key === 'Delete' && cur && !S.view.edit && !cur.trashed) { click('[data-act=delete]'); return; }
  if (e.key === '?') { e.preventDefault(); showShortcuts(); }
}

// ---------------------------------------------------------------- avvio
let lastAct = now();
async function boot() {
  S.settings = loadSettings();
  setupCloudEnv();
  try { S.file = (await store.get('vault')) || null; } catch (e) {
    $('#app').innerHTML = '<div class="center"><div class="card auth"><p class="err">Questo browser non consente l\'archiviazione locale (forse sei in navigazione privata).</p></div></div>';
    return;
  }
  await bioInit();
  document.addEventListener('click', guard(onClick));
  document.addEventListener('submit', guard(onSubmit));
  document.addEventListener('input', onInput);
  document.addEventListener('change', guard(onChange));
  document.addEventListener('keydown', e => { try { onKey(e); } catch (err) { toast(err.message); } });
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, () => { lastAct = now(); }, { passive: true }));
  setInterval(() => {
    if (S.dek && +S.settings.autoLockMin > 0 && now() - lastAct > S.settings.autoLockMin * 60000) lock();
    else if (S.dek) tickTotp();
  }, 1000);
  setInterval(() => syncNow(true), 5 * 60000);
  addEventListener('online', () => scheduleSync(500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onResume(); });
  Native.on('resume', () => onResume());
  Native.on('vaultChanged', () => onResume());
  Native.on('lock', () => { if (S.dek) lock(); });
  Native.on('autotype', req => {
    S.autotype = req || { title: '' };
    lastAct = now();
    if (S.dek) showAutotype(); else render();
  });
  render();
  if (!Native.available && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (typeof document !== 'undefined' && document.getElementById('app')) boot();
