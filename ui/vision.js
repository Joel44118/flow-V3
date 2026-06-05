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
//  Uses YOLOv8n ONNX model via onnxruntime-web
//  Model loads from CDN — no download needed
// ─────────────────────────────────────────
export const YOLO = {
  _session:   null,
  _canvas:    null,
  _video:     null,
  _container: null,
  _animId:    null,
  _labels:    null,

  async start() {
    if (yoloActive) { this.stop(); return; }

    // Load ONNX Runtime from CDN
    if (!window.ort) {
      await _loadScript("https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.17.1/ort.min.js");
    }

    _chat?.add("Loading YOLO model... one moment.", "bot");
    _orb?.setState("thinking");

    try {
      // YOLOv8n — smallest, fastest, free from HuggingFace
      // ~6MB download, runs in-browser on CPU
      this._session = await window.ort.InferenceSession.create(
        "https://huggingface.co/nickmuchi/yolos-small-onnx/resolve/main/yolos-small.onnx",
        { executionProviders: ["wasm"] }
      );

      this._labels = COCO_LABELS;

      // Start camera for YOLO feed
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

      yoloActive = true;
      _orb?.setState("idle");
      _chat?.add("YOLO active. I can identify objects in real time.", "bot");
      Speech.speak("Eyes online. Object detection active.");
      this._loop();

    } catch(e) {
      console.error("[YOLO]", e);
      _chat?.addError("YOLO failed to load: " + e.message);
      _orb?.setState("idle");
    }
  },

  _loop() {
    if (!yoloActive) return;
    this._detect().finally(() => {
      this._animId = requestAnimationFrame(() => this._loop());
    });
  },

  async _detect() {
    if (!this._session || !this._video || this._video.readyState < 2) return;

    const W = this._video.videoWidth;
    const H = this._video.videoHeight;
    if (!W || !H) return;

    // Resize canvas to match video
    this._canvas.width  = W;
    this._canvas.height = H;
    const ctx = this._canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    try {
      // Prep input tensor 640×640
      const size = 640;
      const tmp  = document.createElement("canvas");
      tmp.width = tmp.height = size;
      tmp.getContext("2d").drawImage(this._video, 0, 0, size, size);
      const imgData = tmp.getContext("2d").getImageData(0, 0, size, size);

      // Convert to float32 CHW tensor
      const data = new Float32Array(3 * size * size);
      for (let i = 0; i < size * size; i++) {
        data[i]               = imgData.data[i*4]   / 255;
        data[i + size*size]   = imgData.data[i*4+1] / 255;
        data[i + size*size*2] = imgData.data[i*4+2] / 255;
      }

      const tensor = new window.ort.Tensor("float32", data, [1, 3, size, size]);
      const output = await this._session.run({ images: tensor });

      // Parse detections
      const boxes  = output[Object.keys(output)[0]].data;
      const scaleX = W / size, scaleY = H / size;

      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth   = 2;
      ctx.font        = "bold 13px monospace";
      ctx.fillStyle   = "#38bdf8";

      for (let i = 0; i < boxes.length; i += 6) {
        const conf  = boxes[i+4];
        if (conf < 0.45) continue;
        const cls   = Math.round(boxes[i+5]);
        const label = this._labels[cls] || `class${cls}`;
        const x1 = boxes[i]   * scaleX;
        const y1 = boxes[i+1] * scaleY;
        const x2 = boxes[i+2] * scaleX;
        const y2 = boxes[i+3] * scaleY;

        // Draw box
        ctx.strokeRect(x1, y1, x2-x1, y2-y1);
        // Label background
        ctx.fillStyle = "rgba(2,6,23,0.75)";
        ctx.fillRect(x1, y1-18, ctx.measureText(label).width+8, 18);
        ctx.fillStyle = "#38bdf8";
        ctx.fillText(`${label} ${(conf*100).toFixed(0)}%`, x1+4, y1-4);
      }

    } catch(e) {
      // Silent — detection errors are normal mid-stream
    }
  },

  stop() {
    yoloActive = false;
    if (this._animId) cancelAnimationFrame(this._animId);
    this._session = null;
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
    <video muted playsinline></video>`;
  wrap.querySelector(".vision-close").addEventListener("click", onClose);

  // Draggable
  let dx=0,dy=0,x=0,y=0;
  const header = wrap.querySelector(".vision-header");
  header.addEventListener("mousedown", e => {
    e.preventDefault();
    x=e.clientX-wrap.offsetLeft; y=e.clientY-wrap.offsetTop;
    document.onmousemove = e => { wrap.style.left=(e.clientX-x)+"px"; wrap.style.top=(e.clientY-y)+"px"; };
    document.onmouseup  = () => { document.onmousemove=null; document.onmouseup=null; };
  });
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