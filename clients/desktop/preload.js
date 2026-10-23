'use strict';

// Durum sayfasının ana süreçten isteyebildiği her şey bu dört işlev. Cihazın kendi arayüzü de bu
// pencerede açılıyor, ve ona hiçbir şey açılmıyor: yalnız `file:` sayfası kullanabiliyor.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('depsis', {
    state: () => ipcRenderer.invoke('state'),
    pair: (code) => ipcRenderer.invoke('pair', code),
    prepare: () => ipcRenderer.invoke('prepare'),
    onState: (listener) => ipcRenderer.on('state', (_event, state) => listener(state)),
  });
}
