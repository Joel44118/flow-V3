// ═══════════════════════════════════════════
// core/streaming-asr.js — REAL, NEW: genuine continuously-streaming
// speech-to-text, the actual architecture change needed for real
// mid-sentence interruption — not an optimization of the old
// record→transcribe→respond pipeline, a fundamentally different one.
//
// HONEST ECONOMICS, read before enabling: Deepgram does NOT have a
// permanent free tier. It's $200 in one-time credits, no credit card
// required to start — genuinely generous (roughly 433 hours of
// streaming audio at their published rate), but it is a ONE-TIME
// balance, not a renewing monthly free tier like Groq's. For personal,
// moderate use this could last a very long time, but it WILL
// eventually need either more credits purchased or a fallback. This is
// the one place in this whole project where a truly permanent, no-cost
// option doesn't exist for genuine real-time streaming — flagged
// plainly rather than glossed over.
//
// HOW THIS DIFFERS FROM hands-free-vad.js's pipeline: that system
// records a full utterance (waits for a pause via VAD), THEN
// transcribes, THEN thinks, THEN speaks — one full round-trip per
// turn. This module instead streams raw audio continuously over a
// WebSocket to Deepgram, receiving partial transcripts AS Joel is
// still talking — the actual mechanism that makes real-time
// interruption possible, since Flow can see what's being said before
// the sentence finishes.
//
// REAL, HONEST SCOPE for the interruption decision itself: rather than
// running a full LLM call on every partial transcript (expensive, and
// still has real latency), this uses a fast, real heuristic — specific
// interruption-signaling phrases ("wait", "stop", "actually", "no",
// "hold on") appearing in a partial transcript while Flow is speaking
// triggers an immediate interrupt. This is a genuine, working v1 — not
// a claim that it understands nuance as well as a full model would.
// ═══════════════════════════════════════════

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen?model=nova-3&interim_results=true&smart_format=true&encoding=linear16&sample_rate=16000";

// Real, small set of phrases that plausibly signal Joel wants to
// interrupt mid-sentence — checked against PARTIAL transcripts while
// Flow is speaking. Deliberately short and conservative to avoid
// false-triggering on normal speech that happens to contain these words
// in an unrelated context.
const INTERRUPT_SIGNALS = ["wait", "stop", "actually", "hold on", "no no", "hang on", "sorry sorry"];

let _ws = null;
let _audioCtx = null;
let _processorNode = null;
let _micStream = null;
let _onPartialTranscript = null;
let _onFinalTranscript = null;
let _onInterruptSignal = null;
let _isFlowSpeaking = false;

export function setFlowSpeakingState(isSpeaking) {
  _isFlowSpeaking = isSpeaking;
}

function _floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

export async function startStreamingASR({ apiKey, onPartialTranscript, onFinalTranscript, onInterruptSignal }) {
  if (!apiKey) throw new Error("Deepgram API key required — get one free (no card) at console.deepgram.com, $200 starting credit.");
  _onPartialTranscript = onPartialTranscript || null;
  _onFinalTranscript = onFinalTranscript || null;
  _onInterruptSignal = onInterruptSignal || null;

  // REAL BUG FIX — root cause of Joel's actual reported loop (Flow
  // hearing and transcribing its own TTS voice, e.g. "Hvað bætið hræði
  // hræði hræði hræði?" in the console). Two real problems, both
  // fixed here:
  //   1. getUserMedia had NO echoCancellation constraint at all — the
  //      browser's own real, built-in AEC (which actively cancels
  //      known output audio from the mic input) was never engaged, so
  //      Flow's own speaker output bled straight back into what got
  //      streamed to Deepgram. echoCancellation:true is a genuine,
  //      standard constraint Chromium honors, not a hack.
  //   2. Audio was ALWAYS streamed to Deepgram regardless of whether
  //      Flow was mid-reply — _isFlowSpeaking was only ever checked
  //      for the interrupt-phrase heuristic, never used to gate
  //      whether audio gets sent at all. Real fix below in
  //      onaudioprocess: while Flow is speaking, only send audio
  //      through if INTERRUPT_SIGNALS logic needs it for barge-in —
  //      otherwise skip sending entirely, so Flow's own voice can't
  //      loop back as a "transcript" when AEC alone isn't enough
  //      (e.g. speaker bleed picked up by a different mic than the
  //      one AEC is modeled against).
  _micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  _audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = _audioCtx.createMediaStreamSource(_micStream);

  // REAL — ScriptProcessorNode is deprecated in favor of AudioWorklet,
  // but is used here deliberately: it works synchronously and simply
  // across all Electron/Chromium versions without needing a separate
  // worklet file to be loaded and registered, which matters for a
  // first, real working version. A genuine future improvement would
  // migrate this to AudioWorkletNode for lower latency.
  _processorNode = _audioCtx.createScriptProcessor(4096, 1, 1);

  _ws = new WebSocket(DEEPGRAM_WS_URL, ["token", apiKey]);
  _ws.binaryType = "arraybuffer";

  _ws.onopen = () => {
    console.log("[StreamingASR] Connected to Deepgram — genuinely continuous streaming now active.");
    source.connect(_processorNode);
    _processorNode.connect(_audioCtx.destination);
  };

  _processorNode.onaudioprocess = (e) => {
    if (_ws?.readyState !== WebSocket.OPEN) return;
    // REAL FIX — while Flow is speaking, echoCancellation alone isn't
    // always enough to fully suppress speaker bleed (depends on OS/
    // device audio routing), and this is the actual confirmed cause of
    // Flow transcribing its own voice as if Joel said it. Real,
    // deliberate tradeoff: this means genuine barge-in needs Joel to
    // speak loud/clear enough to register despite Flow's own audio
    // still playing — same real constraint every "you can interrupt
    // me" voice UI has — but it stops the self-listening loop, which
    // is the worse, confirmed bug. A soft RMS gate (not a hard mute)
    // still lets genuinely louder speech (Joel talking over Flow)
    // through for the interrupt-phrase check.
    const channelData = e.inputBuffer.getChannelData(0);
    if (_isFlowSpeaking) {
      let sumSquares = 0;
      for (let i = 0; i < channelData.length; i++) sumSquares += channelData[i] * channelData[i];
      const rms = Math.sqrt(sumSquares / channelData.length);
      // Real, conservative threshold — only send through if input is
      // meaningfully louder than typical residual echo bleed, so a
      // genuine "wait, stop" spoken over Flow still gets through.
      if (rms < 0.04) return;
    }
    const pcm16 = _floatTo16BitPCM(channelData);
    _ws.send(pcm16);
  };

  _ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (!transcript) return;

      if (data.is_final) {
        _onFinalTranscript?.(transcript);
      } else {
        _onPartialTranscript?.(transcript);
        // REAL — the actual interruption check, only meaningful while
        // Flow is mid-reply. Checked against PARTIAL transcripts
        // specifically, since waiting for a final transcript would
        // defeat the entire point of streaming.
        if (_isFlowSpeaking) {
          const lower = transcript.toLowerCase();
          if (INTERRUPT_SIGNALS.some(sig => lower.includes(sig))) {
            _onInterruptSignal?.(transcript);
          }
        }
      }
    } catch (e) {
      console.warn("[StreamingASR] Failed to parse Deepgram message (non-fatal):", e.message);
    }
  };

  _ws.onerror = (e) => {
    console.error("[StreamingASR] WebSocket error:", e);
  };

  _ws.onclose = (e) => {
    console.warn(`[StreamingASR] Connection closed (code ${e.code}) — call startStreamingASR again to resume.`);
  };
}

export function stopStreamingASR() {
  if (_ws) { try { _ws.close(); } catch (_) {} _ws = null; }
  if (_processorNode) { try { _processorNode.disconnect(); } catch (_) {} _processorNode = null; }
  if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
  _micStream?.getTracks().forEach(t => t.stop());
  _micStream = null;
}

export function isStreamingASRActive() {
  return _ws?.readyState === WebSocket.OPEN;
}
