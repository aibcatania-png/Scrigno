'use strict';
/*
 * Servizi cloud. Il file caricato è il vault già cifrato.
 * Cloud.env viene impostato da chi usa il modulo (web app, app native, estensione):
 *   fetch(url, opt)               richiesta HTTP
 *   redirect()                    URI di ritorno OAuth registrato presso il servizio
 *   begin()                       chiamato in modo sincrono al clic (es. apre il popup)
 *   authorize(handle, url, state) apre il login e restituisce i parametri di ritorno
 *   folder                        true se è disponibile la cartella sincronizzata
 */

const Cloud = { env: null };

async function pkcePair() {
  const verifier = b64u.to(rand(32));
  const challenge = b64u.to(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  return { verifier, challenge };
}
const oauthState = () => 'scrigno-' + b64u.to(rand(12));
const fileOf = c => c.fileName || FILE_NAME;

async function tokenRequest(url, params, label) {
  const r = await Cloud.env.fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.error_description || j.error || ''; } catch { /* ignora */ }
    throw new Error(`${label}: autorizzazione non riuscita (${r.status}) ${detail}`.trim());
  }
  return r.json();
}

const WebDAV = {
  name: 'WebDAV / Nextcloud',
  hdr(c) { return { Authorization: 'Basic ' + toB64(enc.encode(c.user + ':' + c.pass)) }; },
  async connect(cfg) {
    const c = { provider: 'webdav', url: (cfg.url || '').trim(), user: cfg.user || '', pass: cfg.pass || '' };
    if (!/^https:\/\//i.test(c.url)) throw new Error('L\'indirizzo WebDAV deve iniziare con https://');
    await this.download(c);
    return c;
  },
  async download(c) {
    let r;
    try { r = await Cloud.env.fetch(c.url, { headers: this.hdr(c), cache: 'no-store' }); } catch {
      throw new Error('Server WebDAV non raggiungibile: controlla l\'indirizzo e, nella web app, che il server consenta richieste dal browser (CORS).');
    }
    if (r.status === 404) return null;
    if (r.status === 401) throw new Error('WebDAV: utente o password errati.');
    if (!r.ok) throw new Error('WebDAV: errore ' + r.status);
    return r.json();
  },
  async upload(c, file) {
    const r = await Cloud.env.fetch(c.url, { method: 'PUT', headers: { ...this.hdr(c), 'Content-Type': 'application/json' }, body: JSON.stringify(file) });
    if (!r.ok) throw new Error('WebDAV: salvataggio non riuscito (' + r.status + ')');
  },
};

const Dropbox = {
  name: 'Dropbox',
  async connect(cfg, h) {
    if (!cfg.appKey) throw new Error('Inserisci la App key di Dropbox.');
    const { verifier, challenge } = await pkcePair();
    const state = oauthState();
    const redirect = Cloud.env.redirect();
    const p = await Cloud.env.authorize(h, 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: cfg.appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
      token_access_type: 'offline', redirect_uri: redirect, state,
    }), state);
    const tok = await tokenRequest('https://api.dropboxapi.com/oauth2/token',
      { code: p.code, grant_type: 'authorization_code', code_verifier: verifier, client_id: cfg.appKey, redirect_uri: redirect }, 'Dropbox');
    return { provider: 'dropbox', appKey: cfg.appKey, refresh: tok.refresh_token, access: tok.access_token, exp: now() + tok.expires_in * 1000 - 60000 };
  },
  async token(c) {
    if (c.access && c.exp > now()) return c.access;
    const tok = await tokenRequest('https://api.dropboxapi.com/oauth2/token', { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.appKey }, 'Dropbox');
    c.access = tok.access_token;
    c.exp = now() + tok.expires_in * 1000 - 60000;
    return c.access;
  },
  async download(c) {
    const r = await Cloud.env.fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: {
      Authorization: 'Bearer ' + await this.token(c), 'Dropbox-API-Arg': JSON.stringify({ path: '/' + fileOf(c) }) } });
    if (r.status === 409) return null;
    if (!r.ok) throw new Error('Dropbox: errore ' + r.status);
    return r.json();
  },
  async upload(c, file) {
    const r = await Cloud.env.fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: {
      Authorization: 'Bearer ' + await this.token(c), 'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: '/' + fileOf(c), mode: 'overwrite', mute: true }) }, body: JSON.stringify(file) });
    if (!r.ok) throw new Error('Dropbox: salvataggio non riuscito (' + r.status + ')');
  },
};

const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const MS_SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const MS_FILE = c => `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${encodeURIComponent(fileOf(c))}:/content`;
const OneDrive = {
  name: 'OneDrive',
  async connect(cfg, h) {
    if (!cfg.clientId) throw new Error('Inserisci l\'ID applicazione Microsoft.');
    const { verifier, challenge } = await pkcePair();
    const state = oauthState();
    const redirect = Cloud.env.redirect();
    const p = await Cloud.env.authorize(h, MS_AUTH + '/authorize?' + new URLSearchParams({
      client_id: cfg.clientId, response_type: 'code', redirect_uri: redirect, scope: MS_SCOPE,
      code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account',
    }), state);
    const tok = await tokenRequest(MS_AUTH + '/token', { client_id: cfg.clientId, grant_type: 'authorization_code', code: p.code,
      redirect_uri: redirect, code_verifier: verifier, scope: MS_SCOPE }, 'OneDrive');
    return { provider: 'onedrive', clientId: cfg.clientId, refresh: tok.refresh_token, access: tok.access_token, exp: now() + tok.expires_in * 1000 - 60000 };
  },
  async token(c) {
    if (c.access && c.exp > now()) return c.access;
    const tok = await tokenRequest(MS_AUTH + '/token', { client_id: c.clientId, grant_type: 'refresh_token', refresh_token: c.refresh, scope: MS_SCOPE }, 'OneDrive')
      .catch(e => { throw Object.assign(new Error('Accesso a OneDrive scaduto: ricollega il servizio nelle impostazioni. ' + e.message), { code: 'reauth' }); });
    c.access = tok.access_token;
    c.refresh = tok.refresh_token || c.refresh;
    c.exp = now() + tok.expires_in * 1000 - 60000;
    return c.access;
  },
  async download(c) {
    const r = await Cloud.env.fetch(MS_FILE(c), { headers: { Authorization: 'Bearer ' + await this.token(c) }, cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('OneDrive: errore ' + r.status);
    return r.json();
  },
  async upload(c, file) {
    const r = await Cloud.env.fetch(MS_FILE(c), { method: 'PUT', headers: { Authorization: 'Bearer ' + await this.token(c), 'Content-Type': 'text/plain' }, body: JSON.stringify(file) });
    if (!r.ok) throw new Error('OneDrive: salvataggio non riuscito (' + r.status + ')');
  },
};

const reauthErr = () => Object.assign(new Error('Accesso a Google Drive scaduto: premi “Riconnetti” nelle impostazioni.'), { code: 'reauth' });
const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = 'https://oauth2.googleapis.com/token';
const G_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
/*
 * Con il "Client secret" Scrigno usa il flusso con codice (PKCE + refresh token): l'accesso
 * resta valido senza ricollegarsi. Senza secret ripiega sul flusso implicito (token di un'ora).
 */
const GDrive = {
  name: 'Google Drive',
  async connect(cfg, h) {
    if (!cfg.clientId) throw new Error('Inserisci il Client ID di Google.');
    const state = oauthState();
    const redirect = Cloud.env.redirect();
    if (!cfg.clientSecret) {
      const d = await Cloud.env.authorize(h, G_AUTH + '?' + new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: redirect, response_type: 'token', scope: G_SCOPE, state,
      }), state);
      if (!d.access_token) throw new Error('Google non ha restituito l\'accesso.');
      return { provider: 'gdrive', clientId: cfg.clientId, access: d.access_token, exp: now() + (+d.expires_in || 3600) * 1000 - 60000 };
    }
    const { verifier, challenge } = await pkcePair();
    const p = await Cloud.env.authorize(h, G_AUTH + '?' + new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirect, response_type: 'code', scope: G_SCOPE, state,
      access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256',
    }), state);
    if (!p.code) throw new Error('Google non ha restituito l\'autorizzazione.');
    const tok = await tokenRequest(G_TOKEN, { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code',
      code: p.code, redirect_uri: redirect, code_verifier: verifier }, 'Google Drive');
    return { provider: 'gdrive', clientId: cfg.clientId, clientSecret: cfg.clientSecret, refresh: tok.refresh_token,
      access: tok.access_token, exp: now() + (+tok.expires_in || 3600) * 1000 - 60000 };
  },
  async token(c) {
    if (c.access && c.exp > now()) return c.access;
    if (!c.refresh || !c.clientSecret) throw reauthErr();
    const tok = await tokenRequest(G_TOKEN, { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: c.refresh }, 'Google Drive')
      .catch(e => { throw Object.assign(new Error('Accesso a Google Drive scaduto: premi “Riconnetti” nelle impostazioni. ' + e.message), { code: 'reauth' }); });
    c.access = tok.access_token;
    c.refresh = tok.refresh_token || c.refresh;
    c.exp = now() + (+tok.expires_in || 3600) * 1000 - 60000;
    return c.access;
  },
  async api(c, url, opt = {}) {
    const auth = async () => ({ ...(opt.headers || {}), Authorization: 'Bearer ' + await this.token(c) });
    let r = await Cloud.env.fetch(url, { ...opt, headers: await auth() });
    if (r.status === 401) {
      c.access = null;
      if (!c.refresh) throw reauthErr();
      r = await Cloud.env.fetch(url, { ...opt, headers: await auth() });
      if (r.status === 401) throw reauthErr();
    }
    if (!r.ok && r.status !== 404) throw new Error('Google Drive: errore ' + r.status);
    return r;
  },
  async fileId(c) {
    if (c.fileId) return c.fileId;
    const r = await this.api(c, 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
      spaces: 'appDataFolder', q: `name='${fileOf(c)}'`, fields: 'files(id)' }));
    const j = await r.json();
    return (c.fileId = (j.files && j.files[0] && j.files[0].id) || null);
  },
  async download(c) {
    const id = await this.fileId(c);
    if (!id) return null;
    const r = await this.api(c, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
    if (r.status === 404) { c.fileId = null; return null; }
    return r.json();
  },
  async upload(c, file) {
    const id = await this.fileId(c);
    if (id) {
      await this.api(c, `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(file) });
      return;
    }
    const b = 'scrigno' + b64u.to(rand(9));
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fileOf(c), parents: ['appDataFolder'] })}` +
      `\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(file)}\r\n--${b}--`;
    const r = await this.api(c, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
    c.fileId = (await r.json()).id;
  },
};

// Cartella sincronizzata dal sistema: iCloud Drive, oppure la cartella di OneDrive/Dropbox sul computer.
const Folder = {
  name: 'iCloud Drive o cartella sincronizzata',
  async connect() {
    const f = await Native.call('folderPick');
    if (!f) throw new Error('Nessuna cartella scelta.');
    return { provider: 'folder', folder: f.id, label: f.label };
  },
  async download(c) {
    const t = await Native.call('folderRead', { id: c.folder, name: fileOf(c) });
    return t ? JSON.parse(t) : null;
  },
  async upload(c, file) { await Native.call('folderWrite', { id: c.folder, name: fileOf(c), text: JSON.stringify(file) }); },
};

const PROVIDERS = { dropbox: Dropbox, onedrive: OneDrive, gdrive: GDrive, webdav: WebDAV, folder: Folder };
const OAUTH_PROVIDERS = ['dropbox', 'onedrive', 'gdrive'];
const providerList = () => Object.keys(PROVIDERS).filter(k => k !== 'folder' || (Cloud.env && Cloud.env.folder));

// Da chiamare direttamente nel gestore del clic (il popup della web app va aperto prima di ogni await).
function connectCloud(cfg) {
  let h = null;
  try { if (OAUTH_PROVIDERS.includes(cfg.provider)) h = Cloud.env.begin(); } catch (e) { return Promise.reject(e); }
  return PROVIDERS[cfg.provider].connect(cfg, h).finally(() => { if (h && h.close) h.close(); });
}

/*
 * Una sincronizzazione completa: scarica, unisce, ricarica se serve.
 * ctx = { file, dek, items, cfg }  →  { items, changedLocal, uploaded }
 */
async function cloudSync(ctx) {
  const P = PROVIDERS[ctx.cfg.provider];
  const remote = await P.download(ctx.cfg);
  if (!remote) {
    await P.upload(ctx.cfg, ctx.file);
    return { items: ctx.items, changedLocal: false, uploaded: true };
  }
  const m = await vaultMerge(ctx.file, ctx.dek, ctx.items, remote);
  if (m.changedLocal || m.updateOther) await vaultWrite(ctx.file, ctx.dek, m.items);
  if (m.updateOther) await P.upload(ctx.cfg, ctx.file);
  return { items: m.items, changedLocal: m.changedLocal, uploaded: m.updateOther };
}

// Configurazione cloud per un altro file sullo stesso servizio (vault aggiuntivi).
function cloudCfgForFile(cfg, fileName) {
  const c = clone(cfg);
  delete c.fileId; delete c.lastSync;
  c.fileName = fileName;
  if (c.provider === 'webdav') c.url = c.url.replace(/[^/]*$/, fileName);
  return c;
}
