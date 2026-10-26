// Prova l'interfaccia in Chromium: web app normale e con un finto ponte nativo Android.
const { chromium } = require(process.env.PW || 'playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, s) => {
  const p = path.join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  fs.readFile(p, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); s.end(d); } });
}).listen(0);
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
(async () => {
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  for (const mode of ['web', 'android', 'desktop']) {
    const page = await browser.newPage({ viewport: { width: mode === 'web' ? 1280 : 400, height: 850 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    if (mode === 'android') {
      await page.addInitScript(() => {
        const kv = {};
        window.__calls = [];
        window.ScrignoAndroid = { call(id, m, a) {
          const args = JSON.parse(a); window.__calls.push(m);
          let res = null;
          if (m === 'kvGet') res = kv[args.key] ?? null;
          else if (m === 'kvSet') kv[args.key] = args.value;
          else if (m === 'kvDel') delete kv[args.key];
          else if (m === 'bioStatus') res = { available: true, enrolled: false };
          setTimeout(() => window.__scrignoReply(id, true, JSON.stringify(res)), 0);
        } };
      });
    }
    if (mode === 'desktop') {
      await page.addInitScript(() => {
        window.__calls = [];
        window.scrignoElectron = {
          platform: 'linux',
          call: async (m, a) => { window.__calls.push([m, a]); return m === 'bioStatus' ? { available: false, enrolled: false } : null; },
          onEvent: cb => { window.__fire = cb; },
        };
      });
    }
    await page.goto(base);
    await page.fill('input[name=pw]', 'una-frase-molto-lunga-42');
    await page.fill('input[name=pw2]', 'una-frase-molto-lunga-42');
    await page.check('input[name=ack]');
    await page.click('button[type=submit]');
    await page.waitForSelector('.shell', { timeout: 20000 });
    ok(true, `${mode}: vault creato`);
    await page.click('[data-act=new]');
    await page.click('[data-act=newtype][data-k=login]');
    await page.fill('input[name=title]', 'Posta');
    await page.fill('input[name=f_username]', 'mario@example.com');
    await page.fill('input[name=f_password]', 'Tr0ub4dor&3-x');
    await page.fill('input[name=f_url]', 'mail.example.com');
    await page.fill('input[name=f_totp]', 'JBSWY3DPEHPK3PXP');
    await page.click('#editForm button[type=submit]');
    await page.waitForSelector('.totp');
    await page.waitForFunction(() => /\d{3} \d{3}/.test(document.querySelector('.totp').textContent));
    ok(true, `${mode}: login salvato e codice 2FA mostrato`);
    for (const s of ['audit', 'gen', 'settings']) {
      await page.click(`[data-act=section][data-k=${s}]`);
      await page.waitForSelector('.pagewrap');
    }
    ok(await page.isVisible('.stabs [data-k=general].on'), `${mode}: impostazioni a sezioni`);
    for (const t of ['general', 'security', 'look', 'autofill', 'backup', 'advanced', 'about', 'vault']) {
      await page.click(`.stabs [data-k=${t}]`);
      await page.waitForSelector(`.stabs [data-k=${t}].on`);
    }
    ok(await page.isVisible('text=Sincronizzazione del vault principale'), `${mode}: sezione Vault`);
    const provs = await page.$$eval('[data-role=prov] option', o => o.map(x => x.value));
    ok(provs.includes('onedrive') && provs.includes('dropbox'), `${mode}: servizi cloud ${provs.join(',')}`);
    await page.selectOption('[data-role=prov]', 'onedrive');
    ok(await page.isVisible('input[data-c=clientId]'), `${mode}: campi OneDrive`);
    await page.click('.stabs [data-k=autofill]');
    if (mode === 'android') {
      ok(await page.isVisible('text=Imposta compilazione automatica'), 'android: scheda compilazione automatica');
      const calls = await page.evaluate(() => window.__calls);
      ok(calls.includes('session') && calls.includes('kvSet'), 'android: chiave condivisa e vault salvato nel file nativo');
    }
    if (mode === 'desktop') {
      ok(await page.isVisible('text=Ctrl Alt A'), 'desktop: istruzioni Auto-Type');
      await page.evaluate(() => window.__fire('autotype', { title: 'Posta in arrivo - mail.example.com - Firefox' }));
      await page.waitForSelector('#atDlg [data-at]');
      await page.click('#atDlg [data-at]');
      await page.waitForTimeout(200);
      const at = await page.evaluate(() => window.__calls.find(c => c[0] === 'autotype'));
      ok(at && at[1].username === 'mario@example.com' && at[1].password === 'Tr0ub4dor&3-x' && at[1].enter, 'desktop: Auto-Type invia utente e password');
    }
    await page.click('[data-act=lock]');
    await page.fill('#mp', 'una-frase-molto-lunga-42');
    await page.click('#unlockForm button[type=submit]');
    await page.waitForSelector('.shell', { timeout: 20000 });
    ok(await page.locator('.row b', { hasText: 'Posta' }).isVisible(), `${mode}: riaperto dopo il blocco`);
    const vw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    ok(vw[0] <= vw[1], `${mode}: nessuno scorrimento orizzontale ${vw}`);
    const inView = async sel => { const b = await page.locator(sel).boundingBox(); return b && b.x >= 0 && b.x + b.width <= vw[1] + 1; };
    ok(await inView('[data-act=new]') && await inView('[data-act=lock]'), `${mode}: pulsanti dentro lo schermo`);
    await page.screenshot({ path: path.join(__dirname, `shot-${mode}.png`) });
    ok(errors.length === 0, `${mode}: nessun errore JS ${errors.join(' | ')}`);
    await page.close();
  }
  await browser.close();
  srv.close();
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
