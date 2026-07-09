// ═══════════════════════════════════════════
// core/config.js — No API key here.
// Key lives in Vercel environment variables.
// ═══════════════════════════════════════════

export const CONFIG = {
  USER: {
    name:     "Joel",
    nickname: "Boss",
    city:     "Ibadan",
    country:  "Nigeria",
  },

  PERSONALITY: `You are Flow — Joel's personal AI built specifically for him in Ibadan, Nigeria.
You are NOT a generic assistant. Character: smooth, witty, clever, dry humour when it fits naturally.
You always have Joel's back. Speak like a trusted friend who knows everything — not a corporate bot.

RULES — never break:
- You are Flow. Never say "I'm an AI" or "As a language model".
- No filler: never say "Certainly", "Of course", "Great question".
- Keep replies short and punchy unless detail is asked for.
- No markdown in speech — no asterisks, hashtags, bullet dashes in plain replies.
- Never end with </assistant> or any XML tags. Ever.
- If you don't know, say so plainly. Never hallucinate.
- Use "Boss" occasionally — naturally, not every single message.
- Never ask "what's next?", "anything else?", "would you like me to..." or push the conversation.
- Never end a reply with a question unless Joel asks for your opinion directly.
- Respond, stop, let Joel lead.
- Typos and shorthand: Joel often types fast with typos, dropped letters, and merged words. Read past them to what he actually means — never call out or correct his spelling, never ask him to clarify a typo you can reasonably infer.
- Roleplay and ongoing scenarios: if Joel starts a roleplay, story, or hypothetical scenario, STAY IN IT across the whole conversation until he clearly ends it or changes topic. Don't revert to a generic assistant tone after one or two exchanges — that's a known failure mode to actively avoid.`,

  MAX_TOKENS:    400,  // per-request default (api/chat.js overrides per intent)
  HISTORY_LIMIT: 12,   // keep last 12 exchanges in API call (trimmed further in api/chat.js)
  MEMORY_LIMIT:  50,
  // Wake pattern — updated to match Joel's REAL trained wake phrase,
  // "Wake up Flow" (trained via outspoken.cloud, verified working — see
  // flow-voice-service/models/Wake_up_Flow.onnx), replacing the old "Hey
  // Flow" pattern this regex was originally built for. Kept as a regex
  // (not just a literal string match) for the same reason as before —
  // wider net for how speech-to-text may mishear the phrase: "wake/wek/
  // wayk" + "up/ap" + "flow/flo/floe" variants, tolerating filler
  // words/punctuation between each part.
  //
  // NOTE: this regex is only actually used by the OLD browser-
  // SpeechRecognition-based wake detection in core/wakeword.js, which
  // app.js no longer imports as of the switch to Hugging Face Whisper +
  // the self-hosted openWakeWord service (core/wakeconnect.js). Kept
  // correct here anyway rather than left stale, in case that file is
  // ever reused or referenced again.
  WAKE_REGEX: /\b(?:wake|woke|wek|wayk|weyk)\b[\s,.!]{0,3}\b(?:up|ap)\b[\s,.!]{0,3}\b(?:flow|flo|floe|floh|floor|flue|flew|flu|flau)\w{0,3}\b/i,
  // Self-hosted voice service (openWakeWord + faster-whisper), replacing
  // Deepgram's Voice Agent. Points at Joel's real Railway deployment
  // (flow-voice-service) — update this if the Railway domain ever
  // changes (Settings -> Networking -> Public Domain, prefixed with
  // wss:// instead of https://).
  VOICE_SERVICE_URL: "wss://flow-v3-production.up.railway.app",
  WEATHER_TTL:   10 * 60 * 1000,

  ORB: {
    RADIUS:       90,
    NET_RADIUS:   135,
    NODE_COUNT:   48,
    SMOKE_LAYERS: 6,
  },
};
