'use strict';
/*
 * Scrigno — script nelle pagine (mondo isolato).
 * Riconosce i moduli di accesso, mostra il menu di compilazione, propone di salvare i login
 * e fa da ponte per le richieste di passkey.
 */
(() => {
  if (window.__scrignoContent) return;
  window.__scrignoContent = true;
  const api = typeof browser !== 'undefined' ? browser : chrome;

  const send = async msg => {
    const r = await api.runtime.sendMessage(msg);
    if (!r) throw new Error('Nessuna risposta');
    if (!r.ok) throw new Error(r.error);
    return r.r;
  };

  // ------------------------------------------------------------ campi
  const USER_RE = /user|email|e-mail|login|account|utente|nome.?utente|identifier|phone|cellulare/i;
  const OTP_RE = /otp|totp|2fa|mfa|one.?time|verification.?code|auth.?code|security.?code|codice/i;
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range', 'color', 'date', 'number', 'search']);

  const visible = el => {
    if (!el.isConnected || el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && +st.opacity > 0.05;
  };
  const attrs = el => [el.name, el.id, el.getAttribute('autocomplete'), el.placeholder, el.getAttribute('aria-label')].filter(Boolean).join(' ');
  const isPw = el => el.type === 'password';
  const isText = el => el.tagName === 'INPUT' && !SKIP_TYPES.has(el.type) && !isPw(el);
  const isOtp = el => isText(el) && (el.autocomplete === 'one-time-code' || OTP_RE.test(attrs(el)));
  const isUser = el => isText(el) && !isOtp(el) && (/username|email/.test(el.autocomplete || '') || USER_RE.test(attrs(el)) || el.type === 'email');
  const isNewPw = el => /new-password/.test(el.autocomplete || '');

  function allInputs(root = document) {
    return [...root.querySelectorAll('input')].filter(visible);
  }
  function formOf(el) { return el.form || el.closest('form, [role=form]') || document.body; }

  // Trova il campo utente relativo a un campo password (il campo di testo che lo precede).
  function userFieldFor(pw) {
    const inputs = allInputs(formOf(pw));
    const idx = inputs.indexOf(pw);
    for (let i = idx - 1; i >= 0; i--) if (isText(inputs[i]) && !isOtp(inputs[i])) return inputs[i];
    const all = allInputs();
    const j = all.indexOf(pw);
    for (let i = j - 1; i >= 0 && i >= j - 3; i--) if (isText(all[i]) && !isOtp(all[i])) return all[i];
    return null;
  }
  function loginFields(scope) {
    const pws = allInputs().filter(isPw).filter(p => !scope || formOf(p) === scope);
    const pw = pws[0] || null;
    const user = pw ? userFieldFor(pw) : allInputs().filter(isUser).find(u => !scope || formOf(u) === scope) || null;
    return { user, pw, newPw: pws.length >= 2 || (pw && isNewPw(pw)) };
  }
  const classify = el => {
    if (!el || el.tagName !== 'INPUT') return null;
    if (isPw(el)) return isNewPw(el) ? 'newpw' : 'pw';
    if (isOtp(el)) return 'otp';
    if (isUser(el)) return 'user';
    const f = loginFields(formOf(el));
    if (f.user === el && f.pw) return 'user';
    return null;
  };

  function setValue(el, value) {
    if (!el) return;
    el.focus({ preventScroll: true });
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    setter.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ------------------------------------------------------------ interfaccia in Shadow DOM
  let host = null, shadow = null;
  function ui() {
    if (shadow) return shadow;
    host = document.createElement('scrigno-ui');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .menu { position: fixed; min-width: 260px; max-width: 360px; max-height: 320px; overflow-y: auto; background: #fff; color: #13202a;
        border: 1px solid #d6dde2; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); padding: 6px; }
      .head { display: flex; align-items: center; gap: 8px; padding: 4px 8px 8px; font-weight: 700; color: #1f78cc; font-size: 12px; }
      .head svg { width: 16px; height: 16px; }
      button { all: unset; display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
      button:hover, button.sel { background: #e3f0fc; }
      .ic { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: #fff; font-weight: 700; flex: none; background: #1f78cc; position: relative; overflow: hidden; }
      .ic img { position: absolute; inset: 0; width: 100%; height: 100%; padding: 4px; background: #fff; object-fit: contain; }
      .t { display: flex; flex-direction: column; min-width: 0; }
      .t b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .t small { color: #5d6c78; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .empty { color: #5d6c78; padding: 8px 10px; font-size: 13px; }
      .bar { position: fixed; top: 16px; right: 16px; width: 340px; background: #fff; color: #13202a; border: 1px solid #d6dde2;
        border-radius: 14px; box-shadow: 0 12px 34px rgba(0,0,0,.2); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
      .bar p { margin: 0; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
      .row button { width: auto; padding: 7px 12px; border: 1px solid #d6dde2; font-weight: 600; }
      .row button.pri { background: #1f78cc; color: #fff; border-color: #1f78cc; }
      @media (prefers-color-scheme: dark) {
        .menu, .bar { background: #131c22; color: #e5edf1; border-color: #23323c; }
        button:hover, button.sel { background: #14304b; }
        .t small, .empty { color: #8fa1ad; }
        .row button { border-color: #23323c; }
      }
    </style><div id="root"></div>`;
    document.documentElement.append(host);
    return shadow;
  }
  const LOGO = '<svg viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="8" fill="#1f78cc"/><path d="M11 14.5v-3a5 5 0 0 1 10 0v3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><rect x="8.5" y="14.5" width="15" height="10.5" rx="2.5" fill="#fff"/></svg>';
  const favHost = u => { try { const h = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) ? h : ''; } catch { return ''; } };
  const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let menu = null, menuFor = null, menuItems = [], sel = -1;
  function closeMenu() { if (menu) menu.remove(); menu = null; menuFor = null; menuItems = []; sel = -1; }
  function placeMenu() {
    if (!menu || !menuFor) return;
    const r = menuFor.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { closeMenu(); return; }
    const h = menu.offsetHeight;
    const top = r.bottom + 4 + h > innerHeight && r.top - 4 - h > 0 ? r.top - 4 - h : r.bottom + 4;
    menu.style.top = top + 'px';
    menu.style.left = Math.max(4, Math.min(r.left, innerWidth - menu.offsetWidth - 4)) + 'px';
  }

  async function openMenu(field, kind) {
    let m;
    try { m = await send({ type: 'pageMatches' }); } catch { return; }
    if (m.state === 'none') return;
    const entries = [];
    if (m.state === 'locked') entries.push({ icon: '🔒', title: 'Sblocca Scrigno', sub: 'per compilare questo modulo', run: async () => { if (await send({ type: 'pageUnlock' })) openMenu(field, kind); } });
    if (m.state === 'ok') {
      if (kind === 'otp') {
        m.logins.filter(l => l.hasTotp).forEach(l => entries.push({ icon: '⏱', title: 'Codice 2FA', sub: l.title, run: () => fill(l.id, field, true) }));
      } else {
        for (const c of condCandidates) entries.push({ icon: '🔐', title: c.username || c.title, sub: 'Passkey · ' + c.title, run: () => usePasskey(c.id) });
        m.logins.forEach(l => entries.push({ letter: (l.title || '?')[0].toUpperCase(), fav: m.favicons ? favHost(l.url) : '', title: l.title, sub: l.username, run: () => fill(l.id, field, false) }));
        if (kind === 'newpw' || (kind === 'pw' && loginFields(formOf(field)).newPw)) {
          entries.push({ icon: '🎲', title: 'Genera password sicura', sub: 'e compila i campi password', run: async () => {
            const pw = await send({ type: 'pageGenerate' });
            allInputs(formOf(field)).filter(isPw).forEach(p => setValue(p, pw));
          } });
        }
      }
    }
    if (!entries.length) { closeMenu(); return; }
    closeMenu();
    const root = ui().getElementById('root');
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = `<div class="head">${LOGO}Scrigno</div>` + entries.map((e, i) =>
      `<button data-i="${i}"><span class="ic">${escH(e.icon || e.letter)}${e.fav ? `<img src="https://icons.duckduckgo.com/ip3/${escH(e.fav)}.ico" alt="" referrerpolicy="no-referrer">` : ''}</span><span class="t"><b>${escH(e.title)}</b><small>${escH(e.sub || '')}</small></span></button>`).join('');
    menu.querySelectorAll('img').forEach(i => i.addEventListener('error', () => i.remove()));
    menu.addEventListener('mousedown', ev => ev.preventDefault());
    menu.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      const e = entries[+b.dataset.i];
      closeMenu();
      e.run();
    });
    root.append(menu);
    menuFor = field; menuItems = entries; sel = -1;
    placeMenu();
  }

  async function fill(id, field, totpOnly) {
    let d;
    try { d = await send({ type: 'pageFill', id, totpOnly }); } catch (e) { return; }
    if (totpOnly) { setValue(field, d.totp); return; }
    const f = loginFields(formOf(field));
    const userEl = f.user || (classify(field) === 'user' ? field : null);
    if (userEl && d.username) setValue(userEl, d.username);
    const pwEl = f.pw || (classify(field) === 'pw' ? field : null);
    if (pwEl && d.password) setValue(pwEl, d.password);
    afterFill(id, d, pwEl || userEl);
  }

  // Dopo la compilazione: codice 2FA negli appunti e nel campo del codice, invio automatico del modulo.
  let pendingOtp = null;
  function afterFill(id, d, el) {
    if (d.otp || d.totp) {
      pendingOtp = { id, until: Date.now() + 180000, code: d.totp };
      if (d.totp && navigator.clipboard) navigator.clipboard.writeText(d.totp).catch(() => {});
      setTimeout(fillPendingOtp, 400);
    }
    if (d.autoSubmit && el) setTimeout(() => submitFrom(el), 350);
  }
  function submitFrom(el) {
    const form = el.form || el.closest('form');
    lastSubmit = 0;
    captureFrom(formOf(el));
    const btn = (form || document).querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (btn && visible(btn)) btn.click();
    else if (form && form.requestSubmit) form.requestSubmit();
    else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  async function fillPendingOtp(target) {
    if (!pendingOtp || Date.now() > pendingOtp.until) { pendingOtp = null; return false; }
    const el = target || allInputs().find(isOtp);
    if (!el || el.value) return false;
    let code = pendingOtp.code;
    if (pendingOtp.id) { try { code = (await send({ type: 'pageFill', id: pendingOtp.id, totpOnly: true })).totp || code; } catch { /* usa il codice già letto */ } }
    if (!code) return false;
    setValue(el, code);
    pendingOtp = null;
    return true;
  }

  // ------------------------------------------------------------ eventi sui campi
  document.addEventListener('focusin', async e => {
    const el = e.composedPath()[0];
    const k = classify(el);
    if (k === 'otp' && pendingOtp && await fillPendingOtp(el)) return;
    if (k) openMenu(el, k); else if (menuFor && el !== menuFor) closeMenu();
  }, true);
  // Il campo del codice 2FA può comparire dopo (pagina successiva o modulo dinamico).
  new MutationObserver(() => { if (pendingOtp) fillPendingOtp(); }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') setTimeout(() => send({ type: 'pagePendingOtp' }).then(p => { if (p) { pendingOtp = { ...p, until: Date.now() + 120000 }; fillPendingOtp(); } }).catch(() => {}), 600);
  else document.addEventListener('DOMContentLoaded', () => setTimeout(() => send({ type: 'pagePendingOtp' }).then(p => { if (p) { pendingOtp = { ...p, until: Date.now() + 120000 }; fillPendingOtp(); } }).catch(() => {}), 600));
  document.addEventListener('click', e => {
    const el = e.composedPath()[0];
    if (el === menuFor) return;
    const k = classify(el);
    if (k && document.activeElement === el && !menu) openMenu(el, k);
  }, true);
  document.addEventListener('keydown', e => {
    if (!menu) return;
    const bs = [...menu.querySelectorAll('button')];
    if (e.key === 'Escape') { closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length;
      bs.forEach((b, i) => b.classList.toggle('sel', i === sel));
    } else if (e.key === 'Enter' && sel >= 0) {
      e.preventDefault(); e.stopPropagation();
      bs[sel].click();
    }
  }, true);
  addEventListener('scroll', placeMenu, true);
  addEventListener('resize', placeMenu);
  document.addEventListener('focusout', e => { if (e.composedPath()[0] === menuFor) setTimeout(() => { if (document.activeElement !== menuFor) closeMenu(); }, 150); }, true);

  // ------------------------------------------------------------ salvataggio dei login
  let lastSubmit = 0;
  function captureFrom(scope) {
    const f = loginFields(scope);
    if (!f.pw || !f.pw.value) return;
    if (Date.now() - lastSubmit < 1500) return;
    lastSubmit = Date.now();
    const pws = allInputs(scope).filter(isPw).map(p => p.value).filter(Boolean);
    const password = pws.length >= 2 ? pws[pws.length - 1] : f.pw.value;  // cambio password: l'ultima è la nuova
    send({ type: 'pageSubmitted', username: f.user ? f.user.value.trim() : '', password }).then(o => { if (o) showSaveBar(o); }).catch(() => {});
  }
  document.addEventListener('submit', e => captureFrom(e.target), true);
  document.addEventListener('click', e => {
    const b = e.composedPath()[0].closest && e.composedPath()[0].closest('button, input[type=submit], [role=button]');
    if (!b) return;
    const scope = formOf(b);
    if (allInputs(scope).some(isPw)) captureFrom(scope);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || menu) return;
    const el = e.composedPath()[0];
    if (el && el.tagName === 'INPUT' && (isPw(el) || classify(el) === 'user')) captureFrom(formOf(el));
  }, true);

  function showSaveBar(o) {
    const root = ui().getElementById('root');
    const old = root.querySelector('.bar');
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `<div class="head" style="padding:0">${LOGO}Scrigno</div>
      <p>${o.update ? 'Aggiornare la password salvata' : 'Salvare questo login'} per <b>${escH(o.host)}</b>${o.username ? ` (${escH(o.username)})` : ''}?</p>
      <div class="row"><button class="pri" data-d="save">${o.update ? 'Aggiorna' : 'Salva'}</button><button data-d="later">Non ora</button>${o.update ? '' : '<button data-d="never">Mai per questo sito</button>'}</div>`;
    bar.addEventListener('click', async ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      bar.remove();
      try { await send({ type: 'pageSaveDecision', decision: b.dataset.d }); } catch { /* ignora */ }
    });
    root.append(bar);
    setTimeout(() => bar.remove(), 45000);
  }
  if (window.top === window) {
    const check = () => send({ type: 'pagePendingSave' }).then(o => { if (o) showSaveBar(o); }).catch(() => {});
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
  }

  // ------------------------------------------------------------ comandi dal popup e scorciatoia
  api.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== api.runtime.id) return false;
    if (msg.type === 'doFill') {
      const f = loginFields();
      if (f.user && msg.username) setValue(f.user, msg.username);
      if (f.pw && msg.password) setValue(f.pw, msg.password);
      afterFill(null, { totp: msg.totp, otp: !!msg.totp, autoSubmit: msg.autoSubmit }, f.pw || f.user);
      respond(!!(f.user || f.pw));
    } else if (msg.type === 'openMenu') {
      const f = loginFields();
      const el = f.user || f.pw;
      if (el) { el.focus(); openMenu(el, classify(el) || 'user'); }
      respond(!!el);
    }
    return false;
  });

  // ------------------------------------------------------------ passkey: ponte con page.js
  let channel = null, condReq = null, condCandidates = [];
  const reply = (id, result) => window.postMessage({ scrignoRes: channel, id, result }, '*');
  window.addEventListener('message', async e => {
    if (e.source !== window || !e.data) return;
    if (e.data.scrignoHello && !channel) { channel = e.data.scrignoHello; return; }
    if (!channel || e.data.scrignoReq !== channel) return;
    const { id, payload } = e.data;
    if (payload.kind === 'get' && payload.conditional) {
      condReq = { id, options: payload.options };
      try {
        const r = await send({ type: 'passkey', kind: 'get', conditional: true, options: payload.options });
        condCandidates = (r && r.candidates) || [];
        if (r && r.fallback) reply(id, { fallback: true });
      } catch { reply(id, { fallback: true }); }
      return;
    }
    try { reply(id, await send({ type: 'passkey', ...payload })); } catch { reply(id, { fallback: true }); }
  });
  window.postMessage({ scrignoPing: true }, '*');

  async function usePasskey(itemId) {
    if (!condReq) return;
    const req = condReq;
    try {
      const r = await send({ type: 'passkey', kind: 'get', conditional: true, chosenId: itemId, options: req.options });
      if (r && r.credential) { condReq = null; condCandidates = []; reply(req.id, r); }
    } catch { /* ignora */ }
  }
})();
