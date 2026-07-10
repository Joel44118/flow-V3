// telegram-userbot/index.js — ALWAYS-ON listener for Joel's personal Telegram
//
// Deploy this to Railway.app (free tier, ~500 hrs/month — effectively always-on
// for one small service). It holds a persistent MTProto connection to Telegram
// and auto-replies to anyone who messages Joel's personal account directly.
//
// This is SEPARATE from the Telegram Bot (api/social.js on Vercel) — that one
// only replies to people who message the bot. This one replies as Joel himself.
//
// NEW IN THIS VERSION:
//   1. Auto-blocks ALL bot accounts, always — this account (nicknamed
//      ECHO_NAME below) never auto-replies to another bot, full stop. This
//      is what kills the Flow-bot-DMs-Joel -> Echo-replies -> bot-replies
//      loop, and also stops it replying to things like @userinfobot.
//   1b. On top of that, a KV-stored username blocklist for specific humans
//      Joel doesn't want auto-replied to — just plain usernames, no ID
//      lookups needed, editable without redeploying (see bottom of file).
//   2. Per-chat activity awareness — replaces the earlier global
//      online/offline approach, which had a real flaw: the userbot's own
//      GramJS session shares Joel's account, so Telegram's account-wide
//      presence status wasn't reliably distinguishable from the
//      userbot's own connection activity. Now tracks, per conversation,
//      whether JOEL HIMSELF sent a message in that specific chat within
//      the last 5 minutes:
//        - Joel active in THIS chat: userbot stays silent. If 10+ min
//          pass with the message still unread/unanswered by Joel, it
//          sends ONE nudge asking the sender if they want to wait for
//          Joel or have Flow continue helping — then goes quiet again.
//        - Joel not recently active in this chat: full auto-reply.
//   3. Joel's own outgoing message to a chat is treated as "Joel handled
//      this" — clears the pending-nudge state for that chat immediately.
//
// ENV VARS NEEDED (set these in Railway → Variables):
//   TELEGRAM_API_ID     — from my.telegram.org/apps
//   TELEGRAM_API_HASH   — from my.telegram.org/apps
//   TELEGRAM_SESSION    — generated once via login.js, never changes after
//   FLOW_SITE_URL       — https://flow-v3-mu.vercel.app  (reuses Flow's existing AI)

const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");
const { NewMessage }     = require("telegram/events");
const { Api }            = require("telegram/tl");

const apiId    = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
const apiHash  = process.env.TELEGRAM_API_HASH || "";
const sessStr  = process.env.TELEGRAM_SESSION || "";
const SITE_URL = process.env.FLOW_SITE_URL || "https://flow-v3-mu.vercel.app";

// This account-side persona's name — kept separate from "Flow" (the Telegram
// BOT) so Joel can tell them apart in logs/notifications. Rename freely.
const ECHO_NAME = "Echo";

const NUDGE_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const PRESENCE_KEY = "flow_manual_presence"; // shared KV key, also read/written by api/social.js
const PRESENCE_AUTOREVERT_MS = 60 * 60 * 1000; // 1 hour — matches Joel's chosen timeout

if (!apiId || !apiHash || !sessStr) {
  console.error("❌ Missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION.");
  console.error("Run login.js once locally first to generate TELEGRAM_SESSION.");
  process.exit(1);
}

// ── Ask Flow's existing AI chain for a reply (reuses everything already built) ──
// Style-profile sample collection & generation — this is the genuine
// missing half of "put my brain into Echo". getPersonaBlock() below reads
// a style profile from shared KV; collectStyleSample/regenerateStyleProfile
// are what actually WRITE it, built this session (confirmed no prior code
// anywhere ever wrote flow_joel_style_profile before this).
const STYLE_SAMPLE_KEY = "flow_style_samples";
const STYLE_PROFILE_KEY = "flow_joel_style_profile";
const MAX_SAMPLES = 60;              // rolling window — recent style matters more than year-old messages
const REGEN_EVERY_N_SAMPLES = 15;    // regenerate the profile every N new real messages, not every single one

async function collectStyleSample(text) {
  const samples = (await memGet(STYLE_SAMPLE_KEY)) || [];
  const list = Array.isArray(samples) ? samples : [];
  list.push(text);
  const trimmed = list.slice(-MAX_SAMPLES);
  await memSet(STYLE_SAMPLE_KEY, trimmed);

  // Only regenerate the actual profile every REGEN_EVERY_N_SAMPLES new
  // messages — regenerating on every single outgoing message would be
  // real, unnecessary AI-call cost for something that doesn't need to
  // update that often; Joel's writing style doesn't meaningfully shift
  // message-to-message.
  if (trimmed.length > 0 && trimmed.length % REGEN_EVERY_N_SAMPLES === 0) {
    await regenerateStyleProfile(trimmed);
  }
}

async function regenerateStyleProfile(samples) {
  try {
    // Combine the real writing sample with memextract.js's extracted
    // memory (projects, preferences, decisions) — per Joel's explicit
    // choice to use BOTH sources together. Reads from the shared KV key
    // memextract.js now pushes to (flow_shared_extracted_memory) — this
    // required a real fix in memextract.js itself, since its data
    // previously lived only in browser localStorage, unreachable from
    // Echo's separate Railway process.
    const extracted = await memGet("flow_shared_extracted_memory");
    const memoryContext = extracted?.summary || "";

    const r = await fetch(`${SITE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "Analyze these real message samples from a person named Joel and produce a SHORT (3-4 sentence) description of his actual writing style — tone, formality level, common phrases, sentence length habits, use of emoji/punctuation. Be specific and concrete, not generic. Do not invent facts about him, only describe HOW he writes, not what he says. Respond with ONLY the description, no preamble.",
          },
          {
            role: "user",
            content: `Message samples:\n${samples.join("\n---\n")}\n\n${memoryContext ? `Additional context about Joel: ${memoryContext}` : ""}`,
          },
        ],
        force_intent: "chat",
      }),
    });
    const d = await r.json();
    const description = d.reply?.trim();
    if (description) {
      await memSet(STYLE_PROFILE_KEY, { description, updatedAt: Date.now(), sampleCount: samples.length });
      console.log(`[Style] Profile regenerated from ${samples.length} real samples.`);
    }
  } catch (e) {
    console.error("[Style] Profile regeneration failed:", e.message);
  }
}

async function getPersonaBlock() {
  try {
    // REAL FIX: was doing its own raw fetch + d?.value?.description,
    // which would have hit the same double-encoding bug already found
    // and fixed in memGet elsewhere this session (d.value being a raw
    // JSON string, not a parsed object, meaning .description would
    // always be undefined). Using memGet directly here instead, which
    // already correctly parses it.
    const profile = await memGet(STYLE_PROFILE_KEY);
    const desc = profile?.description || SEED_STYLE_DESCRIPTION;
    if (!desc) return "";
    return `\n\nJOEL'S WRITING STYLE (learned from his real messages, for matching tone only): ${desc}\nLet this inform tone and phrasing only — never invent facts, commitments, or opinions Joel hasn't actually stated.`;
  } catch (_) { return ""; }
}

// ── Seed style baseline ──────────────────────────────────────────────────
// Joel has very little Telegram history yet (installed Flow only days
// ago) — per his explicit request, this is a genuine, observed baseline
// from real conversation patterns, not invented flattery, used ONLY
// until enough real Telegram samples exist to replace it via
// regenerateStyleProfile above. This is intentionally a starting point,
// not a permanent substitute for real data.
const SEED_STYLE_DESCRIPTION = "Direct and informal — gets to the point without corporate filler. Comfortable saying 'I'm overwhelmed' or asking to slow down rather than pushing through confusion silently. Pushes back and asks for real verification rather than accepting claims at face value. Cares about intellectual honesty and originality — avoids borrowed/derivative phrasing. Thinks in terms of underlying systems and root causes even when starting from a specific, narrow problem. Uses minimal emoji, prefers concise responses over lengthy ones.";

async function askFlow(message, senderName) {
  const personaBlock = await getPersonaBlock();
  const SYSTEM = `You are ${ECHO_NAME}, Joel Olanrewaju's personal AI assistant answering on
his PERSONAL Telegram account (not his Flow bot — you are a separate persona
from Flow, even though you're powered by the same underlying AI chain).
This is likely a friend, contact, or business lead messaging Joel directly.
Be helpful, friendly, and natural — like Joel's assistant picking up on his behalf.
Keep replies concise unless more detail is clearly needed.
Joel runs Joelflowstack — premium web development and AI automation services.
If you can't answer something personal/specific, say Joel will get back to them directly.${personaBlock}`;

  try {
    const r = await fetch(`${SITE_URL}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user",   content: message },
        ],
      }),
    });
    if (!r.ok) throw new Error(`chat API ${r.status}`);
    const d = await r.json();
    return d.reply?.trim() || `Hey! This is ${ECHO_NAME}, Joel's AI assistant. Got your message — Joel will follow up!`;
  } catch (e) {
    console.error("[Userbot] askFlow error:", e.message);
    return `Hey! This is ${ECHO_NAME}, Joel's AI assistant. Got your message and will pass it along!`;
  }
}

// ── Push notification + summary to Flow's existing bell/KV system ──────────
async function notifyFlow(senderName, text, reply) {
  try {
    const getRes = await fetch(`${SITE_URL}/api/memory?key=flow_pending_notifs`);
    const cur    = getRes.ok ? (await getRes.json()).value : null;
    const arr    = Array.isArray(cur) ? cur : [];

    arr.push({
      source: "Telegram (Personal)",
      text:   `${senderName}: ${text.slice(0, 120)}`,
      ts:     Date.now(),
      read:   false,
    });

    await fetch(`${SITE_URL}/api/memory`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key: "flow_pending_notifs", value: arr.slice(-30) }),
    });
  } catch (e) {
    console.error("[Userbot] notify error:", e.message);
  }
}

// ── Manual-mode draft notification — sends the drafted reply to Joel via
// the FLOW BOT (not Echo's own account) with Yes/No/Skip/Retry buttons.
// Uses TELEGRAM_BOT_TOKEN + JOEL_TELEGRAM_CHAT_ID directly here rather than
// routing through /api/memory, since this needs Telegram's real
// sendMessage + reply_markup, which the generic KV bridge doesn't expose.
async function notifyFlowDraft(senderName, originalText, draftText, senderId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const joelChatId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!botToken || !joelChatId) {
    console.error("[Presence] Can't send draft for approval — TELEGRAM_BOT_TOKEN or JOEL_TELEGRAM_CHAT_ID not set on Echo's Railway env.");
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: joelChatId,
        text: `📨 *${senderName}:* ${originalText.slice(0, 200)}\n\n📝 *Echo's draft:*\n${draftText}`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Yes",   callback_data: `echodraft_yes_${senderId}` },
            { text: "❌ No",    callback_data: `echodraft_no_${senderId}` },
            { text: "⏭️ Skip",  callback_data: `echodraft_skip_${senderId}` },
            { text: "🔄 Retry", callback_data: `echodraft_retry_${senderId}` },
          ]],
        },
      }),
    });
  } catch (e) {
    console.error("[Presence] Failed to send draft notification:", e.message);
  }
}


// NOTE: api/memory.js already fixed the double-encoding bug (only
// JSON.stringify non-string values on the way in). We rely on that here:
// we always send/receive plain JS values through the existing /api/memory
// GET (?key=) / POST ({key, value}) contract, never touching Upstash directly.
async function memGet(key) {
  try {
    const r = await fetch(`${SITE_URL}/api/memory?key=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d?.value == null) return null;
    // REAL BUG FIX: this used to return d.value raw. api/memory.js's KV
    // backend stores objects as JSON-stringified text (same pattern
    // already found and fixed in api/social.js's safeKvResult this
    // session) — so d.value here was literally the STRING
    // '{"state":"online","setAt":...}', not an object. Every check like
    // `manualPresence?.state` was reading .state off a plain string,
    // which is always undefined — meaning isManualOnline was ALWAYS
    // false no matter what Joel clicked. This is the confirmed root
    // cause of Echo still auto-replying while "online"/manual mode was
    // supposedly active. If the value is already a real object (some
    // older writes may not be double-encoded), JSON.parse would throw on
    // it, so we fall back to returning it as-is in that case.
    if (typeof d.value === "string") {
      try { return JSON.parse(d.value); }
      catch { return d.value; } // genuinely a plain string value, not JSON — return as-is
    }
    return d.value;
  } catch (e) {
    console.error("[Userbot] memGet failed:", e.message);
    return null;
  }
}
async function memSet(key, value) {
  try {
    await fetch(`${SITE_URL}/api/memory`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key, value }),
    });
  } catch (e) {
    console.error("[Userbot] memSet failed:", e.message);
  }
}

// ── Blocklist — KV-stored under one key, editable from the Flow app/API
// without redeploying. Just plain @usernames (no @, lowercase), nothing else
// to look up or paste in. Any bot account is auto-blocked regardless of the
// list (see isBlocked below) — this is what stops the Flow-bot reply loop
// and stops Echo replying to things like @userinfobot too.
async function getBlocklist() {
  const list = await memGet("tg_blocklist");
  return Array.isArray(list) ? list.map((s) => String(s).toLowerCase()) : [];
}
function isBlocked(sender, blocklist) {
  if (sender?.bot) return true; // never auto-reply to ANY bot account, ever
  const uname = (sender?.username || "").toLowerCase();
  return !!uname && blocklist.includes(uname);
}

// ── Per-chat "waiting on Joel" state ────────────────────────────────────────
// Shape: { firstUnreadTs: number, nudged: boolean }
function chatStateKey(senderId) { return `tg_chat_state_${senderId}`; }

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log("🔌 Connecting to Telegram as Joel's personal account...");

  const session = new StringSession(sessStr);
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
  });

  await client.connect();
  console.log("✅ Connected — listening for personal messages.\n");

  const me = await client.getMe();
  const myId = me.id.toString();
  console.log(`👤 Logged in as ${me.firstName || me.username} (id: ${myId})`);

  // ── Per-chat activity tracking, replacing global online/offline ────────
  // PREVIOUS APPROACH (removed): watched Telegram's UpdateUserStatus for
  // Joel's account-wide online/offline state. Real problem, confirmed:
  // the userbot's OWN GramJS session is logged into the SAME account as
  // Joel's phone/desktop app, and simply staying connected can itself
  // affect what Telegram reports as that account's presence — there's no
  // reliable way to distinguish "Joel is on his phone right now" from
  // "the userbot's own session is alive" using account-wide status alone.
  // That's almost certainly why Flow kept auto-replying even while Joel
  // was visibly active in the real Telegram app — the global "online"
  // signal wasn't a trustworthy proxy for what Joel was actually doing.
  //
  // NEW APPROACH: track, per chat, the timestamp of Joel's last OUTGOING
  // message in THAT specific conversation. If Joel personally sent
  // something in this exact chat within the last ACTIVE_WINDOW_MS, treat
  // him as "actively handling this conversation right now" and hold
  // auto-replies — regardless of what Telegram's global status says. This
  // is deterministic (based on Joel's own real actions, not a fuzzy
  // presence heartbeat) and per-conversation, which is also more correct
  // behavior anyway — Joel might be actively texting one person while
  // genuinely away from everyone else.
  const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // Joel's own last message in THIS chat within 5 min = treat him as actively on it right now
  const lastJoelActivityByChat = new Map(); // senderId -> timestamp of Joel's last outgoing message in that chat (in-memory; fine to reset on restart, worst case one extra reply right after a redeploy)

  // Track recent senders to avoid double-replying to rapid multi-message bursts
  const recentReplies = new Map();
  const COOLDOWN_MS = 8000;

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      const senderIdEarly = message?.senderId?.toString() || "unknown";

      // ── Joel's own outgoing message: record activity and bail out
      // BEFORE running the (costly) vision description below — there's no
      // reason to describe a photo Joel himself just sent. Moved ahead of
      // the photo-handling block specifically for this reason.
      if (message?.out) {
        lastJoelActivityByChat.set(senderIdEarly, Date.now());
        await memSet(chatStateKey(senderIdEarly), null);
        // ── Style-profile sample collection — this is the actual
        // missing piece behind "put my brain into Echo": getPersonaBlock()
        // (further up this file) already reads a style profile from KV,
        // but nothing ever WROTE one — confirmed by searching the whole
        // codebase for writes to flow_joel_style_profile and finding
        // none. This collects a rolling sample of Joel's REAL outgoing
        // text (never anyone else's messages) and periodically turns it
        // into an actual style description.
        if (message.message && message.message.trim().length > 3) {
          collectStyleSample(message.message.trim()).catch((e) =>
            console.error("[Style] sample collection failed:", e.message)
          );
        }
        return;
      }

      // ── Photo handling — converts an incoming photo into a text
      // description via Flow's existing /api/vision endpoint (same one
      // ui/vision.js already uses for the camera/screen-share features —
      // reused here, not duplicated), then treats that description AS the
      // message text for everything below. This is deliberate: it means
      // photos automatically get the same activity-check, manual-presence
      // drafting, and auto-reply behavior as text messages, with zero
      // special-casing needed in the rest of this handler.
      let textOverride = null;
      if (message?.media?.className === "MessageMediaPhoto" && !message.message) {
        try {
          const buffer = await client.downloadMedia(message, {});
          if (buffer) {
            const base64 = buffer.toString("base64");
            const visionR = await fetch(`${SITE_URL}/api/vision`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                image: base64,
                prompt: "Describe this photo someone sent Joel on Telegram. Be specific about what's shown.",
              }),
            });
            const visionD = await visionR.json();
            if (visionD.description) {
              textOverride = `[Photo] ${visionD.description}`;
              console.log(`🖼️  Described incoming photo via ${visionD.provider}: ${visionD.description.slice(0, 80)}`);
            } else {
              console.warn("[Userbot] Vision description failed:", visionD.error);
            }
          }
        } catch (e) {
          console.error("[Userbot] Photo download/description failed:", e.message);
        }
        // If vision genuinely failed (no textOverride set), fall through
        // to the normal !message?.message check below, which will
        // correctly skip this message rather than crash on empty text —
        // better to silently miss one photo than break the whole handler.
      }

      if (!textOverride && !message?.message) return;  // ignore non-text/non-photo (other media types not yet handled)
      if (!message.isPrivate) return;            // only direct messages, not group chats

      const senderId = message.senderId?.toString() || "unknown";

      // ── Blocklist check (anti-spam/anti-bot — includes the Flow bot
      // itself once ID is set) ─────────────────────────────────────────
      const sender = await message.getSender();
      const senderName = sender?.firstName || sender?.username || "Someone";
      const blocklist = await getBlocklist();
      if (isBlocked(sender, blocklist)) {
        const reason = sender?.bot ? "is a bot" : "is on the blocklist";
        console.log(`🚫 Ignored message from ${senderName} — ${reason}`);
        return;
      }

      // ── Mute check — genuinely SEPARATE system from the blocklist
      // above, per Joel's explicit request. This is Joel's own
      // deliberate "ignore this specific person indefinitely" choice
      // (via /mute @username on the Flow bot), stored under its own KV
      // key so it can never be accidentally affected by anti-spam
      // blocklist changes or vice versa. Checked here, BEFORE the
      // manual-presence/drafting logic further down, so a muted contact
      // is skipped silently even while Joel is in online/manual mode —
      // muting always wins, with no timeout, no draft sent, nothing.
      const uname = (sender?.username || "").toLowerCase();
      const mutedList = await memGet("flow_muted_contacts");
      if (uname && Array.isArray(mutedList) && mutedList.includes(uname)) {
        console.log(`🔇 Ignored message from ${senderName} — muted by Joel`);
        return;
      }

      const now = Date.now();
      const last = recentReplies.get(senderId) || 0;
      if (now - last < COOLDOWN_MS) return;      // debounce rapid messages from same person
      recentReplies.set(senderId, now);

      const text = textOverride || message.message;
      console.log(`📨 ${senderName}: ${text.slice(0, 80)}`);

      // ── Joel is actively handling THIS specific chat right now ──────
      const lastActivity = lastJoelActivityByChat.get(senderId) || 0;
      const joelActiveHere = (now - lastActivity) < ACTIVE_WINDOW_MS;

      // ── Joel hasn't been active in THIS chat recently ──────────────────
      // Before falling through to full auto-reply, check Joel's MANUAL
      // presence toggle (set via the Flow bot's /presence button — see
      // api/social.js). This is a real, separate switch from the per-chat
      // activity tracking above: activity tracking is automatic and
      // per-conversation; manual presence is Joel explicitly saying
      // "I'm around right now, draft things for me instead of sending."
      const manualPresence = await memGet(PRESENCE_KEY);
      const isManualOnline = manualPresence?.state === "online";

      // Auto-revert after 1 hour of no activity from Joel in ANY chat —
      // the closest honest approximation available of "he's probably not
      // actually watching anymore," since neither service can see Joel's
      // real phone/Telegram-app state. Uses the same lastJoelActivityByChat
      // map already being maintained, just checked globally instead of
      // per-chat.
      if (isManualOnline) {
        const anyRecentActivity = [...lastJoelActivityByChat.values()].some(
          (ts) => (now - ts) < PRESENCE_AUTOREVERT_MS
        );
        if (!anyRecentActivity && manualPresence.setAt && (now - manualPresence.setAt) > PRESENCE_AUTOREVERT_MS) {
          await memSet(PRESENCE_KEY, { state: "auto", setAt: now });
          await notifyFlow(
            "System",
            "",
            "🔴 Auto-reverted to auto-reply mode after 1hr of no activity from you anywhere. If you were actually online and just quiet, tap /presence to go back to manual."
          );
          console.log("[Presence] Auto-reverted to 'auto' after 1hr of inactivity.");
          // fall through to normal auto-reply below, since we just reverted
        } else {
          // Genuinely in manual mode right now — draft instead of send.
          await client.invoke(
            new Api.messages.SetTyping({
              peer:   message.peerId,
              action: new Api.SendMessageTypingAction(),
            })
          ).catch(() => {});

          const draftText = await askFlow(text, senderName);
          await memSet(`flow_echo_draft_${senderId}`, {
            senderId, senderName,
            originalText: text,
            replyText: draftText,
            createdAt: now,
          });

          await notifyFlowDraft(senderName, text, draftText, senderId);
          console.log(`📝 Drafted (not sent) for ${senderName} — awaiting Joel's approval via Flow bot.`);
          return;
        }
      }

      if (joelActiveHere) {
        const key = chatStateKey(senderId);
        const state = await memGet(key);

        if (!state) {
          // First unread message while Joel's actively on this chat — start the clock, no reply yet.
          await memSet(key, { firstUnreadTs: now, nudged: false });
          await notifyFlow(senderName, text, "(Joel is active in this chat — held for now)");
          return;
        }

        const elapsed = now - state.firstUnreadTs;
        if (elapsed >= NUDGE_DELAY_MS && !state.nudged) {
          // Been unanswered 10+ min while Joel's still marked active here — send ONE nudge, then go quiet.
          const nudge = "Hey! Joel's active on this chat but hasn't gotten to this yet — want to wait a bit for him, or should I go ahead and help in the meantime?";
          await client.sendMessage(message.peerId, { message: nudge });
          await memSet(key, { firstUnreadTs: state.firstUnreadTs, nudged: true });
          console.log(`💬 Sent wait-or-continue nudge to ${senderName}`);
        }
        // Otherwise: still within the 10-min grace window, or already nudged — stay silent.
        return;
      }

      // ── Joel hasn't been active in THIS chat recently — full auto-reply ──
      await client.invoke(
        new Api.messages.SetTyping({
          peer:   message.peerId,
          action: new Api.SendMessageTypingAction(),
        })
      ).catch(() => {});

      const reply = await askFlow(text, senderName);
      await client.sendMessage(message.peerId, { message: reply });
      console.log(`✅ Replied to ${senderName}`);

      await notifyFlow(senderName, text, reply);
      await memSet(chatStateKey(senderId), null); // clear state — handled
    } catch (e) {
      console.error("[Userbot] handler error:", e.message);
    }
  }, new NewMessage({}));

  console.log("👂 Flow is now listening on Joel's personal Telegram.\n");

  process.on("SIGTERM", async () => {
    console.log("Shutting down gracefully...");
    await client.disconnect();
    process.exit(0);
  });

  // ── Minimal HTTP endpoint — lets api/social.js's "Yes" button tell Echo
  // to actually send an approved draft. Uses Node's built-in http module,
  // not express — this is the ONLY inbound endpoint this service needs,
  // and adding a whole framework dependency for one route isn't worth the
  // extra weight on a free-tier Railway service. Railway auto-detects the
  // PORT env var and routes to it; no railway.json change needed since
  // this doesn't change the start command, just adds a listener alongside
  // the existing Telegram client connection.
  const http = require("http");
  const PORT = process.env.PORT || 3000;

  http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/send-approved-draft") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { senderId, text } = JSON.parse(body);
        if (!senderId || !text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "senderId and text required" }));
          return;
        }
        // senderId is a plain numeric Telegram user ID (string), which
        // GramJS's sendMessage accepts directly as a peer.
        // NOTE: GramJS needs to have this user's "entity" cached to resolve
        // a bare numeric ID — normally true here since senderId came from
        // a real recent incoming message, but if Echo's Railway service
        // restarted between the draft being created and Joel clicking Yes,
        // this can fail with "Could not find the input entity". If that
        // happens, the fix is having Joel send that contact ANY message
        // first (even just opening the chat) to re-cache it, then retry.
        await client.sendMessage(senderId, { message: text });
        console.log(`✅ Sent approved draft to ${senderId} via Joel's approval.`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error("[Presence] Failed to send approved draft:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  }).listen(PORT, () => {
    console.log(`🌐 Echo's approval endpoint listening on port ${PORT}`);
  });
})();

// ── NO ID-HUNTING NEEDED — BOT LOOP IS FIXED AUTOMATICALLY ─────────────────
// The Flow bot's messages to Joel now get ignored automatically, because
// Telegram marks every bot account with sender.bot === true, and this file
// checks that before ever generating a reply. Same reason it'll now ignore
// @userinfobot, @getidsbot, or any other bot account. Nothing to configure.
//
// ── HOW TO BLOCK SPECIFIC HUMANS WITHOUT REDEPLOYING ───────────────────────
// The blocklist lives at KV key "tg_blocklist" — a plain JSON array of
// lowercase usernames (no @). Update it via a simple POST to your existing
// /api/memory endpoint, e.g. from any HTTP client or a quick browser
// fetch() in devtools:
//
//   fetch("https://flow-v3-mu.vercel.app/api/memory", {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       key: "tg_blocklist",
//       value: ["someannoyingusername", "anotherone"]
//     })
//   });
//
// Re-POST the full array each time (it's a full overwrite, not an append).
// People with no Telegram username set can't be blocked this way — bots are
// still caught regardless, since that check doesn't depend on usernames.
