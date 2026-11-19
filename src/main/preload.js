'use strict';

// Bundled by esbuild into dist/preload.js (sandboxed preloads cannot require
// files at runtime). Exposes the SmartSpectra bridge and TrustFall's own API.

require('@smartspectra/node-sdk/preload');
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('lab', {
  config: invoke('lab:config'),
  consent: invoke('lab:consent'),
  list: invoke('lab:list'),
  recBegin: invoke('lab:rec-begin'),
  recChunk: invoke('lab:rec-chunk'),
  recFinish: invoke('lab:rec-finish'),
  setReference: invoke('lab:set-reference'),
  deleteClip: invoke('lab:delete-clip'),
  run: invoke('lab:run'),
  cancel: invoke('lab:cancel'),
  runDetail: invoke('lab:run-detail'),
  reportMd: invoke('lab:report-md'),
  reveal: invoke('lab:reveal'),
  deleteAll: invoke('lab:delete-all'),
  snap: invoke('lab:snap'),
  onEvent: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('lab:event', h);
    return () => ipcRenderer.removeListener('lab:event', h);
  },
});
