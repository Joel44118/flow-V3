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

  // ── Flow Heartbeat — real, standing autonomy loop ───────────────────
  // Lets the renderer see/manage Flow's own self-directed goal list
  // (heartbeat.js's real, persisted store) and receive self-initiated
  // messages Flow decides to send, unprompted, while the window is open.
  heartbeat: {
    listGoals:   ()      => ipcRenderer.invoke('heartbeat_list_goals'),
    addGoal:     (description) => ipcRenderer.invoke('heartbeat_add_goal', { description }),
    removeGoal:  (id)    => ipcRenderer.invoke('heartbeat_remove_goal', { id }),
    recordMarketingPost: () => ipcRenderer.invoke('heartbeat_record_marketing_post'),
    onMessage:   (cb)    => ipcRenderer.on('heartbeat-message', (_e, entry) => cb(entry)),
  },

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

  // ── Voice control — "hey flow" / "wake up flow" ─────────────────────
  // REAL, UPDATED (this session): the detection engine underneath
  // changed (voice-engine.js replaces wakeword-engine.js's ONNX
  // classifier with continuous transcribe.cpp transcription + text
  // matching — no training required, ever), but the wake-detected signal
  // channel name is kept the same for backward compatibility with
  // existing renderer code. onCommand is NEW: delivers the actual
  // transcribed command text once the user finishes speaking after the
  // wake phrase — the renderer is responsible for routing this into
  // real actions (e.g. Content Lab commands).
  wakeword: {
    onDetected: (cb) => ipcRenderer.on('wakeword-detected', () => cb()),
    onLog: (cb) => ipcRenderer.on('wakeword-log', (_e, entry) => cb(entry)),
    onCommand: (cb) => ipcRenderer.on('voice-command', (_e, { text }) => cb(text)),
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
