// core/wakeword.js (v6) — Deepgram VOICE AGENT, not raw transcription
//
// WHY THIS REPLACES v5 ENTIRELY:
// v5 streamed raw audio to Deepgram's /v1/listen transcription endpoint,
// then ran a hand-built silence timer + wake-word regex + separate
// ElevenLabs call for the reply. That's three independently fragile pieces
// glued together, and every seam was a place voice could silently die —
// which is exactly what happened.
//
// Deepgram's Voice Agent API (wss://agent.deepgram.com/v1/agent/converse)
// is a single WebSocket that does STT + turn-taking + LLM + TTS as ONE
// engineered pipeline. It listens continuously, decides on its own when
// Joel has finished a thought (endpointing built into the model, not a
// hand-rolled timer), and speaks back over the same socket. This removes
// almost all of the fragile custom logic — there's just far less to break.
//
// THE WAKE WORD ITSELF is now handled by keeping the agent in "asleep"
// mode until it hears "hey flow" / "flow" in a transcript, then waking it —
// this uses the SAME regex Flow always used (CONFIG.WAKE_REGEX), just
// applied to the agent's live transcript stream instead of a separate
// recognizer. One matching engine, one source of truth, not two competing
// speech systems running at once.
//
// FALLBACK: if DEEPGRAM_API_KEY isn't configured or the connection fails,
// falls back to the browser's built-in SpeechRecognition — same safety
// net as before, so Flow never goes completely voice-deaf.

import { CONFIG } from "./config.js";
import { Speech } from "./speech.js";

// BUG FIX: this was referenced below (in _startBrowserSR) but never
// actually declared anywhere in this file, or imported from anywhere else
// that exports it. Referencing an undeclared variable throws a
// ReferenceError, uncaught, at the exact point _startBrowserSR() checked
// it — which silently killed the entire browser-fallback path before it
// ever reached getUserMedia() or created wakeRec. This is why "no working
// speech engine was found" appeared even with correct OS mic permissions:
// the fallback never actually ran, it crashed before doing anything.
// Matches the same detection pattern already used correctly in
// ui/screencontrol.js, so Electron detection is now consistent app-wide.
const IS_ELECTRON = !!window.__flowElectron;

let _sendFn = null;
let _orbFn  = null;
export function init(sendFn, setOrbState) {
  _sendFn = sendFn;
  _orbFn  = setOrbState;
}

function _sysNotice(text) { _sendFn?.("__SYSTEM__" + text); }

// ── Shared state ────────────────────────────────────────────────────────
let _started      = false;
let _mode         = null;    // 'agent' | 'browser'
let _asleep       = true;    // agent connects immediately but stays "asleep"
                              // until the wake word is heard — mirrors the
                              // old wake-then-listen UX Joel is used to
let _socket       = null;
let _stream       = null;
let _audioCtx     = null;
let _processor    = null;
let _playCtx      = null;    // separate AudioContext for playing agent's TTS
let _playQueueTime = 0;
let _tokenExpiresAt = 0;
let _reconnecting  = false;
let _connectResolve = null; // holds the pending Promise resolver while _connectAgent waits for real success/failure proof

const AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse";

// ── Activation beep — unchanged from before ────────────────────────────
let _beepCtx = null;
function _beep() {
  try {
    if (!_beepCtx) _beepCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _beepCtx;
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
  } catch (_) {}
}

function _showMicDenied() {
  const ind = document.getElementById("wake-indicator");
  if (ind) { ind.textContent = "🎤 Mic blocked — allow mic in browser settings"; ind.classList.add("active"); }
}
function _setWakeUI(active) {
  document.getElementById("wake-indicator")?.classList.toggle("active", !!active);
}

// ── Fetch a short-lived Deepgram token from our own server ────────────
let _lastTokenError = null;
let _browserSRDeadInElectron = false;
async function _getToken() {
  const r = await fetch("/api/tts?action=token");
  const d = await r.json();
  if (!d.configured || !d.key) {
    // This used to silently discard d.error and just return null, making
    // "key not set at all" and "key set but wrong permission scope" look
    // completely identical from here — both just fell back to the generic
    // browser-SR message. Now the real reason (e.g. a 403 because the
    // Deepgram key needs Member role or higher, not just read/write) is
    // kept and surfaced in the startup status notice.
    _lastTokenError = d.error || "Deepgram not configured";
    return null;
  }
  _tokenExpiresAt = Date.now() + 4.5 * 60 * 1000; // token is 5min TTL, refresh a bit early
  return d.key;
}

// Groq is a BYO ("bring your own") think provider for Deepgram's Voice
// Agent — per Deepgram's own docs, that means it REQUIRES an
// endpoint.url + endpoint.headers block in the Settings message, not just
// a provider type + model name. There is no separate "add your Groq key
// inside Deepgram's console" step — that was wrong in an earlier version
// of this comment. The key must travel inside the WebSocket Settings
// message itself. To avoid ever putting the raw key in this client-side
// file, it's fetched from our own backend (api/tts.js?action=groqthink),
// which reads process.env.GROQ_API_KEY server-side and hands back just
// the endpoint/header shape Deepgram needs.
let _groqThinkConfig = null;
async function _fetchGroqThinkConfig() {
  if (_groqThinkConfig) return _groqThinkConfig;
  try {
    const r = await fetch("/api/tts?action=groqthink");
    const d = await r.json();
    if (!d.configured || !d.endpoint) return null;
    _groqThinkConfig = d.endpoint;
    return _groqThinkConfig;
  } catch (e) {
    console.warn("[Flow Agent] Failed to fetch Groq think config:", e.message);
    return null;
  }
}

// ── Play agent audio (linear16 PCM chunks) through Web Audio ──────────
function _playAgentAudio(arrayBuf) {
  try {
    if (!_playCtx) _playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    const pcm16 = new Int16Array(arrayBuf);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

    const buf = _playCtx.createBuffer(1, float32.length, 24000);
    buf.copyToChannel(float32, 0);

    const src = _playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(_playCtx.destination);

    const now = _playCtx.currentTime;
    const startAt = Math.max(now, _playQueueTime);
    src.start(startAt);
    _playQueueTime = startAt + buf.duration;
  } catch (e) { console.warn("[Flow Agent] audio playback error:", e.message); }
}

// ── Build the Settings message sent right after socket opens ──────────
async function _buildSettings() {
  const groqEndpoint = await _fetchGroqThinkConfig();
  return {
    type: "Settings",
    audio: {
      input:  { encoding: "linear16", sample_rate: 16000 },
      output: { encoding: "linear16", sample_rate: 24000, container: "none" },
    },
    agent: {
      language: "en",
      listen: {
        provider: { type: "deepgram", model: "nova-3" },
      },
      think: {
        // Switched from open_ai to groq — the original open_ai config required
        // a separate OpenAI API key configured inside Deepgram's OWN project
        // settings (not this app's env vars), which was never set up. That's
        // the actual root cause of every "Deepgram failed to connect" error:
        // the WebSocket handshake succeeds, but the Agent dies the moment it
        // tries to provision the think stage against a provider with no key
        // on file, and that failure surfaces to the client as a generic
        // connection error. Groq is a natively supported think provider
        // (Deepgram calls Groq directly), reuses infrastructure Joel already
        // has a free API key for, and needs zero new billing anywhere.
        //
        // ACTION NEEDED: add a Groq API key inside Deepgram's project
        // settings (console.deepgram.com → your project → Voice Agent LLM
        // providers, or wherever Deepgram's UI currently exposes this) —
        // this is separate from GROQ_API_KEY in Vercel, since Deepgram
        // calls Groq on its own servers, not through Flow's backend.
        provider: { type: "groq", model: "openai/gpt-oss-20b" },
        // REQUIRED for Groq specifically — it's a BYO provider, so Deepgram
        // needs the actual endpoint + auth header to call it. Omitting this
        // (as an earlier version of this file did) is exactly what caused
        // FAILED_TO_THINK / silent connection failures — the provider type
        // alone isn't enough for BYO providers, unlike managed ones
        // (open_ai, anthropic, google, nvidia) where Deepgram hosts the
        // model itself and only needs the type + model name.
        ...(groqEndpoint ? { endpoint: groqEndpoint } : {}),
        prompt: CONFIG.PERSONALITY + "\n\nYou are in a live VOICE conversation right now — keep replies short, spoken-style, no markdown, no lists.",
      },
      speak: {
        provider: { type: "deepgram", model: "aura-2-orion-en" }, // natural male voice
      },
      greeting: null, // Flow doesn't auto-greet on connect — Joel triggers with the wake word
    },
  };
}

// ── Core: connect to the Voice Agent socket ────────────────────────────
async function _connectAgent() {
  const token = await _getToken();
  if (!token) return false;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    _stream = stream;

    // Browsers can't set custom headers on WebSocket handshakes, so the
    // token rides the Sec-WebSocket-Protocol field instead — this is
    // Deepgram's documented client-side auth method, not a workaround.
    const socket = new WebSocket(AGENT_URL, ["token", token]);
    socket.binaryType = "arraybuffer";
    _socket = socket;

    socket.onopen = async () => {
      socket.send(JSON.stringify(await _buildSettings()));
    };

    socket.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        if (!_asleep) _playAgentAudio(evt.data);
        return;
      }
      let msg;
      try { msg = JSON.parse(evt.data); } catch (_) { return; }
      _handleAgentMessage(msg);
      // Resolve the connection promise the FIRST time we get concrete proof
      // one way or the other — SettingsApplied means it genuinely worked,
      // an Error frame means it genuinely didn't. Previously _connectAgent
      // resolved true right after opening the handlers, before either of
      // these had any chance to arrive, so the caller never actually knew
      // if the connection really succeeded.
      if (msg.type === "SettingsApplied" && _connectResolve) {
        _connectResolve(true);
        _connectResolve = null;
      } else if (msg.type === "Error" && _connectResolve) {
        _connectResolve(false);
        _connectResolve = null;
      }
    };

    socket.onerror = () => {
      console.warn("[Flow Agent] socket error — falling back to browser SR");
      if (!_lastTokenError) _lastTokenError = "WebSocket connection error (no further detail available from the browser)";
      _teardownAgent();
      if (_connectResolve) { _connectResolve(false); _connectResolve = null; }
    };

    socket.onclose = (evt) => {
      if (_connectResolve) {
        // Closed before we ever got SettingsApplied or an Error frame —
        // capture the close code, since that's the only signal left.
        if (!_lastTokenError) _lastTokenError = `Connection closed before agent was ready (code ${evt.code}${evt.reason ? ": " + evt.reason : ""})`;
        _connectResolve(false);
        _connectResolve = null;
        return; // don't auto-reconnect on the very first failed attempt — let the caller decide
      }
      if (_mode === "agent" && !_reconnecting) {
        _reconnecting = true;
        setTimeout(async () => {
          _reconnecting = false;
          if (_mode === "agent") {
            const ok = await _connectAgent();
            if (!ok) _startBrowserSR();
          }
        }, 800);
      }
    };

    _mode = "agent";
    // Wait for real proof of success/failure (max 6s) instead of returning
    // true immediately — this is what makes _lastTokenError actually
    // populated by the time startWakeListener's status check runs.
    const result = await new Promise((resolve) => {
      _connectResolve = resolve;
      setTimeout(() => {
        if (_connectResolve) {
          if (!_lastTokenError) _lastTokenError = "Timed out waiting for Deepgram to confirm the connection";
          _connectResolve(false);
          _connectResolve = null;
        }
      }, 6000);
    });
    return result;
  } catch (err) {
    console.warn("[Flow Agent] connect failed, falling back:", err.message);
    _lastTokenError = err.message;
    return false;
  }
}

// Start streaming mic audio once the socket + audio pipeline are ready
function _startMicStreaming() {
  _audioCtx  = new (window.AudioContext || window.webkitAudioContext)({ sample_rate: 16000 });
  const source = _audioCtx.createMediaStreamSource(_stream);
  _processor = _audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(_processor);
  _processor.connect(_audioCtx.destination);

  _processor.onaudioprocess = (e) => {
    if (_socket?.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    _socket.send(pcm16.buffer);
  };
}

// ── Handle control messages from the agent ─────────────────────────────
function _handleAgentMessage(msg) {
  switch (msg.type) {
    // BUG FIX: Deepgram sends a real JSON error frame — {type: "Error",
    // description: "...", code: "..."} — over the same text-message
    // channel right before closing the socket on failures like
    // FAILED_TO_THINK, invalid Settings, etc. This case never existed
    // before, so every real error Deepgram sent back was silently
    // dropped by the switch's lack of a matching case, which is why the
    // UI only ever showed "unknown reason" — there was no code path
    // capturing the description Deepgram was actually sending.
    case "Error":
    case "Warning": {
      const desc = msg.description || msg.message || JSON.stringify(msg);
      console.error(`[Flow Agent] Deepgram ${msg.type}:`, desc, msg.code ? `(code: ${msg.code})` : "");
      _lastTokenError = `${desc}${msg.code ? ` [${msg.code}]` : ""}`;
      break;
    }

    case "SettingsApplied":
      _startMicStreaming();
      console.log("[Flow Agent] ready — listening for wake word");
      break;

    case "ConversationText": {
      // This is a live transcript/reply turn. While asleep, we only use
      // Joel's own utterances (role: "user") to check for the wake word —
      // the agent's own replies never fire while asleep because output
      // audio is gated by _asleep in the onmessage handler above too.
      if (msg.role !== "user") break;
      const text = (msg.content || "").toLowerCase();

      if (_asleep) {
        if (CONFIG.WAKE_REGEX?.test(text)) {
          _wake();
          const stripped = text.replace(new RegExp(CONFIG.WAKE_REGEX.source, "gi"), "").replace(/[.,!?]/g, "").trim();
          // If Joel said a full command in the same breath as the wake
          // word ("hey flow what's the weather"), let the agent's own
          // reply handle it naturally rather than double-processing.
        }
      } else {
        // Awake and Joel said something — mirror it into Flow's own chat
        // log so voice and text conversations share the same history.
        const inp = document.getElementById("user-input");
        if (inp) inp.textContent = msg.content;
      }
      break;
    }

    case "AgentAudioDone":
      // Agent finished speaking its turn — nothing to do, playback already
      // streamed via binary frames as they arrived.
      break;

    case "UserStartedSpeaking":
      _orbFn?.("listening");
      break;

    case "Error":
      console.warn("[Flow Agent] server error:", msg.description);
      break;

    default:
      break;
  }
}

function _wake() {
  _asleep = false;
  _setWakeUI(true);
  _orbFn?.("listening");
  _beep();
  console.log("[Flow Agent] woke up");

  // Auto-sleep after a period of no interaction so the mic doesn't stay
  // "hot" in the UI forever — matches the old command-listen timeout feel.
  clearTimeout(_sleepTimer);
  _sleepTimer = setTimeout(_sleep, 25000);
}
let _sleepTimer = null;

function _sleep() {
  _asleep = true;
  _setWakeUI(false);
  _orbFn?.("idle");
}

function _teardownAgent() {
  try { _processor?.disconnect(); } catch (_) {}
  try { _audioCtx?.close(); } catch (_) {}
  try { _socket?.close(); } catch (_) {}
  try { _stream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  _processor = _audioCtx = _socket = _stream = null;
}

// ── BROWSER SpeechRecognition fallback (only if Agent totally fails) ───
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let wakeRec = null;
let cmdRec  = null;
const WAKE_STRIP_RX = new RegExp(CONFIG.WAKE_REGEX.source, "gi");

function _handleTranscriptFallback(alternatives, isFinal) {
  if (Speech.isSpeaking()) return;
  let matched = null;
  for (const alt of alternatives) {
    if (CONFIG.WAKE_REGEX?.test(alt.transcript.toLowerCase())) { matched = alt; break; }
  }
  if (!matched) return;

  _setWakeUI(true);
  _orbFn?.("listening");
  _beep();

  const inlineCmd = isFinal
    ? matched.transcript.toLowerCase().replace(WAKE_STRIP_RX, "").replace(/[.,!?]/g, "").trim()
    : "";

  if (inlineCmd.length > 3) {
    setTimeout(() => {
      _setWakeUI(false);
      _sendFn(inlineCmd);
      _orbFn?.("idle");
    }, 400);
  } else {
    startCommandListen();
  }
}

function _buildWakeRec() {
  if (!SR) return null;
  const r = new SR();
  r.continuous = true; r.interimResults = true; r.lang = "en-US"; r.maxAlternatives = 8;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alts = [];
      for (let a = 0; a < res.length; a++) alts.push({ transcript: res[a].transcript, confidence: res[a].confidence || 0 });
      _handleTranscriptFallback(alts, res.isFinal);
    }
  };
  r.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted") console.warn("[Flow] Wake SR error:", e.error);
    if (e.error === "not-allowed") _showMicDenied();
  };
  r.onend = () => { if (!cmdRec) setTimeout(() => { try { wakeRec?.start(); } catch (_) {} }, 120); };
  return r;
}

function _startBrowserSR() {
  _mode = "browser";
  if (!SR) {
    console.warn("[Flow] No speech recognition available at all");
    return;
  }
  // KNOWN, CONFIRMED ELECTRON LIMITATION (not a Flow bug): Electron's
  // bundled Chromium exposes webkitSpeechRecognition as an API — the
  // constructor exists, .start() doesn't throw — but Google's cloud
  // speech backend that actually powers it requires an API key that's
  // baked into official Chrome builds only. Electron doesn't have it, so
  // every real attempt fails asynchronously with a "network" error a few
  // hundred ms after starting. This is documented and unresolved in
  // Electron's own issue tracker, not something fixable from here.
  // Detecting it explicitly rather than assuming a clean .start() call
  // means it's actually working, since it silently isn't in Electron.
  if (IS_ELECTRON) {
    console.warn("[Flow] Browser SpeechRecognition is unreliable in Electron (Chromium's speech backend needs a Google API key that Electron doesn't bundle) — Deepgram is effectively required for voice in the desktop app.");
    _browserSRDeadInElectron = true;
  }
  navigator.mediaDevices?.getUserMedia({ audio: true })
    .then((stream) => {
      stream.getTracks().forEach((t) => t.stop());
      wakeRec = _buildWakeRec();
      try { wakeRec.start(); console.log("[Flow] Browser SR fallback started"); } catch (_) {}
    })
    .catch(() => {
      _showMicDenied();
      wakeRec = _buildWakeRec();
      try { wakeRec.start(); } catch (_) {}
    });
}

function _runBrowserCommand() {
  try { wakeRec?.stop(); } catch (_) {}
  if (cmdRec) { try { cmdRec.abort(); } catch (_) {} cmdRec = null; }

  const micBtn = document.getElementById("mic-btn");
  cmdRec = new SR();
  cmdRec.lang = "en-US"; cmdRec.continuous = true; cmdRec.interimResults = true; cmdRec.maxAlternatives = 5;
  _orbFn?.("listening");
  if (micBtn) micBtn.textContent = "⏹";

  let transcript = "";
  let silenceTimer = null;
  const resetSilence = () => { clearTimeout(silenceTimer); silenceTimer = setTimeout(finish, 4200); };
  const finish = () => {
    clearTimeout(silenceTimer);
    try { cmdRec?.abort(); } catch (_) {}
    cmdRec = null;
    window.__flowCmdActive = false;
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
    _setWakeUI(false);
    const trimmed = transcript.trim();
    if (trimmed.length > 1) {
      const inp = document.getElementById("user-input");
      if (inp) inp.textContent = trimmed;
      _sendFn(trimmed);
    }
    setTimeout(() => { try { wakeRec?.start(); } catch (_) {} }, 400);
  };

  cmdRec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      let best = r[0];
      for (let a = 1; a < r.length; a++) if ((r[a].confidence || 0) > (best.confidence || 0)) best = r[a];
      if (r.isFinal) transcript += " " + best.transcript;
      else interim = best.transcript;
    }
    if (interim || e.results[e.resultIndex]?.isFinal) resetSilence();
  };
  cmdRec.onerror = () => finish();
  cmdRec.onend = () => { if (silenceTimer) finish(); };

  resetSilence();
  try { cmdRec.start(); } catch (_) {
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
  }
}

// ── PUBLIC API — same names as v5, so app.js needs zero changes ────────

export async function startWakeListener() {
  if (_started) return;
  _started = true;

  const ok = await _connectAgent();
  if (!ok) _startBrowserSR();

  setTimeout(() => {
    if (_mode === "agent" && _socket?.readyState === WebSocket.OPEN) {
      _sysNotice("🎙️ Voice active — Deepgram Voice Agent (STT + LLM + TTS in one stream). Say \"Hey Flow\" to talk.");
    } else if (_browserSRDeadInElectron) {
      // Don't claim success here — browser SR genuinely doesn't work in
      // Electron (see the comment in _startBrowserSR), so telling Joel
      // "voice active" would be actively misleading when it's about to
      // fail with a silent network error the moment he tries it.
      _sysNotice(`⚠️ Voice can't work right now — Deepgram failed to connect (${_lastTokenError || "unknown reason"}), and the browser speech fallback doesn't work inside the Electron desktop app at all (a known Chromium/Electron limitation, not fixable from Flow's side). Fixing the Deepgram connection is the only real path to voice working here — check your Deepgram key has "Member" role or higher in your Deepgram account's team settings, not just read/write API scopes.`);
    } else if (_mode === "browser" && wakeRec) {
      _sysNotice(`🎙️ Voice active — using your browser's built-in speech recognition. Deepgram fallback reason: ${_lastTokenError || "not configured"}.`);
    } else {
      _sysNotice("⚠️ Voice listening did not start — no working speech engine was found.");
    }
  }, 2000);
}

export function startCommandListen() {
  // Manual mic-button press. If the Agent connection is live, just wake
  // it directly — it's already listening continuously, there's no
  // separate "command mode" to enter like the old transcription approach.
  window.__flowCmdActive = true;
  if (_mode === "agent" && _socket?.readyState === WebSocket.OPEN) {
    _wake();
    window.__flowCmdActive = false;
  } else if (SR) {
    _runBrowserCommand();
  } else {
    window.__flowCmdActive = false;
    _orbFn?.("idle");
    _sysNotice("⚠️ Voice input isn't available right now — no speech engine is reachable.");
  }
}
