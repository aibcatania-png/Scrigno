'use strict';
// Pagina di ritorno OAuth: inoltra i parametri alla web app (BroadcastChannel) o all'app nativa (scrigno://).
(() => {
  const p = Object.fromEntries(new URLSearchParams(location.search));
  Object.assign(p, Object.fromEntries(new URLSearchParams(location.hash.slice(1))));
  history.replaceState(null, '', location.pathname);
  const msg = document.getElementById('msg');
  if (!p.state || !String(p.state).startsWith('scrigno-')) { msg.textContent = 'Nessun accesso in corso.'; return; }
  if (!location.pathname.endsWith('oauth-app.html')) {
    new BroadcastChannel('scrigno-oauth').postMessage(p);
    msg.textContent = 'Accesso completato. Puoi chiudere questa finestra.';
    setTimeout(() => window.close(), 400);
    return;
  }
  const json = JSON.stringify(p);
  const b = btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const link = 'scrigno://oauth?' + new URLSearchParams(p).toString();
  msg.textContent = 'Accesso completato: torno a Scrigno…';
  document.getElementById('code').value = b;
  document.getElementById('openBtn').href = link;
  document.getElementById('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(b); } catch { document.getElementById('code').select(); document.execCommand('copy'); }
    document.getElementById('copyBtn').textContent = 'Copiato';
  };
  document.getElementById('codeBox').hidden = false;
  location.href = link;
})();
