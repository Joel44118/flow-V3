// core/whisper.js — Speech-to-text via Hugging Face's hosted Whisper model
//
// REPLACES Deepgram as Flow's STT engine. Real reasons for this switch,
// stated plainly: Deepgram's Voice Agent WebSocket connection failed
// repeatedly across many debugging rounds — token freshness, TTL, scope,
// and the Groq think-provider config were all checked and fixed, but a
// completely RAW WebSocket test outside Flow's own code, using Joel's
// real key directly, ALSO failed with zero diagnostic detail. That
// pointed at something in Joel's local network/security-software
// environment blocking or resetting outbound WebSocket connections
// specifically — not a code bug Flow's side could keep chasing.
//
// This uses the SAME token-serving pattern already proven working for
// ui/imagine.js and ui/videogen.js (api/mediapipe.js?action=token hands
// back HF_TOKEN, since Hugging Face has no short-lived client-token
// mechanism the way Deepgram does) — reusing infrastructure that's
// already confirmed functional, rather than adding another new moving part.
//
// HOW IT WORKS: records the mic via the browser's own MediaRecorder API
// (no MediaPipe/WASM/WebSocket streaming needed) until the user stops
// (via a button or the wake-word phrase, whichever mode is active), then
// POSTs the recorded audio blob directly to Hugging Face's Whisper
// endpoint and gets text back. Simpler and more failure-resistant than a
// continuous streaming approach, at the cost of not being live word-by-
// word — acceptable, since Flow's chat interface already works turn-by-
// turn, not as a live caption feed.
//
// REAL LIMITS TO KNOW (from Hugging Face's own documented free tier):
// rate-limited (not a fixed published number — described as "a few
// hundred requests per hour"), and there IS a monthly credit cap on the
// free tier that a real user has hit in practice, after which further
// calls return a 402 asking for a PRO upgrade. This is NOT unlimited —
// if voice starts failing with a 402, that's the free-tier cap, not a bug.

const WHISPER_MODEL = "openai/whisper-large-v3";
const WHISPER_URL = `https://router.huggingface.co/hf-inference/models/${WHISPER_MODEL}`;

let _hfToken = null;
async function _getToken() {
  if (_hfToken) return _hfToken;
  const r = await fetch("/api/mediapipe?action=token");
  const data = await r.json();
  if (!data.token) throw new Error(data.error || "HF_TOKEN not set in Vercel environment variables.");
  _hfToken = data.token;
  return _hfToken;
}

let _mediaRecorder = null;
let _audioChunks = [];
let _stream = null;

// Starts recording from the mic. Call stopRecordingAndTranscribe() to end
// the recording and get back transcribed text.
export async function startRecording() {
  if (_mediaRecorder && _mediaRecorder.state === "recording") return; // already recording, don't double-start

  _stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
  _audioChunks = [];

  // webm/opus is well-supported across Chrome/Electron and keeps file
  // size reasonable — explicitly setting mimeType rather than leaving it
  // to the browser's default, since a real forum-reported bug showed HF's
  // endpoint failing when content-type wasn't explicitly stated (auto-
  // detection isn't reliable on their side anymore).
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  _mediaRecorder = new MediaRecorder(_stream, { mimeType });
  _mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _audioChunks.push(e.data); };
  _mediaRecorder.start();
}

// Stops recording and sends the captured audio to Whisper, returning the
// transcribed text (or throwing a real, specific error rather than
// failing silently — given Joel's track record with HF issues, every
// failure here should say exactly what went wrong).
export async function stopRecordingAndTranscribe() {
  if (!_mediaRecorder || _mediaRecorder.state !== "recording") {
    throw new Error("Not currently recording — call startRecording() first.");
  }

  const audioBlob = await new Promise((resolve) => {
    _mediaRecorder.onstop = () => {
      resolve(new Blob(_audioChunks, { type: _mediaRecorder.mimeType }));
    };
    _mediaRecorder.stop();
  });

  _stream?.getTracks().forEach((t) => t.stop());
  _stream = null;

  if (audioBlob.size < 1000) {
    throw new Error("Recording was too short or silent — try again and speak clearly.");
  }

  const token = await _getToken();

  const r = await fetch(WHISPER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": audioBlob.type || "audio/webm", // explicit content-type — HF's endpoint does NOT reliably auto-detect this
    },
    body: audioBlob,
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    if (r.status === 402) {
      throw new Error("Hugging Face free-tier inference credits are used up for this month — this is a real free-tier limit, not a bug. Wait for next month's reset, or upgrade to HF PRO ($9/mo) for 20x the allowance.");
    }
    if (r.status === 503 && err.estimated_time) {
      throw new Error(`Whisper is warming up (cold start) — try again in about ${Math.ceil(err.estimated_time)}s.`);
    }
    throw new Error(err.error || `Hugging Face returned HTTP ${r.status}`);
  }

  const data = await r.json();
  if (!data.text) throw new Error("Whisper returned no text — the recording may have been unclear.");
  return data.text.trim();
}

// Cancels an in-progress recording without transcribing (e.g. user hit
// escape or changed their mind) — cleans up the stream properly so the
// mic indicator light actually turns off.
export function cancelRecording() {
  if (_mediaRecorder && _mediaRecorder.state === "recording") {
    _mediaRecorder.onstop = null; // don't trigger the transcribe flow
    _mediaRecorder.stop();
  }
  _stream?.getTracks().forEach((t) => t.stop());
  _stream = null;
  _audioChunks = [];
}
