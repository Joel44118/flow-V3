// api/whatsapp.js — WhatsApp Cloud API auto-reply
// Setup: meta.com/whatsapp → Business → Cloud API (free)
// Env vars needed in Vercel:
//   WHATSAPP_TOKEN       — from Meta Developer App → WhatsApp → API Setup
//   WHATSAPP_VERIFY_TOKEN — any string you choose (for webhook verification)
//   WHATSAPP_PHONE_ID    — Phone number ID from Meta API Setup page
//
// Webhook URL to set in Meta: https://flow-v3-mu.vercel.app/api/whatsapp
// Webhook fields to subscribe: messages

import { sendToFlowAI } from './_flowbridge.js';

const TOKEN        = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const PHONE_ID     = process.env.WHATSAPP_PHONE_ID;

// ── Send WhatsApp message ─────────────────────────────────────────────────
async function sendWA(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text.slice(0, 4096) },
    }),
  });
}

export default async function handler(req, res) {
  // ── Webhook verification (GET) ───────────────────────────────────────
  if (req.method === 'GET') {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[Flow WA] Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // ── Incoming message (POST) ──────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).end();

  res.status(200).json({ status: 'ok' }); // acknowledge immediately

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const msg     = changes?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const from    = msg.from;            // sender's WhatsApp number
    const text    = msg.text?.body || '';
    const contact = changes?.contacts?.[0]?.profile?.name || from;

    console.log(`[Flow WA] Message from ${contact}: ${text}`);

    // Get Flow's AI response
    const reply = await sendToFlowAI(text, `WhatsApp user ${contact}`);

    // Send reply back
    await sendWA(from, reply);

    // Deliver summary to you (Joel) — send to your own number
    const MY_NUMBER = process.env.JOEL_WHATSAPP_NUMBER;
    if (MY_NUMBER && MY_NUMBER !== from) {
      await sendWA(MY_NUMBER, `📱 *${contact}* asked:\n"${text}"\n\n✅ *Flow replied:*\n"${reply.slice(0, 200)}..."`);
    }
  } catch (e) {
    console.error('[Flow WA] Error:', e.message);
  }
}
