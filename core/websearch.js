// ═══════════════════════════════════════════
// core/websearch.js — Web search + research
// ═══════════════════════════════════════════
import { CONFIG } from "./config.js";

// ── Quick search ─────────────────────────
export async function webSearch(query, mode = "quick") {
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(query)}&mode=${mode}`);
    const data = await res.json();
    if (!data.results?.length) return null;
    return data.results;
  } catch(e) {
    console.error("[Flow Search]", e.message);
    return null;
  }
}

// ── Format results as readable context ───
export function formatResults(results, query) {
  if (!results?.length) return `No search results found for "${query}".`;
  return results
    .filter(r => r.snippet?.length > 10)
    .slice(0, 6)
    .map((r, i) => `[${i+1}] ${r.title ? r.title + ": " : ""}${r.snippet}`)
    .join("\n\n");
}

// ── Auto-research on a topic ─────────────
// Searches, collects results, sends to AI to synthesise
export async function deepResearch(topic, sendToAI) {
  const results = await webSearch(topic, "deep");
  if (!results) {
    sendToAI(`I searched for "${topic}" but couldn't find anything. My connection might be having issues.`);
    return;
  }
  const context = formatResults(results, topic);
  const prompt  = `Using these search results about "${topic}", give me a clear, useful summary. Focus on the most important and recent information. Be direct and skip anything vague.\n\nSearch results:\n${context}`;
  sendToAI(prompt);
}

// ── Business growth research ─────────────
// Proactively searches for Joel's business
export async function businessResearch(sendToAI) {
  const topics = [
    "Joelflowstack latest tech stack trends 2025",
    "bot development business growth strategies 2025",
    "web development freelance opportunities Nigeria 2025",
    "AI bot integration business revenue 2025",
  ];

  const allResults = [];
  for (const topic of topics) {
    const r = await webSearch(topic, "quick");
    if (r) allResults.push(...r.slice(0, 2));
  }

  if (!allResults.length) return;

  const context = allResults
    .filter(r => r.snippet?.length > 20)
    .slice(0, 8)
    .map((r, i) => `[${i+1}] ${r.snippet}`)
    .join("\n\n");

  const prompt = `Here are some web results about growing a bot development and web development business like Joelflowstack:\n\n${context}\n\nGive Joel 3-5 specific, actionable tips he can apply right now to grow his business. Keep it real and direct.`;
  sendToAI(prompt);
}

// ── URL inspection ────────────────────────────────────────────────────────
export async function inspectUrl(url, deep = false) {
  try {
    const mode = deep ? "deep-url" : "url";
    const res  = await fetch(`/api/search?q=${encodeURIComponent(url)}&mode=${mode}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (e) {
    console.error("[Flow URL]", e.message);
    return null;
  }
}

// ── Format URL inspection result for AI ──────────────────────────────────
export function formatUrlResult(data, deep = false) {
  if (!data?.content) return `Could not fetch ${data?.url || "that URL"}.`;

  const meta = [
    `URL: ${data.url}`,
    data.wordCount  ? `Words: ~${data.wordCount}` : null,
    data.links      ? `Links: ${data.links}` : null,
    data.hasLogin   ? "Has login/auth form" : null,
    data.hasPricing ? "Has pricing/payment section" : null,
  ].filter(Boolean).join(" | ");

  return `${meta}\n\n${data.content}`;
}
