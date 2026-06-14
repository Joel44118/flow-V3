// ═══════════════════════════════════════════
// api/search.js — Smart search + URL inspector
//
// MODES:
//   quick  → DuckDuckGo instant answer
//   deep   → DDG + news RSS (more results)
//   news   → targeted news search (RSS feeds)
//   url    → fetch & extract a specific URL
// ═══════════════════════════════════════════

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s{2,}/g, " ").trim();
}

// ── DuckDuckGo search ─────────────────────────────────────────────────────
async function ddgSearch(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const r   = await fetch(url, { signal: AbortSignal.timeout(6000) });
  const d   = await r.json();

  const results = [];

  // Abstract (top answer)
  if (d.AbstractText) {
    results.push({ title: d.Heading || query, snippet: d.AbstractText, url: d.AbstractURL });
  }

  // Related topics
  (d.RelatedTopics || []).slice(0, 6).forEach(t => {
    if (t.Text) results.push({ title: t.Text.split(" - ")[0], snippet: t.Text, url: t.FirstURL });
  });

  return results;
}

// ── RSS news search — searches Google News RSS for targeted queries ────────
async function newsSearch(query) {
  const results = [];

  // Google News RSS - returns actual recent news articles
  const feeds = [
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    `https://feeds.bbci.co.uk/news/rss.xml`,
  ];

  await Promise.allSettled(feeds.map(async (feedUrl) => {
    try {
      const r    = await fetch(feedUrl, { signal: AbortSignal.timeout(6000) });
      const text = await r.text();

      // Parse <item> blocks
      const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      items.slice(0, 8).forEach(m => {
        const block = m[1];
        const title = (block.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/) ||
                       block.match(/<title>([^<]+)<\/title>/))?.[1]?.trim();
        const desc  = (block.match(/<description><!\[CDATA\[(.+?)\]\]><\/description>/) ||
                       block.match(/<description>([^<]{20,})<\/description>/))?.[1]?.trim();
        const link  = block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() ||
                      block.match(/<guid[^>]*>([^<]+)<\/guid>/)?.[1]?.trim();
        const pub   = block.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim();

        if (title && title.length > 5) {
          const clean = desc ? extractText(desc).slice(0, 200) : "";
          results.push({ title, snippet: clean || title, url: link || "", pub });
        }
      });
    } catch {}
  }));

  // Filter to query-relevant results if we have enough
  const q = query.toLowerCase();
  const relevant = results.filter(r =>
    r.title.toLowerCase().includes(q.split(" ")[0]) ||
    r.snippet.toLowerCase().includes(q.split(" ")[0])
  );

  return (relevant.length >= 3 ? relevant : results).slice(0, 8);
}

// ── URL Inspector ─────────────────────────────────────────────────────────
async function inspectUrl(url) {
  const r    = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; FlowBot/1.0)" },
    signal: AbortSignal.timeout(8000)
  });
  const html = await r.text();
  const text = extractText(html).slice(0, 4000);

  const title    = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
  const desc     = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i)?.[1] || "";
  const words    = text.split(/\s+/).length;
  const links    = (html.match(/<a\s/gi) || []).length;
  const hasPay   = /pricing|subscribe|checkout|payment|buy now/i.test(text);
  const hasLogin = /login|sign in|register|sign up/i.test(text);

  return { title, description: desc, text, words, links, hasPricing: hasPay, hasLogin };
}

// ── Handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { q, mode = "quick" } = req.query;
  if (!q) return res.status(400).json({ error: "q is required" });

  try {
    // URL mode
    if (mode === "url" || q.startsWith("http")) {
      const data = await inspectUrl(q);
      return res.status(200).json({
        type: "url",
        url:  q,
        ...data,
        context: `URL: ${q}\nTitle: ${data.title}\nWords: ~${data.words} | Links: ${data.links}${data.hasPricing ? " | Has pricing/payment section" : ""}${data.hasLogin ? " | Has login" : ""}\nDESCRIPTION: ${data.description}\n\n${data.text.slice(0, 2000)}`
      });
    }

    // News mode — targeted news search
    if (mode === "news") {
      const results = await newsSearch(q);
      return res.status(200).json({ results, mode: "news" });
    }

    // Deep mode — DDG + news combined
    if (mode === "deep") {
      const [ddg, news] = await Promise.allSettled([ddgSearch(q), newsSearch(q)]);
      const results = [
        ...(ddg.status === "fulfilled" ? ddg.value : []),
        ...(news.status === "fulfilled" ? news.value : []),
      ].slice(0, 10);
      return res.status(200).json({ results, mode: "deep" });
    }

    // Quick mode — DDG only
    const results = await ddgSearch(q);
    return res.status(200).json({ results, mode: "quick" });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
