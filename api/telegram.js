// api/telegram.js (v3) — Flow Telegram Bot
// FIX: All async work done BEFORE res.status(200) — prevents early termination
// NEW: Pushes notification to KV so Flow's bell icon updates in real-time
// Setup: @BotFather → /newbot → copy token → add TELEGRAM_BOT_TOKEN to Vercel env vars
// Webhook: visit https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://flow-v3-mu.vercel.app/api/telegram

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const KV_URL     = process.env.KV_REST_API_URL;
const KV_TOKEN   = process.env.KV_REST_API_TOKEN;
const SITE_URL   = 'https://flow-v3-mu.vercel.app';

async function sendTG(chatId, text) {
  if (!BOT_TOKEN) return;
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), parse_mode: 'Markdown' }),
  });
  if (!r.ok) console.error('[Flow TG] sendTG failed:', r.status, await r.text());
}

async function sendTyping(chatId) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}

async function askFlow(userMessage, context) {
  const SYSTEM = `You are Flow, Joel Olanrewaju's personal AI assistant.
You are replying to a Telegram message on Joel's behalf.
Be helpful, friendly, professional. Keep replies under 200 words unless more is needed.
Joel runs Joelflowstack — premium web development and AI automation services.
If you cannot answer something specific, say you'll pass the message to Joel.`;

  const res = await fetch(`${SITE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM + (context ? `\nContext: ${context}` : '') },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Chat API ${res.status}`);
  const data = await res.json();
  return data.reply?.trim() || "Hi! I'm Flow, Joel's AI. Your message was received!";
}

async function pushNotification(source, text) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    // Get current pending notifications
    const r = await fetch(`${KV_URL}/get/flow_pending_notifs`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const existing = r.ok ? ((await r.json()).result || []) : [];
    const updated = [...(Array.isArray(existing) ? existing : []),
      { source, text: text.slice(0, 200), ts: Date.now(), read: false }
    ].slice(-20);

    await fetch(`${KV_URL}/set/flow_pending_notifs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
  } catch (e) {
    console.error('[Flow TG] KV push failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'Flow Telegram Bot' });
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!BOT_TOKEN) {
    console.error('[Flow TG] TELEGRAM_BOT_TOKEN not set');
    return res.status(200).json({ ok: false, error: 'Bot token not configured' });
  }

  const update = req.body;
  const msg    = update?.message || update?.edited_message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId   = msg.chat.id;
  const text     = msg.text || '';
  const username = msg.from?.username || msg.from?.first_name || String(chatId);

  if (text === '/start') {
    await sendTG(chatId,
      `👋 Hi *${username}*\\! I'm *Flow*, Joel's AI assistant\\.\n\nSend me any message and I'll help right away\\!`
    );
    return res.status(200).json({ ok: true });
  }

  if (!text.trim()) return res.status(200).json({ ok: true });

  console.log(`[Flow TG] @${username}: ${text.slice(0, 100)}`);

  try {
    // 1. Show typing indicator
    await sendTyping(chatId);

    // 2. Get AI reply
    const reply = await askFlow(text, `Telegram: @${username}`);

    // 3. Reply to user
    await sendTG(chatId, reply);

    // 4. Push notification to Flow's bell (parallel with notifying Joel)
    const notifText = `@${username}: ${text.slice(0, 120)}`;
    await Promise.all([
      pushNotification('Telegram', notifText),
      // Notify Joel's Telegram if JOEL_TELEGRAM_CHAT_ID is set
      (async () => {
        const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
        if (joelId && String(chatId) !== String(joelId)) {
          const summary = `📨 *@${username}* sent:\n"${text.slice(0,150)}"\n\n✅ *Flow replied:*\n"${reply.slice(0,200)}"`;
          await sendTG(joelId, summary);
        }
      })(),
    ]);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[Flow TG] Error:', e.message);
    await sendTG(chatId, "I had a brief issue — please try again in a moment!").catch(() => {});
    return res.status(200).json({ ok: false, error: e.message });
  }
}
