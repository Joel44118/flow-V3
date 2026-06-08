// ═══════════════════════════════════════════
// ui/vision.js — Flow's Eyes
//
// YOLO FIX:
//   - Runs at max 2fps (500ms interval) instead of 5fps
//   - Uses requestIdleCallback between frames — browser
//     only runs inference when it has spare time
//   - Caps canvas at 320x240 for WASM performance
//   - Shows warning if browser reports page is slow
//   - Added explicit stop between each inference call
// ═══════════════════════════════════════════

import { Speech } from "../core/speech.js";

let _facerecog = null;
async function getFaceRecog() {
  if (_facerecog) return _facerecog;
  _facerecog = await import("./facerecog.js");
  return _facerecog;
}

let _chat    = null;
let _orb     = null;
let _sendMsg = null;

export function initVision(chat, orb, sendMsg) {
  _chat    = chat;
  _orb     = orb;
  _sendMsg = sendMsg;
}

let cameraStream  = null;
let screenStream  = null;
let yoloActive    = false;

async function openCamera() {
  if (cameraStream && cameraStream.active) return cameraStream;
  cameraStream?.getTracks().forEach(t => t.stop());
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240, facingMode: "user" },
    audio: false,
  });
  return cameraStream;
}

function captureFrame(videoEl, quality = 0.65) {
  const c = document.createElement("canvas");
  c.width  = videoEl.videoWidth  || 320;
  c.height = videoEl.videoHeight || 240;
  c.getContext("2d").drawImage(videoEl, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality).split(",")[1];
}

async function describeFrame(base64, prompt) {
  try {
    const res = await fetch("/api/vision", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, prompt }),
    });
    const data = await res.json();
    if (!res.ok || !data.description) throw new Error(data.error || "Vision API failed");
    return data.description;
  } catch(e) {
    console.error("[Flow Vision]", e.message);
    return null;
  }
}

// ─────────────────────────────────────────
//  CAMERA MODE
// ─────────────────────────────────────────
export const Camera = {
  _video: null,
  _container: null,

  async start() {
    if (cameraStream) { this.stop(); return; }
    try {
      cameraStream = await openCamera();
      await this._mount(cameraStream, "📷 CAMERA");
      Speech.speak("Camera online. I can see you now, Boss.");
      _chat?.add("Camera on. I can see you.", "bot");
      getFaceRecog().then(fr => { if (fr.hasLearnedFace()) fr.startRecognition(this._video); }).catch(()=>{});
    } catch(e) {
      _chat?.addError("Camera access denied: " + e.message);
    }
  },

  stop() {
    getFaceRecog().then(fr => fr.stopRecognition()).catch(()=>{});
    cameraStream?.getTracks().forEach(t => t.stop());
    cameraStream = null;
    this._unmount();
    Speech.speak("Camera off.");
  },

  async learnMyFace() {
    if (!this._video) { _chat?.addError("Open camera first, then say 'learn my face'."); return; }
    const fr = await getFaceRecog();
    await fr.learnFace(this._video);
    if (fr.hasLearnedFace()) fr.startRecognition(this._video);
  },

  async look(question) {
    if (!cameraStream || !this._video) {
      _chat?.addError("Camera is off. Say 'open camera' first.");
      return;
    }
    _orb?.setState("thinking");
    const frame  = captureFrame(this._video);
    const prompt = question || "Describe exactly what you see in this image. Be specific and brief.";
    const desc   = await describeFrame(frame, prompt);
    if (!desc) { _orb?.setState("idle"); return; }
    _chat?.add(desc, "bot");
    _orb?.setState("speaking");
    Speech.speak(desc, () => _orb?.setState("idle"));
  },

  async _mount(stream, label) {
    this._container = _createVideoContainer(label, () => this.stop());
    document.body.appendChild(this._container);
    this._video = this._container.querySelector("video");
    this._video.srcObject   = stream;
    this._video.muted       = true;
    this._video.playsInline = true;
    await new Promise(r => { this._video.onloadedmetadata = r; setTimeout(r, 2000); });
    await this._video.play().catch(e => console.warn("[Camera] play():", e.message));
  },

  _unmount() {
    this._container?.remove();
    this._container = null;
    this._video     = null;
  },
};

// ─────────────────────────────────────────
//  SCREEN MODE
// ─────────────────────────────────────────
export const ScreenVision = {
  _video: null,
  _container: null,

  async start() {
    if (screenStream) { this.stop(); return; }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStream.getVideoTracks()[0].onended = () => this.stop();
      await this._mount(screenStream, "🖥️ SCREEN");
      Speech.speak("Screen share active. I can see your screen.");
      _chat?.add("Screen captured. I can see everything on it.", "bot");
    } catch(e) {
      _chat?.addError("Screen share denied: " + e.message);
    }
  },

  stop() {
    screenStream?.getTracks().forEach(t => t.stop());
    screenStream = null;
    this._unmount();
    Speech.speak("Screen share ended.");
  },

  async look(question) {
    if (!screenStream || !this._video) {
      _chat?.addError("Screen share is off. Say 'share screen' first.");
      return;
    }
    _orb?.setState("thinking");
    const frame  = captureFrame(this._video, 0.6);
    const prompt = question || "Describe what is on this screen. What app is open, what content is visible? Be specific.";
    const desc   = await describeFrame(frame, prompt);
    if (!desc) { _orb?.setState("idle"); return; }
    _chat?.add(desc, "bot");
    _orb?.setState("speaking");
    Speech.speak(desc, () => _orb?.setState("idle"));
  },

  async _mount(stream, label) {
    this._container = _createVideoContainer(label, () => this.stop());
    document.body.appendChild(this._container);
    this._video = this._container.querySelector("video");
    this._video.srcObject   = stream;
    this._video.muted       = true;
    this._video.playsInline = true;
    await new Promise(r => { this._video.onloadedmetadata = r; setTimeout(r, 2000); });
    await this._video.play().catch(e => console.warn("[Screen] play():", e.message));
  },

  _unmount() {
    this._container?.remove();
    this._container = null;
    this._video     = null;
  },
};

// ─────────────────────────────────────────
//  YOLO — Real-time object detection
//
//  PERFORMANCE FIXES:
//  1. Max 2fps (500ms timeout) — WASM is slow
//  2. requestIdleCallback used so browser
//     yields to UI updates between frames
//  3. Canvas capped at 320x240 — quarter
//     the pixels of 640x480 = 4x faster WASM
//  4. Single shared tmp canvas (no GC pressure)
//  5. _inferring flag prevents overlapping calls
// ─────────────────────────────────────────
export const YOLO = {
  _pipeline:  null,
  _canvas:    null,
  _tmpCanvas: null, // reused across frames
  _video:     null,
  _container: null,
  _timerId:   null,
  _running:   false,
  _inferring: false, // prevents overlapping inference calls

  async start() {
    if (yoloActive) { this.stop(); return; }

    // Warn if device seems slow
    const cores = navigator.hardwareConcurrency || 2;
    if (cores <= 2) {
      _chat?.add("⚠️ YOLO needs a bit more CPU — it may be slow on this device. Use camera mode instead for basic vision.", "bot");
    }

    if (cameraStream && !cameraStream.active) cameraStream = null;

    _chat?.add("Loading object detection model... first load takes ~20 seconds.", "bot");
    _orb?.setState("thinking");

    try {
      if (!window._transformers) {
        await _loadScript("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js");
        window._transformers = window.transformers || window._transformers;
      }

      const { pipeline, env } = window.transformers || window._transformers ||
        await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js");

      env.allowRemoteModels = true;

      _chat?.add("Model downloading... almost there.", "bot");

      this._pipeline = await pipeline(
        "object-detection",
        "Xenova/yolos-tiny",
        { dtype: "fp32", device: "wasm" }
      );

      cameraStream = await openCamera();

      this._container = _createVideoContainer("🔍 YOLO DETECTION", () => this.stop());
      this._video  = this._container.querySelector("video");

      // Overlay canvas — same size as video (320x240)
      this._canvas = document.createElement("canvas");
      this._canvas.width  = 320;
      this._canvas.height = 240;
      this._canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;";
      this._container.appendChild(this._canvas);

      // Reusable capture canvas — created once, never GC'd mid-loop
      this._tmpCanvas = document.createElement("canvas");
      this._tmpCanvas.width  = 320;
      this._tmpCanvas.height = 240;

      this._video.srcObject   = cameraStream;
      document.body.appendChild(this._container);
      await new Promise(r => { this._video.onloadedmetadata = r; setTimeout(r, 2000); });
      await this._video.play().catch(e => console.warn("[YOLO] play():", e.message));

      yoloActive    = true;
      this._running = true;
      _orb?.setState("idle");
      _chat?.add("YOLO active. Detecting objects at 2fps — smooth and steady.", "bot");
      Speech.speak("Eyes online. Object detection active.");

      // Start loop via idle callback
      this._scheduleNext();

    } catch(e) {
      console.error("[YOLO]", e);
      _chat?.addError("YOLO failed: " + e.message);
      _orb?.setState("idle");
    }
  },

  _scheduleNext() {
    if (!this._running) return;
    // Use requestIdleCallback if available — runs when browser is free
    // Falls back to setTimeout at 500ms (2fps)
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => this._runFrame(), { timeout: 600 });
    } else {
      this._timerId = setTimeout(() => this._runFrame(), 500);
    }
  },

  async _runFrame() {
    if (!this._running || !this._pipeline || !this._video) return;
    if (this._inferring) { this._scheduleNext(); return; } // skip if busy

    this._inferring = true;
    try {
      const vW = this._video.videoWidth;
      const vH = this._video.videoHeight;
      if (!vW || !vH) { this._inferring = false; this._scheduleNext(); return; }

      // Draw to shared canvas at 320x240
      this._tmpCanvas.getContext("2d").drawImage(this._video, 0, 0, 320, 240);
      const dataURL = this._tmpCanvas.toDataURL("image/jpeg", 0.6);

      // Yield to browser before heavy WASM call
      await new Promise(r => setTimeout(r, 0));

      const results = await this._pipeline(dataURL, { threshold: 0.45 });

      // Draw boxes
      const ctx = this._canvas.getContext("2d");
      ctx.clearRect(0, 0, 320, 240);
      ctx.lineWidth = 1.5;
      ctx.font = "bold 11px monospace";

      results.forEach(({ label, score, box }) => {
        // yolos-tiny returns pixel coords relative to model input (416x416)
        // scale to our 320x240 canvas
        const scaleX = 320 / 416;
        const scaleY = 240 / 416;
        const x = box.xmin * scaleX;
        const y = box.ymin * scaleY;
        const w = (box.xmax - box.xmin) * scaleX;
        const h = (box.ymax - box.ymin) * scaleY;

        // Sci-fi corner brackets instead of full rectangle
        const cs = Math.min(w, h) * 0.22; // corner size
        ctx.strokeStyle = "#38bdf8";
        ctx.beginPath();
        // Top-left
        ctx.moveTo(x, y + cs); ctx.lineTo(x, y); ctx.lineTo(x + cs, y);
        // Top-right
        ctx.moveTo(x + w - cs, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cs);
        // Bottom-right
        ctx.moveTo(x + w, y + h - cs); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - cs, y + h);
        // Bottom-left
        ctx.moveTo(x + cs, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - cs);
        ctx.stroke();

        // Label
        const txt = `${label} ${(score * 100).toFixed(0)}%`;
        const tw  = ctx.measureText(txt).width + 6;
        ctx.fillStyle = "rgba(2,6,23,0.85)";
        ctx.fillRect(x, y - 16, tw, 16);
        ctx.fillStyle = "#38bdf8";
        ctx.fillText(txt, x + 3, y - 3);
      });

    } catch(e) {
      // Silent — inference errors are normal (blurry frames, etc)
      if (e.message && !e.message.includes("tensor")) {
        console.warn("[YOLO frame]", e.message);
      }
    }

    this._inferring = false;
    // Schedule next frame — 500ms gap minimum (2fps max)
    this._timerId = setTimeout(() => this._scheduleNext(), 500);
  },

  stop() {
    this._running  = false;
    yoloActive     = false;
    this._inferring = false;
    clearTimeout(this._timerId);
    if (window.cancelIdleCallback && this._idleId) window.cancelIdleCallback(this._idleId);
    this._pipeline = null;
    cameraStream?.getTracks().forEach(t => t.stop());
    cameraStream = null;
    this._container?.remove();
    this._container = null;
    this._video     = null;
    this._canvas    = null;
    this._tmpCanvas = null;
    Speech.speak("Object detection stopped.");
    _chat?.add("YOLO off.", "bot");
  },
};

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function _createVideoContainer(label, onClose) {
  const wrap = document.createElement("div");
  wrap.className = "vision-window";
  wrap.innerHTML = `
    <div class="vision-header">
      <span>${label}</span>
      <button class="vision-close">✕</button>
    </div>
    <video muted playsinline></video>`;
  wrap.querySelector(".vision-close").addEventListener("click", onClose);

  // Draggable
  const header = wrap.querySelector(".vision-header");
  header.addEventListener("mousedown", e => {
    e.preventDefault();
    const ox = e.clientX - wrap.offsetLeft;
    const oy = e.clientY - wrap.offsetTop;
    const onMove = e => { wrap.style.left = (e.clientX - ox) + "px"; wrap.style.top = (e.clientY - oy) + "px"; };
    const onUp   = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  return wrap;
}

function _loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
