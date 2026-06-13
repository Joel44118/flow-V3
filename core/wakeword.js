// ═══════════════════════════════════════════
// core/wakeword.js
//
// Fixes:
//  - 3s delay after "hey flow" before listening
//    so ambient noise / partial phrases are ignored
//  - Activation sound (beep) plays immediately
//    when wake word detected — works across tabs
//  - Requires full FINAL result containing wake word
//    (not just interim) to avoid "airflow" triggers
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
let wakeRec   = null;
let cmdRec    = null;
let _wakeLock = false;  // prevents double-trigger during delay

// ── Activation beep (works even in background tab) ──
// Generated via Web Audio API — no file needed
let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playActivationBeep() {
  try {
    const ctx  = _getAudioCtx();
    // Two-tone rising beep — distinct and pleasant
    [880, 1320].forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = "sine";
      const start = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch(e) { console.warn("[Flow] Beep failed:", e.message); }
}

function playReadyBeep() {
  // Lower tone — signals "now speaking, I'm listening"
  try {
    const ctx  = _getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 660;
    osc.type = "sine";
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch(e) {}
}

// ── Wake word listener (always on) ───────────
export function startWakeListener() {
  if (!SR) { console.warn("[Flow] SR not supported"); return; }

  wakeRec = new SR();
  wakeRec.continuous      = true;
  wakeRec.interimResults  = false;  // FINAL results only — kills "airflow" false triggers
  wakeRec.lang            = "en-US";
  wakeRec.maxAlternatives = 5;

  wakeRec.onresult = (e) => {
    if (Speech.isSpeaking()) return;
    if (_wakeLock) return;  // already activated, waiting for delay

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (!res.isFinal) continue;  // only act on confirmed final results

      // Check all alternatives for wake phrase
      let all = "";
      for (let a = 0; a < res.length; a++) all += " " + res[a].transcript.toLowerCase();

      // Strict match — must contain "hey flow" or "hey flo"
      // NOT just "flow" alone to avoid triggering on random words
      const strictWake = /\bhey\s+fl[ao]w?\b|\bhey\s+flo\b/i.test(all);
      const looseWake  = CONFIG.WAKE_REGEX.test(all);

      if (!strictWake && !looseWake) continue;

      // Extract command after wake phrase
      const cmd = res[0].transcript.toLowerCase()
        .replace(/\bhey\s+fl[aeiou]?\w{0,3}\b/gi, "")
        .replace(/[.,!?]/g, "")
        .trim();

      // Activate
      _wakeLock = true;
      document.getElementById("wake-indicator")?.classList.add("active");
      _orbFn?.("listening");
      playActivationBeep();  // instant audio feedback — works across tabs

      if (cmd.length > 3) {
        // Command was included in the wake phrase — 1s delay then send
        setTimeout(() => {
          _wakeLock = false;
          document.getElementById("wake-indicator")?.classList.remove("active");
          _sendFn(cmd);
        }, 1000);
      } else {
        // Just "Hey Flow" — 3s delay then open mic
        // The delay filters out ambient noise and partial phrases
        setTimeout(() => {
          _wakeLock = false;
          document.getElementById("wake-indicator")?.classList.remove("active");
          playReadyBeep();  // second beep = "I'm ready, speak now"
          startCommandListen();
        }, 3000);
      }
    }
  };

  wakeRec.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted")
      console.warn("[Flow] Wake SR error:", e.error);
    _wakeLock = false;
  };

  wakeRec.onend = () => {
    setTimeout(() => { try { wakeRec.start(); } catch(_){} }, 300);
  };

  try { wakeRec.start(); } catch(_){}
}

// ── One-shot command listener (mic button + after wake) ──
export function startCommandListen() {
  if (!SR) return;
  try { wakeRec?.stop(); } catch(_){}
  if (cmdRec) { try { cmdRec.stop(); } catch(_){} }

  const micBtn = document.getElementById("mic-btn");
  cmdRec = new SR();
  cmdRec.lang            = "en-US";
  cmdRec.continuous      = false;
  cmdRec.interimResults  = false;
  cmdRec.maxAlternatives = 1;

  _orbFn?.("listening");
  if (micBtn) micBtn.textContent = "⏹";

  cmdRec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    const conf = e.results[0][0].confidence;
    if (conf < 0.35 && conf !== 0) { _orbFn?.("idle"); return; }
    const inp = document.getElementById("user-input");
    if (inp) inp.textContent = text;
    _sendFn(text);
  };

  cmdRec.onerror = (e) => {
    if (e.error === "no-speech") console.log("[Flow] No speech detected");
    _orbFn?.("idle");
    if (micBtn) micBtn.textContent = "🎤";
  };

  cmdRec.onend = () => {
    if (micBtn) micBtn.textContent = "🎤";
    setTimeout(() => { try { wakeRec?.start(); } catch(_){} }, 400);
  };

  try { cmdRec.start(); } catch(e) {
    console.error("[Flow] cmdRec start failed:", e);
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
  }
}
