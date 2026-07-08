// ui/auth.js (v4) — Flow password panel, face verification, secret-question recovery
//
// TWO REAL FIXES THIS VERSION, BOTH FROM DIRECT FEEDBACK:
//
// 1. FACE SETUP MOVED TO FIRST LAUNCH: it used to require unlocking with
//    the PIN first, then going into the brain menu — a real gap for
//    something meant to be a fast unlock convenience. Now, right after
//    setting your PIN for the first time, Flow offers face setup
//    immediately, in the same flow — exactly like the PIN setup itself.
//    Skippable, and still available later from the brain menu too.
//
// 2. "FORGOT PIN?" WAS GENUINELY DEFENSELESS: it used to wipe the PIN
//    instantly with just a browser confirm() dialog — meaning anyone who
//    got to the lock screen could reset it with one click, no real gate
//    at all. Fixed: it's now a secret question YOU set during initial
//    setup (e.g. "What's Flow's real name?"), and the reset only proceeds
//    if the answer matches. Still a LOCAL-DEVICE mechanism, not a
//    cryptographically bulletproof recovery system — but a genuine gate
//    now, not an open door.
//
// FACE VERIFICATION SCOPE (unchanged, still true): pure geometric
// landmark comparison tops out around 64% accuracy in published research
// — not reliable enough as a sole security gate. Stays a fast-path
// convenience alongside the PIN, never replacing it.

const LOCK_KEY        = "flow_lock_hash";
const UNLOCK_KEY      = "flow_unlocked_until";
const FACE_KEY        = "flow_face_vector";
const RECOVERY_Q_KEY  = "flow_recovery_question";
const RECOVERY_A_KEY  = "flow_recovery_answer_hash";
const UNLOCK_HRS      = 5;
const MATCH_THRESHOLD = 0.90; // cosine similarity — tuned conservative:
                               // given the ~64% ceiling on pure geometric
                               // verification, a HIGH bar means face
                               // unlock will sometimes ask you to use the
                               // PIN instead of ever falsely accepting
                               // someone else. Fails safe, not convenient.

// ── KV persistence ──────────────────────────────────────────────────────
async function _kvSave(key, value) {
  try {
    const r = await fetch("/api/memory", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.kv === false) {
        console.warn(`[Flow Auth] Saved ${key} to localStorage only — KV is not configured on the server, so this is NOT backed up to the cloud yet.`);
      }
    } else {
      console.error(`[Flow Auth] KV save for ${key} failed with HTTP ${r.status}.`);
    }
  } catch (e) {
    console.error(`[Flow Auth] KV save for ${key} failed:`, e.message);
  }
}
async function _kvLoad(key, fallbackLocalKey) {
  try {
    const r = await fetch(`/api/memory?key=${encodeURIComponent(key)}`);
    if (r.ok) {
      const d = await r.json();
      if (d.value != null) {
        if (fallbackLocalKey) localStorage.setItem(fallbackLocalKey, typeof d.value === "string" ? d.value : JSON.stringify(d.value));
        return d.value;
      }
      // Same critical fix as _loadHashFromCloud: kv:false means KV isn't
      // configured server-side at all, not "confirmed empty" — trust the
      // local fallback in that case instead of wiping it.
      if (d.kv === false) {
        console.warn(`[Flow Auth] KV not configured — trusting local value for ${key}.`);
        if (!fallbackLocalKey) return null;
        const local = localStorage.getItem(fallbackLocalKey);
        try { return local ? JSON.parse(local) : local; } catch (_) { return local; }
      }
      if (fallbackLocalKey) localStorage.removeItem(fallbackLocalKey);
      return null;
    }
  } catch (_) {}
  if (!fallbackLocalKey) return null;
  const local = localStorage.getItem(fallbackLocalKey);
  try { return local ? JSON.parse(local) : local; } catch (_) { return local; }
}

async function _saveHashToCloud(hash) { await _kvSave("flow_pin_hash", hash); localStorage.setItem(LOCK_KEY, hash); }
async function _loadHashFromCloud() {
  try {
    const r = await fetch("/api/memory?key=flow_pin_hash");
    if (r.ok) {
      const d = await r.json();
      if (d.value && typeof d.value === "string") {
        localStorage.setItem(LOCK_KEY, d.value);
        return d.value;
      }
      // CRITICAL DISTINCTION missed by the previous version: memory.js
      // returns HTTP 200 with { value: null, kv: false } when
      // KV_REST_API_URL/TOKEN aren't configured on Vercel AT ALL — that's
      // a genuine misconfiguration, not "confirmed no PIN exists." The
      // earlier fix only told apart "network request failed" from
      // "KV explicitly confirmed empty," and missed this third case,
      // which meant a broken/unconfigured KV connection was silently
      // treated as authoritative and wiped a perfectly correct local PIN
      // — exactly the trap that made a newly-set PIN look "wrong" right
      // after setup with no visible cause.
      if (d.kv === false) {
        console.warn("[Flow Auth] KV is not configured on the server (KV_REST_API_URL/TOKEN missing) — trusting local PIN instead of wiping it based on an unreliable cloud check.");
        return localStorage.getItem(LOCK_KEY);
      }
      // KV genuinely IS connected (kv:true) and explicitly returned no
      // value — THIS is the real confirmed-empty case, safe to trust.
      localStorage.removeItem(LOCK_KEY);
      return null;
    }
  } catch (_) {}
  // Only reached if the KV request itself failed (network error, KV
  // misconfigured) — in that case, and ONLY that case, fall back to
  // whatever's in localStorage as a last resort.
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

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

async function _loadFaceLandmarker() {
  if (_faceLandmarker) return _faceLandmarker;
  if (_faceLoadPromise) return _faceLoadPromise;

  _faceLoadPromise = (async () => {
    // Each step below had NO timeout before this fix — any one of them
    // stalling (a slow/blocked CDN import, a WASM fetch that never
    // resolves, a model file fetch through the mediapipe proxy that
    // hangs) froze the entire face-verification flow indefinitely with
    // zero feedback, stuck exactly on "Starting camera…" forever. That's
    // precisely the reported bug. Now each step fails loudly and
    // specifically within 12 seconds instead of hanging silently.
    let mod;
    try {
      mod = await _withTimeout(
        import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs"),
        12000, "Loading face-scan library"
      );
    } catch (e) {
      throw new Error(`Couldn't load the face-scan library — ${e.message}. Check your internet connection.`);
    }
    const { FaceLandmarker, FilesetResolver } = mod;

    let files;
    try {
      files = await _withTimeout(
        FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"),
        12000, "Loading face-scan engine"
      );
    } catch (e) {
      throw new Error(`Couldn't load the face-scan engine — ${e.message}.`);
    }

    try {
      _faceLandmarker = await _withTimeout(
        FaceLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: "/api/mediapipe?f=face_landmarker.task",
            delegate: "CPU",
          },
          runningMode: "IMAGE",
          numFaces: 1,
        }),
        20000, "Loading face model"
      );
    } catch (e) {
      // /api/mediapipe now tries Google's official model storage first,
      // then automatically falls back to a verified mirror if that's
      // unreachable — this is a real two-source fallback now, not a
      // single point of failure. If BOTH sources genuinely failed,
      // something is actually down rather than one flaky connection.
      throw new Error(`Couldn't load the face model — ${e.message}. Both the primary source and backup mirror failed — this usually means a genuine network issue on this device/network, not a one-off blip.`);
    }

    return _faceLandmarker;
  })();

  // If setup genuinely fails, clear the cached promise so the NEXT
  // attempt (e.g. pressing "Use PIN instead" then trying face unlock
  // again) actually retries from scratch instead of permanently
  // returning the same rejected promise forever.
  _faceLoadPromise.catch(() => { _faceLoadPromise = null; });

  return _faceLoadPromise;
}

function _computeFaceVector(landmarks) {
  const p = (i) => landmarks[i];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

  const leftEye = p(33), rightEye = p(263), nose = p(1);
  const mouthL = p(61), mouthR = p(291), chin = p(199);
  const forehead = p(10), faceL = p(234), faceR = p(454);

  const interocular = dist(leftEye, rightEye);
  if (interocular < 0.001) return null;

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

async function _captureFaceVector(video) {
  const landmarker = await _loadFaceLandmarker();
  const result = landmarker.detect(video);
  if (!result.faceLandmarks?.length) return null;
  return _computeFaceVector(result.faceLandmarks[0]);
}

// ── Camera + live mesh overlay UI for the face capture popup ──────────
// MediaPipe FaceLandmarker's standard face-mesh connection topology —
// pairs of landmark indices that form the actual facial contours (eyes,
// eyebrows, lips, face oval, nose bridge). This is what turns a scatter
// of 478 dots into a genuine connected "net" over the face, matching
// what was actually asked for.
const FACE_MESH_CONNECTIONS = [
  // Face oval
  [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],[356,454],
  [454,323],[323,361],[361,288],[288,397],[397,365],[365,379],[379,378],[378,400],
  [400,377],[377,152],[152,148],[148,176],[176,149],[149,150],[150,136],[136,172],
  [172,58],[58,132],[132,93],[93,234],[234,127],[127,162],[162,21],[21,54],[54,103],[103,67],[67,109],[109,10],
  // Left eye
  [33,7],[7,163],[163,144],[144,145],[145,153],[153,154],[154,155],[155,133],
  [133,173],[173,157],[157,158],[158,159],[159,160],[160,161],[161,246],[246,33],
  // Right eye
  [362,382],[382,381],[381,380],[380,374],[374,373],[373,390],[390,249],[249,263],
  [263,466],[466,388],[388,387],[387,386],[386,385],[385,384],[384,398],[398,362],
  // Lips outer
  [61,146],[146,91],[91,181],[181,84],[84,17],[17,314],[314,405],[405,321],[321,375],
  [375,291],[291,409],[409,270],[270,269],[269,267],[267,0],[0,37],[37,39],[39,40],[40,185],[185,61],
  // Eyebrows
  [70,63],[63,105],[105,66],[66,107],[336,296],[296,334],[334,293],[293,300],
  // Nose bridge
  [168,6],[6,197],[197,195],[195,5],
];

function _buildFaceCapture(mode, onResult, onCancel) {
  const isEnroll = mode === "enroll";
  const wrap = document.createElement("div");
  wrap.id = "flow-face-capture";
  wrap.innerHTML = `
    <div id="flow-face-inner">
      <div id="flow-face-title">${isEnroll ? "Set up Face Unlock" : "Verifying face…"}</div>
      <div id="flow-face-sub">Center your face in the frame</div>
      <div id="flow-face-video-wrap">
        <video id="flow-face-video" autoplay playsinline muted></video>
        <canvas id="flow-face-canvas"></canvas>
        <div id="flow-face-radar"></div>
        <div id="flow-face-wave"></div>
        <div id="flow-face-ring"></div>
        <svg id="flow-face-corners" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M8,20 L8,8 L20,8" /><path d="M80,8 L92,8 L92,20" />
          <path d="M92,80 L92,92 L80,92" /><path d="M20,92 L8,92 L8,80" />
        </svg>
      </div>
      <div id="flow-face-hud">
        <div class="flow-face-meter"><span>DISTANCE</span><div class="flow-face-bar"><div id="flow-face-dist-fill"></div></div></div>
        <div class="flow-face-meter"><span>LIGHT</span><div class="flow-face-bar"><div id="flow-face-light-fill"></div></div></div>
      </div>
      <div id="flow-face-status">Starting camera…</div>
      <div id="flow-face-hint"></div>
      <button id="flow-face-cancel">${isEnroll ? "Skip for now" : "Use PIN instead"}</button>
    </div>
  `;
  const style = document.createElement("style");
  style.textContent = `
    #flow-face-capture { position:fixed; inset:0; z-index:100000; display:flex; align-items:center; justify-content:center;
      background:rgba(6,10,26,0.97); backdrop-filter:blur(30px); }
    #flow-face-inner { display:flex; flex-direction:column; align-items:center; gap:12px;
      background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.16);
      border-radius:22px; padding:26px; width:min(380px,92vw); }
    #flow-face-title { font-family:'Orbitron',monospace; font-size:15px; color:#38bdf8; letter-spacing:.08em; }
    #flow-face-sub { font-size:12px; color:rgba(255,255,255,0.5); text-align:center; }
    #flow-face-video-wrap { position:relative; width:270px; height:270px; border-radius:20px; overflow:hidden; background:#000; }
    #flow-face-video { width:100%; height:100%; object-fit:cover; transform:scaleX(-1); }
    #flow-face-canvas { position:absolute; inset:0; width:100%; height:100%; transform:scaleX(-1); }
    #flow-face-ring { position:absolute; inset:0; border-radius:20px; pointer-events:none;
      border:2px solid rgba(56,189,248,0.4); transition:border-color .25s, box-shadow .25s; }
    #flow-face-ring.good { border-color:rgba(74,222,128,0.85); box-shadow:0 0 26px rgba(74,222,128,0.4) inset; }
    #flow-face-ring.bad  { border-color:rgba(248,113,113,0.55); }
    /* Corner brackets — the "advanced scanner" framing device */
    #flow-face-corners { position:absolute; inset:10px; width:calc(100% - 20px); height:calc(100% - 20px); pointer-events:none; }
    #flow-face-corners path { fill:none; stroke:rgba(56,189,248,0.7); stroke-width:2.5; }
    /* Rotating radar sweep — a full conic wedge rotating continuously
       while actively scanning, distinct from the mesh itself. */
    #flow-face-radar { position:absolute; inset:0; border-radius:20px; pointer-events:none; overflow:hidden;
      opacity:0; transition:opacity .2s; }
    #flow-face-radar.active { opacity:1; }
    #flow-face-radar::before { content:''; position:absolute; inset:-40%;
      background:conic-gradient(from 0deg, transparent 0deg, rgba(56,189,248,0.35) 18deg, rgba(56,189,248,0.05) 40deg, transparent 70deg);
      animation:flow-face-spin 2.2s linear infinite; }
    @keyframes flow-face-spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
    /* Vertical light-wave — a horizontal band that sweeps up and down
       independently of the radar, the second requested effect. */
    #flow-face-wave { position:absolute; left:0; right:0; height:36px; pointer-events:none;
      background:linear-gradient(180deg, transparent, rgba(56,189,248,0.5), transparent);
      opacity:0; }
    #flow-face-wave.active { opacity:1; animation:flow-face-wave-move 2.4s ease-in-out infinite; }
    @keyframes flow-face-wave-move { 0%,100% { top:6%; } 50% { top:88%; } }
    #flow-face-hud { display:flex; gap:16px; width:100%; }
    .flow-face-meter { flex:1; display:flex; flex-direction:column; gap:4px; }
    .flow-face-meter span { font-size:9px; color:rgba(255,255,255,0.4); letter-spacing:.1em; font-family:'Orbitron',monospace; }
    .flow-face-bar { height:5px; border-radius:3px; background:rgba(255,255,255,0.08); overflow:hidden; }
    .flow-face-bar > div { height:100%; width:50%; background:#38bdf8; transition:width .2s, background .2s; }
    #flow-face-status { font-size:13px; color:#a78bfa; min-height:18px; text-align:center; font-weight:600; }
    #flow-face-hint { font-size:11px; color:rgba(255,255,255,0.45); min-height:14px; text-align:center; }
    #flow-face-cancel { background:none; border:1px solid rgba(255,255,255,0.2); color:rgba(255,255,255,0.6);
      border-radius:10px; padding:8px 16px; font-size:12px; cursor:pointer; }
    #flow-face-cancel:hover { border-color:rgba(255,255,255,0.4); color:#fff; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(wrap);

  const video      = document.getElementById("flow-face-video");
  const canvas     = document.getElementById("flow-face-canvas");
  const ctx        = canvas.getContext("2d");
  const radar      = document.getElementById("flow-face-radar");
  const wave       = document.getElementById("flow-face-wave");
  const ring       = document.getElementById("flow-face-ring");
  const distFill   = document.getElementById("flow-face-dist-fill");
  const lightFill  = document.getElementById("flow-face-light-fill");
  const status     = document.getElementById("flow-face-status");
  const hint       = document.getElementById("flow-face-hint");
  let stream = null, rafId = null, closed = false, locking = false;
  let goodFrameCount = 0;

  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 32; sampleCanvas.height = 32;
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });

  function cleanup() {
    closed = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach(t => t.stop());
    wrap.remove();
  }

  document.getElementById("flow-face-cancel").addEventListener("click", () => { cleanup(); onCancel(); });

  function _measureBrightness() {
    try {
      sampleCtx.drawImage(video, 0, 0, 32, 32);
      const data = sampleCtx.getImageData(0, 0, 32, 32).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return sum / (data.length / 4);
    } catch (_) { return 128; }
  }

  function _drawMesh(lm) {
    const w = canvas.width, h = canvas.height;
    // Connecting lines first — this is what makes it read as an actual
    // net over the face, not a scatter of isolated points.
    ctx.strokeStyle = "rgba(56,189,248,0.55)";
    ctx.lineWidth = 1;
    for (const [a, b] of FACE_MESH_CONNECTIONS) {
      if (!lm[a] || !lm[b]) continue;
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
    // Points on top of the lines
    ctx.fillStyle = "rgba(167,139,250,0.9)";
    for (const pt of lm) {
      ctx.beginPath();
      ctx.arc(pt.x * w, pt.y * h, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  async function scanLoop() {
    if (closed) return;
    canvas.width = video.videoWidth || 270;
    canvas.height = video.videoHeight || 270;

    try {
      const landmarker = await _loadFaceLandmarker();
      const result = landmarker.detect(video);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const brightness = _measureBrightness();
      const lightPct = Math.max(0, Math.min(100, Math.round((brightness / 180) * 100)));
      lightFill.style.width = lightPct + "%";
      lightFill.style.background = lightPct < 30 ? "#f87171" : lightPct < 50 ? "#facc15" : "#4ade80";
      const tooDark = brightness < 55;

      if (result.faceLandmarks?.length) {
        const lm = result.faceLandmarks[0];
        _drawMesh(lm);

        // Same eye-corner geometry used in _computeFaceVector — genuine
        // shared signal, not a fabricated separate metric.
        const eyeSpan = Math.hypot(
          (lm[33].x - lm[263].x) * canvas.width,
          (lm[33].y - lm[263].y) * canvas.height
        );
        const eyeFraction = eyeSpan / canvas.width;
        const distPct = Math.max(0, Math.min(100, Math.round(((eyeFraction - 0.1) / 0.4) * 100)));
        distFill.style.width = distPct + "%";

        const tooFar   = eyeFraction < 0.18;
        const tooClose = eyeFraction > 0.42;
        distFill.style.background = (tooFar || tooClose) ? "#f87171" : "#4ade80";

        radar.classList.add("active");

        if (tooDark) {
          status.textContent = "Lighting is too low";
          hint.textContent = "Move somewhere brighter, or face a light source";
          ring.className = "bad"; wave.classList.remove("active");
          goodFrameCount = 0;
        } else if (tooFar) {
          status.textContent = "Move closer";
          hint.textContent = "";
          ring.className = "bad"; wave.classList.remove("active");
          goodFrameCount = 0;
        } else if (tooClose) {
          status.textContent = "Move back a little";
          hint.textContent = "";
          ring.className = "bad"; wave.classList.remove("active");
          goodFrameCount = 0;
        } else {
          // Everything genuinely good — the light-wave sweep only turns
          // on during this final locking phase, so it visually signals
          // "actively capturing" specifically, distinct from the radar
          // sweep which runs during the whole search phase.
          goodFrameCount++;
          const framesNeeded = isEnroll ? 20 : 14;
          wave.classList.add("active");
          status.textContent = goodFrameCount >= framesNeeded ? "Locked — scanning" : "Hold still…";
          hint.textContent = "";
          ring.className = "good";

          if (goodFrameCount >= framesNeeded && !locking) {
            locking = true;
            radar.classList.remove("active");
            wave.classList.remove("active");
            status.textContent = "Scan complete";
            // SECURITY FIX: previously captured exactly ONE vector at the
            // end of the good-frame window and compared it once — a
            // single transient false-positive match (bad lighting moment,
            // brief angle glitch) was enough to fully unlock. Given the
            // documented ~64% real-world accuracy ceiling of this
            // geometric-vector approach, that's a genuine gap, confirmed
            // in practice when it accepted someone who wasn't Joel.
            // Now captures 3 SEPARATE vectors across brief pauses within
            // the already-held-still window (cheap — Joel is already
            // holding still for the frame count anyway, adds negligible
            // time) and requires the CALLER to check all 3 independently
            // against the enrolled vector, rather than trusting one shot.
            const vectors = [];
            for (let i = 0; i < 3; i++) {
              const v = await _captureFaceVector(video);
              if (v) vectors.push(v);
              if (i < 2) await new Promise(r => setTimeout(r, 150)); // brief gap between captures, still well within a natural "hold still" pause
            }
            cleanup();
            onResult(vectors); // now an array of up to 3 vectors, not a single one — callers must be updated to check all of them
            return;
          }
        }
      } else {
        status.textContent = "No face detected";
        hint.textContent = "Center yourself in the frame";
        ring.className = "bad"; wave.classList.remove("active"); radar.classList.remove("active");
        distFill.style.width = "0%";
        goodFrameCount = 0;
      }
    } catch (_) {}

    if (!closed && !locking) rafId = requestAnimationFrame(scanLoop);
  }

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 480 } });
      video.srcObject = stream;
      await new Promise(r => { video.onloadedmetadata = r; });
      await _loadFaceLandmarker();
      status.textContent = "Scanning…";
      scanLoop();
    } catch (e) {
      status.textContent = `Camera error: ${e.message}`;
      setTimeout(() => { cleanup(); onCancel(); }, 2000);
    }
  })();

  return { cleanup };
}

async function _enrollFaceInline(onDone) {
  _buildFaceCapture("enroll", async (vectors) => {
    // onResult now delivers an array of up to 3 captures — average them
    // into one enrolled reference vector, which is itself a small
    // accuracy improvement over enrolling from a single frame (smooths
    // out one-off measurement noise from a single capture).
    const valid = (vectors || []).filter(Boolean);
    if (!valid.length) { onDone?.(false, "No face detected clearly enough."); return; }
    const dims = valid[0].length;
    const avgVector = Array.from({ length: dims }, (_, i) =>
      valid.reduce((sum, v) => sum + v[i], 0) / valid.length
    );
    localStorage.setItem(FACE_KEY, JSON.stringify(avgVector));
    await _kvSave("flow_face_vector", avgVector);
    onDone?.(true, "Face Unlock set up.");
  }, () => { onDone?.(false, "Skipped."); });
}

// ═══════════════════════════════════════════════════════════════════════
// SECRET QUESTION RECOVERY — real gate, not an instant wipe
// ═══════════════════════════════════════════════════════════════════════

function _buildRecoveryPrompt(question, onSubmit, onCancel) {
  const wrap = document.createElement("div");
  wrap.id = "flow-recovery-prompt";
  wrap.innerHTML = `
    <div id="flow-recovery-inner">
      <div id="flow-recovery-title">Forgot PIN — Answer to reset</div>
      <div id="flow-recovery-q">${question}</div>
      <input id="flow-recovery-input" type="text" placeholder="Your answer" autocomplete="off">
      <button id="flow-recovery-submit">SUBMIT</button>
      <div id="flow-recovery-err"></div>
      <button id="flow-recovery-cancel">Cancel</button>
    </div>
  `;
  const style = document.createElement("style");
  style.textContent = `
    #flow-recovery-prompt { position:fixed; inset:0; z-index:100001; display:flex; align-items:center; justify-content:center;
      background:rgba(6,10,26,0.97); backdrop-filter:blur(30px); }
    #flow-recovery-inner { display:flex; flex-direction:column; align-items:center; gap:12px;
      background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.18); border-radius:22px; padding:30px; width:min(340px,88vw); }
    #flow-recovery-title { font-family:'Orbitron',monospace; font-size:13px; color:#38bdf8; letter-spacing:.06em; text-align:center; }
    #flow-recovery-q { font-size:14px; color:rgba(255,255,255,0.85); text-align:center; padding:4px 0; }
    #flow-recovery-input { width:100%; padding:12px 14px; border-radius:12px; background:rgba(255,255,255,0.08);
      border:1px solid rgba(255,255,255,0.18); color:#fff; font-size:15px; text-align:center; outline:none; }
    #flow-recovery-input:focus { border-color:rgba(56,189,248,0.55); }
    #flow-recovery-submit { width:100%; padding:12px; background:rgba(56,189,248,0.15); border:1px solid rgba(56,189,248,0.4);
      border-radius:12px; color:#38bdf8; font-family:'Orbitron',monospace; font-size:11px; letter-spacing:.15em; cursor:pointer; }
    #flow-recovery-submit:hover { background:rgba(56,189,248,0.28); }
    #flow-recovery-err { font-size:12px; color:#f87171; min-height:16px; text-align:center; }
    #flow-recovery-cancel { background:none; border:none; color:rgba(255,255,255,0.4); font-size:12px; text-decoration:underline; cursor:pointer; }
    #flow-recovery-cancel:hover { color:rgba(255,255,255,0.65); }
  `;
  document.head.appendChild(style);
  document.body.appendChild(wrap);

  const input = document.getElementById("flow-recovery-input");
  const err   = document.getElementById("flow-recovery-err");
  const submit = () => onSubmit(input.value.trim(), err, () => wrap.remove());
  document.getElementById("flow-recovery-submit").addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
  document.getElementById("flow-recovery-cancel").addEventListener("click", () => { wrap.remove(); onCancel(); });
  setTimeout(() => input.focus(), 100);
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
${!isSetup ? `
        <div id="flow-pin-boxes"></div>
        <input id="flow-auth-input" type="password" style="position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;" autocomplete="current-password" maxlength="32">
      ` : `
        <input id="flow-auth-input"
          type="password"
          placeholder="Create PIN (4+ characters)"
          autocomplete="current-password"
          maxlength="32">
      `}
        ${!isSetup ? `<button id="flow-face-eye-btn" title="Unlock with face">👁</button>` : ""}
      </div>

      ${isSetup ? `<input id="flow-auth-confirm" type="password" placeholder="Confirm PIN" autocomplete="new-password" maxlength="32">` : ""}
      ${isSetup ? `
        <div id="flow-auth-recovery-block">
          <input id="flow-auth-recovery-q" type="text" placeholder="Secret question (e.g. What is Flow's real name?)" maxlength="120">
          <input id="flow-auth-recovery-a" type="text" placeholder="Answer to that question" maxlength="80" autocomplete="off">
        </div>
      ` : ""}

      <button id="flow-auth-btn">${isSetup ? "SET PIN" : "UNLOCK"}</button>
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

    /* ── Segmented PIN digit boxes — replaces the flat text input for
       unlock mode. Each box glows green by default (matches Joel's
       "green light" request), individually flashes red + the whole row
       shakes on a wrong PIN, then clears for a fresh attempt. ────────── */
    #flow-pin-boxes { display:flex; gap:10px; justify-content:center; }
    .flow-pin-box {
      width:46px; height:54px; border-radius:12px;
      background:rgba(255,255,255,0.06);
      border:1.5px solid rgba(74,222,128,0.4);
      box-shadow:0 0 10px rgba(74,222,128,0.15) inset;
      display:flex; align-items:center; justify-content:center;
      font-size:22px; color:#fff; font-family:monospace;
      transition:border-color .15s, box-shadow .15s, background .15s;
    }
    .flow-pin-box.filled {
      border-color:rgba(74,222,128,0.75);
      box-shadow:0 0 14px rgba(74,222,128,0.35) inset, 0 0 10px rgba(74,222,128,0.25);
      background:rgba(74,222,128,0.08);
    }
    .flow-pin-box.error {
      border-color:rgba(239,68,68,0.9) !important;
      box-shadow:0 0 16px rgba(239,68,68,0.5) inset, 0 0 14px rgba(239,68,68,0.4) !important;
      background:rgba(239,68,68,0.12) !important;
    }
    #flow-pin-boxes.shake { animation: flow-pin-shake .42s ease; }
    @keyframes flow-pin-shake {
      0%, 100% { transform:translateX(0); }
      15%      { transform:translateX(-10px); }
      30%      { transform:translateX(9px); }
      45%      { transform:translateX(-7px); }
      60%      { transform:translateX(6px); }
      75%      { transform:translateX(-4px); }
      90%      { transform:translateX(3px); }
    }
    #flow-face-eye-btn { flex-shrink:0; width:48px; border-radius:14px; border:1px solid rgba(167,139,250,0.35);
      background:rgba(167,139,250,0.1); font-size:20px; cursor:pointer; transition:background .2s; }
    #flow-face-eye-btn:hover { background:rgba(167,139,250,0.22); }
    #flow-face-eye-btn.disabled { opacity:0.3; cursor:not-allowed; }
    #flow-auth-recovery-block { display:flex; flex-direction:column; gap:8px; width:100%; }
    #flow-auth-recovery-q, #flow-auth-recovery-a { width:100%; padding:11px 14px; border-radius:12px;
      background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); color:#fff; font-size:13px;
      outline:none; font-family:'Rajdhani',sans-serif; }
    #flow-auth-recovery-q:focus, #flow-auth-recovery-a:focus { border-color:rgba(56,189,248,0.5); }
    #flow-auth-btn { width:100%; padding:14px; background:rgba(56,189,248,0.15); border:1px solid rgba(56,189,248,0.4);
      border-radius:14px; color:#38bdf8; font-family:'Orbitron',monospace; font-size:12px; letter-spacing:.18em;
      cursor:pointer; transition:background .2s, box-shadow .2s; }
    #flow-auth-btn:hover { background:rgba(56,189,248,0.28); box-shadow:0 0 20px rgba(56,189,248,0.2); }
    #flow-auth-err { font-size:12px; color:#f87171; min-height:18px; font-family:'Rajdhani',sans-serif; text-align:center; }
    #flow-auth-forgot { font-size:12px; color:rgba(255,255,255,0.35); text-decoration:underline; cursor:pointer; }
    #flow-auth-forgot:hover { color:rgba(255,255,255,0.6); }
    @media (max-width:480px) { #flow-auth-inner { padding:32px 22px; } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  const input     = document.getElementById("flow-auth-input");
  const confirm   = document.getElementById("flow-auth-confirm");
  const recoveryQ = document.getElementById("flow-auth-recovery-q");
  const recoveryA = document.getElementById("flow-auth-recovery-a");
  const btn       = document.getElementById("flow-auth-btn");
  const err       = document.getElementById("flow-auth-err");
  const eyeBtn    = document.getElementById("flow-face-eye-btn");
  const forgot    = document.getElementById("flow-auth-forgot");

  if (eyeBtn && !faceEnrolled) {
    eyeBtn.classList.add("disabled");
    eyeBtn.title = "No face set up yet — set one up from the brain menu.";
  }

  setTimeout(() => input?.focus(), 100);
  [input, confirm].forEach(el => el?.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); }));
  // Extra safety net: clicking ANYWHERE in the auth panel refocuses the
  // real input, not just the box row — covers Electron's window/focus
  // timing potentially differing from a browser tab's, which could have
  // silently left the input unfocused with no visible way to tell.
  document.getElementById("flow-auth-panel")?.addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON" && e.target.tagName !== "A") input?.focus();
  });

  // ── Segmented digit-box display (unlock mode only) ──────────────────
  // The real, hidden <input> above still does all the actual work
  // (keystroke capture, paste support, mobile keyboard triggering) —
  // this just renders a visual box per character, growing as Joel types,
  // shrinking as he backspaces. Kept flexible-length (not a fixed 4-box
  // grid) since PINs aren't restricted to exactly 4 characters.
  const boxesEl = document.getElementById("flow-pin-boxes");
  function _renderPinBoxes() {
    if (!boxesEl || !input) return;
    const val = input.value;
    const len = Math.max(val.length, 4); // always show at least 4 boxes, even before typing starts
    boxesEl.innerHTML = "";
    for (let i = 0; i < len; i++) {
      const box = document.createElement("div");
      box.className = "flow-pin-box" + (i < val.length ? " filled" : "");
      box.textContent = i < val.length ? "•" : "";
      boxesEl.appendChild(box);
    }
  }
  if (boxesEl) {
    input.addEventListener("input", _renderPinBoxes);
    _renderPinBoxes();
    // BUG FIX: the real <input> is positioned off-screen (so only the
    // visible box row shows), which means clicking the box row itself
    // did nothing — there was no way to (re)focus the real input if
    // focus was ever lost after the initial auto-focus, which is exactly
    // why typing appeared completely broken. Now clicking anywhere on
    // the box row refocuses the real input immediately.
    boxesEl.style.cursor = "text";
    boxesEl.addEventListener("click", () => input.focus());
  }

  // Flashes every box red + shakes, then clears — called on a wrong PIN.
  // Exposed on the returned object so the unlock click-handler (which
  // knows about wrong-attempt state) can trigger it directly.
  function _flashPinBoxesRed() {
    if (!boxesEl) return;
    const boxes = boxesEl.querySelectorAll(".flow-pin-box");
    boxes.forEach(b => b.classList.add("error"));
    boxesEl.classList.add("shake");
    setTimeout(() => {
      boxesEl.classList.remove("shake");
      boxes.forEach(b => b.classList.remove("error"));
    }, 420);
  }

  return { input, confirm, recoveryQ, recoveryA, btn, err, eyeBtn, forgot, flashPinBoxesRed: _flashPinBoxesRed };
}

// ── Main export ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════
// TEMPORARY BYPASS — set to true to skip the lock screen entirely while
// Joel sets his own PIN, secret question, and face verification up
// properly from inside the app. Flip back to false once done, then push
// again to re-enable the lock. This is intentionally a single obvious
// switch right at the top of the file — not a backdoor buried elsewhere —
// so it's easy to find, easy to verify, and easy to turn back off.
// ═══════════════════════════════════════════════════════════════════════
const BYPASS_LOCK = false;

export async function initAuth() {
  if (BYPASS_LOCK) {
    console.warn("[Flow Auth] BYPASS_LOCK is ON — lock screen is skipped. Set it back to false in ui/auth.js once setup is done.");
    return;
  }

  const stored = await _loadHashFromCloud();
  if (stored && _isUnlocked()) return;

  return new Promise((resolve) => {

    if (!stored) {
      // First time — setup mode. Recovery question is REQUIRED, since
      // it's the only real gate on "Forgot PIN?" — without one, there'd
      // be nothing to fall back to.
      const { input, confirm, recoveryQ, recoveryA, btn, err } = _buildPanel("setup", false);

      btn.addEventListener("click", async () => {
        const val = input.value.trim();
        const con = confirm?.value.trim() || "";
        const q   = recoveryQ?.value.trim() || "";
        const a   = recoveryA?.value.trim() || "";

        if (val.length < 4) { err.textContent = "PIN must be at least 4 characters."; return; }
        if (val !== con)    { err.textContent = "PINs don't match."; return; }
        if (!q || !a)       { err.textContent = "Set a secret question and answer too — it's what protects \"Forgot PIN?\" from being an open door."; return; }

        const h  = await _hash(val);
        const ah = await _hash(a.toLowerCase());
        await _saveHashToCloud(h);
        await _kvSave("flow_recovery_question", q);
        await _kvSave("flow_recovery_answer_hash", ah);
        localStorage.setItem(RECOVERY_Q_KEY, q);
        localStorage.setItem(RECOVERY_A_KEY, ah);
        _setUnlocked();
        document.getElementById("flow-auth-panel")?.remove();

        // Face setup offered IMMEDIATELY, right in this same flow — not
        // hidden in the brain menu, which was the actual gap being fixed.
        const offer = document.createElement("div");
        offer.id = "flow-face-offer";
        offer.innerHTML = `
          <div id="flow-face-offer-inner">
            <div id="flow-face-offer-title">Set up Face Unlock?</div>
            <div id="flow-face-offer-sub">A quick way to unlock next time — your PIN still works either way.</div>
            <button id="flow-face-offer-yes">SET IT UP</button>
            <button id="flow-face-offer-no">Skip for now</button>
          </div>`;
        const st = document.createElement("style");
        st.textContent = `
          #flow-face-offer { position:fixed; inset:0; z-index:99998; display:flex; align-items:center; justify-content:center;
            background:rgba(6,10,26,0.97); backdrop-filter:blur(30px); }
          #flow-face-offer-inner { display:flex; flex-direction:column; align-items:center; gap:12px;
            background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.18); border-radius:22px; padding:32px; width:min(320px,86vw); }
          #flow-face-offer-title { font-family:'Orbitron',monospace; font-size:15px; color:#38bdf8; text-align:center; }
          #flow-face-offer-sub { font-size:12px; color:rgba(255,255,255,0.5); text-align:center; }
          #flow-face-offer-yes { width:100%; padding:12px; background:rgba(167,139,250,0.18); border:1px solid rgba(167,139,250,0.45);
            border-radius:12px; color:#a78bfa; font-family:'Orbitron',monospace; font-size:11px; letter-spacing:.12em; cursor:pointer; }
          #flow-face-offer-yes:hover { background:rgba(167,139,250,0.3); }
          #flow-face-offer-no { background:none; border:none; color:rgba(255,255,255,0.4); font-size:12px; text-decoration:underline; cursor:pointer; }
          #flow-face-offer-no:hover { color:rgba(255,255,255,0.65); }
        `;
        document.head.appendChild(st);
        document.body.appendChild(offer);

        document.getElementById("flow-face-offer-yes").addEventListener("click", () => {
          offer.remove();
          _enrollFaceInline(() => { resolve(); });
        });
        document.getElementById("flow-face-offer-no").addEventListener("click", () => {
          offer.remove();
          resolve();
        });
      });

    } else {
      // Return visit — unlock mode
      let attempts = 0;
      const faceVectorRaw = localStorage.getItem(FACE_KEY);
      const faceEnrolled = !!faceVectorRaw;
      const { input, btn, err, eyeBtn, forgot, flashPinBoxesRed } = _buildPanel("unlock", faceEnrolled);

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
          err.textContent = attempts >= 3 ? `Wrong PIN (${attempts} attempts). Try again, or use "Forgot PIN?" below.` : "Wrong PIN.";
          flashPinBoxesRed?.();
          setTimeout(() => {
            input.value = "";
            input.dispatchEvent(new Event("input")); // re-renders the box row back to empty
            input.focus();
          }, 420); // matches the flash/shake duration, so boxes clear right as the red flash finishes
        }
      });

      // Face unlock — fast path, never the only path
      if (eyeBtn && faceEnrolled) {
        eyeBtn.addEventListener("click", () => {
          let enrolledVector;
          try { enrolledVector = JSON.parse(faceVectorRaw); } catch (_) { enrolledVector = null; }
          if (!enrolledVector) return;

          document.getElementById("flow-auth-panel").style.display = "none";
          _buildFaceCapture("verify", (capturedVectors) => {
            document.getElementById("flow-auth-panel").style.display = "flex";
            // SECURITY FIX: previously compared ONE captured vector once —
            // a single transient false-positive was enough to fully
            // unlock, confirmed in practice when it accepted someone who
            // wasn't Joel. Now requires ALL 3 independently-captured
            // vectors to each individually clear MATCH_THRESHOLD against
            // the enrolled vector. A genuine match (Joel's actual face)
            // clears this consistently across all 3 captures a fraction
            // of a second apart; a borderline false-positive from a
            // different person is much less likely to clear the bar on
            // EVERY one of 3 separate captures, since real geometric
            // measurement noise varies slightly frame to frame.
            const valid = (capturedVectors || []).filter(Boolean);
            const allMatch = valid.length === 3 && valid.every(v => _cosineSimilarity(enrolledVector, v) >= MATCH_THRESHOLD);

            if (allMatch) {
              _setUnlocked();
              document.getElementById("flow-auth-panel")?.remove();
              resolve();
            } else {
              err.textContent = valid.length
                ? "Face didn't match closely enough — try again, or use your PIN."
                : "Couldn't get a clear face reading — try again, or use your PIN.";
            }
          }, () => {
            document.getElementById("flow-auth-panel").style.display = "flex";
          });
        });
      }

      // THE REAL FIX: "Forgot PIN?" now requires answering the secret
      // question set at initial setup — not an instant wipe behind a
      // single confirm() dialog anymore.
      forgot?.addEventListener("click", async () => {
        const question    = await _kvLoad("flow_recovery_question", RECOVERY_Q_KEY);
        const answerHash  = await _kvLoad("flow_recovery_answer_hash", RECOVERY_A_KEY);

        if (!question || !answerHash) {
          err.textContent = "No recovery question was set up with this PIN — there's no safe way to reset without it.";
          return;
        }

        _buildRecoveryPrompt(question, async (answer, recErr, closePrompt) => {
          if (!answer) { recErr.textContent = "Enter an answer."; return; }
          const h = await _hash(answer.toLowerCase());
          if (h !== answerHash) {
            recErr.textContent = "That's not the right answer.";
            return;
          }
          closePrompt();
          localStorage.removeItem(LOCK_KEY);
          localStorage.removeItem(UNLOCK_KEY);
          localStorage.removeItem(FACE_KEY);
          await _kvSave("flow_pin_hash", null);
          location.reload();
        }, () => {});
      });
    }
  });
}

// ── Face enrollment / removal — still available from the brain menu too ──
export async function enrollFace(onDone) {
  await _enrollFaceInline(onDone);
}

export function hasFaceEnrolled() { return !!localStorage.getItem(FACE_KEY); }

// ── Shared recovery-question gate for in-app resets ─────────────────────
// PREVIOUSLY: resetFace() and resetPin(), when triggered from the brain
// menu while already unlocked, needed no secondary confirmation at all —
// a real gap Joel correctly flagged, since anyone with momentary access
// to an already-unlocked session could silently reset either credential.
// Now both require correctly answering the same secret question used by
// the lock-screen's "Forgot PIN?" flow, before proceeding at all.
async function _confirmViaRecoveryQuestion(actionLabel) {
  const question = await _kvLoad("flow_recovery_question", RECOVERY_Q_KEY);
  const answerHash = await _kvLoad("flow_recovery_answer_hash", RECOVERY_A_KEY);
  if (!question || !answerHash) {
    // No recovery question was ever set up — can't gate on something
    // that doesn't exist. Fall back to the browser confirm() rather than
    // silently blocking Joel from ever resetting anything.
    return confirm(`No secret question is set up, so this can't be double-checked. Proceed with ${actionLabel} anyway?`);
  }

  const answer = prompt(`To confirm ${actionLabel}, answer your secret question:\n\n${question}`);
  if (answer == null) return false; // cancelled
  const h = await _hash(answer.trim().toLowerCase());
  if (h !== answerHash) {
    alert("That answer doesn't match — reset cancelled.");
    return false;
  }
  return true;
}

export async function resetFace() {
  const ok = await _confirmViaRecoveryQuestion("resetting Face Unlock");
  if (!ok) return;
  localStorage.removeItem(FACE_KEY);
  _kvSave("flow_face_vector", null);
}

// Reset PIN from the brain menu (already unlocked) — now requires
// answering the secret question first, same gate as resetFace() above,
// instead of resetting on a bare confirm() with no real verification.
export async function resetPin() {
  const ok = await _confirmViaRecoveryQuestion("resetting your PIN");
  if (!ok) return;
  if (!confirm("This will require setting up a brand new PIN and secret question on next load. Continue?")) return;
  localStorage.removeItem(LOCK_KEY);
  localStorage.removeItem(UNLOCK_KEY);
  localStorage.removeItem(RECOVERY_Q_KEY);
  localStorage.removeItem(RECOVERY_A_KEY);
  location.reload();
}
