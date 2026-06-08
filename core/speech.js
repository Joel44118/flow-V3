// ═══════════════════════════════════════════
// core/speech.js — TTS + speech envelope
//
// FIX: stripForSpeech now uses greedy regex
// so unclosed ``` blocks (truncated responses)
// are also silenced — not read aloud.
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

// Strip ALL code before speaking
// Uses greedy [\s\S]* so unclosed blocks at end of string are caught too
function stripForSpeech(text) {
  if (!text) return "";
  return text
    // Closed fenced blocks: ```...``` — greedy, catches multiline
    .replace(/```[\s\S]*?```/g, "here is the code")
    // Unclosed fenced block at end of string (truncated response)
    .replace(/```[\s\S]*/g, "here is the code")
    // Inline code: `...`
    .replace(/`[^`]+`/g, "")
    // Remaining backticks
    .replace(/`/g, "")
    // Markdown cleanup
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/^[-•]\s/gm, "")
    // URL cleanup — don't read raw URLs
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\s+/g, " ")
    .trim();
}

export const Speech = {

  speak(text, onDone) {
    const clean = stripForSpeech(text);
    // If nothing left after stripping (pure code response), just call onDone
    if (!clean || clean === "here is the code") {
      if (onDone) onDone();
      return;
    }
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
