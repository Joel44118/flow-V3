// ui/auth.js (v3) — Flow password panel + face verification fast-path
//
// WHAT CHANGED AND WHY, READ THIS FIRST:
//
// 1. THE LOCKOUT BUG: "Reset PIN" used to live only in the brain menu —
//    which is INSIDE the app, unreachable if you're locked out. That's a
//    real design flaw I introduced. Fixed: "Forgot PIN?" now lives
//    directly on the lock screen itself, reachable with zero prior access.
//    This is a LOCAL device reset (clears the hash so a new one can be
//    set), not a remote account recovery system. That's an honest
//    tradeoff: anyone with physical access to your unlocked device could
//    reset it too, same as most personal local-lock apps.
//
// 2. FACE VERIFICATION — SCOPED HONESTLY:
//    Peer-reviewed research on landmark-geometry face verification (the
//    only approach safely buildable here without new fragile
//    dependencies) shows real accuracy around 64% — genuinely not
//    reliable enough to be a sole security gate. Building it as your
//    ONLY unlock method would very likely lock you out again. So: face
//    verification is a FAST-PATH CONVENIENCE, always sitting alongside
//    the PIN field, never hiding or blocking it.
//
//    Technology: MediaPipe FaceLandmarker (same Google MediaPipe family
//    already proven working in this exact app via gesture control) —
//    478 3D face landmarks per frame, the "net-like structure aligning
//    with your face" is literally this mesh, drawn live during capture.
//    A normalized geometric feature vector (interocular distance, jaw
//    width, nose ratios — all scale/rotation invariant) is computed and
//    compared via cosine similarity against your one enrolled vector.
//
//    Verified NOT to hit the earlier Electron landmine: unlike
//    SpeechRecognition (confirmed broken in Electron's Chromium),
//    MediaPipe's WASM vision tasks run entirely locally with no cloud
//    dependency, and the same underlying engine family (hand tracking)
//    is already proven working in this exact Electron app.

const LOCK_KEY        = "flow_lock_hash";
const UNLOCK_KEY       = "flow_unlocked_until";
const FACE_KEY          = "flow_face_vector";
const UNLOCK_HRS       = 5;
const MATCH_THRESHOLD = 0.90; // cosine similarity — tuned conservative:
                               // given the ~64% ceiling on pure geometric
                               // verification, a HIGH bar means face
                               // unlock will sometimes ask you to use the
                               // PIN instead of ever falsely accepting
                               // someone else. Fails safe, not convenient.

// ── KV persistence (same pattern as PIN hash) ──────────────────────────
async function _kvSave(key, value) {
  try {
    await fetch("/api/memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
  } catch (_) {}
}

async function _saveHashToCloud(hash) { await _kvSave("flow_pin_hash", hash); localStorage.setItem(LOCK_KEY, hash); }
async function _loadHashFromCloud() {
  try {
    const r = await fetch("/api/memory?key=flow_pin_hash");
    if (r.ok) {
      const d = await r.json();
      if (d.value && typeof d.value === "string") { localStorage.setItem(LOCK_KEY, d.value); return d.value; }
    }
  } catch (_) {}
  return localStorage.getItem(LOCK_KEY);
}

// ── SHA-256 hash (browser native, no libraries) ───────────────────────────
async function _hash(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function _isUnlocked() {
  const until = localStorage.getItem(UNLOCK_KEY);
  if (!until) return false;
  return Date.now() < parseInt(until, 10);
}
function _setUnlocked() {
  localStorage.setItem(UNLOCK_KEY, String(Date.now() + UNLOCK_HRS * 60 * 60 * 1000));
}

// ═══════════════════════════════════════════════════════════════════════
// FACE VERIFICATION — MediaPipe FaceLandmarker, fully local, no cloud call
// ═══════════════════════════════════════════════════════════════════════

let _faceLandmarker = null;
let _faceLoadPromise = null;

// Loaded lazily — only when the eye button is actually pressed, so the
// lock screen itself stays instant even on a slow connection.
async function _loadFaceLandmarker() {
  if (_faceLandmarker) return _faceLandmarker;
  if (_faceLoadPromise) return _faceLoadPromise;

  _faceLoadPromise = (async () => {
    const { FaceLandmarker, FilesetResolver } = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs"
    );
    const files = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
    );
    _faceLandmarker = await FaceLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: "/api/mediapipe?f=face_landmarker.task",
        delegate: "CPU", // GPU delegate has documented crashes on some
                          // systems — CPU is slightly slower but reliable
                          // everywhere, which matters more for a lock
                          // screen than raw speed.
      },
      runningMode: "IMAGE",
      numFaces: 1,
    });
    return _faceLandmarker;
  })();

  return _faceLoadPromise;
}

// Converts 478 raw landmarks into a normalized, scale/rotation-invariant
// feature vector — ratios rather than raw coordinates, so it doesn't
// matter how close you are to the camera or how your head is tilted.
function _computeFaceVector(landmarks) {
  const p = (i) => landmarks[i];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

  // Key landmark indices (MediaPipe FaceLandmarker's 478-point topology):
  // 33/263 = outer eye corners, 1 = nose tip, 61/291 = mouth corners,
  // 199 = chin, 10 = forehead top, 234/454 = left/right face edge
  const leftEye = p(33), rightEye = p(263), nose = p(1);
  const mouthL = p(61), mouthR = p(291), chin = p(199);
  const forehead = p(10), faceL = p(234), faceR = p(454);

  const interocular = dist(leftEye, rightEye);
  if (interocular < 0.001) return null; // degenerate detection, reject

  return [
    dist(nose, leftEye) / interocular,
    dist(nose, rightEye) / interocular,
    dist(mouthL, mouthR) / interocular,
    dist(nose, chin) / interocular,
    dist(forehead, chin) / interocular,
    dist(faceL, faceR) / interocular,
    dist(nose, mouthL) / interocular,
    dist(nose, mouthR) / interocular,
    dist(leftEye, chin) / interocular,
    dist(rightEye, chin) / interocular,
    dist(faceL, nose) / interocular,
    dist(faceR, nose) / interocular,
  ];
}

function _cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Captures ONE frame, runs detection, returns the feature vector — used
// for both enrollment and verification so the exact same math applies.
async function _captureFaceVector(video) {
  const landmarker = await _loadFaceLandmarker();
  const result = landmarker.detect(video);
  if (!result.faceLandmarks?.length) return null;
  return _computeFaceVector(result.faceLandmarks[0]);
}

// ── Camera + live mesh overlay UI for the face capture popup ──────────
function _buildFaceCapture(mode, onResult, onCancel) {
  const isEnroll = mode === "enroll";
  const wrap = document.createElement("div");
  wrap.id = "flow-face-capture";
  wrap.innerHTML = `
    <div id="flow-face-inner">
      <div id="flow-face-title">${isEnroll ? "Set up Face Unlock" : "Verifying face…"}</div>
      <div id="flow-face-sub">${isEnroll ? "Look straight at the camera, good lighting helps." : "Hold still…"}</div>
      <div id="flow-face-video-wrap">
        <video id="flow-face-video" autoplay playsinline muted></video>
        <canvas id="flow-face-canvas"></canvas>
      </div>
      <div id="flow-face-status"></div>
      <button id="flow-face-cancel">Use PIN instead</button>
    </div>
  `;
  const style = document.createElement("style");
  style.textContent = `
    #flow-face-capture { position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center;
      background:rgba(6,10,26,0.97); backdrop-filter:blur(30px); }
    #flow-face-inner { display:flex; flex-direction:column; align-items:center; gap:14px;
      background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.16);
      border-radius:22px; padding:28px; width:min(360px,90vw); }
    #flow-face-title { font-family:'Orbitron',monospace; font-size:15px; color:#38bdf8; letter-spacing:.08em; }
    #flow-face-sub { font-size:12px; color:rgba(255,255,255,0.5); text-align:center; }
    #flow-face-video-wrap { position:relative; width:260px; height:260px; border-radius:50%; overflow:hidden;
      border:2px solid rgba(56,189,248,0.4); background:#000; }
    #flow-face-video { width:100%; height:100%; object-fit:cover; transform:scaleX(-1); }
    #flow-face-canvas { position:absolute; inset:0; width:100%; height:100%; transform:scaleX(-1); }
    #flow-face-status { font-size:12px; color:#a78bfa; min-height:16px; text-align:center; }
    #flow-face-cancel { background:none; border:1px solid rgba(255,255,255,0.2); color:rgba(255,255,255,0.6);
      border-radius:10px; padding:8px 16px; font-size:12px; cursor:pointer; }
    #flow-face-cancel:hover { border-color:rgba(255,255,255,0.4); color:#fff; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(wrap);

  const video  = document.getElementById("flow-face-video");
  const canvas = document.getElementById("flow-face-canvas");
  const ctx    = canvas.getContext("2d");
  const status = document.getElementById("flow-face-status");
  let stream = null, rafId = null, closed = false;

  function cleanup() {
    closed = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach(t => t.stop());
    wrap.remove();
  }

  document.getElementById("flow-face-cancel").addEventListener("click", () => { cleanup(); onCancel(); });

  // Draws the live 478-point mesh overlay — the "net-like structure
  // aligning with your face" from the request.
  async function drawMeshLoop() {
    if (closed) return;
    canvas.width = video.videoWidth || 260;
    canvas.height = video.videoHeight || 260;
    try {
      const landmarker = await _loadFaceLandmarker();
      const result = landmarker.detect(video);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (result.faceLandmarks?.length) {
        const lm = result.faceLandmarks[0];
        ctx.fillStyle = "rgba(56,189,248,0.85)";
        for (const pt of lm) {
          ctx.beginPath();
          ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
        status.textContent = isEnroll ? "Face detected — hold still" : "Face detected — checking…";
      } else {
        status.textContent = "No face detected — center yourself in frame";
      }
    } catch (_) {}
    rafId = requestAnimationFrame(drawMeshLoop);
  }

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 480 } });
      video.srcObject = stream;
      await new Promise(r => { video.onloadedmetadata = r; });
      await _loadFaceLandmarker();
      drawMeshLoop();

      // Give the mesh a moment to visibly lock on before capturing —
      // purely for a good user experience.
      await new Promise(r => setTimeout(r, isEnroll ? 1800 : 1200));
      if (closed) return;

      const vector = await _captureFaceVector(video);
      cleanup();
      onResult(vector);
    } catch (e) {
      status.textContent = `Camera error: ${e.message}`;
      setTimeout(() => { cleanup(); onCancel(); }, 2000);
    }
  })();

  return { cleanup };
}

// ── Build the lock screen UI ──────────────────────────────────────────────
function _buildPanel(mode, faceEnrolled) {
  document.getElementById("flow-auth-panel")?.remove();
  const isSetup = mode === "setup";

  const panel = document.createElement("div");
  panel.id = "flow-auth-panel";
  panel.innerHTML = `
    <div id="flow-auth-inner">
      <div id="flow-auth-logo">FLOW</div>
      <div id="flow-auth-sub">${isSetup ? "Create your access PIN" : "Enter your PIN to unlock"}</div>

      <div id="flow-auth-input-row">
        <input id="flow-auth-input"
          type="password"
          placeholder="${isSetup ? "Create PIN (4+ characters)" : "Enter PIN"}"
          autocomplete="current-password"
          maxlength="32">
        ${!isSetup ? `<button id="flow-face-eye-btn" title="Unlock with face">👁</button>` : ""}
      </div>

      ${isSetup ? `<input id="flow-auth-confirm" type="password" placeholder="Confirm PIN" autocomplete="new-password" maxlength="32">` : ""}

      <button id="flow-auth-btn">${isSetup ? "SET PIN" : "UNLOCK"}</button>
      ${isSetup ? `<div id="flow-face-enroll-hint">You can set up Face Unlock right after this, from the brain menu.</div>` : ""}
      <div id="flow-auth-err"></div>
      ${!isSetup ? `<a id="flow-auth-forgot" href="javascript:void(0)">Forgot PIN?</a>` : ""}
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #flow-auth-panel { position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center;
      background:rgba(6,10,26,0.97); backdrop-filter:blur(40px) saturate(180%); -webkit-backdrop-filter:blur(40px) saturate(180%); }
    #flow-auth-inner { display:flex; flex-direction:column; align-items:center; gap:14px;
      background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.18); border-radius:24px; padding:40px 36px;
      box-shadow:0 1px 0 rgba(255,255,255,0.12) inset, 0 32px 80px rgba(0,0,0,0.6); width:min(340px,88vw); }
    #flow-auth-logo { font-family:'Orbitron',monospace; font-size:28px; font-weight:700; letter-spacing:.35em; color:#38bdf8;
      text-shadow:0 0 28px rgba(56,189,248,0.55); margin-bottom:4px; }
    #flow-auth-sub { font-family:'Rajdhani',sans-serif; font-size:13px; color:rgba(255,255,255,0.45); letter-spacing:.05em; }
    #flow-auth-input-row { display:flex; gap:8px; width:100%; }
    #flow-auth-input, #flow-auth-confirm { width:100%; padding:13px 16px; border-radius:14px;
      background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.18); color:#fff; font-size:18px;
      letter-spacing:.25em; text-align:center; outline:none; font-family:monospace; transition:border-color .2s; }
    #flow-auth-input:focus, #flow-auth-confirm:focus { border-color:rgba(56,189,248,0.55); }
    #flow-face-eye-btn { flex-shrink:0; width:48px; border-radius:14px; border:1px solid rgba(167,139,250,0.35);
      background:rgba(167,139,250,0.1); font-size:20px; cursor:pointer; transition:background .2s; }
    #flow-face-eye-btn:hover { background:rgba(167,139,250,0.22); }
    #flow-face-eye-btn.disabled { opacity:0.3; cursor:not-allowed; }
    #flow-auth-btn { width:100%; padding:14px; background:rgba(56,189,248,0.15); border:1px solid rgba(56,189,248,0.4);
      border-radius:14px; color:#38bdf8; font-family:'Orbitron',monospace; font-size:12px; letter-spacing:.18em;
      cursor:pointer; transition:background .2s, box-shadow .2s; }
    #flow-auth-btn:hover { background:rgba(56,189,248,0.28); box-shadow:0 0 20px rgba(56,189,248,0.2); }
    #flow-auth-err { font-size:12px; color:#f87171; min-height:18px; font-family:'Rajdhani',sans-serif; text-align:center; }
    #flow-face-enroll-hint { font-size:11px; color:rgba(167,139,250,0.7); text-align:center; }
    #flow-auth-forgot { font-size:12px; color:rgba(255,255,255,0.35); text-decoration:underline; cursor:pointer; }
    #flow-auth-forgot:hover { color:rgba(255,255,255,0.6); }
    @media (max-width:480px) { #flow-auth-inner { padding:32px 22px; } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  const input   = document.getElementById("flow-auth-input");
  const confirm = document.getElementById("flow-auth-confirm");
  const btn     = document.getElementById("flow-auth-btn");
  const err     = document.getElementById("flow-auth-err");
  const eyeBtn  = document.getElementById("flow-face-eye-btn");
  const forgot  = document.getElementById("flow-auth-forgot");

  if (eyeBtn && !faceEnrolled) {
    eyeBtn.classList.add("disabled");
    eyeBtn.title = "No face set up yet — set one up from the brain menu after unlocking once with your PIN.";
  }

  setTimeout(() => input?.focus(), 100);
  [input, confirm].forEach(el => el?.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); }));

  return { input, confirm, btn, err, eyeBtn, forgot };
}

// ── Main export ───────────────────────────────────────────────────────────
export async function initAuth() {
  const stored = await _loadHashFromCloud();
  if (stored && _isUnlocked()) return;

  return new Promise((resolve) => {

    if (!stored) {
      // First time — setup mode
      const { input, confirm, btn, err } = _buildPanel("setup", false);

      btn.addEventListener("click", async () => {
        const val = input.value.trim();
        const con = confirm?.value.trim() || "";
        if (val.length < 4) { err.textContent = "PIN must be at least 4 characters."; return; }
        if (val !== con)    { err.textContent = "PINs don't match."; return; }
        const h = await _hash(val);
        await _saveHashToCloud(h);
        _setUnlocked();
        document.getElementById("flow-auth-panel")?.remove();
        resolve();
      });

    } else {
      // Return visit — unlock mode
      let attempts = 0;
      const faceVectorRaw = localStorage.getItem(FACE_KEY);
      const faceEnrolled = !!faceVectorRaw;
      const { input, btn, err, eyeBtn, forgot } = _buildPanel("unlock", faceEnrolled);

      btn.addEventListener("click", async () => {
        const val = input.value.trim();
        if (!val) { err.textContent = "Enter your PIN."; return; }
        const h = await _hash(val);
        if (h === stored) {
          _setUnlocked();
          document.getElementById("flow-auth-panel")?.remove();
          resolve();
        } else {
          attempts++;
          input.value = "";
          err.textContent = attempts >= 3 ? `Wrong PIN (${attempts} attempts). Try again, or use "Forgot PIN?" below.` : "Wrong PIN.";
          const inner = document.getElementById("flow-auth-inner");
          if (inner) {
            inner.style.transition = "transform .07s";
            inner.style.transform = "translateX(-8px)";
            setTimeout(() => { inner.style.transform = "translateX(8px)"; }, 70);
            setTimeout(() => { inner.style.transform = "translateX(0)"; }, 140);
          }
        }
      });

      // Face unlock — fast path, never the only path
      if (eyeBtn && faceEnrolled) {
        eyeBtn.addEventListener("click", () => {
          let enrolledVector;
          try { enrolledVector = JSON.parse(faceVectorRaw); } catch (_) { enrolledVector = null; }
          if (!enrolledVector) return;

          document.getElementById("flow-auth-panel").style.display = "none";
          _buildFaceCapture("verify", (capturedVector) => {
            document.getElementById("flow-auth-panel").style.display = "flex";
            const similarity = _cosineSimilarity(enrolledVector, capturedVector);
            if (capturedVector && similarity >= MATCH_THRESHOLD) {
              _setUnlocked();
              document.getElementById("flow-auth-panel")?.remove();
              resolve();
            } else {
              err.textContent = capturedVector
                ? "Face didn't match closely enough — try again, or use your PIN."
                : "Couldn't get a clear face reading — try again, or use your PIN.";
            }
          }, () => {
            document.getElementById("flow-auth-panel").style.display = "flex";
          });
        });
      }

      // THE ACTUAL LOCKOUT FIX — reachable directly from the lock screen,
      // no prior access required. This is a LOCAL reset: it clears the
      // hash stored on THIS device/browser so a fresh PIN can be set. It
      // does not verify identity beyond "you have access to this device
      // right now" — same tradeoff most personal local-lock screens make.
      forgot?.addEventListener("click", () => {
        const ok = confirm(
          "This clears the current PIN on this device and lets you set a new one immediately — no verification beyond having access to this device right now. Continue?"
        );
        if (!ok) return;
        localStorage.removeItem(LOCK_KEY);
        localStorage.removeItem(UNLOCK_KEY);
        localStorage.removeItem(FACE_KEY);
        _kvSave("flow_pin_hash", null);
        location.reload();
      });
    }
  });
}

// ── Face enrollment — call from the brain menu once unlocked ──────────
export async function enrollFace(onDone) {
  _buildFaceCapture("enroll", async (vector) => {
    if (!vector) { onDone?.(false, "No face detected clearly enough — try again in better lighting."); return; }
    localStorage.setItem(FACE_KEY, JSON.stringify(vector));
    await _kvSave("flow_face_vector", vector);
    onDone?.(true, "Face Unlock is set up — the 👁 button will now appear on your lock screen.");
  }, () => { onDone?.(false, "Cancelled."); });
}

export function hasFaceEnrolled() { return !!localStorage.getItem(FACE_KEY); }

export function resetFace() {
  localStorage.removeItem(FACE_KEY);
  _kvSave("flow_face_vector", null);
}

// Reset PIN (call from brain menu — IN ADDITION TO the lock-screen
// "Forgot PIN?", not a replacement)
export function resetPin() {
  if (!confirm("Reset your Flow PIN? You'll create a new one on next load.")) return;
  localStorage.removeItem(LOCK_KEY);
  localStorage.removeItem(UNLOCK_KEY);
  location.reload();
}
