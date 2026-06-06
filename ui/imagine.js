// ═══════════════════════════════════════════
// ui/imagine.js — Image generation UI
// ═══════════════════════════════════════════
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;

export function initImagine(chat, orb) {
  _chat = chat;
  _orb  = orb;
}

// ── Parse dimension strings ───────────────
// "1920x1080", "1024 by 768", "square", "landscape", "portrait", "banner"
function parseDimensions(text) {
  const t = text.toLowerCase();

  // Presets
  if (/\bsquare\b/.test(t))                         return [1024, 1024];
  if (/\blandscape\b|\bwide\b/.test(t))             return [1280, 720];
  if (/\bportrait\b|\btall\b/.test(t))              return [720, 1280];
  if (/\bbanner\b|\bheader\b/.test(t))              return [1500, 500];
  if (/\bwallpaper\b/.test(t))                      return [1920, 1080];
  if (/\binstagram\b/.test(t))                      return [1080, 1080];
  if (/\btwitter\b|\bx\s+post\b/.test(t))           return [1200, 675];
  if (/\bthumbnail\b/.test(t))                      return [1280, 720];
  if (/\bposter\b/.test(t))                         return [794, 1123];
  if (/\bcanva\b/.test(t))                          return [1080, 1080];

  // Explicit dimensions: "1920x1080", "800 by 600", "400 * 300"
  const match = t.match(/(\d{2,4})\s*(?:x|by|\*|×)\s*(\d{2,4})/);
  if (match) return [parseInt(match[1]), parseInt(match[2])];

  return [1024, 1024]; // default square
}

// ── Extract model preference ──────────────
function parseModel(text) {
  const t = text.toLowerCase();
  if (/\brealistic\b|\bphoto\b|\bphotographic\b/.test(t)) return "flux-realism";
  if (/\bfast\b|\bquick\b|\bturbo\b/.test(t))             return "turbo";
  return "flux"; // default — best quality
}

// ── Main generate function ────────────────
export async function generateImage(promptText, dimensionHint = "") {
  const combined = promptText + " " + dimensionHint;
  const [w, h]   = parseDimensions(combined);
  const model    = parseModel(combined);

  // Clean prompt — remove dimension/style words
  const cleanPrompt = promptText
    .replace(/\b(square|landscape|portrait|banner|wallpaper|poster|thumbnail|instagram|twitter|realistic|fast|turbo|canva)\b/gi, "")
    .replace(/\d{2,4}\s*(?:x|by|\*|×)\s*\d{2,4}/g, "")
    .trim();

  _chat?.add(`Generating ${w}×${h} image: "${cleanPrompt}"...`, "bot");
  _orb?.setState("thinking");

  try {
    const url = `/api/imagine?prompt=${encodeURIComponent(cleanPrompt)}&w=${w}&h=${h}&model=${model}`;
    const res  = await fetch(url);

    let imgUrl;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      imgUrl = data.url; // fallback URL
    } else {
      // Direct image blob
      const blob = await res.blob();
      imgUrl = URL.createObjectURL(blob);
    }

    // Render image in chat
    _renderImageMessage(imgUrl, cleanPrompt, w, h);
    Speech.speak(`Here's your ${w} by ${h} image.`);
    _orb?.setState("idle");

  } catch(e) {
    _chat?.addError("Image generation failed: " + e.message);
    _orb?.setState("idle");
  }
}

function _renderImageMessage(imgUrl, prompt, w, h) {
  const col  = document.getElementById("col-left");
  if (!col) return;

  const wrap  = document.createElement("div");
  wrap.className = "mwrap mleft fresh";

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = "FLOW";

  const card = document.createElement("div");
  card.className = "img-card";

  const img = document.createElement("img");
  img.src   = imgUrl;
  img.alt   = prompt;
  img.style.cssText = `max-width:100%;border-radius:10px;display:block;cursor:pointer;`;
  img.onclick = () => window.open(imgUrl, "_blank");

  const meta = document.createElement("div");
  meta.className   = "img-meta";
  meta.textContent = `${w}×${h} • click to open full size`;

  const dlBtn = document.createElement("a");
  dlBtn.href      = imgUrl;
  dlBtn.download  = `flow-${Date.now()}.jpg`;
  dlBtn.className = "img-dl-btn";
  dlBtn.textContent = "⬇ DOWNLOAD";

  card.appendChild(img);
  card.appendChild(meta);
  card.appendChild(dlBtn);
  wrap.appendChild(label);
  wrap.appendChild(card);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;

  // Fade after 8s (images stay visible longer)
  setTimeout(() => wrap.classList.remove("fresh"), 8000);
}

// ── Parse image request from text ─────────
export function parseImageRequest(text) {
  const t = text.toLowerCase();

  // Triggers: "generate", "create", "make", "draw", "imagine", "design"
  const triggers = /\b(generate|create|make|draw|imagine|design|show me|produce)\b.*\b(image|picture|photo|illustration|artwork|logo|banner|poster|thumbnail|wallpaper)\b/i;
  const reverse  = /\b(image|picture|photo|illustration|artwork|logo|banner|poster|thumbnail|wallpaper)\b.*\b(of|for|showing|with)\b/i;
  const canvaStyle = /\bcanva.*(style|like|design)\b/i;

  if (!triggers.test(text) && !reverse.test(text) && !canvaStyle.test(text)) return null;

  // Extract the actual subject
  let prompt = text
    .replace(/\b(generate|create|make|draw|imagine|design|show me|produce)\b/gi, "")
    .replace(/\b(an?\s+)?(image|picture|photo|illustration|artwork)\b/gi, "")
    .replace(/\b(of|for|showing|with|in|style|like)\b/gi, "")
    .replace(/\bcanva\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return prompt || null;
}
