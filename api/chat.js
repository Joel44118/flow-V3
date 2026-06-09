export const config = { maxDuration: 45 };

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// Free models on OpenRouter that are reliably online (updated June 2026)
const MODELS = [
  "meta-llama/llama-3.1-8b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "google/gemma-3-1b-it:free",
  "microsoft/phi-3-mini-128k-instruct:free",
];

// Detect intent locally — zero API calls, zero latency
function detectIntent(msg) {
  const m = msg.toLowerCase();
  if (/\b(code|function|script|html|css|js|python|write me|build me|create a|implement)\b/.test(m)) return "code";
  if (/\b(search|find|look up|latest|news|research|what is|who is|when did)\b/.test(m)) return "research";
  if (/\b(image|picture|photo|generate|draw|design|logo|banner|wallpaper)\b/.test(m)) return "image";
  return "chat";
}

// Trim messages so total tokens stay well under 8000
// Rough estimate: 1 token ≈ 4 chars
function trimMessages(systemPrompt, history) {
  const SYS_LIMIT = 2000;   // chars for system prompt
  const HIST_LIMIT = 12000; // chars for history
  const MSG_LIMIT = 500;    // chars per individual message

  // Trim system prompt if too long
  let sys = systemPrompt;
  if (sys.length > SYS_LIMIT) {
    sys = sys.slice(0, SYS_LIMIT) + "\n[trimmed for context limit]";
  }

  // Trim each message content
  let msgs = history.map(m => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content.slice(0, MSG_LIMIT)
      : m.content
  }));

  // Drop oldest messages until total history fits
  let totalChars = msgs.reduce((acc, m) => acc + (m.content?.length || 0), 0);
  while (totalChars > HIST_LIMIT && msgs.length > 2) {
    const removed = msgs.shift();
    totalChars -= removed.content?.length || 0;
  }

  return { sys, msgs };
}

async function callOpenRouter(model, systemPrompt, messages, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20s per model

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://flow-v3-mu.vercel.app",
        "X-Title": "Flow AI"
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errMsg = err?.error?.message || `HTTP ${res.status}`;
      
      // Token limit error — caller will retry with more trimming
      if (errMsg.includes("Prompt tokens limit exceeded") || errMsg.includes("context_length_exceeded")) {
        throw new Error("TOKEN_LIMIT: " + errMsg);
      }
      throw new Error(errMsg);
    }

    const data = await res.json();
    if (!data.choices?.[0]?.message?.content) {
      throw new Error("Empty response from model");
    }
    return data.choices[0].message.content;

  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages = [], systemPrompt = "", intent } = req.body;

  if (!OPENROUTER_KEY) {
    return res.status(500).json({ error: "OPENROUTER_API_KEY not set in Vercel environment variables." });
  }

  // Pick max tokens based on intent
  const detectedIntent = intent || detectIntent(messages[messages.length - 1]?.content || "");
  const maxTokens = detectedIntent === "code" ? 2000 : detectedIntent === "research" ? 1500 : 800;

  // Trim everything to fit within free tier limits
  const { sys, msgs } = trimMessages(systemPrompt, messages);

  let lastError = "";

  for (const model of MODELS) {
    try {
      console.log(`[Flow] Trying model: ${model}`);
      const reply = await callOpenRouter(model, sys, msgs, maxTokens);
      console.log(`[Flow] Success with: ${model}`);
      return res.status(200).json({ reply, model });

    } catch (e) {
      lastError = e.message;
      console.warn(`[Flow] ${model} failed: ${e.message}`);

      // If token limit, trim harder and retry same model once
      if (e.message.startsWith("TOKEN_LIMIT")) {
        try {
          console.log(`[Flow] Retrying ${model} with aggressive trim`);
          const aggressiveMsgs = msgs.slice(-3); // only last 3 messages
          const shortSys = sys.slice(0, 800);
          const reply = await callOpenRouter(model, shortSys, aggressiveMsgs, 600);
          return res.status(200).json({ reply, model });
        } catch (e2) {
          console.warn(`[Flow] Aggressive retry failed: ${e2.message}`);
        }
      }
      // Otherwise try next model
      continue;
    }
  }

  // All models failed
  return res.status(503).json({
    error: `Flow is having trouble connecting right now. Last error: ${lastError}. Please try again in a moment.`
  });
}
