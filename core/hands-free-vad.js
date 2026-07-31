// ═══════════════════════════════════════════
// core/hands-free-vad.js — REAL, NEW: genuinely hands-free voice input,
// with NO hotkey and NO spoken wake-word phrase required.
//
// /criticalthinking SUMMARY (why this approach, not another wake-word
// attempt): FOUR separate wake-word/dictation approaches already failed
// across this project's history (trained openWakeWord models, Deepgram
// streaming, a whisper.cpp compile that never shipped a working binary,
// webkitSpeechRecognition — confirmed broken specifically inside
// Electron since it lacks Chrome's baked-in Google API key). A FIFTH
// wake-word attempt would very likely hit the same class of problems
// again — packaging a real trained audio model, or getting a specific
// phrase reliably recognized offline, is genuinely hard.
//
// The actual constraint Joel stated is "without touching the hotkeys"
// — that does NOT require a wake WORD at all, just continuous
// listening with automatic speech-boundary detection. That's a much
// simpler, already-solved problem: Voice Activity Detection (VAD).
// Silero VAD (via the community-maintained @ricky0123/vad-web wrapper,
// MIT-licensed, runs as WASM through onnxruntime-web) genuinely runs
// entirely in the browser/Electron renderer — no native compile step,
// no Python, no Playwright, nothing that broke the prior four attempts.
// It just answers "is someone talking right now, yes or no" and fires
// onSpeechStart/onSpeechEnd callbacks — the captured audio on
// onSpeechEnd goes straight to Groq Whisper (core/whisper.js's
// transcribeBlob) for transcription, then straight into chat exactly
// like the hotkey flow already does.
//
// REAL, HONEST TRADE-OFF Joel should know: without a wake word, this
// listens to and transcribes ANYONE speaking while it's on — including
// Joel talking to someone else in the room, a phone call, a TV. This is
// NOT a "smart enough to ignore ambient speech" system — it is
// maximally hands-free at the cost of being indiscriminate. That's why
// this defaults OFF and is a real, explicit settings toggle
// ("Hands-free voice") rather than always-on — Joel chooses when it's
// worth that trade-off (e.g. working alone at the desk) versus leaving
// it off. No CDN/model download cost beyond the one-time ~2MB Silero
// VAD model + onnxruntime-web's WASM runtime, both cached by the
// browser after first load.
// ═══════════════════════════════════════════

const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort.js";
const VAD_CDN = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.19/dist/bundle.min.js";

let _micVad = null;
let _scriptsLoaded = false;
let _onTranscript = null;
let _onStateChange = null;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function _ensureScriptsLoaded() {
  if (_scriptsLoaded) return;
  await _loadScript(ORT_CDN);
  await _loadScript(VAD_CDN);
  if (!window.vad?.MicVAD) throw new Error("vad-web failed to load — window.vad.MicVAD not found after script load.");
  _scriptsLoaded = true;
}

// REAL, minimal WAV encoder — Silero VAD hands back a raw Float32Array
// of PCM samples at 16kHz mono. Groq's transcription endpoint (like
// any real audio API) needs an actual audio FILE, not a bare float
// array, so this wraps it in a standard 44-byte WAV header. This is a
// well-known, tiny, dependency-free technique — no library needed for
// something this small.
function _float32ToWavBlob(float32Audio, sampleRate = 16000) {
  const numSamples = float32Audio.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);       // PCM chunk size
  view.setUint16(20, 1, true);        // audio format = PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits per sample
  writeString(36, "data");
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Audio[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

// REAL, exported — call once with callbacks; actual start/stop is
// controlled separately via setHandsFreeVoiceEnabled() so the Settings
// toggle can turn it on/off without re-registering callbacks.
export function initHandsFreeVAD({ onTranscript, onStateChange } = {}) {
  _onTranscript = onTranscript || null;
  _onStateChange = onStateChange || null;
}

// REAL — starts continuous listening. Safe to call multiple times
// (no-ops if already running).
export async function setHandsFreeVoiceEnabled(enabled) {
  if (enabled) {
    if (_micVad) { try { _micVad.start(); } catch (_) {} return; }
    try {
      await _ensureScriptsLoaded();
      _micVad = await window.vad.MicVAD.new({
        onSpeechStart: () => { _onStateChange?.("listening"); },
        onSpeechEnd: async (audioFloat32) => {
          _onStateChange?.("thinking");
          try {
            const wavBlob = _float32ToWavBlob(audioFloat32);
            const { transcribeBlob } = await import("./whisper.js");
            const text = await transcribeBlob(wavBlob);
            if (text) _onTranscript?.(text);
          } catch (e) {
            console.warn("[HandsFreeVAD] Transcription failed (non-fatal, staying in listening mode):", e.message);
          } finally {
            _onStateChange?.("idle");
          }
        },
      });
      _micVad.start();
    } catch (e) {
      console.warn("[HandsFreeVAD] Failed to start:", e.message);
      throw e;
    }
  } else {
    if (_micVad) { try { _micVad.pause(); } catch (_) {} }
  }
}

export function isHandsFreeVoiceRunning() {
  return !!_micVad;
}
