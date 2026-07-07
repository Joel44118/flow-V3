// core/persona.js — "Think like Joel" style profile
//
// WHAT THIS ACTUALLY DOES, STATED PLAINLY: this builds a running profile of
// Joel's OWN writing style — tone, typical phrasing, how he handles certain
// recurring situations — from his actual messages, and injects that into
// the system prompt so Flow's account-side responses (Echo, in the
// Telegram userbot) sound more like Joel specifically, not like a generic
// assistant persona.
//
// WHAT THIS DOES NOT DO: it does not give Flow Joel's judgment, knowledge,
// or decision-making on situations Joel hasn't actually written about
// before. It's a STYLE match, not a mind copy — treat anything sensitive
// (money, contracts, disputes, commitments on Joel's behalf) as still
// needing Joel's real involvement, not Echo's best guess at "what Joel
// would probably say." Stated honestly rather than oversold.
//
// HOW IT BUILDS THE PROFILE: rather than re-analyzing Joel's entire message
// history on every single reply (slow, expensive, redundant), this keeps a
// small rolling profile in KV, updated periodically (every N messages, see
// UPDATE_INTERVAL below) by asking a model to extract concrete style
// patterns from a batch of Joel's recent real messages. The profile itself
// is just a few lines of plain-language description — not a fine-tuned
// model, not embeddings, just a system-prompt fragment that gets better
// over time as more of Joel's real messages get folded in.

const PROFILE_KEY = "flow_joel_style_profile";
const RAW_SAMPLES_KEY = "flow_joel_style_samples"; // rolling buffer of recent Joel messages, pre-profile-update
const UPDATE_INTERVAL = 20; // rebuild the profile every 20 new Joel messages collected
const MAX_SAMPLES = 40;     // keep at most this many raw samples between updates — bounded, not unbounded growth

async function kvGet(siteUrl, key) {
  try {
    const r = await fetch(`${siteUrl}/api/memory?key=${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.value ?? null;
  } catch (_) { return null; }
}
async function kvSet(siteUrl, key, value) {
  try {
    await fetch(`${siteUrl}/api/memory`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ key, value }),
    });
  } catch (_) {}
}

// Call this every time Joel sends a real message (from either the web app
// or the Telegram userbot) — NOT for messages Flow/Echo generates. Adds the
// message to a rolling buffer, and rebuilds the style profile once enough
// new samples have accumulated. Fire-and-forget from the caller's side —
// never blocks or slows down the actual reply Joel is waiting for.
export async function recordJoelMessage(siteUrl, text) {
  if (!text || text.trim().length < 4) return; // skip near-empty messages, no signal there
  try {
    const samples = (await kvGet(siteUrl, RAW_SAMPLES_KEY)) || [];
    samples.push(text.trim().slice(0, 400)); // cap per-sample length, avoid one huge message skewing storage
    const trimmed = samples.slice(-MAX_SAMPLES);
    await kvSet(siteUrl, RAW_SAMPLES_KEY, trimmed);

    if (trimmed.length > 0 && trimmed.length % UPDATE_INTERVAL === 0) {
      await _rebuildProfile(siteUrl, trimmed);
    }
  } catch (e) {
    console.warn("[Persona] recordJoelMessage failed silently:", e.message);
  }
}

async function _rebuildProfile(siteUrl, samples) {
  const EXTRACT_SYSTEM = `You are a writing-style analyst, not an assistant. You will be given a batch of real messages written by one person, Joel.
Extract ONLY concrete, observable patterns in how Joel writes — NOT what he's talking about, NOT any opinions or facts he states, just HOW he writes.
Look for: typical sentence length, directness, typos/shorthand patterns, filler words he uses or avoids, how he opens/closes messages, tone (casual/formal/blunt), any recurring phrases.
Reply in plain prose, under 100 words, describing the style only. No preamble, no markdown, no bullet points — just a short paragraph a system prompt could reuse directly, e.g. "Joel writes in short, direct sentences with minimal punctuation, often skips greetings, uses lowercase starts, and gets straight to the technical point without softening critical feedback."
If the samples don't show a clear consistent pattern yet, say so plainly instead of inventing one.`;

  try {
    const r = await fetch(`${siteUrl}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: samples.join("\n---\n") },
        ],
        force_intent: "chat",
      }),
    });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.reply) return;
    await kvSet(siteUrl, PROFILE_KEY, {
      description: data.reply.trim(),
      updatedAt:   Date.now(),
      sampleCount: samples.length,
    });
    console.log("[Persona] Style profile rebuilt from", samples.length, "samples");
  } catch (e) {
    console.warn("[Persona] _rebuildProfile failed silently:", e.message);
  }
}

// Call this wherever a system prompt is being built for a Joel-facing or
// account-side persona (e.g. core/ai.js, telegram-userbot/index.js's askFlow).
// Returns a ready-to-inject prompt fragment, or an empty string if no
// profile exists yet (e.g. brand new install, not enough samples collected).
// NEVER throws — a failed fetch here should just mean "no style info this
// time," not a broken reply.
export async function getPersonaPromptBlock(siteUrl) {
  try {
    const profile = await kvGet(siteUrl, PROFILE_KEY);
    if (!profile?.description) return "";
    return `\n\nJOEL'S WRITING STYLE (learned from his real messages, for matching tone only — this describes HOW Joel writes, not what to claim as his opinions or decisions):\n${profile.description}\n\nWhen writing AS Joel or ON Joel's behalf (e.g. Echo replying to someone on his personal Telegram), let this style inform tone and phrasing. Never use this to invent facts, commitments, or opinions Joel hasn't actually stated — style match only, not a substitute for Joel's real judgment on anything that matters.`;
  } catch (_) {
    return "";
  }
}
