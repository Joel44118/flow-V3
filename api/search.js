// ═══════════════════════════════════════════
// api/search.js — Search + URL Inspector
//
// MODES:
//   quick  → DuckDuckGo instant answer
//   deep   → DDG + recent news
//   url    → fetch & extract a specific URL
//            (for "check this website", "inspect this URL")
//
// GET /api/search?q=query&mode=quick
// GET /api/search?q=https://example.com&mode=url
// ═══════════════════════════════════════════

// ── Strip HTML to clean readable text ───────────────────────────────────
function extractText(html) {
  return html
    // Remove scripts, styles, nav, footer, header, ads
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Extract title
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/i, "\nPAGE TITLE: $1\n")
    // Extract meta description
    .replace(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i, "\nDESCRIPTION: $1\n")
    .replace(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i, "\nDESCRIPTION: $1\n")
    // Extract headings (important for understanding site structure)
    .replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) =>
      `\n${"#".repeat(parseInt(level))} ${text.replace(/<[^>]+>/g, "").trim()}\n`)
    // Convert links to readable format
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, text) => `${text.replace(/<[^>]+>/g, "").trim()} [${href}]`)
    // Strip remaining tags
    .replace(/<[^>]+>/g, " ")
    // Clean whitespace
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

// ── Fetch a URL and extract useful content ───────────────────────────────
async function fetchUrl(url, deep = false) {
  const ctrl    = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);

  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FlowBot/3.0)",
        "Accept":     "text/html,application/xhtml+xml,*/*",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const ct   = r.headers.get("content-type") || "";
    const html = await r.text();
    const text = extractText(html);

    // Trim to reasonable length
    const maxChars = deep ? 8000 : 3000;
    const trimmed  = text.length > maxChars
      ? text.slice(0, maxChars) + "\n\n[content trimmed — showing first portion]"
      : text;

    // Count words, links, approximate reading time
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const links     = (html.match(/<a\s+[^>]*href/gi) || []).length;
    const hasLogin  = /<(form|input)[^>]*type=["']?password["']?/i.test(html);
    const hasPricing = /pricing|price|subscribe|plan|cost|payment/i.test(text);

    return {
      url,
      content:   trimmed,
      wordCount,
      links,
      hasLogin,
      hasPricing,
      statusCode: r.status,
      contentType: ct,
    };
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q, mode = "quick" } = req.query;
  if (!q) return res.status(400).json({ error: "query required" });

  try {

    // ── URL INSPECT MODE ───────────────────────────────────────────────
    if (mode === "url" || /^https?:\/\//i.test(q)) {
      const deep   = mode === "deep-url";
      const result = await fetchUrl(q, deep);
      return res.status(200).json({ mode: "url", ...result });
    }

    // ── QUICK / NEWS SEARCH ────────────────────────────────────────────
    if (mode === "quick" || mode === "news") {
      const url  = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const r    = await fetch(url, { headers: { "User-Agent": "FlowAI/3.0" } });
      const data = await r.json();

      const results = [];
      if (data.AbstractText) results.push({ title: data.AbstractSource || "Summary", snippet: data.AbstractText, url: data.AbstractURL });
      (data.RelatedTopics || []).slice(0, 5).forEach(t => {
        if (t.Text) results.push({ title: t.Text.split(" - ")[0] || "", snippet: t.Text, url: t.FirstURL || "" });
      });
      if (data.Answer) results.push({ title: "Direct Answer", snippet: data.Answer, url: "" });

      return res.status(200).json({ query: q, results, source: "duckduckgo" });
    }

    // ── DEEP SEARCH ────────────────────────────────────────────────────
    if (mode === "deep") {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const ddgRes = await fetch(ddgUrl, { headers: { "User-Agent": "FlowAI/3.0" } });
      const ddg    = await ddgRes.json();

      const results = [];
      if (ddg.AbstractText) results.push({ title: ddg.AbstractSource, snippet: ddg.AbstractText, url: ddg.AbstractURL });
      (ddg.RelatedTopics || []).slice(0, 8).forEach(t => {
        if (t.Text) results.push({ title: t.Text.split(" - ")[0], snippet: t.Text, url: t.FirstURL || "" });
      });

      const newsRes = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(q + " 2025 latest")}&format=json&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "FlowAI/3.0" } }
      );
      const news = await newsRes.json();
      (news.RelatedTopics || []).slice(0, 5).forEach(t => {
        if (t.Text) results.push({ title: "[Recent] " + t.Text.split(" - ")[0], snippet: t.Text, url: t.FirstURL || "" });
      });

      return res.status(200).json({ query: q, results, source: "duckduckgo-deep" });
    }

    return res.status(400).json({ error: "Unknown mode" });

  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
