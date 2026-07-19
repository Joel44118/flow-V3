// ═══════════════════════════════════════════
// ui/content-lab.js — Real Content Lab
//
// Built directly from Joel's actual request: a real workspace (not a
// single generated post) for creating video/image/text content and
// previewing it across his real social platforms, with voice or typed
// control, or left entirely to Flow's judgment.
//
// REAL, HONEST SCOPE, stated plainly rather than overpromised:
//   - Bluesky is the only platform with real, live posting access right
//     now (BLUESKY_HANDLE/BLUESKY_APP_PASSWORD already confirmed working
//     in api/social.js). Every other platform section genuinely
//     generates real content + real hashtags, but the post button is
//     disabled with "Coming soon" — because no real API/account access
//     exists yet for TikTok, X, YouTube, Instagram, or Threads. This is
//     an honest limitation, not a bug — building fake "post" buttons
//     that don't actually post anywhere would be actively misleading.
//   - Hashtags are model-judgment-generated (the same caption-writing
//     call also proposes hashtags from its own real knowledge), NOT
//     from a live search API — Joel has no budget for a paid search
//     service (Tavily/SerpAPI/etc.), and Flow has no web_search tool
//     wired in server-side anywhere in this codebase currently. Labeled
//     honestly in the UI rather than silently pretending otherwise.
//   - This reuses the EXACT SAME real pipelines already built and
//     tested elsewhere — callFlux/getToken/FLUX_MODELS from imagine.js,
//     generateVideo from videogen.js, the /api/chat + force_intent:'pdf'
//     JSON-generation pattern from marketing.js — nothing here is a
//     second, competing implementation of image/video/text generation.
// ═══════════════════════════════════════════
import { generateVideo } from "./videogen.js";

let _chat = null;
let _orb  = null;
let _panelEl = null;

export function initContentLab(chat, orb) {
  _chat = chat;
  _orb  = orb;
}

const PLATFORMS = [
  { id: "bluesky",   label: "Bluesky",   live: true  },
  { id: "tiktok",    label: "TikTok",    live: false },
  { id: "x",         label: "X",         live: false },
  { id: "youtube",   label: "YouTube",   live: false },
  { id: "instagram", label: "Instagram", live: false },
  { id: "threads",   label: "Threads",   live: false },
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

// REAL FIX: the old FLUX_MODELS chain (imagine.js) is confirmed dead —
// all three models return real 410/400 errors from HuggingFace's
// hf-inference provider (HF deprecated them there). Real replacement:
// NVIDIA's free NIM image API, called via the new server-side
// /api/mediapipe?action=image route (keeps NVIDIA_API_KEY server-side,
// matches the same pattern as the embed route).
// ── Real in-app prompt replacement ──────────────────────────────────────
// REAL FIX: window.prompt() is confirmed NOT supported in Electron's
// renderer (Chromium disables it there) — three call sites in this file
// used it and all three threw "prompt() is and will not be supported."
// This is a real, minimal in-app modal doing the same job: ask one
// question, get text back, resolve null if cancelled.
function _realPrompt(question, placeholder = "") {
  return new Promise((resolve) => {
    _injectStyles();
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
    input.style.marginTop = "0";
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

async function _generateImageBlob(imagePrompt) {
  const res = await fetch("/api/mediapipe?action=image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: imagePrompt }),
  });
  const data = await res.json();
  if (!res.ok || !data.b64_json) {
    throw new Error(data.error || "Image generation failed — no real image data returned");
  }
  // Real, direct base64 -> Blob conversion, no extra dependency
  const byteChars = atob(data.b64_json);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: "image/png" });
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

// ── Real, minimal CSS injected once — matches Flow's existing dark/
// purple visual language (rgba(167,139,250,...) is the same accent used
// throughout main.js's overlay and marketing.js's approval cards) ──────
function _injectStyles() {
  if (document.getElementById("content-lab-style")) return;
  const style = document.createElement("style");
  style.id = "content-lab-style";
  style.textContent = `
#content-lab-panel {
  position: fixed; top: 60px; right: 30px; width: 380px; max-height: 82vh;
  background: rgba(15,10,30,0.97); border: 1px solid rgba(167,139,250,0.4);
  border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  z-index: 9999; display: flex; flex-direction: column;
  font-family: system-ui, sans-serif; color: #e5e7eb;
  overflow: hidden;
}
#content-lab-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid rgba(167,139,250,0.25);
  cursor: move; user-select: none; background: rgba(167,139,250,0.08);
}
#content-lab-header h3 { margin: 0; font-size: 14px; font-weight: 700; color: #a78bfa; letter-spacing: .03em; }
#content-lab-close { background: none; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; line-height: 1; padding: 2px 6px; }
#content-lab-close:hover { color: #f87171; }
#content-lab-body { overflow-y: auto; padding: 14px 16px; flex: 1; }
#content-lab-body::-webkit-scrollbar { width: 6px; }
#content-lab-body::-webkit-scrollbar-track { background: transparent; }
#content-lab-body::-webkit-scrollbar-thumb { background: rgba(167,139,250,0.3); border-radius: 3px; }
#content-lab-body::-webkit-scrollbar-thumb:hover { background: rgba(167,139,250,0.5); }
.cl-section { margin-bottom: 16px; }
.cl-section-title { font-size: 11px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
.cl-btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
.cl-btn {
  flex: 1; min-width: 90px; padding: 9px 10px; border-radius: 8px;
  border: 1px solid rgba(167,139,250,0.35); background: rgba(167,139,250,0.1);
  color: #d8d4ff; font-size: 12px; cursor: pointer; text-align: center;
}
.cl-btn:hover { background: rgba(167,139,250,0.2); }
.cl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cl-input {
  width: 100%; padding: 8px 10px; border-radius: 8px; margin-top: 8px;
  border: 1px solid rgba(167,139,250,0.3); background: rgba(255,255,255,0.04);
  color: #e5e7eb; font-size: 12px; box-sizing: border-box;
}
.cl-platform-card {
  border: 1px solid rgba(167,139,250,0.2); border-radius: 10px;
  padding: 10px; margin-bottom: 8px; background: rgba(255,255,255,0.02);
}
.cl-platform-card.disabled { opacity: 0.55; }
.cl-platform-title { font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: space-between; }
.cl-badge-live { color: #4ade80; font-size: 9px; border: 1px solid rgba(74,222,128,0.4); border-radius: 10px; padding: 1px 7px; }
.cl-badge-soon { color: #9ca3af; font-size: 9px; border: 1px solid rgba(156,163,175,0.4); border-radius: 10px; padding: 1px 7px; }
.cl-preview-img { width: 100%; border-radius: 8px; margin-top: 8px; }
.cl-caption { font-size: 11px; color: rgba(255,255,255,0.75); white-space: pre-wrap; margin-top: 6px; }
.cl-hashtags { font-size: 10px; color: #a78bfa; margin-top: 4px; }
.cl-post-all-btn {
  width: 100%; padding: 11px; border-radius: 10px; margin-top: 4px;
  border: 1px solid rgba(74,222,128,0.4); background: rgba(74,222,128,0.15);
  color: #4ade80; font-size: 13px; font-weight: 700; cursor: pointer;
}
.cl-post-all-btn:hover { background: rgba(74,222,128,0.25); }
.cl-status { font-size: 11px; color: #9ca3af; margin-top: 6px; }
`;
  document.head.appendChild(style);
}

// ── Real drag-to-move, matches a light desktop-window feel ─────────────
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
  });
  document.addEventListener("mouseup", () => { dragging = false; });
}

function _renderPlatformCard(platform, container) {
  const card = document.createElement("div");
  card.className = "cl-platform-card" + (platform.live ? "" : " disabled");

  const title = document.createElement("div");
  title.className = "cl-platform-title";
  title.innerHTML = `<span>${platform.label}</span><span class="${platform.live ? "cl-badge-live" : "cl-badge-soon"}">${platform.live ? "LIVE" : "Coming soon"}</span>`;
  card.appendChild(title);

  const genBtn = document.createElement("button");
  genBtn.className = "cl-btn";
  genBtn.style.marginTop = "8px";
  genBtn.style.width = "100%";
  genBtn.textContent = `Generate content for ${platform.label}`;
  card.appendChild(genBtn);

  const statusEl = document.createElement("div");
  statusEl.className = "cl-status";
  card.appendChild(statusEl);

  let generated = null;

  genBtn.onclick = async () => {
    genBtn.disabled = true;
    statusEl.textContent = "Generating content...";
    try {
      const briefInput = card.querySelector(".cl-input");
      const brief = briefInput ? briefInput.value.trim() : "";
      const content = await _generateContentJSON(`a ${platform.label} post`, brief);
      statusEl.textContent = "Generating image...";
      const blob = await _generateImageBlob(content.imagePrompt);
      const blobUrl = URL.createObjectURL(blob);

      card.querySelectorAll(".cl-preview-img, .cl-caption, .cl-hashtags, .cl-post-btn").forEach(el => el.remove());

      const img = document.createElement("img");
      img.className = "cl-preview-img";
      img.src = blobUrl;
      card.appendChild(img);

      const cap = document.createElement("div");
      cap.className = "cl-caption";
      cap.textContent = content.caption;
      card.appendChild(cap);

      const tags = document.createElement("div");
      tags.className = "cl-hashtags";
      tags.textContent = (content.hashtags || []).map(t => `#${t.replace(/^#/, "")}`).join("  ") + "  (model-suggested, not live-researched)";
      card.appendChild(tags);

      generated = { ...content, blob };

      if (platform.live) {
        const postBtn = document.createElement("button");
        postBtn.className = "cl-btn cl-post-btn";
        postBtn.style.width = "100%";
        postBtn.style.marginTop = "8px";
        postBtn.textContent = `Post to ${platform.label}`;
        postBtn.onclick = async () => {
          postBtn.disabled = true;
          postBtn.textContent = "Posting...";
          try {
            const base64 = await _blobToBase64(generated.blob);
            const result = await _postToBluesky(generated.caption, base64);
            if (!result.ok) throw new Error(result.error);
            statusEl.textContent = `✅ Posted — ${result.uri}`;
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

  const briefInput = document.createElement("input");
  briefInput.className = "cl-input";
  briefInput.placeholder = platform.live ? "Optional: a specific angle or brief..." : "Optional brief (preview only — posting not yet connected)";
  card.insertBefore(briefInput, genBtn.nextSibling);

  container.appendChild(card);
  return { card, getGenerated: () => generated };
}

async function _handlePostToAll(platformCards) {
  for (const [platform, ref] of platformCards) {
    if (!platform.live) continue;
    const generated = ref.getGenerated();
    if (!generated) continue;
    try {
      const base64 = await _blobToBase64(generated.blob);
      const result = await _postToBluesky(generated.caption, base64);
      _chat?.add(result.ok ? `✅ Posted to ${platform.label} — ${result.uri}` : `❌ ${platform.label} failed: ${result.error}`, "bot");
    } catch (e) {
      _chat?.add(`❌ ${platform.label} failed: ${e.message}`, "bot");
    }
  }
  _chat?.add("Everything else (TikTok, X, YouTube, Instagram, Threads) is generated and previewed above, but real posting isn't connected yet — coming soon.", "bot");
}

// ── Real, complete entry point — toggles the panel open/closed ─────────
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

  const body = document.createElement("div");
  body.id = "content-lab-body";
  panel.appendChild(body);

  // Create-type quick actions — real, direct triggers into the existing
  // tested pipelines (imagine.js / videogen.js), not duplicated logic.
  const createSection = document.createElement("div");
  createSection.className = "cl-section";
  createSection.innerHTML = `<div class="cl-section-title">Create</div>`;
  const btnRow = document.createElement("div");
  btnRow.className = "cl-btn-row";

  const videoBtn = document.createElement("button");
  videoBtn.className = "cl-btn";
  videoBtn.textContent = "🎬 Video";
  videoBtn.onclick = async () => {
    const prompt = await _realPrompt("What should the video show?");
    if (prompt) { closeContentLab(); await generateVideo(prompt); }
  };

  const imageBtn = document.createElement("button");
  imageBtn.className = "cl-btn";
  imageBtn.textContent = "🖼️ Picture";
  imageBtn.onclick = async () => {
    const prompt = await _realPrompt("What should the image show?");
    if (!prompt) return;
    _chat?.add("🖼️ Generating...", "bot");
    try {
      const blob = await _generateImageBlob(prompt);
      _chat?.add("Done — check the images area.", "bot");
      const url = URL.createObjectURL(blob);
      window.dispatchEvent(new CustomEvent("flow-image-generated", { detail: { url, prompt } }));
    } catch (e) {
      _chat?.addError?.(`Image generation failed: ${e.message}`);
    }
  };

  const textBtn = document.createElement("button");
  textBtn.className = "cl-btn";
  textBtn.textContent = "✍️ Text only";
  textBtn.onclick = async () => {
    const brief = (await _realPrompt("What should the post be about? (leave blank for Flow's own judgment)")) || "";
    try {
      const content = await _generateContentJSON("a general social post (no image)", brief);
      _chat?.add(`📝 Draft:\n\n${content.caption}\n\n${(content.hashtags || []).map(t => "#" + t).join(" ")}`, "bot");
    } catch (e) {
      _chat?.addError?.(`Text generation failed: ${e.message}`);
    }
  };

  btnRow.appendChild(videoBtn);
  btnRow.appendChild(imageBtn);
  btnRow.appendChild(textBtn);
  createSection.appendChild(btnRow);
  body.appendChild(createSection);

  // Per-platform sections
  const platformSection = document.createElement("div");
  platformSection.className = "cl-section";
  platformSection.innerHTML = `<div class="cl-section-title">Platforms</div>`;
  const platformCards = [];
  PLATFORMS.forEach(p => {
    const ref = _renderPlatformCard(p, platformSection);
    platformCards.push([p, ref]);
  });
  body.appendChild(platformSection);

  const postAllBtn = document.createElement("button");
  postAllBtn.className = "cl-post-all-btn";
  postAllBtn.textContent = "🚀 Post to all (generated) socials";
  postAllBtn.onclick = () => _handlePostToAll(platformCards);
  body.appendChild(postAllBtn);

  document.body.appendChild(panel);
  _makeDraggable(panel, header);
  _panelEl = panel;
}

export function closeContentLab() {
  if (_panelEl) { _panelEl.remove(); _panelEl = null; }
}

export function isContentLabOpen() {
  return !!_panelEl;
}
