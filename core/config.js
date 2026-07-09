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
  // Matches a greeting-ish prefix ("hey/hay/hi/yo/ay/okay/ok") + anything
  // starting "fl" (flow/flo/floe/flaw/float/flown/flows/flowing/...).
  // Broadened on purpose: at a distance, speech-to-text mishears both the
  // greeting AND "flow" itself, so this trades a little false-positive risk
  // (harmless — it just opens the mic and times out after 3s) for much
  // better recall on quiet/far-away audio.
  // Wake pattern — wider net for how Web Speech API actually mishears
  // "Hey Flow" in practice: "a/hay/hey/ay/yo/okay" + up to 2 filler words/punctuation + "flo*"
  // "flo*" alone (without a trigger word) is no longer required to also match "they/say/play" etc,
  // because those gave false POSITIVES before. This version trades a few more false negatives
  // for far fewer accidental triggers, and widens the "flow" misheard-spelling set.
  WAKE_REGEX: /\b(?:hey|hay|hi+|yo|ay|okay|ok|k|hyy|ei|eh)\b[\s,.!]{0,4}\b(?:flow|flo|floe|floh|floor|flue|flew|flu|flau)\w{0,3}\b/i,
  // Self-hosted voice service (openWakeWord + faster-whisper), replacing
  // Deepgram's Voice Agent — set this to your Railway deployment's real
  // WebSocket URL once flow-voice-service is deployed (Railway shows this
  // under the service's Settings -> Networking -> Public Domain, prefixed
  // with wss:// instead of https://). Voice will show a clear connection
  // error until this is set to a real value.
  VOICE_SERVICE_URL: "wss://flow-v3-production.up.railway.app",
  WEATHER_TTL:   10 * 60 * 1000,

  ORB: {
    RADIUS:       90,
    NET_RADIUS:   135,
    NODE_COUNT:   48,
    SMOKE_LAYERS: 6,
  },
};
