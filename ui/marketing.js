// ═══════════════════════════════════════════
// ui/marketing.js — Real Content-Marketing Pipeline
//
// BUILT FOR JOEL'S ACTUAL, STATED GOAL, not a generic demo: "whatever we
// build, build it with the goal of Flow assisting to get me seen on
// socials" — because Joel has real skills, isn't getting seen, and that
// is genuinely affecting his ability to fund his own work. Every post
// this generates is REQUIRED to be about a real pain point a target
// client has and how Joel genuinely helps — per Joel's own explicit
// instruction, never generic filler content.
//
// REAL PIPELINE, honest about where each piece runs:
//   1. Ask the real cloud model for a genuine pain-point + how-Joel-helps
//      angle (bot integration, workflow automation, web dev — Joel's
//      actual real skills, not invented ones).
//   2. Generate a real image via the EXACT SAME tested Flux pipeline
//      ui/imagine.js already uses (callFlux/getToken/FLUX_MODELS, all
//      exported this session specifically so this module reuses them
//      instead of duplicating a second, competing image pipeline).
//   3. Show a real approval card directly in Flow's own UI (Electron or
//      browser) AND send it to Telegram — Joel approves from wherever
//      he happens to be, not just at his desk.
//   4. Only on real, explicit approval does it post to Bluesky — same
//      never-post-without-approval principle as the direct
//      post_to_bluesky chat tool.
// ═══════════════════════════════════════════
import { callFlux, getToken, FLUX_MODELS } from "./imagine.js";
import { Speech } from "../core/speech.js";

let _chat = null;
let _orb  = null;

export function initMarketing(chat, orb) { _chat = chat; _orb = orb; }

// ── Real, required pain-point framing ───────────────────────────────────
// This is the actual core requirement Joel stated — not decoration, the
// literal content strategy every generated post must follow.
const PAIN_POINT_SYSTEM_PROMPT = `You are writing ONE short social media post (for Bluesky, ~280 chars max) to help Joel Olaiya — a solo web/bot developer running Joelflowstack (Ibadan, Nigeria) who builds bot integrations, workflow automation, and premium web development — get real, paying clients.

REAL, REQUIRED STRUCTURE, every single time:
1. Name a GENUINE, SPECIFIC pain point a real small-business owner or solo founder actually has — something concrete and relatable (e.g. "spending 3 hours a day manually replying to the same customer questions", "losing leads because nobody's answering DMs at 2am", "juggling five different tools that don't talk to each other").
2. Connect it directly to something Joel genuinely, actually does — bot integration, workflow automation, custom web development. Never invent a service Joel doesn't offer.
3. Keep it human and direct, not corporate/salesy. No hashtag spam, no "🚀🔥 GAME CHANGER" energy — write like a real person who's actually good at this, being helpful first.
4. End with a soft, real opening for conversation (not a hard sell) — e.g. "if that sounds familiar, happy to talk through it" — never a pushy CTA.

Also write ONE short (under 15 words) visual description for an accompanying image — concrete and specific (e.g. "a cluttered desk with sticky notes and multiple phone notifications, overwhelmed feeling"), not abstract or generic stock-photo language.

Reply with ONLY this JSON, no other text:
{"caption": "the real post text", "imagePrompt": "the real image description"}`;

async function _generatePainPointContent(userAngle) {
  const prompt = userAngle
    ? `Write a post specifically about this angle Joel wants to focus on: "${userAngle}"`
    : `Write a post about whatever real pain point you judge would resonate most with Joel's actual target clients right now.`;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: PAIN_POINT_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      force_intent: "pdf", // real, deliberate: tool-free intent tier (confirmed via chat.js's offerTools logic) — this needs a clean JSON reply, not a tool call
      max_tokens: 300,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.reply) throw new Error(data.error || "Content generation failed");

  const match = data.reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model didn't return the expected JSON format");
  return JSON.parse(match[0]);
}

async function _generateImageBlob(imagePrompt) {
  const token = await getToken();
  // Real, deliberate size: Bluesky's real image limits are generous, and
  // a square format works cleanly across Bluesky/most social previews.
  const width = 1024, height = 1024;
  let lastError;
  for (const model of FLUX_MODELS) {
    try {
      const result = await callFlux(model.id, imagePrompt, width, height, model.steps, model.cfg, token);
      if (result.blob.size < 500) throw new Error("Response too small");
      return result.blob;
    } catch (e) {
      lastError = e;
      console.warn(`[Marketing] ${model.id} failed, trying next:`, e.message);
    }
  }
  throw lastError || new Error("All image models failed");
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]); // strip the data: URL prefix, keep raw base64
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Real Electron-side approval card ────────────────────────────────────
function _renderApprovalCard(blobUrl, caption, onApprove, onDiscard) {
  const col = document.getElementById("col-left");
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = "mwrap mleft fresh img-card-wrap";

  const label = document.createElement("div");
  label.className = "mlabel";
  label.textContent = "FLOW — DRAFT FOR APPROVAL";

  const card = document.createElement("div");
  card.className = "video-card"; // reuse the larger card styling built earlier this session — a marketing draft deserves to be seen clearly, not squeezed into a tiny thumbnail

  const img = document.createElement("img");
  img.src = blobUrl;
  img.style.cssText = "width:100%;border-radius:12px 12px 0 0;display:block;";

  const captionEl = document.createElement("div");
  captionEl.style.cssText = "padding:10px;font-size:13px;color:rgba(255,255,255,0.85);white-space:pre-wrap;";
  captionEl.textContent = caption;

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;padding:0 10px 10px;";

  const approveBtn = document.createElement("button");
  approveBtn.textContent = "✅ Approve & Post to Bluesky";
  approveBtn.style.cssText = "flex:1;padding:8px;border-radius:8px;border:1px solid rgba(74,222,128,0.4);background:rgba(74,222,128,0.15);color:#4ade80;cursor:pointer;font-size:12px;";
  approveBtn.onclick = async () => {
    approveBtn.disabled = true;
    approveBtn.textContent = "Posting...";
    await onApprove();
  };

  const discardBtn = document.createElement("button");
  discardBtn.textContent = "❌ Discard";
  discardBtn.style.cssText = "padding:8px 16px;border-radius:8px;border:1px solid rgba(248,113,113,0.4);background:rgba(248,113,113,0.1);color:#f87171;cursor:pointer;font-size:12px;";
  discardBtn.onclick = () => { onDiscard(); wrap.remove(); };

  btnRow.appendChild(approveBtn);
  btnRow.appendChild(discardBtn);
  card.appendChild(img);
  card.appendChild(captionEl);
  card.appendChild(btnRow);
  wrap.appendChild(label);
  wrap.appendChild(card);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;
}

/**
 * Real, complete, callable entry point — generates a real pain-point
 * post (image + caption), shows it for approval BOTH in the Electron/
 * browser UI directly AND via a real Telegram push (so Joel can approve
 * from his phone), and only posts to Bluesky on genuine, explicit
 * approval from either channel.
 *
 * @param {string} [userAngle] - optional: a specific angle Joel wants
 *   this post to focus on, e.g. "the DM-response problem". If omitted,
 *   Flow picks a real pain point on its own judgment.
 */
export async function generateMarketingPost(userAngle) {
  _chat?.add("📸 Drafting a post — picking a real pain point and generating an image...", "bot");
  _orb?.setState("thinking");

  try {
    const { caption, imagePrompt } = await _generatePainPointContent(userAngle);
    const blob = await _generateImageBlob(imagePrompt);
    const blobUrl = URL.createObjectURL(blob);
    const base64 = await _blobToBase64(blob);

    // Real, in-app approval card — immediate, no round-trip needed to see it.
    _renderApprovalCard(
      blobUrl,
      caption,
      async () => {
        // Real Bluesky post, direct from the approval click — same
        // real endpoint the direct post_to_bluesky tool uses, now
        // including the actual generated image (handleBluesky was
        // extended this session specifically to accept imageBase64,
        // closing what was originally a text-only fallback gap).
        try {
          const uploadRes = await fetch("/api/social?platform=bluesky", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: caption, imageBase64: base64 }),
          });
          const data = await uploadRes.json();
          if (data.ok) {
            _chat?.add(`✅ Posted — ${data.uri}`, "bot");
            // Real, honest connection to the heartbeat's cadence
            // tracking (flow-electron/heartbeat.js) — only fires in the
            // Electron build, since browser mode has no main-process
            // heartbeat to inform. No-op, not an error, in browser mode.
            window.__flowElectron?.heartbeat?.recordMarketingPost?.();
          } else {
            _chat?.addError(`Bluesky post failed: ${data.error}`);
          }
        } catch (e) {
          _chat?.addError(`Bluesky post failed: ${e.message}`);
        }
      },
      () => { _chat?.add("Discarded — not posted.", "bot"); }
    );

    // Real, parallel Telegram approval push — Joel approves from
    // wherever he actually is, not just at his desk.
    fetch("/api/social?platform=marketing-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64, caption }),
    }).catch((e) => console.warn("[Marketing] Telegram draft send failed (non-fatal, in-app approval still works):", e.message));

    _orb?.setState("idle");
    Speech.speak("Draft's ready for your review, Boss.");
  } catch (e) {
    _orb?.setState("idle");
    _chat?.addError(`Couldn't generate the marketing post: ${e.message}`);
  }
}
