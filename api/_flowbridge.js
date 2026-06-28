// api/_flowbridge.js — shared AI bridge for WhatsApp + Telegram
// Underscore prefix = Vercel does NOT expose this as a public endpoint
// Both whatsapp.js and telegram.js import sendToFlowAI from here

const SITE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://flow-v3-mu.vercel.app';

const SYSTEM_PROMPT = `You are Flow, Joel Olanrewaju's personal AI assistant.
You are responding to messages from Joel's contacts via auto-reply on WhatsApp or Telegram.
Be helpful, friendly, professional and concise — under 200 words unless more detail is needed.
Represent Joel and his brand (Joelflowstack — web development and AI automations) well.
If asked about Joel's services, mention he builds premium websites and AI automation systems.
If you cannot answer something, say you will pass the message to Joel.`;

export async function sendToFlowAI(userMessage, context = '') {
  try {
    const res = await fetch(`${SITE_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        messages: [
          {
            role:    'system',
            content: SYSTEM_PROMPT + (context ? `\n\nContext: ${context}` : ''),
          },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Chat API ${res.status}`);
    const data = await res.json();
    return data.reply?.trim() || "I'm Flow, Joel's AI assistant. I received your message and Joel will get back to you!";
  } catch (e) {
    console.error('[FlowBridge] Error:', e.message);
    return "Hi! I'm Flow, Joel's AI assistant. Your message has been received — Joel will respond soon!";
  }
}
