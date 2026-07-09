// ui/videogen.js — Text-to-Video Generation
//
// ON SEEDANCE, SAID PLAINLY: Seedance is ByteDance's proprietary, closed
// model. It is not open-weight and does not run on Hugging Face's
// Inference Providers — the "Seedance" pages that turn up on Hugging Face
// are either research papers or third-party sites that just link out to
// paid platforms (seedance2.plus, seedancepro.com). That's not something
// safe to wire into Flow as if it were a real HF API, so this uses
// Hugging Face's actual, currently-served, genuinely free open-weight
// video models instead — same trustworthy foundation as ui/imagine.js's
// FLUX image generation.
//
// MODEL CHAIN (in order, falls through on failure exactly like FLUX does):
//   1. Wan-AI/Wan2.1-T2V-1.3B  — smaller/faster, good first try
//   2. Lightricks/LTX-Video    — real-time-capable, high quality
//
// REALISTIC EXPECTATIONS: video generation is far slower than image
// generation — anywhere from 30 seconds to a few minutes depending on
// server load, since these run on shared free-tier GPU capacity, not
// dedicated hardware. Flow tells you this upfront rather than looking
// frozen. If both models are cold/overloaded, it says so plainly instead
// of hanging silently.

import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;
let _hfToken = null;

export function initVideoGen(chat, orb) { _chat = chat; _orb = orb; }

async function getToken() {
  if (_hfToken) return _hfToken;
  const r    = await fetch("/api/mediapipe?action=token");
  const data = await r.json();
  if (!data.token) throw new Error(data.error || "HF_TOKEN not set in Vercel environment variables.");
  _hfToken = data.token;
  return _hfToken;
}

const VIDEO_MODELS = [
  { id: "Wan-AI/Wan2.1-T2V-1.3B", label: "Wan 2.1" },
  { id: "Lightricks/LTX-Video",   label: "LTX-Video" },
];

// ── Image-to-video model ────────────────────────────────────────────────
// Stable Video Diffusion — a real, HF-hosted, genuinely servable
// image-to-video model, unlike Wan2.2-I2V-A14B (checked directly:
// documented as needing 80GB VRAM minimum, not realistically free-tier
// servable). SVD is IMAGE-ONLY — per Stability's own model card, "the
// model cannot be controlled through text" — so this animates the given
// image with implicit motion, it does not follow a text prompt. That's a
// real, honest limitation, not a bug: true image+text-to-video isn't
// confirmed available on any free tier as of this integration.
const IMG2VIDEO_MODEL = "stabilityai/stable-video-diffusion-img2vid-xt";

async function callImageToVideoModel(imageBlob, token) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000);

  try {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${IMG2VIDEO_MODEL}`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  imageBlob.type || "image/png",
        "x-use-cache":   "false",
      },
      body: imageBlob, // raw image bytes, same pattern as Whisper's audio upload — this endpoint takes the image directly, not wrapped in JSON
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const ct = r.headers.get("content-type") || "";
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      if (r.status === 503 && err.estimated_time) {
        throw new Error(`Model is loading (cold start) — try again in about ${Math.ceil(err.estimated_time)}s`);
      }
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    if (!ct.startsWith("video/") && !ct.includes("octet-stream")) {
      const txt = await r.text();
      throw new Error(`Unexpected response: ${txt.slice(0, 100)}`);
    }
    return { blob: await r.blob(), contentType: ct };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("Timed out after 3 minutes — the model may be under heavy load right now.");
    throw e;
  }
}

// Public entry point for image-to-video — takes a File/Blob the user
// attached (e.g. via the existing file-upload UI), animates it.
export async function generateVideoFromImage(imageFile) {
  _chat?.add(
    `Animating your image into a short video clip...\n\nThis runs on free shared GPU capacity, so it can take anywhere from 30 seconds to a few minutes.`,
    "bot"
  );
  _orb?.setState("thinking");

  let token;
  try {
    token = await getToken();
  } catch (e) {
    _chat?.addError(e.message);
    _orb?.setState("idle");
    return;
  }

  try {
    const result = await callImageToVideoModel(imageFile, token);
    console.log(`[VideoGen] ✓ image-to-video — ${result.blob.size} bytes`);
    if (result.blob.size < 2000) throw new Error("Response too small — likely not a real video");
    _renderCard(URL.createObjectURL(result.blob), imageFile.name || "your image", "Stable Video Diffusion");
    Speech.speak("Your video's ready, Boss.");
    _orb?.setState("idle");
  } catch (e) {
    _chat?.addError(`Image-to-video failed: ${e.message} — free-tier video GPUs can be busy or cold, worth trying again in a minute.`);
    _orb?.setState("idle");
  }
}

async function callVideoModel(modelId, prompt, token) {
  // Video generation is slow — give it real room (3 minutes) rather than
  // hitting a default fetch timeout and reporting a false failure.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000);

  try {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
        "x-use-cache":   "false",
      },
      body: JSON.stringify({ inputs: prompt }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const ct = r.headers.get("content-type") || "";
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      // Free-tier models often need a "warm up" — Hugging Face returns a
      // 503 with an estimated_time while the model loads onto a GPU.
      // Surface that clearly instead of just failing.
      if (r.status === 503 && err.estimated_time) {
        throw new Error(`Model is loading (cold start) — try again in about ${Math.ceil(err.estimated_time)}s`);
      }
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    if (!ct.startsWith("video/") && !ct.includes("octet-stream")) {
      const txt = await r.text();
      throw new Error(`Unexpected response: ${txt.slice(0, 100)}`);
    }
    return { blob: await r.blob(), contentType: ct };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") throw new Error("Timed out after 3 minutes — the model may be under heavy load right now.");
    throw e;
  }
}

// ── Render the finished video as a card in chat ────────────────────────
function _renderCard(blobUrl, prompt, modelLabel) {
  const col = document.getElementById("col-left");
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = "mwrap mleft fresh img-card-wrap";

  const label = document.createElement("div");
  label.className = "mlabel";
  label.textContent = "FLOW";

  const card = document.createElement("div");
  card.className = "img-card";

  const video = document.createElement("video");
  video.src = blobUrl;
  video.controls = true;
  video.loop = true;
  video.style.cssText = "max-width:100%;border-radius:10px;display:block;";

  const meta = document.createElement("div");
  meta.className = "img-meta";
  meta.textContent = `${prompt.slice(0, 60)} · ${modelLabel}`;

  const dl = document.createElement("a");
  dl.className = "img-dl-btn";
  dl.textContent = "⬇ DOWNLOAD";
  dl.href = blobUrl;
  dl.download = `flow-video-${Date.now()}.mp4`;

  card.appendChild(video);
  card.appendChild(meta);
  card.appendChild(dl);
  wrap.appendChild(label);
  wrap.appendChild(card);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;
}

// ── Main entry point ─────────────────────────────────────────────────────
export async function generateVideo(promptText) {
  const cleanPrompt = promptText
    .replace(/\b(generate|create|make|produce)\b/gi, "")
    .replace(/\ban?\s+(video|clip|animation)\b/gi, "")
    .replace(/\b(of|showing|depicting)\b/gi, " ")
    .replace(/\s+/g, " ").trim() || promptText;

  _chat?.add(
    `Generating a short video — "${cleanPrompt}"...\n\nThis runs on free shared GPU capacity, so it can take anywhere from 30 seconds to a few minutes. I'll post it here the moment it's ready.`,
    "bot"
  );
  _orb?.setState("thinking");

  let token;
  try {
    token = await getToken();
  } catch (e) {
    _chat?.addError(e.message);
    _orb?.setState("idle");
    return;
  }

  for (const model of VIDEO_MODELS) {
    try {
      const result = await callVideoModel(model.id, cleanPrompt, token);
      console.log(`[VideoGen] ✓ ${model.id} — ${result.blob.size} bytes`);
      if (result.blob.size < 2000) throw new Error("Response too small — likely not a real video");
      _renderCard(URL.createObjectURL(result.blob), cleanPrompt, model.label);
      Speech.speak("Video's ready, Boss.");
      _orb?.setState("idle");
      return;
    } catch (e) {
      console.warn(`[VideoGen] ${model.id}: ${e.message}`);
    }
  }

  _chat?.addError("Video generation failed on all available models right now — free-tier video GPUs can be busy or cold. Worth trying again in a minute, or check HF_TOKEN is set in Vercel → Settings → Environment Variables.");
  _orb?.setState("idle");
}

// ── Parse video request from text ─────────────────────────────────────────
export function parseVideoRequest(text) {
  const gen = /\b(generate|create|make|produce)\b.{0,30}\b(video|clip|animation)\b/i;
  if (!gen.test(text)) return null;

  const prompt = text
    .replace(/\b(generate|create|make|produce)\b/gi, "")
    .replace(/\ban?\s+(video|clip|animation)\b/gi, "")
    .replace(/\b(of|showing|depicting)\b/gi, " ")
    .replace(/\s+/g, " ").trim();

  return { type: "generate", prompt: prompt || text };
}
