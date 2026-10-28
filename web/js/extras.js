'use strict';
/*
 * Funzioni aggiuntive in stile Enpass:
 *  - generatore e cronologia del generatore dentro la modifica di un elemento;
 *  - condivisione di un elemento cifrato con una chiave (link o testo) e ricezione;
 *  - Assistente del computer: finestra compatta richiamata dalla scorciatoia, anche ancorata.
 * Usa le funzioni globali di app.js (caricato dopo questo file).
 */

// ================================================================ generatore nella modifica
function dlg(html, cls = 'dlg') {
  const d = document.createElement('dialog');
  d.className = cls;
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}
function siteOfForm() {
  const u = document.querySelector('[name=f_url]');
  return u && u.value ? baseDomain(hostOf(u.value)) : '';
}
function useGenerated(inp, pw) {
  inp.value = pw;
  inp.type = 'text';
  updateMeter(inp);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}

function genDialog(inp) {
  const g = genCfg();
  let pw = genPassword(g);
  const d = dlg('<div class="stack gendlg"></div>', 'dlg wide');
  const box = d.querySelector('.gendlg');
  const tog = (k, l, n) => `<div class="gen-opt"><label class="switch"><input type="checkbox" data-gd="${k}" ${g[k] ? 'checked' : ''}><span></span>${l}</label>${n
    ? `<span class="stepper ${g[k] ? '' : 'off'}"><button type="button" data-gstep="${n}" data-d="-1" aria-label="Meno">−</button><b>${g[n]}</b><button type="button" data-gstep="${n}" data-d="1" aria-label="Più">+</button></span>` : ''}</div>`;
  const draw = () => {
    const w = g.mode === 'words';
    const s = bitsLevel(genBits(g));
    box.innerHTML = `<div class="card-head"><h3>${ic('wand')} Generatore di password</h3><button type="button" class="icon" data-gx title="Chiudi">${ic('x')}</button></div>
      <div class="seg"><button type="button" data-gmode="random" class="${w ? '' : 'on'}">Casuale</button><button type="button" data-gmode="words" class="${w ? 'on' : ''}">Pronunciabile</button></div>
      <code class="genbig" id="gdOut">${colorPw(pw)}</code>
      <span class="meter" data-lvl="${s.lvl}">${s.label} · ${s.bits} bit · ${pw.length} caratteri</span>
      ${w ? `<label class="lbl"><span>Parole: <b>${g.words}</b></span><input type="range" min="2" max="12" value="${g.words}" data-gd="words"></label>
          <label class="lbl">Separate da<select data-gd="sep">${GEN_SEPS.map(([v, l]) => `<option value="${esc(v)}" ${g.sep === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${tog('wordCaps', 'Maiuscole (iniziali)')}${tog('wordDigit', 'Una cifra')}
          <label class="lbl">Lingua<select data-gd="lang"><option value="it" ${g.lang === 'it' ? 'selected' : ''}>Italiano</option><option value="en" ${g.lang === 'en' ? 'selected' : ''}>Inglese</option></select></label>`
        : `<label class="lbl"><span>Lunghezza: <b>${g.length}</b></span><input type="range" min="4" max="100" value="${g.length}" data-gd="length"></label>
          ${tog('upper', 'Maiuscole (A-Z)', 'minUpper')}${tog('digits', 'Cifre (0-9)', 'minDigits')}${tog('symbols', 'Simboli (!@#…)', 'minSymbols')}${tog('noAmbig', 'Evita caratteri ambigui')}`}
      <div class="row-btns end"><button type="button" class="btn" data-gnew>${ic('refresh')} Rigenera</button><button type="button" class="btn primary" data-guse>Usa questa password</button></div>`;
  };
  const regen = () => { saveGen(); pw = genPassword(g); draw(); };
  d.addEventListener('input', e => {
    const t = e.target;
    if (!t.dataset.gd || t.type !== 'range') return;
    g[t.dataset.gd] = +t.value;
    t.previousElementSibling.querySelector('b').textContent = t.value;
    saveGen(); pw = genPassword(g);
    $('#gdOut', d).innerHTML = colorPw(pw);
  });
  d.addEventListener('change', e => {
    const t = e.target;
    if (!t.dataset.gd) return;
    g[t.dataset.gd] = t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value;
    regen();
  });
  d.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.gx !== undefined) d.close();
    else if (t.dataset.gmode) { g.mode = t.dataset.gmode; regen(); }
    else if (t.dataset.gstep) { const k = t.dataset.gstep; g[k] = Math.max(1, Math.min(20, (+g[k] || 0) + +t.dataset.d)); regen(); }
    else if (t.dataset.gnew !== undefined) regen();
    else if (t.dataset.guse !== undefined) {
      useGenerated(inp, pw);
      d.close();
      await genUsed(pw, siteOfForm());
    }
  });
  draw();
}

function genHistoryDialog(inp) {
  const list = genHistory(S.items);
  const d = dlg(`<div class="stack"><div class="card-head"><h3>${ic('refresh')} Cronologia del generatore</h3><button type="button" class="icon" data-gx title="Chiudi">${ic('x')}</button></div>
    ${list.length ? `<div class="genhist">${list.map((e, i) => `<div class="hrow hrow3"><code class="mono">${colorPw(e.pw)}</code>
        <span class="hint">${new Date(e.t).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}${e.site ? ' · ' + esc(e.site) : ''}</span>
        <span class="row-btns"><button type="button" class="icon" data-hcopy="${i}" title="Copia">${ic('copy')}</button>${inp ? `<button type="button" class="btn small primary" data-huse="${i}">Usa</button>` : ''}</span></div>`).join('')}</div>`
      : '<p class="hint">Nessuna password generata finora. Le password che generi e usi compaiono qui (ultime 30), cifrate nel vault.</p>'}</div>`, 'dlg wide');
  d.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.gx !== undefined) d.close();
    else if (t.dataset.hcopy) await copy(list[+t.dataset.hcopy].pw);
    else if (t.dataset.huse) { useGenerated(inp, list[+t.dataset.huse].pw); d.close(); }
  });
}

// ================================================================ condivisione di elementi
const SHARE_PREFIX = 'scrigno-share:1.';
const SHARE_ITER = 200000;
async function shareKey(key, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode('scrigno-share\u0000' + key.trim()), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: SHARE_ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// Cosa viaggia: il contenuto dell'elemento (senza cronologia, allegati e dati interni) e, per i modelli personalizzati, la loro definizione.
function sharePayload(it) {
  const p = { v: 1, type: it.type, title: it.title, f: it.f || {}, custom: it.custom || [], tags: it.tags || [] };
  if (String(it.type).startsWith('tpl:')) {
    const tpl = S.items.find(i => i.type === '_template' && 'tpl:' + i.id === it.type);
    if (tpl) p.tpl = { title: tpl.title, f: tpl.f };
  }
  return p;
}
async function shareEncrypt(payload, key) {
  const salt = rand(16), iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('scrigno-share-v1') }, await shareKey(key, salt), enc.encode(JSON.stringify(payload)));
  return SHARE_PREFIX + [salt, iv, ct].map(x => b64u.to(x)).join('.');
}
function shareTokenOf(text) {
  const m = /scrigno-share:1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(String(text || ''))
    || /[#&]share=(scrigno-share(?::|%3A)1\.[A-Za-z0-9_.-]+)/.exec(String(text || ''));
  return m ? decodeURIComponent(m[1] || m[0]) : null;
}
async function shareDecrypt(token, key) {
  const [salt, iv, ct] = token.slice(SHARE_PREFIX.length).split('.').map(x => b64u.from(x));
  let raw;
  try { raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('scrigno-share-v1') }, await shareKey(key, salt), ct); } catch { throw new Error('Chiave errata'); }
  const p = JSON.parse(new TextDecoder().decode(raw));
  if (p.v !== 1 || !p.title) throw new Error('Elemento condiviso non valido');
  return p;
}
const shareLink = token => (CONFIG.pagesUrl ? CONFIG.pagesUrl.replace(/\/?$/, '/') : location.href.split('#')[0]) + '#share=' + token;
function shareKeyWords() { return genPassword({ mode: 'words', words: 4, sep: '-', wordCaps: false, wordDigit: true, lang: 'it' }); }

async function sendText(text, title) {
  if (Native.platform === 'android') { await Native.call('shareText', { text, title }); return; }
  if (navigator.share && !Native.desktop) { try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  await copy(text, 'Copiato: incollalo nel messaggio');
}

function shareDialog(it) {
  let key = shareKeyWords(), token = null;
  const d = dlg('<div class="stack sharedlg"></div>', 'dlg wide');
  const box = d.querySelector('.sharedlg');
  const draw = () => {
    box.innerHTML = `<div class="card-head"><h3>${ic('share')} Condividi “${esc(it.title)}”</h3><button type="button" class="icon" data-sx title="Chiudi">${ic('x')}</button></div>
      ${!token ? `<p class="hint">L'elemento viene cifrato con una chiave. Chi lo riceve ha bisogno del link <b>e</b> della chiave: mandali con due mezzi diversi (per esempio il link su WhatsApp e la chiave a voce o per SMS). Allegati e cronologia non vengono condivisi.</p>
        <label class="lbl">Chiave di condivisione<span class="inrow"><input id="shKey" value="${esc(key)}" autocomplete="off" spellcheck="false" minlength="8" required>
          <button type="button" class="icon" data-snew title="Nuova chiave">${ic('refresh')}</button></span></label>
        <div class="row-btns end"><button type="button" class="btn primary" data-smake>Crea il link cifrato</button></div>`
      : `<p class="ok">Link cifrato pronto.</p>
        <label class="lbl">Link<textarea class="mono" rows="3" readonly>${esc(shareLink(token))}</textarea></label>
        <div class="row-btns"><button type="button" class="btn primary" data-ssend>${ic('share')} Invia il link</button><button type="button" class="btn" data-scopy>${ic('copy')} Copia il link</button></div>
        <label class="lbl">Chiave (da mandare a parte)<span class="inrow"><input value="${esc(key)}" readonly class="mono"><button type="button" class="icon" data-skey title="Copia la chiave">${ic('copy')}</button></span></label>
        <p class="hint">Chi riceve apre il link (va bene anche senza Scrigno, dal browser) e inserisce la chiave. Con Scrigno può aggiungere l'elemento al suo vault, anche incollando il link in Impostazioni › Vault › “Ricevi elemento condiviso”.</p>`}`;
  };
  d.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.sx !== undefined) d.close();
    else if (t.dataset.snew !== undefined) { key = shareKeyWords(); $('#shKey', d).value = key; }
    else if (t.dataset.smake !== undefined) {
      key = $('#shKey', d).value.trim();
      if (key.length < 8) { toast('La chiave deve avere almeno 8 caratteri'); return; }
      t.disabled = true;
      token = await shareEncrypt(sharePayload(it), key);
      draw();
    } else if (t.dataset.ssend !== undefined) await sendText(`Ti condivido “${it.title}” da Scrigno. Aprilo qui (la chiave te la mando a parte):\n${shareLink(token)}`, 'Elemento Scrigno');
    else if (t.dataset.scopy !== undefined) await copy(shareLink(token), 'Link copiato');
    else if (t.dataset.skey !== undefined) await copy(key, 'Chiave copiata');
  });
  draw();
}

// Ricezione: dal link (#share=…), dagli appunti o incollando il testo.
async function addSharedItem(p) {
  let type = p.type;
  if (String(type).startsWith('tpl:')) {
    let tpl = S.items.find(i => i.type === '_template' && !i.deleted && i.title === (p.tpl && p.tpl.title));
    if (!tpl && p.tpl) { tpl = makeItem('_template', p.tpl.title, p.tpl.f); S.items.push(tpl); }
    type = tpl ? 'tpl:' + tpl.id : 'note';
  } else if (!TYPES[type]) type = 'note';
  const it = makeItem(type, p.title, { ...p.f }, (p.custom || []).map(c => ({ ...c })));
  it.tags = normTags(p.tags || []);
  const target = S.view.vault && S.view.vault !== 'all' ? S.view.vault : MAIN;
  arrOf(target).push(it);
  await saveVaultOf(target);
  S.view = { ...S.view, section: 'all', id: it.id, edit: false, q: '' };
  renderMain();
  toast(`“${it.title}” aggiunto a ${vaultName(target)}`);
}
function receiveDialog(token) {
  if (!token || $('#shareRecv')) return;
  S.lastShareSeen = token;
  let data = null;
  const d = dlg('<div class="stack" id="shareRecv"></div>', 'dlg wide');
  const box = d.querySelector('#shareRecv');
  const draw = () => {
    if (!data) {
      box.innerHTML = `<div class="card-head"><h3>${ic('share')} Elemento condiviso con te</h3><button type="button" class="icon" data-rx title="Chiudi">${ic('x')}</button></div>
        <p class="hint">Qualcuno ti ha mandato un elemento cifrato con Scrigno. Inserisci la chiave che ti ha dato a parte.</p>
        <form id="recvForm" class="stack"><label class="lbl">Chiave<input id="rKey" autocomplete="off" spellcheck="false" required></label>
        <p class="err" id="rErr" hidden></p><button class="btn primary" type="submit">Apri</button></form>`;
      setTimeout(() => { const k = $('#rKey', d); if (k) k.focus(); }, 0);
      return;
    }
    const T = (allTypes(S.items)[data.type]) || (data.tpl ? { label: data.tpl.title, fields: (() => { try { return JSON.parse(data.tpl.f.fields); } catch { return []; } })() } : TYPES.note);
    const fields = [...(T.fields || []).filter(([k]) => data.f[k]).map(([k, l, kind]) => [l, data.f[k], kind]),
      ...Object.keys(data.f).filter(k => !(T.fields || []).some(([x]) => x === k) && data.f[k]).map(k => [k, data.f[k], '']),
      ...(data.custom || []).filter(c => c.value).map(c => [c.label || 'Campo', c.value, c.secret ? 'secret' : ''])];
    box.innerHTML = `<div class="card-head"><h3>${ic('share')} ${esc(data.title)}</h3><button type="button" class="icon" data-rx title="Chiudi">${ic('x')}</button></div>
      <div class="fields">${fields.map(([l, v, kind], i) => `<div class="field"><label>${esc(l)}</label><div class="fv">
        <span class="val ${kind && kind.startsWith('secret') ? 'mono' : ''}">${kind && kind.startsWith('secret') || kind === 'totp' ? '••••••••' : esc(v)}</span>
        ${kind && kind.startsWith('secret') ? `<button type="button" class="icon" data-rshow="${i}" title="Mostra">${ic('eye')}</button>` : ''}
        <button type="button" class="icon" data-rcopy="${i}" title="Copia">${ic('copy')}</button></div></div>`).join('')}</div>
      <div class="row-btns end">${S.dek ? '<button type="button" class="btn primary" data-radd>Aggiungi al mio vault</button>'
        : S.file ? '<button type="button" class="btn primary" data-rlater>Sblocca e aggiungi</button>' : ''}</div>
      ${!S.file ? '<p class="hint">Per conservarlo installa Scrigno o crea un vault da questa pagina, poi riapri il link.</p>' : ''}`;
    box._fields = fields;
  };
  d.addEventListener('submit', async e => {
    e.preventDefault(); e.stopPropagation();
    try { data = await shareDecrypt(token, $('#rKey', d).value); draw(); } catch (err) { const p = $('#rErr', d); p.textContent = err.message; p.hidden = false; }
  });
  d.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.rx !== undefined) d.close();
    else if (t.dataset.rcopy) await copy(box._fields[+t.dataset.rcopy][1]);
    else if (t.dataset.rshow) { const v = t.parentElement.querySelector('.val'); v.textContent = v.textContent === '••••••••' ? box._fields[+t.dataset.rshow][1] : '••••••••'; }
    else if (t.dataset.radd !== undefined) { d.close(); await addSharedItem(data); }
    else if (t.dataset.rlater !== undefined) { S.shareToAdd = data; d.close(); toast('Sblocca Scrigno: l\'elemento verrà aggiunto subito dopo'); }
  });
  draw();
}
async function afterUnlockShare() {
  if (S.shareToAdd) { const p = S.shareToAdd; S.shareToAdd = null; await addSharedItem(p); }
  if (S.incomingShare) { const t = S.incomingShare; S.incomingShare = null; receiveDialog(t); }
}
function shareFromHash() {
  const t = shareTokenOf(location.hash);
  if (!t) return;
  history.replaceState(null, '', location.pathname + location.search);
  receiveDialog(t);
}
// "Controlla gli appunti": se è stato copiato un elemento condiviso, Scrigno propone di aprirlo.
async function checkClipboardShare() {
  if (!S.settings.clipboardCheck || $('#shareRecv')) return;
  let text = '';
  try { text = Native.available ? await Native.call('clipboardRead') : await navigator.clipboard.readText(); } catch { return; }
  const t = shareTokenOf(text);
  if (t && t !== S.lastShareSeen) receiveDialog(t);
}

// ================================================================ Assistente (computer)
// La scorciatoia apre una finestra compatta sopra le altre: cerca, compila con Auto-Type o copia.
function renderAssistant() {
  const req = S.assistant || {};
  const ql = (S.asQ || '').trim().toLowerCase();
  const cands = autotypeCandidates(req.title);
  const pool = ql ? allLive().filter(i => [i.title, i.f.username, i.f.url, ...(i.tags || [])].some(x => x && String(x).toLowerCase().includes(ql))) : cands.slice(0, 25);
  $('#app').innerHTML = `<div class="assistant">
    <div class="as-head">${LOGO}<b>Assistente</b>
      <button class="icon ${S.settings.assistantDocked ? 'on' : ''}" data-act="as-dock" title="${S.settings.assistantDocked ? 'Ancorato: resta sullo schermo' : 'Ancora: resta sullo schermo'}">${ic('pin')}</button>
      <button class="icon" data-act="as-expand" title="Apri Scrigno">${ic('open')}</button>
      <button class="icon" data-act="lock" title="Blocca">${ic('lock')}</button>
      <button class="icon" data-act="as-close" title="Chiudi">${ic('x')}</button></div>
    ${req.title ? `<p class="as-for">${ic('monitor')} ${esc(req.title)}</p>` : ''}
    <input id="asQ" type="search" placeholder="Cerca in Scrigno" value="${esc(S.asQ || '')}" autocomplete="off">
    <div class="as-list">${pool.map(i => `<div class="as-row">${letterIcon(i)}<span class="rtext"><b>${esc(i.title)}</b><small>${esc(subtitle(i))}</small></span>
      <span class="as-acts">${i.type === 'login' && (i.f.username || i.f.password) ? `<button class="btn small primary" data-act="as-type" data-id="${i.id}" title="Digita nome utente e password nell'app in primo piano">Compila</button>` : ''}
        ${i.f.username ? `<button class="icon" data-act="as-copy" data-id="${i.id}" data-k="username" title="Copia nome utente">${ic('id')}</button>` : ''}
        ${i.f.password ? `<button class="icon" data-act="as-copy" data-id="${i.id}" data-k="password" title="Copia password">${ic('key')}</button>` : ''}
        ${i.f.totp ? `<button class="icon" data-act="as-copy" data-id="${i.id}" data-k="totp" title="Copia codice 2FA">${ic('shield')}</button>` : ''}</span></div>`).join('') || '<p class="empty">Nessun elemento.</p>'}</div>
    <label class="chk small as-enter"><input type="checkbox" id="asEnter" ${S.settings.assistantEnter !== false ? 'checked' : ''}> Premi Invio dopo la compilazione</label>
  </div>`;
  const q = $('#asQ');
  if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}
async function assistantClick(act, b) {
  switch (act) {
    case 'as-type': {
      const it = findItem(b.dataset.id);
      const enter = $('#asEnter') ? $('#asEnter').checked : true;
      try { await Native.call('autotype', { username: it.f.username || '', password: it.f.password || '', enter, assistant: true }); } catch (err) { toast(err.message, 5000); }
      return true;
    }
    case 'as-copy': {
      const it = findItem(b.dataset.id);
      await copy(b.dataset.k === 'totp' ? await totp(parseTotp(it.f.totp)) : it.f[b.dataset.k]);
      return true;
    }
    case 'as-dock':
      S.settings.assistantDocked = !S.settings.assistantDocked; saveSettings(); pushDesktopPrefs(); renderAssistant();
      toast(S.settings.assistantDocked ? 'Assistente ancorato: resta sullo schermo' : 'L\'assistente si chiude quando fai clic altrove');
      return true;
    case 'as-expand': S.assistant = null; S.asQ = ''; await Native.call('assistantEnd', { show: true }).catch(() => {}); render(); return true;
    case 'as-close': S.assistant = null; S.asQ = ''; await Native.call('assistantEnd', { show: false }).catch(() => {}); render(); return true;
  }
  return false;
}
