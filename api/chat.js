// ═══════════════════════════════════════════
// api/chat.js — HuggingFace Inference API
//
// FIXES:
//   - HF cold-start 503 → retry up to 3x with 2s delay
//   - Faster models tried first (warm more often)
//   - 502 was caused by all models cold-starting simultaneously
//   - Now waits for model to warm up instead of failing instantly
//
// VERCEL ENV VARS:
//   HF_TOKEN  ← huggingface.co/settings/tokens (Read token, free)
//
// MODEL CHAIN:
//   code     → Qwen/Qwen2.5-Coder-32B-Instruct
//   research → meta-llama/Llama-3.3-70B-Instruct
//   chat     → mistralai/Mistral-7B-Instruct-v0.3 (fastest, stays warm)
//   creative → mistralai/Mistral-7B-Instruct-v0.3
//   pdf      → meta-llama/Llama-3.1-8B-Instruct
//   image    → meta-llama/Llama-3.1-8B-Instruct
// ═══════════════════════════════════════════

const HF_API = "https://api-inference.huggingface.co/v1/chat/completions";

const INTENT_MODEL = {
  code:     "Qwen/Qwen2.5-Coder-32B-Instruct",
  research: "meta-llama/Llama-3.3-70B-Instruct",
  pdf:      "meta-llama/Llama-3.1-8B-Instruct",
  image:    "meta-llama/Llama-3.1-8B-Instruct",
  creative: "mistralai/Mistral-7B-Instruct-v0.3",
  chat:     "mistralai/Mistral-7B-Instruct-v0.3",
};

const TOKEN_LIMIT = {
  code:     3000,
  research: 1500,
  pdf:      1500,
  image:    800,
  creative: 800,
  chat:     600,
};

// Fallbacks ordered by how likely they are to be warm
const FALLBACKS = [
  "mistralai/Mistral-7B-Instruct-v0.3",       // most popular → stays warm
  "meta-llama/Llama-3.1-8B-Instruct",          // very popular
  "HuggingFaceH4/zephyr-7b-beta",              // always available
];

const STOP_TOKENS = ["</s>", "<|eot_id|>", "Human:", "User:", "Assistant:", "</assistant>"];

function cleanReply(text) {
  return text
    .replace(/<\/?assistant>/gi, "")
    .replace(/<\|eot_id\|>/g, "")
    .replace(/^(assistant|flow)\s*:/i, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s/gm, "")
    .trim();
}

// Trim system prompt + history to avoid token overflow
function trimMessages(messages) {
  const system  = messages.find(m => m.role === "system");
  const history = messages.filter(m => m.role !== "system").slice(-16);

  if (!system) return history;

  let sysContent = system.content;

  // If system prompt > 5000 chars, strip the RAG knowledge block first
  if (sysContent.length > 5000) {
    sysContent = sysContent.replace(/KNOWLEDGE BASE[\s\S]*?(?=\nLIVE CONTEXT:)/s, "");
  }
  // If still > 3500, condense the identity block
  if (sysContent.length > 3500) {
    sysContent = sysContent.replace(/WHAT I \(FLOW\) CAN DO[\s\S]*?(?=\nI am Flow)/s,
      "I am Flow V3, Joel's personal AI. Voice, vision, web search, alarms, goals, code, images — I handle it all.\n");
  }

  return [{ role: "system", content: sysContent }, ...history];
}

// Classify intent with the smallest fastest model
async function classifyIntent(userMsg, token) {
  try {
    const r = await fetch(HF_API, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model:      "mistralai/Mistral-7B-Instruct-v0.3",
        max_tokens: 8,
        messages: [{
          role:    "user",
          content: `One word only — code, pdf, image, research, creative, or chat.\nMessage: "${userMsg.slice(0, 150)}"`,
        }],
      }),
    });
    if (!r.ok) return "chat";
    const data   = await r.json();
    const intent = data.choices?.[0]?.message?.content?.trim().toLowerCase().replace(/[^a-z]/g, "") || "chat";
    return Object.keys(INTENT_MODEL).includes(intent) ? intent : "chat";
  } catch {
    return "chat";
  }
}

// Generate with retry on 503 (model cold-starting)
async function generate(messages, maxTokens, model, token) {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch(HF_API, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens, stop: STOP_TOKENS, messages }),
    });

    // 503 = model is loading (cold start) — wait and retry
    if (r.status === 503) {
      if (attempt < MAX_RETRIES) {
        console.log(`[Flow] ${model} loading (503), retry ${attempt}/${MAX_RETRIES}...`);
        await new Promise(resolve => setTimeout(resolve, 2500 * attempt));
        continue;
      }
      throw new Error(`${model} still loading after ${MAX_RETRIES} retries`);
    }

    const data = await r.json();

    if (!r.ok || !data.choices?.length) {
      const errMsg = data?.error?.message || data?.error || `HTTP ${r.status}`;
      throw new Error(`${model}: ${errMsg}`);
    }

    return { reply: cleanReply(data.choices[0].message.content), model };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  const token = process.env.HF_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: "HF_TOKEN not set. Go to Vercel Dashboard → Settings → Environment Variables → add HF_TOKEN.",
    });
  }

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const trimmed  = trimMessages(messages);
  const lastUser = [...trimmed].reverse().find(m => m.role === "user")?.content || "";

  // Classify intent (if it fails, defaults to "chat")
  const intent    = await classifyIntent(lastUser, token);
  const maxTokens = TOKEN_LIMIT[intent] || 600;
  const primary   = INTENT_MODEL[intent];

  console.log(`[Flow] intent=${intent} model=${primary} tokens=${maxTokens}`);

  // Try primary model, then fallbacks
  const queue   = [primary, ...FALLBACKS.filter(m => m !== primary)];
  let   lastErr = "All models failed";

  for (const model of queue) {
    try {
      const result = await generate(trimmed, maxTokens, model, token);
      return res.status(200).json({ ...result, intent });
    } catch (e) {
      lastErr = e.message;
      console.warn(`[Flow] ${model} failed: ${e.message}`);
    }
  }

  return res.status(502).json({ error: lastErr });
}
