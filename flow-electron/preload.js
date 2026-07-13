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

  // ── Wake word — "Wake up Flow" ──────────────────────────────────────
  // Fully local detection (main process). Fires once per detected wake
  // word; the renderer's listener should call the existing
  // core/whisper.js startRecording()/stopRecordingAndTranscribe() flow —
  // no new transcription logic needed here.
  wakeword: {
    onDetected: (cb) => ipcRenderer.on('wakeword-detected', () => cb()),
    // REAL FIX: wake-word logs (model loading, SoX status, detection
    // scores, errors) previously only reached a terminal window that
    // genuinely doesn't exist in a packaged .exe — meaning Joel's F12
    // DevTools console was ALWAYS silent about wake-word activity,
    // regardless of whether it was working or broken. This forwards
    // every real log line through so app.js can print it where Joel can
    // actually see it.
    onLog: (cb) => ipcRenderer.on('wakeword-log', (_e, entry) => cb(entry)),
  },

  // Real fix: this IPC handler (validate_js_syntax) was added to main.js
  // earlier this session but never actually exposed here — meaning
  // window.__flowElectron.validateJsSyntax was undefined this whole
  // time, silently falling through to the browser-only Acorn fallback
  // even inside the Electron app, where true node --check was actually
  // available all along.
  validateJsSyntax: (code, moduleType) => ipcRenderer.invoke('validate_js_syntax', { code, moduleType }),

  // ── Main-process log forwarding ─────────────────────────────────────
  // Real fix for debugging main-process-only code (wakeword-engine.js,
  // and anything else running outside the renderer) in a packaged app
  // with no terminal window. app.js registers a listener that prints
  // these to the real DevTools console (opened via Ctrl+Shift+I).
  onMainLog: (cb) => ipcRenderer.on('main-process-log', (_e, entry) => cb(entry)),
});
