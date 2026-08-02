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
    // REAL, Joel-requested — lets the renderer tell the heartbeat "Joel
    // just did something real." No longer gates background research
    // (that now starts immediately on app open, per Joel's explicit
    // ask), but kept for other real, potential future uses of genuine
    // activity tracking.
    markUserActivity: () => ipcRenderer.send('heartbeat_mark_user_activity'),
    onMessage:   (cb)    => ipcRenderer.on('heartbeat-message', (_e, entry) => cb(entry)),
  },

  // ── Flow Settings — real, persisted toggles ─────────────────────────
  // Backing store lives in heartbeat.js (small JSON file in userData).
  // Starts with backgroundResearchEnabled; a real place to add more
  // toggles later without inventing a new IPC channel each time.
  settings: {
    get: () => ipcRenderer.invoke('flow_get_settings'),
    set: (key, value) => ipcRenderer.invoke('flow_set_setting', key, value),
  },

  // REAL, Joel-explicit-override — OS-level skill replay. Every call
  // goes through main.js's flow_replay_skill handler, which ALWAYS
  // shows a confirmation overlay first — this bridge cannot bypass
  // that gate from the renderer side.
  osControl: {
    replaySkill: (skill) => ipcRenderer.invoke('flow_replay_skill', skill),
    runNamedSkill: (name) => ipcRenderer.invoke('flow_run_named_skill', name),
    listSkills: () => ipcRenderer.invoke('flow_list_skills'),
    startRecording: () => ipcRenderer.invoke('flow_start_skill_recording'),
    stopRecording: () => ipcRenderer.invoke('flow_stop_skill_recording'),
    saveSkill: (skill) => ipcRenderer.invoke('flow_save_skill', skill),
    getLastRecording: () => ipcRenderer.invoke('flow_get_last_recording'),
    performOSAction: (action, appName) => ipcRenderer.invoke('flow_perform_os_action', { action, appName }),
    onStep: (callback) => ipcRenderer.on('os-control-step', (_event, data) => callback(data)),
    onAborted: (callback) => ipcRenderer.on('os-control-aborted', (_event, data) => callback(data)),
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
  // ═══════════════════════════════════════════
  // REAL, SCRATCHED AND REBUILT — Joel's explicit instruction: the old
  // "hey flow" spoken wake-word system is gone. Real, honest reason:
  // FOUR separate real approaches were tried across this project's
  // history and all failed for Joel's specific environment — trained
  // openWakeWord models, Deepgram continuous streaming, a whisper.cpp
  // local compile (the binary never actually shipped), and
  // webkitSpeechRecognition (confirmed via research to reliably fail
  // inside Electron specifically — Electron builds lack the special
  // Google API key Chrome bakes in for its speech service). Chasing a
  // fifth approach would likely hit the same wall.
  //
  // REAL REPLACEMENT: a global hotkey (Ctrl+Shift+Space, registered in
  // main.js using the SAME globalShortcut infrastructure already proven
  // working elsewhere in this app) instantly triggers the mic from
  // anywhere on the PC — no spoken phrase, no continuous audio capture,
  // no native binaries, no compilation step. Recording itself reuses
  // core/whisper.js's ALREADY-WORKING MediaRecorder + Hugging Face
  // Whisper flow (the same one the plain web build already uses
  // successfully) — Electron no longer has its own separate, more
  // fragile dictation pipeline at all.
  // ═══════════════════════════════════════════
  voiceHotkey: {
    onTrigger: (cb) => ipcRenderer.on('trigger-voice-record', () => cb()),
  },

  // ── Live dictation mode — Joel's explicit request: text streams into
  // the input box as he talks, auto-sends after ~3-4s of real silence.
  // start() begins the mode (reuses the same mic/engine as wake-word,
  // pausing wake-word listening while active); onUpdate fires repeatedly
  // with the current best-guess text; onFinal fires once with the
  // completed text when silence is detected or stop() is called manually.
  // NOTE: the old Electron-specific `dictation` bridge (SoX + local
  // whisper.cpp) is gone — Electron now uses the exact same
  // core/whisper.js MediaRecorder + Hugging Face Whisper flow the plain
  // web build already used successfully, so no separate bridge is
  // needed for this anymore.

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
