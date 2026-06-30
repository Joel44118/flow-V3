// api/tts.js — Voice: ElevenLabs TTS (speak) + Deepgram token (listen)
// Merged into one file to stay within Vercel's 12-function Hobby plan limit.
// Routes by ?action= query param: default = ElevenLabs speak, ?action=token = Deepgram
//
// ── ELEVENLABS (text-to-speech, Flow's voice) ──────────────────────────────
// Add ELEVENLABS_API_KEY in Vercel env vars. Free tier: 10,000 chars/month.
// Voice: Adam (pNInz6obpgDQGcFmaJgB) — natural male, same on every device.
//
// ── DEEPGRAM (speech-to-text, listening accuracy) ──────────────────────────
// Add DEEPGRAM_API_KEY in Vercel env vars. Free tier: 200 min/month.
// Get key at: https://console.deepgram.com → Create Project → API Keys
// This route issues a short-lived (5 min) scoped key so the real key never
// reaches the browser.

const EL_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Adam

async function handleSpeak(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: "ELEVENLABS_API_KEY not set" });

  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text required" });

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}`, {
      method:  "POST",
      headers: {
        "xi-api-key":   key,
        "Content-Type": "application/json",
        "Accept":       "audio/mpeg",
      },
      body: JSON.stringify({
        text:           text.slice(0, 500),
        model_id:       "eleven_multilingual_v2",
        voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.0, speed: 0.85 },
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

async function handleDeepgramToken(req, res) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(503).json({ error: "DEEPGRAM_API_KEY not set", configured: false });

  try {
    const projRes = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${key}` },
    });
    const projects  = await projRes.json();
    const projectId = projects?.projects?.[0]?.project_id;
    if (!projectId) throw new Error("No Deepgram project found on this account");

    const grantRes = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
      method:  "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        comment:                 "flow-temp-" + Date.now(),
        scopes:                  ["usage:write"],
        time_to_live_in_seconds: 300, // 5 minutes
      }),
    });

    if (!grantRes.ok) throw new Error(`Deepgram key grant failed: ${grantRes.status}`);
    const grant = await grantRes.json();

    return res.status(200).json({ configured: true, key: grant.key });
  } catch (e) {
    console.error("[Flow Deepgram] token error:", e.message);
    return res.status(502).json({ error: e.message, configured: true });
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query?.action || "speak";

  if (action === "token") return handleDeepgramToken(req, res);
  return handleSpeak(req, res);
}
