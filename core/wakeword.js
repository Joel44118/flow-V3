// core/wakeword.js (v5) — Deepgram streaming, replaces browser SpeechRecognition
//
// WHY: Browser SpeechRecognition (Chrome's built-in engine) has a real accuracy
// ceiling — struggles with accents, background noise, and distance from mic,
// regardless of how the matching regex is tuned. Deepgram's Nova-2 model is
// purpose-built for streaming transcription and is materially more accurate.
//
// HOW IT WORKS:
// 1. Get a short-lived token from /api/tts?action=token (real key stays server-side)
// 2. Open a WebSocket to Deepgram's streaming endpoint
// 3. Stream raw mic audio continuously
// 4. Deepgram sends back transcripts in real time, with confidence + multiple alts
// 5. Same wake-word matching logic as before, but on much more accurate text
//
// FALLBACK: if DEEPGRAM_API_KEY isn't configured, falls back to the old
// browser SpeechRecognition path automatically — Flow still works either way.

import { CONFIG } from "./config.js";
import { Speech } from "./speech.js";

let _sendFn = null;
let _orbFn  = null;
export function init(sendFn, setOrbState) {
  _sendFn = sendFn;
  _orbFn  = setOrbState;
}

const WAKE_STRIP_RX = new RegExp(CONFIG.WAKE_REGEX.source, "gi");

let _wakeLock   = false;
let _started    = false;
let _mode       = null;     // 'deepgram' | 'browser'
let _dgSocket   = null;
let _dgStream   = null;
let _dgAudioCtx = null;
let _dgProcessor= null;

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

function _showMicDenied() {
  const ind = document.getElementById("wake-indicator");
  if (ind) { ind.textContent = "🎤 Mic blocked — allow mic in browser settings"; ind.classList.add("active"); }
}

// ── Shared: handle a transcript chunk from either engine ──────────────────
// alternatives: array of { transcript, confidence }
function _handleTranscript(alternatives, isFinal) {
  if (Speech.isSpeaking()) return;
  if (_wakeLock) return;

  let matched = null;
  for (const alt of alternatives) {
    if (CONFIG.WAKE_REGEX?.test(alt.transcript.toLowerCase())) { matched = alt; break; }
  }
  if (!matched) return;

  _wakeLock = true;
  document.getElementById("wake-indicator")?.classList.add("active");
  _orbFn?.("listening");
  playActivationBeep();

  const inlineCmd = isFinal
    ? matched.transcript.toLowerCase().replace(WAKE_STRIP_RX, "").replace(/[.,!?]/g, "").trim()
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
}

// ── DEEPGRAM streaming path ─────────────────────────────────────────────────
async function _startDeepgram() {
  try {
    const tokRes = await fetch("/api/tts?action=token");
    const tok    = await tokRes.json();
    if (!tok.configured || !tok.key) return false;  // not configured — fall back

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _dgStream = stream;

    const url = "wss://api.deepgram.com/v1/listen"
      + "?model=nova-2"
      + "&language=en"
      + "&interim_results=true"
      + "&endpointing=300"
      + "&alternatives=5"
      + "&smart_format=true";

    const socket = new WebSocket(url, ["token", tok.key]);
    _dgSocket = socket;

    socket.onopen = () => {
      console.log("[Flow] Deepgram connected ✓");
      _dgAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = _dgAudioCtx.createMediaStreamSource(stream);
      _dgProcessor = _dgAudioCtx.createScriptProcessor(4096, 1, 1);

      source.connect(_dgProcessor);
      _dgProcessor.connect(_dgAudioCtx.destination);

      _dgProcessor.onaudioprocess = (e) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input  = e.inputBuffer.getChannelData(0);
        const pcm16  = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        socket.send(pcm16.buffer);
      };
    };

    socket.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        const alts = data?.channel?.alternatives;
        if (!alts?.length) return;
        const formatted = alts.map(a => ({
          transcript: a.transcript || "",
          confidence: a.confidence || 0,
        })).filter(a => a.transcript);
        if (!formatted.length) return;
        _handleTranscript(formatted, !!data.is_final);
      } catch(_) {}
    };

    socket.onerror = (e) => {
      console.warn("[Flow] Deepgram socket error — falling back to browser SR");
      _teardownDeepgram();
      _startBrowserSR();
    };

    socket.onclose = () => {
      // Reconnect automatically unless we're mid-command-listen
      if (_mode === "deepgram" && !window.__flowCmdActive) {
        setTimeout(() => { if (_mode === "deepgram") _startDeepgram(); }, 500);
      }
    };

    _mode = "deepgram";
    return true;
  } catch (err) {
    console.warn("[Flow] Deepgram setup failed, falling back:", err.message);
    return false;
  }
}

function _teardownDeepgram() {
  try { _dgProcessor?.disconnect(); } catch(_) {}
  try { _dgAudioCtx?.close(); } catch(_) {}
  try { _dgSocket?.close(); } catch(_) {}
  try { _dgStream?.getTracks().forEach(t => t.stop()); } catch(_) {}
  _dgProcessor = _dgAudioCtx = _dgSocket = _dgStream = null;
}

// ── BROWSER SpeechRecognition fallback path (unchanged logic) ─────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let wakeRec = null;
let cmdRec  = null;

function _buildWakeRec() {
  if (!SR) return null;
  const r = new SR();
  r.continuous = true; r.interimResults = true; r.lang = "en-US"; r.maxAlternatives = 8;

  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alts = [];
      for (let a = 0; a < res.length; a++) alts.push({ transcript: res[a].transcript, confidence: res[a].confidence || 0 });
      _handleTranscript(alts, res.isFinal);
    }
  };
  r.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted") console.warn("[Flow] Wake SR error:", e.error);
    if (e.error === "not-allowed") _showMicDenied();
  };
  r.onend = () => { if (!cmdRec) setTimeout(() => { try { wakeRec?.start(); } catch(_) {} }, 120); };
  return r;
}

function _startBrowserSR() {
  if (!SR) { console.warn("[Flow] No speech recognition available at all"); return; }
  _mode = "browser";
  navigator.mediaDevices?.getUserMedia({ audio: true })
    .then(stream => {
      stream.getTracks().forEach(t => t.stop());
      wakeRec = _buildWakeRec();
      try { wakeRec.start(); console.log("[Flow] Browser SR wake listener started"); } catch(_) {}
    })
    .catch(() => {
      _showMicDenied();
      wakeRec = _buildWakeRec();
      try { wakeRec.start(); } catch(_) {}
    });
}

// ── Public: start wake listener — tries Deepgram first, falls back ────────
export async function startWakeListener() {
  if (_started) return;
  _started = true;

  const ok = await _startDeepgram();
  if (!ok) _startBrowserSR();

  // One-time visible confirmation of which engine actually activated —
  // without this, a silent failure and a working listener look identical
  // from the chat UI, which is exactly what made this hard to diagnose.
  setTimeout(() => {
    if (_mode === "deepgram" && _dgSocket?.readyState === WebSocket.OPEN) {
      _sendFn?.("__SYSTEM__🎙️ Voice listening active — using Deepgram (high accuracy).");
    } else if (_mode === "browser" && wakeRec) {
      _sendFn?.("__SYSTEM__🎙️ Voice listening active — using your browser's built-in speech recognition (Deepgram not configured or unreachable).");
    } else {
      _sendFn?.("__SYSTEM__⚠️ Voice listening did not start — no working speech engine was found. Say the wake word won't do anything until this is resolved.");
    }
  }, 1800);
}

// ── Command listener — explicit command after wake word or mic button ─────
export function startCommandListen() {
  window.__flowCmdActive = true;

  if (_mode === "deepgram" && _dgSocket?.readyState === WebSocket.OPEN) {
    _runDeepgramCommand();
  } else if (SR) {
    _runBrowserCommand();
  } else {
    // Genuine dead end — neither engine is usable. This used to fail with
    // zero feedback, which is exactly what looked like "Flow isn't hearing
    // me" with no way to tell why. Now it says so directly, in chat.
    window.__flowCmdActive = false;
    _orbFn?.("idle");
    if (_sendFn) {
      _sendFn("__SYSTEM__⚠️ Voice input isn't available right now — your browser doesn't support speech recognition and Deepgram isn't reachable. Voice commands need either a Chrome-based browser or a working Deepgram connection.");
    }
  }
}

function _finishCommand(text, micBtn) {
  window.__flowCmdActive = false;
  if (micBtn) micBtn.textContent = "🎤";
  _orbFn?.("idle");
  document.getElementById("wake-indicator")?.classList.remove("active");

  const trimmed = text.trim();
  if (trimmed.length > 1) {
    const inp = document.getElementById("user-input");
    if (inp) inp.textContent = trimmed;
    _sendFn(trimmed);
  }

  // Resume wake listening
  setTimeout(() => {
    if (_mode === "deepgram") { if (!_dgSocket || _dgSocket.readyState !== WebSocket.OPEN) _startDeepgram(); }
    else { try { wakeRec?.start(); } catch(_) {} }
  }, 400);
}

function _runDeepgramCommand() {
  const micBtn = document.getElementById("mic-btn");
  _orbFn?.("listening");
  if (micBtn) micBtn.textContent = "⏹";

  let transcript = "";
  let silenceTimer = null;
  const resetSilence = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      socket.removeEventListener("message", onMsg);
      _finishCommand(transcript, micBtn);
    }, 4200);
  };

  const socket = _dgSocket;
  function onMsg(msg) {
    try {
      const data = JSON.parse(msg.data);
      const best = data?.channel?.alternatives?.[0];
      if (!best?.transcript) return;
      if (data.is_final) transcript += " " + best.transcript;
      resetSilence();
    } catch(_) {}
  }
  socket.addEventListener("message", onMsg);
  resetSilence();
}

function _runBrowserCommand() {
  try { wakeRec?.stop(); } catch(_) {}
  if (cmdRec) { try { cmdRec.abort(); } catch(_) {} cmdRec = null; }

  const micBtn = document.getElementById("mic-btn");
  cmdRec = new SR();
  cmdRec.lang = "en-US"; cmdRec.continuous = true; cmdRec.interimResults = true; cmdRec.maxAlternatives = 5;

  _orbFn?.("listening");
  if (micBtn) micBtn.textContent = "⏹";

  let _transcript = "";
  let _silenceTimer = null;
  const resetSilence = () => {
    if (_silenceTimer) clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(finish, 4200);
  };
  const finish = () => {
    if (_silenceTimer) { clearTimeout(_silenceTimer); _silenceTimer = null; }
    try { cmdRec?.abort(); } catch(_) {}
    cmdRec = null;
    _finishCommand(_transcript, micBtn);
  };

  cmdRec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      let best = r[0];
      for (let a = 1; a < r.length; a++) if ((r[a].confidence || 0) > (best.confidence || 0)) best = r[a];
      if (r.isFinal) _transcript += " " + best.transcript;
      else interim = best.transcript;
    }
    if (interim || e.results[e.resultIndex]?.isFinal) resetSilence();
  };
  cmdRec.onerror = (e) => { if (e.error === "no-speech") finish(); else finish(); };
  cmdRec.onend = () => { if (_silenceTimer) finish(); };

  resetSilence();
  try { cmdRec.start(); } catch(e) {
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
  }
}
