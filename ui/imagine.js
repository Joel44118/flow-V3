// ═══════════════════════════════════════════
// ui/imagine.js — Smart Image Generation
//
// TWO MODES (auto-detected from prompt):
//
//  DESIGN MODE — text, banners, promos, social posts
//    Uses: AI generates HTML/CSS → renders in hidden iframe
//          → html2canvas captures → blob download
//    Result: perfect text, custom fonts, exact layout
//    Triggers: "promotion", "banner", "text on", "quote",
//              "social post", "poster with text", "logo"
//
//  PHOTO/ART MODE — scenes, people, objects, landscapes
//    Uses: HuggingFace FLUX.1-schnell via router (no cold-start)
//    Result: photorealistic or artistic image
//    Triggers: everything else
// ═══════════════════════════════════════════
import { Speech } from "../core/speech.js";

let _chat    = null;
let _orb     = null;
let _hfToken = null;

export function initImagine(chat, orb) { _chat = chat; _orb = orb; }

// ── Token fetch (cached) ─────────────────────────────────────────────────
// NOTE: this used to call /api/token, which doesn't exist anywhere in the
// repo — meaning this has likely been silently 404ing this whole time.
// The token route now lives on the existing api/mediapipe.js edge function
// (same pattern as api/social.js and api/tts.js routing by query param) —
// no new file added, since Vercel Hobby's 12-function limit is already at
// capacity.
export async function getToken() {
  if (_hfToken) return _hfToken;
  const r    = await fetch("/api/mediapipe?action=token");
  const data = await r.json();
  if (!data.token) throw new Error(data.error || "HF_TOKEN not set in Vercel environment variables.");
  _hfToken = data.token;
  return _hfToken;
}

// ── Dimension presets (multiples of 64 for FLUX) ────────────────────────
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

// ── Detect if this is a DESIGN request (needs text/layout) or PHOTO ──────
function isDesignRequest(text) {
  const t = text.toLowerCase();
  return /\b(promotion|promo|promotional|banner|social\s+post|twitter\s+post|instagram\s+post|facebook\s+post|poster\s+with|text\s+on|quote|slogan|headline|typography|graphic\s+design|flyer|ad\s+|advertisement|branding|minimalist\s+design|centered\s+(text|design)|put.{0,20}text|write.{0,20}on|add.{0,20}text)\b/.test(t);
}

// ── HuggingFace FLUX (photo/art mode) ───────────────────────────────────
export const FLUX_MODELS = [
  { id: "black-forest-labs/FLUX.1-schnell",         steps: 4,  cfg: 0   },
  { id: "stabilityai/stable-diffusion-xl-base-1.0", steps: 20, cfg: 7.5 },
  { id: "runwayml/stable-diffusion-v1-5",           steps: 20, cfg: 7   },
];

export async function callFlux(modelId, prompt, width, height, steps, cfg, token) {
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
    throw new Error(`Unexpected response: ${txt.slice(0, 80)}`);
  }
  return { blob: await r.blob(), contentType: ct };
}

// ── HTML Design Generator (design mode) ──────────────────────────────────
// Asks the AI to write a self-contained HTML design,
// renders it in a hidden iframe, captures with html2canvas
async function generateDesign(promptText, width, height) {
  _chat?.add(`Designing ${width}×${height} graphic...`, "bot");
  _orb?.setState("thinking");

  // Ask the AI (via /api/chat) to write the HTML design
  const systemPrompt = `You are a graphic designer who writes self-contained HTML/CSS.
Write ONLY the complete HTML code for a ${width}×${height}px graphic.
Rules:
- Single HTML file, no external dependencies except Google Fonts
- Use inline CSS only, body margin:0, overflow:hidden
- The root div must be exactly ${width}px wide and ${height}px tall
- Use web-safe or Google Fonts for text
- Make it visually stunning — gradients, shadows, modern typography
- NO JavaScript needed
- Reply with ONLY the HTML code, nothing else, no markdown fences`;

  const userPrompt = `Design a ${width}×${height}px graphic: ${promptText}`;

  try {
    const res = await fetch("/api/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.reply) throw new Error(data.error || "Design generation failed");

    // Clean the HTML (strip any markdown fences the model adds)
    let html = data.reply
      .replace(/^```html?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    if (!html.includes("<html") && !html.includes("<div")) {
      throw new Error("Model didn't return valid HTML");
    }

    // Render in hidden iframe → capture with html2canvas → blob
    const blobUrl = await renderHtmlToImage(html, width, height);
    _renderCard(blobUrl, promptText, width, height, "AI Design");
    Speech.speak("Design ready, Boss.");
    _orb?.setState("idle");

  } catch (e) {
    console.error("[Design]", e.message);
    _chat?.addError("Design failed: " + e.message);
    _orb?.setState("idle");
  }
}

// ── Render HTML to image using hidden iframe + html2canvas ───────────────
function renderHtmlToImage(html, width, height) {
  return new Promise(async (resolve, reject) => {
    // Load html2canvas from CDN if not already loaded
    if (!window.html2canvas) {
      await new Promise((res, rej) => {
        const s   = document.createElement("script");
        s.src     = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        s.onload  = res;
        s.onerror = () => rej(new Error("html2canvas CDN failed to load"));
        document.head.appendChild(s);
      });
    }

    // Create hidden iframe
    const iframe = document.createElement("iframe");
    iframe.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${width}px;height:${height}px;border:none;visibility:hidden;`;
    document.body.appendChild(iframe);

    // Write HTML into iframe
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();

    // Wait for fonts/images to load
    setTimeout(async () => {
      try {
        const canvas = await window.html2canvas(iframe.contentDocument.body, {
          width,
          height,
          scale:           1,
          useCORS:         true,
          allowTaint:      true,
          backgroundColor: null,
          windowWidth:     width,
          windowHeight:    height,
        });

        canvas.toBlob(blob => {
          document.body.removeChild(iframe);
          if (!blob) { reject(new Error("Canvas capture failed")); return; }
          resolve(URL.createObjectURL(blob));
        }, "image/png");

      } catch (e) {
        document.body.removeChild(iframe);
        reject(e);
      }
    }, 1200); // wait for Google Fonts etc
  });
}

// ── Main entry point ─────────────────────────────────────────────────────
export async function generateImage(promptText, dimensionHint = "") {
  const combined = promptText + " " + dimensionHint;
  const [w, h]   = parseDimensions(combined);

  // Clean prompt
  const cleanPrompt = promptText
    .replace(/\b(square|landscape|portrait|banner|wallpaper|poster|thumbnail|instagram|twitter|realistic|photo|canva|logo|icon|fast|turbo)\b/gi, "")
    .replace(/\d{3,4}\s*(?:x|by|×|\*)\s*\d{3,4}/g, "")
    .replace(/\s+/g, " ").trim();

  // Route to design mode or photo mode
  if (isDesignRequest(combined)) {
    await generateDesign(cleanPrompt || promptText, w, h);
    return;
  }

  // Photo/art mode — REAL FIX: the old HF FLUX chain (FLUX.1-schnell,
  // SDXL, SD 1.5) is confirmed fully dead — all three return real,
  // live 410/400 errors from HuggingFace's hf-inference provider, which
  // has deprecated them there. Real replacement: the same NVIDIA NIM
  // image route already built and fixed for Content Lab
  // (api/mediapipe.js's real, confirmed-working handleNvidiaImage),
  // reused here instead of a second, duplicate implementation.
  _chat?.add(`Generating ${w}×${h} image — "${cleanPrompt}"...`, "bot");
  _orb?.setState("thinking");

  try {
    const res = await fetch("/api/mediapipe?action=image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: cleanPrompt }),
    });
    const data = await res.json();
    if (!res.ok || (!data.b64_json && !data.imageUrl)) {
      throw new Error(data.error || "No real image data returned");
    }
    let blob;
    if (data.b64_json) {
      const byteChars = atob(data.b64_json);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      blob = new Blob([new Uint8Array(byteNumbers)], { type: "image/png" });
    } else {
      const imgRes = await fetch(data.imageUrl);
      blob = await imgRes.blob();
    }
    console.log(`[Imagine] ✓ ${data.modelUsed} — ${blob.size} bytes`);
    _renderCard(URL.createObjectURL(blob), cleanPrompt, w, h, data.modelUsed?.split("/")[1] || "nvidia");
    Speech.speak("Image ready, Boss.");
    _orb?.setState("idle");
    return;
  } catch (e) {
    console.warn(`[Imagine] NVIDIA image generation failed: ${e.message}`);
  }

  _chat?.addError("Image generation failed. Check NVIDIA_API_KEY is set in Vercel → Settings → Environment Variables.");
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
    const r      = await fetch("https://api-inference.huggingface.co/models/briaai/RMBG-1.4", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "image/jpeg" },
      body:    binary,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blobUrl = URL.createObjectURL(await r.blob());
    _renderCard(blobUrl, "background-removed", null, null, "RMBG");
    Speech.speak("Background removed, Boss.");
    _orb?.setState("idle");
  } catch (e) {
    _chat?.addError("Background removal failed: " + e.message);
    _orb?.setState("idle");
  }
}

// ── Render card in chat ───────────────────────────────────────────────────
function _renderCard(blobUrl, prompt, w, h, modelName) {
  const col = document.getElementById("col-left");
  if (!col) return;

  const wrap  = document.createElement("div");
  wrap.className = "mwrap mleft fresh img-card-wrap";

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = "FLOW";

  const card  = document.createElement("div");
  card.className = "img-card";

  const img   = document.createElement("img");
  img.src     = blobUrl;
  img.alt     = prompt;
  img.title   = "Click to fullscreen";
  img.style.cssText = "max-width:100%;border-radius:10px;display:block;cursor:pointer;";
  img.onclick = () => window.open(blobUrl, "_blank");

  const meta  = document.createElement("div");
  meta.className   = "img-meta";
  meta.textContent = w && h ? `${w}×${h} · ${modelName}` : modelName;

  const dl    = document.createElement("a");
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
  // Image cards never fade out
}

// ── Parse image request from text ─────────────────────────────────────────
export function parseImageRequest(text) {
  const gen  = /\b(generate|create|make|draw|imagine|design|show me|produce)\b.{0,30}\b(image|picture|photo|illustration|artwork|logo|banner|poster|thumbnail|wallpaper|icon|graphic|flyer|ad)\b/i;
  const noun = /\b(image|picture|photo|logo|banner|poster|thumbnail|wallpaper|graphic|flyer)\b.{0,20}\b(of|for|showing|depicting|with|that)\b/i;
  const bgRm = /\b(remove|strip)\b.{0,15}\b(background|bg)\b/i;

  if (bgRm.test(text)) return { type: "remove-bg" };
  if (!gen.test(text) && !noun.test(text)) return null;

  const prompt = text
    .replace(/\b(generate|create|make|draw|imagine|design|show me|produce)\b/gi, "")
    .replace(/\ban?\s+(image|picture|photo|illustration|artwork|graphic)\b/gi, "")
    .replace(/\b(of|for|showing|depicting)\b/gi, " ")
    .replace(/\s+/g, " ").trim();

  return { type: "generate", prompt: prompt || text };
}
