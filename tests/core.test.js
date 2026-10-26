const load = require('./load');
let fails = 0;
const __kv_has_kf = f => !!(f.kdf && f.kdf.keyfile);
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
(async () => {
  const { ctx, R } = load(['web/js/core.js', 'web/js/words.js', 'web/js/native.js', 'web/js/cloud.js', 'web/js/passkey.js', 'web/js/vaults.js']);
  // TOTP RFC 6238
  ctx.__sec = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [t, exp] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']])
    ok(await R(`totp({secret:__sec,digits:8,period:30,algorithm:'SHA-1'},${t}000)`) === exp, `TOTP t=${t}`);
  // vault
  const v = await R(`vaultCreate('cavallo-batteria-graffetta-42')`);
  ctx.__v = v;
  R(`__items=[makeItem('login','Banca',{username:'mario',password:'123456',url:'https://www.banca.it/login'})]`);
  await R(`vaultWrite(__v.file,__v.dek,__items)`);
  ok(!JSON.stringify(v.file).includes('mario'), 'nessun dato in chiaro');
  let bad = false; try { await R(`vaultUnlock(__v.file,'x')`); } catch (e) { bad = e.message === 'Password errata'; } ok(bad, 'password errata');
  const dek2 = await R(`vaultUnlock(__v.file,'cavallo-batteria-graffetta-42')`); ctx.__d2 = dek2;
  ok((await R(`vaultRead(__v.file,__d2)`))[0].f.username === 'mario', 'sblocco');
  await R(`vaultChangePassword(__v.file,__v.dek,'cavallo-batteria-graffetta-42','nuova-frase-lunga-99')`);
  ok(!!(await R(`vaultUnlock(__v.file,'nuova-frase-lunga-99')`)), 'cambio password');
  // merge tra due copie
  R(`__other=JSON.parse(JSON.stringify(__v.file))`);
  R(`__items2=[...__items, makeItem('note','Nota',{notes:'x'})]`);
  await R(`vaultWrite(__other,__v.dek,__items2)`);
  const m = await R(`vaultMerge(__v.file,__v.dek,__items,__other)`);
  ok(m.items.length === 2 && m.changedLocal && !m.updateOther, 'merge copia più nuova');
  // cloudSync con provider in memoria
  R(`__cloud=null; PROVIDERS.mem={download:async()=>__cloud&&JSON.parse(JSON.stringify(__cloud)),upload:async(c,f)=>{__cloud=JSON.parse(JSON.stringify(f))}}`);
  let r = await R(`cloudSync({file:__v.file,dek:__v.dek,items:__items,cfg:{provider:'mem'}})`);
  ok(r.uploaded && R('__cloud'), 'primo caricamento');
  r = await R(`cloudSync({file:JSON.parse(JSON.stringify(__other)),dek:__v.dek,items:__items2,cfg:{provider:'mem'}})`);
  ok(r.uploaded, 'altro dispositivo carica le novità');
  r = await R(`cloudSync({file:__v.file,dek:__v.dek,items:__items,cfg:{provider:'mem'}})`);
  ok(r.changedLocal && r.items.length === 2, 'primo dispositivo riceve le novità');
  // matching
  ctx.__ml = R(`[makeItem('login','A',{url:'https://accounts.google.com'}), makeItem('login','B',{url:'banca.it'}), makeItem('login','C',{},[{label:APP_FIELD,value:'com.app.x'}])]`);
  ok(R(`matchLogins(__ml,{host:'mail.google.com'}).length`) === 1, 'match dominio');
  ok(R(`matchLogins(__ml,{host:'www.banca.it'})[0].title`) === 'B', 'match www');
  ok(R(`matchLogins(__ml,{pkg:'com.app.x'})[0].title`) === 'C', 'match app Android');
  ok(R(`baseDomain('a.b.co.uk')`) === 'b.co.uk', 'baseDomain SLD');
  ok(R(`rpIdAllowed('google.com','accounts.google.com')`) && !R(`rpIdAllowed('com','x.com')`) && !R(`rpIdAllowed('evil.com','google.com')`), 'rpId');
  // import
  ctx.__csv = 'name,url,username,password,note\n"Posta, personale",mail.it,me,"p""w",ciao\nGit,github.com,dev,xyz,';
  const ci = R('importCSV(__csv)'); ok(ci.length === 2 && ci[0].f.password === 'p"w', 'CSV');
  ctx.__en = { items: [{ title: 'Amazon', category: 'login', favorite: 1, fields: [{ type: 'username', value: 'u' }, { type: 'password', value: 'pp' }, { type: 'text', value: 'q', label: 'D', sensitive: 1 }] }] };
  ok(R('importEnpass(__en)')[0].f.password === 'pp', 'Enpass');
  // passkey
  const pk = await R(`passkeyCreate({rpId:'example.com',userId:'dXNlcg',userName:'mario'})`);
  ok(pk.attestationObject[0] === 0xa3 && pk.credentialId.length === 16, 'attestazione CBOR');
  ok(pk.authenticatorData[32] === 0x5d, 'flag creazione');
  ctx.__pk = pk;
  // decodifica CBOR dell'attestazione e confronto della chiave COSE con quella SPKI
  const cbor = (b, o = 0) => {
    const ib = b[o++], mt = ib >> 5, ai = ib & 31;
    let n = ai;
    if (ai === 24) n = b[o++]; else if (ai === 25) { n = (b[o] << 8) | b[o + 1]; o += 2; } else if (ai === 26) { n = ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; o += 4; }
    if (mt === 0) return [n, o]; if (mt === 1) return [-1 - n, o];
    if (mt === 2) return [b.slice(o, o + n), o + n]; if (mt === 3) return [new TextDecoder().decode(b.slice(o, o + n)), o + n];
    if (mt === 4) { const a = []; for (let i = 0; i < n; i++) { let v; [v, o] = cbor(b, o); a.push(v); } return [a, o]; }
    if (mt === 5) { const m = new Map(); for (let i = 0; i < n; i++) { let k, v; [k, o] = cbor(b, o); [v, o] = cbor(b, o); m.set(k, v); } return [m, o]; }
    throw new Error('cbor ' + mt);
  };
  const [att] = cbor(pk.attestationObject);
  const ad = att.get('authData');
  const cl = (ad[53] << 8) | ad[54];
  const [cose, end] = cbor(ad, 55 + cl);
  const jwk = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('spki', pk.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']));
  const b64u = u => Buffer.from(u).toString('base64url');
  ok(att.get('fmt') === 'none' && att.get('attStmt').size === 0 && end === ad.length, 'struttura attestationObject');
  ok(cose.get(1) === 2 && cose.get(3) === -7 && cose.get(-1) === 1 && b64u(cose.get(-2)) === jwk.x && b64u(cose.get(-3)) === jwk.y, 'chiave COSE uguale alla SPKI');
  ok(b64u(ad.slice(55, 55 + cl)) === pk.fields.credentialId, 'credentialId in authData');
  ctx.__cdh = await R(`sha256(clientDataJSON('webauthn.get','Y2hhbA','https://example.com'))`);
  const as = await R(`passkeyAssert({privateKey:__pk.fields.privateKey,rpId:'example.com',clientDataHash:__cdh})`);
  // verifica firma con la chiave pubblica SPKI
  const der = as.signature; const rl = der[3]; const rr = der.slice(4, 4 + rl); const sl = der[5 + rl]; const ss = der.slice(6 + rl, 6 + rl + sl);
  const fix = b => { b = b[0] === 0 && b.length > 32 ? b.slice(1) : b; const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
  const raw = new Uint8Array([...fix(rr), ...fix(ss)]);
  const pub = await crypto.subtle.importKey('spki', pk.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const data = new Uint8Array([...as.authenticatorData, ...ctx.__cdh]);
  ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, raw, data), 'firma passkey verificata');
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('example.com')));
  ok(as.authenticatorData.slice(0, 32).every((b, i) => b === rpHash[i]) && as.authenticatorData[32] === 0x1d, 'authenticatorData asserzione');
  // keyfile
  ctx.__kfa = await R(`keyfileHash(new TextEncoder().encode('keyfile A'))`);
  ctx.__kfb = await R(`keyfileHash(new TextEncoder().encode('keyfile B'))`);
  const kv = await R(`vaultCreate('frase-kf-lunga-1', __kfa)`); ctx.__kv = kv;
  ok(kv.file.kdf.keyfile === true, 'keyfile: flag nel file');
  let e1 = null; try { await R(`vaultUnlock(__kv.file, 'frase-kf-lunga-1')`); } catch (e) { e1 = e.code; } ok(e1 === 'keyfile', 'keyfile: richiesto');
  let e2 = false; try { await R(`vaultUnlock(__kv.file, 'frase-kf-lunga-1', __kfb)`); } catch { e2 = true; } ok(e2, 'keyfile: sbagliato rifiutato');
  ok(!!(await R(`vaultUnlock(__kv.file, 'frase-kf-lunga-1', __kfa)`)), 'keyfile: corretto accettato');
  await R(`vaultChangePassword(__kv.file, __kv.dek, 'frase-kf-lunga-1', 'frase-kf-lunga-1', __kfa, null)`);
  ok(!__kv_has_kf(kv.file) && !!(await R(`vaultUnlock(__kv.file, 'frase-kf-lunga-1')`)), 'keyfile: disattivato');
  // cestino e cronologia
  R(`__t=[makeItem('login','A',{password:'x'}), makeItem('login','B',{password:'y'})]; trashItem(__t[0]); __t[0].trashed = now() - 31*864e5`);
  ok(R(`purgeTrash(__t)`) && R(`__t[0].deleted && !__t[1].deleted`), 'cestino: svuotato dopo 30 giorni');
  ok(R(`matchLogins([trashItem(makeItem('login','C',{url:'c.it'}))],{host:'c.it'}).length`) === 0, 'cestino: esclusi dalla compilazione');
  const h = R(`(()=>{const o=makeItem('login','H',{password:'old1'}); const n={...o,f:{password:'new1'}}; return withHistory(o,n);})()`);
  ok(h.history.length === 1 && h.history[0].password === 'old1', 'cronologia password');
  // modelli
  R(`__tp=[makeItem('_template','Palestra',{icon:'🏋️',fields:JSON.stringify([['n','Numero tessera','secret'],['s','Scadenza','text']])})]`);
  const at = R(`allTypes(__tp)`);
  const tk = Object.keys(at).find(k => k.startsWith('tpl:'));
  ok(tk && at[tk].label === 'Palestra' && at[tk].fields[0][2] === 'secret' && at[tk].fields[1][2] === undefined && at.wifi, 'modelli personalizzati e predefiniti');
  ok(!R(`isActive(__tp[0])`), 'modelli nascosti dagli elenchi');
  // più vault
  const xv = await R(`createExtraVault({ name: 'Lavoro', password: 'frase-lavoro-lunga', cloudCfg: { provider: 'webdav', url: 'https://x/dav/scrigno-vault.json', user: 'u', pass: 'p' } })`);
  ctx.__xv = xv;
  ok(xv.cfg.url.endsWith(`scrigno-${xv.id}.json`) && xv.key.type === '_vaultkey', 'vault aggiuntivo: config cloud su file separato');
  R(`__xv.items.push(makeItem('login','Intranet',{username:'me',url:'intra.net'}))`);
  await R(`idb.set(vaultFileKey(__xv.id), __xv.file)`);
  await R(`saveExtraVault(idb, __xv)`);
  const op = await R(`openExtraVault(idb, __xv.key)`);
  ok(op.items.length === 1 && op.items[0].title === 'Intranet' && op.name === 'Lavoro', 'vault aggiuntivo: riaperto con la chiave del principale');
  ok(!!(await R(`vaultUnlock(__xv.file, 'frase-lavoro-lunga')`)), 'vault aggiuntivo: apribile anche con la sua password');
  ok(R(`cloudCfgForFile({provider:'dropbox',fileId:'x',appKey:'k'},'a.json')`).fileName === 'a.json', 'cloud: nome file per vault');
  // generatore in stile Enpass
  for (let k = 0; k < 200; k++) {
    const pw = R(`genPassword({ length: 12, minUpper: 2, minDigits: 3, minSymbols: 2 })`);
    if (pw.length !== 12 || (pw.match(/[A-Z]/g) || []).length < 2 || (pw.match(/\d/g) || []).length < 3 || (pw.match(/[^A-Za-z0-9]/g) || []).length < 2 || !/[a-z]/.test(pw)) { ok(false, 'generatore: minimi rispettati ' + pw); break; }
    if (k === 199) ok(true, 'generatore: lunghezza e minimi di maiuscole, cifre e simboli');
  }
  const amb = Array.from({ length: 100 }, () => R(`genPassword({ length: 40, noAmbig: true, exclude: '#$' })`)).join('');
  ok(!/[Il1|O0o#$]/.test(amb), 'generatore: niente caratteri ambigui o esclusi');
  ok(/^[a-z]+$/.test(R(`genPassword({ length: 30, upper: false, digits: false, symbols: false })`)), 'generatore: solo minuscole');
  ok(R(`genPassword({ length: 200 })`).length === 100 && R(`genPassword({ length: 1 })`).length === 4, 'generatore: lunghezza 4–100');
  const ph = R(`genPassword({ mode: 'words', words: 5, sep: '-', wordCaps: true, wordDigit: true, lang: 'it' })`);
  const parts = ph.split('-');
  ok(parts.length === 5 && parts.every(w => /^[A-Z][a-z]+\d?$/.test(w)) && (ph.match(/\d/g) || []).length === 1, 'pronunciabile: 5 parole con iniziale maiuscola e una cifra ' + ph);
  ok(R(`WORDLISTS.it.includes(${JSON.stringify(parts[0].replace(/\d/, '').toLowerCase())})`), 'pronunciabile: parole italiane');
  ok(/^[a-z]+(\d[a-z]+){2}$/.test(R(`genPassword({ mode: 'words', words: 3, sep: '#digit', wordCaps: false, wordDigit: false, lang: 'en' })`)), 'pronunciabile: separatore cifra casuale');
  ok(R(`genBits({ mode: 'words', words: 4, wordDigit: false, lang: 'it' })`) === 52 && R(`genBits({ length: 20 })`) > 120, 'generatore: entropia');
  R(`__gh = []; genHistoryAdd(__gh, 'aaa', 'x.it'); genHistoryAdd(__gh, 'bbb'); genHistoryAdd(__gh, 'aaa', 'y.it')`);
  const gh = R(`genHistory(__gh)`);
  ok(gh.length === 2 && gh[0].pw === 'aaa' && gh[0].site === 'y.it' && R(`!isActive(__gh[0])`), 'cronologia generatore nel vault (nascosta)');
  // Google Drive con refresh token (servizio finto)
  ctx.__glog = [];
  R(`Cloud.env = { redirect: () => 'https://x/oauth-app.html', authorize: async (h, url, st) => { __glog.push(url); return { code: 'C1', state: st }; },
    fetch: async (url, opt = {}) => { const b = opt.body ? String(opt.body) : ''; __glog.push(url + ' ' + b);
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => b.includes('authorization_code') ? { access_token: 'A1', refresh_token: 'R1', expires_in: 3600 } : { access_token: 'A2', expires_in: 3600 } };
      const auth = opt.headers && opt.headers.Authorization;
      if (auth === 'Bearer A1') return { ok: false, status: 401 };
      return { ok: true, status: 200, json: async () => ({ files: [] }) }; } }`);
  const gc = await R(`PROVIDERS.gdrive.connect({ clientId: 'cid', clientSecret: 'sec' })`);
  ctx.__gc = gc;
  ok(gc.refresh === 'R1' && /access_type=offline/.test(ctx.__glog[0]) && /code_challenge=/.test(ctx.__glog[0]), 'Google Drive: flusso con codice e refresh token');
  ok(await R(`PROVIDERS.gdrive.download(__gc)`) === null && ctx.__gc.access === 'A2' && ctx.__glog.some(l => l.includes('grant_type=refresh_token') && l.includes('client_secret=sec')), 'Google Drive: token rinnovato da solo');
  R(`__gf = []; Cloud.env.fetch = async (url, opt = {}) => { __gf.push(url);
      if (url.includes('/drive/v3/files?')) return { ok: true, status: 200, json: async () => ({ files: [{ id: 'NEW', createdTime: '2026-10-26T10:00:00Z' }, { id: 'OLD', createdTime: '2026-10-20T10:00:00Z' }] }) };
      if (url.includes('/files/OLD?alt=media')) return { ok: true, status: 200, json: async () => ({ format: 'scrigno', from: 'old' }) };
      return { ok: true, status: 200, json: async () => ({ from: 'new' }) }; }`);
  ctx.__gc.access = 'A9'; ctx.__gc.exp = Date.now() + 600000; ctx.__gc.fileId = 'NEW';
  ok((await R(`PROVIDERS.gdrive.download(__gc)`)).from === 'old', 'Google Drive: con file doppi tutti usano il più vecchio');
  const gi = await R(`(async()=>{ Cloud.env.authorize = async () => ({ access_token: 'T', expires_in: 3600 }); return PROVIDERS.gdrive.connect({ clientId: 'cid' }); })()`);
  ok(gi.access === 'T' && !gi.refresh, 'Google Drive: senza secret resta il flusso implicito');
  R(`Cloud.env = null`);
  // violazioni (Have I Been Pwned, finto)
  const fakeFetch = async url => ({ ok: true, text: async () => url.endsWith('/5BAA6') ? '1E4C9B93F3F0682250B6CF8331B7EE68FD7:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824' : '' });
  ctx.__ff = fakeFetch;
  ok(await R(`pwnedCount('password', __ff)`) === 9545824, 'violazioni: password trovata');
  ok(await R(`pwnedCount('Zx9!unica-password-ok', __ff)`) === 0, 'violazioni: password non trovata');
  // elenchi 2FA/passkey (finti)
  ctx.__df = async url => ({ ok: true, json: async () => url.includes('totp') ? [['Google', { domain: 'google.com', 'additional-domains': ['youtube.com'], documentation: 'https://g/doc' }]] : { 'github.com': { passwordless: 'allowed' } } });
  ctx.__dc = new Map();
  const dirs = await R(`loadDirectories(__df, { get: async k => __dc.get(k), set: async (k, v) => __dc.set(k, v) })`);
  ok(dirs.tfa['youtube.com'][0] === 'Google' && 'github.com' in dirs.pk, 'elenchi 2fa.directory');
  // fixture per i test nativi (Kotlin/Swift): vault con password nota + passkey
  const fx = await R(`(async()=>{const v=await vaultCreate('fixture-password-123'); const it=[makeItem('login','Example',{username:'alice',password:'s3cret!',url:'https://example.com'}), makeItem('passkey','example.com',__pk.fields)]; await vaultWrite(v.file,v.dek,it); return {file:v.file, dek: await exportDEK(v.dek), passkeySpki: toB64(__pk.publicKey), passkeyRpId: 'example.com'};})()`);
  require('fs').writeFileSync(require('path').join(__dirname, 'fixture-vault.json'), JSON.stringify(fx, null, 1));
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
