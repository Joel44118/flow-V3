// ═══════════════════════════════════════════
// core/wakeword.js
// ═══════════════════════════════════════════
import { CONFIG } from "./config.js";
import { Speech } from "./speech.js";

let _sendFn = null;
let _orbFn  = null;
export function init(sendFn, setOrbState) {
  _sendFn = sendFn;
  _orbFn  = setOrbState;
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let wakeRec    = null;
let cmdRec     = null;
let _wakeLock  = false;

// Single source of truth for the wake pattern lives in CONFIG.WAKE_REGEX —
// build a global version off the same source for stripping the phrase out
// of a transcript to recover any inline command spoken in the same breath.
const WAKE_STRIP_RX = new RegExp(CONFIG.WAKE_REGEX.source, "gi");

// ── Audio ─────────────────────────────────────────────────────────────────
let _audioCtx = null;
function _ctx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playActivationBeep() {
  try {
    const ctx = _ctx();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = "sine";
      const t = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.start(t); osc.stop(t + 0.2);
    });
  } catch(e) {}
}

// ── Wake listener (always on) ─────────────────────────────────────────────
export function startWakeListener() {
  if (!SR) { console.warn("[Flow] SR not supported"); return; }

  wakeRec = new SR();
  wakeRec.continuous     = true;
  // Listening to interim (not-yet-final) results too means the wake phrase
  // is caught the instant the engine's first guess matches, instead of
  // waiting for it to finish "endpointing" the whole utterance — faster
  // AND more sensitive, since a quiet/distant "hey flow" sometimes never
  // gets a confident final result at all.
  wakeRec.interimResults = true;
  wakeRec.lang           = "en-US";
  wakeRec.maxAlternatives = 8; // wider net of guesses to test the wake pattern against

  wakeRec.onresult = (e) => {
    if (Speech.isSpeaking()) return;
    if (_wakeLock) return;

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];

      let all = "";
      for (let a = 0; a < res.length; a++) all += " " + res[a].transcript.toLowerCase();

      const isWake = CONFIG.WAKE_REGEX?.test(all);
      if (!isWake) continue;

      _wakeLock = true;
      document.getElementById("wake-indicator")?.classList.add("active");
      _orbFn?.("listening");
      playActivationBeep();  // instant feedback

      // Only trust an inline command ("hey flow, what's the weather") off a
      // FINAL result — interim text for the tail of the utterance is often
      // still being revised and isn't reliable enough to act on yet.
      const inlineCmd = res.isFinal
        ? res[0].transcript.toLowerCase()
            .replace(WAKE_STRIP_RX, "")
            .replace(/[.,!?]/g, "")
            .trim()
        : "";

      if (inlineCmd.length > 3) {
        // Full command in same utterance — send immediately
        setTimeout(() => {
          _wakeLock = false;
          document.getElementById("wake-indicator")?.classList.remove("active");
          _sendFn(inlineCmd);
          _orbFn?.("idle");
        }, 400);
      } else {
        // Just "Hey Flow" (or wake caught early via interim) — open mic
        // IMMEDIATELY, no wait, and let startCommandListen capture the rest
        _wakeLock = false;
        startCommandListen();
      }
      return;
    }
  };

  wakeRec.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted")
      console.warn("[Flow] Wake SR error:", e.error);
    _wakeLock = false;
  };

  wakeRec.onend = () => {
    // Restart as fast as the browser will allow — every millisecond the
    // wake listener is down is a window where "Hey Flow" goes unheard.
    // A short delay is still needed: calling start() while the previous
    // session is still tearing down throws InvalidStateError in Chrome.
    setTimeout(() => { try { wakeRec.start(); } catch(_){} }, 120);
  };

  try { wakeRec.start(); } catch(_){}
}

// ── Command listener ──────────────────────────────────────────────────────
// Behavior:
//   - Opens immediately after "Hey Flow"
//   - continuous=true so it keeps listening while you talk
//   - 3-second silence timer resets on every word heard
//   - When timer fires (3s of silence) → sends whatever was captured → stops
//   - If nothing heard at all within 3s → stops silently
export function startCommandListen() {
  if (!SR) return;
  try { wakeRec?.stop(); } catch(_){}
  if (cmdRec) { try { cmdRec.abort(); } catch(_){} cmdRec = null; }

  const micBtn = document.getElementById("mic-btn");

  cmdRec = new SR();
  cmdRec.lang            = "en-US";
  cmdRec.continuous      = true;   // keeps listening while you talk
  cmdRec.interimResults  = true;   // get partials so we can reset the silence timer
  cmdRec.maxAlternatives = 1;

  _orbFn?.("listening");
  if (micBtn) micBtn.textContent = "⏹";

  let _transcript  = "";   // accumulates final words
  let _silenceTimer = null;

  function _resetSilenceTimer() {
    if (_silenceTimer) clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(_finish, 3000);  // 3s of silence → send
  }

  function _finish() {
    if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
    try { cmdRec?.abort(); } catch(_){}
    cmdRec = null;
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
    document.getElementById("wake-indicator")?.classList.remove("active");

    const text = _transcript.trim();
    if (text.length > 1) {
      const inp = document.getElementById("user-input");
      if (inp) inp.textContent = text;
      _sendFn(text);
    }
    // restart wake listener
    setTimeout(() => { try { wakeRec?.start(); } catch(_){} }, 400);
  }

  cmdRec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        _transcript += " " + r[0].transcript;
      } else {
        interim = r[0].transcript;  // interim = something is being said
      }
    }
    // Any speech activity (final or interim) resets the 3s silence clock
    if (interim || e.results[e.resultIndex]?.isFinal) {
      _resetSilenceTimer();
    }
  };

  cmdRec.onerror = (e) => {
    if (e.error === "no-speech") {
      // no-speech fires after browser's own silence detection
      // treat it the same as our 3s timeout
      _finish();
    } else {
      console.warn("[Flow] cmdRec error:", e.error);
      _finish();
    }
  };

  cmdRec.onend = () => {
    // continuous=true means onend only fires if something stopped it externally
    // our _finish() calls abort() which triggers this — guard against double-send
    if (_silenceTimer) {
      // ended unexpectedly before our timer — treat as done
      _finish();
    }
  };

  // Start the 3s silence clock immediately (if you say nothing → stops after 3s)
  _resetSilenceTimer();

  try {
    cmdRec.start();
  } catch(e) {
    console.error("[Flow] cmdRec start failed:", e);
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
  }
}
