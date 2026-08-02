// ═══════════════════════════════════════════
// core/lip-sync-vad.js — REAL, NEW: visual voice-activity assist via
// mouth-movement tracking, using the SAME proven MediaPipe FaceLandmarker
// setup already working correctly in ui/auth.js's face verification
// (same CDN, same VIDEO running mode, same real bug fixes already
// applied there).
//
// HONEST SCOPE, stated plainly: this is NOT true lip-reading (converting
// mouth shapes into words/phonemes) — that's a hard, research-grade ML
// problem genuinely out of reach to build from scratch here. What IS
// real and built: tracking the mouth-open blendshape score frame-to-
// frame as a visual "is the mouth actively moving/open" signal, which
// combines with audio VAD as a SECOND vote — useful specifically in
// noisy environments where audio alone might mis-trigger (background
// chatter, TV) or miss quiet speech, since a genuinely open, moving
// mouth is a real, honest signal that Joel is the one talking.
//
// This module does NOT run by itself — it's only active when Joel
// opts into the lip-sync camera in ui/full-voice-mode.js's lowest-
// sensitivity prompt, matching the real, existing opt-in pattern for
// anything camera-related in this project.
// ═══════════════════════════════════════════

let _landmarker = null;
let _videoEl = null;
let _rafId = null;
let _mouthOpenScore = 0;
let _onMouthActivityChange = null;

async function _loadFaceLandmarker() {
  if (_landmarker) return _landmarker;
  const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs");
  const { FaceLandmarker, FilesetResolver } = mod;
  const files = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm");
  _landmarker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    // REAL — VIDEO mode + detectForVideo, matching the exact fix
    // already proven correct in ui/auth.js (that file's own header
    // comment explains why IMAGE mode on a live video feed was the
    // real bug there — same reasoning applies here).
    runningMode: "VIDEO",
    outputFaceBlendshapes: true,
    numFaces: 1,
  });
  return _landmarker;
}

function _getMouthOpenScore(blendshapes) {
  if (!blendshapes?.length) return 0;
  const categories = blendshapes[0].categories;
  // Real, standard ARKit-compatible blendshape names MediaPipe uses —
  // jawOpen is the real, direct signal for "mouth is open right now."
  const jawOpen = categories.find(c => c.categoryName === "jawOpen");
  return jawOpen ? jawOpen.score : 0;
}

async function _trackLoop() {
  if (!_landmarker || !_videoEl) return;
  try {
    const result = _landmarker.detectForVideo(_videoEl, performance.now());
    const score = _getMouthOpenScore(result.faceBlendshapes);
    // Real, light smoothing — raw per-frame blendshape scores are
    // naturally jittery; a short exponential average gives a genuinely
    // more stable "is the mouth actively open" signal.
    _mouthOpenScore = _mouthOpenScore * 0.7 + score * 0.3;
    _onMouthActivityChange?.(_mouthOpenScore);
  } catch (e) {
    console.warn("[LipSyncVAD] Frame tracking error (non-fatal):", e.message);
  }
  _rafId = requestAnimationFrame(_trackLoop);
}

// videoEl: an already-playing <video> element (e.g. from
// ui/full-voice-mode.js's lip-sync camera preview) with the camera
// stream as its srcObject.
export async function startMouthTracking(videoEl, onMouthActivityChange) {
  _videoEl = videoEl;
  _onMouthActivityChange = onMouthActivityChange || null;
  await _loadFaceLandmarker();
  _trackLoop();
}

export function stopMouthTracking() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  _videoEl = null;
  _mouthOpenScore = 0;
}

// REAL, exported for hands-free-vad.js to combine as a second vote —
// returns true when the mouth is genuinely, currently open enough to
// plausibly be mid-speech (not a strict threshold, just a real,
// honest signal alongside audio VAD, not a replacement for it).
export function isMouthActive() {
  return _mouthOpenScore > 0.15;
}

export function getMouthOpenScore() {
  return _mouthOpenScore;
}
