'use strict';
/*
 * Impostazioni divise in sezioni (come in Enpass) e funzioni collegate:
 * tema, icone dei siti, PIN, blocco automatico, compilazione automatica, backup automatici,
 * avvio e vassoio del computer, controllo degli aggiornamenti.
 * Usa le funzioni globali di app.js (caricato dopo questo file).
 */

const SETTINGS_DEFAULT = {
  autoLockMin: 5, clipClearSec: 30, mainName: 'Personale', sort: 'az',
  theme: 'system', showCounts: true, showSubtitles: true, auditOld: true, oldYears: 1, favicons: true,
  hideSecrets: true, searchAll: true,
  tray: true, autostart: false, hotkey: 'A',
  lockOnClose: true, lockOnSuspend: true, lockOnUserSwitch: true, lockOnScreenLock: true, sysIdleMin: 5,
  backupAuto: true, backupDir: '', backupKeep: 60, backupLast: 0,
  updateCheck: true, allowScreenshots: false, clipboardCheck: false, assistantDocked: false, assistantEnter: true,
};
const SET_TABS = [
  ['general', 'Generali', 'sliders'], ['vault', 'Vault', 'vault'], ['security', 'Sicurezza', 'shield'],
  ['look', 'Personalizza', 'palette'], ['autofill', 'Compilazione automatica', 'key'], ['backup', 'Backup', 'refresh'],
  ['advanced', 'Avanzate', 'settings'], ['about', 'Informazioni', 'info'],
];

// ---------------------------------------------------------------- piccoli componenti
const swRow = (key, title, desc = '', on = S.settings[key], attr = 'data-pref') =>
  `<div class="srow"><span class="stext"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</span>
    <label class="switch" aria-label="${esc(title)}"><input type="checkbox" ${attr}="${key}" ${on ? 'checked' : ''}><span></span></label></div>`;
const selRow = (key, title, desc, opts, cur = S.settings[key], attr = 'data-pref') =>
  `<div class="srow"><span class="stext"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</span>
    <select ${attr}="${key}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
const btnRow = (title, desc, btns) => `<div class="srow"><span class="stext"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</span><span class="row-btns">${btns}</span></div>`;
const group = (title, rows) => `<h4 class="sgroup">${title}</h4><div class="sbox">${rows}</div>`;

// ---------------------------------------------------------------- pagina
function renderSettings() {
  const tab = S.view.setTab || 'general';
  const body = { general: setGeneral, vault: setVault, security: setSecurity, look: setLook, autofill: setAutofill,
    backup: setBackup, advanced: setAdvanced, about: setAbout }[tab]();
  return `<div class="pagewrap settings-wrap"><h1>Impostazioni</h1>
    <div class="settings"><nav class="stabs">${SET_TABS.map(([k, l, i]) =>
      `<button class="${tab === k ? 'on' : ''}" data-act="set-tab" data-k="${k}">${ic(i)}<span>${l}</span></button>`).join('')}</nav>
      <div class="sbody">${body}</div></div></div>`;
}

function setGeneral() {
  const desk = Native.desktop;
  const keys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(k => [k, k]);
  return `${desk ? group('Esecuzione',
      swRow('tray', 'Riduci nell\'area di notifica', 'Chiudendo la finestra Scrigno resta attivo vicino all\'orologio, pronto per Auto-Type.') +
      swRow('autostart', 'Avvia all\'avvio del sistema', 'Scrigno si apre ridotto nell\'area di notifica quando accendi il computer.') +
      selRow('hotkey', 'Scorciatoia dell\'Assistente', `${Native.platform === 'darwin' ? '⌘ ⌥' : 'Ctrl + Alt'} + tasto: apre l'Assistente in qualunque punto del sistema, per compilare l'app in primo piano o copiare un dato.`, keys) +
      swRow('assistantDocked', 'Esegui sempre l\'Assistente in modalità ancorata', 'L\'Assistente resta sullo schermo, sopra le altre finestre, e non scompare quando fai clic al di fuori.')) : ''}
    ${group('Comportamento',
      swRow('searchAll', 'Cerca in tutti gli elementi', 'La ricerca guarda in tutto il vault selezionato, non solo nella categoria aperta.'))}
    ${group('Tastiera',
      btnRow('Scorciatoie da tastiera', 'Ctrl (⌘ su Mac) + F cerca, + N nuovo elemento, + L blocca. Premi ? per l\'elenco.', '<button class="btn small" data-act="shortcuts">Mostra</button>'))}`;
}

function setVault() {
  const sy = S.sync;
  const reauth = sy && OAUTH_PROVIDERS.includes(sy.provider);
  return `<div class="card stack"><h3>${ic('cloud')} Sincronizzazione del vault principale</h3>
      ${sy ? `<p>Collegato a <b>${PROVIDERS[sy.provider].name}</b>${sy.label ? ` (${esc(sy.label)})` : ''}${sy.lastSync ? ` · ultima sincronizzazione ${fmtDate(sy.lastSync)}` : ''}</p>
        ${sy.provider === 'gdrive' ? `<p class="hint">${sy.email ? `Account <b>${esc(sy.email)}</b> · ` : ''}App Google n. <b>${esc(String(sy.clientId || '').split('-')[0])}</b> · ${sy.refresh && sy.clientSecret ? 'accesso permanente' : 'accesso da rinnovare ogni ora (manca il client secret)'}. Tutti i dispositivi devono usare la stessa app Google.</p>` : ''}
        ${S.syncErr ? `<p class="err">${esc(S.syncErr.message)}</p>` : ''}
        <div class="row-btns"><button class="btn primary" data-act="sync">Sincronizza ora</button>
          ${reauth ? '<button class="btn" data-act="reauth">Riconnetti</button>' : ''}
          ${S.syncErr && S.syncErr.code === 'other-vault' ? '<button class="btn danger" data-act="cloud-overwrite">Sovrascrivi il cloud con questo vault</button>' : ''}
          <button class="btn ghost" data-act="cloud-off">Disconnetti</button></div>`
      : `<p class="hint">Il vault viene caricato già cifrato: il servizio cloud vede solo dati illeggibili.</p>${cloudForm('connect-cloud', 'Connetti')}`}
    </div>
    ${devicesCard()}
    ${vaultsCard()}
    <div class="card stack"><h3>${ic('download')} Importa ed esporta</h3>
      <div class="row-btns"><button class="btn" data-act="export">Esporta backup cifrato</button>
        <button class="btn" data-act="pick" data-kind="backup">Importa backup Scrigno</button></div>
      <div class="row-btns"><button class="btn" data-act="share-receive">${ic('share')} Ricevi elemento condiviso</button></div>
      <div class="row-btns"><button class="btn" data-act="pick" data-kind="enpass">Importa da Enpass (.json)</button>
        <button class="btn" data-act="pick" data-kind="csv">Importa CSV</button></div>
      <p class="hint">In Enpass: Impostazioni › Esporta › formato .json. Il CSV può venire da Chrome, Bitwarden o simili. Dopo l'importazione elimina il file esportato, perché non è cifrato. Gli elementi importati finiscono nel vault ${S.extra.length ? 'selezionato in alto nell\'elenco' : 'principale'}.</p>
    </div>`;
}

// Dispositivi che usano lo stesso file nel cloud: se un telefono manca qui, è collegato a un altro account o a un'altra app Google.
function devicesCard() {
  if (!S.sync) return '';
  const me = deviceId();
  const list = deviceList(S.items);
  return `${group('Dispositivi che sincronizzano questo vault', `<div class="devlist">${list.map(d => `<div class="srow"><span class="stext"><b>${esc(d.title)}${d.f.deviceId === me ? ' (questo)' : ''}</b>
      <small>Ultima sincronizzazione ${fmtDate(+d.f.last)}${d.f.app ? ' · Scrigno ' + esc(d.f.app) : ''}${d.f.account ? ' · ' + esc(d.f.account) : ''}</small></span></div>`).join('') || '<div class="srow"><span class="hint">Nessuno ancora.</span></div>'}
    <div class="srow"><span class="hint">Ogni vault si sincronizza per conto suo: questo elenco riguarda il vault principale. Se un tuo dispositivo non compare qui, non sta usando lo stesso file nel cloud: sul dispositivo mancante scollega e ricollega ${S.sync.provider === 'gdrive' ? 'Google Drive con lo stesso account' + (S.sync.email ? ' (<b>' + esc(S.sync.email) + '</b>)' : '') + ' e lo stesso Client ID' : 'lo stesso servizio e account'}.</span></div></div>`)}`;
}

function setSecurity() {
  const st = S.settings;
  const desk = Native.desktop;
  const mins = [1, 2, 5, 10, 15, 30, 60].map(v => [v, v + ' min']);
  return `${group('Sblocco',
      btnRow(bioLabel(), S.bio ? 'Attivo su questo dispositivo.' : S.bioAvail ? 'Usa impronta, volto o Windows Hello/Touch ID al posto della master password su questo dispositivo.' : 'Non disponibile su questo dispositivo.',
        S.bio ? '<button class="btn small" data-act="bio-off">Disattiva</button>' : S.bioAvail ? '<button class="btn small primary" data-act="bio-on">Attiva</button>' : '') +
      btnRow('PIN', S.pin ? 'Attivo: sblocchi con il PIN su questo dispositivo. Dopo 5 tentativi errati serve la master password.' : 'Sblocca più velocemente con un PIN, senza inserire ogni volta la master password. Vale solo su questo dispositivo.',
        S.pin ? '<button class="btn small" data-act="pin-off">Disattiva</button>' : '<button class="btn small" data-act="pin-on">Imposta PIN</button>') +
      (S.pinSetup ? `<form id="pinSetForm" class="srow stack pinset">
        <label class="lbl">Nuovo PIN (4–8 cifre)<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required autocomplete="off"></label>
        <label class="lbl">Ripeti il PIN<input name="pin2" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required autocomplete="off"></label>
        <div class="row-btns"><button class="btn primary small" type="submit">Salva PIN</button><button class="btn small ghost" type="button" data-act="pin-cancel">Annulla</button></div></form>` : '') +
      btnRow('Master password', 'Cambiala da qui: il vault viene ricifrato e sincronizzato.', '<button class="btn small" data-act="pw-toggle">Cambia</button>') +
      (S.pwOpen ? `<form class="srow stack" id="pwForm">
        <label class="lbl">Password attuale<input type="password" name="cur" autocomplete="current-password" required></label>
        <label class="lbl">Nuova password<input type="password" name="nw" autocomplete="new-password" required minlength="10">${meterHTML()}</label>
        <label class="lbl">Ripeti la nuova password<input type="password" name="nw2" autocomplete="new-password" required></label>
        ${S.file.kdf && S.file.kdf.keyfile && !rememberedKf() ? '<p class="hint">Ti verrà chiesto anche il keyfile.</p>' : ''}
        <button class="btn primary left small" type="submit">Cambia password</button></form>` : ''))}
    ${keyfileCard()}
    ${group('Blocca automaticamente quando',
      (desk ? swRow('lockOnClose', 'La finestra principale è chiusa') +
        swRow('lockOnSuspend', 'Il sistema va in sospensione') +
        swRow('lockOnUserSwitch', 'Cambio rapido di utente') +
        swRow('lockOnScreenLock', 'Lo schermo del sistema si blocca') : '') +
      `<div class="srow"><label class="chk"><input type="checkbox" data-pref-on="autoLockMin" ${+st.autoLockMin ? 'checked' : ''}> Scrigno è inattivo da</label>
        <select data-pref="autoLockMin" ${+st.autoLockMin ? '' : 'disabled'}>${mins.map(([v, l]) => `<option value="${v}" ${+st.autoLockMin === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` +
      (desk ? `<div class="srow"><label class="chk"><input type="checkbox" data-pref-on="sysIdleMin" ${+st.sysIdleMin ? 'checked' : ''}> Il sistema è inattivo da</label>
        <select data-pref="sysIdleMin" ${+st.sysIdleMin ? '' : 'disabled'}>${mins.map(([v, l]) => `<option value="${v}" ${+st.sysIdleMin === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''))}
    ${group('Riservatezza',
      `<div class="srow"><label class="chk"><input type="checkbox" data-pref-on="clipClearSec" ${+st.clipClearSec ? 'checked' : ''}> Svuota gli appunti dopo</label>
        <select data-pref="clipClearSec" ${+st.clipClearSec ? '' : 'disabled'}>${[10, 15, 30, 60, 120].map(v => `<option value="${v}" ${+st.clipClearSec === v ? 'selected' : ''}>${v} secondi</option>`).join('')}</select></div>` +
      (Native.platform === 'android' ? swRow('allowScreenshots', 'Consenti gli screenshot', 'Di solito Scrigno blocca screenshot e anteprima nelle app recenti, per questo lo screenshot esce nero. Attivalo solo quando ti serve e poi spegnilo.') : '') +
      swRow('hideSecrets', 'Nascondi i campi sensibili', 'Password, PIN e codici restano coperti finché non premi l\'occhio.'))}`;
}

function setLook() {
  return `${group('Aspetto', `<div class="themes">${[['system', 'Segui il sistema'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([k, l]) =>
      `<button class="theme-pick ${S.settings.theme === k ? 'on' : ''}" data-act="set-theme" data-k="${k}"><span class="tp tp-${k}"><i></i><i></i><i></i></span>${l}</button>`).join('')}</div>`)}
    ${group('Elenco e barra laterale',
      swRow('showCounts', 'Mostra il numero di elementi nella barra laterale') +
      swRow('showSubtitles', 'Mostra i sottotitoli', 'Nome utente, numero della carta o altro sotto il titolo di ogni elemento.') +
      swRow('favicons', 'Usa le icone dei siti web', 'Mostra il logo del sito per i login. Le icone sono scaricate dal servizio di DuckDuckGo, che riceve solo il nome del sito, mai le tue credenziali.'))}
    ${group('Controllo sicurezza',
      swRow('auditOld', 'Segnala le password vecchie', 'Le password non cambiate da tempo compaiono in Sicurezza.') +
      (S.settings.auditOld ? selRow('oldYears', 'Considera vecchia una password dopo', '', [[1, '1 anno'], [2, '2 anni'], [3, '3 anni']]) : ''))}
    ${templatesCard()}`;
}

function setAutofill() {
  const p = afPrefs(S.items);
  const af = (k, t, d) => swRow(k, t, d, p[k], 'data-af');
  return `${autofillCard()}
    ${group('Estensione del browser e app',
      af('autoSubmit', 'Accedi automaticamente dopo la compilazione', 'Dopo aver inserito nome utente e password, invia il modulo da solo.') +
      af('otpCopy', 'Copia e inserisci il codice 2FA dopo la compilazione', 'Il codice monouso viene copiato e inserito nel campo del codice quando compare.') +
      af('fillSingle', 'Compila senza chiedere se c\'è un solo login', 'La scorciatoia dell\'estensione (Ctrl+Shift+L) compila subito quando per il sito c\'è un solo login.') +
      af('exactMatch', 'Corrispondenza esatta con l\'indirizzo del sito', 'Compila solo se il sito coincide con l\'indirizzo salvato: un login per “esempio.com” non viene proposto su “account.esempio.com”.') +
      af('lockedSuggest', 'Mostra i suggerimenti anche quando è bloccato', 'Nei campi di accesso compare “Sblocca Scrigno” anche a vault bloccato.') +
      af('askSave', 'Chiedi se salvare i dati di accesso nuovi'))}
    ${group('Siti ignorati', `<div class="srow stack"><small class="hint">Su questi siti Scrigno non compila e non chiede di salvare. Vale per tutti i dispositivi.</small>
      ${p.ignore.length ? `<div class="chips">${p.ignore.map(d => `<span class="chip">${esc(d)}<button class="icon" data-act="af-unignore" data-d="${esc(d)}" title="Rimuovi">${ic('x')}</button></span>`).join('')}</div>` : '<p class="hint">Nessun sito ignorato.</p>'}
      <form id="ignoreForm" class="row-btns"><input name="d" placeholder="esempio.com" autocomplete="off" inputmode="url" required><button class="btn small" type="submit">Aggiungi</button></form></div>`)}
    <p class="hint">Le preferenze sono salvate nel vault, quindi valgono per l'estensione, per l'app Android e per gli altri dispositivi.</p>`;
}

function setBackup() {
  const st = S.settings;
  const desk = Native.desktop;
  const list = S.backups || [];
  return `${group('Backup automatici',
      swRow('backupAuto', 'Esegui il backup automatico', `Una copia cifrata del vault ${desk ? 'nella cartella indicata' : 'su questo dispositivo'}, al massimo una volta al giorno e prima di ogni ripristino.`) +
      (desk ? btnRow('Posizione', `<code>${esc(st.backupDir || S.backupDefaultDir || 'cartella dati di Scrigno › Backups')}</code>`,
        '<button class="btn small" data-act="bk-dir">Cambia percorso</button><button class="btn small ghost" data-act="bk-open">Apri</button>') : '') +
      selRow('backupKeep', 'Backup da conservare', desk ? '' : 'Su telefono e browser lo spazio è limitato: ne bastano pochi.', [[5, 'Ultimi 5'], [10, 'Ultimi 10'], [30, 'Ultimi 30'], [60, 'Ultimi 60']]) +
      btnRow('Backup ora', st.backupLast ? 'Ultimo: ' + fmtDate(st.backupLast) : 'Nessun backup ancora.', '<button class="btn small primary" data-act="bk-now">Esegui backup</button>'))}
    ${group('Backup precedenti', list.length ? list.map(b => `<div class="srow"><span class="stext"><b>${fmtDate(b.t)}</b><small>${b.n != null ? b.n + ' elementi' : esc(b.name || '')}</small></span>
        <span class="row-btns"><button class="btn small" data-act="bk-restore" data-k="${esc(b.k)}">Ripristina</button><button class="icon" data-act="bk-save" data-k="${esc(b.k)}" title="Esporta">${ic('download')}</button></span></div>`).join('')
      : '<div class="srow"><span class="hint">Nessun backup automatico su questo dispositivo.</span></div>')}
    <p class="hint">I backup sono cifrati con la master password del momento in cui sono stati fatti. “Ripristina” sostituisce gli elementi del vault con quelli del backup, su tutti i dispositivi; prima viene fatto un backup dello stato attuale.</p>`;
}

function setAdvanced() {
  return `${group('Condivisione',
      swRow('clipboardCheck', 'Controlla gli appunti', 'Se copi il link di un elemento condiviso con Scrigno, l\'app lo riconosce quando torni qui e ti propone di aprirlo.'))}
    ${group('Aggiornamenti',
      swRow('updateCheck', 'Controlla gli aggiornamenti', 'Avvisa quando su GitHub c\'è una versione nuova di Scrigno.') +
      btnRow('Controlla ora', S.update ? (S.update.newer ? `Disponibile la versione <b>${esc(S.update.version)}</b>` : 'Hai l\'ultima versione.') : '',
        '<button class="btn small" data-act="upd-check">Controlla</button>' + (S.update && S.update.newer ? `<a class="btn small primary" href="${esc(S.update.url)}" target="_blank" rel="noopener" data-act="open-url">Scarica</a>` : '')))}
    ${group('Ripristino',
      btnRow('Reimposta Scrigno', 'Elimina vault, impostazioni, PIN e backup solo da questo dispositivo. I dati nel cloud e sugli altri dispositivi restano intatti.',
        '<button class="btn small danger" data-act="reset-all">Elimina tutto</button>'))}`;
}

function setAbout() {
  const v = (CONFIG && CONFIG.version) || '';
  const where = Native.desktop ? 'App per computer' : Native.platform === 'android' ? 'App Android' : Native.platform === 'ios' ? 'App iOS' : 'Web app';
  return `<div class="card stack about"><div class="brand big">${LOGO}<span>Scrigno</span></div>
      <p>Versione <b>${esc(v || '—')}</b> · ${where}</p>
      <p class="hint">Gestore di password con vault cifrato (AES-256-GCM) sincronizzato sul tuo cloud.</p>
      <div class="row-btns">${repoUrl() ? `<a class="btn small" href="${esc(repoUrl())}/releases" target="_blank" rel="noopener" data-act="open-url">Versioni e download</a>` : ''}
        ${CONFIG.pagesUrl ? `<a class="btn small" href="${esc(CONFIG.pagesUrl)}privacy.html" target="_blank" rel="noopener" data-act="open-url">Privacy e termini</a>` : ''}</div>
      <p class="hint">Parole per le password pronunciabili: elenco italiano di diceware (CC BY 4.0) ed EFF Large Wordlist (CC BY 3.0). Icone dei siti: DuckDuckGo.</p></div>`;
}

function bioLabel() {
  if (Native.platform === 'darwin') return 'Touch ID';
  if (Native.platform === 'win32') return 'Windows Hello';
  if (Native.platform === 'android') return 'Impronta o volto';
  if (Native.platform === 'ios') return 'Face ID o Touch ID';
  return 'Sblocco biometrico';
}

// ---------------------------------------------------------------- applicazione delle impostazioni
function applyTheme() {
  const t = S.settings && S.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
// Preferenze del computer (vassoio, avvio, scorciatoia, blocco) passate al processo principale.
function pushDesktopPrefs() {
  if (!Native.desktop) return;
  const st = S.settings;
  Native.call('desktopPrefs', { tray: !!st.tray, autostart: !!st.autostart, hotkey: st.hotkey || 'A',
    lockOnClose: !!st.lockOnClose, lockOnSuspend: !!st.lockOnSuspend, lockOnUserSwitch: !!st.lockOnUserSwitch,
    lockOnScreenLock: !!st.lockOnScreenLock, sysIdleMin: +st.sysIdleMin || 0, assistantDocked: !!st.assistantDocked }).catch(() => {});
}
// Le preferenze di compilazione servono anche al servizio Android a vault bloccato.
function pushAfPrefs() {
  if (Native.platform !== 'android' || !S.dek) return;
  Native.call('afPrefs', { prefs: JSON.stringify(afPrefs(S.items)) }).catch(() => {});
}

// ---------------------------------------------------------------- icone dei siti
function siteHost(it) {
  const u = it && it.f && (it.f.url || it.f.website || '');
  if (!u || /^androidapp:/.test(u)) return '';
  const h = hostOf(u).toLowerCase().replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : '';
}
function faviconImg(it) {
  if (!S.settings || !S.settings.favicons) return '';
  const h = siteHost(it);
  return h ? `<img class="favimg" src="https://icons.duckduckgo.com/ip3/${h}.ico" alt="" loading="lazy" referrerpolicy="no-referrer" decoding="async">` : '';
}
// Le icone che non si caricano lasciano vedere la lettera sotto.
document.addEventListener('error', e => { if (e.target && e.target.classList && e.target.classList.contains('favimg')) e.target.remove(); }, true);
document.addEventListener('load', e => { if (e.target && e.target.classList && e.target.classList.contains('favimg')) e.target.parentElement.classList.add('hasfav'); }, true);

// ---------------------------------------------------------------- PIN
const PIN_ITER = 300000, PIN_TRIES = 5;
async function pinKek(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode('scrigno-pin\u0000' + pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}
async function pinInit() { try { S.pin = (await store.get('pin')) || null; } catch { S.pin = null; } if (S.pin && S.file && S.pin.vaultId !== S.file.vaultId) S.pin = null; }
async function pinEnable(pin) {
  const salt = rand(16);
  S.pin = { vaultId: S.file.vaultId, salt: toB64(salt), wrapped: await wrapKey(S.dek, await pinKek(pin, salt)), tries: 0 };
  await store.set('pin', S.pin);
}
async function pinDisable() { S.pin = null; await store.del('pin').catch(() => {}); }
async function pinUnlock(pin) {
  const p = S.pin;
  let dek = null;
  try { dek = await unwrapKey(p.wrapped, await pinKek(pin, fromB64(p.salt))); } catch { dek = null; }
  if (!dek) {
    p.tries = (p.tries || 0) + 1;
    if (p.tries >= PIN_TRIES) { await pinDisable(); throw new Error('Troppi tentativi: il PIN è stato disattivato. Usa la master password.'); }
    await store.set('pin', p);
    throw new Error(`PIN errato. Tentativi rimasti: ${PIN_TRIES - p.tries}.`);
  }
  if (p.tries) { p.tries = 0; await store.set('pin', p); }
  await openWithDEK(dek);
  await afterUnlock();
}
function pinLockForm() {
  return `<form id="pinForm" class="stack">
      <label class="lbl">PIN<input type="password" id="pinIn" inputmode="numeric" autocomplete="off" maxlength="8" required></label>
      <p class="err" id="unlockErr" hidden></p>
      <button class="btn primary wide" type="submit">Sblocca</button></form>
    <button class="link" data-act="use-master">Usa la master password</button>`;
}

// ---------------------------------------------------------------- backup automatici
const bkName = t => `scrigno-backup-${new Date(t).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
async function backupList() {
  try {
    if (Native.desktop) {
      const r = await Native.call('backupList', { dir: S.settings.backupDir || '' });
      S.backupDefaultDir = r.defaultDir;
      S.backups = r.files.map(f => ({ k: f.name, t: f.time, name: f.name }));
    } else {
      S.backups = ((await store.get('bk-index')) || []).map(b => ({ ...b }));
    }
  } catch { S.backups = []; }
  S.backups.sort((a, b) => b.t - a.t);
  return S.backups;
}
async function backupNow(reason = '') {
  if (!S.file || !S.dek) return;
  const t = now();
  const text = JSON.stringify(S.file);
  const keep = Math.max(1, +S.settings.backupKeep || 60);
  if (Native.desktop) {
    await Native.call('backupWrite', { dir: S.settings.backupDir || '', name: bkName(t), text, keep });
  } else {
    const idx = (await store.get('bk-index')) || [];
    const k = 'bk-' + t;
    await store.set(k, S.file);
    idx.push({ k, t, n: S.items.filter(isActive).length, reason });
    idx.sort((a, b) => b.t - a.t);
    for (const old of idx.splice(Math.min(keep, 10))) await store.del(old.k).catch(() => {});
    await store.set('bk-index', idx);
  }
  S.settings.backupLast = t; saveSettings();
}
async function backupAuto() {
  if (!S.settings.backupAuto || !S.dek) return;
  if (now() - (+S.settings.backupLast || 0) < 24 * 3600e3) return;
  try { await backupNow('auto'); } catch { /* ignora: riprova al prossimo sblocco */ }
}
async function backupRead(k) {
  if (Native.desktop) return JSON.parse(await Native.call('backupRead', { dir: S.settings.backupDir || '', name: k }));
  return store.get(k);
}
async function backupRestore(k) {
  const f = await backupRead(k);
  if (!f || f.format !== 'scrigno') throw new Error('Backup non leggibile.');
  let dek;
  if (f.vaultId === S.file.vaultId) { try { dek = (await vaultRead(f, S.dek)) && S.dek; } catch { dek = null; } }
  if (!dek) {
    const pw = await askPassword('Master password del backup');
    if (!pw) return false;
    dek = await vaultUnlock(f, pw).catch(() => { throw new Error('Password del backup errata'); });
  }
  const old = (await vaultRead(f, dek)).filter(i => !i.deleted && !isInternal(i));
  await backupNow('prima del ripristino');
  // Gli elementi del backup diventano i più recenti; quelli nati dopo vanno nel cestino (recuperabili).
  // Gli elementi interni attuali (chiavi dei vault, preferenze, cronologia) restano come sono.
  const t = now();
  const keepIds = new Set(old.map(i => i.id));
  const restored = old.map(i => ({ ...i, updated: t }));
  for (const i of S.items) {
    if (keepIds.has(i.id)) continue;
    if (isInternal(i) || i.deleted || i.trashed) restored.push(i);
    else restored.push({ ...i, trashed: t, updated: t });
  }
  S.items = restored;
  await saveVault();
  return true;
}

// ---------------------------------------------------------------- aggiornamenti
function repoUrl() {
  if (CONFIG.repo) return 'https://github.com/' + CONFIG.repo;
  const m = /^https:\/\/([^.]+)\.github\.io\/([^/]+)\//.exec(CONFIG.pagesUrl || '');
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
}
const verNum = v => String(v || '').replace(/^v/, '').split('.').map(n => +n || 0);
const verNewer = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function checkUpdate(manual) {
  const r = repoUrl();
  if (!r) { if (manual) toast('Controllo aggiornamenti non disponibile in questa build'); return; }
  try {
    const res = await Cloud.env.fetch(r.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error('GitHub: ' + res.status);
    const j = await res.json();
    const version = String(j.tag_name || '').replace(/^v/, '');
    const apk = (j.assets || []).find(a => /\.apk$/.test(a.name));
    S.update = { version, newer: verNewer(version, CONFIG.version), url: Native.platform === 'android' && apk ? apk.browser_download_url : j.html_url };
    if (manual && !S.update.newer) toast('Hai l\'ultima versione');
  } catch (e) { if (manual) toast('Controllo non riuscito: ' + e.message); }
  if (S.dek) renderMain();
}
function updateBanner() {
  return S.update && S.update.newer && S.settings.updateCheck
    ? `<a class="upd-banner" href="${esc(S.update.url)}" target="_blank" rel="noopener" data-act="open-url">${ic('bell')}<span class="nl">Aggiorna a ${esc(S.update.version)}</span></a>` : '';
}

// ---------------------------------------------------------------- eventi
async function settingsClick(act, b) {
  switch (act) {
    case 'set-tab':
      S.view.setTab = b.dataset.k; S.pwOpen = false; S.pinSetup = false;
      if (b.dataset.k === 'backup') await backupList();
      renderMain(); return true;
    case 'set-theme': S.settings.theme = b.dataset.k; saveSettings(); applyTheme(); renderMain(); return true;
    case 'pw-toggle': S.pwOpen = !S.pwOpen; renderMain(); return true;
    case 'pin-on': S.pinSetup = true; renderMain(); setTimeout(() => { const i = document.querySelector('#pinSetForm input'); if (i) i.focus(); }, 0); return true;
    case 'pin-cancel': S.pinSetup = false; renderMain(); return true;
    case 'pin-off': if (confirm('Disattivare lo sblocco con PIN su questo dispositivo?')) { await pinDisable(); renderMain(); toast('PIN disattivato'); } return true;
    case 'use-master': S.lockMode = 'master'; render(); return true;
    case 'af-unignore': {
      const p = afPrefs(S.items);
      afPrefsSet(S.items, { ignore: p.ignore.filter(d => d !== b.dataset.d) });
      await saveVault(); pushAfPrefs(); renderMain(); return true;
    }
    case 'bk-now': await backupNow('manuale'); await backupList(); renderMain(); toast('Backup eseguito'); return true;
    case 'bk-dir': {
      const f = await Native.call('folderPick');
      if (f) { S.settings.backupDir = f.id; saveSettings(); await backupList(); renderMain(); }
      return true;
    }
    case 'bk-open': await Native.call('openFolder', { dir: S.settings.backupDir || '' }); return true;
    case 'bk-save': {
      const f = await backupRead(b.dataset.k);
      await downloadFile(`scrigno-backup-${new Date((S.backups.find(x => x.k === b.dataset.k) || {}).t || now()).toISOString().slice(0, 10)}.json`, JSON.stringify(f));
      return true;
    }
    case 'bk-restore':
      if (!confirm('Ripristinare questo backup? Gli elementi del vault torneranno com\'erano allora su tutti i dispositivi (quelli creati dopo finiscono nel cestino). Prima viene fatto un backup dello stato attuale.')) return true;
      if (await backupRestore(b.dataset.k)) { await backupList(); renderMain(); toast('Backup ripristinato'); }
      return true;
    case 'upd-check': await checkUpdate(true); return true;
    case 'reset-all':
      if (!confirm('Eliminare da questo dispositivo vault, impostazioni, PIN e backup? Il cloud e gli altri dispositivi non vengono toccati.')) return true;
      if (!Native.desktop) for (const bk of (await store.get('bk-index').catch(() => [])) || []) await store.del(bk.k).catch(() => {});
      await store.del('bk-index').catch(() => {});
      await pinDisable();
      try { localStorage.removeItem('scrigno-settings'); } catch { /* ignora */ }
      S.settings = loadSettings(); applyTheme();
      await wipe(true);
      return true;
  }
  return false;
}

async function settingsSubmit(fm) {
  if (fm.id === 'pinForm') {
    const btn = fm.querySelector('button[type=submit]');
    btn.disabled = true;
    try { await pinUnlock($('#pinIn').value); } catch (err) {
      if (!S.pin) { S.lockMode = 'master'; render(); toast(err.message, 5000); return true; }
      const p = $('#unlockErr'); p.textContent = err.message; p.hidden = false; btn.disabled = false; $('#pinIn').value = ''; $('#pinIn').focus();
    }
    return true;
  }
  if (fm.id === 'pinSetForm') {
    const a = fm.pin.value, c = fm.pin2.value;
    if (!/^\d{4,8}$/.test(a)) throw new Error('Il PIN deve avere da 4 a 8 cifre');
    if (a !== c) throw new Error('I due PIN non coincidono');
    if (/^(\d)\1+$/.test(a) || '0123456789012'.includes(a) || '9876543210987'.includes(a)) throw new Error('PIN troppo semplice: evita cifre uguali o in sequenza');
    await pinEnable(a);
    S.pinSetup = false; renderMain(); toast('PIN attivato');
    return true;
  }
  if (fm.id === 'ignoreForm') {
    const d = normDomain(fm.d.value);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error('Scrivi un dominio, per esempio esempio.com');
    const p = afPrefs(S.items);
    if (!p.ignore.includes(d)) afPrefsSet(S.items, { ignore: [...p.ignore, d].sort() });
    await saveVault(); pushAfPrefs(); renderMain();
    return true;
  }
  return false;
}

async function settingsChange(t) {
  if (t.dataset.af) {
    afPrefsSet(S.items, { [t.dataset.af]: t.checked });
    await saveVault(); pushAfPrefs(); toast('Impostazione salvata');
    return true;
  }
  if (t.dataset.prefOn) {   // casella che attiva/disattiva un valore numerico (es. blocco dopo N minuti)
    const k = t.dataset.prefOn;
    const sel = t.closest('.srow').querySelector('select');
    sel.disabled = !t.checked;
    S.settings[k] = t.checked ? +sel.value : 0;
  } else if (t.dataset.pref) {
    const k = t.dataset.pref;
    S.settings[k] = t.type === 'checkbox' ? t.checked : typeof SETTINGS_DEFAULT[k] === 'number' ? +t.value : t.value;
  } else return false;
  saveSettings();
  pushDesktopPrefs();
  if (t.dataset.pref === 'allowScreenshots') Native.call('screenshots', { allow: t.checked }).catch(() => {});
  if (['showCounts', 'showSubtitles', 'favicons', 'auditOld', 'hideSecrets'].includes(t.dataset.pref)) renderMain();
  if (t.dataset.pref === 'autoLockMin' || t.dataset.prefOn === 'autoLockMin') shareSession();
  if (t.dataset.pref === 'updateCheck' && t.checked) checkUpdate(false);
  toast('Impostazione salvata');
  return true;
}
