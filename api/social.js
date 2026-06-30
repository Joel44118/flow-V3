// api/social.js (v2) — Telegram Bot + WhatsApp
// NEW: Image analysis via vision API (buyers can send photos)
// NEW: Summary delivery to Joel for every conversation
// Routes: /api/social?platform=telegram  |  /api/social?platform=whatsapp

const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const WA_TOKEN  = process.env.WHATSAPP_TOKEN;
const WA_PHONE  = process.env.WHATSAPP_PHONE_ID;
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN;
const KV_URL    = process.env.KV_REST_API_URL;
const KV_KEY    = process.env.KV_REST_API_TOKEN;
const SITE      = 'https://flow-v3-mu.vercel.app';

// ── Shared: Ask Flow AI ───────────────────────────────────────────────────
async function askFlow(userMsg, context = '', imageDesc = '') {
  const SYSTEM = `You are Flow, Joel Olanrewaju's personal AI assistant.
You are auto-replying to a ${context} message on Joel's behalf.
Joel runs Joelflowstack — premium web development and AI automation services.
Be helpful, friendly, professional. Keep replies under 200 words.
${imageDesc ? `The user sent an image. Here is what it shows: ${imageDesc}\nRespond to both the image and their message.` : ''}
If you cannot answer something specific, say you will pass it to Joel.`;

  const r = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: userMsg || (imageDesc ? 'See the image I sent.' : 'Hello') },
      ],
    }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}`);
  const d = await r.json();
  return d.reply?.trim() || "Hi! I'm Flow, Joel's AI. Your message was received!";
}

// ── Shared: Analyze image via Flow vision API ─────────────────────────────
async function analyzeImage(base64, mimeType = 'image/jpeg') {
  try {
    const r = await fetch(`${SITE}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image:  base64,
        prompt: 'Describe this image in detail. Note any problems, products, text, or context visible.',
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.description || null;
  } catch(_) { return null; }
}

// ── Shared: Push notification to Flow bell ────────────────────────────────
async function pushNotif(source, text) {
  if (!KV_URL || !KV_KEY) return;
  try {
    const r   = await fetch(`${KV_URL}/get/flow_pending_notifs`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
    const cur = r.ok ? ((await r.json()).result || []) : [];
    const arr = Array.isArray(cur) ? cur : [];
    arr.push({ source, text: text.slice(0, 200), ts: Date.now(), read: false });
    await fetch(`${KV_URL}/set/flow_pending_notifs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(arr.slice(-30)),
    });
  } catch(e) { console.error('[Social] pushNotif:', e.message); }
}

// ── Shared: Store conversation summary in KV ──────────────────────────────
async function storeSummary(platform, sender, userMsg, flowReply, hasImage) {
  if (!KV_URL || !KV_KEY) return;
  try {
    const summaryKey = `flow_conv_summary_${Date.now()}`;
    await fetch(`${KV_URL}/set/${encodeURIComponent(summaryKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform, sender,
        userMsg:   userMsg.slice(0, 300),
        flowReply: flowReply.slice(0, 300),
        hasImage,
        ts: Date.now(),
      }),
    });
  } catch(_) {}
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────
async function handleTelegram(req, res) {
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });

  const tgFetch = (method, body) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(e => console.error('[TG]', method, e.message));

  const update = req.body;
  const msg    = update?.message || update?.edited_message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId   = msg.chat.id;
  const text     = msg.text || msg.caption || '';
  const username = msg.from?.username
    ? `@${msg.from.username}`
    : msg.from?.first_name || String(chatId);

  // /start command
  if (text === '/start') {
    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: `👋 Hi ${username}! I'm *Flow*, Joel's AI assistant.\n\nYou can send me text messages or photos and I'll respond right away!`,
      parse_mode: 'Markdown',
    });
    return res.status(200).json({ ok: true });
  }

  // Show typing indicator
  await tgFetch('sendChatAction', { chat_id: chatId, action: 'typing' });

  // ── Handle photos ──────────────────────────────────────────────────────
  let imageDesc = null;
  if (msg.photo || msg.document?.mime_type?.startsWith('image/')) {
    try {
      // Get the largest photo version
      const fileId = msg.photo
        ? msg.photo[msg.photo.length - 1].file_id
        : msg.document.file_id;

      // Get file path from Telegram
      const fileR = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
      const fileD = await fileR.json();
      const filePath = fileD.result?.file_path;

      if (filePath) {
        // Download the image
        const imgR = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
        const buf  = await imgR.arrayBuffer();
        const b64  = Buffer.from(buf).toString('base64');

        // Analyze with vision API
        imageDesc = await analyzeImage(b64, 'image/jpeg');
        console.log('[TG] Image analyzed:', imageDesc?.slice(0, 80));
      }
    } catch (e) {
      console.error('[TG] Image error:', e.message);
    }
  }

  // Get AI reply
  const reply = await askFlow(
    text || (imageDesc ? 'What do you think about this image?' : 'Hello'),
    `Telegram ${username}`,
    imageDesc
  );

  // Send reply
  await tgFetch('sendMessage', {
    chat_id:    chatId,
    text:       reply.slice(0, 4096),
    parse_mode: 'Markdown',
  });

  // Build summary for Joel
  const summary = [
    `📨 *${username}* on Telegram:`,
    text ? `"${text.slice(0, 150)}"` : '',
    imageDesc ? `📷 *Image:* ${imageDesc.slice(0, 150)}` : '',
    `\n✅ *Flow replied:*\n"${reply.slice(0, 200)}"`,
  ].filter(Boolean).join('\n');

  // Notify Joel + push to bell + store summary — all parallel
  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  await Promise.all([
    pushNotif('Telegram', `${username}: ${(text || '[image]').slice(0, 120)}`),
    storeSummary('telegram', username, text || '[image]', reply, !!imageDesc),
    joelId && String(chatId) !== String(joelId)
      ? tgFetch('sendMessage', { chat_id: joelId, text: summary, parse_mode: 'Markdown' })
      : Promise.resolve(),
  ]);

  return res.status(200).json({ ok: true });
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────
async function handleWhatsApp(req, res) {
  // Webhook verification
  if (req.method === 'GET') {
    const mode  = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const ch    = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WA_VERIFY) return res.status(200).send(ch);
    return res.status(403).send('Forbidden');
  }

  if (!WA_TOKEN || !WA_PHONE) return res.status(200).json({ ok: false, error: 'WhatsApp not configured' });

  const sendWA = async (to, text) => fetch(`https://graph.facebook.com/v19.0/${WA_PHONE}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096) } }),
  }).catch(e => console.error('[WA] send:', e.message));

  const entry   = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg     = entry?.messages?.[0];
  if (!msg) return res.status(200).json({ ok: true });

  const from    = msg.from;
  const text    = msg.text?.body || msg.caption || '';
  const contact = entry?.contacts?.[0]?.profile?.name || from;

  // ── Handle WA images ───────────────────────────────────────────────────
  let imageDesc = null;
  if (msg.type === 'image' && msg.image?.id) {
    try {
      // Get media URL from WhatsApp
      const mediaR = await fetch(`https://graph.facebook.com/v19.0/${msg.image.id}`, {
        headers: { Authorization: `Bearer ${WA_TOKEN}` },
      });
      const mediaD = await mediaR.json();

      if (mediaD.url) {
        const imgR = await fetch(mediaD.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
        const buf  = await imgR.arrayBuffer();
        const b64  = Buffer.from(buf).toString('base64');
        imageDesc  = await analyzeImage(b64, msg.image.mime_type || 'image/jpeg');
      }
    } catch (e) { console.error('[WA] Image error:', e.message); }
  }

  const reply = await askFlow(text || 'Hello', `WhatsApp from ${contact}`, imageDesc);
  await sendWA(from, reply);

  const myNum = process.env.JOEL_WHATSAPP_NUMBER;
  const summary = [
    `📱 *${contact}* on WhatsApp:`,
    text ? `"${text.slice(0, 150)}"` : '',
    imageDesc ? `📷 Image: ${imageDesc.slice(0, 100)}` : '',
    `\n✅ Flow: "${reply.slice(0, 200)}"`,
  ].filter(Boolean).join('\n');

  await Promise.all([
    pushNotif('WhatsApp', `${contact}: ${(text || '[image]').slice(0, 120)}`),
    storeSummary('whatsapp', contact, text || '[image]', reply, !!imageDesc),
    myNum && myNum !== from ? sendWA(myNum, summary) : Promise.resolve(),
  ]);

  return res.status(200).json({ ok: true });
}

// ── FLOW SENTINEL RELAY ─────────────────────────────────────────────────
// Lets the Electron desktop app ask Flow to ping Joel on Telegram, without
// the bot token ever existing on Joel's machine. The desktop app only ever
// sends plain text here; this route is the only thing that touches TG_TOKEN.
async function handleSentinelPing(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });

  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!joelId) return res.status(200).json({ ok: false, error: 'JOEL_TELEGRAM_CHAT_ID not set' });

  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ ok: false, error: 'text required' });

  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: joelId, text: text.slice(0, 4096), parse_mode: 'Markdown' }),
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[Sentinel relay]', e.message);
    return res.status(502).json({ ok: false, error: e.message });
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const platform = req.query?.platform || '';
  if (platform === 'telegram')      return handleTelegram(req, res);
  if (platform === 'whatsapp')      return handleWhatsApp(req, res);
  if (platform === 'sentinel-ping') return handleSentinelPing(req, res);
  return res.status(200).json({ service: 'Flow Social', endpoints: {
    telegram: '/api/social?platform=telegram',
    whatsapp: '/api/social?platform=whatsapp',
    sentinelPing: '/api/social?platform=sentinel-ping',
  } });
}
