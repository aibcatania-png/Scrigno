'use strict';
/*
 * Ponte verso le app native (Android, iOS, desktop).
 * Nella web app normale Native.available è false e si usano le API del browser.
 */
const Native = (() => {
  const pending = new Map();
  const listeners = {};
  let seq = 0, call = null, platform = 'web';
  const g = typeof self !== 'undefined' ? self : globalThis;

  g.__scrignoEvent = (name, json) => {
    let data = null;
    try { data = json ? JSON.parse(json) : null; } catch { data = json; }
    (listeners[name] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
  };

  if (g.ScrignoAndroid) {
    platform = 'android';
    g.__scrignoReply = (id, ok, payload) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      let v = null;
      try { v = payload ? JSON.parse(payload) : null; } catch { v = payload; }
      if (ok) p.res(v); else p.rej(new Error((v && v.message) || String(v || 'Errore')));
    };
    call = (m, a) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      g.ScrignoAndroid.call(id, m, JSON.stringify(a === undefined ? null : a));
    });
  } else if (g.webkit && g.webkit.messageHandlers && g.webkit.messageHandlers.scrigno) {
    platform = 'ios';
    call = async (m, a) => {
      const r = await g.webkit.messageHandlers.scrigno.postMessage({ method: m, args: JSON.stringify(a === undefined ? null : a) });
      return r == null || r === '' ? null : JSON.parse(r);
    };
  } else if (g.scrignoElectron) {
    platform = g.scrignoElectron.platform; // 'win32' | 'darwin' | 'linux'
    call = (m, a) => g.scrignoElectron.call(m, a === undefined ? null : a);
    g.scrignoElectron.onEvent((name, data) => g.__scrignoEvent(name, JSON.stringify(data)));
  }

  return {
    available: !!call,
    platform,
    mobile: platform === 'android' || platform === 'ios',
    desktop: ['win32', 'darwin', 'linux'].includes(platform),
    call: (m, a) => (call ? call(m, a) : Promise.reject(new Error('Funzione disponibile solo nelle app'))),
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
  };
})();

// Archivio chiave/valore: file nativi su telefono (letti anche dalla compilazione automatica), IndexedDB altrove.
const store = Native.mobile ? {
  get: key => Native.call('kvGet', { key }),
  set: (key, value) => Native.call('kvSet', { key, value }),
  del: key => Native.call('kvDel', { key }),
} : idb;

// fetch senza limiti CORS nelle app native.
async function httpFetch(url, opt = {}) {
  if (!Native.available) return fetch(url, opt);
  let body = opt.body;
  const headers = { ...(opt.headers || {}) };
  if (body instanceof URLSearchParams) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = body.toString(); }
  const r = await Native.call('http', { url, method: opt.method || 'GET', headers, body: body == null ? null : String(body) });
  return {
    ok: r.status >= 200 && r.status < 300, status: r.status,
    text: async () => r.body || '',
    json: async () => JSON.parse(r.body || 'null'),
  };
}
