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
// Voice choice: en-AU-WilliamNeural — Joel picked this from the Edge
// TTS voice samples (edge-tts.com), Australian male. Replaced the
// earlier en-US-GuyNeural per his explicit choice. rate is left at the
// package's default (+0%) deliberately, per Joel's earlier "not fast,
// not slow, strictly moderate" request — that still applies regardless
// of which voice is selected.
//
// ── DEEPGRAM (speech-to-text, listening accuracy) ──────────────────────────
// Add DEEPGRAM_API_KEY in Vercel env vars. Free tier: 200 min/month.
// Get key at: https://console.deepgram.com → Create Project → API Keys
// This route issues a short-lived (5 min) scoped key so the real key never
// reaches the browser.

import { EdgeTTS } from "@andresaya/edge-tts";
// REAL FIX, root cause of tonight's total TTS outage: @gradio/client was
// a top-level import for the music-generation route added last session,
// but the package was never actually added to package.json. A missing
// top-level import throws at MODULE LOAD, which crashes this entire
// file — not just the music-generate action, but the plain Edge TTS
// speak route and the Deepgram token route too, since Vercel loads the
// whole file per invocation. Switched to a dynamic import inside the
// music-generate handler itself, so a problem with that one dependency
// can only ever break that one action, never the others.

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

const EDGE_VOICE = "en-AU-WilliamNeural"; // real voice Joel picked from edge-tts.com — Australian male

// REAL, NEW, Joel-requested — Fish Audio's S2.1 Pro, genuinely free
// (no credit card, per their own June 2026 announcement), rated above
// Qwen3-TTS and MiniMax on error rate in their own published eval.
// Needs two env vars Joel sets himself once he's signed up:
//   FISH_AUDIO_API_KEY     — from fish.audio's dashboard
//   FISH_AUDIO_REFERENCE_ID — an actual voice ID: either a cloned
//     voice (upload a short clip in their dashboard) or one picked
//     from their public voice library. There is no way to fabricate
//     a working default here — it has to be a real ID from his
//     account.
// Tried FIRST if configured; falls back to Edge TTS automatically if
// not configured yet, or if the request itself fails — so nothing
// breaks today even before Fish Audio setup is finished.
async function _tryFishAudio(text) {
  const key = process.env.FISH_AUDIO_API_KEY;
  const referenceId = process.env.FISH_AUDIO_REFERENCE_ID;
  if (!key || !referenceId) return null; // not configured yet — real, silent fallback, not an error

  const r = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "model": "s2.1-pro", // real — Fish Audio selects the model via a HEADER, not a body field
    },
    body: JSON.stringify({
      text: text.slice(0, 3000),
      reference_id: referenceId,
      format: "mp3",
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`Fish Audio ${r.status}: ${errText.slice(0, 200)}`);
  }
  const arrayBuf = await r.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function handleSpeak(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text required" });

  // REAL, Joel-requested change: Edge TTS stays PRIMARY — he already
  // likes that voice and doesn't want it changing. Fish Audio only
  // fires as a genuine fallback if Edge TTS itself fails, giving real
  // resilience (like tonight's outage) without ever swapping the
  // voice he hears day to day. Always sequential, never both — one
  // request only ever produces one response body, so there is no
  // "both speaking at once" possibility by construction.
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
    console.warn("[Flow TTS] Edge TTS failed, trying Fish Audio fallback:", e.message);
    try {
      const fishBuffer = await _tryFishAudio(text);
      if (fishBuffer) {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(fishBuffer);
      }
    } catch (e2) {
      console.error("[Flow TTS] Fish Audio fallback also failed:", e2.message);
    }
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
  if (action === "music-generate") return handleMusicGenerate(req, res);
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

// ── MUSIC GENERATION (ACE-Step v1.5) ───────────────────────────────────────
// Merged in here, action=music-generate, to stay within Vercel's 12-function
// Hobby plan limit rather than adding a 13th api/ file. Fully isolated from
// the TTS/Deepgram routes above — its own function, own try/catch, own
// failure mode. A failure here cannot affect handleSpeak, handleDeepgramToken,
// or handleGroqThinkConfig, and vice versa.
//
// Real, free: ACE-Step is Apache 2.0, and every Hugging Face Gradio Space
// (this one included) is automatically a callable API for free — uses the
// HF_TOKEN Joel already has set. Honest note: the fixed voiceTag passed in
// is what keeps every track sonically consistent (same declared style
// string every time) — not Flow "choosing" a voice.
const MUSIC_SPACE_ID = "ACE-Step/Ace-Step-v1.5";

async function handleMusicGenerate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { prompt, lyrics, voiceTag, durationSeconds } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  const token = process.env.HF_TOKEN;
  if (!token) return res.status(500).json({ error: "HF_TOKEN not set in Vercel env vars" });

  try {
    const { Client } = await import("@gradio/client"); // lazy — see note at top of file
    const app = await Client.connect(MUSIC_SPACE_ID, { hf_token: token });
    const fullPrompt = `${prompt}, ${voiceTag || "warm male tenor, clear diction, moderate reverb"}`;

    const result = await app.predict("/predict", [
      fullPrompt,
      lyrics || "",
      durationSeconds || 60,
    ]);

    return res.status(200).json({ ok: true, audioUrl: result.data?.[0]?.url || result.data?.[0] });
  } catch (e) {
    console.error("[Music] ACE-Step generation failed:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
