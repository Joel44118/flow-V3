// ═══════════════════════════════════════════
// ui/imagine.js — Browser-Direct Image Generation
//
// ROOT CAUSE OF 502 FIX:
//   api/imagine.js ran on Vercel (10s limit).
//   FLUX takes 15-30s → Vercel kills it → 502.
//
// FIX: Call HuggingFace DIRECTLY from the browser.
//   No Vercel function involved at all.
//   Browser waits as long as needed (no timeout).
//   HF_TOKEN is read from /api/token (safe — never
//   exposed in frontend code).
//
// MODELS (tried in order):
//   1. black-forest-labs/FLUX.1-schnell  (best quality)
//   2. stabilityai/stable-diffusion-xl-base-1.0  (reliable)
//   3. runwayml/stable-diffusion-v1-5  (always warm, fast)
// ═══════════════════════════════════════════
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;
let _hfToken = null;

export function initImagine(chat, orb) { _chat = chat; _orb = orb; }

// ── Fetch HF token from a safe server endpoint ──────────────────────────
async function getToken() {
  if (_hfToken) return _hfToken;
  try {
    const r    = await fetch("/api/token");
    const data = await r.json();
    if (data.token) { _hfToken = data.token; return _hfToken; }
    throw new Error("token not set");
  } catch (e) {
    throw new Error("HF_TOKEN not configured. Add it in Vercel → Settings → Environment Variables.");
  }
}

// ── Dimension presets (all multiples of 64 for FLUX) ────────────────────
const PRESETS = {
  square:    [1024, 1024], logo:      [512,  512],
  icon:      [512,  512],  portrait:  [768,  1280],
  tall:      [768,  1280], landscape: [1280, 768],
  wide:      [1280, 768],  wallpaper: [1920, 1088],
  banner:    [1536, 512],  header:    [1536, 512],
  instagram: [1024, 1024], twitter:   [1216, 704],
  thumbnail: [1280, 768],  poster:    [768,  1088],
};

function parseDimensions(text) {
  const t = text.toLowerCase();
  for (const [key, dims] of Object.entries(PRESETS)) {
    if (t.includes(key)) return dims;
  }
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

// ── Models to try ────────────────────────────────────────────────────────
const IMAGE_MODELS = [
  // HF router endpoints — always warm, no cold-start via router.huggingface.co
  { id: "black-forest-labs/FLUX.1-schnell",         steps: 4,  cfg: 0   },
  { id: "stabilityai/stable-diffusion-xl-base-1.0", steps: 20, cfg: 7.5 },
  { id: "runwayml/stable-diffusion-v1-5",           steps: 20, cfg: 7   },
];

// ── Call HF image API directly from browser ──────────────────────────────
async function callHF(modelId, prompt, width, height, steps, cfg, token) {
  const r = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "x-use-cache":   "false",
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { width, height, num_inference_steps: steps, guidance_scale: cfg },
    }),
  });

  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  if (!ct.startsWith("image/")) {
    const txt = await r.text();
    throw new Error(`Expected image, got: ${txt.slice(0, 80)}`);
  }

  return { blob: await r.blob(), contentType: ct };
}

// ── Main generate ────────────────────────────────────────────────────────
export async function generateImage(promptText, dimensionHint = "") {
  const combined = promptText + " " + dimensionHint;
  const [w, h]   = parseDimensions(combined);
  const modelPref = parseModel(combined);

  const cleanPrompt = promptText
    .replace(/\b(square|landscape|portrait|banner|wallpaper|poster|thumbnail|instagram|twitter|realistic|photo|canva|logo|icon|fast|turbo)\b/gi, "")
    .replace(/\d{3,4}\s*(?:x|by|×|\*)\s*\d{3,4}/g, "")
    .replace(/\s+/g, " ").trim();

  _chat?.add(`Generating ${w}×${h} image — "${cleanPrompt}"...`, "bot");
  _orb?.setState("thinking");

  let token;
  try {
    token = await getToken();
  } catch (e) {
    _chat?.addError(e.message);
    _orb?.setState("idle");
    return;
  }

  // Reorder models if realistic requested
  const models = modelPref === "realistic"
    ? [IMAGE_MODELS[1], IMAGE_MODELS[2], IMAGE_MODELS[0]]
    : IMAGE_MODELS;

  for (const model of models) {
    try {
      console.log(`[Imagine] Trying ${model.id}...`);
      const result  = await callHF(model.id, cleanPrompt, w, h, model.steps, model.cfg, token);
      console.log(`[Imagine] Got blob: ${result.blob.size} bytes, type: ${result.blob.type}`);
      if (result.blob.size < 500) throw new Error("Response too small — likely an error");
      const blobUrl = URL.createObjectURL(result.blob);
      _renderCard(blobUrl, cleanPrompt, w, h, model.id.split("/")[1]);
      Speech.speak(`Image ready, Boss.`);
      _orb?.setState("idle");
      return;
    } catch (e) {
      // No cold-start with HF router — all errors just try next model
      console.warn(`[Imagine] ${model.id}: ${e.message}`);
      console.warn(`[Imagine] ${model.id}: ${e.message}`);
    }
  }

  _chat?.addError("Image generation failed. Check that HF_TOKEN is set in Vercel → Settings → Environment Variables.");
  _orb?.setState("idle");
}

// ── Background removal ────────────────────────────────────────────────────
export async function removeBackground(base64Image) {
  _chat?.add("Removing background...", "bot");
  _orb?.setState("thinking");

  let token;
  try { token = await getToken(); }
  catch (e) { _chat?.addError(e.message); _orb?.setState("idle"); return; }

  try {
    const binary = Uint8Array.from(atob(base64Image), c => c.charCodeAt(0));
    const r = await fetch("https://api-inference.huggingface.co/models/briaai/RMBG-1.4", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "image/jpeg" },
      body:    binary,
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob    = await r.blob();
    const blobUrl = URL.createObjectURL(blob);
    _renderCard(blobUrl, "background-removed", null, null, "RMBG-1.4");
    Speech.speak("Background removed. Here's the result, Boss.");
    _orb?.setState("idle");
  } catch (e) {
    _chat?.addError("Background removal failed: " + e.message);
    _orb?.setState("idle");
  }
}

// ── Render image card in chat ─────────────────────────────────────────────
function _renderCard(blobUrl, prompt, w, h, modelName) {
  const col = document.getElementById("col-left");
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = "mwrap mleft fresh img-card-wrap";

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = "FLOW";

  const card = document.createElement("div");
  card.className = "img-card";

  const img    = document.createElement("img");
  img.src      = blobUrl;
  img.alt      = prompt;
  img.title    = "Click to open full size";
  img.style.cssText = "max-width:100%;border-radius:10px;display:block;cursor:pointer;";
  img.onclick  = () => window.open(blobUrl, "_blank");

  const meta = document.createElement("div");
  meta.className   = "img-meta";
  meta.textContent = w && h ? `${w}×${h} · ${modelName} · click to fullscreen`
                             : `${modelName} · click to fullscreen`;

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
  // Image cards stay visible permanently — don't fade out
}

// ── Parse image request ───────────────────────────────────────────────────
export function parseImageRequest(text) {
  const gen   = /\b(generate|create|make|draw|imagine|design|show me|produce)\b.{0,30}\b(image|picture|photo|illustration|artwork|logo|banner|poster|thumbnail|wallpaper|icon)\b/i;
  const noun  = /\b(image|picture|photo|logo|banner|poster|thumbnail|wallpaper)\b.{0,20}\b(of|for|showing|depicting)\b/i;
  const bgRm  = /\b(remove|strip)\b.{0,15}\b(background|bg)\b/i;

  if (bgRm.test(text)) return { type: "remove-bg" };
  if (!gen.test(text) && !noun.test(text)) return null;

  const prompt = text
    .replace(/\b(generate|create|make|draw|imagine|design|show me|produce)\b/gi, "")
    .replace(/\ban?\s+(image|picture|photo|illustration|artwork)\b/gi, "")
    .replace(/\b(of|for|showing|depicting)\b/gi, " ")
    .replace(/\s+/g, " ").trim();

  return { type: "generate", prompt: prompt || text };
}
