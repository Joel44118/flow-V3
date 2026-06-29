// flow-electron/preload.js (v4 — clean)
// No HTML injection — OS title bar handles the buttons natively
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__flowElectron', {
  send: (action, payload) => {
    const OK = ['cursor_move','gesture_click','right_click','scroll','type_text','gesture_start','gesture_stop','cursor_held'];
    if (OK.includes(action)) ipcRenderer.send(action, payload);
  },
  getScreenSize: () => ipcRenderer.invoke('get_screen_size'),
  minimize: () => ipcRenderer.send('win_minimize'),
  maximize: () => ipcRenderer.send('win_maximize'),
  close:    () => ipcRenderer.send('win_close'),
});
