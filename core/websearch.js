// ═══════════════════════════════════════════
// core/websearch.js
// ═══════════════════════════════════════════
import { CONFIG } from "./config.js";

// ── Detect query intent ───────────────────────────────────────────────────
// Returns: "news" | "deep" | "quick"
function detectMode(query) {
  const q = query.toLowerCase();
  if (/latest|recent|news|update|today|this week|current|right now|happening|just|breaking/i.test(q))
    return "news";
  if (/research|explain|how does|what is|compare|history|overview|guide/i.test(q))
    return "deep";
  return "quick";
}

// ── Extract the actual subject from natural language ─────────────────────
// "tell me the latest news on Elon" → "Elon Musk"
// "what's happening with Tesla"     → "Tesla"
function extractQuery(text) {
  return text
    .replace(/^(search for|search|look up|find|tell me|what('s| is)|give me|show me|latest|recent|news on|news about|update on|updates on|info on|information on|about|regarding)\s+/gi, "")
    .replace(/\?$/, "")
    .trim();
}

// ── Core search ───────────────────────────────────────────────────────────
export async function webSearch(query, mode) {
  const resolvedMode = mode || detectMode(query);
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(query)}&mode=${resolvedMode}`);
    const data = await res.json();
    return { results: data.results || [], mode: resolvedMode };
  } catch(e) {
    console.error("[Flow Search]", e.message);
    return { results: [], mode: resolvedMode };
  }
}

// ── Format results ────────────────────────────────────────────────────────
export function formatResults(results, query) {
  if (!results?.length) return `No results found for "${query}".`;
  return results
    .filter(r => r.snippet?.length > 10 || r.title?.length > 5)
    .slice(0, 4)
    .map((r, i) => {
      const pub     = r.pub ? ` [${new Date(r.pub).toLocaleDateString()}]` : "";
      const snippet = (r.snippet || "").slice(0, 300); // cap each snippet
      return `[${i+1}]${pub} ${r.title ? r.title + ": " : ""}${snippet}`;
    })
    .join("\n\n");
}

// ── Smart search: detects intent, routes to right mode, returns AI prompt ─
export async function smartSearch(rawText, sendToAI, chatAdd) {
  const query        = extractQuery(rawText);
  const mode         = detectMode(rawText);
  const modeLabel    = mode === "news" ? "latest news" : mode === "deep" ? "deep research" : "search results";

  chatAdd?.(`Searching for ${modeLabel} on "${query}"...`, "bot");

  const { results } = await webSearch(query, mode);

  if (!results?.length) {
    sendToAI(`I searched for "${query}" but found no results. Tell Joel you couldn't find anything and suggest he try rephrasing.`);
    return;
  }

  const context = formatResults(results, query);

  // Build a prompt that tells Flow exactly what was searched and how to respond
  const prompt = mode === "news"
    ? `Joel asked for the latest news/updates on "${query}". Here are the most recent results:\n\n${context}\n\nGive Joel a sharp briefing — what's actually happening with ${query} right now? Lead with the most important development. Be specific, current, and tell him if there's anything he should act on.`
    : mode === "deep"
    ? `Joel asked to research "${query}". Here are the search results:\n\n${context}\n\nGive Joel a clear, useful breakdown. Cover: what it is, why it matters, key facts, and any practical implications for him as a developer/entrepreneur in Nigeria.`
    : `Joel searched for "${query}". Here are the results:\n\n${context}\n\nGive Joel the key answer directly. Be concise and practical.`;

  sendToAI(prompt);
}

// ── Deep research (kept for backward compat) ──────────────────────────────
export async function deepResearch(topic, sendToAI) {
  const { results } = await webSearch(topic, "deep");
  if (!results?.length) {
    sendToAI(`I searched for "${topic}" but couldn't find anything useful.`);
    return;
  }
  const context = formatResults(results, topic);
  sendToAI(`Research results for "${topic}":\n\n${context}\n\nGive Joel a clear, structured breakdown covering the most important points.`);
}

// ── URL inspection ────────────────────────────────────────────────────────
export async function inspectUrl(url, sendToAI, chatAdd) {
  chatAdd?.(`Fetching ${url}...`, "bot");
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(url)}&mode=url`);
    const data = await res.json();
    if (data.error) { sendToAI(`Couldn't fetch that URL: ${data.error}`); return; }
    sendToAI(`Do a thorough analysis of this website. Cover: purpose, features, tech stack clues, content quality, target audience, pricing if any, and anything notable.\n\n${data.context}`);
  } catch(e) {
    sendToAI(`Failed to fetch that URL: ${e.message}`);
  }
}

export { formatResults as formatUrlResult };

// ── Business research (backward compat) ──────────────────────────────────
export async function businessResearch(sendToAI) {
  await smartSearch(
    "latest news Nigeria tech business development AI trends",
    sendToAI,
    null
  );
}
