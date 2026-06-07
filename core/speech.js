// ═══════════════════════════════════════════
// core/speech.js — TTS + speech envelope
// ═══════════════════════════════════════════

let _isSpeaking   = false;
let _envelope     = 0;
let _lastBoundary = 0;
let _onDone       = null;

// Tick: updates envelope ~60fps, read by orb.js
setInterval(() => {
  if (!_isSpeaking) { _envelope *= 0.82; return; }
  const age   = performance.now() - _lastBoundary;
  const decay = Math.max(0, 1 - age / 260);
  _envelope   = decay * (0.5 + 0.5 * Math.sin(performance.now() * 0.025));
}, 16);

// Strip code blocks before speaking — never read raw code aloud
function stripForSpeech(text) {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, "here is the code")
    .replace(/`[^`]+`/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/^[-•]\s/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const Speech = {

  speak(text, onDone) {
    const clean = stripForSpeech(text);
    window.speechSynthesis.cancel();
    _isSpeaking = true;
    _onDone     = onDone || null;

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

  isSpeaking()  { return _isSpeaking; },
  getEnvelope() { return _envelope;   },
};
