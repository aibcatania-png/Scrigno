'use strict';
/* Popup dell'estensione e pagina completa (opzioni). */
const api = typeof browser !== 'undefined' ? browser : chrome;
const FULL = location.search.includes('full') || document.body.dataset.full === '1';
document.body.classList.add(FULL ? 'full' : 'popup');

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGO = '<svg viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="8" fill="#1f78cc"/><path d="M11 14.5v-3a5 5 0 0 1 10 0v3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><rect x="8.5" y="14.5" width="15" height="10.5" rx="2.5" fill="#fff"/><circle cx="16" cy="19" r="1.8" fill="#1f78cc"/></svg>';

async function send(msg) {
  const r = await api.runtime.sendMessage(msg);
  if (!r) throw new Error('Nessuna risposta');
  if (!r.ok) throw new Error(r.error);
  return r.r;
}
function toast(m, ms = 2200) {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) % 360; return h; }


async function kfHashOf() {
  const inp = document.getElementById('kfFile');
  const f = inp && inp.files[0];
  if (!f) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()));
  let s = '';
  d.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}
const unlockMsg = async () => ({ type: 'unlock', password: document.getElementById('mp').value, kf: await kfHashOf(), remember: !!(document.getElementById('kfRem') || {}).checked });

let ST = null, tab = null, items = [], view = 'list', q = '', setupMode = 'create';

async function refresh() {
  ST = await send({ type: 'state' });
  if (!tab) { try { [tab] = await api.tabs.query({ active: true, currentWindow: true }); } catch { tab = null; } }
  if (ST.unlocked) items = await send({ type: 'items', url: tab && /^https?:/.test(tab.url || '') ? tab.url : '' });
  render();
}

function header() {
  const s = ST.sync ? `<span class="pill ${ST.syncState}" title="${esc(ST.syncErr || '')}">${ST.syncState === 'err' ? '⚠' : ST.syncState === 'busy' ? '⟳' : '☁'} ${esc(ST.sync.name)}</span>` : '';
  return `<div class="top"><div class="brand">${LOGO}Scrigno</div>${s}
    ${FULL ? '' : '<button class="icon" data-a="full" title="Apri a schermo intero">⤢</button>'}
    ${ST.unlocked ? '<button class="icon" data-a="lock" title="Blocca">🔒</button>' : ''}</div>`;
}

function providerFields(p) {
  if ((ST.builtIn || []).includes(p)) {
    return `<p class="hint">Pronto: premi <b>Connetti</b> e accedi con il tuo account.</p>
      <details><summary class="hint">Usa una mia app (avanzato)</summary>${customFields(p)}</details>`;
  }
  return customFields(p);
}
function customFields(p) {
  if (p === 'dropbox') return '<label class="lbl">App key Dropbox<input data-c="appKey" autocomplete="off"></label>';
  if (p === 'gdrive') return '<label class="lbl">Client ID Google<input data-c="clientId" autocomplete="off"></label><label class="lbl">Client secret Google<input data-c="clientSecret" autocomplete="off"></label>';
  if (p === 'onedrive') return '<label class="lbl">ID applicazione Microsoft<input data-c="clientId" autocomplete="off"></label>';
  return `<label class="lbl">Indirizzo del file WebDAV<input data-c="url" placeholder="https://…/scrigno-vault.json" autocomplete="off"></label>
    <label class="lbl">Utente<input data-c="user" autocomplete="off"></label><label class="lbl">Password per app<input data-c="pass" type="password" autocomplete="off"></label>`;
}
function cloudForm(act, label) {
  return `<div class="card" id="cloudForm"><label class="lbl">Servizio<select id="prov">${ST.providers.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select></label>
    <div id="pf">${providerFields(ST.providers[0][0])}</div>
    <p class="hint">Indirizzo di ritorno da registrare presso il servizio (Dropbox, Microsoft, Google): <code>${esc(ST.redirect)}</code></p>
    <button class="btn pri wide" data-a="${act}">${label}</button></div>`;
}
function readCloud() {
  const cfg = { provider: $('#prov').value };
  document.querySelectorAll('#cloudForm [data-c]').forEach(i => { cfg[i.dataset.c] = i.value.trim(); });
  return cfg;
}

function renderSetup() {
  const tabs = `<div class="tabs">${[['create', 'Nuovo'], ['cloud', 'Dal cloud'], ['backup', 'Da backup']].map(([k, l]) => `<button data-a="setup" data-k="${k}" class="${setupMode === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  let body;
  if (setupMode === 'create') {
    body = `<form class="card" id="createForm"><p class="hint">Se usi già Scrigno su telefono o computer, scegli “Dal cloud” per avere lo stesso vault.</p>
      <label class="lbl">Master password<input type="password" name="pw" required minlength="10" autocomplete="new-password"></label>
      <label class="lbl">Ripeti<input type="password" name="pw2" required autocomplete="new-password"></label>
      <button class="btn pri wide">Crea il vault</button></form>`;
  } else if (setupMode === 'cloud') {
    body = cloudForm('download', 'Scarica il vault');
  } else {
    body = `<div class="card"><p class="hint">Carica un backup Scrigno (.json) esportato dall'app.</p>
      <button class="btn pri wide" data-a="pick" data-k="backup">Scegli file…</button></div>`;
  }
  return `<div class="body"><h2>Benvenuto in Scrigno</h2>${tabs}${body}</div>`;
}
function renderLock() {
  return `<div class="body"><form class="card" id="unlockForm">
    <label class="lbl">Master password<input type="password" id="mp" required autocomplete="current-password" autofocus></label>
    ${ST.keyfile && !ST.kfRemembered ? `<label class="lbl">Keyfile<input type="file" id="kfFile"></label><label class="lbl" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="kfRem" style="width:auto"> Ricorda il keyfile in questo browser</label>` : ''}
    <p class="err" id="uerr" hidden></p><button class="btn pri wide">Sblocca</button></form>
    ${ST.kfRemembered ? '<button class="btn" data-a="forget-kf">Dimentica il keyfile in questo browser</button>' : ''}
    <button class="btn danger" data-a="wipe">Rimuovi il vault da questo browser</button></div>`;
}

const favHost = u => { try { const h = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) ? h : ''; } catch { return ''; } };
function itemRow(i) {
  const ch = (i.title || '?')[0].toUpperCase();
  const fh = ST.settings.favicons !== false && i.url && !/^androidapp:/.test(i.url) ? favHost(i.url) : '';
  return `<div class="item"><span class="ic" style="background:hsl(${hue(i.title)} 45% 42%)">${esc(ch)}${fh ? `<img class="favimg" src="https://icons.duckduckgo.com/ip3/${esc(fh)}.ico" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>
    <span class="t"><b>${esc(i.title)}</b><small>${esc(i.sub)}</small></span>
    <span class="acts">
      ${i.match && i.hasPw ? `<button class="fillbtn" data-a="fill" data-id="${i.id}">Compila</button>` : ''}
      ${i.type === 'login' && i.sub ? `<button class="icon" title="Copia utente" data-a="copy" data-f="username" data-id="${i.id}">👤</button>` : ''}
      ${i.hasPw ? `<button class="icon" title="Copia password" data-a="copy" data-f="password" data-id="${i.id}">🔑</button>` : ''}
      ${i.hasTotp ? `<button class="icon" title="Copia codice 2FA" data-a="copy" data-f="totp" data-id="${i.id}">⏱</button>` : ''}
    </span></div>`;
}
function renderList() {
  const ql = q.toLowerCase();
  const filt = items.filter(i => i.type !== 'passkey' || ql).filter(i => !ql || (i.title + ' ' + i.sub + ' ' + i.url).toLowerCase().includes(ql))
    .sort((a, b) => a.title.localeCompare(b.title, 'it'));
  const match = filt.filter(i => i.match);
  const rest = filt.filter(i => !i.match);
  return `${match.length ? `<div class="sect">Per questo sito</div><div class="list">${match.map(itemRow).join('')}</div>` : ''}
    ${rest.length ? `<div class="sect">${q ? 'Risultati' : 'Tutti'}</div><div class="list">${rest.slice(0, FULL ? 500 : 60).map(itemRow).join('')}</div>` : ''}
    ${!filt.length ? '<p class="empty">Nessun elemento.</p>' : ''}`;
}
function renderUnlocked() {
  const tabs = `<div class="tabs">${[['list', 'Vault'], ['gen', 'Generatore'], ['settings', 'Impostazioni']].map(([k, l]) => `<button data-a="view" data-k="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  let body = '';
  if (view === 'list') body = `<input id="q" type="search" placeholder="Cerca…" value="${esc(q)}" autocomplete="off"><div id="lst">${renderList()}</div>`;
  if (view === 'gen') body = '<div id="genBox"></div>';
  if (view === 'settings') {
    body = `<div class="card"><h2>Sincronizzazione</h2>
      ${ST.sync ? `<p>Collegato a <b>${esc(ST.sync.name)}</b>${ST.syncErr ? `<br><span class="err">${esc(ST.syncErr)}</span>` : ''}</p>
        <div class="row"><button class="btn pri" data-a="sync">Sincronizza ora</button><button class="btn" data-a="disconnect">Disconnetti</button></div>` : ''}</div>
      ${ST.sync ? '' : cloudForm('connect', 'Connetti')}
      <div class="card" id="afBox"><h2>Compilazione automatica</h2><p class="hint">Caricamento…</p></div>
      <div class="card"><h2>Aspetto</h2><label class="chk"><input type="checkbox" id="favOn" ${ST.settings.favicons !== false ? 'checked' : ''}> Icone dei siti web (da DuckDuckGo)</label></div>
      <div class="card"><h2>Blocco automatico</h2><select id="autolock">${[5, 15, 30, 60, 240, 0].map(v => `<option value="${v}" ${ST.settings.autoLockMin === v ? 'selected' : ''}>${v ? 'Dopo ' + v + ' min' : 'Mai'}</option>`).join('')}</select>
        <p class="hint">Il vault si blocca comunque alla chiusura del browser.</p></div>
      <div class="card"><h2>Importa</h2><div class="row"><button class="btn" data-a="pick" data-k="enpass">Da Enpass (.json)</button><button class="btn" data-a="pick" data-k="csv">Da CSV</button></div></div>
      <div class="card"><button class="btn danger" data-a="wipe">Rimuovi il vault da questo browser</button></div>`;
  }
  return `<div class="body">${tabs}${body}</div>`;
}

function render() {
  const main = !ST.hasVault ? renderSetup() : !ST.unlocked ? renderLock() : renderUnlocked();
  $('#app').innerHTML = header() + main;
  if ($('#mp')) $('#mp').focus();
  if ($('#q')) $('#q').focus();
  if ($('#genBox')) renderGen();
  if ($('#afBox')) renderAf();
}

const AF_LABELS = [['autoSubmit', 'Accedi automaticamente dopo la compilazione'], ['otpCopy', 'Copia e inserisci il codice 2FA'],
  ['fillSingle', 'Scorciatoia: compila subito se c\'è un solo login'], ['exactMatch', 'Corrispondenza esatta con l\'indirizzo del sito'],
  ['lockedSuggest', 'Suggerimenti anche quando è bloccato'], ['askSave', 'Chiedi se salvare i login nuovi']];
async function renderAf() {
  const p = await send({ type: 'afGet' });
  $('#afBox').innerHTML = `<h2>Compilazione automatica</h2>${AF_LABELS.map(([k, l]) => `<label class="chk"><input type="checkbox" data-af="${k}" ${p[k] ? 'checked' : ''}> ${l}</label>`).join('')}
    <div class="lbl">Siti ignorati</div>${p.ignore.length ? p.ignore.map(d => `<div class="hrow"><span>${esc(d)}</span><button class="btn sm" data-a="unignore" data-d="${esc(d)}">Rimuovi</button></div>`).join('') : '<p class="hint">Nessuno. Scegli “Mai per questo sito” quando Scrigno propone di salvare un login.</p>'}
    <p class="hint">Valgono anche per l'app e gli altri dispositivi.</p>`;
}

// ---------------------------------------------------------------- generatore (come nella app)
let GS = null, genVal = '';
const colorPw = pw => [...pw].map(c => /\d/.test(c) ? `<span class="cd">${esc(c)}</span>` : /[A-Za-z]/.test(c) ? esc(c) : `<span class="cs">${esc(c)}</span>`).join('');
const tog = (k, l, n) => `<div class="gopt"><label class="chk"><input type="checkbox" data-g="${k}" ${GS.opts[k] ? 'checked' : ''}> ${l}</label>${n
  ? `<span class="step"><button data-a="gstep" data-k="${n}" data-d="-1">−</button><b>${GS.opts[n]}</b><button data-a="gstep" data-k="${n}" data-d="1">+</button></span>` : ''}</div>`;
async function renderGen(keep) {
  GS = await send({ type: 'genState' });
  if (!keep || !genVal) genVal = await send({ type: 'generate' });
  const o = GS.opts, w = o.mode === 'words';
  $('#genBox').innerHTML = `<div class="seg"><button data-a="gmode" data-k="random" class="${w ? '' : 'on'}">Casuale</button><button data-a="gmode" data-k="words" class="${w ? 'on' : ''}">Pronunciabile</button></div>
    <div class="card"><div class="gen" id="genOut">${colorPw(genVal)}</div><div class="meter" data-lvl="${GS.bits.lvl}">${GS.bits.label} · ${GS.bits.bits} bit</div>
      <div class="row"><button class="btn pri" data-a="gen-copy">Copia</button><button class="btn" data-a="gen-new">Rigenera</button></div></div>
    <div class="card">${w ? `<label class="lbl"><span>Parole: <b>${o.words}</b></span><input type="range" min="2" max="12" value="${o.words}" data-g="words"></label>
      <label class="lbl">Separate da<select data-g="sep">${GS.seps.map(([v, l]) => `<option value="${esc(v)}" ${o.sep === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${tog('wordCaps', 'Iniziali maiuscole')}${tog('wordDigit', 'Una cifra')}
      <label class="lbl">Lingua<select data-g="lang"><option value="it" ${o.lang === 'it' ? 'selected' : ''}>Italiano</option><option value="en" ${o.lang === 'en' ? 'selected' : ''}>Inglese</option></select></label>`
    : `<label class="lbl"><span>Lunghezza: <b>${o.length}</b></span><input type="range" min="4" max="100" value="${o.length}" data-g="length"></label>
      ${tog('upper', 'Maiuscole', 'minUpper')}${tog('digits', 'Cifre', 'minDigits')}${tog('symbols', 'Simboli', 'minSymbols')}${tog('noAmbig', 'Evita caratteri ambigui')}
      <label class="lbl">Escludi caratteri<input data-g="exclude" value="${esc(o.exclude)}" autocomplete="off" spellcheck="false"></label>`}</div>
    ${GS.history.length ? `<div class="card"><h2>Cronologia</h2>${GS.history.map((e, i) => `<div class="hrow"><code>${colorPw(e.pw)}</code><button class="btn sm" data-a="ghist" data-i="${i}">Copia</button></div>`).join('')}</div>` : ''}`;
}
async function genSet(opts) { await send({ type: 'genSet', opts }); await renderGen(); }

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  toast('Copiato · gli appunti si svuotano tra 30s');
  setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000);
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  try {
    switch (b.dataset.a) {
      case 'full': api.runtime.openOptionsPage(); window.close(); break;
      case 'lock': await send({ type: 'lock' }); await refresh(); break;
      case 'forget-kf': await send({ type: 'forgetKeyfile' }); toast('Keyfile dimenticato'); await refresh(); break;
      case 'setup': setupMode = b.dataset.k; render(); break;
      case 'view': view = b.dataset.k; render(); break;
      case 'fill': await send({ type: 'fillTab', id: b.dataset.id, tabId: tab.id }); window.close(); break;
      case 'copy': await copyText(await send({ type: 'secret', id: b.dataset.id, field: b.dataset.f })); break;
      case 'gen-new': await renderGen(); break;
      case 'gen-copy': await copyText(genVal); await send({ type: 'genUsed', pw: genVal, site: tab && tab.url ? new URL(tab.url).hostname : '' }).catch(() => {}); await renderGen(true); break;
      case 'gmode': await genSet({ mode: b.dataset.k }); break;
      case 'gstep': await genSet({ [b.dataset.k]: Math.max(1, Math.min(20, GS.opts[b.dataset.k] + +b.dataset.d)) }); break;
      case 'ghist': await copyText(GS.history[+b.dataset.i].pw); break;
      case 'unignore': { const p = await send({ type: 'afGet' }); await send({ type: 'afSet', patch: { ignore: p.ignore.filter(d => d !== b.dataset.d) } }); await renderAf(); break; }
      case 'sync': b.disabled = true; await send({ type: 'syncNow' }); toast('Sincronizzato'); await refresh(); break;
      case 'disconnect': if (confirm('Scollegare il cloud?')) { await send({ type: 'disconnect' }); await refresh(); } break;
      case 'connect': b.disabled = true; b.textContent = 'Accesso…'; await send({ type: 'connect', cfg: readCloud(), mode: 'link' }); toast('Cloud collegato'); await refresh(); break;
      case 'download': b.disabled = true; b.textContent = 'Accesso…'; await send({ type: 'connect', cfg: readCloud(), mode: 'download' }); toast('Vault scaricato: inserisci la master password'); await refresh(); break;
      case 'wipe': if (confirm('Rimuovere il vault da questo browser? Gli altri dispositivi e il cloud non vengono toccati.')) { await send({ type: 'wipe' }); await refresh(); } break;
      case 'pick': {
        if (!FULL) { api.runtime.openOptionsPage(); window.close(); return; }
        const fi = $('#fileIn'); fi.dataset.k = b.dataset.k; fi.click(); break;
      }
    }
  } catch (err) { toast(err.message, 4000); await refresh().catch(() => {}); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    if (f.id === 'unlockForm') {
      try { await send(await unlockMsg()); } catch (err) { $('#uerr').textContent = err.message; $('#uerr').hidden = false; return; }
      await refresh();
    } else if (f.id === 'createForm') {
      if (f.pw.value !== f.pw2.value) throw new Error('Le password non coincidono');
      await send({ type: 'create', password: f.pw.value });
      await refresh();
    }
  } catch (err) { toast(err.message, 4000); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { q = e.target.value; $('#lst').innerHTML = renderList(); }
  if (e.target.dataset.g && e.target.type === 'range') e.target.previousElementSibling.querySelector('b').textContent = e.target.value;
});
document.addEventListener('change', async e => {
  const t = e.target;
  try {
    if (t.id === 'prov') $('#pf').innerHTML = providerFields(t.value);
    if (t.dataset.af) { await send({ type: 'afSet', patch: { [t.dataset.af]: t.checked } }); toast('Salvato'); }
    if (t.id === 'favOn') { await send({ type: 'settings', settings: { favicons: t.checked } }); ST.settings.favicons = t.checked; toast('Salvato'); }
    if (t.dataset.g) await genSet({ [t.dataset.g]: t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value });
    if (t.id === 'autolock') { await send({ type: 'settings', settings: { autoLockMin: +t.value } }); toast('Salvato'); }
    if (t.id === 'fileIn' && t.files[0]) {
      const text = await t.files[0].text();
      t.value = '';
      const kind = t.dataset.k;
      const password = kind === 'backup' ? prompt('Master password del backup') : null;
      if (kind === 'backup' && !password) return;
      toast(await send({ type: 'importFile', text, kind, password }));
      await refresh();
    }
  } catch (err) { toast(err.message, 4000); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'q') { const b = document.querySelector('.fillbtn'); if (b) b.click(); }
});
refresh().catch(e => { document.body.textContent = e.message; });

document.addEventListener('error', e => { if (e.target && e.target.classList && e.target.classList.contains('favimg')) e.target.remove(); }, true);
