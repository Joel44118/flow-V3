// api/social.js — Telegram Bot + WhatsApp Cloud API (merged to save function slots)
// Routes by query param: /api/social?platform=telegram  or  /api/social?platform=whatsapp
//
// ── TELEGRAM SETUP ────────────────────────────────────────────────────────
// 1. Talk to @BotFather → /newbot → copy token
// 2. Add TELEGRAM_BOT_TOKEN to Vercel env vars
// 3. Set webhook (paste in browser once after deploy):
//    https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://flow-v3-mu.vercel.app/api/social?platform=telegram
// 4. Optional: add JOEL_TELEGRAM_CHAT_ID (message @userinfobot to get yours)
//
// ── WHATSAPP SETUP ────────────────────────────────────────────────────────
// 1. developers.facebook.com → Create App → WhatsApp Business
// 2. Add WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN to Vercel
// 3. Set webhook URL: https://flow-v3-mu.vercel.app/api/social?platform=whatsapp
// 4. Optional: JOEL_WHATSAPP_NUMBER (your number with country code, e.g. 2348012345678)

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const WA_TOKEN   = process.env.WHATSAPP_TOKEN;
const WA_PHONE   = process.env.WHATSAPP_PHONE_ID;
const WA_VERIFY  = process.env.WHATSAPP_VERIFY_TOKEN;
const KV_URL     = process.env.KV_REST_API_URL;
const KV_TOKEN_V = process.env.KV_REST_API_TOKEN;
const SITE       = 'https://flow-v3-mu.vercel.app';

// ── Shared: get AI reply from Flow ────────────────────────────────────────
async function askFlow(message, context) {
  const SYSTEM = `You are Flow, Joel Olanrewaju's personal AI assistant.
You are auto-replying to a ${context} message on Joel's behalf.
Be helpful, friendly, professional. Under 200 words unless more is needed.
Joel runs Joelflowstack — premium web development and AI automation.
If you can't answer something, say you'll pass it to Joel.`;

  try {
    const r = await fetch(`${SITE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user',   content: message },
        ],
      }),
    });
    if (!r.ok) throw new Error(`chat API ${r.status}`);
    const d = await r.json();
    return d.reply?.trim() || "Hi! I'm Flow, Joel's AI. Your message was received!";
  } catch (e) {
    console.error('[Social] askFlow error:', e.message);
    return "Hi! I'm Flow, Joel's AI assistant. Your message has been received — Joel will get back to you!";
  }
}

// ── Shared: push notification to Flow's bell ──────────────────────────────
async function pushNotif(source, text) {
  if (!KV_URL || !KV_TOKEN_V) return;
  try {
    const r   = await fetch(`${KV_URL}/get/flow_pending_notifs`, { headers: { Authorization: `Bearer ${KV_TOKEN_V}` } });
    const cur = r.ok ? ((await r.json()).result || []) : [];
    const arr = Array.isArray(cur) ? cur : [];
    arr.push({ source, text: text.slice(0, 200), ts: Date.now(), read: false });
    await fetch(`${KV_URL}/set/flow_pending_notifs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN_V}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(arr.slice(-20)),
    });
  } catch(e) { console.error('[Social] pushNotif:', e.message); }
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────
async function handleTelegram(req, res) {
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });

  const sendTG = async (chatId, text) => {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), parse_mode: 'Markdown' }),
    }).catch(e => console.error('[TG] send error:', e.message));
  };

  const update = req.body;
  const msg    = update?.message || update?.edited_message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId   = msg.chat.id;
  const text     = msg.text || '';
  const username = msg.from?.username || msg.from?.first_name || String(chatId);

  if (text === '/start') {
    await sendTG(chatId, `👋 Hi *${username}*! I'm *Flow*, Joel's AI.\n\nSend me any message and I'll reply right away!`);
    return res.status(200).json({ ok: true });
  }
  if (!text.trim()) return res.status(200).json({ ok: true });

  // Show typing
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendChatAction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});

  const reply = await askFlow(text, `Telegram @${username}`);
  await sendTG(chatId, reply);

  // Notify Joel + push bell notification in parallel
  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  await Promise.all([
    pushNotif('Telegram', `@${username}: ${text.slice(0, 120)}`),
    joelId && String(chatId) !== String(joelId)
      ? sendTG(joelId, `📨 *@${username}*:\n"${text.slice(0,150)}"\n\n✅ *Flow replied:*\n"${reply.slice(0,200)}"`)
      : Promise.resolve(),
  ]);

  return res.status(200).json({ ok: true });
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────
async function handleWhatsApp(req, res) {
  // Webhook verification (GET)
  if (req.method === 'GET') {
    const mode  = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const ch    = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WA_VERIFY) return res.status(200).send(ch);
    return res.status(403).send('Forbidden');
  }

  if (!WA_TOKEN || !WA_PHONE) return res.status(200).json({ ok: false, error: 'WhatsApp not configured' });

  const sendWA = async (to, text) => {
    await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096) } }),
    }).catch(e => console.error('[WA] send error:', e.message));
  };

  const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg   = entry?.messages?.[0];
  if (!msg || msg.type !== 'text') return res.status(200).json({ ok: true });

  const from    = msg.from;
  const text    = msg.text?.body || '';
  const contact = entry?.contacts?.[0]?.profile?.name || from;

  const reply = await askFlow(text, `WhatsApp from ${contact}`);
  await sendWA(from, reply);

  const myNum = process.env.JOEL_WHATSAPP_NUMBER;
  await Promise.all([
    pushNotif('WhatsApp', `${contact}: ${text.slice(0, 120)}`),
    myNum && myNum !== from
      ? sendWA(myNum, `📱 *${contact}*: "${text.slice(0,150)}"\n\n✅ Flow replied: "${reply.slice(0,200)}"`)
      : Promise.resolve(),
  ]);

  return res.status(200).json({ ok: true });
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const platform = req.query?.platform || '';

  if (platform === 'telegram') return handleTelegram(req, res);
  if (platform === 'whatsapp') return handleWhatsApp(req, res);

  return res.status(200).json({
    service: 'Flow Social API',
    endpoints: {
      telegram: '/api/social?platform=telegram',
      whatsapp: '/api/social?platform=whatsapp',
    },
  });
}
