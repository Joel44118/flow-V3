// ═══════════════════════════════════════════
// ui/facerecog.js — Facial recognition
//
// Uses face-api.js (free, runs in browser)
// to detect and recognise Joel's face.
//
// Flow:
//  1. "Learn my face" → captures 5 frames,
//     builds a face descriptor, saves to storage
//  2. On camera open → continuously checks
//     if the person is Joel
//  3. If Joel recognised → greets personally
//  4. If unknown → notes it
//
// No server needed — all runs locally via WASM
// ═══════════════════════════════════════════
import { Storage } from "../core/storage.js";
import { Speech }  from "../core/speech.js";

const FACE_API_CDN = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js";
const MODELS_URL   = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";

let _loaded      = false;
let _joelDesc    = null;  // saved face descriptor for Joel
let _chat        = null;
let _recognising = false;
let _recogInterval = null;

export function initFaceRecog(chat) {
  _chat = chat;
  // Load Joel's saved descriptor if it exists
  const saved = Storage.get("joel_face", null);
  if (saved) _joelDesc = new Float32Array(saved);
}

// ── Load face-api models ──────────────────
async function loadModels() {
  if (_loaded) return true;
  try {
    if (!window.faceapi) {
      await _loadScript(FACE_API_CDN);
    }
    // Load required models from CDN
    await Promise.all([
      window.faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS_URL),
      window.faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
      window.faceapi.nets.faceLandmark68Net.loadFromUri(MODELS_URL),
    ]);
    _loaded = true;
    return true;
  } catch(e) {
    console.error("[FaceRecog] Model load failed:", e.message);
    return false;
  }
}

// ── Learn Joel's face ─────────────────────
// Call this when Joel says "learn my face"
export async function learnFace(videoEl) {
  _chat?.add("Learning your face... hold still for a moment.", "bot");
  Speech.speak("Hold still while I learn your face.");

  const ok = await loadModels();
  if (!ok) { _chat?.addError("Face models failed to load."); return; }

  const descriptors = [];

  // Capture 5 frames over 2.5 seconds
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const detection = await window.faceapi
        .detectSingleFace(videoEl)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection) {
        descriptors.push(detection.descriptor);
      }
    } catch(_) {}
  }

  if (descriptors.length < 2) {
    _chat?.addError("Couldn't get a clear view of your face. Make sure you're well-lit and facing the camera.");
    Speech.speak("I couldn't see your face clearly. Try better lighting.");
    return;
  }

  // Average the descriptors for robustness
  const avg = _averageDescriptors(descriptors);
  _joelDesc = avg;

  // Save to storage as plain array
  Storage.set("joel_face", Array.from(avg));

  const msg = "Got it. I know your face now, Boss. I'll recognise you every time.";
  _chat?.add(msg, "bot");
  Speech.speak(msg);
}

// ── Start continuous recognition on a video ──
export function startRecognition(videoEl) {
  if (_recogInterval) clearInterval(_recogInterval);
  if (!_joelDesc) return; // no face saved yet
  _recognising = true;

  let greeted = false;

  _recogInterval = setInterval(async () => {
    if (!_recognising || !videoEl || videoEl.readyState < 2) return;
    if (!_loaded) { await loadModels(); return; }

    try {
      const detection = await window.faceapi
        .detectSingleFace(videoEl)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) return;

      const dist = window.faceapi.euclideanDistance(detection.descriptor, _joelDesc);
      // dist < 0.5 = same person (Joel), > 0.6 = different person
      if (dist < 0.5 && !greeted) {
        greeted = true;
        const msg = "Hey Boss, I see you.";
        _chat?.add(msg, "bot");
        Speech.speak(msg);
      } else if (dist >= 0.6 && greeted) {
        greeted = false; // reset so it greets again if Joel comes back
      }
    } catch(_) {}

  }, 3000); // check every 3 seconds
}

export function stopRecognition() {
  _recognising = false;
  clearInterval(_recogInterval);
  _recogInterval = null;
}

export function hasLearnedFace() {
  return _joelDesc !== null || Storage.get("joel_face", null) !== null;
}

// ── Helpers ───────────────────────────────
function _averageDescriptors(descriptors) {
  const len = descriptors[0].length;
  const avg = new Float32Array(len);
  descriptors.forEach(d => { for (let i=0;i<len;i++) avg[i] += d[i]; });
  for (let i=0;i<len;i++) avg[i] /= descriptors.length;
  return avg;
}

function _loadScript(src) {
  return new Promise((res,rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
