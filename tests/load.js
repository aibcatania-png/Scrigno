// Carica gli script del browser in un contesto Node per i test.
const fs = require('fs'), vm = require('vm'), path = require('path');
module.exports = function load(files, extra = {}) {
  const store = new Map();
  const ctx = vm.createContext({
    console, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, URL, URLSearchParams, setTimeout, clearTimeout,
    indexedDB: null, ...extra,
  });
  ctx.self = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  ctx.__store = store;
  vm.runInContext(`idb.get = async k => __store.has(k) ? JSON.parse(JSON.stringify(__store.get(k))) : undefined;
    idb.set = async (k, v) => { __store.set(k, JSON.parse(JSON.stringify(v))); }; idb.del = async k => { __store.delete(k); };`, ctx);
  return { ctx, R: code => vm.runInContext(code, ctx), store };
};
