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
      const errText = await r.text();
      // ElevenLabs returns 401 for TWO different causes that look identical
      // at the status-code level: an invalid/rotated API key, or a valid key
      // that's simply out of free-tier quota (10,000 chars/month). Parse the
      // real "status" field out of their JSON body so the caller (and Joel,
      // reading the console) can tell which one it actually is instead of
      // guessing — this was previously being swallowed as an opaque string.
      let reason = "unknown";
      try {
        const parsed = JSON.parse(errText);
        reason = parsed?.detail?.status || "unknown";
      } catch {
        // response wasn't JSON — leave reason as "unknown"
      }
      console.error(`[Flow TTS] ElevenLabs ${r.status} — reason: ${reason}`);
      return res.status(r.status).json({ error: errText, reason });
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
    // The correct endpoint for a short-lived client-side token is the
    // dedicated /v1/auth/grant route — NOT a projects lookup followed by a
    // scoped-key creation call. That two-step flow was fragile (an extra
    // network hop that could fail independently) and used the wrong mental
    // model entirely; /v1/auth/grant exists specifically for this.
    // Default TTL is only 30s, which is far too short for a voice session
    // that stays open while Joel talks — explicitly requesting a longer TTL.
    const grantRes = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method:  "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 3600 }), // bumped from 300s — the shorter TTL, combined with getUserMedia's variable delay before the token was ever used, was likely causing tokens to go stale before the WebSocket handshake happened. 3600s (Deepgram's max) removes that risk entirely; the token is still short-lived relative to a real session and still only used once per connection attempt.
    });

    if (!grantRes.ok) {
      const errText = await grantRes.text();
      throw new Error(`Deepgram grant failed: ${grantRes.status} ${errText.slice(0, 200)}`);
    }
    const grant = await grantRes.json();
    const token = grant.access_token || grant.token || grant.key;
    if (!token) throw new Error("Deepgram grant returned no token field");

    return res.status(200).json({ configured: true, key: token });
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
  if (action === "groqthink") return handleGroqThinkConfig(req, res);
  return handleSpeak(req, res);
}

// Returns the Groq BYO endpoint config for Deepgram's Voice Agent "think"
// stage — url + auth header — WITHOUT ever sending the raw GROQ_API_KEY to
// the browser as a bare value the client could read. The browser still
// technically receives the header value here (Deepgram's Settings message
// has to carry it, since Deepgram's servers — not ours — call Groq
// directly), but this keeps it server-sourced from Vercel's existing env
// var rather than hardcoded in a committed file, and scoped to this one
// endpoint rather than reused across other client-side code.
function handleGroqThinkConfig(req, res) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(200).json({ configured: false });
  return res.status(200).json({
    configured: true,
    endpoint: {
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: { Authorization: `Bearer ${key}` },
    },
  });
}
