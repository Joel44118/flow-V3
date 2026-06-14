// ═══════════════════════════════════════════
// core/speech.js — TTS + speech envelope
// ═══════════════════════════════════════════

let _isSpeaking   = false;
let _isPaused     = false;
let _envelope     = 0;
let _lastBoundary = 0;
let _onDone       = null;
// Track the active message wrap so we can update its button state
let _activeWrap   = null;

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

function _setButtonState(wrap, state) {
  // state: "playing" | "paused" | "idle"
  if (!wrap) return;
  const btn = wrap.querySelector(".msg-play-btn");
  if (!btn) return;
  if (state === "playing") {
    btn.textContent = "⏸";
    btn.title = "Pause";
    btn.dataset.state = "playing";
  } else if (state === "paused") {
    btn.textContent = "▶";
    btn.title = "Resume";
    btn.dataset.state = "paused";
  } else {
    btn.textContent = "▶";
    btn.title = "Read aloud";
    btn.dataset.state = "idle";
  }
}

export const Speech = {

  speak(text, onDone, wrap) {
    const clean = stripForSpeech(text);
    if (!clean || clean === "here is the code") {
      if (onDone) onDone();
      return;
    }

    // Reset previous active button
    if (_activeWrap && _activeWrap !== wrap) {
      _setButtonState(_activeWrap, "idle");
    }

    window.speechSynthesis.cancel();
    _isSpeaking  = true;
    _isPaused    = false;
    _onDone      = onDone || null;
    _activeWrap  = wrap || null;
    _setButtonState(_activeWrap, "playing");

    const u    = new SpeechSynthesisUtterance(clean);
    u.lang     = "en-US";
    u.rate     = 0.96;
    u.pitch    = 1;
    u.volume   = 1;

    u.onboundary = (e) => {
      if (e.name === "word") {
        _lastBoundary = performance.now();
        _envelope     = 0.6 + Math.random() * 0.4;
      }
    };

    u.onend = u.onerror = () => {
      _isSpeaking = false;
      _isPaused   = false;
      _envelope   = 0;
      _setButtonState(_activeWrap, "idle");
      _activeWrap = null;
      if (_onDone) _onDone();
    };

    window.speechSynthesis.speak(u);
  },

  pause() {
    if (_isSpeaking && !_isPaused) {
      window.speechSynthesis.pause();
      _isPaused = true;
      _envelope = 0;
      _setButtonState(_activeWrap, "paused");
    }
  },

  resume() {
    if (_isSpeaking && _isPaused) {
      window.speechSynthesis.resume();
      _isPaused = false;
      _setButtonState(_activeWrap, "playing");
    }
  },

  cancel() {
    window.speechSynthesis.cancel();
    _isSpeaking = false;
    _isPaused   = false;
    _envelope   = 0;
    _setButtonState(_activeWrap, "idle");
    _activeWrap = null;
  },

  reread(text, wrap) {
    this.speak(text, null, wrap);
  },

  isSpeaking()  { return _isSpeaking; },
  isPaused()    { return _isPaused;   },
  getEnvelope() { return _envelope;   },
};
