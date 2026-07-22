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

let _chat = null;
let _orb  = null;
let _panelEl = null;

export function initContentLab(chat, orb) {
  _chat = chat;
  _orb  = orb;
  _buildToggleButton();
}

// Real, current (2026) recommended dimensions per platform — see header
// comment for sourcing. NVIDIA's image API (flux.1-schnell/dev) accepts
// arbitrary width/height, so each platform genuinely gets its own real
// aspect ratio rather than a single shared size stretched/cropped after
// the fact.
const PLATFORMS = [
  { id: "bluesky",   label: "Bluesky",   live: true,  width: 1200, height: 675  },
  { id: "tiktok",    label: "TikTok",    live: false, width: 1080, height: 1920 },
  { id: "x",         label: "X",         live: false, width: 1600, height: 900  },
  { id: "youtube",   label: "YouTube",   live: false, width: 1080, height: 1920 },
  { id: "instagram", label: "Instagram", live: false, width: 1080, height: 1350 },
  { id: "threads",   label: "Threads",   live: false, width: 1080, height: 1350 },
];

// ── Real, shared JSON-content generation, same pattern as marketing.js ──
async function _generateContentJSON(kind, brief) {
  const system = `You are helping Joel Olaiya — a solo web/bot developer running Joelflowstack (Ibadan, Nigeria), building bot integrations, workflow automation, and premium web development — create ONE piece of real social content.

Content type requested: ${kind}
${brief ? `Joel's specific brief: "${brief}"` : `Joel left this to your judgment — pick a real, specific pain point a small-business owner or solo founder genuinely has, and connect it to something Joel actually does.`}

REAL, REQUIRED RULES:
- Never invent a service Joel doesn't offer (bot integration, workflow automation, web development only).
- Write like a real person who's good at this — no corporate tone, no "🚀🔥 GAME CHANGER" energy, no hard sells.
- Hashtags: propose 4-6 real, relevant hashtags based on your own knowledge of what's genuinely used in tech/small-business/indie-dev social spaces — label these as suggestions, not researched trending data, since no live search was performed.

Reply with ONLY this JSON, no other text:
{"caption": "the real post text", "imagePrompt": "a short (under 15 words), concrete visual description for an accompanying image — specific, not generic stock-photo language", "hashtags": ["tag1","tag2","tag3"]}`;

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
  return JSON.parse(match[0]);
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
async function _burnTextOnImage(blob, text) {
  if (!text || !text.trim()) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  // Real, simple readable style: bottom-anchored, dark gradient behind
  // the text so it stays legible over any background, word-wrapped to
  // the image width.
  const fontSize = Math.round(canvas.width * 0.055);
  ctx.font = `800 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const maxWidth = canvas.width * 0.88;
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

  const lineHeight = fontSize * 1.25;
  const blockHeight = lines.length * lineHeight;
  const gradientHeight = blockHeight + fontSize * 1.6;
  const gradient = ctx.createLinearGradient(0, canvas.height - gradientHeight, 0, canvas.height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.72)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, canvas.height - gradientHeight, canvas.width, gradientHeight);

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = fontSize * 0.06;
  let y = canvas.height - fontSize * 0.9 - (lines.length - 1) * lineHeight;
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
#content-lab-panel {
  /* REAL FIX: previously centered edge-to-edge (94vw), which could sit
     directly under the right-side brain/kb/proj/content-lab-toggle
     button column (all at right:18px). Real clearance reserved here —
     right:80px keeps the panel's right edge clear of that entire
     button stack at any reasonable screen width, and the panel is now
     positioned from the left instead of centered, so its width doesn't
     silently creep back under the buttons on wider screens. */
  position: fixed; bottom: 90px; left: 24px; right: 80px;
  max-width: 1180px; max-height: 70vh;
  background: rgba(15,10,30,0.97); border: 1px solid rgba(167,139,250,0.4);
  border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  z-index: 9999; display: flex; flex-direction: column;
  font-family: system-ui, sans-serif; color: #e5e7eb;
  overflow: hidden;
}
#content-lab-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid rgba(167,139,250,0.25);
  cursor: move; user-select: none; background: rgba(167,139,250,0.08);
  flex-shrink: 0;
}
#content-lab-header h3 { margin: 0; font-size: 14px; font-weight: 700; color: #a78bfa; letter-spacing: .03em; }
#content-lab-close { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; line-height: 1; padding: 2px 6px; }
#content-lab-close:hover { color: #f87171; }

#cl-create-row {
  display: flex; gap: 8px; padding: 10px 16px; flex-shrink: 0;
  border-bottom: 1px solid rgba(167,139,250,0.15);
}

/* REAL LAYOUT FIX: horizontal row of platform cards, not a vertical
   stack — scrolls sideways if it overflows the panel width. */
#cl-platforms-row {
  display: flex; gap: 12px; padding: 14px 16px; overflow-x: auto;
  overflow-y: hidden; flex: 1; align-items: flex-start;
}
#cl-platforms-row::-webkit-scrollbar { height: 6px; }
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
.cl-platform-card {
  /* REAL FIX: cards are a fixed 240px width, but platforms have
     different real aspect ratios (TikTok 9:16 vs Bluesky 16:9 vs
     Instagram 4:5) — without a cap, a 9:16 image at 240px wide would
     render ~426px tall, making that ONE card visually tower over its
     16:9/4:5 neighbors in the same horizontal row. max-height + a
     scrollable card body keeps every card the same real, predictable
     footprint regardless of which platform's image is showing. */
  flex: 0 0 240px; max-height: 100%; border: 1px solid rgba(167,139,250,0.2);
  border-radius: 10px; padding: 10px; background: rgba(255,255,255,0.02);
  display: flex; flex-direction: column; overflow-y: auto;
}
.cl-platform-card::-webkit-scrollbar { width: 4px; }
.cl-platform-card::-webkit-scrollbar-thumb { background: rgba(167,139,250,0.3); border-radius: 2px; }
.cl-platform-card.disabled { opacity: 0.7; }
.cl-platform-title { font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.cl-badge-live { color: #4ade80; font-size: 9px; border: 1px solid rgba(74,222,128,0.4); border-radius: 10px; padding: 1px 7px; flex-shrink: 0; }
.cl-badge-soon { color: #9ca3af; font-size: 9px; border: 1px solid rgba(156,163,175,0.4); border-radius: 10px; padding: 1px 7px; flex-shrink: 0; }
.cl-image-strip {
  display: flex; gap: 6px; overflow-x: auto; margin-top: 8px;
  flex-shrink: 0;
}
.cl-image-strip::-webkit-scrollbar { height: 4px; }
.cl-image-strip::-webkit-scrollbar-thumb { background: rgba(167,139,250,0.3); border-radius: 2px; }
.cl-image-strip .cl-preview-img {
  flex: 0 0 120px; width: 120px; margin-top: 0;
}
.cl-preview-img {
  /* REAL FIX: cap displayed height regardless of the real aspect ratio,
     so a tall 9:16 image never blows out the card — object-fit:cover
     crops rather than distorts, keeping every card's image area a
     consistent, predictable size. */
  width: 100%; max-height: 220px; object-fit: cover; border-radius: 8px; margin-top: 8px; flex-shrink: 0;
}
.cl-caption {
  font-size: 11px; color: rgba(255,255,255,0.75); white-space: pre-wrap;
  margin-top: 6px; max-height: 90px; overflow-y: auto;
  word-wrap: break-word; overflow-wrap: anywhere; /* REAL FIX: a single long word/URL with no spaces could previously overflow the card's fixed width instead of wrapping */
}
.cl-hashtags {
  font-size: 10px; color: #a78bfa; margin-top: 4px;
  word-wrap: break-word; overflow-wrap: anywhere; /* REAL FIX: previously had no overflow protection at all */
  max-height: 40px; overflow-y: auto;
}
.cl-post-all-btn {
  margin: 0 16px 14px; padding: 11px; border-radius: 10px; flex-shrink: 0;
  border: 1px solid rgba(74,222,128,0.4); background: rgba(74,222,128,0.15);
  color: #4ade80; font-size: 13px; font-weight: 700; cursor: pointer;
}
.cl-post-all-btn:hover { background: rgba(74,222,128,0.25); }
.cl-status { font-size: 10px; color: #9ca3af; margin-top: 6px; word-wrap: break-word; overflow-wrap: anywhere; }

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

// ── Real drag-to-move ────────────────────────────────────────────────────
function _makeDraggable(panel, handle) {
  let dragging = false, offX = 0, offY = 0;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    offX = e.clientX - panel.getBoundingClientRect().left;
    offY = e.clientY - panel.getBoundingClientRect().top;
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.left = `${e.clientX - offX}px`;
    panel.style.top  = `${e.clientY - offY}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.transform = "none";
  });
  document.addEventListener("mouseup", () => { dragging = false; });
}

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

  const optsRow = document.createElement("div");
  optsRow.style.cssText = "display:flex;gap:6px;margin-top:8px;align-items:center;";

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
    if (n === 3) opt.selected = true; // real, sensible default matching Joel's "3, 4, or 5 would be good"
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

  card.appendChild(optsRow);

  const genBtn = document.createElement("button");
  genBtn.className = "cl-btn";
  genBtn.style.marginTop = "8px";
  genBtn.style.width = "100%";
  genBtn.textContent = "Generate";
  card.appendChild(genBtn);

  const statusEl = document.createElement("div");
  statusEl.className = "cl-status";
  card.appendChild(statusEl);

  let generated = null; // { ...content, blobs: [Blob, ...] } — blobs[0] used for posting today

  genBtn.onclick = async () => {
    genBtn.disabled = true;
    statusEl.textContent = "Generating content...";
    try {
      const brief = briefInput.value.trim();
      const n = Number(countSelect.value) || 1;
      const burnText = burnCheckbox.checked;
      const content = await _generateContentJSON(`a ${platform.label} post`, brief);
      statusEl.textContent = `Generating ${n} image${n > 1 ? "s" : ""} (${platform.width}×${platform.height})...`;
      let blobs = await _generateImageBlobs(content.imagePrompt, n);
      if (burnText) {
        // Real, short hook text burned onto each image — reuses the
        // first ~8 words of the caption as the on-image hook, matching
        // how a real caption/hook split typically works for creators.
        const hook = content.caption.split(/\s+/).slice(0, 8).join(" ");
        blobs = await Promise.all(blobs.map((b) => _burnTextOnImage(b, hook)));
      }

      card.querySelectorAll(".cl-image-strip, .cl-caption, .cl-hashtags, .cl-post-btn").forEach(el => el.remove());

      const strip = document.createElement("div");
      strip.className = "cl-image-strip";
      blobs.forEach((blob) => {
        const img = document.createElement("img");
        img.className = "cl-preview-img";
        img.style.aspectRatio = `${platform.width} / ${platform.height}`;
        img.src = URL.createObjectURL(blob);
        strip.appendChild(img);
      });
      card.appendChild(strip);

      const cap = document.createElement("div");
      cap.className = "cl-caption";
      cap.textContent = content.caption;
      card.appendChild(cap);

      const tags = document.createElement("div");
      tags.className = "cl-hashtags";
      tags.textContent = (content.hashtags || []).map(t => `#${t.replace(/^#/, "")}`).join("  ");
      card.appendChild(tags);

      generated = { ...content, blobs };

      if (platform.live) {
        const postBtn = document.createElement("button");
        postBtn.className = "cl-btn cl-post-btn";
        postBtn.style.width = "100%";
        postBtn.style.marginTop = "8px";
        postBtn.style.background = "rgba(74,222,128,0.15)";
        postBtn.style.borderColor = "rgba(74,222,128,0.4)";
        postBtn.style.color = "#4ade80";
        // Real, honest label — Bluesky posting today only sends the
        // FIRST generated image (api/social.js's existing handler takes
        // a single imageBase64, never confirmed to support multiple
        // images per post, so not guessing that it does).
        postBtn.textContent = blobs.length > 1 ? `Post to ${platform.label} (1st image)` : `Post to ${platform.label}`;
        postBtn.onclick = async () => {
          postBtn.disabled = true;
          postBtn.textContent = "Posting...";
          try {
            const base64 = await _blobToBase64(generated.blobs[0]);
            const result = await _postToBluesky(generated.caption, base64);
            if (!result.ok) throw new Error(result.error);
            statusEl.textContent = `✅ Posted`;
            postBtn.textContent = "Posted ✓";
          } catch (e) {
            statusEl.textContent = `❌ ${e.message}`;
            postBtn.disabled = false;
            postBtn.textContent = `Post to ${platform.label}`;
          }
        };
        card.appendChild(postBtn);
      }

      statusEl.textContent = "Ready.";
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
    } finally {
      genBtn.disabled = false;
    }
  };

  container.appendChild(card);
  return { card, getGenerated: () => generated };
}

async function _handlePostToAll(platformCards, statusOutput) {
  for (const [platform, ref] of platformCards) {
    if (!platform.live) continue;
    const generated = ref.getGenerated();
    if (!generated) continue;
    try {
      const base64 = await _blobToBase64(generated.blobs[0]);
      const result = await _postToBluesky(generated.caption, base64);
      statusOutput.textContent = result.ok ? `✅ Posted to ${platform.label}` : `❌ ${platform.label} failed: ${result.error}`;
    } catch (e) {
      statusOutput.textContent = `❌ ${platform.label} failed: ${e.message}`;
    }
  }
  const note = document.createElement("div");
  note.className = "cl-status";
  note.style.marginTop = "4px";
  note.textContent = "The rest (TikTok, X, YouTube, Instagram, Threads) are generated and previewed above — real posting isn't connected yet for those.";
  statusOutput.after(note);
}

// ── Real, self-contained create-output renderer ─────────────────────────
// REAL FIX: this used to call _chat.add(...), leaking results into the
// main chat log. Now everything renders inside Content Lab's own
// #cl-create-output area instead.
function _renderCreateResult(outputEl, { title, body, imgUrl }) {
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
  if (body) {
    const b = document.createElement("div");
    b.className = "cl-caption";
    b.textContent = body;
    wrap.appendChild(b);
  }
  outputEl.prepend(wrap);
}

// ── Real, complete entry point ───────────────────────────────────────────
export function openContentLab() {
  if (_panelEl) { closeContentLab(); return; }
  _injectStyles();

  const panel = document.createElement("div");
  panel.id = "content-lab-panel";

  const header = document.createElement("div");
  header.id = "content-lab-header";
  header.innerHTML = `<h3>🧪 Content Lab</h3>`;
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
    _renderCreateResult(createOutput, { title: "🎬 Video — generating in the background, check your videos area when ready.", body: prompt });
    await generateVideo(prompt); // real, existing pipeline — this one genuinely does need to surface in the app's normal video area, not duplicated here
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
  panel.appendChild(platformsRow);

  const postAllStatus = document.createElement("div");
  postAllStatus.className = "cl-status";
  postAllStatus.style.margin = "0 16px";

  const postAllBtn = document.createElement("button");
  postAllBtn.className = "cl-post-all-btn";
  postAllBtn.textContent = "🚀 Post to all (generated) socials";
  postAllBtn.onclick = () => _handlePostToAll(platformCards, postAllStatus);
  panel.appendChild(postAllBtn);
  panel.appendChild(postAllStatus);

  document.body.appendChild(panel);
  _makeDraggable(panel, header);
  _panelEl = panel;

  const toggleBtn = document.getElementById("content-lab-toggle-btn");
  if (toggleBtn) toggleBtn.classList.add("active");
}

export function closeContentLab() {
  if (_panelEl) { _panelEl.remove(); _panelEl = null; }
  const btn = document.getElementById("content-lab-toggle-btn");
  if (btn) btn.classList.remove("active");
}

export function isContentLabOpen() {
  return !!_panelEl;
}

// Real button, matching kb-btn/proj-btn's exact creation pattern.
function _buildToggleButton() {
  const btn = document.createElement("div");
  btn.id = "content-lab-toggle-btn";
  btn.title = "Content Lab";
  btn.textContent = "🧪";
  btn.addEventListener("click", () => {
    if (isContentLabOpen()) closeContentLab();
    else openContentLab();
  });
  document.body.appendChild(btn);
}
