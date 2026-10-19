'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const clean = e => new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
contextBridge.exposeInMainWorld('scrignoElectron', {
  platform: process.platform,
  call: (method, args) => ipcRenderer.invoke('scrigno:call', method, args).catch(e => { throw clean(e); }),
  onEvent: cb => ipcRenderer.on('scrigno:event', (_e, name, data) => cb(name, data)),
});
