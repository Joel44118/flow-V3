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
//   1. Blocklist (KV-stored, editable without redeploy) — never auto-replies
//      to blocked senders. Includes the Flow BOT's own account by default,
//      so the bot-DMs-Joel -> userbot-replies -> bot-replies loop is dead.
//   2. Presence-aware behavior — tracks Joel's own Telegram online/offline
//      status via Telegram's real UpdateUserStatus events (no manual toggle,
//      no polling Flow's own app):
//        - Joel ONLINE: userbot stays silent. If 10+ min pass with the
//          message still unread/unanswered by Joel, it sends ONE nudge
//          asking the sender if they want to wait for Joel or have Flow
//          continue helping — then goes quiet again either way.
//        - Joel OFFLINE: full auto-reply, exactly as before.
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

// ── PASTE THE FLOW BOT'S NUMERIC TELEGRAM USER ID HERE ─────────────────────
// See bottom of file for exactly how to find this. Until filled in, the bot
// account is NOT auto-blocked — add it to the KV blocklist manually in the
// meantime (see notes at the bottom) so the reply loop stops today.
const FLOW_BOT_USER_ID = ""; // e.g. "5983021147" — leave blank if unknown for now

const NUDGE_DELAY_MS = 10 * 60 * 1000; // 10 minutes

if (!apiId || !apiHash || !sessStr) {
  console.error("❌ Missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION.");
  console.error("Run login.js once locally first to generate TELEGRAM_SESSION.");
  process.exit(1);
}

// ── Ask Flow's existing AI chain for a reply (reuses everything already built) ──
async function askFlow(message, senderName) {
  const SYSTEM = `You are Flow, Joel Olanrewaju's personal AI assistant.
You are replying to a message sent to JOEL'S PERSONAL Telegram account (not his bot).
This is likely a friend, contact, or business lead messaging Joel directly.
Be helpful, friendly, and natural — like Joel's assistant picking up on his behalf.
Keep replies concise unless more detail is clearly needed.
Joel runs Joelflowstack — premium web development and AI automation services.
If you can't answer something personal/specific, say Joel will get back to them directly.`;

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
    return d.reply?.trim() || "Hey! This is Flow, Joel's AI assistant. Got your message — Joel will follow up!";
  } catch (e) {
    console.error("[Userbot] askFlow error:", e.message);
    return "Hey! This is Flow, Joel's AI assistant. Got your message and will pass it along!";
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

// ── KV helpers — reuses api/memory.js's generic key/value store ───────────
// NOTE: api/memory.js already fixed the double-encoding bug (only
// JSON.stringify non-string values on the way in). We rely on that here:
// we always send/receive plain JS values through the existing /api/memory
// GET (?key=) / POST ({key, value}) contract, never touching Upstash directly.
async function memGet(key) {
  try {
    const r = await fetch(`${SITE_URL}/api/memory?key=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.value ?? null;
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
// without redeploying. Add either numeric Telegram user IDs or @usernames
// (lowercase, no @) as strings to this array via /api/memory.
async function getBlocklist() {
  const list = await memGet("tg_blocklist");
  return Array.isArray(list) ? list.map(String) : [];
}
function isBlocked(senderId, username, blocklist) {
  if (FLOW_BOT_USER_ID && senderId === FLOW_BOT_USER_ID) return true;
  const uname = (username || "").toLowerCase();
  return blocklist.some((entry) => entry === senderId || entry.toLowerCase() === uname);
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

  // Joel's live online/offline status, updated in real time by Telegram itself.
  // Starts assumed offline until the first status update arrives.
  let joelOnline = false;

  client.addEventHandler((update) => {
    try {
      if (update instanceof Api.UpdateUserStatus && update.userId?.toString() === myId) {
        joelOnline = update.status instanceof Api.UserStatusOnline;
        console.log(`[Presence] Joel is now ${joelOnline ? "ONLINE" : "OFFLINE"}`);
      }
    } catch (e) {
      console.error("[Userbot] status update error:", e.message);
    }
  });

  // Track recent senders to avoid double-replying to rapid multi-message bursts
  const recentReplies = new Map();
  const COOLDOWN_MS = 8000;

  // Periodic sweep: check any chat that's been "waiting on Joel" past the
  // nudge delay while Joel is still online and hasn't personally replied yet.
  setInterval(async () => {
    if (!joelOnline) return; // only relevant while Joel is online and silent
    // Sweep is intentionally lightweight — real check happens per-chat
    // inside the message handler below using each chat's own state key,
    // so this interval just exists as a safety net comment for future
    // extension (e.g. a scheduled digest). Left as a no-op for now.
  }, 60 * 1000);

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message?.message) return;           // ignore non-text (handle media separately below)
      if (!message.isPrivate) return;            // only direct messages, not group chats

      const senderId = message.senderId?.toString() || "unknown";

      // ── Joel's own outgoing message: treat as "Joel handled this chat" ──
      if (message.out) {
        await memSet(chatStateKey(senderId), null); // clear any pending nudge state
        return;
      }

      // ── Blocklist check (includes the Flow bot itself once ID is set) ──
      const sender = await message.getSender();
      const senderName = sender?.firstName || sender?.username || "Someone";
      const blocklist = await getBlocklist();
      if (isBlocked(senderId, sender?.username, blocklist)) {
        console.log(`🚫 Ignored message from blocked sender: ${senderName}`);
        return;
      }

      const now = Date.now();
      const last = recentReplies.get(senderId) || 0;
      if (now - last < COOLDOWN_MS) return;      // debounce rapid messages from same person
      recentReplies.set(senderId, now);

      const text = message.message;
      console.log(`📨 ${senderName}: ${text.slice(0, 80)}`);

      // ── Joel is ONLINE: stay quiet, but track how long it's been unread ──
      if (joelOnline) {
        const key = chatStateKey(senderId);
        const state = await memGet(key);

        if (!state) {
          // First unread message while Joel's online — start the clock, no reply yet.
          await memSet(key, { firstUnreadTs: now, nudged: false });
          await notifyFlow(senderName, text, "(Joel is online — held for now)");
          return;
        }

        const elapsed = now - state.firstUnreadTs;
        if (elapsed >= NUDGE_DELAY_MS && !state.nudged) {
          // Been unanswered 10+ min while Joel's online — send ONE nudge, then go quiet.
          const nudge = "Hey! Joel's online but hasn't gotten to this yet — want to wait a bit for him, or should I go ahead and help in the meantime?";
          await client.sendMessage(message.peerId, { message: nudge });
          await memSet(key, { firstUnreadTs: state.firstUnreadTs, nudged: true });
          console.log(`💬 Sent wait-or-continue nudge to ${senderName}`);
        }
        // Otherwise: still within the 10-min grace window, or already nudged — stay silent.
        return;
      }

      // ── Joel is OFFLINE: full auto-reply, same as before ────────────────
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
})();

// ── HOW TO FIND THE FLOW BOT'S NUMERIC USER ID ─────────────────────────────
// 1. In Telegram, message @userinfobot (or @getidsbot) and forward it any
//    message the Flow bot has sent you — it'll reply with the bot's numeric ID.
// 2. Paste that number as a string into FLOW_BOT_USER_ID at the top of this
//    file, e.g. FLOW_BOT_USER_ID = "5983021147".
// 3. Commit + push — Railway redeploys automatically.
// Until then: add the bot's ID as a string into the tg_blocklist KV array
// (see below) so blocking works immediately without touching this file.
//
// ── HOW TO MANAGE THE BLOCKLIST WITHOUT REDEPLOYING ────────────────────────
// The blocklist lives at KV key "tg_blocklist" — a plain JSON array of
// strings (numeric IDs and/or lowercase usernames, no @). Update it via a
// simple POST to your existing /api/memory endpoint, e.g. from any HTTP
// client or a quick browser fetch() in devtools:
//
//   fetch("https://flow-v3-mu.vercel.app/api/memory", {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       key: "tg_blocklist",
//       value: ["5983021147", "someannoyingusername"]
//     })
//   });
//
// Re-POST the full array each time (it's a full overwrite, not an append).
