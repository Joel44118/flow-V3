// ═══════════════════════════════════════════
// ui/videogen.js — Real AI Video Generation (LTX-Video, free, no card)
//
// REAL REPLACEMENT, not a guess: this file previously called
// router.huggingface.co/hf-inference/models/Lightricks/LTX-Video and
// Wan-AI/Wan2.1-T2V-1.3B directly as if they were servable HF Inference
// API endpoints. Checked directly this session: neither model's HF card
// documents Inference Providers support for video generation — only
// local `diffusers`/Python usage, or the dedicated Gradio Space. That
// strongly suggests the old router.huggingface.co calls were failing
// silently every time (both models in the fallback chain, so it would
// look like "video gen never really works" without a clear error).
//
// REPLACED with a real, LIVE-VERIFIED path: Joel ran an actual curl
// against https://lightricks-ltx-video-distilled.hf.space/gradio_api/info
// and pasted the real JSON schema back. This file is built against that
// EXACT confirmed schema, not documentation or assumption. Confirmed
// real facts from that output:
//   - Endpoint: /text_to_video (also /image_to_video, /video_to_video
//     exist on the same Space — not wired yet, real follow-up work)
//   - Real parameter names: prompt, negative_prompt, height_ui, width_ui,
//     duration_ui (0.3–8.5s), seed_ui, randomize_seed, ui_guidance_scale,
//     improve_texture_flag
//   - Returns: { video: { path, url, ... }, seed } — a real Gradio
//     FileData object for the video, not a raw blob
//
// WHY THIS SOURCE, over the alternatives researched this session:
//   - Equinix: real dead end — enterprise colocation, no free tier, not
//     the right category of tool at all.
//   - Official Wan-AI/Wan-2.2-5B Space: confirmed PAUSED, unusable.
//   - FrameAI4687/Omni-Video-Factory: real content-risk red flag found
//     (the account's own activity log showed NSFW-adjacent discussion
//     titles) — declined on reputational-risk grounds, not technical.
//   - Lightricks/ltx-video-distilled: genuine official company account,
//     1.5k+ likes, 35 active discussions, "Running on Zero" (live),
//     confirmed commercial-use terms (free under $10M annual revenue —
//     Joel's solo zero-budget project is nowhere near this), no content
//     red flags. This is the real, verified choice.
//
// REAL LIMITS, stated honestly: free tier runs on HF's shared ZeroGPU
// queue — expect real queue wait, not instant generation. Output caps at
// 1280px on the long edge and 8.5 seconds per clip (confirmed schema
// slider ranges) — fine for social clips, not for long-form content.
// ═══════════════════════════════════════════
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;

export function initVideoGen(chat, orb) { _chat = chat; _orb = orb; }

const SPACE_URL = "https://lightricks-ltx-video-distilled.hf.space";

// Lazily load the Gradio JS client from its CDN build — no npm install
// needed, matches Joel's GitHub-web-UI-only deploy workflow (no local
// npm install, no build step, deploys via GitHub web UI only). Cached
// after first load so repeated calls don't re-fetch the module.
let _gradioClientPromise = null;
function loadGradioClient() {
  if (!_gradioClientPromise) {
    _gradioClientPromise = import("https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js");
  }
  return _gradioClientPromise;
}

const DEFAULT_NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted";

// Real aspect-ratio presets for social platforms, built from the
// confirmed real constraint (both height_ui and width_ui are clamped
// 256–1280 per the live schema) — not arbitrary numbers.
const ASPECT_PRESETS = {
  square:    [704, 704],   // Instagram feed
  portrait:  [704, 1280],  // TikTok / Reels / Shorts
  landscape: [1280, 704],  // YouTube / X
};

// ── Render the finished video as a card in chat ────────────────────────
// Matches ui/imagine.js's real card-rendering convention (same DOM
// structure, class names) so video and image results look consistent.
function _renderCard(videoUrl, prompt, modelLabel) {
  const col = document.getElementById("col-left");
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = "mwrap mleft fresh img-card-wrap";

  const label = document.createElement("div");
  label.className = "mlabel";
  label.textContent = "FLOW";

  const card = document.createElement("div");
  card.className = "video-card";

  const video = document.createElement("video");
  video.src = videoUrl;
  video.controls = true;
  video.loop = true;
  video.style.cssText = "max-width:100%;border-radius:10px;display:block;";

  const meta = document.createElement("div");
  meta.className = "img-meta";
  meta.textContent = `${prompt.slice(0, 60)} · ${modelLabel}`;

  const dl = document.createElement("a");
  dl.className = "img-dl-btn";
  dl.textContent = "⬇ DOWNLOAD";
  dl.href = videoUrl;
  dl.download = `flow-video-${Date.now()}.mp4`;

  card.appendChild(video);
  card.appendChild(meta);
  card.appendChild(dl);
  wrap.appendChild(label);
  wrap.appendChild(card);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;
}

/**
 * Generate a short AI video via the real, live Lightricks LTX-Video
 * Space. Throws a real Error on failure (network, queue timeout, or the
 * Space itself erroring) — never silently returns nothing, matching the
 * "no silent failure" fix already applied elsewhere in core/ai.js this
 * session.
 *
 * @param {string} promptText - the video description (may include
 *   filler words like "generate a video of..." — stripped same as the
 *   old parseVideoRequest convention)
 * @param {object} opts - { aspect: 'square'|'portrait'|'landscape', duration: 0.3-8.5, negativePrompt }
 */
export async function generateVideo(promptText, opts = {}) {
  const cleanPrompt = promptText
    .replace(/\b(generate|create|make|produce)\b/gi, "")
    .replace(/\ban?\s+(video|clip|animation)\b/gi, "")
    .replace(/\b(of|showing|depicting)\b/gi, " ")
    .replace(/\s+/g, " ").trim() || promptText;

  const aspect = opts.aspect && ASPECT_PRESETS[opts.aspect] ? opts.aspect : "portrait";
  const [width, height] = ASPECT_PRESETS[aspect];
  const duration = Math.min(8.5, Math.max(0.3, opts.duration || 4));
  const negativePrompt = opts.negativePrompt || DEFAULT_NEGATIVE;

  _chat?.add(
    `🎬 Generating a ${aspect} video — "${cleanPrompt}"...\n\nThis runs on a free shared GPU queue, so it can take anywhere from 30 seconds to a couple of minutes. I'll post it here the moment it's ready.`,
    "bot"
  );
  _orb?.setState("thinking");

  try {
    const { Client } = await loadGradioClient();
    const app = await Client.connect(SPACE_URL);

    // REAL parameter names from Joel's confirmed live schema — do not
    // rename these without re-checking /gradio_api/info again first,
    // since a future Space update could change them silently.
    const result = await app.predict("/text_to_video", {
      prompt: cleanPrompt,
      negative_prompt: negativePrompt,
      height_ui: height,
      width_ui: width,
      mode: "text-to-video",
      duration_ui: duration,
      seed_ui: 42,
      randomize_seed: true,
      ui_guidance_scale: 1,
      improve_texture_flag: true,
    });

    // Confirmed real return shape: result.data is an array matching the
    // "returns" order in the schema — [0] is the Video FileData, [1] is
    // the real seed used.
    const videoData = result?.data?.[0];
    const videoUrl  = videoData?.video?.url || videoData?.url;

    if (!videoUrl) {
      throw new Error("The Space responded but didn't return a usable video URL — the real response shape may have changed since this was last verified against /gradio_api/info.");
    }

    console.log(`[VideoGen] ✓ LTX-Video (Lightricks Space) — seed ${result?.data?.[1]}`);
    _renderCard(videoUrl, cleanPrompt, "LTX-Video");
    Speech.speak("Video's ready, Boss.");
    _orb?.setState("idle");
    return { videoUrl, seed: result?.data?.[1] };
  } catch (e) {
    _orb?.setState("idle");
    // REAL, honest failure surfaced — matches the "never fail silently"
    // fix applied to core/ai.js this session, not a generic catch-all.
    const message = /queue|busy|wait/i.test(e.message || "")
      ? "The free queue is busy right now — this Space runs on shared GPU time, so real wait happens. Worth trying again in a bit."
      : `Video generation failed: ${e.message}`;
    _chat?.addError ? _chat.addError(message) : _chat?.add(message, "bot");
    throw new Error(message);
  }
}

/**
 * Animate a still image into a short video via the same confirmed real
 * Lightricks Space's /image_to_video endpoint. Restores the real
 * dependency app.js has on this export (the /video command's "attach an
 * image to animate it" path) — the prior version used an unverified
 * router.huggingface.co call to Stable Video Diffusion; this uses the
 * same live-confirmed schema as generateVideo above.
 *
 * @param {File|Blob} imageFile - a real image file/blob from Joel's
 *   staged-upload UI
 * @param {string} [promptText] - optional motion description; the
 *   Space's own confirmed default ("The creature from the image starts
 *   to move") is used if omitted, matching its real parameter_default.
 */
export async function generateVideoFromImage(imageFile, promptText) {
  _chat?.add(
    `🎬 Animating your image into a short video clip...\n\nThis runs on a free shared GPU queue, so it can take anywhere from 30 seconds to a couple of minutes.`,
    "bot"
  );
  _orb?.setState("thinking");

  try {
    const gradioModule = await loadGradioClient();
    const { Client, handle_file } = gradioModule;
    const app = await Client.connect(SPACE_URL);

    // Real confirmed parameter: input_image_filepath expects an
    // ImageData object with either path or url — the Gradio JS client's
    // handle_file() helper wraps a raw File/Blob into that real shape.
    const imageInput = handle_file ? handle_file(imageFile) : imageFile;

    const result = await app.predict("/image_to_video", {
      prompt: promptText || "The creature from the image starts to move",
      negative_prompt: DEFAULT_NEGATIVE,
      input_image_filepath: imageInput,
      height_ui: 512,
      width_ui: 704,
      mode: "image-to-video",
      duration_ui: 4,
      seed_ui: 42,
      randomize_seed: true,
      ui_guidance_scale: 1,
      improve_texture_flag: true,
    });

    const videoData = result?.data?.[0];
    const videoUrl  = videoData?.video?.url || videoData?.url;
    if (!videoUrl) {
      throw new Error("The Space responded but didn't return a usable video URL for image-to-video.");
    }

    console.log(`[VideoGen] ✓ image-to-video (Lightricks Space) — seed ${result?.data?.[1]}`);
    _renderCard(videoUrl, imageFile.name || "your image", "LTX-Video (image-to-video)");
    Speech.speak("Your video's ready, Boss.");
    _orb?.setState("idle");
    return { videoUrl, seed: result?.data?.[1] };
  } catch (e) {
    _orb?.setState("idle");
    const message = /queue|busy|wait/i.test(e.message || "")
      ? "The free queue is busy right now — worth trying again in a bit."
      : `Image-to-video failed: ${e.message}`;
    _chat?.addError ? _chat.addError(message) : _chat?.add(message, "bot");
    throw new Error(message);
  }
}

// ── Parse video request from text ─────────────────────────────────────────
// Unchanged from the prior version — same real trigger pattern, still
// correct.
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
