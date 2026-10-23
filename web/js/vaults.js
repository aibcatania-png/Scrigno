'use strict';
/*
 * Più vault. Il vault principale contiene, cifrate, le chiavi dei vault aggiuntivi
 * (elementi interni "_vaultkey": nome, chiave, eventuale configurazione cloud).
 * Ogni vault aggiuntivo è un normale file Scrigno, salvato con la chiave "vault-<id>"
 * e sincronizzato come file a parte sul cloud scelto.
 * Usato dalla web app/app native e dall'estensione.
 */

const vaultFileKey = id => 'vault-' + id;
const vaultKeyItems = items => items.filter(i => !i.deleted && i.type === '_vaultkey');
function vaultCloudCfg(key) {
  try { return key.f.cloud ? JSON.parse(key.f.cloud) : null; } catch { return null; }
}
// Parti stabili della configurazione cloud (senza token temporanei), per capire se va salvata.
const stableCfg = c => JSON.stringify(c ? { ...c, access: undefined, exp: undefined, lastSync: undefined } : null);

async function createExtraVault({ name, password, cloudCfg }) {
  const v = await vaultCreate(password);
  const id = b64u.to(rand(9)).replace(/[^a-zA-Z0-9]/g, 'x');
  const cfg = cloudCfg ? cloudCfgForFile(cloudCfg, `scrigno-${id}.json`) : null;
  const key = makeItem('_vaultkey', name, { vaultId: id, dek: await exportDEK(v.dek), cloud: cfg ? JSON.stringify(cfg) : '' });
  return { id, name, keyId: key.id, file: v.file, dek: v.dek, items: [], cfg, key };
}

// Aggiunge un vault esistente (es. da un backup) di cui si conosce la password.
async function adoptExtraVault({ file, password, name }) {
  const dek = await vaultUnlock(file, password);
  const id = b64u.to(rand(9)).replace(/[^a-zA-Z0-9]/g, 'x');
  const key = makeItem('_vaultkey', name, { vaultId: id, dek: await exportDEK(dek), cloud: '' });
  return { id, name, keyId: key.id, file, dek, items: await vaultRead(file, dek), cfg: null, key };
}

async function openExtraVault(storeApi, key) {
  const id = key.f.vaultId;
  const dek = await importDEK(fromB64(key.f.dek));
  let file = null;
  try { file = (await storeApi.get(vaultFileKey(id))) || null; } catch { file = null; }
  let items = [];
  if (file) { try { items = await vaultRead(file, dek); } catch { file = null; } }
  return { id, name: key.title, keyId: key.id, dek, file, items, cfg: vaultCloudCfg(key) };
}

async function saveExtraVault(storeApi, v) {
  let disk = null;
  try { disk = await storeApi.get(vaultFileKey(v.id)); } catch { disk = null; }
  if (disk && v.file && disk.vaultId === v.file.vaultId && disk.updatedAt !== v.file.updatedAt) {
    try { v.items = (await vaultMerge(v.file, v.dek, v.items, disk)).items; } catch { /* ignora */ }
  }
  await vaultWrite(v.file, v.dek, v.items);
  await storeApi.set(vaultFileKey(v.id), v.file);
}

// Sincronizza un vault aggiuntivo con il suo cloud. Se sul dispositivo manca, lo scarica.
async function syncExtraVault(storeApi, v) {
  if (!v.cfg) return { changed: false };
  const P = PROVIDERS[v.cfg.provider];
  if (!P || (v.cfg.provider === 'folder' && !(Cloud.env && Cloud.env.folder))) return { changed: false };
  if (!v.file) {
    const remote = await P.download(v.cfg);
    if (!remote) return { changed: false };
    v.items = await vaultRead(remote, v.dek);
    v.file = remote;
    await storeApi.set(vaultFileKey(v.id), v.file);
    return { changed: true };
  }
  const r = await cloudSync({ file: v.file, dek: v.dek, items: v.items, cfg: v.cfg });
  v.items = r.items;
  if (r.changedLocal || r.uploaded) await storeApi.set(vaultFileKey(v.id), v.file);
  return { changed: r.changedLocal };
}
