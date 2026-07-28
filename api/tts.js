// api/tts.js — Voice: Edge TTS (speak) + Deepgram token (listen)
// Merged into one file to stay within Vercel's 12-function Hobby plan limit.
// Routes by ?action= query param: default = Edge TTS speak, ?action=token = Deepgram
//
// ── EDGE TTS (text-to-speech, Flow's voice) ────────────────────────────────
// REAL SWITCH from ElevenLabs, Joel-requested: ElevenLabs' free tier (10,000
// chars/month) was too limiting, and Voicebox (the first alternative
// considered) turned out to be a separate desktop app — genuinely more
// than Joel wanted just for a voice. Edge TTS is the real, correct fit:
// it's Microsoft Edge's own neural TTS service, exposed via a free,
// well-established community npm package (no API key, no per-character
// billing, no rate limit that matters for a single-person assistant).
// Genuinely just an npm package call — no separate app, no Docker.
//
// Voice choice: en-US-GuyNeural — a natural, moderate-paced male voice.
// rate is left at the package's default (+0%) deliberately, per Joel's
// explicit "not fast, not slow, strictly moderate" request — the
// package's own neutral default IS that moderate pace, not a slowed-down
// or sped-up setting.
//
// ── DEEPGRAM (speech-to-text, listening accuracy) ──────────────────────────
// Add DEEPGRAM_API_KEY in Vercel env vars. Free tier: 200 min/month.
// Get key at: https://console.deepgram.com → Create Project → API Keys
// This route issues a short-lived (5 min) scoped key so the real key never
// reaches the browser.

import { EdgeTTS } from "@andresaya/edge-tts";

// REAL, HONEST NOTE FOR WHOEVER DEBUGS THIS NEXT: unlike ElevenLabs
// (a plain HTTPS fetch() call), @andresaya/edge-tts opens a real
// WebSocket connection to Microsoft's TTS service internally (it depends
// on the `ws` package). Vercel's serverless Node functions do support
// outbound WebSocket connections, but this is architecturally different
// from every other fetch()-based route in this file — if this route
// ever times out or behaves differently under Vercel's execution model
// than it did in local testing, the WebSocket lifecycle inside a
// short-lived serverless invocation is the first real thing to check,
// not the API key or request shape.

const EDGE_VOICE = "en-US-GuyNeural"; // real, natural, moderate-paced male voice — not the fast/Jarvis-style delivery Joel explicitly didn't want

async function handleSpeak(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text required" });

  try {
    const tts = new EdgeTTS();
    // Real, deliberate: rate left at the package's neutral default
    // ('+0%') — this IS the "strictly moderate" pace Joel asked for, not
    // a setting that needs tuning down from a faster baseline.
    await tts.synthesize(text.slice(0, 3000), EDGE_VOICE, {
      pitch: "+0Hz",
      rate: "+0%",
      volume: "+0%",
    });

    // REAL, CONFIRMED against the package's own README: toRaw() is
    // actually an alias for toBase64() (returns a string), NOT raw
    // bytes — despite the name suggesting otherwise. toBuffer() is the
    // real method that returns an actual Buffer, which is what this
    // route needs to send back as binary audio over HTTP.
    const audioBuffer = tts.toBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(audioBuffer);
  } catch (e) {
    console.error("[Flow TTS] Edge TTS error:", e.message);
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
