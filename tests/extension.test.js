// Prova l'estensione in Chromium: creazione vault, compilazione, salvataggio login, passkey.
const { chromium } = require(process.env.PW || 'playwright');
const http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const EXT = path.join(__dirname, '..', 'dist', 'extension', 'chromium');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const LOGIN = `<!doctype html><title>Login</title><form id="f" action="/done" method="post">
<input name="email" type="email" autocomplete="username"><input name="pw" type="password" autocomplete="current-password"><button>Entra</button></form>`;
const DONE = '<!doctype html><title>Fatto</title><p>ok</p>';
const PASSKEY = `<!doctype html><title>Passkey</title><button id="reg">Registra</button><script>
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
window.reg = async () => {
  const c = await navigator.credentials.create({ publicKey: { rp: { name: 'Prova', id: 'localhost' }, user: { id: new Uint8Array([1,2,3]), name: 'mario', displayName: 'Mario' },
    challenge: new Uint8Array([9,9,9,9]), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required' } } });
  window.pub = c.response.getPublicKey();
  return { id: c.id, type: c.type, inst: c instanceof PublicKeyCredential, cd: JSON.parse(new TextDecoder().decode(c.response.clientDataJSON)), alg: c.response.getPublicKeyAlgorithm(), json: !!c.toJSON().response.attestationObject };
};
window.login = async () => {
  const chal = new Uint8Array([7,7,7]);
  const a = await navigator.credentials.get({ publicKey: { challenge: chal, rpId: 'localhost' } });
  const key = await crypto.subtle.importKey('spki', window.pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const der = new Uint8Array(a.response.signature);
  const rl = der[3], r = der.slice(4, 4 + rl), sl = der[5 + rl], s = der.slice(6 + rl, 6 + rl + sl);
  const fix = x => { x = x[0] === 0 && x.length > 32 ? x.slice(1) : x; const o = new Uint8Array(32); o.set(x, 32 - x.length); return o; };
  const raw = new Uint8Array([...fix(r), ...fix(s)]);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', a.response.clientDataJSON));
  const ad = new Uint8Array(a.response.authenticatorData);
  const okSig = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, new Uint8Array([...ad, ...h]));
  const cd = JSON.parse(new TextDecoder().decode(a.response.clientDataJSON));
  return { okSig, cd, user: new Uint8Array(a.response.userHandle).join(','), chal: b64u(chal) };
};
</script>`;

(async () => {
  const srv = http.createServer((q, s) => {
    s.writeHead(200, { 'Content-Type': 'text/html' });
    s.end(q.url.startsWith('/passkey') ? PASSKEY : q.url.startsWith('/done') ? DONE : LOGIN);
  }).listen(0);
  const base = `http://localhost:${srv.address().port}`;
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'scr-')), {
    headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  ok(true, 'service worker avviato');
  const extId = sw.url().split('/')[2];
  ok(extId === require('../scrigno.config.json').chromeId, 'ID estensione fisso ' + extId);
  ctx.on('page', p => p.on('pageerror', e => errors.push(p.url() + ' ' + e.message)));

  // opzioni: crea vault
  const opt = await ctx.newPage();
  opt.on('pageerror', e => errors.push('options ' + e.message));
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.fill('input[name=pw]', 'frase-lunga-di-prova-42');
  await opt.fill('input[name=pw2]', 'frase-lunga-di-prova-42');
  await opt.click('#createForm button');
  await opt.waitForSelector('#q');
  ok(true, 'vault creato dalle opzioni');
  // generatore nel popup/opzioni
  await opt.click('[data-a=view][data-k=gen]');
  await opt.waitForSelector('#genOut');
  ok((await opt.textContent('#genOut')).length === 20, 'estensione: generatore casuale');
  await opt.click('[data-a=gmode][data-k=words]');
  await opt.waitForSelector('[data-a=gmode][data-k=words].on');
  ok((await opt.textContent('#genOut')).split('-').length === 5, 'estensione: generatore pronunciabile');
  await opt.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await opt.click('[data-a=gen-copy]');
  await opt.waitForSelector('.hrow');
  ok(true, 'estensione: cronologia generatore');
  if (process.env.SHOTS) await opt.screenshot({ path: path.join(process.env.SHOTS, 'ext-gen.png') });
  await opt.click('[data-a=gmode][data-k=random]');
  await opt.click('[data-a=view][data-k=list]');
  await opt.waitForSelector('#q');

  // CDP per cliccare dentro lo shadow DOM chiuso
  async function clickShadowText(page, text) {
    const cdp = await page.context().newCDPSession(page);
    for (let i = 0; i < 40; i++) {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      let found = null;
      const walk = n => {
        if (found) return;
        if (n.nodeType === 3 && n.nodeValue.trim() === text) found = n;
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
      };
      walk(root);
      if (found) {
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: found.backendNodeId }).catch(() => cdp.send('DOM.getBoxModel', { nodeId: found.parentId }));
        const q = model.content;
        await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
        return true;
      }
      await page.waitForTimeout(150);
    }
    return false;
  }

  // salvataggio login
  const pg = await ctx.newPage();
  await pg.goto(base + '/login');
  await pg.fill('input[name=email]', 'mario@example.com');
  await pg.fill('input[name=pw]', 'Segreta!2024');
  await pg.click('button');
  await pg.waitForURL(/done/);
  ok(await clickShadowText(pg, 'Salva'), 'barra “Salvare questo login” mostrata dopo la navigazione');
  await pg.waitForTimeout(500);
  const items = await opt.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'items', url: location.href })).r);
  ok(items.some(i => i.sub === 'mario@example.com'), 'login salvato nel vault');

  // compilazione dal menu
  await pg.goto(base + '/login');
  await pg.click('input[name=email]');
  ok(await clickShadowText(pg, 'localhost'), 'menu di compilazione mostrato');
  await pg.waitForTimeout(300);
  const vals = await pg.evaluate(() => [document.querySelector('[name=email]').value, document.querySelector('[name=pw]').value]);
  ok(vals[0] === 'mario@example.com' && vals[1] === 'Segreta!2024', 'campi compilati ' + vals);

  // preferenze: accesso automatico e sito ignorato
  await opt.evaluate(async () => chrome.runtime.sendMessage({ type: 'afSet', patch: { autoSubmit: true } }));
  await pg.goto(base + '/login');
  await pg.click('input[name=email]');
  await clickShadowText(pg, 'localhost');
  await pg.waitForURL(/done/, { timeout: 5000 }).then(() => ok(true, 'accesso automatico dopo la compilazione'), () => ok(false, 'accesso automatico dopo la compilazione'));
  await opt.evaluate(async () => chrome.runtime.sendMessage({ type: 'afSet', patch: { autoSubmit: false, ignore: ['localhost'] } }));
  await pg.goto(base + '/login');
  await pg.click('input[name=email]');
  await pg.waitForTimeout(700);
  const menuShown = await pg.evaluate(() => !!document.querySelector('scrigno-ui'));
  ok(!menuShown, 'nessun menu sui siti ignorati');
  await opt.evaluate(async () => chrome.runtime.sendMessage({ type: 'afSet', patch: { ignore: [] } }));

  // passkey: creazione
  const pk = await ctx.newPage();
  pk.on('pageerror', e => errors.push('passkey ' + e.message));
  await pk.goto(base + '/passkey');
  const regP = pk.evaluate(() => window.reg());
  const prompt1 = await ctx.waitForEvent('page');
  await prompt1.waitForSelector('[data-a=create]');
  await prompt1.click('[data-a=create]');
  const reg = await regP;
  ok(reg.type === 'public-key' && reg.inst && reg.alg === -7 && reg.json, 'passkey creata ' + JSON.stringify(reg));
  ok(reg.cd.origin === base && reg.cd.type === 'webauthn.create' && reg.cd.challenge === 'CQkJCQ', 'clientDataJSON creazione');
  // passkey: accesso
  const logP = pk.evaluate(() => window.login());
  const prompt2 = await ctx.waitForEvent('page');
  await prompt2.waitForSelector('[data-a=use]');
  await prompt2.click('[data-a=use]');
  const log = await logP;
  ok(log.okSig && log.cd.origin === base && log.cd.challenge === log.chal && log.user === '1,2,3', 'accesso con passkey, firma valida ' + JSON.stringify(log));

  // blocco e sblocco
  await opt.evaluate(() => chrome.runtime.sendMessage({ type: 'lock' }));
  await opt.reload();
  await opt.fill('#mp', 'frase-lunga-di-prova-42');
  await opt.click('#unlockForm button');
  await opt.waitForSelector('#q');
  ok((await opt.textContent('#lst')).includes('localhost'), 'sblocco e lista');
  ok(errors.length === 0, 'nessun errore JS ' + errors.join(' | '));
  await ctx.close();
  srv.close();
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
