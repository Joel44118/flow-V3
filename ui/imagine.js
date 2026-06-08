// ═══════════════════════════════════════════
// ui/imagine.js — Image generation UI
//
// FIXES:
//   - Handles HF blob response (downloads correctly)
//   - Handles Pollinations URL fallback (opens in new tab)
//   - Download button works for both cases
//   - Image previews inline before downloading
// ═══════════════════════════════════════════
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;

export function initImagine(chat, orb) {
  _chat = chat;
  _orb  = orb;
}

// ── Parse dimension strings ───────────────
function parseDimensions(text) {
  const t = text.toLowerCase();
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
  const match = t.match(/(\d{2,4})\s*(?:x|by|\*|×)\s*(\d{2,4})/);
  if (match) return [parseInt(match[1]), parseInt(match[2])];
  return [1024, 1024];
}

function parseModel(text) {
  const t = text.toLowerCase();
  if (/\brealistic\b|\bphoto\b|\bphotographic\b/.test(t)) return "realistic";
  if (/\bfast\b|\bquick\b|\bturbo\b/.test(t))             return "turbo";
  return "flux";
}

// ── Main generate function ────────────────
export async function generateImage(promptText, dimensionHint = "") {
  const combined    = promptText + " " + dimensionHint;
  const [w, h]      = parseDimensions(combined);
  const model       = parseModel(combined);

  const cleanPrompt = promptText
    .replace(/\b(square|landscape|portrait|banner|wallpaper|poster|thumbnail|instagram|twitter|realistic|fast|turbo|canva|logo|icon)\b/gi, "")
    .replace(/\d{2,4}\s*(?:x|by|\*|×)\s*\d{2,4}/g, "")
    .replace(/\s+/g, " ")
    .trim();

  _chat?.add(`Generating ${w}×${h} image — "${cleanPrompt}"...`, "bot");
  _orb?.setState("thinking");

  try {
    const url = `/api/imagine?prompt=${encodeURIComponent(cleanPrompt)}&w=${w}&h=${h}&model=${model}`;
    const res  = await fetch(url);

    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const contentType = res.headers.get("content-type") || "";

    if (contentType.startsWith("image/")) {
      // HuggingFace returned actual image binary — create local blob URL
      const blob   = await res.blob();
      const imgUrl = URL.createObjectURL(blob);
      _renderImageCard(imgUrl, cleanPrompt, w, h, true); // isBlob = true
    } else {
      // Pollinations fallback — got a JSON with a URL
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const imgUrl = data.url;
      _renderImageCard(imgUrl, cleanPrompt, w, h, false); // isBlob = false
    }

    Speech.speak(`Here's your ${w} by ${h} image, Boss.`);
    _orb?.setState("idle");

  } catch(e) {
    _chat?.addError("Image generation failed: " + e.message);
    _orb?.setState("idle");
  }
}

function _renderImageCard(imgUrl, prompt, w, h, isBlob) {
  const col = document.getElementById("col-left");
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = "mwrap mleft fresh";

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = "FLOW";

  const card = document.createElement("div");
  card.className = "img-card";

  // Image element — inline preview
  const img = document.createElement("img");
  img.alt   = prompt;
  img.style.cssText = "max-width:100%;border-radius:10px;display:block;cursor:pointer;min-height:60px;background:rgba(56,189,248,.05);";

  // For Pollinations URL fallback — load inline, handle errors
  if (!isBlob) {
    img.crossOrigin = "anonymous";
    img.onerror = () => {
      // Image failed to load inline (CORS etc) — show open link instead
      img.style.display = "none";
      const openLink = document.createElement("a");
      openLink.href      = imgUrl;
      openLink.target    = "_blank";
      openLink.className = "img-open-btn";
      openLink.textContent = "🖼 Open Image in New Tab";
      card.insertBefore(openLink, img.nextSibling);
    };
  }
  img.src = imgUrl;
  img.onclick = () => window.open(imgUrl, "_blank");

  // Meta info
  const meta = document.createElement("div");
  meta.className   = "img-meta";
  meta.textContent = `${w}×${h} · click image to open full size`;

  // Download button — works correctly for both blob and URL
  const dlBtn = document.createElement("a");
  dlBtn.className   = "img-dl-btn";
  dlBtn.textContent = "⬇ DOWNLOAD";

  if (isBlob) {
    // Blob URL — direct download works
    dlBtn.href     = imgUrl;
    dlBtn.download = `flow-image-${Date.now()}.jpg`;
  } else {
    // Pollinations URL — open in new tab (avoids the rate-limit JSON error page)
    dlBtn.href   = imgUrl;
    dlBtn.target = "_blank";
    dlBtn.title  = "Opens in new tab — right-click to save";
  }

  card.appendChild(img);
  card.appendChild(meta);
  card.appendChild(dlBtn);
  wrap.appendChild(label);
  wrap.appendChild(card);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;

  // Keep visible longer — images need more reading time
  setTimeout(() => wrap.classList.remove("fresh"), 10000);
}

// ── Parse image request from text ─────────
export function parseImageRequest(text) {
  const triggers = /\b(generate|create|make|draw|imagine|design|show me|produce)\b.*\b(image|picture|photo|illustration|artwork|logo|banner|poster|thumbnail|wallpaper|icon)\b/i;
  const reverse  = /\b(image|picture|photo|illustration|artwork|logo|banner|poster|thumbnail|wallpaper)\b.*\b(of|for|showing|with)\b/i;
  const canvaStyle = /\bcanva.*(style|like|design)\b/i;

  if (!triggers.test(text) && !reverse.test(text) && !canvaStyle.test(text)) return null;

  let prompt = text
    .replace(/\b(generate|create|make|draw|imagine|design|show me|produce)\b/gi, "")
    .replace(/\b(an?\s+)?(image|picture|photo|illustration|artwork)\b/gi, "")
    .replace(/\b(of|for|showing|with|in|style|like)\b/gi, "")
    .replace(/\bcanva\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return prompt || null;
}
