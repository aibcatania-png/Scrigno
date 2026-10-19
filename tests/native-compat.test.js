// Verifica che i file scritti dal codice nativo (Kotlin o Swift) siano leggibili dalla web app.
// Uso: node tests/native-compat.test.js <cartella> <kt|swift>
const load = require('./load');
const fs = require('fs'), path = require('path');
const dir = process.argv[2], prefix = process.argv[3] || 'kt';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
(async () => {
  const { ctx, R } = load(['web/js/core.js', 'web/js/passkey.js']);
  ctx.__f = JSON.parse(fs.readFileSync(path.join(dir, `${prefix}-vault.json`), 'utf8'));
  const items = await R(`vaultUnlock(__f, 'fixture-password-123').then(d => vaultRead(__f, d))`);
  ok(items.length >= 3 && items.some(i => i.f.username === 'bob') && items.some(i => i.f.username === 'alice'), `${prefix}: vault scritto dal codice nativo letto dalla web app`);
  const kp = JSON.parse(fs.readFileSync(path.join(dir, `${prefix}-passkey.json`), 'utf8'));
  ctx.__kp = kp;
  ctx.__cdh = new Uint8Array(32).fill(7);
  const a = await R(`passkeyAssert({ privateKey: __kp.privateKey, rpId: 'example.com', clientDataHash: __cdh })`);
  const pub = await crypto.subtle.importKey('spki', Buffer.from(kp.spki, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const der = a.signature, rl = der[3], r = der.slice(4, 4 + rl), sl = der[5 + rl], s = der.slice(6 + rl, 6 + rl + sl);
  const fix = x => { x = x[0] === 0 && x.length > 32 ? x.slice(1) : x; const o = new Uint8Array(32); o.set(x, 32 - x.length); return o; };
  ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, new Uint8Array([...fix(r), ...fix(s)]), new Uint8Array([...a.authenticatorData, ...ctx.__cdh])),
    `${prefix}: passkey creata dal codice nativo usata da WebCrypto`);
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
