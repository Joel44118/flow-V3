// ═══════════════════════════════════════════
// api/chat.js — HuggingFace Inference API
//
// WHY HF INSTEAD OF OPENROUTER:
//   OpenRouter free tier: 8,561 token context limit
//   Flow's system prompt alone exceeds that → error
//   HuggingFace free tier: much larger context windows
//
// VERCEL ENV VARS NEEDED (Dashboard → Settings → Environment Variables):
//   HF_TOKEN  ← your HuggingFace token (read-only is fine)
//
// MODEL CHAIN (same intent routing, different provider):
//   code     → Qwen/Qwen2.5-Coder-32B-Instruct  (best free coder)
//   research → meta-llama/Llama-3.3-70B-Instruct  (large, smart)
//   chat     → mistralai/Mistral-7B-Instruct-v0.3  (fast, free)
//   creative → mistralai/Mistral-7B-Instruct-v0.3
//   pdf      → meta-llama/Llama-3.1-8B-Instruct   (structured)
//   image    → meta-llama/Llama-3.1-8B-Instruct
//
// YES — Flow still reads his replies (TTS is in speech.js, not here)
// YES — model chaining still works (classify → route → generate)
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

// Fallback chain — all HF free models
const FALLBACKS = [
  "mistralai/Mistral-7B-Instruct-v0.3",
  "meta-llama/Llama-3.1-8B-Instruct",
  "HuggingFaceH4/zephyr-7b-beta",
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

// Trim conversation history to stay well under token limits
// HF free models are generous but we keep it sane
function trimMessages(messages) {
  const system = messages.find(m => m.role === "system");
  const history = messages.filter(m => m.role !== "system");

  // Keep system prompt + last 10 exchanges (20 messages)
  const trimmedHistory = history.slice(-20);

  // Trim system prompt if needed — keep personality + capabilities
  // but cut the RAG block if the prompt is huge
  if (system) {
    let sysContent = system.content;
    // If system prompt is very long, trim the knowledge base block
    if (sysContent.length > 6000) {
      // Remove the RAG/knowledge block (between KNOWLEDGE BASE and the next section)
      sysContent = sysContent.replace(/KNOWLEDGE BASE.*?(?=\nLIVE CONTEXT:)/s, "");
    }
    // If still long, trim identity capabilities to summary
    if (sysContent.length > 4000) {
      sysContent = sysContent.replace(/WHAT I \(FLOW\) CAN ACTUALLY DO[\s\S]*?(?=\nMY NAME)/s,
        "I am Flow, Joel's personal AI. I can do voice, vision, web search, alarms, goals, and more.\n");
    }
    return [{ role: "system", content: sysContent }, ...trimmedHistory];
  }

  return trimmedHistory;
}

// Classify intent using a fast small model
async function classifyIntent(userMsg, token) {
  try {
    const r = await fetch(HF_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:      "mistralai/Mistral-7B-Instruct-v0.3",
        max_tokens: 10,
        messages: [{
          role:    "user",
          content: `Reply with EXACTLY one word — code, pdf, image, research, creative, or chat.\nMessage: "${userMsg.slice(0, 200)}"`,
        }],
      }),
    });
    const data   = await r.json();
    const intent = data.choices?.[0]?.message?.content?.trim().toLowerCase().replace(/[^a-z]/g, "") || "chat";
    return Object.keys(INTENT_MODEL).includes(intent) ? intent : "chat";
  } catch {
    return "chat";
  }
}

// Generate reply using HuggingFace chat completions
async function generate(messages, maxTokens, model, token) {
  const r = await fetch(HF_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stop:       STOP_TOKENS,
      messages,
    }),
  });

  const data = await r.json();

  if (!r.ok || !data.choices?.length) {
    const errMsg = data?.error?.message || data?.error || `HTTP ${r.status}`;
    throw new Error(`${model}: ${errMsg}`);
  }

  return {
    reply: cleanReply(data.choices[0].message.content),
    model,
  };
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
      error: "HF_TOKEN not set. Add it in Vercel Dashboard → Settings → Environment Variables.",
    });
  }

  const { messages } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  // Trim history to avoid token overflow
  const trimmedMessages = trimMessages(messages);

  // Pull last user message for intent classification
  const lastUser = [...trimmedMessages].reverse().find(m => m.role === "user")?.content || "";

  // Step 1: classify intent (fast)
  const intent     = await classifyIntent(lastUser, token);
  const maxTokens  = TOKEN_LIMIT[intent] || 600;
  const primary    = INTENT_MODEL[intent];

  console.log(`[Flow] intent=${intent} model=${primary} tokens=${maxTokens}`);

  // Step 2: try primary model then fallbacks
  const queue   = [primary, ...FALLBACKS.filter(m => m !== primary)];
  let   lastErr = "All models failed";

  for (const model of queue) {
    try {
      const result = await generate(trimmedMessages, maxTokens, model, token);
      return res.status(200).json({ ...result, intent });
    } catch (e) {
      lastErr = e.message;
      console.warn(`[Flow] ${model} failed: ${e.message}`);
    }
  }

  return res.status(502).json({ error: lastErr });
}
