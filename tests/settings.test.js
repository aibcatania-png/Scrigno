// Impostazioni in stile Enpass: tema, icone dei siti, PIN, campi visibili, contatori, compilazione, backup, aggiornamenti.
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVR42mNk+M9Qz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC', 'base64');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const icons = [];
  await ctx.route('https://icons.duckduckgo.com/**', r => { icons.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
  await ctx.route('https://api.github.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/x/y/releases/tag/v99.0.0', assets: [] }) }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.evaluate(() => { self.SCRIGNO_CONFIG.repo = 'x/y'; });
  await page.fill('input[name=pw]', PW); await page.fill('input[name=pw2]', PW);
  await page.check('input[name=ack]'); await page.click('button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 20000 });
  const login = async (t, u, p, url) => {
    await page.click('[data-act=new]'); await page.click('[data-act=newtype][data-k=login]');
    await page.fill('input[name=title]', t); await page.fill('input[name=f_username]', u);
    await page.fill('input[name=f_password]', p); await page.fill('input[name=f_url]', url);
    await page.click('#editForm button[type=submit]'); await page.waitForSelector('.detail .field');
  };
  await login('GitHub', 'mario', 'Gh-pass-1234!x', 'https://github.com/login');
  await login('Banca', 'mrossi', 'Banca-pass-99!', 'https://banca.example.it');
  await page.waitForFunction(() => document.querySelectorAll('.row .ricon.hasfav').length >= 2);
  ok(icons.some(u => u.includes('/ip3/github.com.ico')), 'icone dei siti scaricate per dominio');
  // impostazioni: personalizza
  await page.click('[data-act=section][data-k=settings]');
  await page.click('.stabs [data-k=look]');
  if (shots) await page.screenshot({ path: path.join(shots, 'set-look.png') });
  await page.click('[data-act=set-theme][data-k=dark]');
  ok(await page.evaluate(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor !== 'rgb(243, 246, 250)'), 'tema scuro');
  await page.click('[data-act=set-theme][data-k=system]');
  await page.click('.srow:has([data-pref=showCounts]) .switch');
  await page.click('.srow:has([data-pref=favicons]) .switch');
  await page.click('[data-act=section][data-k=all]');
  ok(!(await page.$('.nav .cnt:not(.warn)')), 'contatori nascosti');
  ok(!(await page.$('.row .favimg')), 'icone dei siti disattivate');
  // sicurezza: campi visibili e PIN
  await page.click('[data-act=section][data-k=settings]');
  await page.click('.stabs [data-k=security]');
  await page.click('.srow:has([data-pref=hideSecrets]) .switch');
  await page.click('[data-act=pin-on]');
  await page.fill('#pinSetForm [name=pin]', '2580'); await page.fill('#pinSetForm [name=pin2]', '2580');
  await page.click('#pinSetForm button[type=submit]');
  await page.waitForSelector('[data-act=pin-off]');
  if (shots) await page.screenshot({ path: path.join(shots, 'set-security.png') });
  await page.click('[data-act=section][data-k=all]');
  await page.click('.row:has-text("GitHub")');
  ok((await page.textContent('.detail')).includes('Gh-pass-1234!x'), 'campi sensibili visibili quando “Nascondi” è disattivo');
  await page.click('[data-act=lock]');
  await page.waitForSelector('#pinIn');
  await page.fill('#pinIn', '1111'); await page.click('#pinForm button[type=submit]');
  await page.waitForSelector('#unlockErr:not([hidden])');
  ok((await page.textContent('#unlockErr')).includes('Tentativi rimasti: 4'), 'PIN errato: tentativi contati');
  await page.fill('#pinIn', '2580'); await page.click('#pinForm button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 20000 });
  ok(true, 'sblocco con il PIN');
  // ricerca in tutto il vault
  await page.click('[data-act=section][data-k=card]');
  await page.fill('#q', 'banca');
  ok((await page.textContent('#items')).includes('Banca'), 'ricerca in tutti gli elementi anche da un\'altra categoria');
  await page.fill('#q', '');
  // compilazione: sito ignorato e preferenza
  await page.click('[data-act=section][data-k=settings]');
  await page.click('.stabs [data-k=autofill]');
  await page.fill('#ignoreForm [name=d]', 'https://www.Banca.example.it/login');
  await page.click('#ignoreForm button');
  await page.waitForSelector('.chip:has-text("banca.example.it")');
  await page.click('.srow:has([data-af=exactMatch]) .switch');
  const prefs = await page.evaluate(() => afPrefs(S.items));
  ok(prefs.exactMatch === true && prefs.ignore.includes('banca.example.it'), 'preferenze di compilazione salvate nel vault');
  // backup
  await page.click('.stabs [data-k=backup]');
  await page.click('[data-act=bk-now]');
  await page.waitForSelector('[data-act=bk-restore]');
  await page.click('[data-act=section][data-k=all]');
  await login('Nuovo dopo il backup', 'x', 'Altro-pass-777!', 'https://nuovo.example.com');
  await page.click('[data-act=section][data-k=settings]');
  await page.click('.stabs [data-k=backup]');
  await page.locator('[data-act=bk-restore]').first().click();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({ live: live().map(i => i.title), trash: trashedItems().map(i => i.title), prefs: afPrefs(S.items).exactMatch }));
  ok(!after.live.includes('Nuovo dopo il backup') && after.trash.includes('Nuovo dopo il backup') && after.live.includes('GitHub') && after.prefs, 'ripristino del backup (gli elementi nuovi vanno nel cestino)');
  if (shots) await page.screenshot({ path: path.join(shots, 'set-backup.png') });
  // aggiornamenti
  await page.click('.stabs [data-k=advanced]');
  await page.click('[data-act=upd-check]');
  await page.waitForSelector('.upd-banner');
  ok((await page.textContent('.upd-banner')).includes('99.0.0'), 'avviso di aggiornamento');
  // telefono: schede orizzontali senza scorrimento della pagina
  await page.setViewportSize({ width: 390, height: 800 });
  await page.click('.stabs [data-k=general]');
  const vw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  ok(vw[0] <= vw[1], 'impostazioni su telefono senza scorrimento orizzontale ' + vw);
  if (shots) await page.screenshot({ path: path.join(shots, 'set-mobile.png') });
  ok(!errors.length, 'nessun errore JS ' + errors.join(' | '));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
