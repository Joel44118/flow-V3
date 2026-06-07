// ═══════════════════════════════════════════
// api/chat.js — Vercel serverless function
// Uses OpenRouter model chaining:
//   Step 1: gpt-4o-mini classifies intent (fast, cheap)
//   Step 2: routes to best model for that intent
// API key NEVER leaves this file.
// ═══════════════════════════════════════════

const KEY_HEADER = () => ({
  "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
  "Content-Type":  "application/json",
  "HTTP-Referer":  "https://flow-v3-mu.vercel.app",
  "X-Title":       "Flow AI V3",
});

// Intent → best model for the job
const MODEL_MAP = {
  code:     "openai/gpt-4o-mini",               // code: reliable, fast, good output
  research: "meta-llama/llama-3.3-70b-instruct:free", // research: needs breadth
  creative: "meta-llama/llama-3.1-8b-instruct:free",  // creative: free, good
  chat:     "meta-llama/llama-3.1-8b-instruct:free",  // casual chat: free model
  analysis: "openai/gpt-4o-mini",               // analysis: structured, accurate
};

const FALLBACK_MODELS = [
  "meta-llama/llama-3.1-8b-instruct:free",
  "google/gemini-flash-1.5",
  "openai/gpt-4o-mini",
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

// Step 1: classify intent with gpt-4o-mini (fast + cheap)
async function classifyIntent(userMessage, key) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://flow-v3-mu.vercel.app",
        "X-Title":       "Flow AI V3",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        max_tokens: 10,
        messages: [{
          role: "user",
          content: `Classify this message into exactly one word: code, research, creative, analysis, or chat.\nMessage: "${userMessage.slice(0, 200)}"\nReply with only the one word.`
        }]
      }),
    });
    const data = await r.json();
    const intent = data.choices?.[0]?.message?.content?.trim().toLowerCase() || "chat";
    // Validate — only accept known intents
    return ["code","research","creative","analysis","chat"].includes(intent) ? intent : "chat";
  } catch(e) {
    return "chat"; // classification failed, default to chat
  }
}

// Step 2: generate with the right model for the intent
async function generate(messages, max_tokens, model, key) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type":  "application/json",
      "HTTP-Referer":  "https://flow-v3-mu.vercel.app",
      "X-Title":       "Flow AI V3",
    },
    body: JSON.stringify({ model, max_tokens, stop: STOP, messages }),
  });
  const data = await r.json();
  if (!r.ok || !data.choices?.length) {
    throw new Error(data?.error?.message || `HTTP ${r.status} from ${model}`);
  }
  return { reply: clean(data.choices[0].message.content), model };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({
    error: "OPENROUTER_API_KEY not set in Vercel environment variables."
  });

  const { messages, max_tokens = 800 } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  // Pull last user message for classification
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";

  // Step 1: classify intent
  const intent = await classifyIntent(lastUser, key);
  console.log(`[Flow] Intent: ${intent} | Query: ${lastUser.slice(0,60)}`);

  // Step 2: pick best model for intent
  // For code: raise token limit automatically
  const tokenLimit = intent === "code" ? Math.max(max_tokens, 2000) : max_tokens;
  const primaryModel = MODEL_MAP[intent] || MODEL_MAP.chat;

  // Try primary model, then fallbacks
  const modelsToTry = [primaryModel, ...FALLBACK_MODELS.filter(m => m !== primaryModel)];

  let lastErr = "All models failed";
  for (const model of modelsToTry) {
    try {
      const result = await generate(messages, tokenLimit, model, key);
      return res.status(200).json({ ...result, intent });
    } catch(e) {
      lastErr = e.message;
      console.warn(`[Flow] ${model} failed: ${e.message}`);
    }
  }

  return res.status(502).json({ error: lastErr });
}
