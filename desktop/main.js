'use strict';
/* Scrigno per Windows, macOS e Linux: finestra con la web app, Auto-Type, cartelle sincronizzate, Touch ID. */
const { app, BrowserWindow, Tray, Menu, ipcMain, protocol, net, shell, clipboard, dialog, globalShortcut,
  systemPreferences, safeStorage, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const autotype = require('./autotype');

const WEB = path.join(__dirname, 'web');
const HOTKEY = 'CommandOrControl+Alt+A';
let win = null, tray = null, quitting = false, pendingOAuth = null;

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
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://scrigno/')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Scrigno');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Apri Scrigno', click: showWindow },
    { label: 'Blocca', click: () => send('lock') },
    { type: 'separator' },
    { label: 'Esci', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------------------------------------------------------------- Auto-Type
async function startAutotype() {
  const title = await autotype.activeWindowTitle();
  showWindow();
  send('autotype', { title });
}
function giveFocusBack() {
  if (process.platform === 'darwin') app.hide(); else if (win) { win.minimize(); win.hide(); }
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
    return true;
  },
  async autotypeCancel() { giveFocusBack(); return true; },
};

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
  createTray();
  if (!globalShortcut.register(HOTKEY, startAutotype)) console.warn('Scorciatoia Auto-Type non disponibile:', HOTKEY);
  const link = process.argv.find(a => a.startsWith('scrigno://'));
  if (link) handleDeepLink(link);
  app.on('activate', showWindow);
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* resta nell'area di notifica */ });
