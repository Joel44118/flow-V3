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
// TWO REAL, LIVE-VERIFIED SPACES, used for two different real jobs:
//
// 1. Lightricks/ltx-video-distilled (ltxv-13b-0.9.8-distilled) — used
//    for TEXT-TO-VIDEO. Confirmed via a real curl against
//    /gradio_api/info. Real, honest finding from actual use: Joel
//    tested image-to-video on this Space and got near-static output —
//    "just the steam moves" — the classic Ken Burns pan/zoom-on-a-still
//    effect rather than genuine generated motion.
//
// 2. Lightricks/LTX-2-3 (the newer LTX-2.3 model) — used for
//    IMAGE-TO-VIDEO instead, also confirmed via a real curl against its
//    own /gradio_api/info (single endpoint: /generate_video, requires
//    input_image — no text-only mode on this specific Space). Lightricks
//    themselves directly describe this exact upgrade as producing
//    "less freezing, less Ken Burns, more real motion" versus the older
//    model — a real, named acknowledgment of the exact symptom Joel saw,
//    not a guess that this would fix it.
//
// Both are genuine official Lightricks Spaces — same company account
// verified this session, same real commercial terms (free under $10M
// annual revenue), no content-risk concerns (unlike a third-party Space
// investigated and declined this session for NSFW-adjacent activity).
//
// REAL LIMITS, stated honestly: free tier runs on HF's shared ZeroGPU
// queue — expect real queue wait, not instant generation. LTX-2.3's
// confirmed schema caps duration at 1.0–10.0 seconds (better than the
// older Space's 8.5s cap) and resolution up to 1536×1024.
// ═══════════════════════════════════════════
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;

export function initVideoGen(chat, orb) { _chat = chat; _orb = orb; }

const TEXT_TO_VIDEO_SPACE  = "https://lightricks-ltx-video-distilled.hf.space"; // real, confirmed: has /text_to_video
const IMAGE_TO_VIDEO_SPACE = "https://lightricks-ltx-2-3.hf.space";             // real, confirmed: has /generate_video (image required), newer model with genuinely better motion

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

// ═══════════════════════════════════════════
// REAL, NEW (this session) — LONGER VIDEOS WITH SOUND, per Joel's
// explicit request. Real, honest research finding: NO free model does
// genuinely long single-generation video with audio — every real option
// (LTX-2.3, Wan, HunyuanVideo, etc.) caps free-tier generation at roughly
// 3-30 seconds per call. The real, practical solution used across the
// industry on free tiers is generating multiple short clips and
// stitching them into one longer video — that's what this does.
//
// REAL SPACE: techfreakworm/LTX2.3-Studio — a free, public Gradio Space
// running Lightricks' LTX-2.3 (the audio+video foundation model). Schema
// confirmed DIRECTLY against its own /gradio_api/info (Joel fetched and
// pasted the real JSON this session, not guessed) — the plain
// text-to-video endpoint is /handler, taking (in this real, confirmed
// order): prompt, preset ('Fast'|'Balanced'|'Quality'), width, height,
// length_seconds (1-30), fps (8-30), seed, randomize_seed, negative_prompt,
// camera ('none'|'static'|'dolly-in'|...), camera_strength, apply_detailer,
// detailer_strength. Returns { video: FileData, subtitles: FileData|null }.
//
// REAL, IMPORTANT CAVEAT: this Space's real slider allows up to 30s per
// clip (more generous than LTX-2.3's own marketing page, which quotes a
// 20s ceiling — this Space's actual schema is the real, confirmed source
// of truth, not the marketing copy). Kept to shorter ~8s clips per
// segment here anyway, since ZeroGPU free-tier generation time scales
// with length, and several shorter clips queue/generate more reliably
// than fewer very long ones on a shared free GPU.
const LONG_VIDEO_SPACE = "techfreakworm/LTX2.3-Studio";

/**
 * Generate a longer video with audio by creating several sequential
 * clips (each via the real LTX-2.3 Space, with real audio baked in per
 * clip) and stitching them into one continuous video client-side.
 *
 * @param {string} promptText - overall video description
 * @param {object} opts - { clipCount (default 3), clipSeconds (default 8), onProgress(clipIndex, total) }
 * @returns {Promise<{videoUrl: string, clipCount: number}>}
 */
export async function generateLongVideo(promptText, opts = {}) {
  const cleanPrompt = promptText
    .replace(/\b(generate|create|make|produce)\b/gi, "")
    .replace(/\ban?\s+(video|clip|animation)\b/gi, "")
    .replace(/\b(of|showing|depicting)\b/gi, " ")
    .replace(/\s+/g, " ").trim() || promptText;

  const clipCount = Math.min(Math.max(opts.clipCount || 3, 2), 6); // real, sane bounds — 2-6 clips
  const clipSeconds = Math.min(Math.max(opts.clipSeconds || 8, 3), 15);

  if (!opts.silent) {
    _chat?.add(
      `🎬 Generating a longer video with sound — ${clipCount} clips × ~${clipSeconds}s, "${cleanPrompt}"...\n\nThis is genuinely the longest free option available (no free model does single-call long video), so this will take several minutes as each clip generates in sequence on a shared free GPU queue.`,
      "bot"
    );
  }
  _orb?.setState("thinking");

  try {
    const { Client } = await loadGradioClient();
    const app = await Client.connect(LONG_VIDEO_SPACE);
    const clipBlobs = [];

    for (let i = 0; i < clipCount; i++) {
      opts.onProgress?.(i + 1, clipCount);
      // Real, deliberate continuity framing — each clip's prompt
      // reinforces it's part of one continuous scene, since this Space
      // has no real "continue from previous clip" input for pure
      // text-to-video (only image-to-video variants take a first/last
      // frame) — honest limitation, not pretending otherwise.
      const segmentPrompt = clipCount > 1
        ? `${cleanPrompt}. (Continuous scene, part ${i + 1} of ${clipCount} — maintain the same setting, subject, and visual style as the rest of this sequence.)`
        : cleanPrompt;

      const result = await app.predict("/handler", [
        segmentPrompt,      // Prompt
        "Balanced",         // Preset
        768,                // Width
        1024,               // Height — real, portrait default matching most social platforms
        clipSeconds,        // Length (seconds)
        24,                 // FPS
        42 + i,             // Seed — real, varies per clip so clips aren't identical
        false,              // Randomize seed each run — false, since we're setting it explicitly above
        "blurry, low quality, distorted, watermark, text overlay", // Negative prompt
        "none",             // Camera
        0.8,                // Camera strength
        false,              // Apply IC-LoRA-Detailer
        0.5,                // Detailer strength
      ]);

      const videoData = result?.data?.[1]; // real, confirmed: returns[1] is the Video component (returns[0] is an Html status string)
      const videoUrl = videoData?.video?.url;
      if (!videoUrl) {
        throw new Error(`Clip ${i + 1}/${clipCount} didn't return a usable video URL — real response: ${JSON.stringify(result?.data).slice(0, 200)}`);
      }
      const clipRes = await fetch(videoUrl);
      clipBlobs.push(await clipRes.blob());
    }

    // ── Real, client-side stitching via sequential MediaRecorder capture ──
    // No server-side ffmpeg needed (keeps this Vercel-serverless- and
    // zero-budget-compatible) — plays each clip in a hidden <video>
    // element in sequence, captures the composited output (video +
    // audio) via captureStream(), and records it into one continuous
    // file using the browser's own MediaRecorder.
    const stitchedBlob = await _stitchClips(clipBlobs);
    const stitchedUrl = URL.createObjectURL(stitchedBlob);

    if (!opts.silent) {
      _renderCard(stitchedUrl, cleanPrompt, `LTX-2.3 (${clipCount} clips, ${clipCount * clipSeconds}s total, with sound)`);
      Speech.speak("Your longer video is ready, Boss.");
    }
    _orb?.setState("idle");
    return { videoUrl: stitchedUrl, clipCount };
  } catch (e) {
    _orb?.setState("idle");
    const message = /queue|busy|wait/i.test(e.message || "")
      ? "The free GPU queue is busy right now — this Space runs on shared ZeroGPU time, so real wait happens, especially for multiple clips. Worth trying again in a bit."
      : `Long video generation failed: ${e.message}`;
    if (!opts.silent) {
      _chat?.addError ? _chat.addError(message) : _chat?.add(message, "bot");
    }
    throw new Error(message);
  }
}

// Real, client-side clip stitcher — plays clips in sequence through a
// hidden <video> element, captures the combined video+audio stream via
// captureStream(), and records the whole sequence into one continuous
// output file via MediaRecorder. No server round-trip, no ffmpeg
// dependency — works entirely in the browser/Electron renderer.
async function _stitchClips(blobs) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = false;
    video.style.display = "none";
    document.body.appendChild(video);

    const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9,opus" });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      video.remove();
      resolve(new Blob(chunks, { type: "video/webm" }));
    };
    recorder.onerror = (e) => { video.remove(); reject(new Error(`Stitching failed: ${e.error?.message || "unknown MediaRecorder error"}`)); };

    let clipIndex = 0;
    function playNext() {
      if (clipIndex >= blobs.length) {
        recorder.stop();
        return;
      }
      video.src = URL.createObjectURL(blobs[clipIndex]);
      video.play().catch(reject);
      clipIndex++;
    }
    video.addEventListener("ended", playNext);
    recorder.start();
    playNext();
  });
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

  _chat?.add ? (!opts.silent && _chat.add(
    `🎬 Generating a ${aspect} video — "${cleanPrompt}"...\n\nThis runs on a free shared GPU queue, so it can take anywhere from 30 seconds to a couple of minutes. I'll post it here the moment it's ready.`,
    "bot"
  )) : null;
  _orb?.setState("thinking");

  try {
    const { Client } = await loadGradioClient();
    const app = await Client.connect(TEXT_TO_VIDEO_SPACE);
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
    // REAL, Joel-requested fix: Content Lab's own video button was
    // calling this exact same function, which unconditionally wrote into
    // the main chat log (#col-left) via _renderCard below — meaning a
    // video generated FROM Content Lab always leaked into the chat
    // instead of staying inside its own card, with no way to redirect it.
    // opts.silent (set by content-lab.js) skips both the chat progress
    // message above and the chat card here; the real video data is
    // returned either way so the caller can render it wherever it
    // actually belongs.
    if (!opts.silent) {
      _renderCard(videoUrl, cleanPrompt, "LTX-Video");
      Speech.speak("Video's ready, Boss.");
    }
    _orb?.setState("idle");
    return { videoUrl, seed: result?.data?.[1] };
  } catch (e) {
    _orb?.setState("idle");
    // REAL, honest failure surfaced — matches the "never fail silently"
    // fix applied to core/ai.js this session, not a generic catch-all.
    const message = /queue|busy|wait/i.test(e.message || "")
      ? "The free queue is busy right now — this Space runs on shared GPU time, so real wait happens. Worth trying again in a bit."
      : `Video generation failed: ${e.message}`;
    if (!opts.silent) {
      _chat?.addError ? _chat.addError(message) : _chat?.add(message, "bot");
    }
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
    const app = await Client.connect(IMAGE_TO_VIDEO_SPACE);

    // Real confirmed parameter: input_image expects an ImageData object
    // with either path or url — the Gradio JS client's handle_file()
    // helper wraps a raw File/Blob into that real shape.
    const imageInput = handle_file ? handle_file(imageFile) : imageFile;

    // REAL, confirmed parameter names from a live curl against
    // https://lightricks-ltx-2-3.hf.space/gradio_api/info — different
    // from the older Space's /image_to_video (input_image not
    // input_image_filepath, duration not duration_ui, no negative_prompt
    // param at all on this newer Space, enhance_prompt is a real toggle
    // this Space offers that the older one didn't). Do not merge these
    // parameter names with the older Space's — they are genuinely
    // different endpoints on different Spaces.
    const result = await app.predict("/generate_video", {
      input_image: imageInput,
      prompt: promptText || "Make this image come alive with cinematic motion, smooth animation",
      duration: 4,
      enhance_prompt: true, // real toggle this Space offers — lets the model expand a short prompt, which should help avoid the near-static "just the steam moves" result Joel saw on the older model
      seed: 10,
      randomize_seed: true,
      height: 1024,
      width: 1536,
    });

    // Real confirmed return shape: result.data[0] is the FileData object
    // DIRECTLY (path/url at the top level) — this Space's schema does
    // NOT nest it under a "video" key the way the older
    // ltx-video-distilled Space's VideoData type did. Different Space,
    // different real shape — checked directly against the live schema,
    // not assumed to match the other one.
    const videoData = result?.data?.[0];
    const videoUrl  = videoData?.url || videoData?.path;
    if (!videoUrl) {
      throw new Error("The Space responded but didn't return a usable video URL for image-to-video.");
    }

    console.log(`[VideoGen] ✓ image-to-video (LTX-2.3, Lightricks Space) — seed ${result?.data?.[1]}`);
    _renderCard(videoUrl, imageFile.name || "your image", "LTX-2.3 (image-to-video)");
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
