// flow-electron/preload.js (v5 — adds Flow Sentinel bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__flowElectron', {
  send: (action, payload) => {
    const OK = ['cursor_move','gesture_click','right_click','scroll','type_text','gesture_start','gesture_stop','cursor_held'];
    if (OK.includes(action)) ipcRenderer.send(action, payload);
  },
  getScreenSize: () => ipcRenderer.invoke('get_screen_size'),
  getBuildInfo:  () => ipcRenderer.invoke('get_build_info'),
  minimize: () => ipcRenderer.send('win_minimize'),
  maximize: () => ipcRenderer.send('win_maximize'),
  close:    () => ipcRenderer.send('win_close'),

  // ── Flow Sentinel ────────────────────────────────────────────────────
  // Ambient context awareness — Electron-only, requires OS-level access
  sentinel: {
    toggle:   (enabled) => ipcRenderer.send('sentinel_toggle', { enabled }),
    status:   ()        => ipcRenderer.invoke('sentinel_status'),
    askNow:   ()         => ipcRenderer.invoke('sentinel_ask_now'),
    rawScreenshot: ()    => ipcRenderer.invoke('sentinel_raw_screenshot'),
    onObservation: (cb) => ipcRenderer.on('sentinel-observation', (_e, desc) => cb(desc)),
    onToggled:     (cb) => ipcRenderer.on('sentinel-toggled', (_e, enabled) => cb(enabled)),

    // Watch · Learn · Replicate — records a rolling screenshot+window trail,
    // then extracts and (with confirmation) replays a short action sequence.
    learnToggle: (enabled) => ipcRenderer.send('sentinel_learn_toggle', { enabled }),
    learnStatus: ()        => ipcRenderer.invoke('sentinel_learn_status'),
    replayPlan:    (instruction)               => ipcRenderer.invoke('sentinel_replay_plan', { instruction }),
    replayExecute: (action, x, y, text, direction) => ipcRenderer.invoke('sentinel_replay_execute', { action, x, y, text, direction }),
  },
});
