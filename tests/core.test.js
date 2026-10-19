const load = require('./load');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
(async () => {
  const { ctx, R } = load(['web/js/core.js', 'web/js/native.js', 'web/js/cloud.js', 'web/js/passkey.js']);
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
  // fixture per i test nativi (Kotlin/Swift): vault con password nota + passkey
  const fx = await R(`(async()=>{const v=await vaultCreate('fixture-password-123'); const it=[makeItem('login','Example',{username:'alice',password:'s3cret!',url:'https://example.com'}), makeItem('passkey','example.com',__pk.fields)]; await vaultWrite(v.file,v.dek,it); return {file:v.file, dek: await exportDEK(v.dek), passkeySpki: toB64(__pk.publicKey), passkeyRpId: 'example.com'};})()`);
  require('fs').writeFileSync(require('path').join(__dirname, 'fixture-vault.json'), JSON.stringify(fx, null, 1));
  console.log(fails ? `\n${fails} FALLITI` : '\nTUTTI OK');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
