'use strict';
/*
 * Scrigno — estensione browser, processo in background.
 * Tiene il vault (cifrato in storage.local), la chiave di sessione (storage.session, solo in memoria),
 * risponde al popup, agli script delle pagine (compilazione, salvataggio) e alle richieste di passkey.
 */

const api = typeof browser !== 'undefined' ? browser : chrome;
const B = {
  file: null, dek: null, items: [], extra: [], sync: null, syncState: 'idle', syncErr: null,
  settings: { autoLockMin: 15 }, lastAct: now(), loaded: false,
  pendingSave: new Map(),   // tabId -> { host, url, username, password, existingId, ts }
  prompts: new Map(),       // id -> { kind, data, resolve, windowId }
};

// ---------------------------------------------------------------- archivio
const local = {
  get: async k => (await api.storage.local.get(k))[k],
  set: (k, v) => api.storage.local.set({ [k]: v }),
  del: k => api.storage.local.remove(k),
};
const session = api.storage.session;

async function ensureLoaded() {
  if (B.loaded) return;
  B.file = (await local.get('vault')) || null;
  B.settings = { ...B.settings, ...((await local.get('settings')) || {}) };
  const s = await session.get(['dek', 'lastAct']);
  if (s.dek && B.file) {
    try {
      B.dek = await importDEK(fromB64(s.dek));
      B.items = await vaultRead(B.file, B.dek);
      await loadExtras();
      B.lastAct = s.lastAct || now();
      B.sync = await loadSync();
    } catch { B.dek = null; B.items = []; await session.remove('dek'); }
  }
  B.loaded = true;
}
// Elementi attivi di tutti i vault (principale + aggiuntivi), senza cestino ed elementi interni.
const live = () => [...B.items.filter(isActive), ...B.extra.flatMap(v => v.items.filter(isActive))];
function ownerOf(id) {
  if (B.items.some(i => i.id === id)) return { arr: B.items, vault: null };
  const v = B.extra.find(x => x.items.some(i => i.id === id));
  return v ? { arr: v.items, vault: v } : { arr: B.items, vault: null };
}
async function loadExtras() {
  const next = [];
  for (const k of vaultKeyItems(B.items)) {
    const have = B.extra.find(v => v.keyId === k.id);
    if (have) {
      have.name = k.title;
      const kc = vaultCloudCfg(k);
      if (stableCfg(kc) !== stableCfg(have.cfg)) have.cfg = kc;
      next.push(have); continue;
    }
    try { next.push(await openExtraVault(local, k)); } catch { /* vault non leggibile */ }
  }
  B.extra = next;
}
const touch = () => { B.lastAct = now(); session.set({ lastAct: B.lastAct }); };

async function setUnlocked(dek) {
  B.dek = dek;
  B.items = await vaultRead(B.file, dek);
  B.extra = [];
  await loadExtras();
  await session.set({ dek: await exportDEK(dek), lastAct: now() });
  B.sync = await loadSync();
  const { pendingSync } = await session.get('pendingSync');
  if (pendingSync) { await saveSync(pendingSync); await session.remove('pendingSync'); }
  touch();
  updateBadge();
  if (B.sync) syncNow();
}
async function lock() {
  B.dek = null; B.items = []; B.extra = []; B.sync = null;
  await session.remove(['dek', 'lastAct']);
  updateBadge();
}
async function persist() {
  const disk = await local.get('vault');
  if (disk && disk.vaultId === B.file.vaultId && disk.updatedAt !== B.file.updatedAt) {
    try { B.items = (await vaultMerge(B.file, B.dek, B.items, disk)).items; } catch { /* ignora */ }
  }
  await vaultWrite(B.file, B.dek, B.items);
  await local.set('vault', B.file);
  scheduleSync();
}
async function loadSync() {
  const box = await local.get('sync');
  if (!box || !B.dek) return null;
  try { return await decryptJSON(B.dek, box); } catch { return null; }
}
async function saveSync(cfg) {
  B.sync = cfg;
  if (cfg) await local.set('sync', await encryptJSON(B.dek, cfg)); else await local.del('sync');
}

function updateBadge() {
  api.action.setBadgeText({ text: B.dek ? '' : '•' }).catch(() => {});
  api.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(() => {});
}

// ---------------------------------------------------------------- cloud
// Senza l'API identity (es. Opera) il login si apre in una scheda e si legge l'indirizzo di ritorno
// sulla pagina oauth.html della web app.
const HAS_IDENTITY = !!(api.identity && api.identity.launchWebAuthFlow && api.identity.getRedirectURL);
const PAGES_URL = (self.SCRIGNO_CONFIG && self.SCRIGNO_CONFIG.pagesUrl) || '';
function tabAuth(url, redirect) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    const keep = setInterval(() => api.runtime.getPlatformInfo().catch(() => {}), 20000);
    const done = fn => { clearInterval(keep); api.tabs.onUpdated.removeListener(upd); api.tabs.onRemoved.removeListener(rem); fn(); };
    const upd = (id, info) => {
      if (id !== tabId || !info.url || !info.url.startsWith(redirect)) return;
      done(() => { api.tabs.remove(id).catch(() => {}); resolve(info.url); });
    };
    const rem = id => { if (id === tabId) done(() => reject(new Error('Accesso annullato.'))); };
    api.tabs.onUpdated.addListener(upd);
    api.tabs.onRemoved.addListener(rem);
    api.tabs.create({ url }).then(t => { tabId = t.id; }, e => done(() => reject(e)));
  });
}
Cloud.env = {
  fetch: (u, o) => fetch(u, o),
  redirect: () => HAS_IDENTITY ? api.identity.getRedirectURL('oauth') : PAGES_URL + 'oauth.html',
  folder: false,
  begin: () => null,
  async authorize(h, url, state) {
    if (!HAS_IDENTITY && !PAGES_URL) throw new Error('Questo browser non supporta l\'accesso ai cloud dall\'estensione.');
    const back = HAS_IDENTITY ? await api.identity.launchWebAuthFlow({ url, interactive: true }) : await tabAuth(url, PAGES_URL + 'oauth.html');
    const u = new URL(back);
    const p = Object.fromEntries(new URLSearchParams(u.search));
    Object.assign(p, Object.fromEntries(new URLSearchParams(u.hash.slice(1))));
    if (p.state !== state) throw new Error('Risposta di accesso non valida.');
    if (p.error) throw new Error('Accesso negato: ' + (p.error_description || p.error));
    return p;
  },
};

let syncTimer = null, syncing = false;
function scheduleSync(ms = 1500) {
  if (!B.sync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), ms);
}
async function syncNow() {
  if (!B.dek || syncing) return;
  if (!B.sync && !B.extra.some(v => v.cfg)) return;
  syncing = true;
  B.syncState = 'busy';
  const errors = [];
  try {
    if (B.sync) {
      try {
        const r = await cloudSync({ file: B.file, dek: B.dek, items: B.items, cfg: B.sync });
        B.items = r.items;
        if (r.changedLocal || r.uploaded) await local.set('vault', B.file);
        B.sync.lastSync = now();
        await saveSync(B.sync);
      } catch (e) { errors.push(e.message); }
    }
    await loadExtras();
    let keysChanged = false;
    for (const v of B.extra) {
      if (!v.cfg) continue;
      const key = B.items.find(i => i.id === v.keyId);
      const before = key ? stableCfg(vaultCloudCfg(key)) : '';
      try { await syncExtraVault(local, v); } catch (e) { errors.push(v.name + ': ' + e.message); }
      if (key && stableCfg(v.cfg) !== before) { key.f.cloud = JSON.stringify(v.cfg); key.updated = now(); keysChanged = true; }
    }
    if (keysChanged) await persist();
    B.syncErr = errors[0] || null;
    B.syncState = errors.length ? 'err' : 'ok';
  } finally { syncing = false; }
}

// ---------------------------------------------------------------- utilità per le pagine
const senderOrigin = s => s.origin || (s.url ? new URL(s.url).origin : '');
const senderHost = s => { try { return new URL(senderOrigin(s)).hostname; } catch { return ''; } };

function loginsFor(host) {
  return matchLogins(live(), { host }).map(i => ({ id: i.id, title: i.title, username: i.f.username || '', hasTotp: !!i.f.totp }));
}
function passkeysFor(rpId) {
  return live().filter(i => i.type === 'passkey' && i.f.rpId === rpId && i.f.privateKey);
}

async function offerSave(tabId, host, url, username, password) {
  if (!password) return null;
  let existingId = null;
  if (B.dek) {
    const same = matchLogins(live(), { host }).filter(i => (i.f.username || '') === (username || ''));
    if (same.some(i => i.f.password === password)) return null;
    if (same[0]) existingId = same[0].id;
  }
  const never = (await local.get('neverSave')) || [];
  if (never.includes(baseDomain(host))) return null;
  const p = { host, url, username, password, existingId, ts: now() };
  B.pendingSave.set(tabId, p);
  return { host, username, update: !!existingId };
}

async function doSave(p) {
  if (p.existingId) {
    const own = ownerOf(p.existingId);
    const it = own.arr.find(i => i.id === p.existingId);
    if (it) {
      if (it.f.password && it.f.password !== p.password) {
        it.history = [{ password: it.f.password, until: now() }, ...(it.history || [])].slice(0, 15);
      }
      it.f.password = p.password; it.updated = now(); it.pwChanged = now();
    }
    if (own.vault) { await saveExtraVault(local, own.vault); scheduleSync(); return; }
  } else {
    B.items.push(makeItem('login', baseDomain(p.host), { username: p.username, password: p.password, url: new URL(p.url).origin }));
  }
  await persist();
}

// ---------------------------------------------------------------- finestre di conferma
function openPrompt(kind, data) {
  return new Promise(async resolve => {
    const id = uuid();
    B.prompts.set(id, { kind, data, resolve });
    const w = await api.windows.create({ url: api.runtime.getURL(`prompt.html#${id}`), type: 'popup', width: 420, height: kind === 'unlock' ? 420 : 560, focused: true });
    const p = B.prompts.get(id);
    if (p) p.windowId = w.id;
  });
}
api.windows.onRemoved.addListener(wid => {
  for (const [id, p] of B.prompts) if (p.windowId === wid) { B.prompts.delete(id); p.resolve({ cancel: true }); }
});
function answerPrompt(id, answer) {
  const p = B.prompts.get(id);
  if (!p) return;
  B.prompts.delete(id);
  p.resolve(answer);
  if (p.windowId != null) api.windows.remove(p.windowId).catch(() => {});
}
async function ensureUnlocked(reason) {
  if (B.dek) return true;
  if (!B.file) { api.runtime.openOptionsPage(); return false; }
  const a = await openPrompt('unlock', { reason });
  return !a.cancel && !!B.dek;
}

// ---------------------------------------------------------------- passkey
let passkeyBusy = new Set();
async function handlePasskey(msg, sender) {
  const origin = senderOrigin(sender);
  const host = senderHost(sender);
  const tabKey = sender.tab ? sender.tab.id : 0;
  if (!/^https:/.test(origin) && host !== 'localhost') return { fallback: true };
  if (sender.frameId && sender.tab && sender.tab.url && new URL(sender.tab.url).origin !== origin) return { fallback: true };
  const o = msg.options;
  const rpId = (msg.kind === 'create' ? o.rp && o.rp.id : o.rpId) || host;
  if (!rpIdAllowed(rpId, host)) return { error: 'SecurityError', message: 'rpId non valido per questa origine' };

  if (msg.kind === 'create') {
    if (!(o.pubKeyCredParams || []).some(p => p.alg === -7)) return { fallback: true };
    if (passkeyBusy.has(tabKey)) return { fallback: true };
    passkeyBusy.add(tabKey);
    try {
      const a = await openPrompt('passkey-create', { rpId, rpName: (o.rp && o.rp.name) || rpId, user: o.user.name || o.user.displayName || '', locked: !B.dek });
      if (a.cancel || !a.useScrigno || !B.dek) return a.useBrowser ? { fallback: true } : { error: 'NotAllowedError', message: 'Operazione annullata' };
      const exclude = new Set((o.excludeCredentials || []).map(c => c.id));
      if (passkeysFor(rpId).some(i => exclude.has(i.f.credentialId))) return { error: 'InvalidStateError', message: 'Passkey già presente' };
      const cdj = clientDataJSON('webauthn.create', o.challenge, origin);
      const pk = await passkeyCreate({ rpId, userId: o.user.id, userName: o.user.name || o.user.displayName || '' });
      B.items.push(makeItem('passkey', a.title || (o.rp && o.rp.name) || rpId, pk.fields));
      await persist();
      return { credential: {
        kind: 'create', id: b64u.to(pk.credentialId), clientDataJSON: b64u.to(cdj), attestationObject: b64u.to(pk.attestationObject),
        authenticatorData: b64u.to(pk.authenticatorData), publicKey: b64u.to(pk.publicKey), publicKeyAlgorithm: -7, transports: ['internal', 'hybrid'],
      } };
    } finally { passkeyBusy.delete(tabKey); }
  }

  // asserzione
  const allow = new Set((o.allowCredentials || []).map(c => c.id));
  const pick = list => list.filter(i => !allow.size || allow.has(i.f.credentialId));
  if (msg.conditional) {
    if (!B.dek) return { fallback: true };
    if (!msg.chosenId) return { candidates: pick(passkeysFor(rpId)).map(i => ({ id: i.id, title: i.title, username: i.f.username })) };
  } else {
    if (B.dek && !pick(passkeysFor(rpId)).length) return { fallback: true };
    if (passkeyBusy.has(tabKey)) return { fallback: true };
  }
  let chosen = msg.chosenId ? live().find(i => i.id === msg.chosenId) : null;
  if (!chosen) {
    passkeyBusy.add(tabKey);
    try {
      const a = await openPrompt('passkey-get', { rpId, locked: !B.dek, allow: [...allow] });
      if (a.useBrowser) return { fallback: true };
      if (a.cancel || !a.id || !B.dek) return { error: 'NotAllowedError', message: 'Operazione annullata' };
      chosen = live().find(i => i.id === a.id);
    } finally { passkeyBusy.delete(tabKey); }
  }
  if (!chosen || chosen.f.rpId !== rpId) return { error: 'NotAllowedError', message: 'Passkey non trovata' };
  const cdj = clientDataJSON('webauthn.get', o.challenge, origin);
  const r = await passkeyAssert({ privateKey: chosen.f.privateKey, rpId, clientDataHash: await sha256(cdj) });
  touch();
  return { credential: {
    kind: 'get', id: chosen.f.credentialId, clientDataJSON: b64u.to(cdj), authenticatorData: b64u.to(r.authenticatorData),
    signature: b64u.to(r.signature), userHandle: chosen.f.userHandle || null,
  } };
}

// ---------------------------------------------------------------- messaggi
const handlers = {
  // --- popup e pagine dell'estensione
  async state() {
    const kfOn = !!(B.file && B.file.kdf && B.file.kdf.keyfile);
    return { hasVault: !!B.file, unlocked: !!B.dek, keyfile: kfOn, kfRemembered: kfOn && !!(await local.get('kf-' + B.file.vaultId)), vaults: B.extra.length + 1, sync: B.sync ? { provider: B.sync.provider, name: PROVIDERS[B.sync.provider].name, lastSync: B.sync.lastSync } : null,
      syncState: B.syncState, syncErr: B.syncErr, settings: B.settings, providers: providerList().map(k => [k, PROVIDERS[k].name]), redirect: Cloud.env.redirect() };
  },
  async unlock({ password, kf, remember }) {
    const needKf = !!(B.file && B.file.kdf && B.file.kdf.keyfile);
    const key = 'kf-' + (B.file && B.file.vaultId);
    const useKf = needKf ? (kf || (await local.get(key)) || null) : null;
    await setUnlocked(await vaultUnlock(B.file, password, useKf));
    if (needKf && kf && remember) await local.set(key, kf);
    return true;
  },
  async forgetKeyfile() { await local.del('kf-' + (B.file && B.file.vaultId)); return true; },
  async lock() { await lock(); return true; },
  async create({ password }) {
    const v = await vaultCreate(password);
    B.file = v.file;
    await local.set('vault', B.file);
    await local.del('sync');
    await setUnlocked(v.dek);
    return true;
  },
  async connect({ cfg, mode }) {
    const c = await connectCloud(cfg);
    const remote = await PROVIDERS[c.provider].download(c);
    if (mode === 'download') {
      if (!remote) throw new Error('Nel cloud non c\'è ancora un vault Scrigno.');
      B.file = remote;
      await local.set('vault', remote);
      await lock();
      await session.set({ pendingSync: c });
      return true;
    }
    if (remote && remote.vaultId !== B.file.vaultId) throw new Error('Nel cloud c\'è un vault diverso. Usa “Rimuovi vault” e poi “Scarica dal cloud”.');
    await saveSync(c);
    await syncNow();
    return true;
  },
  async disconnect() { await saveSync(null); return true; },
  async syncNow() { await syncNow(); if (B.syncErr) throw new Error(B.syncErr); return true; },
  async items({ url }) {
    if (!B.dek) throw new Error('Bloccato');
    touch();
    const host = url ? hostOf(url) : '';
    const match = new Set(host ? matchLogins(live(), { host }).map(i => i.id) : []);
    return live().map(i => ({ id: i.id, type: i.type, title: i.title, sub: i.f.username || i.f.rpId || hostOf(i.f.url || '') || '', url: i.f.url || '',
      hasPw: !!i.f.password, hasTotp: !!i.f.totp, match: match.has(i.id) }));
  },
  async secret({ id, field }) {
    if (!B.dek) throw new Error('Bloccato');
    touch();
    const it = live().find(i => i.id === id);
    if (!it) throw new Error('Elemento non trovato');
    if (field === 'totp') return totp(parseTotp(it.f.totp));
    return it.f[field] || '';
  },
  async fillTab({ id, tabId }) {
    const it = live().find(i => i.id === id);
    const tab = await api.tabs.get(tabId);
    if (!matchLogins([it], { host: hostOf(tab.url) }).length) throw new Error('Questo login non è per il sito aperto.');
    await api.tabs.sendMessage(tabId, { type: 'doFill', username: it.f.username || '', password: it.f.password || '' }, { frameId: 0 });
    touch();
    return true;
  },
  async generate() { return genPassword(await local.get('gen')); },
  async genState() {
    const o = genOpts(await local.get('gen'));
    return { opts: o, seps: GEN_SEPS, bits: bitsLevel(genBits(o)), history: B.dek ? genHistory(B.items).slice(0, 10) : [] };
  },
  async genSet({ opts }) { await local.set('gen', genOpts({ ...genOpts(await local.get('gen')), ...opts })); return true; },
  async genUsed({ pw, site }) {
    if (!B.dek || !pw) return false;
    genHistoryAdd(B.items, pw, site || '');
    await persist();
    return true;
  },
  async settings({ settings }) { B.settings = { ...B.settings, ...settings }; await local.set('settings', B.settings); return true; },
  async wipe() { await lock(); await local.del('vault'); await local.del('sync'); B.file = null; return true; },
  async importFile({ text, kind, password }) {
    if (kind === 'backup') {
      const f = JSON.parse(text);
      if (!B.file) {
        const dek = await vaultUnlock(f, password);
        B.file = f;
        await local.set('vault', f);
        await setUnlocked(dek);
        return 'Backup caricato';
      }
      throw new Error('C\'è già un vault: rimuovilo prima di caricare un backup.');
    }
    if (!B.dek) throw new Error('Bloccato');
    const items = kind === 'enpass' ? importEnpass(JSON.parse(text)) : importCSV(text);
    B.items.push(...items);
    await persist();
    return `Importati ${items.length} elementi`;
  },
  async promptData({ id }) { const p = B.prompts.get(id); if (!p) throw new Error('Richiesta scaduta'); return { kind: p.kind, data: p.data, hasVault: !!B.file }; },
  async promptAnswer({ id, answer }) { answerPrompt(id, answer); return true; },
  async promptPasskeys({ rpId, allow }) {
    if (!B.dek) throw new Error('Bloccato');
    const set = new Set(allow || []);
    return passkeysFor(rpId).filter(i => !set.size || set.has(i.f.credentialId)).map(i => ({ id: i.id, title: i.title, username: i.f.username }));
  },
  async savePending({ tabId, title }) {
    const p = B.pendingSave.get(tabId);
    if (!p) throw new Error('Nessun login da salvare');
    if (title) p.title = title;
    await doSave(p);
    B.pendingSave.delete(tabId);
    return true;
  },

  // --- script delle pagine (il mittente è verificato dal browser)
  async pageMatches(_, s) {
    const host = senderHost(s);
    if (!B.file) return { state: 'none' };
    if (!B.dek) return { state: 'locked' };
    touch();
    return { state: 'ok', logins: loginsFor(host) };
  },
  async pageFill({ id, totpOnly }, s) {
    if (!B.dek) throw new Error('Bloccato');
    const it = live().find(i => i.id === id);
    if (!it || !matchLogins([it], { host: senderHost(s) }).length) throw new Error('Login non valido per questo sito');
    touch();
    const code = it.f.totp ? await totp(parseTotp(it.f.totp)).catch(() => '') : '';
    return totpOnly ? { totp: code } : { username: it.f.username || '', password: it.f.password || '', totp: code };
  },
  async pageUnlock(_, s) { return ensureUnlocked('Sblocca per compilare su ' + senderHost(s)); },
  async pageSubmitted({ username, password }, s) {
    if (!s.tab) return null;
    return offerSave(s.tab.id, senderHost(s), senderOrigin(s), username, password);
  },
  async pagePendingSave(_, s) {
    const p = s.tab && B.pendingSave.get(s.tab.id);
    if (!p || now() - p.ts > 5 * 60000) return null;
    return { host: p.host, username: p.username, update: !!p.existingId };
  },
  async pageSaveDecision({ decision }, s) {
    const p = s.tab && B.pendingSave.get(s.tab.id);
    if (!p) return false;
    B.pendingSave.delete(s.tab.id);
    if (decision === 'never') {
      const never = (await local.get('neverSave')) || [];
      never.push(baseDomain(p.host));
      await local.set('neverSave', never);
      return true;
    }
    if (decision !== 'save') return true;
    if (!(await ensureUnlocked('Sblocca per salvare il login'))) return false;
    if (!p.existingId) {
      const same = matchLogins(live(), { host: p.host }).find(i => (i.f.username || '') === (p.username || ''));
      if (same) p.existingId = same.id;
    }
    await doSave(p);
    return true;
  },
  async pageGenerate(msg, sender) {
    const pw = genPassword(await local.get('gen'));
    if (B.dek) { genHistoryAdd(B.items, pw, baseDomain(hostOf(sender.url || ''))); persist().catch(() => {}); }
    return pw;
  },
  async passkey(msg, s) { await ensureLoaded(); return handlePasskey(msg, s); },
};

api.runtime.onMessage.addListener((msg, sender, send) => {
  const h = msg && handlers[msg.type];
  if (!h) return false;
  if (sender.id !== api.runtime.id) return false;
  // I messaggi dalle pagine web non possono usare le funzioni riservate a popup e opzioni.
  const fromPage = sender.tab && sender.url && !sender.url.startsWith(api.runtime.getURL(''));
  if (fromPage && !/^page|^passkey$/.test(msg.type)) { send({ ok: false, error: 'Non consentito' }); return false; }
  ensureLoaded().then(() => h(msg, sender)).then(r => send({ ok: true, r }), e => send({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

// ---------------------------------------------------------------- blocco automatico, sync periodica, scorciatoia
api.alarms.create('tick', { periodInMinutes: 1 });
api.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'tick') return;
  await ensureLoaded();
  if (B.dek && B.settings.autoLockMin > 0 && now() - B.lastAct > B.settings.autoLockMin * 60000) await lock();
  else if (B.dek && B.sync && (!B.sync.lastSync || now() - B.sync.lastSync > 15 * 60000)) syncNow();
});
api.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'fill-login') return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) api.tabs.sendMessage(tab.id, { type: 'openMenu' }, { frameId: 0 }).catch(() => {});
});
api.tabs.onRemoved.addListener(id => B.pendingSave.delete(id));
api.runtime.onInstalled.addListener(d => { if (d.reason === 'install') api.runtime.openOptionsPage(); });
ensureLoaded().then(updateBadge);
