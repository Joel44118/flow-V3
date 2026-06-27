// core/wakeword.js (v4)
// FIX: PWA/desktop app mic permission — SpeechRecognition blocked until
//      first user gesture. Solution: defer startWakeListener until first
//      click/keydown/touchstart, then auto-restart if it silently dies.

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
let _wakeLock = false;
let _started  = false;

const WAKE_STRIP_RX = new RegExp(CONFIG.WAKE_REGEX.source, "gi");

// ── Audio beep ────────────────────────────────────────────────────────────
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

// ── Wake listener ─────────────────────────────────────────────────────────
function _buildWakeRec() {
  if (!SR) return null;
  const r = new SR();
  r.continuous      = true;
  r.interimResults  = true;
  r.lang            = "en-US";
  r.maxAlternatives = 8;

  r.onresult = (e) => {
    if (Speech.isSpeaking()) return;
    if (_wakeLock) return;

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      let all = "";
      for (let a = 0; a < res.length; a++) all += " " + res[a].transcript.toLowerCase();
      if (!CONFIG.WAKE_REGEX?.test(all)) continue;

      _wakeLock = true;
      document.getElementById("wake-indicator")?.classList.add("active");
      _orbFn?.("listening");
      playActivationBeep();

      const inlineCmd = res.isFinal
        ? res[0].transcript.toLowerCase()
            .replace(WAKE_STRIP_RX, "")
            .replace(/[.,!?]/g, "")
            .trim()
        : "";

      if (inlineCmd.length > 3) {
        setTimeout(() => {
          _wakeLock = false;
          document.getElementById("wake-indicator")?.classList.remove("active");
          _sendFn(inlineCmd);
          _orbFn?.("idle");
        }, 400);
      } else {
        _wakeLock = false;
        startCommandListen();
      }
      return;
    }
  };

  r.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted")
      console.warn("[Flow] Wake SR error:", e.error);
    _wakeLock = false;
    // If mic was not-allowed in PWA, show indicator
    if (e.error === "not-allowed") {
      _showMicDenied();
    }
  };

  r.onend = () => {
    // Restart immediately unless we intentionally stopped for a command
    if (!cmdRec) {
      setTimeout(() => {
        try { wakeRec?.start(); } catch(_) {}
      }, 120);
    }
  };

  return r;
}

function _showMicDenied() {
  const ind = document.getElementById("wake-indicator");
  if (ind) { ind.textContent = "🎤 Mic blocked — allow mic in browser settings"; ind.classList.add("active"); }
}

// ── Public start — defers until first user gesture if needed ──────────────
export function startWakeListener() {
  if (!SR) { console.warn("[Flow] SpeechRecognition not supported"); return; }
  if (_started) return;

  function _doStart() {
    if (_started) return;
    _started = true;

    // Request mic permission explicitly first (unblocks PWA)
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(stream => {
        // Got permission — stop the test stream immediately, SR handles its own
        stream.getTracks().forEach(t => t.stop());
        wakeRec = _buildWakeRec();
        try { wakeRec.start(); console.log("[Flow] Wake listener started ✓"); } catch(e) { console.warn("[Flow] Wake start err:", e); }
      })
      .catch(err => {
        console.warn("[Flow] Mic permission denied:", err);
        _showMicDenied();
        // Still try SR anyway (some browsers allow it even without getUserMedia)
        wakeRec = _buildWakeRec();
        try { wakeRec.start(); } catch(_) {}
      });
  }

  // Try immediately (works if user already interacted with page)
  // If it fails, wait for first gesture
  try {
    wakeRec = _buildWakeRec();
    wakeRec.start();
    _started = true;
    console.log("[Flow] Wake listener started immediately ✓");
  } catch(e) {
    // NotAllowedError or InvalidStateError — wait for first gesture
    console.log("[Flow] Wake deferred until gesture...");
    const events = ["click", "keydown", "touchstart", "pointerdown"];
    const handler = () => {
      events.forEach(ev => document.removeEventListener(ev, handler));
      _doStart();
    };
    events.forEach(ev => document.addEventListener(ev, handler, { once: false }));

    // Also try after 2s (user may have already interacted before boot)
    setTimeout(() => { if (!_started) _doStart(); }, 2000);
  }
}

// ── Command listener ──────────────────────────────────────────────────────
export function startCommandListen() {
  if (!SR) return;
  try { wakeRec?.stop(); } catch(_) {}
  if (cmdRec) { try { cmdRec.abort(); } catch(_) {} cmdRec = null; }

  const micBtn = document.getElementById("mic-btn");

  cmdRec = new SR();
  cmdRec.lang           = "en-US";
  cmdRec.continuous     = true;
  cmdRec.interimResults = true;
  cmdRec.maxAlternatives = 1;

  _orbFn?.("listening");
  if (micBtn) micBtn.textContent = "⏹";

  let _transcript   = "";
  let _silenceTimer = null;

  function _resetSilenceTimer() {
    if (_silenceTimer) clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(_finish, 3000);
  }

  function _finish() {
    if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
    try { cmdRec?.abort(); } catch(_) {}
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
    // Restart wake listener
    setTimeout(() => {
      try { wakeRec?.start(); } catch(_) {}
    }, 400);
  }

  cmdRec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) _transcript += " " + r[0].transcript;
      else interim = r[0].transcript;
    }
    if (interim || e.results[e.resultIndex]?.isFinal) _resetSilenceTimer();
  };

  cmdRec.onerror = (e) => {
    if (e.error === "no-speech") _finish();
    else { console.warn("[Flow] cmdRec error:", e.error); _finish(); }
  };

  cmdRec.onend = () => { if (_silenceTimer) _finish(); };

  _resetSilenceTimer();
  try { cmdRec.start(); } catch(e) {
    console.error("[Flow] cmdRec start failed:", e);
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
  }
}
