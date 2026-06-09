// ═══════════════════════════════════════════
// ui/imagine.js — Image Generation UI
//
// Works entirely with HuggingFace binary responses.
// No Pollinations, no redirect URLs.
//
// FEATURES:
//   - Text-to-image (FLUX.1-schnell → SDXL fallback)
//   - Background removal (say "remove background from this image")
//   - Custom dimensions via natural language
//   - Real download button (blob URL, no redirects)
//   - Inline preview with click-to-fullscreen
//   - "Model warming up" retry message
// ═══════════════════════════════════════════
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;
export function initImagine(chat, orb) { _chat = chat; _orb = orb; }

// ── Dimension presets ────────────────────────────────────────────────────
const PRESETS = {
  square:    [1024, 1024],
  landscape: [1280, 768],
  wide:      [1280, 768],
  portrait:  [768,  1280],
  tall:      [768,  1280],
  banner:    [1536, 512],
  header:    [1536, 512],
  wallpaper: [1920, 1088],  // nearest 64-multiple to 1920x1080
  instagram: [1024, 1024],
  twitter:   [1216, 704],
  thumbnail: [1280, 768],
  poster:    [768,  1088],
  logo:      [512,  512],
  icon:      [512,  512],
};

function parseDimensions(text) {
  const t = text.toLowerCase();
  for (const [key, dims] of Object.entries(PRESETS)) {
    if (t.includes(key)) return dims;
  }
  // Custom e.g. "1920x1080" or "1920 by 1080"
  const m = t.match(/(\d{3,4})\s*(?:x|by|×|\*)\s*(\d{3,4})/);
  if (m) {
    const w = Math.round(parseInt(m[1]) / 64) * 64;
    const h = Math.round(parseInt(m[2]) / 64) * 64;
    return [Math.min(w, 1440), Math.min(h, 1440)];
  }
  return [1024, 1024];
}

function parseModel(text) {
  const t = text.toLowerCase();
  if (/\brealistic\b|\bphoto\b|\bphotograph\b/.test(t)) return "realistic";
  return "flux";
}

// ── Generate image from text prompt ──────────────────────────────────────
export async function generateImage(promptText, dimensionHint = "") {
  const combined = promptText + " " + dimensionHint;
  const [w, h]   = parseDimensions(combined);
  const model    = parseModel(combined);

  // Clean prompt — remove dimension/style keywords
  const cleanPrompt = promptText
    .replace(/\b(square|landscape|portrait|banner|wallpaper|poster|thumbnail|instagram|twitter|realistic|photo|canva|logo|icon|fast|turbo)\b/gi, "")
    .replace(/\d{3,4}\s*(?:x|by|×|\*)\s*\d{3,4}/g, "")
    .replace(/\s+/g, " ")
    .trim();

  _chat?.add(`Generating ${w}×${h} image — "${cleanPrompt}"...`, "bot");
  _orb?.setState("thinking");

  try {
    const url = `/api/imagine?prompt=${encodeURIComponent(cleanPrompt)}&w=${w}&h=${h}&model=${model}`;
    const res  = await fetch(url);
    const ct   = res.headers.get("content-type") || "";

    if (!res.ok || !ct.startsWith("image/")) {
      const data = await res.json().catch(() => ({}));

      // Model warming up — give user a clear message
      if (data.loading) {
        _chat?.add(`${data.error} Say "generate image of ${cleanPrompt}" again when ready.`, "bot");
        Speech.speak(`The image model is warming up. Try again in about ${data.error.match(/\d+/)?.[0] || 20} seconds.`);
        _orb?.setState("idle");
        return;
      }

      throw new Error(data.error || `Server error ${res.status}`);
    }

    // Got actual image binary back
    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const usedModel = res.headers.get("x-model-used") || "FLUX";

    _renderCard(blobUrl, cleanPrompt, w, h, usedModel);
    Speech.speak(`Here's your ${w} by ${h} image, Boss.`);
    _orb?.setState("idle");

  } catch (e) {
    _chat?.addError("Image generation failed: " + e.message);
    _orb?.setState("idle");
  }
}

// ── Remove background from uploaded image ────────────────────────────────
export async function removeBackground(base64Image) {
  _chat?.add("Removing background...", "bot");
  _orb?.setState("thinking");

  try {
    const res = await fetch("/api/imagine", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ mode: "remove-bg", imageBase64: base64Image }),
    });

    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.startsWith("image/")) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error ${res.status}`);
    }

    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);

    _renderCard(blobUrl, "background-removed", null, null, "BRIA-RMBG");
    Speech.speak("Background removed. Here's the result.");
    _orb?.setState("idle");

  } catch (e) {
    _chat?.addError("Background removal failed: " + e.message);
    _orb?.setState("idle");
  }
}

// ── Render image card in chat ─────────────────────────────────────────────
function _renderCard(blobUrl, prompt, w, h, modelUsed) {
  const col = document.getElementById("col-left");
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = "mwrap mleft fresh";

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = "FLOW";

  const card = document.createElement("div");
  card.className = "img-card";

  // Image
  const img   = document.createElement("img");
  img.src      = blobUrl;
  img.alt      = prompt;
  img.title    = "Click to open full size";
  img.style.cssText = "max-width:100%;border-radius:10px;display:block;cursor:pointer;";
  img.onclick  = () => window.open(blobUrl, "_blank");

  // Meta
  const meta = document.createElement("div");
  meta.className   = "img-meta";
  meta.textContent = w && h
    ? `${w}×${h} · ${modelUsed} · click to fullscreen`
    : `${modelUsed} · click to fullscreen`;

  // Download — blob URL means this is a real direct download
  const dl = document.createElement("a");
  dl.className   = "img-dl-btn";
  dl.textContent = "⬇ DOWNLOAD";
  dl.href        = blobUrl;
  dl.download    = `flow-${Date.now()}.png`;

  card.appendChild(img);
  card.appendChild(meta);
  card.appendChild(dl);
  wrap.appendChild(label);
  wrap.appendChild(card);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;

  // Keep visible for 15s (images need reading time)
  setTimeout(() => wrap.classList.remove("fresh"), 15000);
}

// ── Parse image request trigger from text ─────────────────────────────────
export function parseImageRequest(text) {
  const genPattern = /\b(generate|create|make|draw|imagine|design|show me|produce)\b.{0,30}\b(image|picture|photo|illustration|artwork|logo|banner|poster|thumbnail|wallpaper|icon)\b/i;
  const nounFirst  = /\b(image|picture|photo|logo|banner|poster|thumbnail|wallpaper)\b.{0,20}\b(of|for|showing|depicting)\b/i;
  const bgRemove   = /\b(remove|strip)\b.{0,15}\b(background|bg)\b/i;

  if (bgRemove.test(text)) return { type: "remove-bg" };
  if (!genPattern.test(text) && !nounFirst.test(text)) return null;

  const prompt = text
    .replace(/\b(generate|create|make|draw|imagine|design|show me|produce)\b/gi, "")
    .replace(/\ban?\s+(image|picture|photo|illustration|artwork)\b/gi, "")
    .replace(/\b(of|for|showing|depicting|in the style of)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { type: "generate", prompt: prompt || text };
}
