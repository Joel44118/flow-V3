// api/telegram.js — Flow Telegram Bot (v2)
// FIX: res.status(200) was ending the function before async work ran
// Now: do all work first, then respond

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL  = 'https://flow-v3-mu.vercel.app';

async function sendTG(chatId, text) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    chatId,
      text:       text.slice(0, 4096),
      parse_mode: 'Markdown',
    }),
  }).catch(e => console.error('[Flow TG] sendTG error:', e.message));
}

async function sendTyping(chatId) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}

async function askFlow(userMessage, context) {
  const SYSTEM = `You are Flow, Joel Olanrewaju's personal AI assistant.
You are replying to a Telegram message on Joel's behalf.
Be helpful, friendly, professional and concise (under 200 words unless more detail is needed).
Joel runs Joelflowstack — premium web development and AI automation services.
If asked about Joel's work or services, be positive and professional.
If you cannot answer, say you will pass the message to Joel.`;

  const res = await fetch(`${SITE_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM + (context ? `\n\nContext: ${context}` : '') },
        { role: 'user',   content: userMessage },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Chat API returned ${res.status}`);
  const data = await res.json();
  return data.reply?.trim() || "I'm Flow, Joel's AI assistant. Your message has been received!";
}

export default async function handler(req, res) {
  // Webhook verification test
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, bot: 'Flow Telegram Bot' });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Check token is configured
  if (!BOT_TOKEN) {
    console.error('[Flow TG] TELEGRAM_BOT_TOKEN not set in Vercel env vars');
    return res.status(200).json({ ok: false, error: 'Bot token not configured' });
  }

  const update = req.body;

  // Handle /start command immediately and return
  const msg = update?.message || update?.edited_message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId   = msg.chat.id;
  const text     = msg.text || '';
  const username = msg.from?.username || msg.from?.first_name || String(chatId);

  if (text === '/start') {
    await sendTG(chatId, `👋 Hi *${username}*! I'm *Flow*, Joel's AI assistant.\n\nAsk me anything about Joel's work, services, or any question you have!`);
    return res.status(200).json({ ok: true });
  }

  if (!text.trim()) return res.status(200).json({ ok: true });

  console.log(`[Flow TG] @${username} (${chatId}): ${text}`);

  // Show typing, get AI reply, send — all before responding to Telegram
  try {
    await sendTyping(chatId);

    const reply = await askFlow(text, `Telegram user @${username}`);
    await sendTG(chatId, reply);

    // Notify Joel
    const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
    if (joelId && String(chatId) !== String(joelId)) {
      const summary = `📨 *@${username}* asked:\n"${text.slice(0, 150)}"\n\n✅ *Flow replied:*\n"${reply.slice(0, 200)}"`;
      await sendTG(joelId, summary);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[Flow TG] Handler error:', e.message);
    await sendTG(chatId, "Sorry, I had a brief issue. Please try again in a moment!");
    return res.status(200).json({ ok: false, error: e.message });
  }
}
