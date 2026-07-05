// ═══════════════════════════════════════════
// api/rag.js — RAG knowledge base search + Apify web research
//
// FIX: Gracefully handles missing KV env vars.
// Returns empty results (never crashes) so
// core/rag.js falls back to localStorage.
//
// APIFY INTEGRATION — scope, stated plainly:
// This builds the legitimate half of "find potential clients" — scraping
// a website's real, public content into clean text (for feeding a bot's
// knowledge base), and finding publicly-listed business contact info.
// It does NOT send bulk emails or auto-respond as Joel via email. Bulk
// cold outreach is heavily regulated (CAN-SPAM, GDPR, Nigeria's NDPR) and
// is exactly the kind of thing that gets a sending domain blacklisted
// fast when done wrong — that needs a proper transactional email service
// with real unsubscribe handling, not a scraped-list blast script. This
// gives Flow real research tools; sending stays a distinct, compliant
// step to build separately if wanted.
// ═══════════════════════════════════════════

function score(query, chunk) {
  const q     = query.toLowerCase();
  const c     = chunk.toLowerCase();
  const words = q.split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return 0;
  return words.filter(w => c.includes(w)).length / words.length;
}

// ── Apify: scrape a website into clean text for a knowledge base ───────
async function handleApifyScrape(req, res) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(200).json({ ok: false, error: "APIFY_API_TOKEN not set in Vercel env vars. Get one free at apify.com → Settings → Integrations." });

  const { url, maxPages = 5 } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url required" });

  try {
    // apify/website-content-crawler turns any site into clean, LLM-ready
    // text — exactly the format a bot's knowledge base needs. maxPages
    // is capped low by default to keep this well within Vercel's
    // function timeout, not because the actor can't do more.
    const r = await fetch(
      `https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: [{ url }],
          maxCrawlPages: Math.min(maxPages, 15), // hard cap regardless of what's requested
          crawlerType: "cheerio", // fastest option, sufficient for text extraction
        }),
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Apify run failed: ${r.status} ${errText.slice(0, 200)}`);
    }

    const items = await r.json();
    const pages = items.map(item => ({
      url: item.url,
      title: item.metadata?.title || item.url,
      text: (item.text || "").slice(0, 3000), // keep each page's chunk reasonable
    })).filter(p => p.text.trim());

    return res.status(200).json({ ok: true, pages, count: pages.length });
  } catch (e) {
    console.error("[Apify Scrape] failed:", e.message);
    return res.status(502).json({ ok: false, error: e.message });
  }
}

// ── Apify: find publicly-listed business contact info ──────────────────
// Legitimate lead research — finds businesses and their PUBLICLY LISTED
// contact details via Google Maps/search results, not scraped from
// private sources. This is the same kind of research a human would do
// manually by browsing Google Maps; Apify just automates the browsing.
async function handleApifyLeadSearch(req, res) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(200).json({ ok: false, error: "APIFY_API_TOKEN not set in Vercel env vars." });

  const { query, location, maxResults = 10 } = req.body || {};
  if (!query) return res.status(400).json({ ok: false, error: "query required (e.g. 'web design agencies')" });

  try {
    const r = await fetch(
      `https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchStringsArray: [location ? `${query} in ${location}` : query],
          maxCrawledPlacesPerSearch: Math.min(maxResults, 20),
        }),
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Apify run failed: ${r.status} ${errText.slice(0, 200)}`);
    }

    const items = await r.json();
    const leads = items.map(item => ({
      name:    item.title,
      website: item.website || null,
      phone:   item.phone || null,
      email:   item.email || null, // only present if publicly listed on their own site
      address: item.address || null,
      rating:  item.totalScore || null,
    })).filter(l => l.website || l.phone || l.email); // skip entries with no way to actually reach them

    return res.status(200).json({ ok: true, leads, count: leads.length });
  } catch (e) {
    console.error("[Apify Lead Search] failed:", e.message);
    return res.status(502).json({ ok: false, error: e.message });
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Apify routes checked first, by query param, following the same
  // pattern already used across api/social.js and api/tts.js.
  const apifyAction = req.query?.action;
  if (apifyAction === "scrape")      return handleApifyScrape(req, res);
  if (apifyAction === "find-leads")  return handleApifyLeadSearch(req, res);

  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;

  // KV not connected — return empty gracefully, client uses localStorage
  if (!KV_URL || !KV_TOKEN) {
    if (req.method === "GET")  return res.status(200).json({ keys: [] });
    return res.status(200).json({ ok: false, context: null, found: 0, reason: "KV not connected — using localStorage fallback" });
  }

  // ── GET: list keys ─────────────────────
  if (req.method === "GET") {
    try {
      const r    = await fetch(`${KV_URL}/keys/rag:*`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const data = await r.json();
      return res.status(200).json({ keys: data.result || [] });
    } catch (e) {
      return res.status(200).json({ keys: [], error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST or GET only" });

  const { action, query, title, content } = req.body || {};

  // ── SAVE ───────────────────────────────
  if (action === "save") {
    if (!title || !content) return res.status(400).json({ error: "title and content required" });
    const key   = `rag:${title.replace(/\s+/g, "_").toLowerCase()}`;
    // FIX: this was double-encoding — value was already JSON.stringify'd,
    // then wrapped again in JSON.stringify({ value }) as the POST body.
    // Same class of bug fixed in api/memory.js: Upstash stores exactly
    // what's sent, so this saved a string containing literal escaped
    // quote characters, which would never read back out to valid JSON
    // via JSON.parse in the search path below. The object itself
    // (title, content, saved) genuinely needs JSON.stringify since it's
    // not a plain string — the fix is not double-wrapping it a second time.
    const value = { title, content, saved: Date.now() };
    try {
      await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
        body:    JSON.stringify(value),
      });
      return res.status(200).json({ ok: true, key });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── SEARCH ─────────────────────────────
  if (action === "search" && query) {
    try {
      const keysRes  = await fetch(`${KV_URL}/keys/rag:*`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const keysData = await keysRes.json();
      const keys     = keysData.result || [];
      if (!keys.length) return res.status(200).json({ context: null, found: 0 });

      const docs = await Promise.all(keys.map(async k => {
        try {
          const r    = await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
          const data = await r.json();
          // FIX: data.result is already the parsed object now that save
          // no longer double-encodes — no JSON.parse needed here anymore.
          // Kept a defensive check for any OLD entries saved before this
          // fix, which would still be a double-encoded string.
          if (!data.result) return null;
          return typeof data.result === "string" ? JSON.parse(data.result) : data.result;
        } catch { return null; }
      }));

      const chunks = [];
      for (const doc of docs) {
        if (!doc?.content) continue;
        const words = doc.content.split(/\s+/);
        for (let i = 0; i < words.length; i += 150) {
          chunks.push({ title: doc.title, text: words.slice(i, i + 200).join(" "), s: score(query, words.slice(i, i + 200).join(" ")) });
        }
      }

      const top = chunks.filter(c => c.s > 0.1).sort((a, b) => b.s - a.s).slice(0, 3);
      if (!top.length) return res.status(200).json({ context: null, found: 0 });

      return res.status(200).json({
        context: top.map(c => `[From "${c.title}"]\n${c.text}`).join("\n\n---\n\n"),
        found:   top.length,
      });
    } catch (e) {
      return res.status(200).json({ context: null, found: 0, error: e.message });
    }
  }

  // ── DELETE ─────────────────────────────
  if (action === "delete" && title) {
    const key = `rag:${title.replace(/\s+/g, "_").toLowerCase()}`;
    try {
      await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
        method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  return res.status(400).json({ error: "Invalid action" });
}
