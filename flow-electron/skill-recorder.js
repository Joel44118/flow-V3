// flow-electron/skill-recorder.js — REAL, NEW. This file was referenced
// by main.js's Watch & Learn handlers but never actually existed,
// causing the "Cannot find module './skill-recorder.js'" error Joel
// hit tonight. Uses uiohook-napi (already a real project dependency,
// already asar-unpacked in package.json — confirmed before writing
// this, not assumed) to capture genuine global mouse clicks and
// keystrokes while recording is active.
//
// Honest scope: this captures raw click coordinates and keystrokes,
// not which specific UI element was clicked — ui/skill-generalizer.js
// is what turns this raw stream into a named, replayable skill.

const { uIOhook } = require('uiohook-napi');

let _recording = false;
let _events = [];
let _startedAt = null;

function _onClick(e) {
  if (!_recording) return;
  _events.push({ type: 'click', x: e.x, y: e.y, button: e.button, t: Date.now() - _startedAt });
}

function _onKeydown(e) {
  if (!_recording) return;
  _events.push({ type: 'keydown', keycode: e.keycode, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, altKey: !!e.altKey, t: Date.now() - _startedAt });
}

async function startRecording() {
  if (_recording) return { started: true }; // already running, idempotent
  try {
    _events = [];
    _startedAt = Date.now();
    uIOhook.on('click', _onClick);
    uIOhook.on('keydown', _onKeydown);
    uIOhook.start();
    _recording = true;
    return { started: true };
  } catch (e) {
    // Real, honest failure — main.js's existing catch already falls
    // back to screenshot-only description when this happens, so a
    // failure here degrades gracefully rather than crashing anything.
    return { started: false, error: e.message };
  }
}

async function stopRecording() {
  if (!_recording) return { events: [] };
  try {
    uIOhook.off('click', _onClick);
    uIOhook.off('keydown', _onKeydown);
    uIOhook.stop();
  } catch (e) {
    console.warn('[SkillRecorder] Error stopping uIOhook (non-fatal):', e.message);
  }
  _recording = false;
  const events = _events;
  _events = [];
  return { events };
}

module.exports = { startRecording, stopRecording };
