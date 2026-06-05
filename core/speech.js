// ═══════════════════════════════════════════
// core/speech.js — TTS + speech envelope
// ═══════════════════════════════════════════

let _isSpeaking  = false;
let _envelope    = 0;
let _lastBoundary = 0;
let _onDone      = null;

// Tick: updates envelope ~60fps, read by orb.js
setInterval(() => {
  if (!_isSpeaking) { _envelope *= 0.82; return; }
  const age   = performance.now() - _lastBoundary;
  const decay = Math.max(0, 1 - age / 260);
  _envelope = decay * (0.5 + 0.5 * Math.sin(performance.now() * 0.025));
}, 16);

export const Speech = {
  speak(text, onDone) {
    window.speechSynthesis.cancel();
    _isSpeaking = true;
    _onDone = onDone || null;

    const u    = new SpeechSynthesisUtterance(text);
    u.lang     = "en-US";
    u.rate     = 0.96;
    u.pitch    = 1;
    u.volume   = 1;

    u.onboundary = (e) => {
      if (e.name === "word") {
        _lastBoundary = performance.now();
        _envelope = 0.6 + Math.random() * 0.4;
      }
    };

    u.onend = u.onerror = () => {
      _isSpeaking = false;
      _envelope   = 0;
      if (_onDone) _onDone();
    };

    window.speechSynthesis.speak(u);
  },

  cancel() {
    window.speechSynthesis.cancel();
    _isSpeaking = false;
    _envelope   = 0;
  },

  isSpeaking()   { return _isSpeaking; },
  getEnvelope()  { return _envelope;   },
};