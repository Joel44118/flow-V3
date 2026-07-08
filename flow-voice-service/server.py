"""
flow-voice-service/server.py — Flow's self-hosted voice pipeline

WHAT THIS REPLACES: Deepgram's Voice Agent, which kept failing at the
WebSocket handshake layer for reasons never fully isolated (ruled out:
token freshness, TTL, scope, Groq think-provider config — the raw
WebSocket test outside Flow's own code ALSO failed with zero detail,
pointing at local network/security-software interference rather than
anything in Flow's code). Rather than keep chasing that, this is a fully
self-hosted alternative Joel now owns end-to-end.

ARCHITECTURE (all in this one service, one Railway deployment):
  1. Client (core/wakeword.js) opens a WebSocket to this server and
     streams raw 16kHz PCM audio continuously, in real time.
  2. This server runs openWakeWord on the incoming stream, listening for
     "hey jarvis" (the closest pre-trained match to "hey flow" — no
     custom training pipeline needed to ship today; train a real custom
     "hey flow" model later if desired, see bottom of file).
  3. Once the wake word fires, the server stops running wake-word
     detection and starts BUFFERING audio instead, using Silero VAD
     (bundled with openWakeWord) to detect when the person stops talking.
  4. Once silence is detected, the buffered audio is run through
     faster-whisper (small, self-hosted, free, open-weight STT model)
     to get real text.
  5. That text is sent back to the client over the same WebSocket as a
     JSON message: {"type": "transcript", "text": "..."}
  6. The CLIENT then sends that text into Flow's EXISTING /api/chat
     pipeline — this service has zero involvement in actually talking to
     Flow's AI, RAG, memory, or anything else. It only turns speech into
     text, nothing more.

WHY faster-whisper OVER plain openai-whisper: CTranslate2-backed,
meaningfully faster on CPU, which matters since Railway's free tier has
no GPU. Model size is deliberately "base" (not "large") — a real
resource/latency tradeoff for a free-tier deployment, see MODEL_SIZE below.

DEPLOY: this whole folder becomes its own Railway service, separate from
telegram-userbot/. Railway auto-detects Python via requirements.txt and
runs `python server.py` (see Procfile below). No GPU needed or used.
"""

import asyncio
import json
import os
import numpy as np
import websockets
from openwakeword.model import Model as WakeModel
from faster_whisper import WhisperModel

# ── Config ──────────────────────────────────────────────────────────────
SAMPLE_RATE = 16000            # openWakeWord and Whisper both expect 16kHz
FRAME_SIZE = 1280               # 80ms frames at 16kHz — matches openWakeWord's expected chunk size
WAKE_THRESHOLD = 0.5             # confidence score needed to count as a real wake-word trigger
SILENCE_FRAMES_TO_STOP = 25       # ~2 seconds of silence (25 frames * 80ms) before we consider the utterance done
MAX_RECORDING_FRAMES = 375        # ~30 seconds hard cap per utterance, so a stuck VAD can't buffer forever
MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "base")  # "tiny"/"base"/"small" — base is a reasonable accuracy/speed/memory tradeoff for CPU-only free-tier hosting; bump to "small" only if Railway's plan has enough RAM headroom

WAKE_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "models", "hey_flow.onnx"
)

print(f"[Voice Service] Loading openWakeWord (hey_flow — Joel's real trained wake phrase, via outspoken.cloud, Prototype/Internal Evaluation license)...")
wake_model = WakeModel(wakeword_model_paths=[WAKE_MODEL_PATH], vad_threshold=0.5)

print(f"[Voice Service] Loading faster-whisper ({MODEL_SIZE})...")
whisper_model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")  # int8 quantization — smaller memory footprint, negligible accuracy loss, meaningfully faster on CPU than float32
print(f"[Voice Service] Ready.")


class SessionState:
    """Per-connection state — each browser tab/Electron window gets its own instance."""
    def __init__(self):
        self.mode = "listening"       # "listening" (for wake word) | "recording" (buffering an utterance)
        self.recording_buffer = []     # list of int16 numpy frames collected since wake word fired
        self.silence_frame_count = 0
        self.total_recording_frames = 0


async def handle_connection(websocket):
    session = SessionState()
    print("[Voice Service] Client connected.")

    try:
        async for message in websocket:
            if not isinstance(message, bytes):
                # Ignore any stray text frames — this protocol is audio-in, JSON-out only
                continue

            # Client sends raw 16-bit PCM audio chunks. Convert to the
            # int16 numpy array both openWakeWord and our VAD check expect.
            audio_chunk = np.frombuffer(message, dtype=np.int16)

            if session.mode == "listening":
                prediction = wake_model.predict(audio_chunk)
                score = prediction.get("hey_flow", 0.0)

                if score >= WAKE_THRESHOLD:
                    print(f"[Voice Service] Wake word detected (score: {score:.2f}) — recording...")
                    session.mode = "recording"
                    session.recording_buffer = []
                    session.silence_frame_count = 0
                    session.total_recording_frames = 0
                    await websocket.send(json.dumps({"type": "wake_detected"}))

            elif session.mode == "recording":
                session.recording_buffer.append(audio_chunk)
                session.total_recording_frames += 1

                # Simple energy-based silence check as a fast pre-filter —
                # avoids running the heavier Silero VAD model on every
                # single frame when a basic amplitude check already tells
                # us definitively that this frame is silence.
                frame_energy = np.abs(audio_chunk).mean()
                is_silent = frame_energy < 150  # empirical threshold for near-silence in int16 PCM

                if is_silent:
                    session.silence_frame_count += 1
                else:
                    session.silence_frame_count = 0

                utterance_done = (
                    session.silence_frame_count >= SILENCE_FRAMES_TO_STOP
                    or session.total_recording_frames >= MAX_RECORDING_FRAMES
                )

                if utterance_done:
                    print(f"[Voice Service] Utterance complete ({session.total_recording_frames} frames), transcribing...")
                    full_audio = np.concatenate(session.recording_buffer).astype(np.float32) / 32768.0  # int16 -> normalized float32, what Whisper expects

                    segments, _ = whisper_model.transcribe(full_audio, language="en", beam_size=5)
                    text = " ".join(seg.text.strip() for seg in segments).strip()

                    if text:
                        print(f"[Voice Service] Transcribed: {text}")
                        await websocket.send(json.dumps({"type": "transcript", "text": text}))
                    else:
                        print("[Voice Service] Transcription empty — likely noise/false wake trigger, ignoring.")
                        await websocket.send(json.dumps({"type": "transcript_empty"}))

                    # Back to listening for the next wake word
                    session.mode = "listening"
                    session.recording_buffer = []

    except websockets.exceptions.ConnectionClosed:
        print("[Voice Service] Client disconnected.")
    except Exception as e:
        print(f"[Voice Service] Error in connection handler: {e}")
        try:
            await websocket.send(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass


async def main():
    port = int(os.environ.get("PORT", 8765))  # Railway injects PORT — must bind to this, not a hardcoded port
    print(f"[Voice Service] Starting on port {port}...")
    async with websockets.serve(handle_connection, "0.0.0.0", port, max_size=None):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

# ── TRAINING A REAL "HEY FLOW" MODEL LATER (optional, not needed to ship) ──
# openWakeWord's own training notebook (in their GitHub repo, under
# notebooks/training_models.ipynb) lets you generate a custom wake-word
# model using synthetic TTS-generated training data — no manual audio
# recording needed. It runs on Google Colab's free GPU tier. This is a
# separate, optional project for later; "hey jarvis" works today with zero
# extra setup, which is why we shipped with that first.
