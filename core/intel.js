// ═══════════════════════════════════════════
// core/intel.js — World Intelligence for Flow
// ═══════════════════════════════════════════

// Topics that mean "full general brief" — not a specific search
const GENERAL_KEYWORDS = /^(general|all|everything|full|brief|world|today|now|default|latest)$/i;

// Detect if the focus is a specific topic to search vs a general brief
function isSpecificSearch(focus) {
  if (!focus || focus.trim() === "") return false;
  return !GENERAL_KEYWORDS.test(focus.trim());
}

export async function fetchIntel(focus = "general") {
  const specific = isSpecificSearch(focus);
  const params   = new URLSearchParams({ focus });
  if (specific) params.set("search", focus.trim());

  const res = await fetch(`/api/intel?${params}`);
  if (!res.ok) throw new Error(`Intel fetch failed: ${res.status}`);
  return res.json();
}

// ── Build AI prompt ───────────────────────────────────────────────────────
export function buildIntelPrompt(data, focus) {
  const specific = isSpecificSearch(focus);
  const lines    = [];

  lines.push(`WORLD INTELLIGENCE BRIEF — ${new Date().toUTCString()}`);
  lines.push("");

  // ── If specific search: targeted results first, prominently ──────────
  if (specific && data.targeted?.length) {
    lines.push(`── TARGETED NEWS: "${focus.toUpperCase()}" ──`);
    data.targeted.forEach((n, i) => {
      const date = n.pub ? ` [${new Date(n.pub).toLocaleDateString()}]` : "";
      lines.push(`${i + 1}.${date} [${n.source}] ${n.title}`);
    });
    lines.push("");
  } else if (specific && !data.targeted?.length) {
    lines.push(`── TARGETED NEWS: "${focus.toUpperCase()}" ──`);
    lines.push("No targeted results found — showing full world brief below.");
    lines.push("");
  }

  // ── Always include the full brief ────────────────────────────────────
  if (data.forex?.length) {
    lines.push("── MARKETS & FOREX ──");
    data.forex.forEach(f => lines.push(`${f.pair}: ${f.rate}`));
    lines.push("");
  }

  if (data.news?.length) {
    lines.push("── WORLD NEWS (latest) ──");
    data.news.slice(0, 15).forEach(n => lines.push(`• [${n.source}] ${n.title}`));
    lines.push("");
  }

  if (data.tech?.length) {
    lines.push("── TECH & AI SIGNAL (Hacker News) ──");
    data.tech.slice(0, 8).forEach(t => lines.push(`• ${t.title} (${t.points} pts)`));
    lines.push("");
  }

  if (data.quakes?.length) {
    lines.push("── EARTHQUAKES (M4.5+, last 24h) ──");
    data.quakes.slice(0, 5).forEach(q => lines.push(`M${q.mag} — ${q.place}`));
    lines.push("");
  }

  if (data.fires?.length) {
    lines.push("── ACTIVE FIRE ALERTS (NASA) ──");
    data.fires.slice(0, 4).forEach(f => lines.push(`• ${f.region} — brightness ${f.brightness}`));
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

  // ── Build the AI instruction based on mode ───────────────────────────
  if (specific) {
    return `${briefText}

Joel asked specifically about: "${focus}"

Your response should have TWO parts:

PART 1 — "${focus.toUpperCase()}" SPECIFIC BRIEF:
Based on the targeted news results above, give Joel a sharp, dated summary of what is actually happening with "${focus}" right now. List the key developments in order of importance. Include dates where available. Be specific — names, numbers, events.

PART 2 — FULL WORLD BRIEF:
From the rest of the intel above, cover:
• WHAT MATTERS RIGHT NOW — 2-3 most significant global developments
• JOELFLOWSTACK OPPORTUNITIES — what Joel can exploit as a bot/web dev in Nigeria
• SIGNALS TO WATCH — what to monitor in the next 24-48 hours

Keep both parts sharp and actionable. Joel is in Ibadan, Nigeria running a bot and web development business.`;
  }

  // General brief prompt
  return `${briefText}

Based on the above real-world intelligence brief, give Joel a sharp, direct analysis:

1. WHAT MATTERS RIGHT NOW — the 3-4 most significant developments across all categories and why they matter
2. OPPORTUNITIES FOR JOELFLOWSTACK — specific angles Joel can exploit:
   - Tech trends he can build on or pitch to clients
   - Market conditions affecting his business (especially USD/NGN rate)
   - Events creating demand for bot/web development services
   - Nigeria-specific signals worth acting on
3. SIGNALS TO WATCH — what to monitor in the next 24-48 hours

Be specific and actionable. Joel runs a bot and web development business in Ibadan, Nigeria. Skip generic advice.`;
}
