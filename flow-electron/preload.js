// flow-electron/preload.js (v4)
// No custom title bar injection needed — OS handles it via titleBarOverlay
// This file is now clean — just the IPC bridge

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__flowElectron', {
  // Gesture / cursor control
  send: (action, payload) => {
    const ALLOWED = ['cursor_move', 'gesture_click', 'right_click', 'scroll', 'type_text'];
    if (ALLOWED.includes(action)) ipcRenderer.send(action, payload);
  },
  getScreenSize: () => ipcRenderer.invoke('get_screen_size'),

  // Window controls (still available for any custom buttons)
  minimize: () => ipcRenderer.send('win_minimize'),
  maximize: () => ipcRenderer.send('win_maximize'),
  close:    () => ipcRenderer.send('win_close'),
});
