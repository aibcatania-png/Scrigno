'use strict';
/* Finestra di conferma: sblocco, creazione e uso delle passkey. */
const api = typeof browser !== 'undefined' ? browser : chrome;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const id = location.hash.slice(1);
const LOGO = '<svg viewBox="0 0 32 32" width="26" height="26"><rect x="1" y="1" width="30" height="30" rx="8" fill="#0f766e"/><path d="M11 14.5v-3a5 5 0 0 1 10 0v3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><rect x="8.5" y="14.5" width="15" height="10.5" rx="2.5" fill="#fff"/></svg>';

async function send(msg) {
  const r = await api.runtime.sendMessage(msg);
  if (!r || !r.ok) throw new Error(r ? r.error : 'Nessuna risposta');
  return r.r;
}
const answer = a => send({ type: 'promptAnswer', id, answer: a });
let P = null;

let ST = {};
function unlockForm(text) {
  return `<form class="card" id="unlockForm"><p>${esc(text)}</p>
    <label class="lbl">Master password<input type="password" id="mp" required autocomplete="current-password"></label>
    ${ST.keyfile && !ST.kfRemembered ? `<label class="lbl">Keyfile<input type="file" id="kfFile"></label><label class="lbl" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" id="kfRem" style="width:auto"> Ricorda il keyfile in questo browser</label>` : ''}
    <p class="err" id="uerr" hidden></p><button class="btn pri wide">Sblocca</button></form>`;
}
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


async function render() {
  const d = P.data;
  const st = await send({ type: 'state' });
  ST = st;
  let html = `<div class="brand">${LOGO} Scrigno</div>`;
  if (P.kind === 'unlock') {
    html += st.unlocked ? '<p>Sbloccato.</p>' : unlockForm(d.reason || 'Sblocca Scrigno');
    if (st.unlocked) { await answer({ ok: true }); return; }
  } else if (P.kind === 'passkey-create') {
    html += `<div class="card"><h2>Creare una passkey?</h2>
      <p>Sito: <b>${esc(d.rpId)}</b><br>Account: <b>${esc(d.user)}</b></p>
      ${st.unlocked ? `<label class="lbl">Nome nel vault<input id="title" value="${esc(d.rpName)}"></label>` : ''}</div>
      ${st.unlocked ? '' : unlockForm('Sblocca per salvare la passkey in Scrigno.')}
      ${st.unlocked ? '<button class="btn pri wide" data-a="create">Salva in Scrigno</button>' : ''}
      <button class="btn wide" data-a="browser">Usa il browser o un altro dispositivo</button>
      <button class="btn wide" data-a="cancel">Annulla</button>`;
  } else if (P.kind === 'passkey-get') {
    let list = [];
    if (st.unlocked) list = await send({ type: 'promptPasskeys', rpId: d.rpId, allow: d.allow });
    html += `<div class="card"><h2>Accedi con passkey</h2><p>Sito: <b>${esc(d.rpId)}</b></p></div>
      ${!st.unlocked ? unlockForm('Sblocca per usare le passkey di Scrigno.') : list.length ? `<div class="list">${list.map(p =>
        `<button class="item btn" data-a="use" data-id="${p.id}" style="text-align:left"><span class="t"><b>${esc(p.username || p.title)}</b><small>${esc(p.title)}</small></span></button>`).join('')}</div>`
        : '<p class="hint">In Scrigno non ci sono passkey per questo sito.</p>'}
      <button class="btn wide" data-a="browser">Usa il browser o un altro dispositivo</button>
      <button class="btn wide" data-a="cancel">Annulla</button>`;
  }
  $('#app').innerHTML = html;
  if ($('#mp')) $('#mp').focus();
}

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const a = b.dataset.a;
  if (a === 'create') await answer({ useScrigno: true, title: ($('#title') && $('#title').value.trim()) || '' });
  if (a === 'browser') await answer({ useBrowser: true });
  if (a === 'cancel') await answer({ cancel: true });
  if (a === 'use') await answer({ id: b.dataset.id });
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  try { await send(await unlockMsg()); } catch (err) { $('#uerr').textContent = err.message; $('#uerr').hidden = false; return; }
  await render();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') answer({ cancel: true }); });

send({ type: 'promptData', id }).then(p => { P = p; return render(); }).catch(e => { $('#app').textContent = e.message; setTimeout(() => window.close(), 1500); });
