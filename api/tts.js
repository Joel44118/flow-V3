// api/tts.js — ElevenLabs TTS proxy
// Add ELEVENLABS_API_KEY in Vercel → Settings → Environment Variables
// Free tier: 10,000 chars/month at elevenlabs.io (no card needed)
// Voice: Adam (pNInz6obpgDQGcFmaJgB) — natural male, same on every device

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: "ELEVENLABS_API_KEY not set" });

  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text required" });

  const VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Adam — free, natural male

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method:  "POST",
      headers: {
        "xi-api-key":   key,
        "Content-Type": "application/json",
        "Accept":       "audio/mpeg",
      },
      body: JSON.stringify({
        text:           text.slice(0, 500),
        model_id:       "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0 },
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err });
    }

    const buf = await r.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(Buffer.from(buf));
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
