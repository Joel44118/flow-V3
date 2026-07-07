// core/wakeword.js (v7) — Self-hosted voice pipeline (openWakeWord + faster-whisper)
//
// WHY THIS REPLACES THE DEEPGRAM VERSION ENTIRELY:
// Across many debugging rounds, Deepgram's Voice Agent WebSocket kept
// failing at the handshake layer with "HTTP Authentication failed" or
// generic connection errors. Ruled out along the way: token freshness,
// token TTL, token scope, the Groq think-provider config (all fixed and
// confirmed correct), and even a completely raw WebSocket test OUTSIDE
// Flow's own code — using Joel's real key directly — ALSO failed with
// zero detail. That last result is what settled it: this points at
// something in Joel's local network/security-software environment
// blocking or resetting outbound WebSocket connections to Deepgram
// specifically, not a bug in Flow's code. Rather than keep fighting an
// external dependency neither of us can fully diagnose from here, this
// version is fully self-hosted — Joel owns every layer of it.
//
// NEW ARCHITECTURE:
//   - core/wakeword.js (this file) captures mic audio and streams it,
//     continuously, to Joel's own Railway-hosted voice service
//     (flow-voice-service/server.py).
//   - That service runs openWakeWord (listening for "hey jarvis" — the
//     closest pre-trained match to "hey flow"; a real custom "hey flow"
//     model can be trained later, see the service's own file for how)
//     and, once triggered, faster-whisper for transcription.
//   - The service sends back {"type": "transcript", "text": "..."} over
//     the same WebSocket once it has real text.
//   - This file then hands that text to Flow's EXISTING send pipeline —
//     exactly the same path a typed message takes. No separate "think"
//     or "speak" stage lives in this file; Flow's normal /api/chat +
//     ElevenLabs TTS handle that already, completely unchanged.
//
// FALLBACK: if the voice service is unreachable, falls back to the
// browser's built-in SpeechRecognition — same safety net as always,
// though this is known unreliable inside Electron specifically (see
// the comment further down) since Electron's bundled Chromium has no
// Google API key for its speech backend.

import { CONFIG } from "./config.js";
import { Speech } from "./speech.js";

const IS_ELECTRON = !!window.__flowElectron;

let _sendFn = null;
let _orbFn  = null;
export function init(sendFn, setOrbState) {
  _sendFn = sendFn;
  _orbFn  = setOrbState;
}

function _sysNotice(text) { _sendFn?.("__SYSTEM__" + text); }

// ── Config: point this at your own Railway voice service's URL ─────────
// Set this in core/config.js as CONFIG.VOICE_SERVICE_URL, e.g.
// "wss://flow-voice-service-production.up.railway.app" — Railway gives
// you this URL once the service is deployed. Falls back to a placeholder
// that will visibly fail to connect if never configured, rather than
// silently pointing nowhere.
const VOICE_SERVICE_URL = CONFIG.VOICE_SERVICE_URL || "wss://CONFIGURE-ME.up.railway.app";

// ── Shared state ────────────────────────────────────────────────────────
let _started       = false;
let _mode          = null;     // 'service' | 'browser'
let _socket        = null;
let _stream        = null;
let _audioCtx      = null;
let _processorNode = null;
let _reconnecting  = false;
let _lastError     = null;
let _connectResolve = null;

// ── Core: connect to Joel's self-hosted voice service ──────────────────
async function _connectVoiceService() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, channelCount: 1 } });
    _stream = stream;

    const socket = new WebSocket(VOICE_SERVICE_URL);
    socket.binaryType = "arraybuffer";
    _socket = socket;

    socket.onopen = () => {
      console.log("[Voice] Connected to self-hosted voice service.");
      _startMicStreaming(stream);
    };

    socket.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (_) { return; }

      if (msg.type === "wake_detected") {
        console.log("[Voice] Wake word detected.");
        _orbFn?.("listening");
      } else if (msg.type === "transcript") {
        console.log("[Voice] Transcript:", msg.text);
        _orbFn?.("idle");
        _sendFn(msg.text); // hands off to Flow's normal send pipeline — identical to a typed message
      } else if (msg.type === "transcript_empty") {
        _orbFn?.("idle"); // likely a false wake trigger (noise) — nothing to send, just reset the orb
      } else if (msg.type === "error") {
        console.error("[Voice] Service error:", msg.message);
      }

      if (msg.type && _connectResolve) {
        _connectResolve(true); // any real message proves the connection genuinely works
        _connectResolve = null;
      }
    };

    socket.onerror = () => {
      console.warn("[Voice] Socket error connecting to voice service.");
      if (!_lastError) _lastError = "WebSocket connection error reaching the voice service (no further detail available from the browser)";
      _teardown();
      if (_connectResolve) { _connectResolve(false); _connectResolve = null; }
    };

    socket.onclose = (evt) => {
      if (_connectResolve) {
        if (!_lastError) _lastError = `Voice service connection closed before it was ready (code ${evt.code}${evt.reason ? ": " + evt.reason : ""})`;
        _connectResolve(false);
        _connectResolve = null;
        return;
      }
      if (_mode === "service" && !_reconnecting) {
        _reconnecting = true;
        setTimeout(async () => {
          _reconnecting = false;
          if (_mode === "service") {
            const ok = await _connectVoiceService();
            if (!ok) _startBrowserSR();
          }
        }, 1500);
      }
    };

    _mode = "service";
    const result = await new Promise((resolve) => {
      _connectResolve = resolve;
      setTimeout(() => {
        if (_connectResolve) {
          if (!_lastError) _lastError = "Timed out waiting for the voice service to respond";
          _connectResolve(false);
          _connectResolve = null;
        }
      }, 8000); // a bit longer than Deepgram's timeout — Railway free-tier services can have a cold-start delay
    });
    return result;
  } catch (err) {
    console.warn("[Voice] Connect failed:", err.message);
    _lastError = err.message;
    return false;
  }
}

// Streams mic audio to the voice service as raw 16-bit PCM at 16kHz,
// matching exactly what openWakeWord and faster-whisper both expect —
// converting sample rate/format client-side means the server never has
// to guess or transcode, keeping the server simple and fast.
function _startMicStreaming(stream) {
  _audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = _audioCtx.createMediaStreamSource(stream);

  // ScriptProcessorNode is deprecated in favor of AudioWorklet, but is
  // used here deliberately for simplicity and because it still works
  // reliably across both Electron's and Chrome's current versions —
  // an AudioWorklet migration is a reasonable future improvement, not
  // a correctness issue today.
  _processorNode = _audioCtx.createScriptProcessor(1280, 1, 1);

  _processorNode.onaudioprocess = (e) => {
    if (!_socket || _socket.readyState !== WebSocket.OPEN) return;
    const floatData = e.inputBuffer.getChannelData(0);
    const int16Data = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]));
      int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; // float32 [-1,1] -> int16 PCM
    }
    _socket.send(int16Data.buffer);
  };

  source.connect(_processorNode);
  _processorNode.connect(_audioCtx.destination);
}

function _teardown() {
  try { _processorNode?.disconnect(); } catch (_) {}
  try { _audioCtx?.close(); } catch (_) {}
  try { _stream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { _socket?.close(); } catch (_) {}
  _socket = null;
  _audioCtx = null;
  _processorNode = null;
}

// ── BROWSER SpeechRecognition fallback (only if the service is unreachable) ──
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let wakeRec = null;
let _browserSRDeadInElectron = false;

function _buildWakeRec() {
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = "en-US";

  rec.onresult = (e) => {
    const transcript = e.results[e.results.length - 1][0].transcript.trim();
    if (CONFIG.WAKE_REGEX?.test(transcript)) {
      const cmd = transcript.replace(CONFIG.WAKE_REGEX, "").trim();
      if (cmd) _sendFn(cmd);
    }
  };
  rec.onerror = (e) => {
    console.warn("[Flow] Wake SR error:", e.error);
    if (IS_ELECTRON) _browserSRDeadInElectron = true;
  };
  rec.onend = () => {
    if (_mode === "browser" && !_browserSRDeadInElectron) {
      try { rec.start(); } catch (_) {}
    }
  };
  return rec;
}

function _startBrowserSR() {
  if (IS_ELECTRON) {
    console.warn("[Flow] Browser SpeechRecognition is unreliable in Electron (Chromium's speech backend needs a Google API key that Electron doesn't bundle) — the voice service is effectively required for voice in the desktop app.");
  }
  if (!SR) {
    console.warn("[Flow] No browser SpeechRecognition available at all.");
    return;
  }
  _mode = "browser";
  wakeRec = _buildWakeRec();
  try {
    wakeRec.start();
    console.log("[Flow] Browser SR fallback started");
  } catch (e) {
    console.warn("[Flow] Failed to start browser SR:", e.message);
  }
}

function _runBrowserCommand() {
  if (!SR) { window.__flowCmdActive = false; _orbFn?.("idle"); return; }
  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = "en-US";
  _orbFn?.("listening");
  rec.onresult = (e) => {
    const trimmed = e.results[0][0].transcript.trim();
    if (trimmed) _sendFn(trimmed);
    _orbFn?.("idle");
    window.__flowCmdActive = false;
  };
  rec.onerror = () => { _orbFn?.("idle"); window.__flowCmdActive = false; };
  rec.onend = () => { window.__flowCmdActive = false; };
  try { rec.start(); } catch (_) { window.__flowCmdActive = false; _orbFn?.("idle"); }
}

// ── Public entry points ──────────────────────────────────────────────────
export async function startWakeListener() {
  if (_started) return;
  _started = true;

  const ok = await _connectVoiceService();

  if (_mode === "service" && _socket?.readyState === WebSocket.OPEN) {
    console.log("[Voice] Ready — listening for wake word via self-hosted service.");
    return;
  }

  if (IS_ELECTRON) {
    _sysNotice(`⚠️ Voice can't work right now — the self-hosted voice service failed to connect (${_lastError || "unknown reason"}), and the browser speech fallback doesn't work inside the Electron desktop app at all (a known Chromium/Electron limitation, not fixable from Flow's side). Check that the Railway voice service is actually running and that CONFIG.VOICE_SERVICE_URL in core/config.js points to its real URL.`);
    _startBrowserSR(); // starts anyway for logging/consistency, but is known non-functional in Electron
    return;
  }

  _startBrowserSR();
  if (SR) {
    _sysNotice(`🎙️ Voice active — using your browser's built-in speech recognition. Voice service fallback reason: ${_lastError || "unknown"}.`);
  } else {
    _sysNotice("⚠️ Voice listening did not start — no working speech engine was found.");
  }
}

export function startCommandListen() {
  window.__flowCmdActive = true;
  if (_mode === "service" && _socket?.readyState === WebSocket.OPEN) {
    // The service is already listening continuously — a manual mic-button
    // press doesn't need to do anything extra here, it's already capturing.
    window.__flowCmdActive = false;
  } else if (SR) {
    _runBrowserCommand();
  } else {
    window.__flowCmdActive = false;
    _orbFn?.("idle");
    _sysNotice("⚠️ Voice input isn't available right now — no speech engine is reachable.");
  }
}
