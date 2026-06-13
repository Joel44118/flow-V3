// ═══════════════════════════════════════════
// api/intel.js — World intelligence aggregator
// Runs server-side to avoid CORS on free APIs
// No API keys required for any source
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const focus = req.query.focus || "general";

  const results = await Promise.allSettled([
    fetchForex(),
    fetchNews(),
    fetchTech(),
    fetchQuakes(),
    fetchFires(),
    fetchConflicts(),
  ]);

  const [forex, news, tech, quakes, fires, conflicts] = results.map(r =>
    r.status === "fulfilled" ? r.value : []
  );

  return res.status(200).json({ forex, news, tech, quakes, fires, conflicts, focus, ts: Date.now() });
}

// ── FOREX: USD/NGN, EUR/USD, GBP/USD, BTC/USD ────────────────────────────
async function fetchForex() {
  try {
    // Frankfurter API - free, no key
    const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,NGN", {
      signal: AbortSignal.timeout(5000)
    });
    const d = await r.json();
    const rates = d.rates || {};
    return [
      { pair: "USD/NGN", rate: rates.NGN?.toFixed(2) ?? "N/A", change: "" },
      { pair: "USD/EUR", rate: rates.EUR?.toFixed(4) ?? "N/A", change: "" },
      { pair: "USD/GBP", rate: rates.GBP?.toFixed(4) ?? "N/A", change: "" },
    ];
  } catch { return []; }
}

// ── NEWS: BBC + Reuters + Al Jazeera RSS ─────────────────────────────────
async function fetchNews() {
  const feeds = [
    { url: "https://feeds.bbci.co.uk/news/world/rss.xml",   source: "BBC"       },
    { url: "https://feeds.reuters.com/reuters/topNews",      source: "Reuters"   },
    { url: "https://www.aljazeera.com/xml/rss/all.xml",     source: "Al Jazeera"},
    { url: "https://techcabal.com/feed/",                    source: "TechCabal" }, // Nigeria tech
  ];

  const items = [];
  await Promise.allSettled(feeds.map(async ({ url, source }) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const text = await r.text();
      // Simple XML title extraction - no parser needed
      const titles = [...text.matchAll(/<title><!\[CDATA\[(.+?)\]\]><\/title>|<title>([^<]{10,})<\/title>/g)]
        .slice(1, 6) // skip feed title, take next 5
        .map(m => (m[1] || m[2]).trim())
        .filter(t => t.length > 10);
      titles.forEach(title => items.push({ source, title }));
    } catch {}
  }));

  return items.slice(0, 20);
}

// ── TECH: Hacker News top stories ────────────────────────────────────────
async function fetchTech() {
  try {
    const r = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
      signal: AbortSignal.timeout(4000)
    });
    const ids = (await r.json()).slice(0, 10);

    const stories = await Promise.allSettled(
      ids.map(id =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
          signal: AbortSignal.timeout(3000)
        }).then(r => r.json())
      )
    );

    return stories
      .filter(s => s.status === "fulfilled" && s.value?.title)
      .map(s => ({ title: s.value.title, points: s.value.score || 0, url: s.value.url }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 8);
  } catch { return []; }
}

// ── EARTHQUAKES: USGS free API ────────────────────────────────────────────
async function fetchQuakes() {
  try {
    const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    return (d.features || []).slice(0, 8).map(f => ({
      mag:   f.properties.mag,
      place: f.properties.place,
      time:  new Date(f.properties.time).toUTCString(),
    }));
  } catch { return []; }
}

// ── FIRES: NASA FIRMS CSV (public, no key needed for basic feed) ──────────
async function fetchFires() {
  try {
    // NASA FIRMS global 24h summary - public RSS
    const r = await fetch(
      "https://firms.modaps.eosdis.nasa.gov/api/country/csv/VIIRS_SNPP_NRT/World/1",
      { signal: AbortSignal.timeout(5000) }
    );
    const text = await r.text();
    const lines = text.trim().split("\n").slice(1, 8); // skip header
    return lines.map(l => {
      const cols = l.split(",");
      return { region: cols[0] || "Unknown", brightness: cols[2] || "N/A" };
    }).filter(f => f.region !== "Unknown");
  } catch { return []; }
}

// ── CONFLICTS: ACLED public RSS/API ──────────────────────────────────────
async function fetchConflicts() {
  try {
    // ACLED has a public RSS feed for recent events
    const r = await fetch("https://api.acleddata.com/acled/read.csv?limit=10&fields=event_date,country,event_type,location&event_date_where=BETWEEN&event_date_from=" + getYesterday(), {
      signal: AbortSignal.timeout(5000)
    });
    const text = await r.text();
    const lines = text.trim().split("\n").slice(1, 8);
    return lines.map(l => {
      const cols = l.split(",");
      return {
        country:    (cols[1] || "").replace(/"/g, "").trim(),
        event_type: (cols[2] || "").replace(/"/g, "").trim(),
        location:   (cols[3] || "").replace(/"/g, "").trim(),
      };
    }).filter(c => c.country);
  } catch { return []; }
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return d.toISOString().split("T")[0];
}
