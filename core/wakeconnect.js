// core/wakeconnect.js — connects to Joel's self-hosted wake-word service
// (flow-voice-service on Railway, running openWakeWord with the real
// trained "Wake_up_Flow.onnx" model) and auto-triggers the EXISTING
// Whisper recording flow (core/whisper.js) the moment the wake word
// fires — no separate transcription logic duplicated here, this file
// only handles wake-word detection and streaming mic audio to the
// Railway service for THAT purpose.
//
// SETUP NEEDED: set CONFIG.VOICE_SERVICE_URL in core/config.js to the
// real Railway wss:// URL once flow-voice-service is deployed. Until
// then, this silently does nothing (logs a warning once) rather than
// spamming errors — wake-word listening is an enhancement on top of the
// already-working click-to-record mic button, not a replacement for it.

import { CONFIG } from "./config.js";

let _socket = null;
let _audioCtx = null;
let _processorNode = null;
let _stream = null;
let _onWakeCallback = null;
let _warnedOnce = false;

export function initWakeConnect(onWakeDetected) {
  _onWakeCallback = onWakeDetected;
}

export async function startWakeListening() {
  const url = CONFIG.VOICE_SERVICE_URL;
  if (!url || url.includes("CONFIGURE-ME")) {
    if (!_warnedOnce) {
      console.warn("[WakeConnect] CONFIG.VOICE_SERVICE_URL isn't set to a real Railway URL yet — wake-word listening is off. Click-to-record mic button still works normally.");
      _warnedOnce = true;
    }
    return false;
  }

  try {
    _stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, channelCount: 1 } });
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    _socket = socket;

    socket.onopen = () => {
      console.log("[WakeConnect] Connected — listening for 'Wake up Flow'.");
      _startStreaming(_stream);
    };

    socket.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (_) { return; }
      if (msg.type === "wake_detected") {
        console.log("[WakeConnect] Wake word detected!");
        _onWakeCallback?.();
      }
      // transcript/transcript_empty messages are ignored here on purpose —
      // this service's own Whisper step (in server.py) is a fallback path
      // for a fully self-hosted setup; Joel's actual transcription today
      // goes through core/whisper.js (Hugging Face), triggered by
      // _onWakeCallback above instead.
    };

    socket.onerror = () => console.warn("[WakeConnect] Connection error — will retry.");
    socket.onclose = () => {
      _teardown();
      setTimeout(() => startWakeListening(), 5000); // simple retry, no exponential backoff needed for a personal single-user service
    };

    return true;
  } catch (e) {
    console.warn("[WakeConnect] Failed to start:", e.message);
    return false;
  }
}

function _startStreaming(stream) {
  _audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = _audioCtx.createMediaStreamSource(stream);
  _processorNode = _audioCtx.createScriptProcessor(1280, 1, 1);

  _processorNode.onaudioprocess = (e) => {
    if (!_socket || _socket.readyState !== WebSocket.OPEN) return;
    const floatData = e.inputBuffer.getChannelData(0);
    const int16Data = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]));
      int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    _socket.send(int16Data.buffer);
  };

  source.connect(_processorNode);
  _processorNode.connect(_audioCtx.destination);
}

function _teardown() {
  try { _processorNode?.disconnect(); } catch (_) {}
  try { _audioCtx?.close(); } catch (_) {}
  _audioCtx = null;
  _processorNode = null;
  // NOTE: deliberately NOT stopping _stream tracks here — same mic
  // stream needs to stay alive for wake-word listening to resume after
  // reconnect, unlike whisper.js's short-lived recording sessions.
}

export function stopWakeListening() {
  try { _socket?.close(); } catch (_) {}
  _socket = null;
  _teardown();
  _stream?.getTracks().forEach(t => t.stop());
  _stream = null;
}
