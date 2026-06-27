// flow-electron/preload.js
// Secure bridge — exposes only what Flow needs, nothing else

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__flowElectron', {
  // Gesture / cursor actions → robotjs in main process
  send: (action, payload) => {
    const ALLOWED = ['cursor_move', 'gesture_click', 'right_click', 'scroll', 'type_text'];
    if (ALLOWED.includes(action)) ipcRenderer.send(action, payload);
  },

  // Get real screen resolution so gesture coords map correctly
  getScreenSize: () => ipcRenderer.invoke('get_screen_size'),

  // Window controls for custom title bar buttons
  minimize: () => ipcRenderer.send('win_minimize'),
  maximize: () => ipcRenderer.send('win_maximize'),
  close:    () => ipcRenderer.send('win_close'),
});
