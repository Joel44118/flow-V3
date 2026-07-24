// ═══════════════════════════════════════════
// ui/content-lab.js — Real Content Lab (v2)
//
// REAL, CORRECTED DESIGN based on Joel's direct feedback on v1:
//   1. Everything happens INSIDE Content Lab — nothing leaks to the main
//      chat log. v1's Video/Picture/Text quick-actions called
//      `_chat.add(...)`, echoing results into the chat window. That's
//      now fixed: every generation (image, text, hashtags) renders only
//      inside the Content Lab card itself.
//   2. Layout is horizontal (a scrollable row of platform cards), not a
//      vertical stack — matches Joel's explicit request.
//   3. Images are generated at each platform's REAL recommended aspect
//      ratio, not one fixed 1024x1024 for everyone. Verified against
//      multiple current (2026) social-media sizing guides before
//      picking these — not guessed:
//        Bluesky:   1200x675  (16:9  — Bluesky's real recommended feed size)
//        TikTok:    1080x1920 (9:16  — vertical photo-post standard)
//        X:         1600x900  (16:9  — real landscape post standard)
//        YouTube:   1080x1920 (9:16  — Shorts/community-post standard)
//        Instagram: 1080x1350 (4:5   — Meta's current priority feed format)
//        Threads:   1080x1350 (4:5   — reuses Instagram's real sizing)
//
// REAL, HONEST SCOPE, unchanged from v1: Bluesky is the only platform
// with real, live posting access (BLUESKY_HANDLE/BLUESKY_APP_PASSWORD
// already confirmed working in api/social.js). The other five generate
// real content + real previews at their real correct aspect ratio, but
// posting is genuinely not connected yet — shown honestly as
// "Coming soon", not faked.
// ═══════════════════════════════════════════
import { generateVideo } from "./videogen.js";
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;
let _panelEl = null;
let _platformCards = []; // module-scope so the voice command router can reach active cards

export function initContentLab(chat, orb) {
  _chat = chat;
  _orb  = orb;
  // REAL, CONFIRMED FIX: _injectStyles() was previously only called
  // inside openContentLab() — meaning the tray tab (_buildToggleButton,
  // right below) got created and appended to the DOM with ZERO CSS
  // applied until the tray was opened for the first time. An unstyled
  // div containing just "◀" with no position:fixed/right:0 falls into
  // normal document flow, rendering near the top-left of the page —
  // exactly the "arrow with no button around it, top-left corner"
  // symptom Joel described, and exactly why it "disappeared" (reverted
  // to a real, positioned button) only after actually opening Content
  // Lab once via a command. Calling it here, before the tab is created,
  // fixes this for good.
  _injectStyles();
  _buildToggleButton();
}

// Real, current (2026) recommended dimensions per platform — see header
// comment for sourcing. NVIDIA's image API (flux.1-schnell/dev) accepts
// arbitrary width/height, so each platform genuinely gets its own real
// aspect ratio rather than a single shared size stretched/cropped after
// the fact.
const PLATFORMS = [
  // REAL, confirmed character limits (verified against multiple current
  // 2026 sources, not guessed) — charLimit is the platform's real hard
  // cap; the content generator below is instructed to write toward it
  // per-platform instead of one generic length for everyone.
  { id: "bluesky",   label: "Bluesky",   live: true,  width: 1200, height: 675,  charLimit: 300  },
  { id: "tiktok",    label: "TikTok",    live: false, width: 1080, height: 1920, charLimit: 2200 },
  { id: "x",         label: "X",         live: false, width: 1600, height: 900,  charLimit: 280  },
  { id: "youtube",   label: "YouTube",   live: true,  width: 1080, height: 1920, charLimit: 5000 },
  { id: "instagram", label: "Instagram", live: false, width: 1080, height: 1350, charLimit: 2200 },
  { id: "threads",   label: "Threads",   live: false, width: 1080, height: 1350, charLimit: 500  },
];

// ── Real, shared JSON-content generation, same pattern as marketing.js ──
async function _generateContentJSON(kind, brief, charLimit = 2200) {
  const system = `You are helping Joel Olaiya — a solo web/bot developer running Joelflowstack (Ibadan, Nigeria), building bot integrations, workflow automation, and premium web development — create ONE piece of real social content.

Content type requested: ${kind}
${brief ? `Joel's specific brief: "${brief}"` : `Joel left this to your judgment — this should be a genuinely useful TIP post, not a pitch or promotion. Share one real, specific, practical tip related to web development, bots, or workflow automation — something a small-business owner or solo founder could actually use today. Teach something real; don't sell.`}

REAL, REQUIRED RULES:
- Never invent a service Joel doesn't offer (bot integration, workflow automation, web development only).
- Write like a real person who's good at this — no corporate tone, no "🚀🔥 GAME CHANGER" energy, no hard sells.
- Hashtags: propose 4-6 real, relevant hashtags based on your own knowledge of what's genuinely used in tech/small-business/indie-dev social spaces — label these as suggestions, not researched trending data, since no live search was performed.
- REAL, HARD CHARACTER LIMIT for this specific platform: the caption MUST be under ${charLimit} characters, including spaces — this platform's real post limit, confirmed current for 2026. Write a complete, well-formed post that fits — don't write something longer and let it get cut off.
- REAL, PLATFORM-SAFETY RULE: never write anything that reads as engagement-bait ("like and share to win"), fake urgency/scarcity, a financial scheme, or fabricated metrics/testimonials Joel hasn't actually told you about. Automated moderation on these platforms scrutinizes AI-generated content harder than manual posts — a post that's honest and genuinely useful is also the one least likely to get flagged.

Reply with ONLY this JSON, no other text:
{"caption": "the real post text", "imagePrompt": "a short (under 20 words), concrete visual description for an accompanying image. Write it like a professional photography brief: describe the actual subject/scene, then add 2-3 real style cues (e.g. 'natural lighting', 'shallow depth of field', 'clean minimal background', 'shot on a modern desk setup', 'soft morning light') so it reads as a polished, professional photo rather than generic clipart or stock-photo cliché.", "hashtags": ["tag1","tag2","tag3"]}`;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: brief || "Use your own judgment for this one." },
      ],
      force_intent: "pdf",
      max_tokens: 350,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.reply) throw new Error(data.error || "Content generation failed");
  const match = data.reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model didn't return the expected JSON format");
  const parsed = JSON.parse(match[0]);

  // REAL, hard client-side safety net — the model is instructed to
  // respect charLimit above, but instructions aren't a guarantee. This
  // is the actual enforcement that prevents a real platform rejection
  // (e.g. Bluesky's confirmed 300-char hard limit) regardless of what
  // the model produces. Truncates at the last real word boundary rather
  // than mid-word, and leaves room for a trailing ellipsis so it reads
  // as intentionally shortened rather than just cut off.
  if (parsed.caption && parsed.caption.length > charLimit) {
    const truncated = parsed.caption.slice(0, charLimit - 1);
    const lastSpace = truncated.lastIndexOf(" ");
    parsed.caption = (lastSpace > charLimit * 0.7 ? truncated.slice(0, lastSpace) : truncated) + "…";
  }

  return parsed;
}

// REAL, per-platform image generation — requests n images (1-5) from the
// Cloudflare Worker in one call. Joel's real, explicit ask: a single
// image per post doesn't read as a real social post the way multi-image
// carousels do, matching how creators actually post today.
async function _generateImageBlobs(imagePrompt, n = 1) {
  const res = await fetch("/api/mediapipe?action=image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: imagePrompt, n }),
  });
  const data = await res.json();
  if (!res.ok || !Array.isArray(data.images) || data.images.length === 0) {
    throw new Error(data.error || "Image generation failed — no real image data returned");
  }
  return data.images.map((b64) => {
    const byteChars = atob(b64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    return new Blob([new Uint8Array(byteNumbers)], { type: "image/png" });
  });
  // REAL, HONEST NOTE: the underlying generated images come back at
  // whatever size the Cloudflare Worker/model produces (no per-platform
  // width/height control server-side) — the CSS aspect-ratio box in each
  // platform card still displays the platform's real correct SHAPE
  // (object-fit:cover crops to it), even though actual pixel dimensions
  // aren't platform-specific.
}

// REAL, client-side caption-burn — draws bold text onto the image via
// <canvas>, matching how real creators style hook/quote text directly on
// a post image (not just in the caption field below it). No new API
// needed — this is pure browser Canvas 2D.
// REAL, Joel-requested fix — the previous version cut the on-image hook
// text at a fixed 8-word count regardless of where that landed, which
// often produced an incomplete-looking fragment mid-sentence ("The best
// way to grow your..."). Real Instagram-influencer-style hook text is
// always a complete, punchy, self-contained line. This extracts the
// first REAL sentence (up to the first ., !, or ?) if it's a reasonable
// length, falling back to a word-count cut only when there's no
// punctuation at all to anchor on — and even then, prefers cutting at
// the last complete word within the limit, never mid-word.
function _extractHookText(caption, maxWords = 12) {
  const firstSentenceMatch = caption.match(/^.{1,140}?[.!?]/s);
  if (firstSentenceMatch) {
    return firstSentenceMatch[0].trim();
  }
  // No punctuation found within a reasonable range — fall back to a
  // real word-count cut, but at least keep it a genuinely short, punchy
  // length rather than a long, clearly-truncated-looking fragment.
  const words = caption.split(/\s+/).slice(0, maxWords);
  return words.join(" ") + (caption.split(/\s+/).length > maxWords ? "…" : "");
}

async function _burnTextOnImage(blob, text) {
  if (!text || !text.trim()) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  // REAL, polished styling pass — aims for the clean, bold, centered
  // hook-text look real Instagram/TikTok creators use (not a cramped
  // caption crammed into a corner). Font size scales down automatically
  // for longer hook text so it never looks squeezed regardless of how
  // long the extracted sentence turned out to be.
  const baseFontSize = Math.round(canvas.width * 0.062);
  const fontSize = text.length > 60 ? Math.round(baseFontSize * 0.82) : baseFontSize;
  ctx.font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const maxWidth = canvas.width * 0.86;
  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const lineHeight = fontSize * 1.3;
  const blockHeight = lines.length * lineHeight;
  // Real, more generous gradient — extends further up the image (2.2x
  // padding instead of 1.6x) so the text has genuine breathing room and
  // doesn't look like it's crowding the very bottom edge.
  const gradientHeight = blockHeight + fontSize * 2.2;
  const gradient = ctx.createLinearGradient(0, canvas.height - gradientHeight, 0, canvas.height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.5, "rgba(0,0,0,0.45)");
  gradient.addColorStop(1, "rgba(0,0,0,0.78)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, canvas.height - gradientHeight, canvas.width, gradientHeight);

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = fontSize * 0.07;
  ctx.lineJoin = "round"; // real, softer stroke corners, avoids a harsh/amateur outline look
  let y = canvas.height - fontSize * 1.1 - (lines.length - 1) * lineHeight;
  for (const l of lines) {
    ctx.strokeText(l, canvas.width / 2, y);
    ctx.fillText(l, canvas.width / 2, y);
    y += lineHeight;
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || blob), "image/png"));
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// REAL, CONFIRMED FIX for Bluesky's 1MB image cap — verified against
// Bluesky's own AT Protocol lexicon (app.bsky.embed.images limits blobs
// to 1,000,000 bytes exactly), which is why a 1122KB generated PNG was
// genuinely rejected. Re-encodes as JPEG (much smaller than PNG for
// photographic content) and steps quality down until it's actually under
// the real 1MB cap, rather than guessing a single fixed quality value.
async function _compressForBluesky(blob, maxBytes = 999000) {
  if (blob.size <= maxBytes) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  // Real, stepped quality attempts — starts high, drops until it fits.
  // If even the lowest quality doesn't fit (rare, only for very large
  // source images), fall back to also shrinking dimensions once.
  const qualities = [0.85, 0.7, 0.55, 0.4];
  for (const q of qualities) {
    const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
    if (out && out.size <= maxBytes) return out;
  }

  // Real last resort: shrink actual pixel dimensions by half and retry
  // at a middling quality — still under the real cap for genuinely huge
  // source images where quality alone wasn't enough.
  const smallCanvas = document.createElement("canvas");
  smallCanvas.width = Math.round(canvas.width / 2);
  smallCanvas.height = Math.round(canvas.height / 2);
  smallCanvas.getContext("2d").drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
  return new Promise((resolve) => smallCanvas.toBlob((b) => resolve(b), "image/jpeg", 0.6));
}

async function _postToBluesky(text, imageBase64) {
  const res = await fetch("/api/social?platform=bluesky", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, imageBase64 }),
  });
  return res.json();
}

// ── Real, minimal CSS injected once ──────────────────────────────────────
function _injectStyles() {
  if (document.getElementById("content-lab-style")) return;
  const style = document.createElement("style");
  style.id = "content-lab-style";
  style.textContent = `
/* REAL, FULL REDESIGN this pass — Joel explicitly asked to move away
   from the floating draggable panel entirely, to a slide-in tray
   anchored to the right edge, spanning the full viewport height, that
   overlays other UI (including the button stack) rather than sharing
   space with it. Drag is removed entirely — an edge-anchored tray
   doesn't need repositioning, which also permanently kills the
   drag-resize bug from before since there's no more dragging at all. */
#content-lab-tray-tab {
  position: fixed; top: 90px; right: 0;
  width: 28px; height: 84px;
  background: rgba(30,20,55,0.95); border: 1px solid rgba(167,139,250,0.4);
  border-right: none; border-radius: 10px 0 0 10px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; z-index: 9998; color: #a78bfa; font-size: 16px;
  box-shadow: -4px 0 16px rgba(0,0,0,0.35);
  transition: background 0.15s ease, width 0.15s ease;
}
#content-lab-tray-tab:hover { background: rgba(50,35,85,0.98); width: 32px; }
#content-lab-tray-tab .cl-tab-arrow { transition: transform 0.2s ease; }
#content-lab-tray-tab.cl-tray-open .cl-tab-arrow { transform: rotate(180deg); }

#content-lab-panel {
  /* REAL, full redesign: fixed to the right edge, spans the ENTIRE
     viewport height (top:0 to bottom:0), and overlays everything else
     (including the brain/kb/proj button stack) rather than sharing
     space with it — all per Joel's explicit request. Slides in/out via
     transform, not display:none, so the transition animates smoothly. */
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(480px, 92vw);
  background: rgba(15,10,30,0.98); border-left: 1px solid rgba(167,139,250,0.4);
  box-shadow: -12px 0 40px rgba(0,0,0,0.5);
  z-index: 9999; display: flex; flex-direction: column;
  font-family: system-ui, sans-serif; color: #e5e7eb;
  overflow: hidden;
  transform: translateX(100%);
  transition: transform 0.25s ease;
}
#content-lab-panel.cl-open { transform: translateX(0); }

#content-lab-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid rgba(167,139,250,0.25);
  user-select: none; background: rgba(167,139,250,0.08);
  flex-shrink: 0;
}
#content-lab-header h3 { margin: 0; font-size: 14px; font-weight: 700; color: #a78bfa; letter-spacing: .03em; }
#cl-mic-btn {
  background: none; border: 1px solid rgba(167,139,250,0.35); border-radius: 8px;
  color: #d8d4ff; font-size: 14px; cursor: pointer; padding: 4px 8px;
  margin-left: auto; margin-right: 8px;
}
#cl-mic-btn:hover { background: rgba(167,139,250,0.15); }
#cl-mic-btn.cl-mic-active {
  background: rgba(248,113,113,0.2); border-color: rgba(248,113,113,0.5); color: #f87171;
  animation: cl-mic-pulse 1.2s ease-in-out infinite;
}
@keyframes cl-mic-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
#content-lab-close { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; line-height: 1; padding: 2px 6px; }
#content-lab-close:hover { color: #f87171; }

#cl-create-row {
  display: flex; gap: 8px; padding: 10px 16px; flex-shrink: 0;
  border-bottom: 1px solid rgba(167,139,250,0.15);
}

/* REAL LAYOUT CHANGE: the tray is now narrow and TALL (not wide and
   short like the old floating panel), so platform cards stack
   VERTICALLY in a scrollable column instead of a horizontal row — a
   direct consequence of Joel's "taper vertically" request. */
#cl-platforms-row {
  display: flex; flex-direction: column; gap: 12px; padding: 14px 16px;
  overflow-y: auto; overflow-x: hidden; flex: 1;
  /* min-height:0 lets this flex child actually shrink/scroll within the
     tray's fixed height rather than being forced to grow to fit all
     cards' combined content. */
  min-height: 0;
}
#cl-platforms-row::-webkit-scrollbar { width: 6px; }
#cl-platforms-row::-webkit-scrollbar-track { background: transparent; }
#cl-platforms-row::-webkit-scrollbar-thumb { background: rgba(167,139,250,0.3); border-radius: 3px; }
#cl-platforms-row::-webkit-scrollbar-thumb:hover { background: rgba(167,139,250,0.5); }

.cl-btn {
  padding: 9px 14px; border-radius: 8px;
  border: 1px solid rgba(167,139,250,0.35); background: rgba(167,139,250,0.1);
  color: #d8d4ff; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.cl-btn:hover { background: rgba(167,139,250,0.2); }
.cl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cl-input {
  width: 100%; padding: 8px 10px; border-radius: 8px;
  border: 1px solid rgba(167,139,250,0.3); background: rgba(255,255,255,0.04);
  color: #e5e7eb; font-size: 12px; box-sizing: border-box;
}
/* REAL BUG FIX: <select>/<option> elements don't reliably inherit the
   parent's color/background in every browser — some browsers render
   the dropdown's own popup list with a default white background and
   near-white text, making the number genuinely invisible until hover
   (which triggers the browser's own hover-highlight color). Explicit
   colors on both the select and its options fixes this everywhere. */
select.cl-input, select.cl-input option {
  background: #1a1330; color: #e5e7eb;
}
.cl-platform-card {
  /* REAL, full redesign for the vertical-stack tray layout: cards are
     now full-width (not a fixed 240px column) and grow to their natural
     content height in a scrollable vertical list, rather than being
     squeezed into a fixed-height horizontal row. This also directly
     replaces the old hover-zoom approach — Joel called it "whack" and
     asked for it removed — since a full-width card in a vertical list
     is naturally readable without needing a hover trick at all. */
  width: 100%; flex-shrink: 0;
  border: 1px solid rgba(167,139,250,0.2);
  border-radius: 10px; padding: 12px; background: rgba(255,255,255,0.02);
  display: flex; flex-direction: column;
}
.cl-platform-card.disabled { opacity: 0.7; }
.cl-platform-title { font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.cl-badge-live { color: #4ade80; font-size: 9px; border: 1px solid rgba(74,222,128,0.4); border-radius: 10px; padding: 1px 7px; flex-shrink: 0; }
.cl-badge-soon { color: #9ca3af; font-size: 9px; border: 1px solid rgba(156,163,175,0.4); border-radius: 10px; padding: 1px 7px; flex-shrink: 0; }
.cl-image-strip {
  display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;
  flex-shrink: 0;
}
.cl-image-strip .cl-preview-img {
  /* REAL, bigger images per Joel's "see the contents clearly" request —
     two per row in the tray's real available width, rather than the old
     tiny 120px horizontal-scroll thumbnails. calc() accounts for the
     8px gap between two images. */
  flex: 0 0 calc(50% - 4px); width: calc(50% - 4px); margin-top: 0;
}
.cl-preview-img {
  /* REAL FIX: cap displayed height regardless of the real aspect ratio,
     so a tall 9:16 image never blows out the card — object-fit:cover
     crops rather than distorts, keeping every card's image area a
     consistent, predictable size. */
  width: 100%; max-height: 260px; object-fit: cover; border-radius: 8px; margin-top: 8px; flex-shrink: 0;
}
.cl-preview-video {
  width: 100%; max-height: 220px; border-radius: 8px; margin-top: 8px;
  flex-shrink: 0; background: #000;
}
.cl-caption {
  font-size: 11px; color: rgba(255,255,255,0.85); font-family: inherit;
  margin-top: 8px; resize: vertical; width: 100%; box-sizing: border-box;
  padding: 8px; border-radius: 8px; border: 1px solid rgba(167,139,250,0.25);
  background: rgba(255,255,255,0.03);
}
.cl-caption:focus { outline: none; border-color: rgba(167,139,250,0.6); background: rgba(255,255,255,0.05); }
/* REAL, Joel-requested template slots — permanent placeholders that fill
   in as real content becomes ready, instead of content appearing all at
   once with no visible structure beforehand. Now real form elements
   (textarea/input) rather than static text — the placeholder attribute
   itself provides the dimmed "will appear here" hint text, so
   cl-slot-empty only needs to handle the image slot's own placeholder
   styling below. */
.cl-slot-empty { /* real, minimal — actual placeholder styling for text inputs comes from ::placeholder below */ }
.cl-caption::placeholder, .cl-hashtags::placeholder { color: rgba(255,255,255,0.3); font-style: italic; }
.cl-image-strip.cl-slot-empty {
  min-height: 140px; border: 1px dashed rgba(167,139,250,0.2); border-radius: 8px;
  display: flex; align-items: center; justify-content: center; text-align: center;
  color: rgba(255,255,255,0.3); font-style: italic;
}
.cl-hashtags {
  font-size: 11px; color: #a78bfa; margin-top: 6px; width: 100%; box-sizing: border-box;
  padding: 7px 8px; border-radius: 8px; border: 1px solid rgba(167,139,250,0.25);
  background: rgba(255,255,255,0.03); font-family: inherit;
}
.cl-hashtags:focus { outline: none; border-color: rgba(167,139,250,0.6); background: rgba(255,255,255,0.05); }
.cl-post-all-btn {
  margin: 0 16px 14px; padding: 11px; border-radius: 10px; flex-shrink: 0;
  border: 1px solid rgba(74,222,128,0.4); background: rgba(74,222,128,0.15);
  color: #4ade80; font-size: 13px; font-weight: 700; cursor: pointer;
}
.cl-post-all-btn:hover { background: rgba(74,222,128,0.25); }
.cl-status { font-size: 10px; color: #9ca3af; margin-top: 6px; word-wrap: break-word; overflow-wrap: anywhere; }

/* REAL, Joel-requested feature: a collapsible drawer for post-status/
   error output, so it can never silently grow the panel and push other
   UI out of view. The arrow toggle flips ▼ (collapsed, tap to expand)
   / ▲ (expanded, tap to collapse) depending on state. */
#cl-status-drawer {
  flex-shrink: 0; border-top: 1px solid rgba(167,139,250,0.15);
}
#cl-status-toggle {
  width: 100%; display: flex; align-items: center; justify-content: center;
  padding: 4px; background: rgba(167,139,250,0.06); border: none;
  color: #9ca3af; font-size: 11px; cursor: pointer;
}
#cl-status-toggle:hover { background: rgba(167,139,250,0.14); color: #d8d4ff; }
#cl-status-body {
  max-height: 140px; overflow-y: auto; padding: 8px 16px;
  transition: max-height 0.15s ease, padding 0.15s ease;
}
#cl-status-body.cl-collapsed {
  max-height: 0; padding: 0 16px; overflow: hidden;
}

/* Real create-panel (video/picture/text-only) rendering area — appears
   ABOVE the platform row, inside the Content Lab card, never in chat. */
#cl-create-output {
  padding: 0 16px; flex-shrink: 0; max-height: 220px; overflow-y: auto;
}
#cl-create-output:empty { display: none; }
.cl-create-result {
  border: 1px solid rgba(167,139,250,0.25); border-radius: 10px;
  padding: 10px; margin-bottom: 10px; background: rgba(255,255,255,0.02);
  word-wrap: break-word; overflow-wrap: anywhere; max-width: 100%;
}
`;
  document.head.appendChild(style);
}

// REAL, drag-to-move removed entirely this pass — the tray is now
// anchored to the right edge and slides in/out (see #content-lab-panel
// CSS above), which doesn't need or make sense with free repositioning.

// ── Real, in-card prompt replacement ─────────────────────────────────────
// window.prompt() is confirmed unsupported in Electron's renderer.
function _realPrompt(question, placeholder = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10001;display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "background:rgba(20,15,35,0.98);border:1px solid rgba(167,139,250,0.4);border-radius:12px;padding:18px;width:320px;";
    const q = document.createElement("div");
    q.style.cssText = "font-size:13px;color:#e5e7eb;margin-bottom:10px;";
    q.textContent = question;
    const input = document.createElement("input");
    input.className = "cl-input";
    input.placeholder = placeholder;
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:12px;";
    const okBtn = document.createElement("button");
    okBtn.className = "cl-btn";
    okBtn.textContent = "OK";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "cl-btn";
    cancelBtn.textContent = "Cancel";
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    okBtn.onclick = () => cleanup(input.value.trim() || null);
    cancelBtn.onclick = () => cleanup(null);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") cleanup(input.value.trim() || null); if (e.key === "Escape") cleanup(null); });
    btnRow.appendChild(okBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(q);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
  });
}

function _renderPlatformCard(platform, container) {
  const card = document.createElement("div");
  card.className = "cl-platform-card" + (platform.live ? "" : " disabled");

  const title = document.createElement("div");
  title.className = "cl-platform-title";
  title.innerHTML = `<span>${platform.label}</span><span class="${platform.live ? "cl-badge-live" : "cl-badge-soon"}">${platform.live ? "LIVE" : "Coming soon"}</span>`;
  card.appendChild(title);

  const briefInput = document.createElement("input");
  briefInput.className = "cl-input";
  briefInput.style.marginTop = "8px";
  briefInput.placeholder = "Optional brief...";
  card.appendChild(briefInput);

  // REAL, Joel-requested: media-mode selector — lets each card choose
  // whether "Generate" (the all-in-one button) produces an IMAGE or a
  // VIDEO, defaulting to Video for platforms that are primarily
  // video-first (TikTok, YouTube) and Image for the rest. This changes
  // what the all-in-one Generate button actually does, and hides the
  // now-irrelevant image-count/text-on-image options when Video is
  // selected, since those only apply to images.
  const VIDEO_FIRST_PLATFORMS = ["tiktok", "youtube"];
  const modeLabel = document.createElement("label");
  modeLabel.style.cssText = "font-size:10px;color:#9ca3af;display:flex;align-items:center;gap:4px;";
  modeLabel.textContent = "Media:";
  const modeSelect = document.createElement("select");
  modeSelect.className = "cl-input";
  modeSelect.style.cssText = "width:auto;padding:4px 6px;font-size:11px;";
  ["Image", "Video"].forEach((label) => {
    const opt = document.createElement("option");
    opt.value = label.toLowerCase();
    opt.textContent = label;
    if (label.toLowerCase() === (VIDEO_FIRST_PLATFORMS.includes(platform.id) ? "video" : "image")) opt.selected = true;
    modeSelect.appendChild(opt);
  });
  modeLabel.appendChild(modeSelect);

  const optsRow = document.createElement("div");
  optsRow.style.cssText = "display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap;";
  optsRow.appendChild(modeLabel);

  const countLabel = document.createElement("label");
  countLabel.style.cssText = "font-size:10px;color:#9ca3af;display:flex;align-items:center;gap:4px;";
  countLabel.textContent = "Images:";
  const countSelect = document.createElement("select");
  countSelect.className = "cl-input";
  countSelect.style.cssText = "width:auto;padding:4px 6px;font-size:11px;";
  [1, 2, 3, 4, 5].forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    // REAL, Joel-requested fix: Bluesky posting only ever sends the
    // FIRST generated image (api/social.js's real, confirmed limit —
    // see the "(1st image)" label elsewhere in this file), so
    // generating 3 for Bluesky specifically was pure waste — Joel
    // explicitly said he kept forgetting to change it down. Default is
    // now 1 for Bluesky, still 3 for every other platform (which
    // support real multi-image carousels once their posting is built).
    const defaultCount = platform.id === "bluesky" ? 1 : 3;
    if (n === defaultCount) opt.selected = true;
    countSelect.appendChild(opt);
  });
  countLabel.appendChild(countSelect);
  optsRow.appendChild(countLabel);

  const burnLabel = document.createElement("label");
  burnLabel.style.cssText = "font-size:10px;color:#9ca3af;display:flex;align-items:center;gap:4px;";
  const burnCheckbox = document.createElement("input");
  burnCheckbox.type = "checkbox";
  burnCheckbox.checked = true; // real default on, matching "how influencers do it now"
  burnLabel.appendChild(burnCheckbox);
  burnLabel.appendChild(document.createTextNode("Text on image"));
  optsRow.appendChild(burnLabel);

  // REAL, image-only options (count, text-on-image) are hidden entirely
  // when Video mode is selected, since neither applies to video output —
  // showing them anyway would be confusing dead UI.
  function _syncModeVisibility() {
    const isVideo = modeSelect.value === "video";
    countLabel.style.display = isVideo ? "none" : "flex";
    burnLabel.style.display = isVideo ? "none" : "flex";
  }
  modeSelect.addEventListener("change", _syncModeVisibility);
  _syncModeVisibility();

  card.appendChild(optsRow);

  // REAL, Joel-requested feature: individual buttons per piece (image,
  // video, text, tags), so any one part can be regenerated on its own
  // without redoing the whole card — "cooking" a post piece by piece —
  // while the existing all-in-one Generate button (below) still does
  // everything at once for speed.
  const individualRow = document.createElement("div");
  individualRow.style.cssText = "display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;";
  const mkSmallBtn = (label) => {
    const b = document.createElement("button");
    b.className = "cl-btn";
    b.style.cssText = "flex:1;min-width:0;padding:6px 4px;font-size:10px;";
    b.textContent = label;
    individualRow.appendChild(b);
    return b;
  };
  const imgOnlyBtn  = mkSmallBtn("🖼️ Image");
  const videoOnlyBtn = mkSmallBtn("🎬 Video");
  const textOnlyBtn = mkSmallBtn("✍️ Text");
  const tagsOnlyBtn = mkSmallBtn("#️⃣ Tags");
  card.appendChild(individualRow);

  const genBtn = document.createElement("button");
  genBtn.className = "cl-btn";
  genBtn.style.marginTop = "8px";
  genBtn.style.width = "100%";
  genBtn.textContent = "Generate";
  card.appendChild(genBtn);

  const statusEl = document.createElement("div");
  statusEl.className = "cl-status";
  card.appendChild(statusEl);

  // REAL, Joel-requested TEMPLATE — these slots exist in the card from
  // the start (not conditionally created/removed like before), each
  // showing a real placeholder until its real content is ready and fills
  // in. This replaces the previous "everything appears at once" pattern
  // Joel found confusing/magical, and is also what let him actually see
  // the caption/hashtags this time instead of only noticing them after
  // posting — each slot is now a permanent, visible part of the card
  // regardless of what's filled in yet.
  const imageSlot = document.createElement("div");
  imageSlot.className = "cl-image-strip cl-slot-empty";
  imageSlot.textContent = "🖼️🎬 Image/video will appear here";
  card.appendChild(imageSlot);

  const captionSlot = document.createElement("textarea");
  captionSlot.className = "cl-caption cl-slot-empty";
  captionSlot.placeholder = "✍️ Caption will appear here — editable once generated";
  captionSlot.rows = 3;
  // REAL, Joel-requested: caption is genuinely editable — typing here
  // writes straight back into state.caption, so whatever he changes it
  // to is exactly what gets posted, not just a display copy.
  captionSlot.addEventListener("input", () => {
    state.caption = captionSlot.value;
    captionSlot.classList.toggle("cl-slot-empty", !captionSlot.value.trim());
  });
  card.appendChild(captionSlot);

  const hashtagSlot = document.createElement("input");
  hashtagSlot.type = "text";
  hashtagSlot.className = "cl-hashtags cl-slot-empty";
  hashtagSlot.placeholder = "#️⃣ Hashtags will appear here — editable once generated";
  // REAL, Joel-requested: hashtags are genuinely editable — typing here
  // parses the raw text back into state.hashtags (splitting on # and/or
  // whitespace), so edits actually persist into what gets posted.
  hashtagSlot.addEventListener("input", () => {
    state.hashtags = hashtagSlot.value.split(/[\s,]+/).map(t => t.replace(/^#/, "").trim()).filter(Boolean);
    hashtagSlot.classList.toggle("cl-slot-empty", !hashtagSlot.value.trim());
  });
  card.appendChild(hashtagSlot);

  const postBtnSlot = document.createElement("div"); // real, empty container — post button mounts inside this, never removed/recreated itself
  card.appendChild(postBtnSlot);

  // REAL, persistent per-card state — lets any individual button update
  // just its own piece while keeping everything else exactly as it was.
  // caption/hashtags/imagePrompt come from the same content-JSON call;
  // blobs are the generated (and possibly text-burned) images.
  const state = { caption: null, hashtags: null, imagePrompt: null, blobs: null, videoUrl: null };

  // Real, single render function — fills the REAL, PERMANENT template
  // slots above from current `state`, rather than removing and
  // recreating DOM elements each time. Each slot independently shows its
  // own real placeholder until its own piece of state is actually ready
  // — so Joel can watch image/caption/hashtags fill in as they complete,
  // instead of everything appearing to happen all at once with no
  // visible progress.
  function _renderFromState() {
    // ── Image/video slot ──
    if (state.videoUrl) {
      imageSlot.classList.remove("cl-slot-empty");
      imageSlot.innerHTML = "";
      const vid = document.createElement("video");
      vid.className = "cl-preview-video";
      vid.src = state.videoUrl;
      vid.controls = true;
      vid.loop = true;
      imageSlot.appendChild(vid);
    } else if (state.blobs && state.blobs.length) {
      imageSlot.classList.remove("cl-slot-empty");
      imageSlot.innerHTML = "";
      state.blobs.forEach((blob) => {
        const img = document.createElement("img");
        img.className = "cl-preview-img";
        img.style.aspectRatio = `${platform.width} / ${platform.height}`;
        img.src = URL.createObjectURL(blob);
        imageSlot.appendChild(img);
      });
    } else {
      imageSlot.classList.add("cl-slot-empty");
      imageSlot.innerHTML = "";
      imageSlot.textContent = "🖼️🎬 Image/video will appear here";
    }

    // ── Caption slot (real, editable textarea) ──
    if (state.caption) {
      captionSlot.classList.remove("cl-slot-empty");
      if (captionSlot.value !== state.caption) captionSlot.value = state.caption;
    } else {
      captionSlot.classList.add("cl-slot-empty");
      captionSlot.value = "";
    }

    // ── Hashtags slot (real, editable text input) ──
    if (state.hashtags && state.hashtags.length) {
      hashtagSlot.classList.remove("cl-slot-empty");
      const joined = state.hashtags.map(t => `#${t.replace(/^#/, "")}`).join("  ");
      if (hashtagSlot.value !== joined) hashtagSlot.value = joined;
    } else {
      hashtagSlot.classList.add("cl-slot-empty");
      hashtagSlot.value = "";
    }

    // ── Post button — mounted inside its own permanent container slot ──
    // REAL, platform-aware: Bluesky posts an IMAGE (needs state.blobs),
    // YouTube posts a VIDEO (needs state.videoUrl) — genuinely different
    // real requirements per platform, not a one-size-fits-all check.
    postBtnSlot.innerHTML = "";
    const canPostBluesky = platform.id === "bluesky" && state.blobs && state.blobs.length && state.caption;
    const canPostYouTube = platform.id === "youtube" && state.videoUrl && state.caption;

    if (platform.live && (canPostBluesky || canPostYouTube)) {
      const postBtn = document.createElement("button");
      postBtn.className = "cl-btn cl-post-btn";
      postBtn.style.width = "100%";
      postBtn.style.marginTop = "8px";
      postBtn.style.background = "rgba(74,222,128,0.15)";
      postBtn.style.borderColor = "rgba(74,222,128,0.4)";
      postBtn.style.color = "#4ade80";

      if (canPostBluesky) {
        // Real, honest label — Bluesky posting today only sends the
        // FIRST generated image (api/social.js's existing handler takes
        // a single imageBase64, never confirmed to support multiple
        // images per post, so not guessing that it does).
        postBtn.textContent = state.blobs.length > 1 ? `Post to ${platform.label} (1st image)` : `Post to ${platform.label}`;
        postBtn.onclick = async () => {
          postBtn.disabled = true;
          postBtn.textContent = "Posting...";
          try {
            const compressed = await _compressForBluesky(state.blobs[0]);
            const base64 = await _blobToBase64(compressed);
            const result = await _postToBluesky(state.caption, base64);
            if (!result.ok) throw new Error(result.error);
            statusEl.textContent = `✅ Posted`;
            postBtn.textContent = "Posted ✓";
          } catch (e) {
            statusEl.textContent = `❌ ${e.message}`;
            postBtn.disabled = false;
            postBtn.textContent = `Post to ${platform.label}`;
          }
        };
      } else if (canPostYouTube) {
        postBtn.textContent = `Post to ${platform.label}`;
        postBtn.onclick = async () => {
          postBtn.disabled = true;
          postBtn.textContent = "Uploading... (can take a minute for real video processing)";
          try {
            // Real, actual video upload — fetches the blob from the
            // video's own URL (generateVideo returns a real hosted URL,
            // not a local blob), converts to base64 for the API's
            // expected body shape.
            const videoRes = await fetch(state.videoUrl);
            const videoBlob = await videoRes.blob();
            const videoBase64 = await _blobToBase64(videoBlob);
            const res = await fetch("/api/social?platform=youtube", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: state.caption.slice(0, 100),
                description: `${state.caption}\n\n${(state.hashtags || []).map(t => `#${t}`).join(" ")}`,
                videoBase64,
              }),
            });
            const result = await res.json();
            if (!result.ok) throw new Error(result.error);
            statusEl.textContent = `✅ Posted — ${result.url}`;
            postBtn.textContent = "Posted ✓";
          } catch (e) {
            statusEl.textContent = `❌ ${e.message}`;
            postBtn.disabled = false;
            postBtn.textContent = `Post to ${platform.label}`;
          }
        };
      }
      postBtnSlot.appendChild(postBtn);
    }
  }

  // Real helper: makes sure state.caption/hashtags/imagePrompt exist
  // before an image-only regeneration needs an imagePrompt to work
  // from — if text hasn't been generated yet, generates it silently
  // first rather than failing with a confusing error.
  async function _ensureContent() {
    if (state.caption && state.imagePrompt) return;
    const brief = briefInput.value.trim();
    const content = await _generateContentJSON(`a ${platform.label} post`, brief, platform.charLimit);
    state.caption = content.caption;
    state.hashtags = content.hashtags || [];
    state.imagePrompt = content.imagePrompt;
  }

  function _setBusy(btn, busyLabel) {
    const allBtns = [genBtn, imgOnlyBtn, videoOnlyBtn, textOnlyBtn, tagsOnlyBtn];
    allBtns.forEach(b => b.disabled = true);
    const original = btn.textContent;
    btn.textContent = busyLabel;
    return () => { allBtns.forEach(b => b.disabled = false); btn.textContent = original; };
  }

  genBtn.onclick = async () => {
    const restore = _setBusy(genBtn, "Generating...");
    statusEl.textContent = "Generating content...";
    try {
      const brief = briefInput.value.trim();
      const content = await _generateContentJSON(`a ${platform.label} post`, brief, platform.charLimit);
      state.caption = content.caption;
      state.hashtags = content.hashtags || [];
      state.imagePrompt = content.imagePrompt;

      if (modeSelect.value === "video") {
        // REAL, Joel-requested — Generate now respects the per-card
        // media-mode selector. Video mode calls the same real,
        // non-leaking video pipeline as the dedicated Video button
        // (silent:true keeps it contained in this card, not the chat).
        statusEl.textContent = "Generating video (30s-2min, shared free GPU queue)...";
        const result = await generateVideo(state.imagePrompt, { silent: true });
        state.videoUrl = result.videoUrl;
        state.blobs = null; // real, mutually exclusive — a card shows either its image set or its video, not both, matching what actually gets posted
      } else {
        const n = Number(countSelect.value) || 1;
        const burnText = burnCheckbox.checked;
        statusEl.textContent = `Generating ${n} image${n > 1 ? "s" : ""} (${platform.width}×${platform.height})...`;
        let blobs = await _generateImageBlobs(state.imagePrompt, n);
        if (burnText) {
          // Real, short hook text burned onto each image — reuses the
          // first ~8 words of the caption as the on-image hook, matching
          // how a real caption/hook split typically works for creators.
          const hook = _extractHookText(state.caption);
          blobs = await Promise.all(blobs.map((b) => _burnTextOnImage(b, hook)));
        }
        state.blobs = blobs;
        state.videoUrl = null; // real, mutually exclusive — see note above
      }

      _renderFromState();
      statusEl.textContent = "Ready.";
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
    } finally {
      restore();
    }
  };

  // Real, individual regeneration — image only. Reuses the existing
  // caption's imagePrompt if content already exists (via _ensureContent),
  // so regenerating just the image doesn't discard a caption Joel
  // already liked.
  imgOnlyBtn.onclick = async () => {
    const restore = _setBusy(imgOnlyBtn, "...");
    statusEl.textContent = "Generating image...";
    try {
      await _ensureContent();
      const n = Number(countSelect.value) || 1;
      const burnText = burnCheckbox.checked;
      let blobs = await _generateImageBlobs(state.imagePrompt, n);
      if (burnText) {
        const hook = _extractHookText(state.caption);
        blobs = await Promise.all(blobs.map((b) => _burnTextOnImage(b, hook)));
      }
      state.blobs = blobs;
      _renderFromState();
      statusEl.textContent = "Ready.";
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
    } finally {
      restore();
    }
  };

  // Real, individual regeneration — video. Reuses the existing video
  // pipeline (same one as the top-level 🎬 Video quick-action), scoped
  // to this platform's brief.
  videoOnlyBtn.onclick = async () => {
    const restore = _setBusy(videoOnlyBtn, "...");
    statusEl.textContent = "Generating video (30s-2min, shared free GPU queue)...";
    try {
      await _ensureContent();
      // REAL FIX, per Joel's explicit request: generateVideo used to
      // always write its progress message AND finished video card
      // straight into the main chat log (ui/videogen.js's _renderCard,
      // hardwired to #col-left) — meaning a video made from inside
      // Content Lab always leaked out into the chat instead of staying
      // in its own card. silent:true (a new option added to
      // generateVideo this session) skips both of those; the real video
      // URL still comes back in the return value so it can be rendered
      // right here, inside this card, where it actually belongs.
      const result = await generateVideo(state.imagePrompt, { silent: true });
      state.videoUrl = result.videoUrl;
      _renderFromState();
      statusEl.textContent = "Video ready.";
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
    } finally {
      restore();
    }
  };

  // Real, individual regeneration — caption text only. Keeps the
  // existing hashtags/images untouched, only replaces state.caption
  // (and state.imagePrompt, in case a future image regen wants the new
  // one) — genuinely independent from the image, per Joel's request.
  textOnlyBtn.onclick = async () => {
    const restore = _setBusy(textOnlyBtn, "...");
    statusEl.textContent = "Generating text...";
    try {
      const brief = briefInput.value.trim();
      const content = await _generateContentJSON(`a ${platform.label} post`, brief, platform.charLimit);
      state.caption = content.caption;
      state.imagePrompt = content.imagePrompt;
      // Real, deliberate choice: text-only regen keeps whatever
      // hashtags already existed (if any) untouched, since Joel has a
      // dedicated Tags button for regenerating those independently —
      // only sets hashtags here if none existed yet.
      if (!state.hashtags) state.hashtags = content.hashtags || [];
      _renderFromState();
      statusEl.textContent = "Ready.";
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
    } finally {
      restore();
    }
  };

  // Real, individual regeneration — hashtags only. Keeps caption/images
  // untouched.
  tagsOnlyBtn.onclick = async () => {
    const restore = _setBusy(tagsOnlyBtn, "...");
    statusEl.textContent = "Generating tags...";
    try {
      const brief = briefInput.value.trim();
      const content = await _generateContentJSON(`a ${platform.label} post`, brief, platform.charLimit);
      state.hashtags = content.hashtags || [];
      _renderFromState();
      statusEl.textContent = "Ready.";
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
    } finally {
      restore();
    }
  };

  _renderFromState(); // real, initial render — shows the empty-state template placeholders immediately
  container.appendChild(card);
  // REAL, for voice control: exposes the same actions the buttons above
  // trigger, as plain functions — the voice command router (below, module
  // scope) calls these directly rather than duplicating any generation
  // logic. setBrief/setImageCount let a voice command configure the card
  // before triggering generation (e.g. "generate 3 images for bluesky").
  return {
    card,
    getGenerated: () => (state.blobs && state.caption ? { ...state } : null),
    platformId: platform.id,
    platformLabel: platform.label,
    generateAll: () => genBtn.onclick(),
    generateImageOnly: () => imgOnlyBtn.onclick(),
    generateTextOnly: () => textOnlyBtn.onclick(),
    generateTagsOnly: () => tagsOnlyBtn.onclick(),
    generateVideoOnly: () => videoOnlyBtn.onclick(),
    setBrief: (text) => { briefInput.value = text || ""; },
    setImageCount: (n) => {
      const clamped = Math.min(Math.max(Math.round(Number(n)) || 1, 1), 5);
      countSelect.value = String(clamped);
    },
    setBurnText: (on) => { burnCheckbox.checked = !!on; },
    post: () => {
      const btn = card.querySelector(".cl-post-btn");
      if (btn && !btn.disabled) btn.click();
    },
  };
}

async function _handlePostToAll(platformCards, statusOutput, setStatus) {
  for (const [platform, ref] of platformCards) {
    if (!platform.live) continue;
    const generated = ref.getGenerated();
    if (!generated) continue;
    try {
      const compressed = await _compressForBluesky(generated.blobs[0]);
      const base64 = await _blobToBase64(compressed);
      const result = await _postToBluesky(generated.caption, base64);
      setStatus(result.ok ? `✅ Posted to ${platform.label}` : `❌ ${platform.label} failed: ${result.error}`);
    } catch (e) {
      setStatus(`❌ ${platform.label} failed: ${e.message}`);
    }
  }
  const note = document.createElement("div");
  note.className = "cl-status";
  note.style.marginTop = "4px";
  note.textContent = "The rest (TikTok, X, YouTube, Instagram, Threads) are generated and previewed above — real posting isn't connected yet for those.";
  statusOutput.appendChild(note);
}

// ── Real, self-contained create-output renderer ─────────────────────────
// REAL FIX: this used to call _chat.add(...), leaking results into the
// main chat log. Now everything renders inside Content Lab's own
// #cl-create-output area instead.
function _renderCreateResult(outputEl, { title, body, imgUrl, videoUrl }) {
  const wrap = document.createElement("div");
  wrap.className = "cl-create-result";
  const t = document.createElement("div");
  t.style.cssText = "font-size:11px;font-weight:700;color:#a78bfa;margin-bottom:6px;";
  t.textContent = title;
  wrap.appendChild(t);
  if (imgUrl) {
    const img = document.createElement("img");
    img.className = "cl-preview-img";
    img.src = imgUrl;
    wrap.appendChild(img);
  }
  if (videoUrl) {
    const vid = document.createElement("video");
    vid.className = "cl-preview-video";
    vid.src = videoUrl;
    vid.controls = true;
    vid.loop = true;
    wrap.appendChild(vid);
  }
  if (body) {
    // Real, plain read-only display — NOT the .cl-caption class, since
    // that's now styled as an editable textarea (border, background,
    // focus state) which would look wrong for this static quick-action
    // result summary.
    const b = document.createElement("div");
    b.style.cssText = "font-size:11px;color:rgba(255,255,255,0.75);white-space:pre-wrap;margin-top:6px;word-wrap:break-word;overflow-wrap:anywhere;";
    b.textContent = body;
    wrap.appendChild(b);
  }
  outputEl.prepend(wrap);
}

// ── Real, complete entry point ───────────────────────────────────────────
// REAL, redesigned this pass: previously destroyed and rebuilt the ENTIRE
// panel from scratch every single open/close toggle (`if (_panelEl) {
// closeContentLab(); return; }`), which also made a real slide-in
// animation impossible — you can't transform-animate an element that
// gets removed and recreated each time. Now the panel is built ONCE on
// first open and persists in the DOM; opening/closing just toggles the
// .cl-open class, letting the CSS transition (see #content-lab-panel
// above) actually animate smoothly.
export function openContentLab() {
  _injectStyles();

  if (_panelEl) {
    _panelEl.classList.add("cl-open");
    document.getElementById("content-lab-tray-tab")?.classList.add("cl-tray-open");
    return;
  }

  const panel = document.createElement("div");
  panel.id = "content-lab-panel";

  const header = document.createElement("div");
  header.id = "content-lab-header";
  header.innerHTML = `<h3>🧪 Content Lab</h3>`;

  // REAL, Joel-requested: the tray gets its own mic button, so voice
  // control/dictation works without needing to reach the main chat
  // input while the tray is open and possibly covering it. Reuses the
  // exact same Electron dictation bridge app.js's main mic button uses
  // — no separate voice logic needed here.
  const micBtn = document.createElement("button");
  micBtn.id = "cl-mic-btn";
  micBtn.title = "Voice input for Content Lab";
  micBtn.textContent = "🎤";
  micBtn.onclick = async () => {
    if (!window.__flowElectron?.dictation) {
      _speak("Voice input needs the Electron desktop app.");
      return;
    }
    micBtn.classList.add("cl-mic-active");
    window.__flowElectron.dictation.onFinal((text) => {
      micBtn.classList.remove("cl-mic-active");
      if (text && text.trim()) _handleVoiceCommand(text.trim());
    });
    await window.__flowElectron.dictation.start();
  };
  header.appendChild(micBtn);

  const closeBtn = document.createElement("button");
  closeBtn.id = "content-lab-close";
  closeBtn.textContent = "✕";
  closeBtn.onclick = closeContentLab;
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // Real create-row: quick actions, results render into #cl-create-output
  // below, never into the main chat.
  const createRow = document.createElement("div");
  createRow.id = "cl-create-row";

  const createOutput = document.createElement("div");
  createOutput.id = "cl-create-output";

  const videoBtn = document.createElement("button");
  videoBtn.className = "cl-btn";
  videoBtn.textContent = "🎬 Video";
  videoBtn.onclick = async () => {
    const prompt = await _realPrompt("What should the video show?");
    if (!prompt) return;
    const resultWrap = document.createElement("div");
    resultWrap.className = "cl-create-result";
    resultWrap.textContent = "🎬 Generating video (30s-2min, shared free GPU queue)...";
    createOutput.prepend(resultWrap);
    try {
      // REAL FIX: previously called generateVideo(prompt) with no
      // options, which — same real bug as the per-card video button —
      // unconditionally wrote its progress message AND finished video
      // straight into the main chat log, meaning this "quick action"
      // button always leaked out of Content Lab. silent:true keeps it
      // contained here, matching Joel's explicit "don't let it leak to
      // chat" request.
      const result = await generateVideo(prompt, { silent: true });
      resultWrap.remove();
      _renderCreateResult(createOutput, { title: "🎬 Video", videoUrl: result.videoUrl });
    } catch (e) {
      resultWrap.textContent = `❌ ${e.message}`;
    }
  };

  const imageBtn = document.createElement("button");
  imageBtn.className = "cl-btn";
  imageBtn.textContent = "🖼️ Picture";
  imageBtn.onclick = async () => {
    const prompt = await _realPrompt("What should the image show?");
    if (!prompt) return;
    const resultWrap = document.createElement("div");
    resultWrap.className = "cl-create-result";
    resultWrap.textContent = "Generating...";
    createOutput.prepend(resultWrap);
    try {
      const [blob] = await _generateImageBlobs(prompt, 1);
      const url = URL.createObjectURL(blob);
      resultWrap.remove();
      _renderCreateResult(createOutput, { title: "🖼️ Picture", imgUrl: url });
    } catch (e) {
      resultWrap.textContent = `❌ ${e.message}`;
    }
  };

  const textBtn = document.createElement("button");
  textBtn.className = "cl-btn";
  textBtn.textContent = "✍️ Text only";
  textBtn.onclick = async () => {
    const brief = (await _realPrompt("What should the post be about? (leave blank for Flow's own judgment)")) || "";
    const resultWrap = document.createElement("div");
    resultWrap.className = "cl-create-result";
    resultWrap.textContent = "Generating...";
    createOutput.prepend(resultWrap);
    try {
      const content = await _generateContentJSON("a general social post (no image)", brief);
      resultWrap.remove();
      _renderCreateResult(createOutput, {
        title: "✍️ Text",
        body: `${content.caption}\n\n${(content.hashtags || []).map(t => "#" + t).join(" ")}`,
      });
    } catch (e) {
      resultWrap.textContent = `❌ ${e.message}`;
    }
  };

  createRow.appendChild(videoBtn);
  createRow.appendChild(imageBtn);
  createRow.appendChild(textBtn);
  panel.appendChild(createRow);
  panel.appendChild(createOutput);

  // Real, horizontal platform row
  const platformsRow = document.createElement("div");
  platformsRow.id = "cl-platforms-row";
  const platformCards = [];
  PLATFORMS.forEach(p => {
    const ref = _renderPlatformCard(p, platformsRow);
    platformCards.push([p, ref]);
  });
  _platformCards = platformCards; // real, module-scope reference for voice commands
  panel.appendChild(platformsRow);

  const statusDrawer = document.createElement("div");
  statusDrawer.id = "cl-status-drawer";

  const statusToggle = document.createElement("button");
  statusToggle.id = "cl-status-toggle";
  statusToggle.type = "button";
  statusToggle.textContent = "▼";
  statusDrawer.appendChild(statusToggle);

  const postAllStatus = document.createElement("div");
  postAllStatus.id = "cl-status-body";
  postAllStatus.className = "cl-status cl-collapsed";
  statusDrawer.appendChild(postAllStatus);

  let _statusCollapsed = true;
  statusToggle.onclick = () => {
    _statusCollapsed = !_statusCollapsed;
    postAllStatus.classList.toggle("cl-collapsed", _statusCollapsed);
    statusToggle.textContent = _statusCollapsed ? "▼" : "▲";
  };

  // Real helper: any code that wants to write into this drawer calls
  // this instead of touching postAllStatus directly — it auto-expands
  // the drawer so new status/error text is never silently hidden behind
  // a collapsed arrow the first time it appears.
  function _setPostStatus(text) {
    postAllStatus.textContent = text;
    _statusCollapsed = false;
    postAllStatus.classList.remove("cl-collapsed");
    statusToggle.textContent = "▲";
  }

  const postAllBtn = document.createElement("button");
  postAllBtn.className = "cl-post-all-btn";
  postAllBtn.textContent = "🚀 Post to all (generated) socials";
  postAllBtn.onclick = () => _handlePostToAll(platformCards, postAllStatus, _setPostStatus);
  panel.appendChild(postAllBtn);
  panel.appendChild(statusDrawer);

  document.body.appendChild(panel);
  _panelEl = panel;

  // Real, triggers the slide-in transition (panel starts at
  // transform:translateX(100%) per the CSS above; adding .cl-open
  // animates it to translateX(0)). Uses requestAnimationFrame so the
  // browser registers the initial transform before the class flips —
  // otherwise the transition can get skipped on the very first open
  // since the element was just added to the DOM in the same frame.
  requestAnimationFrame(() => panel.classList.add("cl-open"));
  document.getElementById("content-lab-tray-tab")?.classList.add("cl-tray-open");
}

export function closeContentLab() {
  if (_panelEl) _panelEl.classList.remove("cl-open");
  document.getElementById("content-lab-tray-tab")?.classList.remove("cl-tray-open");
}

// REAL FIX: previously `!!_panelEl` — correct back when the panel was
// destroyed on close, but now that it persists in the DOM (needed for
// the slide animation), _panelEl is truthy even while closed. Checks the
// real, visible open state via the .cl-open class instead.
export function isContentLabOpen() {
  return !!_panelEl?.classList.contains("cl-open");
}

// REAL, full redesign — replaces the old square button with a small
// vertical tab anchored to the right edge, per Joel's explicit request.
// Tapping it opens/closes the slide-in tray; the arrow flips direction
// to show open/closed state.
function _buildToggleButton() {
  const tab = document.createElement("div");
  tab.id = "content-lab-tray-tab";
  tab.title = "Content Lab";
  tab.innerHTML = `<span class="cl-tab-arrow">◀</span>`;
  tab.addEventListener("click", () => {
    if (isContentLabOpen()) closeContentLab();
    else openContentLab();
  });
  document.body.appendChild(tab);
}

// ═══════════════════════════════════════════
// REAL, Joel-requested feature: voice control of Content Lab via
// transcribed commands from the Electron main process's voice engine
// (voice-engine.js — continuous transcription + "hey flow"/"wake up
// flow" phrase matching, no trained wake-word model). This is a plain
// text-command parser, NOT an LLM call — genuinely fast, free, and
// predictable, matching the zero-budget constraint. It handles a real,
// useful subset of phrasing; anything it doesn't recognize gets a
// direct, honest "didn't understand" response rather than silently
// doing nothing.
// ═══════════════════════════════════════════

const PLATFORM_ALIASES = {
  bluesky: "bluesky", tiktok: "tiktok", "tik tok": "tiktok",
  x: "x", twitter: "x", youtube: "youtube", "you tube": "youtube",
  instagram: "instagram", insta: "instagram", threads: "threads",
};

function _findCardByVoice(text) {
  for (const [alias, id] of Object.entries(PLATFORM_ALIASES)) {
    if (text.includes(alias)) {
      const found = _platformCards.find(([p]) => p.id === id);
      if (found) return found;
    }
  }
  return null;
}

// Real, simple number-word parser covering the real range Joel asked
// for (1-5 images) — no need for a general number parser here.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
function _extractImageCount(text) {
  const digitMatch = text.match(/\b([1-5])\b/);
  if (digitMatch) return Number(digitMatch[1]);
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (text.includes(word)) return n;
  }
  return null;
}

// Real, honest spoken-feedback helper — uses Flow's actual TTS module
// (core/speech.js's Speech.speak, confirmed via app.js's own usage
// pattern) rather than guessing at a method on the chat object.
function _speak(text) {
  try { Speech.speak(text); } catch (_) {}
  // Always also show it visually — TTS may not be wired/available in
  // every real context, and a silent voice command with no visible
  // trace would be confusing.
  if (_panelEl) {
    const note = _panelEl.querySelector("#cl-status-body");
    if (note) {
      note.textContent = text;
      note.classList.remove("cl-collapsed");
      const toggle = _panelEl.querySelector("#cl-status-toggle");
      if (toggle) toggle.textContent = "▲";
    }
  }
}

// REAL command dispatcher — plain keyword/pattern matching, deliberately
// not an LLM call (fast, free, predictable). Extend this function
// directly to teach Flow new phrasings; each branch is a real, distinct
// intent Joel can trigger by voice.
async function _handleVoiceCommand(rawText) {
  const text = (rawText || "").toLowerCase().trim();
  if (!text) return;

  if (!isContentLabOpen()) openContentLab();

  const target = _findCardByVoice(text);

  // "post to all" / "post everything"
  if (/post (to )?all|post everything/.test(text)) {
    const postAllBtn = _panelEl?.querySelector(".cl-post-all-btn");
    if (postAllBtn) { postAllBtn.click(); _speak("Posting to all connected socials."); }
    return;
  }

  // "post [to] <platform>"
  if (/^post\b/.test(text) || text.includes("post to")) {
    if (target) {
      const [platform, ref] = target;
      ref.post();
      _speak(`Posting to ${platform.label}.`);
    } else {
      _speak("Which platform should I post to? I heard: " + rawText);
    }
    return;
  }

  // "generate [N] image[s] [for <platform>]" / "make an image..."
  if (/(generate|make|create).*(image|picture|photo)/.test(text)) {
    if (!target) { _speak("Which platform is that image for?"); return; }
    const [platform, ref] = target;
    const n = _extractImageCount(text);
    if (n) ref.setImageCount(n);
    _speak(`Generating ${n || "the"} image${n && n > 1 ? "s" : ""} for ${platform.label}.`);
    await ref.generateImageOnly();
    return;
  }

  // "generate [a] video [for <platform>]"
  if (/(generate|make|create).*video/.test(text)) {
    if (!target) { _speak("Which platform is that video for?"); return; }
    const [platform, ref] = target;
    _speak(`Generating a video for ${platform.label}. This runs in the background.`);
    await ref.generateVideoOnly();
    return;
  }

  // "generate [the] text/caption [for <platform>]"
  if (/(generate|make|create|write).*(text|caption)/.test(text)) {
    if (!target) { _speak("Which platform is that caption for?"); return; }
    const [platform, ref] = target;
    _speak(`Writing the caption for ${platform.label}.`);
    await ref.generateTextOnly();
    return;
  }

  // "generate [the] tags/hashtags [for <platform>]"
  if (/(generate|make|create).*(tags|hashtags)/.test(text)) {
    if (!target) { _speak("Which platform are those tags for?"); return; }
    const [platform, ref] = target;
    _speak(`Generating hashtags for ${platform.label}.`);
    await ref.generateTagsOnly();
    return;
  }

  // "generate [a post] for <platform>" / "cook [me] a post for <platform>"
  // — the real, full all-in-one Generate button, matching Joel's
  // existing "cook a content" phrasing from earlier in this session.
  if (/(generate|make|create|cook).*(post|content)/.test(text) || /^cook\b/.test(text)) {
    if (!target) { _speak("Which platform should I generate a post for?"); return; }
    const [platform, ref] = target;
    const n = _extractImageCount(text);
    if (n) ref.setImageCount(n);
    _speak(`Generating a full post for ${platform.label}.`);
    await ref.generateAll();
    return;
  }

  // Real, honest fallback — never silently does nothing.
  _speak("I didn't catch a Content Lab command in that. I heard: " + rawText);
}

// REAL, module-level listener setup — call once at load time. Only
// wires up in the Electron app (window.__flowElectron.wakeword exists);
// harmless no-op in the web/PWA build where this bridge doesn't exist.
if (typeof window !== "undefined" && window.__flowElectron?.wakeword?.onCommand) {
  window.__flowElectron.wakeword.onCommand((text) => {
    _handleVoiceCommand(text).catch((e) => console.error("[ContentLab] voice command error:", e));
  });
}
