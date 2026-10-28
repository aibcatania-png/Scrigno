// Generatore nella modifica, cronologia, condivisione di elementi, Assistente del computer.
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
const shots = process.env.SHOTS;
const PW = 'una-frase-molto-lunga-42';
async function newVault(page) {
  await page.fill('input[name=pw]', PW); await page.fill('input[name=pw2]', PW);
  await page.check('input[name=ack]'); await page.click('button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 20000 });
}
(async () => {
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const errors = [];
  // ---- mittente
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const a = await ctxA.newPage();
  a.on('pageerror', e => errors.push('A ' + e.message)); a.on('dialog', d => d.accept());
  await a.goto(base); await newVault(a);
  await a.click('[data-act=new]'); await a.click('[data-act=newtype][data-k=login]');
  await a.fill('input[name=title]', 'Kenamobile'); await a.fill('input[name=f_username]', '3801234567');
  await a.fill('input[name=f_url]', 'https://auth.kenamobile.it/login');
  ok(await a.isVisible('[data-act=gen-dlg]') && await a.isVisible('[data-act=gen-hist-dlg]'), 'sotto la password: Genera e Cronologia del generatore');
  await a.click('[data-act=gen-dlg]');
  await a.waitForSelector('.gendlg #gdOut');
  await a.click('.gendlg [data-gmode=words]');
  const proposed = await a.textContent('#gdOut');
  if (shots) await a.screenshot({ path: path.join(shots, 'x-gen.png') });
  await a.click('.gendlg [data-guse]');
  const val = await a.inputValue('input[name=f_password]');
  ok(val === proposed && val.split('-').length === 5, 'generatore nella modifica: password pronunciabile inserita ' + val);
  await a.click('[data-act=gen-hist-dlg]');
  await a.waitForSelector('dialog .genhist');
  ok((await a.textContent('dialog .genhist')).includes(val.slice(0, 6)) && (await a.textContent('dialog .genhist')).includes('kenamobile.it'), 'cronologia del generatore con sito');
  if (shots) await a.screenshot({ path: path.join(shots, 'x-hist.png') });
  await a.click('dialog [data-gx]');
  await a.click('#editForm button[type=submit]'); await a.waitForSelector('.detail .field');
  // condividi
  await a.click('[data-act=share-item]');
  await a.waitForSelector('#shKey');
  await a.fill('#shKey', 'chiave-di-prova-77');
  await a.click('[data-smake]');
  await a.waitForSelector('.sharedlg textarea');
  const link = await a.inputValue('.sharedlg textarea');
  if (shots) await a.screenshot({ path: path.join(shots, 'x-share.png') });
  ok(/#share=scrigno-share:1\./.test(link) && !link.includes('3801234567'), 'link cifrato creato (nessun dato in chiaro)');
  // ---- destinatario senza vault: legge dal browser
  const ctxB = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const b = await ctxB.newPage();
  b.on('pageerror', e => errors.push('B ' + e.message)); b.on('dialog', d => d.accept());
  await b.goto(base + '#share=' + link.split('#share=')[1]);
  await b.waitForSelector('#rKey');
  await b.fill('#rKey', 'sbagliata'); await b.click('#recvForm button');
  await b.waitForSelector('#rErr:not([hidden])');
  ok((await b.textContent('#rErr')).includes('Chiave errata'), 'chiave sbagliata rifiutata');
  await b.fill('#rKey', 'chiave-di-prova-77'); await b.click('#recvForm button');
  await b.waitForSelector('#shareRecv .fields');
  ok((await b.textContent('#shareRecv')).includes('3801234567'), 'destinatario senza Scrigno vede l\'elemento');
  if (shots) await b.screenshot({ path: path.join(shots, 'x-recv.png') });
  await b.click('[data-rx]');
  // ---- destinatario con vault: incolla il link e aggiunge
  await newVault(b);
  await b.click('[data-act=section][data-k=settings]'); await b.click('.stabs [data-k=vault]');
  await b.click('[data-act=share-receive]');
  await b.fill('dialog input', 'Ecco: ' + link);
  await b.click('dialog button[value=ok]');
  await b.waitForSelector('#rKey');
  await b.fill('#rKey', 'chiave-di-prova-77'); await b.click('#recvForm button');
  await b.click('[data-radd]');
  await b.waitForSelector('.detail h2');
  ok((await b.textContent('.detail h2')) === 'Kenamobile' && (await b.evaluate(() => live().length)) === 1, 'elemento aggiunto al vault del destinatario');
  // ---- Assistente del computer
  const c = await browser.newPage({ viewport: { width: 400, height: 600 } });
  c.on('pageerror', e => errors.push('C ' + e.message)); c.on('dialog', d => d.accept());
  await c.addInitScript(() => {
    window.__calls = [];
    window.scrignoElectron = { platform: 'linux', call: async (m, x) => { window.__calls.push([m, x]); return m === 'bioStatus' ? { available: false } : m === 'backupList' ? { defaultDir: '/tmp', files: [] } : null; }, onEvent: cb => { window.__fire = cb; } };
  });
  await c.goto(base); await newVault(c);
  await c.click('[data-act=new]'); await c.click('[data-act=newtype][data-k=login]');
  await c.fill('input[name=title]', 'Posta'); await c.fill('input[name=f_username]', 'mario@example.com');
  await c.fill('input[name=f_password]', 'Pass-mail-1234'); await c.fill('input[name=f_url]', 'mail.example.com');
  await c.click('#editForm button[type=submit]'); await c.waitForSelector('.detail .field');
  await c.evaluate(() => window.__fire('assistant', { title: 'Accedi - mail.example.com - Thunderbird' }));
  await c.waitForSelector('.assistant .as-row');
  if (shots) await c.screenshot({ path: path.join(shots, 'x-assistant.png') });
  await c.click('.assistant [data-act=as-dock]');
  ok(await c.evaluate(() => window.__calls.some(([m, x]) => m === 'desktopPrefs' && x.assistantDocked === true)), 'Assistente ancorato');
  await c.click('.assistant [data-act=as-type]');
  await c.waitForTimeout(200);
  const at = await c.evaluate(() => window.__calls.find(([m]) => m === 'autotype'));
  ok(at && at[1].username === 'mario@example.com' && at[1].password === 'Pass-mail-1234', 'Assistente: Compila digita il login');
  await c.keyboard.press('Escape');
  await c.waitForSelector('.shell');
  ok(await c.evaluate(() => window.__calls.some(([m]) => m === 'assistantEnd')), 'Assistente chiuso con Esc');
  ok(!errors.length, 'nessun errore JS ' + errors.join(' | '));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
