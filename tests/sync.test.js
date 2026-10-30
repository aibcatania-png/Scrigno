// Due dispositivi sullo stesso cloud (WebDAV finto): ogni elemento nuovo arriva sull'altro,
// gli errori si vedono e ogni dispositivo compare nell'elenco dei dispositivi.
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
const PW = 'una-frase-molto-lunga-42';
(async () => {
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const dav = new Map();
  let davDown = false, davDelay = 0;
  const route = async r => {
    const u = r.request().url(), m = r.request().method();
    const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS' };
    if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: h });
    if (davDown) return r.fulfill({ status: 503, headers: h, body: '' });
    if (davDelay && m === 'GET') await new Promise(res => setTimeout(res, davDelay));
    if (m === 'PUT') { dav.set(u, r.request().postData()); return r.fulfill({ status: 201, headers: h, body: '' }); }
    return dav.has(u) ? r.fulfill({ status: 200, headers: h, contentType: 'application/json', body: dav.get(u) }) : r.fulfill({ status: 404, headers: h, body: '' });
  };
  const errors = [];
  const dev = async (w) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 860 } });
    await ctx.route('https://dav.test/**', route);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept());
    await p.goto(base);
    return p;
  };
  const cloudForm = async (p, scope = '') => {
    await p.selectOption(scope + ' [data-role=prov]', 'webdav');
    await p.fill(scope + ' [data-c=url]', 'https://dav.test/u/scrigno-vault.json');
    await p.fill(scope + ' [data-c=user]', 'u'); await p.fill(scope + ' [data-c=pass]', 'p');
  };
  // aspetta che il dispositivo abbia caricato nel cloud la sua versione
  const uploaded = async p => {
    for (let i = 0; i < 100; i++) {
      const st = await p.evaluate(() => ({ up: S.file.updatedAt, busy: syncing || syncPending }));
      const cloud = dav.size ? JSON.parse([...dav.values()][0]).updatedAt : 0;
      if (!st.busy && cloud === st.up) return true;
      await p.waitForTimeout(100);
    }
    return false;
  };
  const login = async (p, t) => {
    await p.click('[data-act=new]'); await p.click('[data-act=newtype][data-k=login]');
    await p.fill('input[name=title]', t); await p.fill('input[name=f_username]', 'u-' + t); await p.fill('input[name=f_password]', 'Pw-' + t + '-123!');
    await p.click('#editForm button[type=submit]'); await p.waitForSelector('.detail .field');
  };
  // PC: crea il vault e lo collega al cloud
  const pc = await dev(1280);
  await pc.fill('input[name=pw]', PW); await pc.fill('input[name=pw2]', PW); await pc.check('input[name=ack]'); await pc.click('button[type=submit]');
  await pc.waitForSelector('.shell', { timeout: 20000 });
  await pc.click('[data-act=section][data-k=settings]'); await pc.click('.stabs [data-k=vault]');
  await cloudForm(pc, '.sbody'); await pc.click('[data-act=connect-cloud]');
  await pc.waitForSelector('text=Collegato a');
  // Telefono: scarica il vault dal cloud
  const ph = await dev(400);
  await ph.click('[data-act=setup-tab][data-k=cloud]');
  await cloudForm(ph); await ph.click('[data-act=setup-cloud]');
  await ph.waitForSelector('#mp'); await ph.fill('#mp', PW); await ph.click('#unlockForm button[type=submit]');
  await ph.waitForSelector('.shell', { timeout: 20000 });
  for (const [n, p] of [['PC', pc], ['PH', ph]]) await p.evaluate(n => { const d = PROVIDERS.webdav.download.bind(PROVIDERS.webdav), u = PROVIDERS.webdav.upload.bind(PROVIDERS.webdav); window.__log = [];
    PROVIDERS.webdav.download = async c => { const r = await d(c); __log.push(n + ' down ' + (r && r.updatedAt) + ' @' + Date.now()); return r; };
    PROVIDERS.webdav.upload = async (c, f) => { await u(c, f); __log.push(n + ' up ' + f.updatedAt + ' @' + Date.now()); }; }, n);
  // nuovo elemento sul PC → arriva sul telefono
  await pc.click('[data-act=section][data-k=all]');
  await login(pc, 'Kenamobile');
  await pc.waitForFunction(() => live().some(i => i.title === 'Kenamobile'));
  await pc.waitForTimeout(100);
  ok(await uploaded(pc), 'PC: elemento caricato nel cloud');
  await ph.evaluate(() => syncNow(true));
  await ph.waitForFunction(() => live().some(i => i.title === 'Kenamobile'), null, { timeout: 10000 }).then(() => ok(true, 'elemento del PC arrivato sul telefono'), async () => {
    ok(false, 'elemento del PC arrivato sul telefono');
    console.log('PC', await pc.evaluate(() => JSON.stringify({ st: S.syncState, err: S.syncErr, pend: syncPending, items: S.items.map(i => i.type + ':' + i.title), up: S.file.updatedAt })));
    console.log('PH', await ph.evaluate(() => JSON.stringify({ st: S.syncState, err: S.syncErr, pend: syncPending, syncing, items: S.items.map(i => i.type + ':' + i.title), up: S.file.updatedAt })));
    console.log((await pc.evaluate(() => __log)).concat(await ph.evaluate(() => __log)).sort((a, b) => +a.split('@')[1] - +b.split('@')[1]).join('\n'));
    console.log('DAV', [...dav.keys()], JSON.parse([...dav.values()][0]).updatedAt);
  });
  // nuovo elemento sul telefono, l'app va subito in secondo piano → inviato lo stesso
  await login(ph, 'Banca');
  await ph.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await ph.waitForTimeout(100);
  ok(await uploaded(ph), 'telefono: elemento caricato nel cloud anche andando in secondo piano');
  await pc.evaluate(() => syncNow(true));
  await pc.waitForFunction(() => live().some(i => i.title === 'Banca'), null, { timeout: 10000 }).then(() => ok(true, 'elemento del telefono arrivato sul PC'), async () => {
    ok(false, 'elemento del telefono arrivato sul PC');
    console.log((await pc.evaluate(() => __log)).concat(await ph.evaluate(() => __log)).sort((a, b) => +a.split('@')[1] - +b.split('@')[1]).join('\n'));
    console.log('PC', await pc.evaluate(() => JSON.stringify({ st: S.syncState, pend: syncPending, syncing, items: S.items.map(i => i.type + ':' + i.title), up: S.file.updatedAt })));
    console.log('PH', await ph.evaluate(() => JSON.stringify({ st: S.syncState, pend: syncPending, syncing, items: S.items.map(i => i.type + ':' + i.title), up: S.file.updatedAt })));
    console.log('DAV', JSON.parse([...dav.values()][0]).updatedAt);
  });
  // elenco dei dispositivi
  await pc.click('[data-act=section][data-k=settings]'); await pc.click('.stabs [data-k=vault]');
  const devs = await pc.$$eval('.devlist .srow b', b => b.map(x => x.textContent));
  ok(devs.length === 2, 'entrambi i dispositivi elencati: ' + devs.join(' | '));
  // errore visibile anche nelle sincronizzazioni automatiche
  davDown = true;
  await pc.click('[data-act=section][data-k=all]');
  await login(pc, 'Durante il guasto');
  await pc.waitForSelector('.syncbar', { timeout: 10000 }).then(() => ok(true, 'barra di errore di sincronizzazione visibile'), () => ok(false, 'barra di errore di sincronizzazione visibile'));
  davDown = false;
  await pc.click('.syncbar [data-act=sync]');
  await pc.waitForFunction(() => !document.querySelector('.syncbar'), null, { timeout: 10000 }).then(() => ok(true, 'dopo “Riprova” la barra sparisce'), () => ok(false, 'dopo “Riprova” la barra sparisce'));
  await ph.evaluate(() => syncNow(true));
  await ph.waitForFunction(() => live().some(i => i.title === 'Durante il guasto'), null, { timeout: 10000 }).then(() => ok(true, 'elemento creato durante il guasto arrivato dopo'), () => ok(false, 'elemento creato durante il guasto arrivato dopo'));
  // salvataggi contemporanei su due dispositivi: nessun elemento si perde
  await ph.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); });
  davDelay = 400;
  await pc.evaluate(() => { const it = makeItem('login', 'Insieme PC', { username: 'a' }); S.items.push(it); return persist(); });
  await ph.evaluate(() => { const it = makeItem('login', 'Insieme telefono', { username: 'b' }); S.items.push(it); return persist(); });
  await Promise.all([pc.evaluate(() => syncNow(true)), ph.evaluate(() => syncNow(true))]);
  davDelay = 0;
  const both = p => p.waitForFunction(() => ['Insieme PC', 'Insieme telefono'].every(t => live().some(i => i.title === t)), null, { timeout: 30000 }).then(() => true, () => false);
  ok(await both(pc) && await both(ph), 'salvataggi contemporanei: entrambi gli elementi su entrambi i dispositivi');
  ok(!errors.length, 'nessun errore JS ' + errors.join(' | '));
  await browser.close(); srv.close();
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
