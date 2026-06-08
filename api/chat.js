// ═══════════════════════════════════════════
// api/chat.js — Vercel serverless function
//
// OpenRouter model chain (from their email tip):
//   Step 1: gpt-4o-mini classifies intent (10 tokens, ~$0.000001)
//   Step 2: routes to best model per intent
//
// Intent → Model mapping:
//   code     → anthropic/claude-sonnet-4-5     (best code generation)
//   pdf      → openai/gpt-4o-mini              (structured extraction)
//   image    → openai/gpt-4o-mini              (vision capable)
//   research → meta-llama/llama-3.3-70b:free   (large context, breadth)
//   creative → meta-llama/llama-3.1-8b:free    (creative, free)
//   chat     → meta-llama/llama-3.1-8b:free    (fast, free, personal)
// ═══════════════════════════════════════════

const INTENT_MODEL = {
  code:     "anthropic/claude-sonnet-4-5",
  pdf:      "openai/gpt-4o-mini",
  image:    "openai/gpt-4o-mini",
  research: "meta-llama/llama-3.3-70b-instruct:free",
  creative: "meta-llama/llama-3.1-8b-instruct:free",
  chat:     "meta-llama/llama-3.1-8b-instruct:free",
};

// Token limits per intent — code needs much more room
const TOKEN_LIMIT = {
  code:     2500,
  pdf:      1500,
  image:    800,
  research: 1000,
  creative: 800,
  chat:     500,
};

const FALLBACKS = [
  "google/gemini-flash-1.5",
  "openai/gpt-4o-mini",
  "meta-llama/llama-3.1-8b-instruct:free",
];

const STOP = ["</assistant>","<|eot_id|>","Human:","User:","Assistant:"];

function clean(text) {
  return text
    .replace(/<\/?assistant>/gi,"")
    .replace(/<\|eot_id\|>/g,"")
    .replace(/^(assistant|flow)\s*:/i,"")
    .replace(/\*\*/g,"")
    .replace(/^#+\s/gm,"")
    .trim();
}

// Step 1: classify intent — fast, cheap, 10 tokens
async function classifyIntent(userMsg, key, referer) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json",
        "HTTP-Referer":  referer,
        "X-Title":       "Flow AI V3",
      },
      body: JSON.stringify({
        model:      "openai/gpt-4o-mini",
        max_tokens: 10,
        messages: [{
          role:    "user",
          content: `Classify this message into one word only: code, pdf, image, research, creative, or chat.\nMessage: "${userMsg.slice(0,300)}"\nRespond with exactly one word.`
        }]
      }),
    });
    const data   = await r.json();
    const intent = data.choices?.[0]?.message?.content?.trim().toLowerCase().replace(/[^a-z]/g,"") || "chat";
    return Object.keys(INTENT_MODEL).includes(intent) ? intent : "chat";
  } catch { return "chat"; }
}

// Step 2: generate reply with the right model
async function generate(messages, max_tokens, model, key, referer) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  referer,
      "X-Title":       "Flow AI V3",
    },
    body: JSON.stringify({ model, max_tokens, stop: STOP, messages }),
  });
  const data = await r.json();
  if (!r.ok || !data.choices?.length) {
    throw new Error(data?.error?.message || `HTTP ${r.status} — ${model}`);
  }
  return { reply: clean(data.choices[0].message.content), model, intent: null };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "OPENROUTER_API_KEY not set in Vercel env vars." });

  const { messages, max_tokens = 600 } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const referer = req.headers.origin || "https://flow-v3-mu.vercel.app";

  // Pull last user message for classification
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";

  // Step 1: classify
  const intent = await classifyIntent(lastUser, key, referer);
  const tokenLimit = TOKEN_LIMIT[intent] || 600;
  const primary    = INTENT_MODEL[intent];

  console.log(`[Flow] intent=${intent} model=${primary} tokens=${tokenLimit}`);

  // Step 2: try primary model, then fallbacks
  const queue = [primary, ...FALLBACKS.filter(m => m !== primary)];
  let lastErr = "All models failed";

  for (const model of queue) {
    try {
      const result = await generate(messages, tokenLimit, model, key, referer);
      return res.status(200).json({ ...result, intent });
    } catch(e) {
      lastErr = e.message;
      console.warn(`[Flow] ${model} failed: ${e.message}`);
    }
  }

  return res.status(502).json({ error: lastErr });
}
