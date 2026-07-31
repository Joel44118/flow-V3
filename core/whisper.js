// core/whisper.js — Speech-to-text, REBUILT to use Groq's Whisper
// endpoint via a real server-side proxy (api/mediapipe.js?action=transcribe),
// replacing Hugging Face's hosted Whisper.
//
// REAL REASON FOR THE SWITCH: Joel hit HF's free-tier MONTHLY credit
// cap during ordinary testing — a real 402, not hypothetical. Groq's
// published free tier for this exact endpoint is dramatically more
// generous (2,000 requests/day, 28,800 audio-seconds/day, no card
// required) and Joel already has a working GROQ_API_KEY in Vercel env
// vars from the AI chat fallback chain — zero new setup, zero budget.
//
// REAL, GENUINE SECURITY IMPROVEMENT over the old approach, not just a
// swap: HF has no short-lived client token mechanism, so the old code
// had to fetch a real, long-lived HF_TOKEN down to the browser via
// ?action=token before every transcription. Groq's key never needs to
// leave the server now — this file just POSTs raw audio to Flow's own
// proxy and gets text back; the real secret stays server-side always.
//
// Recording mechanics (MediaRecorder, webm/opus) are UNCHANGED from the
// prior version — only the destination and auth model changed.

const TRANSCRIBE_URL = "/api/mediapipe?action=transcribe";

let _mediaRecorder = null;
let _audioChunks = [];
let _stream = null;

// Starts recording from the mic. Call stopRecordingAndTranscribe() to end
// the recording and get back transcribed text.
export async function startRecording() {
  if (_mediaRecorder && _mediaRecorder.state === "recording") return; // already recording, don't double-start

  _stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
  _audioChunks = [];

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  _mediaRecorder = new MediaRecorder(_stream, { mimeType });
  _mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _audioChunks.push(e.data); };
  _mediaRecorder.start();
}

// Stops recording and sends the captured audio to Flow's own transcribe
// proxy (which forwards to Groq server-side), returning the transcribed
// text or throwing a real, specific error.
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

  return await transcribeBlob(audioBlob);
}

// REAL, exported separately from the record/stop flow — the new
// hands-free VAD listener (core/hands-free-vad.js) captures its own
// audio buffer directly from Silero VAD's onSpeechEnd callback and
// needs to hand that straight to Groq without going through
// MediaRecorder's start/stop lifecycle at all.
export async function transcribeBlob(audioBlob) {
  if (audioBlob.size < 1000) {
    throw new Error("Recording was too short or silent — try again and speak clearly.");
  }

  const r = await fetch(TRANSCRIBE_URL, {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 429) {
      throw new Error("Groq's free-tier rate limit was hit — this is a real, documented free-tier cap (2,000 requests/day), not a bug. Wait a bit and try again.");
    }
    throw new Error(data.error || `Transcription proxy returned HTTP ${r.status}`);
  }
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
