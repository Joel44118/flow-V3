// ═══════════════════════════════════════════
// yolo-worker.js — COCO-SSD object detection worker
//
// Replaced: Xenova/yolos-tiny via transformers.js WASM
//   Problem: 28MB download, slow WASM inference, unreliable
//            in browsers, frequent "pipeline not ready" errors
//
// Now uses: TensorFlow.js + COCO-SSD
//   Why: ~5MB, pure JS (no WASM init), designed for real-time
//        browser use, detects 80 COCO classes, returns real
//        pixel coordinates directly (no manual scaling needed)
//
// Output boxes format: { label, score, bbox: [x,y,w,h] }
//   x,y = top-left corner in pixels (relative to input image)
//   w,h = width/height in pixels
// ═══════════════════════════════════════════

// TF.js + COCO-SSD loaded via importScripts (classic worker syntax)
// because CDN scripts need importScripts, not ES module import
importScripts(
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js"
);

let model = null;

self.onmessage = async (e) => {
  const { type, imageData } = e.data;

  if (type === "init") {
    try {
      self.postMessage({ type: "progress", message: "Loading COCO-SSD model (~5MB)..." });
      model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }
    return;
  }

  if (type === "detect") {
    if (!model) {
      self.postMessage({ type: "warn", message: "Model not ready yet" });
      return;
    }
    try {
      // Decode base64 dataURL → ImageBitmap for TF.js
      const res  = await fetch(imageData);
      const blob = await res.blob();
      const bmp  = await createImageBitmap(blob);

      const predictions = await model.detect(bmp);
      bmp.close();

      // Normalise to the same format vision.js _drawBoxes expects:
      // { label, score, bbox: [x, y, w, h] } — already pixel coords
      const boxes = predictions.map(p => ({
        label: p.class,
        score: p.score,
        bbox:  p.bbox, // [x, y, width, height]
      }));

      self.postMessage({ type: "result", boxes });
    } catch (err) {
      // Silently swallow transient tensor errors on empty/blurry frames
      self.postMessage({ type: "result", boxes: [] });
    }
    return;
  }
};
