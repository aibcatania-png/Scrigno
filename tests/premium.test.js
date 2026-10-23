// Prova in Chromium le funzioni “Premium”: violazioni, 2FA/passkey, cronologia, allegati, modelli, cestino, più vault, keyfile.
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
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.route('https://api.pwnedpasswords.com/range/*', r => r.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' },
    body: r.request().url().endsWith('5BAA6') ? '1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n' : 'AAAA:1\r\n' }));
  await ctx.route('https://api.2fa.directory/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify([['Google', { domain: 'google.com', documentation: 'https://support.google.com/' }]]) }));
  await ctx.route('https://passkeys-api.2fa.directory/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ 'google.com': { passwordless: 'allowed' } }) }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const base = `http://127.0.0.1:${srv.address().port}/`;
  await page.goto(base);
  await page.fill('input[name=pw]', PW); await page.fill('input[name=pw2]', PW);
  await page.check('input[name=ack]'); await page.click('button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 20000 });

  const newLogin = async (title, user, pw, url) => {
    await page.click('[data-act=new]');
    await page.click('[data-act=newtype][data-k=login]');
    await page.fill('input[name=title]', title);
    await page.fill('input[name=f_username]', user);
    await page.fill('input[name=f_password]', pw);
    await page.fill('input[name=f_url]', url);
    await page.click('#editForm button[type=submit]');
    await page.waitForSelector('.detail .dtitle');
  };
  await newLogin('Google', 'mario@gmail.com', 'password', 'accounts.google.com');
  await page.waitForSelector('#toast.show:has-text("violazioni")', { timeout: 5000 }).catch(() => {});
  ok(/violazioni/.test(await page.textContent('#toast')), 'avviso violazione al salvataggio');

  // cronologia
  await page.click('[data-act=edit]');
  await page.fill('input[name=f_password]', 'Nuova-Password-Sicura-2026!');
  await page.click('#editForm button[type=submit]');
  await page.waitForSelector('details.hist');
  ok((await page.textContent('details.hist summary')).includes('(1)'), 'cronologia: password precedente conservata');

  // allegato
  await page.click('[data-act=edit]');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act=att-add]')]);
  await chooser.setFiles({ name: 'tessera.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(root, 'icons', 'icon-192.png')) });
  await page.waitForSelector('#attList .att');
  await page.click('#editForm button[type=submit]');
  await page.waitForSelector('.detail .atts .att');
  ok((await page.textContent('.detail .atts')).includes('tessera.png') && await page.isVisible('.detail .atts img'), 'allegato salvato con anteprima');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act=att-save]')]);
  ok(fs.statSync(await dl.path()).size === fs.statSync(path.join(root, 'icons', 'icon-192.png')).size, 'allegato scaricato identico');

  // sicurezza: violazioni e 2FA/passkey
  await page.click('[data-act=section][data-k=audit]');
  await page.click('[data-act=check-pwned]');
  await page.waitForSelector('text=Password trovate in violazioni');
  ok(await page.isVisible('text=Password trovate in violazioni'), 'controllo violazioni completato');
  await page.click('[data-act=load-dirs]');
  await page.waitForSelector('text=Verifica in due passaggi disponibile');
  const auditText = await page.textContent('.pagewrap');
  ok(/Verifica in due passaggi disponibile\s*1/.test(auditText) && /Passkey disponibili\s*1/.test(auditText), 'monitoraggio 2FA e passkey');

  // modello personalizzato
  await page.click('[data-act=section][data-k=settings]');
  await page.click('[data-act=tpl-new]');
  await page.fill('#tplForm input[name=title]', 'Palestra');
  await page.fill('#tplForm [data-t=label]', 'Numero tessera');
  await page.click('[data-act=tpl-add-field]');
  await page.fill('#tplForm .tplrow:nth-child(2) [data-t=label]', 'Codice ingresso');
  await page.selectOption('#tplForm .tplrow:nth-child(2) [data-t=kind]', 'secret');
  await page.click('#tplForm button[type=submit]');
  await page.click('[data-act=section][data-k=all]');
  await page.click('[data-act=new]');
  await page.click('.typecard:has-text("Palestra")');
  await page.fill('input[name=title]', 'FitLife');
  await page.fill('#editForm input[type=text]:not([name=title])', '12345');
  await page.click('#editForm button[type=submit]');
  await page.waitForSelector('.detail .dtitle:has-text("FitLife")');
  ok(await page.isVisible('.nav-btn:has-text("Palestra")') && (await page.textContent('.detail')).includes('Numero tessera'), 'elemento creato da modello personalizzato');

  // cestino
  await page.click('[data-act=delete]');
  await page.click('[data-act=section][data-k=trash]');
  await page.click('.row:has-text("FitLife")');
  await page.click('[data-act=restore]');
  await page.click('[data-act=section][data-k=all]');
  ok(await page.isVisible('.row:has-text("FitLife")'), 'cestino: elemento ripristinato');

  // secondo vault
  await page.click('[data-act=section][data-k=settings]');
  await page.click('summary:has-text("Nuovo vault")');
  await page.fill('#newVaultForm input[name=name]', 'Lavoro');
  await page.fill('#newVaultForm input[name=pw]', 'frase-del-lavoro-99');
  await page.fill('#newVaultForm input[name=pw2]', 'frase-del-lavoro-99');
  await page.click('#newVaultForm button[type=submit]');
  await page.waitForSelector('.vrow:has-text("Lavoro")');
  await page.click('[data-act=section][data-k=all]');
  ok(await page.isVisible('#vaultSel'), 'selettore dei vault');
  await newLogin('Intranet', 'mrossi', 'Intr4net-Lavoro!', 'intranet.azienda.it');
  await page.selectOption('#vaultSel', 'all');
  ok((await page.textContent('#items')).includes('Lavoro'), 'elemento nel vault Lavoro');

  // keyfile
  await page.click('[data-act=section][data-k=settings]');
  const dlP = page.waitForEvent('download');
  await page.click('[data-act=kf-gen]');
  await page.fill('dialog input[type=password]', PW);
  await page.click('dialog button[value=ok]');
  const kfDl = await dlP;
  ok(kfDl.suggestedFilename() === 'scrigno.keyfile', 'keyfile generato e scaricato');
  await page.waitForSelector('text=Attivo: per sbloccare');
  // blocco e sblocco: keyfile memorizzato
  await page.click('[data-act=lock]');
  ok((await page.textContent('#kfState')).includes('memorizzato'), 'sblocco: keyfile memorizzato');
  await page.fill('#mp', PW); await page.click('#unlockForm button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.selectOption('#vaultSel', 'all');
  ok((await page.textContent('#items')).includes('Intranet'), 'dopo lo sblocco anche il vault Lavoro è aperto');
  // senza keyfile non si apre, con il file scelto sì
  await page.click('[data-act=lock]');
  await page.click('[data-act=forget-kf]');
  await page.fill('#mp', PW); await page.click('#unlockForm button[type=submit]');
  await page.waitForSelector('#unlockErr:not([hidden])');
  ok((await page.textContent('#unlockErr')).includes('keyfile'), 'senza keyfile lo sblocco è rifiutato');
  const [kfc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act=pick-kf]')]);
  await kfc.setFiles(await kfDl.path());
  await page.fill('#mp', PW); await page.click('#unlockForm button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 20000 });
  ok(true, 'sblocco con keyfile scelto');
  await page.screenshot({ path: path.join(__dirname, 'shot-premium.png') });
  ok(errors.length === 0, 'nessun errore JS ' + errors.join(' | '));
  await browser.close();
  srv.close();
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
