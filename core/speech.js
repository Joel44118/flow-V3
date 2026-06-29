// core/speech.js (v2)
// ONE consistent voice across ALL devices via ElevenLabs cloud TTS
// Falls back to browser TTS if ElevenLabs not configured
// ElevenLabs free tier: 10,000 chars/month — enough for daily use
// Add ELEVENLABS_API_KEY to Vercel env vars to enable cloud voice

let _isSpeaking   = false;
let _isPaused     = false;
let _envelope     = 0;
let _lastBoundary = 0;
let _activeWrap   = null;
let _onDone       = null;
let _fullText     = "";
let _charOffset   = 0;
let _audioEl      = null;   // for ElevenLabs audio playback

setInterval(() => {
  if (!_isSpeaking || _isPaused) { _envelope *= 0.82; return; }
  const age = performance.now() - _lastBoundary;
  _envelope = Math.max(0, 1 - age / 260) * (0.5 + 0.5 * Math.sin(performance.now() * 0.025));
}, 16);

function stripForSpeech(text) {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, "here is the code")
    .replace(/```[\s\S]*/g,     "here is the code")
    .replace(/`[^`]+`/g, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .replace(/^[-•]\s/gm, "")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\s+/g, " ")
    .trim();
}

function _setButtons(wrap, state) {
  if (!wrap) return;
  const play   = wrap.querySelector(".msg-play-btn");
  const cancel = wrap.querySelector(".msg-cancel-btn");
  const reread = wrap.querySelector(".msg-reread-btn");
  if (!play) return;
  if (state === "playing") {
    play.textContent = "⏸"; play.title = "Pause"; play.dataset.state = "playing";
    if (cancel) cancel.style.display = "flex";
    if (reread) reread.style.display = "none";
  } else if (state === "paused") {
    play.textContent = "▶"; play.title = "Resume"; play.dataset.state = "paused";
    if (cancel) cancel.style.display = "flex";
    if (reread) reread.style.display = "flex";
  } else {
    play.textContent = "▶"; play.title = "Read aloud"; play.dataset.state = "idle";
    if (cancel) cancel.style.display = "none";
    if (reread) reread.style.display = "none";
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

// ── ElevenLabs cloud TTS — same voice on every device ─────────────────────
// Voice: "Adam" (male, natural, clear) — free tier voice ID
// Set ELEVENLABS_API_KEY in Vercel → Settings → Environment Variables
const EL_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Adam — consistent male voice

async function _speakElevenLabs(text, onDone, wrap) {
  try {
    const res = await fetch("/api/tts", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text: text.slice(0, 500) }), // cap per request
    });
    if (!res.ok) throw new Error("TTS API " + res.status);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);

    if (_audioEl) { _audioEl.pause(); _audioEl.src = ""; }
    _audioEl = new Audio(url);

    _audioEl.onplay  = () => { _isSpeaking = true; _setButtons(wrap, "playing"); };
    _audioEl.onended = () => { URL.revokeObjectURL(url); _resetState(true); if (onDone) onDone(); };
    _audioEl.onerror = () => { URL.revokeObjectURL(url); _fallbackBrowserTTS(text, 0, onDone, wrap); };

    _activeWrap = wrap;
    _onDone     = onDone;
    await _audioEl.play();
    return true;
  } catch (e) {
    console.warn("[Flow TTS] ElevenLabs failed:", e.message, "— using browser TTS");
    return false;
  }
}

// ── Browser TTS fallback — best available male voice ─────────────────────
let _cachedVoice = null;

function _getFlowVoice() {
  if (_cachedVoice) return _cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  // Priority list — male voices, best quality first
  const PREF = [
    "Google UK English Male",
    "Microsoft Ryan Online (Natural) - English (United Kingdom)",
    "Microsoft Guy Online (Natural) - English (United States)",
    "Microsoft Davis Online (Natural) - English (United States)",
    "Daniel",   // iOS/macOS male
    "Aaron",    // iOS 16+ male
    "Fred",     // iOS classic male
    "Google US English",
  ];

  for (const name of PREF) {
    const v = voices.find(v => v.name.toLowerCase().includes(name.toLowerCase()) && v.lang.startsWith("en"));
    if (v) { _cachedVoice = v; return v; }
  }

  // Any non-female English voice
  const FEMALE = ["female","woman","zira","hazel","susan","karen","moira","samantha","victoria","tessa","fiona"];
  const v = voices.find(v => v.lang.startsWith("en") && !FEMALE.some(w => v.name.toLowerCase().includes(w)));
  if (v) { _cachedVoice = v; return v; }
  return null;
}

window.speechSynthesis.onvoiceschanged = () => { _cachedVoice = null; };

function _fallbackBrowserTTS(text, fromChar, onDone, wrap) {
  // Block if ElevenLabs audio is actively playing
  if (_audioEl && !_audioEl.paused && !_audioEl.ended) return;
  const slice = text.slice(fromChar).trim();
  if (!slice) { _resetState(true); return; }

  _isSpeaking = true;
  _isPaused   = false;
  _onDone     = onDone || null;
  _activeWrap = wrap   || null;
  _setButtons(_activeWrap, "playing");

  const u    = new SpeechSynthesisUtterance(slice);
  u.lang     = "en-US";
  u.rate     = 0.96;
  u.pitch    = 1;
  u.volume   = 1;
  u.voice    = _getFlowVoice();

  u.onboundary = (e) => {
    if (e.name === "word") {
      _charOffset   = fromChar + (e.charIndex || 0);
      _lastBoundary = performance.now();
      _envelope     = 0.6 + Math.random() * 0.4;
    }
  };
  u.onend   = () => { if (!_isPaused) _resetState(true); };
  u.onerror = (e) => { if (e.error !== "interrupted") _resetState(true); };

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// ── Check if ElevenLabs is configured (cached after first check) ──────────
let _elAvailable = null;
async function _checkEL() {
  if (_elAvailable !== null) return _elAvailable;
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ text: "." }) });
    _elAvailable = r.ok;
  } catch (_) { _elAvailable = false; }
  return _elAvailable;
}

// ── Public Speech API ─────────────────────────────────────────────────────
export const Speech = {

  async speak(text, onDone, wrap) {
    const clean = stripForSpeech(text);
    if (!clean || clean === "here is the code") { if (onDone) onDone(); return; }

    // ── Stop everything currently playing — one clean slate ──────────────
    _isSpeaking = false;
    _isPaused   = false;
    if (_audioEl) {
      try { _audioEl.pause(); _audioEl.src = ''; } catch(_) {}
      _audioEl = null;
    }
    window.speechSynthesis.cancel();

    if (_activeWrap && _activeWrap !== wrap) _setButtons(_activeWrap, 'idle');
    _fullText   = clean;
    _charOffset = 0;
    _activeWrap = wrap;
    _onDone     = onDone || null;

    // ── LOCK speaking immediately (synchronous) before any await ──────────
    // This prevents browser TTS from starting during the ElevenLabs fetch
    _isSpeaking = true;

    // ── Try ElevenLabs first ──────────────────────────────────────────────
    // _elAvailable is cached after first check — no network roundtrip per speak
    if (_elAvailable === null) await _checkEL();  // only fetches once per session

    if (_elAvailable) {
      const ok = await _speakElevenLabs(clean, onDone, wrap);
      if (ok) return;  // ElevenLabs playing — done
      // ElevenLabs failed this call — fall through to browser TTS
    }

    // ── Browser TTS fallback ──────────────────────────────────────────────
    // Only runs if ElevenLabs is not configured OR failed this specific call
    _isSpeaking = false;  // reset so _fallbackBrowserTTS can set it
    _fallbackBrowserTTS(clean, 0, onDone, wrap);
  },

  pause() {
    if (!_isSpeaking || _isPaused) return;
    _isPaused = true;
    _envelope = 0;
    const savedWrap = _activeWrap;
    const savedDone = _onDone;
    if (_audioEl) { _audioEl.pause(); _isSpeaking = true; _setButtons(savedWrap, "paused"); return; }
    window.speechSynthesis.cancel();
    _isSpeaking = true;
    _isPaused   = true;
    _activeWrap = savedWrap;
    _onDone     = savedDone;
    _setButtons(savedWrap, "paused");
  },

  resume() {
    if (!_isPaused) return;
    _isPaused = false;
    if (_audioEl && _audioEl.paused) { _audioEl.play(); _setButtons(_activeWrap, "playing"); return; }
    _fallbackBrowserTTS(_fullText, _charOffset, _onDone, _activeWrap);
  },

  cancel() {
    if (_audioEl) { _audioEl.pause(); _audioEl.src = ""; _audioEl = null; }
    window.speechSynthesis.cancel();
    _resetState(false);
  },

  reread(wrap) {
    this.cancel();
    const bubble = wrap?.querySelector?.(".mbubble");
    if (bubble) this.speak(bubble.textContent || "", null, wrap);
  },

  isSpeaking()  { return _isSpeaking && !_isPaused; },
  isPaused()    { return _isPaused; },
  getEnvelope() { return _envelope; },
};
