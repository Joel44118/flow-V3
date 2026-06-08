// ═══════════════════════════════════════════
// ui/vision.js — Flow's Eyes
//
// Three vision modes:
//   1. YOLO  — real-time object detection on camera feed (runs locally, free)
//   2. Camera — webcam frame → vision AI → Flow describes what he sees
//   3. Screen — screen capture → vision AI → Flow describes the screen
//
// Vision AI uses gpt-4o-mini (cheap vision model via OpenRouter)
// Flow's reply uses the normal model chain in api/chat.js
// ═══════════════════════════════════════════

import { Speech } from "../core/speech.js";

// ── DOM elements (injected by app.js) ────
let _chat    = null;
let _orb     = null;
let _sendMsg = null;  // AI.sendMessage — for vision-triggered replies

export function initVision(chat, orb, sendMsg) {
  _chat    = chat;
  _orb     = orb;
  _sendMsg = sendMsg;
}

// ── State ─────────────────────────────────
let cameraStream  = null;
let screenStream  = null;
let yoloActive    = false;
let yoloInterval  = null;
let visionOverlay = null;  // canvas drawn over video

// ─────────────────────────────────────────
//  SHARED: grab a frame from a video element
//  Returns base64 JPEG string
// ─────────────────────────────────────────
function captureFrame(videoEl, quality = 0.7) {
  const c = document.createElement("canvas");
  c.width  = videoEl.videoWidth  || 640;
  c.height = videoEl.videoHeight || 480;
  c.getContext("2d").drawImage(videoEl, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality).split(",")[1]; // base64 only
}

// ─────────────────────────────────────────
//  VISION API CALL
//  Sends a frame to gpt-4o-mini vision (cheap)
//  then passes description to Flow for reply
// ─────────────────────────────────────────
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
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width:640, height:480, facingMode:"user" }, audio:false
      });
      this._mount(cameraStream, "📷 CAMERA");
      Speech.speak("Camera online. I can see you now, Boss.");
      _chat?.add("Camera on. I can see you.", "bot");
    } catch(e) {
      _chat?.addError("Camera access denied: " + e.message);
    }
  },

  stop() {
    cameraStream?.getTracks().forEach(t => t.stop());
    cameraStream = null;
    this._unmount();
    Speech.speak("Camera off.");
  },

  async look(question) {
    if (!cameraStream || !this._video) {
      _chat?.addError("Camera is off. Say 'open camera' first.");
      return;
    }
    _orb?.setState("thinking");
    const frame = captureFrame(this._video);
    const prompt = question || "Describe exactly what you see in this image. Be specific and brief.";
    const desc = await describeFrame(frame, prompt);
    if (!desc) { _orb?.setState("idle"); return; }
    _chat?.add(desc, "bot");
    _orb?.setState("speaking");
    Speech.speak(desc, () => _orb?.setState("idle"));
  },

  _mount(stream, label) {
    this._container = _createVideoContainer(label, () => this.stop());
    this._video = this._container.querySelector("video");
    this._video.srcObject = stream;
    this._video.play();
    document.body.appendChild(this._container);
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
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: false
      });
      screenStream.getVideoTracks()[0].onended = () => this.stop();
      this._mount(screenStream, "🖥️ SCREEN");
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

  _mount(stream, label) {
    this._container = _createVideoContainer(label, () => this.stop());
    this._video = this._container.querySelector("video");
    this._video.srcObject = stream;
    this._video.play();
    document.body.appendChild(this._container);
  },

  _unmount() {
    this._container?.remove();
    this._container = null;
    this._video     = null;
  },
};

// ─────────────────────────────────────────
//  YOLO — Real-time object detection
//  Uses Transformers.js + onnx-community/yolov10m
//  Loads from HuggingFace CDN — no API key needed
//  No download required, runs in browser via WASM
// ─────────────────────────────────────────
export const YOLO = {
  _pipeline:  null,
  _canvas:    null,
  _video:     null,
  _container: null,
  _animId:    null,
  _running:   false,

  async start() {
    if (yoloActive) { this.stop(); return; }

    _chat?.add("Loading object detection model... this takes ~15 seconds the first time.", "bot");
    _orb?.setState("thinking");

    try {
      // Load Transformers.js from CDN
      if (!window._transformers) {
        await _loadScript("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js");
        window._transformers = window.transformers || window._transformers;
      }

      const { pipeline, env } = window.transformers || window._transformers ||
        await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js");

      // Allow remote models
      env.allowRemoteModels = true;

      _chat?.add("Model downloading... almost there.", "bot");

      // Xenova/yolos-small — higher accuracy, confirmed transformers.js compatible
      this._pipeline = await pipeline(
        "object-detection",
        "Xenova/yolos-small",
        {
          dtype: "fp32",
          device: "wasm",
        }
      );

      // Start camera
      if (!cameraStream) {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width:640, height:480 }, audio:false
        });
      }

      this._container = _createVideoContainer("🔍 YOLO DETECTION", () => this.stop());
      this._video  = this._container.querySelector("video");
      this._canvas = document.createElement("canvas");
      this._canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;";
      this._container.appendChild(this._canvas);
      this._video.srcObject = cameraStream;
      await this._video.play();
      document.body.appendChild(this._container);

      yoloActive    = true;
      this._running = true;
      _orb?.setState("idle");
      _chat?.add("YOLO active. I can identify objects in real time.", "bot");
      Speech.speak("Eyes online. Object detection active.");
      this._loop();

    } catch(e) {
      console.error("[YOLO]", e);
      _chat?.addError("YOLO failed: " + e.message);
      _orb?.setState("idle");
    }
  },

  async _loop() {
    if (!this._running || !this._pipeline || !this._video) return;

    try {
      const W = this._video.videoWidth;
      const H = this._video.videoHeight;
      if (W && H) {
        this._canvas.width  = W;
        this._canvas.height = H;
        const ctx = this._canvas.getContext("2d");
        ctx.clearRect(0, 0, W, H);

        // Downscale to 416x416 for faster processing (YOLO sweet spot)
        const tmp = document.createElement("canvas");
        tmp.width = 416; tmp.height = 416;
        tmp.getContext("2d").drawImage(this._video, 0, 0, 416, 416);
        const dataURL = tmp.toDataURL("image/jpeg", 0.65);

        // Run detection (non-blocking via setTimeout to prevent UI freeze)
        setTimeout(async () => {
          try {
            const results = await this._pipeline(dataURL, { threshold: 0.45 });

            ctx.lineWidth = 2;
            ctx.font = "bold 13px monospace";
            ctx.fillStyle = "rgba(2,6,23,0.8)";
            ctx.strokeStyle = "#38bdf8";

            results.forEach(det => {
              const { label, score, box } = det;
              if (!box) return;
              const { xmin, ymin, xmax, ymax } = box;

              // Scale from 416x416 back to actual dimensions
              const scaleX = W / 416;
              const scaleY = H / 416;
              const x  = xmin * scaleX;
              const y  = ymin * scaleY;
              const w  = (xmax - xmin) * scaleX;
              const h  = (ymax - ymin) * scaleY;

              ctx.strokeRect(x, y, w, h);

              const txt = `${label} ${(score*100).toFixed(0)}%`;
              const tw  = ctx.measureText(txt).width + 8;
              ctx.fillRect(x, y - 20, tw, 20);
              ctx.fillStyle = "#38bdf8";
              ctx.fillText(txt, x + 4, y - 5);
              ctx.fillStyle = "rgba(2,6,23,0.8)";
            });
          } catch(e) {
            console.error("[YOLO Detection Error]", e.message);
          }
        }, 0);
      }
    } catch(_) {}

    // Frame skip: detect every 2-3 frames only (~1-2 fps) to reduce lag
    // This gives ~1 detection per 1-2 seconds which is more responsive than 20s
    this._animId = setTimeout(() => this._loop(), 750);
  },

  stop() {
    this._running = false;
    yoloActive    = false;
    clearTimeout(this._animId);
    this._pipeline = null;
    cameraStream?.getTracks().forEach(t => t.stop());
    cameraStream = null;
    this._container?.remove();
    this._container = null;
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
    <video muted playsinline></video>
    <div class="vision-resize" style="position:absolute;bottom:0;right:0;width:20px;height:20px;cursor:nwse-resize;"></div>`;
  
  wrap.querySelector(".vision-close").addEventListener("click", onClose);

  // Make draggable and resizable
  let x = 0, y = 0, startX = 0, startY = 0;
  let resizing = false, dragX = 0, dragY = 0;
  
  const header = wrap.querySelector(".vision-header");
  const resizeHandle = wrap.querySelector(".vision-resize");
  
  // Drag to move
  header.addEventListener("mousedown", e => {
    if (e.target === wrap.querySelector(".vision-close")) return;
    e.preventDefault();
    dragX = e.clientX - wrap.offsetLeft;
    dragY = e.clientY - wrap.offsetTop;
    
    const onMove = e => {
      wrap.style.left = (e.clientX - dragX) + "px";
      wrap.style.top = (e.clientY - dragY) + "px";
      wrap.style.right = "auto";
    };
    const onEnd = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onEnd);
    };
    
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onEnd);
  });
  
  // Resize from corner
  resizeHandle?.addEventListener("mousedown", e => {
    e.preventDefault();
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    const startW = wrap.offsetWidth;
    const startH = wrap.offsetHeight;
    
    const onMove = e => {
      const newW = Math.max(200, startW + (e.clientX - startX));
      const newH = Math.max(150, startH + (e.clientY - startY));
      wrap.style.width = newW + "px";
      wrap.style.height = newH + "px";
    };
    const onEnd = () => {
      resizing = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onEnd);
    };
    
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onEnd);
  });
  
  // Position fixed windows properly
  wrap.style.position = "fixed";
  wrap.style.left = (60 + Math.random() * 100) + "px";
  wrap.style.top = (100 + Math.random() * 100) + "px";
  
  return wrap;
}

function _loadScript(src) {
  return new Promise((res,rej)=>{
    const s=document.createElement("script");
    s.src=src; s.onload=res; s.onerror=rej;
    document.head.appendChild(s);
  });
}

// COCO class labels for YOLOv8
const COCO_LABELS = [
  "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat",
  "traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat",
  "dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack",
  "umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball",
  "kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket",
  "bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple",
  "sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair",
  "couch","potted plant","bed","dining table","toilet","tv","laptop","mouse",
  "remote","keyboard","cell phone","microwave","oven","toaster","sink","refrigerator",
  "book","clock","vase","scissors","teddy bear","hair drier","toothbrush"
];
