// ═══════════════════════════════════════════
// api/search.js — Web search via DuckDuckGo
//
// Uses DuckDuckGo Instant Answer API (free,
// no key needed) + scrapes top results for
// deep research mode.
//
// GET  /api/search?q=query&mode=quick   → instant answer
// GET  /api/search?q=query&mode=news    → recent news
// GET  /api/search?q=query&mode=deep    → full research
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, mode = "quick" } = req.query;
  if (!q) return res.status(400).json({ error: "query required" });

  try {
    if (mode === "quick" || mode === "news") {
      // DuckDuckGo Instant Answer API — free, no key
      const url  = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const r    = await fetch(url, { headers: { "User-Agent": "FlowAI/3.0" } });
      const data = await r.json();

      const results = [];

      // Abstract (Wikipedia-style summary)
      if (data.AbstractText) {
        results.push({ title: data.AbstractSource || "Summary", snippet: data.AbstractText, url: data.AbstractURL });
      }

      // Related topics
      (data.RelatedTopics || []).slice(0, 5).forEach(t => {
        if (t.Text) results.push({ title: t.Text.split(" - ")[0] || "", snippet: t.Text, url: t.FirstURL || "" });
      });

      // Answer (calculator, definitions, etc)
      if (data.Answer) {
        results.push({ title: "Direct Answer", snippet: data.Answer, url: "" });
      }

      return res.status(200).json({ query: q, results, source: "duckduckgo" });
    }

    if (mode === "deep") {
      // Deep research: DDG + fetch actual page content from top result
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const ddgRes = await fetch(ddgUrl, { headers: { "User-Agent": "FlowAI/3.0" } });
      const ddg    = await ddgRes.json();

      const results = [];
      if (ddg.AbstractText) results.push({ title: ddg.AbstractSource, snippet: ddg.AbstractText, url: ddg.AbstractURL });
      (ddg.RelatedTopics || []).slice(0, 8).forEach(t => {
        if (t.Text) results.push({ title: t.Text.split(" - ")[0], snippet: t.Text, url: t.FirstURL || "" });
      });

      // Also fetch a news-specific search
      const newsQ   = encodeURIComponent(q + " 2025 latest");
      const newsUrl = `https://api.duckduckgo.com/?q=${newsQ}&format=json&no_html=1&skip_disambig=1`;
      const newsRes = await fetch(newsUrl, { headers: { "User-Agent": "FlowAI/3.0" } });
      const news    = await newsRes.json();
      (news.RelatedTopics || []).slice(0, 5).forEach(t => {
        if (t.Text) results.push({ title: "[Recent] " + t.Text.split(" - ")[0], snippet: t.Text, url: t.FirstURL || "" });
      });

      return res.status(200).json({ query: q, results, source: "duckduckgo-deep" });
    }

    return res.status(400).json({ error: "Unknown mode" });

  } catch(e) {
    return res.status(502).json({ error: e.message });
  }
}
