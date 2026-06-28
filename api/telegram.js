// api/telegram.js — Telegram Bot auto-reply
// Setup: talk to @BotFather on Telegram → /newbot → copy token
// Env vars needed in Vercel:
//   TELEGRAM_BOT_TOKEN — from BotFather
//
// Set webhook (run once in browser after deploying):
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://flow-v3-mu.vercel.app/api/telegram
//
// That's it — Telegram will send every message to this endpoint

import { sendToFlowAI } from './_flowbridge.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API       = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendTG(chatId, text) {
  await fetch(`${API}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    chatId,
      text:       text.slice(0, 4096),
      parse_mode: 'Markdown',
    }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  res.status(200).json({ ok: true }); // acknowledge Telegram immediately

  try {
    const update = req.body;

    // Handle regular messages
    const msg = update?.message || update?.edited_message;
    if (!msg) return;

    const chatId   = msg.chat.id;
    const text     = msg.text || '';
    const username = msg.from?.username || msg.from?.first_name || String(chatId);

    // Ignore commands like /start unless you want to handle them
    if (text.startsWith('/start')) {
      await sendTG(chatId, '👋 Hi! I\'m *Flow*, Joel\'s AI assistant. Ask me anything!');
      return;
    }

    if (!text.trim()) return;

    console.log(`[Flow TG] @${username}: ${text}`);

    // Send typing indicator
    await fetch(`${API}/sendChatAction`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });

    // Get Flow's AI response
    const reply = await sendToFlowAI(text, `Telegram user @${username}`);

    // Reply to user
    await sendTG(chatId, reply);

    // Notify Joel (if JOEL_TELEGRAM_CHAT_ID is set — get yours by messaging @userinfobot)
    const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
    if (joelId && String(chatId) !== String(joelId)) {
      await sendTG(joelId,
        `📨 *@${username}* on Telegram:\n"${text.slice(0, 150)}"\n\n✅ *Flow replied:*\n"${reply.slice(0, 200)}..."`
      );
    }
  } catch (e) {
    console.error('[Flow TG] Error:', e.message);
  }
}
