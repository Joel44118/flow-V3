// ═══════════════════════════════════════════
// core/speech.js — TTS with reliable pause/resume/cancel/reread
//
// Browser's speechSynthesis.pause() is broken in Chrome — it
// restarts from the beginning instead of pausing in place.
// Fix: on pause we cancel() and store the char offset from the
// last onboundary event. Resume() re-speaks from that offset.
// ═══════════════════════════════════════════

let _isSpeaking   = false;
let _isPaused     = false;
let _envelope     = 0;
let _lastBoundary = 0;
let _activeWrap   = null;
let _onDone       = null;

// For reliable pause: store full text + char position
let _fullText      = "";
let _charOffset    = 0;   // updated every word boundary

setInterval(() => {
  if (!_isSpeaking || _isPaused) { _envelope *= 0.82; return; }
  const age   = performance.now() - _lastBoundary;
  const decay = Math.max(0, 1 - age / 260);
  _envelope   = decay * (0.5 + 0.5 * Math.sin(performance.now() * 0.025));
}, 16);

function stripForSpeech(text) {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, "here is the code")
    .replace(/```[\s\S]*/g, "here is the code")
    .replace(/`[^`]+`/g, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/^[-•]\s/gm, "")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\s+/g, " ")
    .trim();
}

// Update all three control buttons on the active wrap
function _setButtons(wrap, state) {
  if (!wrap) return;
  const play   = wrap.querySelector(".msg-play-btn");
  const cancel = wrap.querySelector(".msg-cancel-btn");
  const reread = wrap.querySelector(".msg-reread-btn");

  if (!play) return;

  if (state === "playing") {
    play.textContent   = "⏸";  play.title = "Pause";  play.dataset.state = "playing";
    if (cancel) { cancel.style.display = "flex"; }
    if (reread) { reread.style.display = "none";  }
  } else if (state === "paused") {
    play.textContent   = "▶";  play.title = "Resume"; play.dataset.state = "paused";
    if (cancel) { cancel.style.display = "flex"; }
    if (reread) { reread.style.display = "flex"; }
  } else {
    // idle
    play.textContent   = "▶";  play.title = "Read aloud"; play.dataset.state = "idle";
    if (cancel) { cancel.style.display = "none"; }
    if (reread) { reread.style.display = "none"; }
  }
}

function _resetState(runOnDone = true) {
  _isSpeaking = false;
  _isPaused   = false;
  _envelope   = 0;
  _charOffset = 0;
  _setButtons(_activeWrap, "idle");
  _activeWrap = null;
  if (runOnDone && _onDone) _onDone();
  _onDone = null;
}

function _speak(text, fromChar, onDone, wrap) {
  const slice = text.slice(fromChar).trim();
  if (!slice) { _resetState(true); return; }

  _isSpeaking = true;
  _isPaused   = false;
  _onDone     = onDone || null;
  _activeWrap = wrap || null;
  _setButtons(_activeWrap, "playing");

  const u    = new SpeechSynthesisUtterance(slice);
  u.lang     = "en-US";
  u.rate     = 0.96;
  u.pitch    = 1;
  u.volume   = 1;

  u.onboundary = (e) => {
    if (e.name === "word") {
      // charIndex is relative to slice — add fromChar to get absolute position
      _charOffset   = fromChar + (e.charIndex || 0);
      _lastBoundary = performance.now();
      _envelope     = 0.6 + Math.random() * 0.4;
    }
  };

  u.onend = () => { if (!_isPaused) _resetState(true); };
  u.onerror = (e) => {
    // "interrupted" fires when we manually cancel — ignore it
    if (e.error === "interrupted") return;
    _resetState(true);
  };

  window.speechSynthesis.cancel(); // clear queue first
  window.speechSynthesis.speak(u);
}

export const Speech = {

  speak(text, onDone, wrap) {
    const clean = stripForSpeech(text);
    if (!clean || clean === "here is the code") {
      if (onDone) onDone();
      return;
    }

    // Reset previous active message buttons
    if (_activeWrap && _activeWrap !== wrap) {
      _setButtons(_activeWrap, "idle");
    }

    _fullText   = clean;
    _charOffset = 0;
    _speak(clean, 0, onDone, wrap);
  },

  // Reliable pause: cancel TTS but remember position
  pause() {
    if (!_isSpeaking || _isPaused) return;
    _isPaused = true;
    _envelope = 0;
    // Save wrap ref before cancel clears it
    const savedWrap = _activeWrap;
    const savedDone = _onDone;
    window.speechSynthesis.cancel(); // stops speaking
    // Restore state so resume knows what to do
    _isSpeaking = true;
    _activeWrap = savedWrap;
    _onDone     = savedDone;
    _setButtons(savedWrap, "paused");
    // Also set orb back from speaking state
    try { window.__flowOrb?.setState?.("idle"); } catch(_){}
  },

  // Resume from saved position
  resume() {
    if (!_isSpeaking || !_isPaused) return;
    _isPaused = false;
    const wrap     = _activeWrap;
    const onDone   = _onDone;
    const fromChar = _charOffset;
    const fullText = _fullText;
    _speak(fullText, fromChar, onDone, wrap);
  },

  // Stop completely — resets everything, orb goes idle
  cancel() {
    window.speechSynthesis.cancel();
    const savedWrap = _activeWrap;
    _isSpeaking = false;
    _isPaused   = false;
    _envelope   = 0;
    _charOffset = 0;
    _fullText   = "";
    _activeWrap = null;
    _onDone     = null;
    _setButtons(savedWrap, "idle");
    try { window.__flowOrb?.setState?.("idle"); } catch(_){}
  },

  // Re-read from the very beginning of a message
  reread(text, wrap) {
    const clean = stripForSpeech(text);
    if (!clean) return;
    _fullText   = clean;
    _charOffset = 0;
    if (_activeWrap && _activeWrap !== wrap) _setButtons(_activeWrap, "idle");
    _speak(clean, 0, null, wrap);
  },

  isSpeaking()  { return _isSpeaking && !_isPaused; },
  isPaused()    { return _isPaused; },
  getEnvelope() { return _envelope; },
};
