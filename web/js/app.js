'use strict';
/* Scrigno — interfaccia (web app e app native). Usa core.js, native.js, cloud.js. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CONFIG = self.SCRIGNO_CONFIG || { pagesUrl: '' };

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
  sync: null, syncState: 'idle', syncErr: null, pendingSync: null,
  bio: null, bioAvail: false,
  view: { section: 'all', id: null, edit: false, q: '', newType: null },
  setupTab: 'new', gen: { ...GEN_DEFAULT }, genVal: '',
  autotype: null,
};

function loadSettings() {
  const def = { autoLockMin: 5, clipClearSec: 30 };
  try { return { ...def, ...JSON.parse(localStorage.getItem('scrigno-settings') || '{}') }; } catch { return def; }
}
function saveSettings() {
  try { localStorage.setItem('scrigno-settings', JSON.stringify(S.settings)); } catch { /* ignora */ }
  if (S.dek) shareSession();
}
function loadIds() { try { return JSON.parse(localStorage.getItem('scrigno-oauth-ids') || '{}'); } catch { return {}; } }
function saveIds(o) { try { localStorage.setItem('scrigno-oauth-ids', JSON.stringify({ ...loadIds(), ...o })); } catch { /* ignora */ } }
const live = () => S.items.filter(i => !i.deleted);

// ---------------------------------------------------------------- vault
async function createVault(password) {
  const v = await vaultCreate(password);
  S.file = v.file; S.dek = v.dek; S.items = [];
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

function lock() {
  S.dek = null; S.items = []; S.sync = null; S.syncErr = null; S.syncState = 'idle';
  S.view = { section: 'all', id: null, edit: false, q: '', newType: null };
  S.genVal = '';
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
    const list = live().flatMap(i => {
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
function scheduleSync(ms = 1500) {
  if (!S.sync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), ms);
}
async function syncNow(silent = false) {
  if (!S.sync || !S.dek) return;
  if (syncing) { scheduleSync(3000); return; }
  syncing = true;
  setSync('busy');
  try {
    await mergeFromDisk();
    const r = await cloudSync({ file: S.file, dek: S.dek, items: S.items, cfg: S.sync });
    S.items = r.items;
    if (r.changedLocal || r.uploaded) { await store.set('vault', S.file); pushIdentities(); }
    S.sync.lastSync = now();
    await saveSyncCfg(S.sync);
    S.syncErr = null;
    setSync('ok');
    if (r.changedLocal && S.dek && !S.view.edit) renderMain();
  } catch (e) {
    S.syncErr = { message: e.message, code: e.code };
    setSync('err');
    if (!silent) toast(e.message, 4500);
  } finally {
    syncing = false;
  }
}
function syncLabel() {
  const [i, t] = !S.sync ? ['☁', 'Collega cloud']
    : ({ busy: ['⟳', 'Sincronizzo…'], ok: ['✓', 'Sincronizzato'], err: ['⚠', 'Errore sync'], idle: ['☁', 'Cloud collegato'] }[S.syncState] || ['☁', 'Cloud']);
  return `<span>${i}</span><span class="nl"> ${t}</span>`;
}
function setSync(st) {
  S.syncState = st;
  const p = $('#syncPill');
  if (p) { p.innerHTML = syncLabel(); p.dataset.state = st; }
}

// ---------------------------------------------------------------- interfaccia
const PAGES = ['audit', 'gen', 'settings'];
const SECTIONS = [
  ['all', 'Tutti', '🗂️'], ['fav', 'Preferiti', '⭐'],
  ...Object.entries(TYPES).map(([k, t]) => [k, t.plural, t.icon]),
  ['audit', 'Sicurezza', '🛡️'], ['gen', 'Generatore', '🎲'], ['settings', 'Impostazioni', '⚙️'],
];
const LOGO = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="8" fill="var(--acc)"/><path d="M11 14.5v-3a5 5 0 0 1 10 0v3" fill="none" stroke="var(--on-acc)" stroke-width="2.4" stroke-linecap="round"/><rect x="8.5" y="14.5" width="15" height="10.5" rx="2.5" fill="var(--on-acc)"/><circle cx="16" cy="19" r="1.8" fill="var(--acc)"/><rect x="15.2" y="19.6" width="1.6" height="3" rx=".8" fill="var(--acc)"/></svg>`;

function subtitle(i) {
  const f = i.f || {};
  switch (i.type) {
    case 'login': return f.username || hostOf(f.url);
    case 'card': return f.number ? '•••• ' + f.number.replace(/\s/g, '').slice(-4) : (f.holder || '');
    case 'identity': return [f.firstName, f.lastName].filter(Boolean).join(' ') || f.email || '';
    case 'note': return (f.notes || '').split('\n')[0].slice(0, 60);
    case 'passkey': return [f.username, f.rpId].filter(Boolean).join(' · ');
  }
  return '';
}
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
function letterIcon(it, big = false) {
  const ch = (it.title || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="ricon${big ? ' big' : ''}" style="background:hsl(${hue(it.title || '')} 45% 42%)">${esc(ch)}</span>`;
}

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
    <p class="tag">Password, passkey, carte e codici 2FA, cifrati sui tuoi dispositivi.</p>
    <div class="tabs">${[['new', 'Nuovo vault'], ['cloud', 'Dal cloud'], ['file', 'Da backup']].map(([k, l]) =>
      `<button class="tab ${tab === k ? 'on' : ''}" data-act="setup-tab" data-k="${k}">${l}</button>`).join('')}</div>
    ${body}</div></div>`;
}

function renderLock() {
  $('#app').innerHTML = `<div class="center"><div class="card auth">
    <div class="brand big">${LOGO}<span>Scrigno</span></div>
    <form id="unlockForm" class="stack">
      <label class="lbl">Master password<input type="password" id="mp" autocomplete="current-password" required></label>
      <p class="err" id="unlockErr" hidden></p>
      <button class="btn primary wide" type="submit">Sblocca</button>
    </form>
    ${S.bio ? '<button class="btn wide" data-act="bio-unlock">👆 Sblocca con biometria</button>' : ''}
    ${S.pendingSync ? '<p class="hint">Vault scaricato dal cloud: inserisci la sua master password.</p>' : ''}
    ${S.autotype ? '<p class="hint">Sblocca per compilare nell\'app in primo piano.</p>' : ''}
    <button class="link" data-act="wipe">Rimuovi il vault da questo dispositivo</button>
  </div></div>`;
  const mp = $('#mp');
  if (mp) mp.focus();
}

function countFor(k) {
  if (PAGES.includes(k)) return '';
  const n = live().filter(i => k === 'all' || (k === 'fav' ? i.fav : i.type === k)).length;
  return n ? `<span class="cnt">${n}</span>` : '';
}

function renderMain() {
  const v = S.view;
  const page = PAGES.includes(v.section);
  $('#app').innerHTML = `<div class="shell ${page ? 'pagemode' : ''} ${v.id || v.edit ? 'show-detail' : ''}">
    <aside class="nav">
      <div class="brand">${LOGO}<span>Scrigno</span></div>
      <nav>${SECTIONS.map(([k, l, i]) => `<button class="nav-btn ${v.section === k ? 'on' : ''}" data-act="section" data-k="${k}"><span class="ni">${i}</span><span class="nl">${l}</span>${countFor(k)}</button>`).join('')}</nav>
      <div class="nav-foot">
        <button class="sync-pill" id="syncPill" data-act="sync" data-state="${S.syncState}">${syncLabel()}</button>
        <button class="btn ghost" data-act="lock" title="Blocca">🔒<span class="nl"> Blocca</span></button>
      </div>
    </aside>
    ${page ? `<section class="page">${v.section === 'audit' ? renderAudit() : v.section === 'gen' ? renderGen() : renderSettings()}</section>`
      : `<section class="list">
          <div class="list-head"><input id="q" type="search" placeholder="Cerca…" value="${esc(v.q)}" autocomplete="off"><button class="btn primary" data-act="new" title="Nuovo">＋</button></div>
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
  return live()
    .filter(i => section === 'all' || (section === 'fav' ? i.fav : i.type === section))
    .filter(i => !ql || [i.title, i.f.username, i.f.url, i.f.email, i.f.notes, i.f.rpId, i.f.holder]
      .some(x => x && String(x).toLowerCase().includes(ql)))
    .sort((a, b) => (!!b.fav - !!a.fav) || a.title.localeCompare(b.title, 'it'));
}
function renderList() {
  const items = visibleItems();
  if (!items.length) {
    return `<p class="empty">${live().length ? 'Nessun risultato.' : 'Il vault è vuoto.<br>Premi ＋ per aggiungere il primo elemento, oppure importa da Enpass in Impostazioni.'}</p>`;
  }
  return items.map(i => `<button class="row ${S.view.id === i.id ? 'on' : ''}" data-act="open" data-id="${i.id}">
      ${letterIcon(i)}<span class="rtext"><b>${esc(i.title)}</b><small>${esc(subtitle(i))}</small></span>${i.fav ? '<span class="star">★</span>' : ''}
    </button>`).join('');
}

function fieldRow(it, k, label, kind, val = getVal(it, k)) {
  if (kind === 'totp') {
    return `<div class="field"><label>${esc(label)}</label><div class="fv">
      <span class="totp" data-totp="${it.id}">··· ···</span><span class="ring" data-ring></span>
      <button class="icon" data-act="copy-totp" data-id="${it.id}" title="Copia codice">⧉</button></div></div>`;
  }
  const secret = !!kind && kind.startsWith('secret');
  const multi = kind === 'multi' || kind === 'secret-multi';
  let shown = secret ? '••••••••' : esc(val);
  if (kind === 'url') shown = `<a href="${esc(safeUrl(val))}" target="_blank" rel="noopener noreferrer" data-act="open-url">${esc(val)}</a>`;
  let badge = '';
  if (k === 'password') { const s = strength(val); badge = ` <span class="badge l${s.lvl}">${s.label}</span>`; }
  return `<div class="field"><label>${esc(label)}${badge}</label><div class="fv">
    <span class="val ${multi ? 'multi' : ''} ${secret ? 'mono' : ''}">${shown}</span>
    ${secret ? `<button class="icon" data-act="reveal" data-k="${k}" title="Mostra">👁</button>` : ''}
    <button class="icon" data-act="copy" data-k="${k}" title="Copia">⧉</button></div></div>`;
}

function renderDetail() {
  const v = S.view;
  if (v.edit) return renderEdit();
  const it = live().find(i => i.id === v.id);
  if (!it) return `<div class="placeholder">${LOGO}<p>Seleziona un elemento</p></div>`;
  const T = TYPES[it.type];
  const rows = T.fields.filter(([k]) => it.f[k]).map(([k, l, kind]) => fieldRow(it, k, l, kind)).join('');
  const custom = (it.custom || []).map((c, ix) => c.value ? fieldRow(it, 'c' + ix, c.label || 'Campo', c.secret ? 'secret' : 'text') : '').join('');
  return `<div class="dhead">
      <button class="btn ghost back" data-act="back">‹</button>
      <div class="dtitle">${letterIcon(it, true)}<div><h2>${esc(it.title)}</h2><small>${T.icon} ${T.label}</small></div></div>
      <div class="dactions"><button class="btn ghost" data-act="fav" title="Preferito">${it.fav ? '★' : '☆'}</button><button class="btn" data-act="edit">Modifica</button></div>
    </div>
    <div class="fields">${rows + custom || '<p class="hint">Nessun campo compilato.</p>'}</div>
    ${it.type === 'passkey' ? '<p class="hint">Questa passkey si usa dall\'estensione Scrigno nel browser e dalla compilazione automatica di Android e iPhone.</p>' : ''}
    <p class="meta">Creato ${fmtDate(it.created)} · Modificato ${fmtDate(it.updated)}${it.pwChanged ? ` · Password cambiata ${fmtDate(it.pwChanged)}` : ''}</p>
    <button class="btn danger" data-act="delete">Elimina</button>`;
}

function editField(k, label, kind, val = '') {
  if (kind === 'multi' || kind === 'secret-multi') {
    return `<label class="lbl">${esc(label)}<textarea name="f_${k}" rows="4" spellcheck="false" ${kind === 'secret-multi' ? 'class="mono"' : ''}>${esc(val)}</textarea></label>`;
  }
  const isPw = k === 'password';
  return `<label class="lbl">${esc(label)}<span class="inrow">
      <input name="f_${k}" type="${kind === 'secret' ? 'password' : 'text'}" value="${esc(val)}" autocomplete="${isPw ? 'new-password' : 'off'}" spellcheck="false" ${kind === 'url' ? 'inputmode="url"' : ''}${kind === 'totp' ? ' placeholder="JBSW Y3DP… oppure otpauth://…"' : ''}>
      ${kind === 'secret' ? '<button type="button" class="icon" data-act="toggle-input" title="Mostra">👁</button>' : ''}
      ${isPw ? '<button type="button" class="icon" data-act="gen-into" title="Genera password">🎲</button>' : ''}
    </span>${isPw ? meterHTML() : ''}</label>`;
}
function customRow(c = { label: '', value: '', secret: false }) {
  return `<div class="crow">
    <input data-c="label" placeholder="Etichetta" value="${esc(c.label)}" autocomplete="off">
    <input data-c="value" placeholder="Valore" type="${c.secret ? 'password' : 'text'}" value="${esc(c.value)}" autocomplete="off">
    <label class="chk small"><input type="checkbox" data-c="secret" ${c.secret ? 'checked' : ''}> Segreto</label>
    <button type="button" class="icon" data-act="del-custom" title="Rimuovi">✕</button></div>`;
}
function renderEdit() {
  const v = S.view;
  const it = v.id ? live().find(i => i.id === v.id) : null;
  const type = it ? it.type : v.newType;
  if (!type) {
    return `<div class="dhead"><button class="btn ghost" data-act="cancel">‹ Annulla</button><h2>Nuovo elemento</h2><span></span></div>
      <div class="typegrid">${Object.entries(TYPES).filter(([k]) => k !== 'passkey').map(([k, t]) => `<button class="typecard" data-act="newtype" data-k="${k}"><span>${t.icon}</span>${t.label}</button>`).join('')}</div>
      <p class="hint">Le passkey si creano da sole quando un sito o un'app te ne propone una e scegli Scrigno.</p>`;
  }
  const T = TYPES[type];
  const f = it ? it.f : {};
  return `<form id="editForm" class="edit stack" data-type="${type}" autocomplete="off">
    <div class="dhead"><button type="button" class="btn ghost" data-act="cancel">‹ Annulla</button><h2>${T.icon} ${it ? 'Modifica' : 'Nuovo'}</h2><button class="btn primary" type="submit">Salva</button></div>
    <label class="lbl">Titolo<input name="title" required value="${esc(it ? it.title : '')}" autocomplete="off"></label>
    ${T.fields.map(([k, l, kind]) => editField(k, l, kind, f[k])).join('')}
    <div class="custom" id="customList">${(it ? it.custom || [] : []).map(customRow).join('')}</div>
    <button type="button" class="btn ghost left" data-act="add-custom">＋ Campo personalizzato</button>
    <label class="chk"><input type="checkbox" name="fav" ${it && it.fav ? 'checked' : ''}> Preferito</label>
  </form>`;
}

async function saveEdit(form) {
  const type = form.dataset.type;
  const fd = new FormData(form);
  const old = S.view.id ? S.items.find(i => i.id === S.view.id) : null;
  const f = {};
  for (const [k, , kind] of TYPES[type].fields) {
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
  const item = {
    id: old ? old.id : uuid(), type, title: (fd.get('title') || '').trim() || 'Senza titolo', f, custom,
    fav: !!fd.get('fav'), created: old ? old.created : t, updated: t,
    pwChanged: f.password && f.password !== (old && old.f.password) ? t : old && old.pwChanged,
  };
  S.items = old ? S.items.map(i => (i.id === item.id ? item : i)) : [...S.items, item];
  S.view = { ...S.view, id: item.id, edit: false, newType: null };
  await saveVault();
  renderMain();
  toast('Salvato');
}

function renderAudit() {
  const logins = live().filter(i => i.f.password);
  const weak = logins.filter(i => strength(i.f.password).lvl <= 1);
  const counts = new Map();
  logins.forEach(i => counts.set(i.f.password, (counts.get(i.f.password) || 0) + 1));
  const reused = logins.filter(i => counts.get(i.f.password) > 1);
  const old = logins.filter(i => now() - (i.pwChanged || i.created) > 365 * 864e5);
  const no2fa = live().filter(i => i.type === 'login' && i.f.password && !i.f.totp);
  const bad = new Set([...weak, ...reused, ...old].map(i => i.id));
  const score = logins.length ? Math.round(100 * (1 - bad.size / logins.length)) : 100;
  const block = (title, list, desc, tone) => `<div class="card"><h3>${title} <span class="badge ${list.length ? tone : 'l4'}">${list.length}</span></h3>
    <p class="hint">${desc}</p>${list.map(i => `<button class="row" data-act="open-in" data-id="${i.id}">${letterIcon(i)}<span class="rtext"><b>${esc(i.title)}</b><small>${esc(subtitle(i))}</small></span></button>`).join('')}</div>`;
  return `<div class="pagewrap"><h1>Controllo sicurezza</h1>
    <div class="card score"><div class="big-num" data-lvl="${score >= 90 ? 4 : score >= 70 ? 3 : score >= 50 ? 2 : 1}">${score}</div>
      <div><b>Punteggio del vault</b><p class="hint">${logins.length} password analizzate, ${bad.size} da sistemare.</p></div></div>
    ${block('Password deboli', weak, 'Troppo corte o prevedibili: sostituiscile con una generata.', 'l1')}
    ${block('Password riutilizzate', reused, 'Se un sito viene violato, gli altri account con la stessa password sono a rischio.', 'l1')}
    ${block('Password vecchie', old, 'Non cambiate da più di un anno.', 'l2')}
    ${block('Login senza 2FA', no2fa, 'Dove il sito lo consente, attiva la verifica in due passaggi (o una passkey) e salvala qui.', 'l2')}
  </div>`;
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
      <p class="hint">Apri Impostazioni › Generali › Compilazione automatica e password e attiva Scrigno. Da quel momento Scrigno propone password e passkey in Safari e nelle app, e salva le nuove passkey.</p>
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
    ${autofillCard()}
    <div class="card stack"><h3>Sblocco biometrico</h3>
      ${S.bio ? '<p>Attivo su questo dispositivo.</p><button class="btn left" data-act="bio-off">Disattiva</button>'
        : S.bioAvail ? '<p class="hint">Usa impronta o volto per sbloccare su questo dispositivo, anche durante la compilazione automatica. Sugli altri dispositivi resta necessaria la master password.</p><button class="btn primary left" data-act="bio-on">Attiva</button>'
        : '<p class="hint">Non disponibile su questo dispositivo.</p>'}
    </div>
    <div class="card stack"><h3>Blocco e appunti</h3>
      <label class="lbl">Blocca automaticamente dopo<select data-setting="autoLockMin">${opt([1, 5, 15, 30, 60, 0], st.autoLockMin, v => v ? v + ' min di inattività' : 'Mai')}</select></label>
      <label class="lbl">Svuota gli appunti dopo<select data-setting="clipClearSec">${opt([15, 30, 60, 0], st.clipClearSec, v => v ? v + ' secondi' : 'Mai')}</select></label>
    </div>
    <form class="card stack" id="pwForm"><h3>Master password</h3>
      <label class="lbl">Password attuale<input type="password" name="cur" autocomplete="current-password" required></label>
      <label class="lbl">Nuova password<input type="password" name="nw" autocomplete="new-password" required minlength="10">${meterHTML()}</label>
      <label class="lbl">Ripeti la nuova password<input type="password" name="nw2" autocomplete="new-password" required></label>
      <button class="btn primary left" type="submit">Cambia password</button>
    </form>
    <div class="card stack"><h3>Backup e importazione</h3>
      <div class="row-btns"><button class="btn" data-act="export">Esporta backup cifrato</button>
        <button class="btn" data-act="pick" data-kind="backup">Importa backup Scrigno</button></div>
      <div class="row-btns"><button class="btn" data-act="pick" data-kind="enpass">Importa da Enpass (.json)</button>
        <button class="btn" data-act="pick" data-kind="csv">Importa CSV</button></div>
      <p class="hint">In Enpass: Impostazioni › Esporta › formato .json. Il CSV può venire da Chrome, Bitwarden o simili. Dopo l'importazione elimina il file esportato, perché non è cifrato.</p>
    </div>
    <div class="card stack"><h3>Zona pericolosa</h3>
      <button class="btn danger left" data-act="wipe">Rimuovi il vault da questo dispositivo</button>
    </div>
  </div>`;
}

async function tickTotp() {
  for (const el of $$('[data-totp]')) {
    const it = S.items.find(i => i.id === el.dataset.totp);
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

async function downloadFile(name, text) {
  if (Native.available) { if (await Native.call('saveFile', { name, text })) toast('File salvato'); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
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

// ---------------------------------------------------------------- Auto-Type (app desktop)
function autotypeCandidates(title) {
  const t = String(title || '').toLowerCase();
  const logins = live().filter(i => i.type === 'login' && (i.f.username || i.f.password));
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
    const it = S.items.find(i => i.id === b.dataset.at);
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
  S.view = { section: 'all', id: null, edit: false, q: '', newType: null };
  if (S.pendingSync) { await saveSyncCfg(S.pendingSync); S.pendingSync = null; } else S.sync = await loadSyncCfg();
  S.syncState = 'idle';
  await shareSession();
  if (await mergeFromDisk()) await persist();
  pushIdentities();
  renderMain();
  if (S.sync) syncNow(true);
}

async function wipe() {
  if (!confirm('Rimuovere il vault da questo dispositivo? Se non hai un backup o una copia nel cloud, i dati andranno persi.')) return;
  await store.del('vault'); await store.del('sync');
  await bioReset();
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
    items = (await vaultRead(f, dek)).filter(i => !i.deleted).map(i => ({ ...i, id: uuid(), updated: now() }));
  }
  if (!items.length) return toast('Nessun elemento trovato nel file');
  S.items.push(...items);
  await saveVault();
  renderMain();
  toast(`Importati ${items.length} elementi`);
}

// ---------------------------------------------------------------- eventi
const guard = fn => async e => {
  try { await fn(e); } catch (err) { console.error(err); toast((err && err.message) || String(err), 4500); }
};

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const cur = () => S.items.find(i => i.id === S.view.id);
  switch (act) {
    case 'section': S.view = { section: b.dataset.k, id: null, edit: false, q: S.view.q, newType: null }; renderMain(); break;
    case 'open': S.view.id = b.dataset.id; S.view.edit = false; renderMain(); break;
    case 'open-in': S.view = { section: 'all', id: b.dataset.id, edit: false, q: '', newType: null }; renderMain(); break;
    case 'open-url': if (Native.available) { e.preventDefault(); Native.call('openUrl', { url: b.href }).catch(() => {}); } break;
    case 'back': S.view.id = null; renderMain(); break;
    case 'new': S.view.edit = true; S.view.id = null; S.view.newType = TYPES[S.view.section] && S.view.section !== 'passkey' ? S.view.section : null; renderMain(); break;
    case 'newtype': S.view.newType = b.dataset.k; renderMain(); break;
    case 'edit': S.view.edit = true; renderMain(); break;
    case 'cancel': S.view.edit = false; S.view.newType = null; renderMain(); break;
    case 'fav': { const x = cur(); x.fav = !x.fav; x.updated = now(); await saveVault(); renderMain(); break; }
    case 'delete': {
      const x = cur();
      if (!confirm(`Eliminare “${x.title}”?`)) return;
      S.items = S.items.map(i => (i.id === x.id ? { id: x.id, deleted: true, updated: now() } : i));
      S.view.id = null;
      await saveVault(); renderMain(); toast('Eliminato');
      break;
    }
    case 'copy': await copy(getVal(cur(), b.dataset.k)); break;
    case 'reveal': {
      const span = b.parentElement.querySelector('.val');
      if (span.dataset.shown) { span.textContent = '••••••••'; delete span.dataset.shown; } else { span.textContent = getVal(cur(), b.dataset.k); span.dataset.shown = '1'; }
      break;
    }
    case 'copy-totp': { const x = S.items.find(i => i.id === b.dataset.id); await copy(await totp(parseTotp(x.f.totp)), 'Codice copiato'); break; }
    case 'toggle-input': { const inp = b.parentElement.querySelector('input'); inp.type = inp.type === 'password' ? 'text' : 'password'; break; }
    case 'gen-into': { const inp = b.parentElement.querySelector('input'); inp.value = genPassword(S.gen); inp.type = 'text'; updateMeter(inp); break; }
    case 'add-custom': $('#customList').insertAdjacentHTML('beforeend', customRow()); break;
    case 'del-custom': b.closest('.crow').remove(); break;
    case 'lock': lock(); break;
    case 'native': await Native.call(b.dataset.m); break;
    case 'sync':
      if (!S.sync) { S.view = { section: 'settings', id: null, edit: false, q: '', newType: null }; renderMain(); } else { await syncNow(false); if (S.view.section === 'settings') renderMain(); }
      break;
    case 'gen-new': S.genVal = genPassword(S.gen); updateGenOut(); break;
    case 'gen-copy': await copy(S.genVal); break;
    case 'bio-unlock': await bioUnlock(); break;
    case 'bio-on': await bioEnroll(); toast('Sblocco biometrico attivato'); renderMain(); break;
    case 'bio-off': await bioReset(); renderMain(); toast('Sblocco biometrico disattivato'); break;
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
    try { await openWithDEK(await vaultUnlock(S.file, $('#mp').value)); await afterUnlock(); } catch (err) {
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
  } else if (fm.id === 'pwForm') {
    if (fm.nw.value !== fm.nw2.value) throw new Error('Le due password non coincidono');
    if (strength(fm.nw.value).lvl < 2) throw new Error('Nuova password troppo debole');
    await vaultChangePassword(S.file, S.dek, fm.cur.value, fm.nw.value);
    await saveVault();
    fm.reset();
    toast('Master password cambiata');
  }
}

function onInput(e) {
  const t = e.target;
  if (t.id === 'q') { S.view.q = t.value; $('#items').innerHTML = renderList(); return; }
  if (t.name === 'f_password' || t.name === 'pw' || t.name === 'nw') { updateMeter(t); return; }
  if (t.dataset.gen) {
    S.gen[t.dataset.gen] = t.type === 'checkbox' ? t.checked : +t.value;
    S.genVal = genPassword(S.gen);
    updateGenOut();
  }
}

async function onChange(e) {
  const t = e.target;
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
  if (await mergeFromDisk()) { await persist(); if (!S.view.edit) renderMain(); }
  scheduleSync(300);
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
