'use strict';
/* Scrigno per Windows, macOS e Linux: finestra con la web app, Auto-Type, cartelle sincronizzate, Touch ID. */
const { app, BrowserWindow, Tray, Menu, ipcMain, protocol, net, shell, clipboard, dialog, globalShortcut, screen,
  systemPreferences, safeStorage, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const autotype = require('./autotype');

const WEB = path.join(__dirname, 'web');
let win = null, tray = null, quitting = false, pendingOAuth = null, hotkey = null;

// Preferenze del computer impostate dalla web app (Impostazioni › Generali e Sicurezza).
const prefsFile = () => path.join(app.getPath('userData'), 'desktop-prefs.json');
const PREFS_DEFAULT = { assistantDocked: false, tray: true, autostart: false, hotkey: 'A', lockOnClose: true, lockOnSuspend: true, lockOnUserSwitch: true, lockOnScreenLock: true, sysIdleMin: 5 };
let prefs = { ...PREFS_DEFAULT };
try { prefs = { ...PREFS_DEFAULT, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch { /* prima esecuzione */ }
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient('scrigno', process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient('scrigno');

// ---------------------------------------------------------------- ritorno OAuth (scrigno://oauth?...)
function handleDeepLink(url) {
  if (!url || !url.startsWith('scrigno://')) return;
  if (pendingOAuth) { pendingOAuth.resolve(url); pendingOAuth = null; }
  showWindow();
}
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });
app.on('second-instance', (e, argv) => {
  const link = argv.find(a => a.startsWith('scrigno://'));
  if (link) handleDeepLink(link); else showWindow();
});

// ---------------------------------------------------------------- finestra
function send(name, data) { if (win && !win.isDestroyed()) win.webContents.send('scrigno:event', name, data); }
function showWindow() {
  if (!win) return createWindow();
  if (assistantOn) endAssistant();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 380, minHeight: 520, show: false, title: 'Scrigno',
    backgroundColor: '#0c1317', icon: path.join(__dirname, 'build', 'tray.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadURL('app://scrigno/index.html');
  win.once('ready-to-show', () => { if (!(startHidden && prefs.tray)) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://scrigno/')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('close', e => {
    if (prefs.lockOnClose) send('lock');
    if (!quitting && prefs.tray) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; assistantOn = false; });
  win.on('blur', () => { if (assistantOn && !prefs.assistantDocked && win.isVisible() && !win.isMinimized()) setTimeout(() => { if (assistantOn && !win.isFocused()) win.hide(); }, 150); });
}

function createTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Scrigno');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Apri Scrigno', click: showWindow },
    { label: 'Assistente', click: startAssistant },
    { label: 'Blocca', click: () => send('lock') },
    { type: 'separator' },
    { label: 'Esci', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (assistantOn ? win.show() : showWindow()));
}

// ---------------------------------------------------------------- Assistente e Auto-Type
// La scorciatoia apre l'Assistente: la finestra diventa compatta e resta sopra le altre.
// In modalità ancorata non scompare quando si fa clic altrove.
let assistantOn = false, normalBounds = null;
async function startAssistant() {
  const title = await autotype.activeWindowTitle().catch(() => '');
  if (!win) createWindow();
  if (!assistantOn) {
    normalBounds = win.getBounds();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const w = 400, h = Math.min(600, area.height - 40);
    win.setMinimumSize(340, 420);
    win.setBounds({ x: area.x + area.width - w - 20, y: area.y + 20, width: w, height: h });
    win.setAlwaysOnTop(true, 'floating');
    win.setSkipTaskbar(true);
    assistantOn = true;
  }
  win.show(); win.focus();
  send('assistant', { title });
}
function endAssistant(show = true) {
  if (!assistantOn || !win) return;
  assistantOn = false;
  win.setAlwaysOnTop(false);
  win.setSkipTaskbar(false);
  win.setMinimumSize(380, 520);
  if (normalBounds) win.setBounds(normalBounds);
  send('assistantEnd');
  if (!show) win.hide();
}
function giveFocusBack() {
  if (assistantOn && prefs.assistantDocked) { if (process.platform === 'darwin') app.hide(); else { win.blur(); win.minimize(); } return; }
  if (process.platform === 'darwin') app.hide(); else if (win) { win.minimize(); win.hide(); }
}
function backAfterType() {
  if (assistantOn && prefs.assistantDocked && win) { win.restore(); win.showInactive(); }
}

// ---------------------------------------------------------------- funzioni chiamate dalla web app
const bioFile = () => path.join(app.getPath('userData'), 'bio.bin');
const iCloudDir = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
let clipTimer = null;

const methods = {
  async http({ url, method, headers, body }) {
    if (!/^https:\/\//.test(url)) throw new Error('Sono consentite solo connessioni HTTPS');
    const r = await net.fetch(url, { method, headers, body: body == null ? undefined : body, cache: 'no-store' });
    return { status: r.status, body: await r.text() };
  },
  async oauth({ url }) {
    if (!/^https:\/\//.test(url)) throw new Error('Indirizzo non valido');
    if (pendingOAuth) pendingOAuth.reject(new Error('Accesso annullato'));
    const p = new Promise((resolve, reject) => { pendingOAuth = { resolve, reject }; });
    await shell.openExternal(url);
    return p;
  },
  async oauthCancel() { if (pendingOAuth) { pendingOAuth.reject(new Error('Accesso annullato')); pendingOAuth = null; } return true; },
  async openUrl({ url }) { if (/^https?:\/\//.test(url)) await shell.openExternal(url); return true; },
  async copy({ text, clearSec }) {
    clipboard.writeText(text);
    clearTimeout(clipTimer);
    if (clearSec) clipTimer = setTimeout(() => { if (clipboard.readText() === text) clipboard.clear(); }, clearSec * 1000);
    return true;
  },
  async saveFile({ name, text, b64 }) {
    const ext = path.extname(name).slice(1);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), path.basename(name)), filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [] });
    if (r.canceled || !r.filePath) return false;
    await fs.promises.writeFile(r.filePath, b64 != null ? Buffer.from(b64, 'base64') : text);
    return true;
  },
  async folderPick() {
    const def = process.platform === 'darwin' && fs.existsSync(iCloudDir) ? iCloudDir : os.homedir();
    const r = await dialog.showOpenDialog(win, { title: 'Cartella sincronizzata per il vault', defaultPath: def, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    const label = dir.startsWith(iCloudDir) ? 'iCloud Drive' + dir.slice(iCloudDir.length) : dir;
    return { id: dir, label };
  },
  async folderRead({ id, name }) {
    try { return await fs.promises.readFile(path.join(id, path.basename(name)), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error('Cartella non leggibile: ' + e.message);
    }
  },
  async folderWrite({ id, name, text }) {
    const dest = path.join(id, path.basename(name));
    const tmp = dest + '.tmp-' + process.pid;
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, dest);
    return true;
  },
  async bioStatus() {
    const available = process.platform === 'darwin' && systemPreferences.canPromptTouchID() && safeStorage.isEncryptionAvailable();
    return { available, enrolled: available && fs.existsSync(bioFile()) };
  },
  async bioEnroll({ dek }) {
    await systemPreferences.promptTouchID('attivare lo sblocco di Scrigno con Touch ID');
    await fs.promises.writeFile(bioFile(), safeStorage.encryptString(dek));
    return true;
  },
  async bioUnlock() {
    await systemPreferences.promptTouchID('sbloccare Scrigno');
    return { dek: safeStorage.decryptString(await fs.promises.readFile(bioFile())) };
  },
  async bioDisable() { await fs.promises.rm(bioFile(), { force: true }); return true; },
  async session() { return true; },
  async lock() { return true; },
  async autotype({ username, password, enter }) {
    giveFocusBack();
    await new Promise(r => setTimeout(r, process.platform === 'darwin' ? 500 : 350));
    await autotype.typeLogin({ username, password, enter });
    backAfterType();
    return true;
  },
  async assistantEnd({ show }) { endAssistant(show !== false); if (show !== false) showWindow(); return true; },
  async clipboardRead() { return clipboard.readText(); },
  async autotypeCancel() { giveFocusBack(); return true; },
  async desktopPrefs(p) {
    prefs = { ...PREFS_DEFAULT, ...prefs, ...(p || {}) };
    await fs.promises.writeFile(prefsFile(), JSON.stringify(prefs));
    applyPrefs();
    return true;
  },
  async appInfo() { return { version: app.getVersion(), platform: process.platform }; },
  async openFolder({ dir }) { const d = backupDir(dir); await fs.promises.mkdir(d, { recursive: true }); await shell.openPath(d); return true; },
  async backupList({ dir }) {
    const d = backupDir(dir);
    let names = [];
    try { names = (await fs.promises.readdir(d)).filter(n => /^scrigno-backup-.*\.json$/.test(n)); } catch { names = []; }
    const files = [];
    for (const name of names) { try { files.push({ name, time: (await fs.promises.stat(path.join(d, name))).mtimeMs }); } catch { /* ignora */ } }
    return { defaultDir: backupDir(''), files };
  },
  async backupWrite({ dir, name, text, keep }) {
    const d = backupDir(dir);
    await fs.promises.mkdir(d, { recursive: true });
    await fs.promises.writeFile(path.join(d, path.basename(name)), text);
    const { files } = await methods.backupList({ dir });
    files.sort((a, b) => b.time - a.time);
    for (const f of files.slice(Math.max(1, +keep || 60))) await fs.promises.rm(path.join(d, f.name), { force: true });
    return true;
  },
  async backupRead({ dir, name }) {
    if (!/^scrigno-backup-.*\.json$/.test(path.basename(name))) throw new Error('Nome non valido');
    return fs.promises.readFile(path.join(backupDir(dir), path.basename(name)), 'utf8');
  },
};
const backupDir = dir => dir || path.join(app.getPath('userData'), 'Backups');

// ---------------------------------------------------------------- avvio con il sistema, scorciatoia, vassoio, blocco
function setAutostart(on) {
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'scrigno.desktop');
    const exe = process.env.APPIMAGE || process.execPath;
    try {
      if (on) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Scrigno\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\n`); }
      else fs.rmSync(file, { force: true });
    } catch (e) { console.warn('Avvio automatico non impostato:', e.message); }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--hidden'] });
}
function setHotkey(key) {
  const k = /^[A-Z]$/.test(key || '') ? key : 'A';
  const acc = 'CommandOrControl+Alt+' + k;
  if (hotkey === acc) return;
  if (hotkey) globalShortcut.unregister(hotkey);
  hotkey = globalShortcut.register(acc, startAssistant) ? acc : null;
  if (!hotkey) console.warn('Scorciatoia Auto-Type non disponibile:', acc);
}
function applyPrefs() {
  if (app.isPackaged) setAutostart(prefs.autostart);
  setHotkey(prefs.hotkey);
  if (prefs.tray) createTray(); else if (tray) { tray.destroy(); tray = null; }
}
let idleLocked = false;
function watchSystem() {
  powerMonitor.on('suspend', () => { if (prefs.lockOnSuspend) send('lock'); });
  powerMonitor.on('lock-screen', () => { if (prefs.lockOnScreenLock) send('lock'); });
  powerMonitor.on('user-did-resign-active', () => { if (prefs.lockOnUserSwitch) send('lock'); });
  setInterval(() => {
    const min = +prefs.sysIdleMin || 0;
    if (!min) return;
    const idle = powerMonitor.getSystemIdleTime();
    if (idle >= min * 60 && !idleLocked) { idleLocked = true; send('lock'); } else if (idle < 30) idleLocked = false;
  }, 15000);
}

ipcMain.handle('scrigno:call', async (e, method, args) => {
  if (!e.senderFrame || !e.senderFrame.url.startsWith('app://scrigno/')) throw new Error('Non consentito');
  const fn = methods[method];
  if (!fn) throw new Error('Funzione non disponibile: ' + method);
  return fn(args || {});
});

// ---------------------------------------------------------------- avvio
app.whenReady().then(() => {
  protocol.handle('app', req => {
    const u = new URL(req.url);
    const file = path.normalize(path.join(WEB, decodeURIComponent(u.pathname)));
    if (!file.startsWith(WEB)) return new Response('Non trovato', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
  ]) : null);
  createWindow();
  applyPrefs();
  watchSystem();
  const link = process.argv.find(a => a.startsWith('scrigno://'));
  if (link) handleDeepLink(link);
  app.on('activate', showWindow);
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (!prefs.tray) app.quit(); /* altrimenti resta nell'area di notifica */ });
