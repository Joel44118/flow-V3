// ═══════════════════════════════════════════
// core/intel.js — World Intelligence for Flow
//
// Pulls from free public APIs (no keys needed):
//   - USGS earthquakes
//   - NASA FIRMS fire alerts  
//   - Hacker News (tech signal)
//   - RSS feeds: BBC, Reuters, TechCrunch
//   - Exchange rates (USD/NGN, EUR/USD)
//   - ACLED conflict data (public endpoint)
//
// All calls go through Vercel /api/intel
// to avoid CORS and keep it server-side.
// ═══════════════════════════════════════════

export async function fetchIntel(focus = "general") {
  const res = await fetch(`/api/intel?focus=${encodeURIComponent(focus)}`);
  if (!res.ok) throw new Error(`Intel fetch failed: ${res.status}`);
  return res.json();
}

// Format raw intel into a prompt for Flow's AI
export function buildIntelPrompt(data, focus) {
  const lines = [];

  lines.push(`WORLD INTELLIGENCE BRIEF — ${new Date().toUTCString()}`);
  lines.push(`Focus: ${focus}`);
  lines.push("");

  if (data.forex?.length) {
    lines.push("── MARKETS & FOREX ──");
    data.forex.forEach(f => lines.push(`${f.pair}: ${f.rate} (${f.change})`));
    lines.push("");
  }

  if (data.news?.length) {
    lines.push("── WORLD NEWS (latest) ──");
    data.news.slice(0, 12).forEach(n => lines.push(`• [${n.source}] ${n.title}`));
    lines.push("");
  }

  if (data.tech?.length) {
    lines.push("── TECH & AI SIGNAL ──");
    data.tech.slice(0, 8).forEach(t => lines.push(`• ${t.title} (${t.points} pts)`));
    lines.push("");
  }

  if (data.quakes?.length) {
    lines.push("── EARTHQUAKES (M4.5+, last 24h) ──");
    data.quakes.slice(0, 5).forEach(q =>
      lines.push(`M${q.mag} — ${q.place}`)
    );
    lines.push("");
  }

  if (data.fires?.length) {
    lines.push("── ACTIVE FIRE ALERTS (NASA) ──");
    data.fires.slice(0, 5).forEach(f => lines.push(`• ${f.region} — brightness ${f.brightness}`));
    lines.push("");
  }

  if (data.conflicts?.length) {
    lines.push("── CONFLICT EVENTS (last 48h) ──");
    data.conflicts.slice(0, 6).forEach(c =>
      lines.push(`• ${c.country} — ${c.event_type} in ${c.location}`)
    );
    lines.push("");
  }

  const briefText = lines.join("\n");

  return `${briefText}

Based on the above real-world intelligence brief, give Joel a sharp, direct analysis:

1. WHAT MATTERS RIGHT NOW — the 2-3 most significant developments and why they matter
2. OPPORTUNITIES FOR JOELFLOWSTACK — specific angles Joel can exploit:
   - Tech trends he can build on or pitch to clients
   - Market conditions affecting his business or clients
   - Events creating demand for bot/web development services
   - Any Nigeria-specific signals worth acting on
3. SIGNALS TO WATCH — what to monitor in the next 24-48 hours

Be specific and actionable. Joel runs a bot and web development business in Ibadan, Nigeria. Skip generic advice — give him intelligence he can act on today.`;
}
