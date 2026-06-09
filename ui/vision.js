// ═══════════════════════════════════════════
// ui/vision.js — Flow's Eyes
//
// YOLO WEB WORKER FIX:
//   WASM inference moved to yolo-worker.js
//   Main thread NEVER blocks — zero UI freeze
//   Worker communicates via postMessage
//   OffscreenCanvas used for box drawing
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

let cameraStream = null;
let screenStream = null;
let yoloActive   = false;

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
  } catch (e) {
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
      getFaceRecog().then(fr => { if (fr.hasLearnedFace()) fr.startRecognition(this._video); }).catch(() => {});
    } catch (e) {
      _chat?.addError("Camera access denied: " + e.message);
    }
  },

  stop() {
    getFaceRecog().then(fr => fr.stopRecognition()).catch(() => {});
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
    } catch (e) {
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
//  WEB WORKER ARCHITECTURE:
//  - yolo-worker.js runs in a separate thread
//  - Main thread: captures frames, draws boxes
//  - Worker thread: runs WASM inference (heavy)
//  - No more UI freeze or "page unresponsive" warning
//  - Frames sent to worker at 2fps max
//  - Worker replies asynchronously with box coords
// ─────────────────────────────────────────
export const YOLO = {
  _worker:    null,
  _canvas:    null,
  _video:     null,
  _container: null,
  _frameTimer: null,
  _running:   false,
  _workerBusy: false, // prevents sending frames faster than worker responds

  async start() {
    if (yoloActive) { this.stop(); return; }

    if (cameraStream && !cameraStream.active) cameraStream = null;

    _chat?.add("Loading object detection model... first load takes ~20 seconds.", "bot");
    _orb?.setState("thinking");

    try {
      // Spawn Web Worker — all WASM inference runs there
      this._worker = new Worker("/yolo-worker.js", { type: "module" });

      // Wire up worker message handler
      this._worker.onmessage = (e) => this._onWorkerMsg(e.data);
      this._worker.onerror   = (e) => {
        _chat?.addError("YOLO worker error: " + e.message);
        _orb?.setState("idle");
      };

      // Tell worker to init the pipeline
      this._worker.postMessage({ type: "init" });

    } catch (e) {
      _chat?.addError("YOLO failed to start: " + e.message);
      _orb?.setState("idle");
    }
  },

  _onWorkerMsg(data) {
    switch (data.type) {
      case "progress":
        _chat?.add(data.message, "bot");
        break;

      case "ready":
        this._startCamera();
        break;

      case "result":
        this._workerBusy = false;
        this._drawBoxes(data.boxes);
        break;

      case "warn":
        console.warn("[YOLO Worker]", data.message);
        this._workerBusy = false;
        break;

      case "error":
        _chat?.addError("YOLO failed: " + data.message);
        _orb?.setState("idle");
        this.stop();
        break;
    }
  },

  async _startCamera() {
    try {
      cameraStream = await openCamera();

      this._container = _createVideoContainer("🔍 YOLO DETECTION", () => this.stop());
      this._video = this._container.querySelector("video");

      // Overlay canvas — same size as video (320x240)
      this._canvas = document.createElement("canvas");
      this._canvas.width  = 320;
      this._canvas.height = 240;
      this._canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;";
      this._container.appendChild(this._canvas);

      // Mount to DOM BEFORE setting srcObject
      document.body.appendChild(this._container);

      this._video.srcObject   = cameraStream;
      this._video.muted       = true;
      this._video.playsInline = true;
      await new Promise(r => { this._video.onloadedmetadata = r; setTimeout(r, 2000); });
      await this._video.play().catch(e => console.warn("[YOLO] play():", e.message));

      yoloActive    = true;
      this._running = true;
      _orb?.setState("idle");
      _chat?.add("YOLO active. Detecting objects — UI stays smooth.", "bot");
      Speech.speak("Eyes online. Object detection active.");

      // Start the 2fps capture loop
      this._frameTimer = setInterval(() => this._captureFrame(), 500);

    } catch (e) {
      _chat?.addError("YOLO camera failed: " + e.message);
      _orb?.setState("idle");
      this.stop();
    }
  },

  _captureFrame() {
    if (!this._running || !this._video || this._workerBusy) return;

    const vW = this._video.videoWidth;
    const vH = this._video.videoHeight;
    if (!vW || !vH) return;

    // Capture at 320x240 for performance
    const tmp = document.createElement("canvas");
    tmp.width  = 320;
    tmp.height = 240;
    tmp.getContext("2d").drawImage(this._video, 0, 0, 320, 240);
    const dataURL = tmp.toDataURL("image/jpeg", 0.6);

    // Send to worker — mark busy so we don't pile up frames
    this._workerBusy = true;
    this._worker.postMessage({ type: "detect", imageData: dataURL });
  },

  _drawBoxes(results) {
    if (!this._canvas || !results?.length) {
      // Clear canvas if no detections
      if (this._canvas) {
        this._canvas.getContext("2d").clearRect(0, 0, 320, 240);
      }
      return;
    }

    const ctx = this._canvas.getContext("2d");
    ctx.clearRect(0, 0, 320, 240);
    ctx.lineWidth = 1.5;
    ctx.font = "bold 11px monospace";

    results.forEach(({ label, score, box }) => {
      // yolos-tiny returns pixel coords relative to model input (416x416)
      // Scale to our 320x240 canvas
      const scaleX = 320 / 416;
      const scaleY = 240 / 416;
      const x = box.xmin * scaleX;
      const y = box.ymin * scaleY;
      const w = (box.xmax - box.xmin) * scaleX;
      const h = (box.ymax - box.ymin) * scaleY;

      // Sci-fi corner brackets
      const cs = Math.min(w, h) * 0.22;
      ctx.strokeStyle = "#38bdf8";
      ctx.beginPath();
      ctx.moveTo(x,       y + cs); ctx.lineTo(x,       y      ); ctx.lineTo(x + cs,   y      );
      ctx.moveTo(x+w-cs,  y      ); ctx.lineTo(x + w,   y      ); ctx.lineTo(x + w,    y + cs );
      ctx.moveTo(x + w,   y+h-cs ); ctx.lineTo(x + w,   y + h  ); ctx.lineTo(x+w-cs,   y + h  );
      ctx.moveTo(x + cs,  y + h  ); ctx.lineTo(x,       y + h  ); ctx.lineTo(x,        y+h-cs );
      ctx.stroke();

      // Label pill
      const txt = `${label} ${(score * 100).toFixed(0)}%`;
      const tw  = ctx.measureText(txt).width + 6;
      ctx.fillStyle = "rgba(2,6,23,0.85)";
      ctx.fillRect(x, y - 16, tw, 16);
      ctx.fillStyle = "#38bdf8";
      ctx.fillText(txt, x + 3, y - 3);
    });
  },

  stop() {
    this._running    = false;
    yoloActive       = false;
    this._workerBusy = false;
    clearInterval(this._frameTimer);
    this._frameTimer = null;

    // Terminate worker — kills the WASM thread entirely
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }

    cameraStream?.getTracks().forEach(t => t.stop());
    cameraStream = null;
    this._container?.remove();
    this._container = null;
    this._video     = null;
    this._canvas    = null;

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
    document.addEventListener("mouseup",   onUp);
  });
  return wrap;
}
