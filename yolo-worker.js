// ═══════════════════════════════════════════
// yolo-worker.js — Web Worker for YOLO inference
//
// This file runs in a SEPARATE THREAD.
// The main thread (UI) never freezes because
// all WASM inference happens here.
//
// Messages IN  (from main): { type: "init" } | { type: "detect", imageData }
// Messages OUT (to main):   { type: "ready" } | { type: "result", boxes } | { type: "error", message }
// ═══════════════════════════════════════════

let pipeline = null;

// Load Transformers.js inside the worker
importScripts("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js");

self.onmessage = async (event) => {
  const { type, imageData } = event.data;

  if (type === "init") {
    try {
      const { pipeline: createPipeline, env } = self.transformers;
      env.allowRemoteModels = true;

      // Post progress updates
      self.postMessage({ type: "progress", message: "Downloading YOLO model (~28MB)..." });

      pipeline = await createPipeline(
        "object-detection",
        "Xenova/yolos-tiny",
        {
          dtype:  "fp32",
          device: "wasm",
        }
      );

      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", message: e.message });
    }
    return;
  }

  if (type === "detect") {
    if (!pipeline) {
      self.postMessage({ type: "error", message: "Pipeline not initialised" });
      return;
    }
    try {
      // Run inference — blocks this worker thread, NOT the UI thread
      const results = await pipeline(imageData, { threshold: 0.45 });
      self.postMessage({ type: "result", boxes: results });
    } catch (e) {
      // Inference errors are normal (blurry frames etc) — suppress tensor errors
      if (!e.message?.includes("tensor")) {
        self.postMessage({ type: "warn", message: e.message });
      }
    }
    return;
  }
};
