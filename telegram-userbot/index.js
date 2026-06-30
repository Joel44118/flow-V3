// telegram-userbot/index.js — ALWAYS-ON listener for Joel's personal Telegram
//
// Deploy this to Railway.app (free tier, ~500 hrs/month — effectively always-on
// for one small service). It holds a persistent MTProto connection to Telegram
// and auto-replies to anyone who messages Joel's personal account directly.
//
// This is SEPARATE from the Telegram Bot (api/social.js on Vercel) — that one
// only replies to people who message the bot. This one replies as Joel himself.
//
// ENV VARS NEEDED (set these in Railway → Variables):
//   TELEGRAM_API_ID     — from my.telegram.org/apps
//   TELEGRAM_API_HASH   — from my.telegram.org/apps
//   TELEGRAM_SESSION    — generated once via login.js, never changes after
//   FLOW_SITE_URL       — https://flow-v3-mu.vercel.app  (reuses Flow's existing AI)

const { TelegramClient } = require("telegram");
const { StringSession }  = require("telegram/sessions");
const { NewMessage }     = require("telegram/events");

const apiId    = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
const apiHash  = process.env.TELEGRAM_API_HASH || "";
const sessStr  = process.env.TELEGRAM_SESSION || "";
const SITE_URL = process.env.FLOW_SITE_URL || "https://flow-v3-mu.vercel.app";

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
// api/memory.js stores by simple key overwrite — flow_pending_notifs is an
// array under ONE key, so we must read-modify-write, same pattern api/social.js
// already uses on the Vercel side for the Bot integration.
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

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log("🔌 Connecting to Telegram as Joel's personal account...");

  const session = new StringSession(sessStr);
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
  });

  await client.connect();
  console.log("✅ Connected — listening for personal messages.\n");

  // Track recent senders to avoid double-replying to rapid multi-message bursts
  const recentReplies = new Map();
  const COOLDOWN_MS = 8000;

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message?.message) return;          // ignore non-text (handle media separately below)
      if (message.out) return;                 // ignore messages Joel himself sent
      if (!message.isPrivate) return;           // only direct messages, not group chats

      const senderId = message.senderId?.toString() || "unknown";
      const now = Date.now();
      const last = recentReplies.get(senderId) || 0;
      if (now - last < COOLDOWN_MS) return;     // debounce rapid messages from same person
      recentReplies.set(senderId, now);

      const sender = await message.getSender();
      const senderName = sender?.firstName || sender?.username || "Someone";
      const text = message.message;

      console.log(`📨 ${senderName}: ${text.slice(0, 80)}`);

      // Show "typing..." for realism
      await client.invoke(
        new (require("telegram/tl").Api.messages.SetTyping)({
          peer:   message.peerId,
          action: new (require("telegram/tl").Api.SendMessageTypingAction)(),
        })
      ).catch(() => {});

      const reply = await askFlow(text, senderName);
      await client.sendMessage(message.peerId, { message: reply });

      console.log(`✅ Replied to ${senderName}`);

      await notifyFlow(senderName, text, reply);
    } catch (e) {
      console.error("[Userbot] handler error:", e.message);
    }
  }, new NewMessage({}));

  console.log("👂 Flow is now listening on Joel's personal Telegram.\n");

  // Keep process alive
  process.on("SIGTERM", async () => {
    console.log("Shutting down gracefully...");
    await client.disconnect();
    process.exit(0);
  });
})();
