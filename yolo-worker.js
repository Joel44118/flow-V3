// ═══════════════════════════════════════════
// yolo-worker.js — Module Worker for YOLO
//
// FIX: importScripts() fails for cross-origin
// scripts in many browsers/contexts.
// Using dynamic import() instead, which works
// correctly in module workers.
//
// Spawned with: new Worker('/yolo-worker.js', { type: 'module' })
// ═══════════════════════════════════════════

let pipeline = null;

self.onmessage = async (event) => {
  const { type, imageData } = event.data;

  if (type === "init") {
    try {
      self.postMessage({ type: "progress", message: "Loading YOLO engine..." });

      // Dynamic import works in module workers across origins
      const { pipeline: createPipeline, env } = await import(
        "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js"
      );

      env.allowRemoteModels  = true;
      env.allowLocalModels   = false;

      self.postMessage({ type: "progress", message: "Downloading YOLO model (~28MB), please wait..." });

      pipeline = await createPipeline(
        "object-detection",
        "Xenova/yolos-tiny",
        { dtype: "fp32", device: "wasm" }
      );

      self.postMessage({ type: "ready" });

    } catch (e) {
      self.postMessage({ type: "error", message: e.message });
    }
    return;
  }

  if (type === "detect") {
    if (!pipeline) {
      self.postMessage({ type: "error", message: "Pipeline not ready" });
      return;
    }
    try {
      const results = await pipeline(imageData, { threshold: 0.45 });
      self.postMessage({ type: "result", boxes: results });
    } catch (e) {
      if (!e.message?.includes("tensor")) {
        self.postMessage({ type: "warn", message: e.message });
      } else {
        // Tensor errors on blurry/empty frames are normal — just mark not busy
        self.postMessage({ type: "result", boxes: [] });
      }
    }
    return;
  }
};
