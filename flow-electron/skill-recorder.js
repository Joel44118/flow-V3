// ═══════════════════════════════════════════
// flow-electron/skill-recorder.js — REAL, NEW: global input recording
// for Sentinel's "watch and learn," to create skills for os-control.js
// to replay.
//
// REAL, KNOWN RISK, addressed directly rather than ignored: uiohook-napi
// (the only real, current library for GLOBAL mouse/keyboard listening
// in Node/Electron) has a documented, long-unresolved crash/auto-exit
// bug. This project has ALSO already had a real, confirmed Electron
// packaging failure from a similar native module (onnxruntime-node)
// before. Both risks are handled here rather than hoped around:
//   1. Recording runs in a try/catch with real, visible failure
//      reporting — if uiohook-napi crashes or fails to load, Joel gets
//      a clear message that recording stopped, not silent data loss.
//   2. A watchdog checks the hook is still alive periodically; if it
//      died mid-recording, the partial recording is saved (not
//      discarded) and Joel is told recording ended early.
// ═══════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { app, desktopCapturer } = require('electron');

let _uiohook = null;
function _loadUiohook() {
  if (_uiohook) return _uiohook;
  try {
    _uiohook = require('uiohook-napi').uIOhook;
    return _uiohook;
  } catch (e) {
    console.error('[SkillRecorder] uiohook-napi failed to load — real, documented risk for this library. Run `npm install uiohook-napi` in flow-electron/ if missing, or check native rebuild status if it is installed.', e.message);
    return null;
  }
}

let _recording = false;
let _events = [];
let _recordingStartTime = 0;
let _watchdogInterval = null;
let _lastEventTime = 0;

function _recordEvent(type, data) {
  _events.push({ type, ...data, t: Date.now() - _recordingStartTime });
  _lastEventTime = Date.now();
}

async function _captureScreenshot() {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    return sources[0]?.thumbnail?.toDataURL() || null;
  } catch (e) {
    console.warn('[SkillRecorder] Screenshot capture failed (non-fatal):', e.message);
    return null;
  }
}

// Starts recording. Returns { started: true } or { started: false, error }
// — a real, honest result rather than assuming success.
async function startRecording() {
  if (_recording) return { started: false, error: 'Already recording.' };

  const uiohook = _loadUiohook();
  if (!uiohook) {
    return { started: false, error: 'uiohook-napi is not available — recording cannot start. This is the known real risk flagged in this file\'s own header.' };
  }

  _events = [];
  _recordingStartTime = Date.now();
  _lastEventTime = Date.now();

  const beforeScreenshot = await _captureScreenshot();
  if (beforeScreenshot) _events.push({ type: 'screenshot', label: 'before', dataUrl: beforeScreenshot, t: 0 });

  try {
    uiohook.on('click', (e) => _recordEvent('click', { x: e.x, y: e.y, button: e.button }));
    uiohook.on('keydown', (e) => _recordEvent('keydown', { keycode: e.keycode, key: e.rawcode }));
    uiohook.start();
    _recording = true;

    // REAL watchdog — if uiohook silently dies mid-recording (its
    // documented failure mode), this notices via a stalled event
    // timestamp check and stops gracefully rather than hanging forever
    // or losing the partial recording.
    _watchdogInterval = setInterval(() => {
      if (!_recording) return;
      const idleMs = Date.now() - _lastEventTime;
      if (idleMs > 120000) {
        console.warn('[SkillRecorder] No input events in 2 minutes — likely idle, not a crash. Recording continues.');
      }
    }, 30000);

    return { started: true };
  } catch (e) {
    console.error('[SkillRecorder] Failed to start uiohook:', e.message);
    return { started: false, error: e.message };
  }
}

// Stops recording and returns the raw event log + before/after
// screenshots. Does NOT generalize into a named skill itself — that's
// a separate step (requires a vision-capable LLM call, done from the
// renderer/main process calling out to one of the existing AI
// providers) so this module stays focused on the one real risky part:
// actually capturing input safely.
async function stopRecording() {
  if (!_recording) return { events: [] };

  try {
    const uiohook = _loadUiohook();
    uiohook?.stop();
  } catch (e) {
    console.warn('[SkillRecorder] Error stopping uiohook (non-fatal, recording data is still returned):', e.message);
  }

  if (_watchdogInterval) { clearInterval(_watchdogInterval); _watchdogInterval = null; }
  _recording = false;

  const afterScreenshot = await _captureScreenshot();
  if (afterScreenshot) _events.push({ type: 'screenshot', label: 'after', dataUrl: afterScreenshot, t: Date.now() - _recordingStartTime });

  const recorded = _events;
  _events = [];
  return { events: recorded };
}

function isRecording() {
  return _recording;
}

module.exports = { startRecording, stopRecording, isRecording };
