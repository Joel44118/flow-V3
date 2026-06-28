// api/_flowbridge.js — shared AI bridge for WhatsApp + Telegram
// Calls Flow's own /api/chat endpoint so all providers + context are used
// Underscore prefix means Vercel does NOT expose this as a serverless function
// (only files directly in /api/ without underscore become endpoints)

const SITE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://flow-v3-mu.vercel.app';

const SYSTEM_PROMPT = `You are Flow, Joel's personal AI assistant.
You are currently responding to messages from Joel's social media contacts via auto-reply.
Be helpful, friendly, and concise. Represent Joel's brand professionally.
Keep replies under 300 words unless the question needs more detail.
If someone asks about Joel or his work, be positive and professional.
If asked something you can't answer, politely say you'll pass the message to Joel.`;

export async function sendToFlowAI(userMessage, context = '') {
  try {
    const res = await fetch(`${SITE_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        messages: [
          { role: 'system',    content: SYSTEM_PROMPT + (context ? `\n\nContext: ${context}` : '') },
          { role: 'user',      content: userMessage },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Chat API ${res.status}`);
    const data = await res.json();
    return data.reply || "I'm Flow, Joel's AI. I got your message and will pass it along!";
  } catch (e) {
    console.error('[FlowBridge] AI call failed:', e.message);
    return "Hi! I'm Flow, Joel's AI assistant. I received your message and will get back to you shortly.";
  }
}
