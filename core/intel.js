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
// REAL, Joel-requested fix: previously this dumped the ENTIRE raw brief
// (up to 15 news headlines + 8 tech + 6 conflicts + forex + quakes +
// fires, much of it globally generic and irrelevant to a solo bot/web
// dev business in Nigeria) and asked the AI to filter it inline, in the
// same response as writing the actual analysis. That's a lot of
// low-signal raw text for one call to both digest AND filter AND write
// up — Joel's real complaint was that it "brings loads of information
// and delivers nothing useful." The fix: cap what's actually sent much
// more aggressively per section, and make the instruction explicitly
// about DROPPING irrelevant items rather than just "analyzing" — the
// filtering step is now a stated, primary task, not an implicit side effect.
export function buildIntelPrompt(data, focus) {
  const specific = isSpecificSearch(focus);
  const lines    = [];

  lines.push(`WORLD INTELLIGENCE BRIEF — ${new Date().toUTCString()}`);
  lines.push("");

  // ── If specific search: targeted results first, prominently ──────────
  if (specific && data.targeted?.length) {
    lines.push(`── TARGETED NEWS: "${focus.toUpperCase()}" ──`);
    data.targeted.slice(0, 8).forEach((n, i) => {
      const date = n.pub ? ` [${new Date(n.pub).toLocaleDateString()}]` : "";
      lines.push(`${i + 1}.${date} [${n.source}] ${n.title}`);
    });
    lines.push("");
  } else if (specific && !data.targeted?.length) {
    lines.push(`── TARGETED NEWS: "${focus.toUpperCase()}" ──`);
    lines.push("No targeted results found — showing full world brief below.");
    lines.push("");
  }

  // ── Real, tighter caps than before — this is raw material for
  // filtering, not the final output, so it doesn't need to be
  // exhaustive. Fewer, higher-signal items per section.
  if (data.forex?.length) {
    lines.push("── MARKETS & FOREX ──");
    data.forex.forEach(f => lines.push(`${f.pair}: ${f.rate}`));
    lines.push("");
  }

  if (data.news?.length) {
    lines.push("── WORLD NEWS (latest) ──");
    data.news.slice(0, 10).forEach(n => lines.push(`• [${n.source}] ${n.title}`));
    lines.push("");
  }

  if (data.tech?.length) {
    lines.push("── TECH & AI SIGNAL (Hacker News) ──");
    data.tech.slice(0, 6).forEach(t => lines.push(`• ${t.title} (${t.points} pts)`));
    lines.push("");
  }

  if (data.quakes?.length) {
    lines.push("── EARTHQUAKES (M4.5+, last 24h) ──");
    data.quakes.slice(0, 3).forEach(q => lines.push(`M${q.mag} — ${q.place}`));
    lines.push("");
  }

  if (data.fires?.length) {
    lines.push("── ACTIVE FIRE ALERTS (NASA) ──");
    data.fires.slice(0, 2).forEach(f => lines.push(`• ${f.region} — brightness ${f.brightness}`));
    lines.push("");
  }

  if (data.conflicts?.length) {
    lines.push("── CONFLICT EVENTS (last 48h) ──");
    data.conflicts.slice(0, 4).forEach(c =>
      lines.push(`• ${c.country} — ${c.event_type} in ${c.location}`)
    );
    lines.push("");
  }

  const briefText = lines.join("\n");

  // ── Build the AI instruction based on mode ───────────────────────────
  // REAL CHANGE: filtering is now stated as the FIRST, explicit task,
  // not something implied by "give an analysis." The instruction tells
  // the model directly to discard items with no real Joelflowstack
  // relevance rather than trying to say something about everything.
  if (specific) {
    return `${briefText}

Joel asked specifically about: "${focus}"

Your response should have TWO parts. In BOTH parts, your first real job is FILTERING — actively drop anything from the raw material above that has no genuine relevance to Joel's business (a solo web dev / bot integration / workflow automation freelancer, Joelflowstack, based in Ibadan, Nigeria). Don't mention or summarize irrelevant items just because they were in the brief — leaving something out silently is correct when it doesn't matter to Joel.

PART 1 — "${focus.toUpperCase()}" SPECIFIC BRIEF:
From the targeted news results above, give Joel a sharp, dated summary of what is actually happening with "${focus}" right now — but only the developments that could realistically affect his business or work. Include dates where available. Be specific — names, numbers, events. If none of the targeted results are actually relevant, say so plainly instead of padding.

PART 2 — FILTERED WORLD BRIEF:
From the rest of the intel above, after dropping anything irrelevant:
• WHAT MATTERS RIGHT NOW — only the 2-3 developments with real relevance to Joel's business or the Nigerian tech/market context, not generic global news
• JOELFLOWSTACK OPPORTUNITIES — concrete, specific angles Joel can exploit as a bot/web dev in Nigeria — no generic "AI is growing" filler
• SIGNALS TO WATCH — only things worth Joel's actual attention in the next 24-48 hours

Keep both parts sharp and short. It's fine — better, even — for this to be brief if most of the raw material genuinely wasn't relevant.`;
  }

  // General brief prompt
  return `${briefText}

Your first real job is FILTERING, not summarizing everything. From the raw material above, actively drop anything with no genuine relevance to Joel's business (a solo web dev / bot integration / workflow automation freelancer, Joelflowstack, based in Ibadan, Nigeria) or to Nigeria specifically. Don't mention an item just because it was in the brief — if most of today's raw material is irrelevant, it's correct and expected for this response to be short.

Give Joel a sharp, direct, FILTERED analysis:

1. WHAT MATTERS RIGHT NOW — only the developments (up to 3-4) that are genuinely significant to his business or Nigerian context — skip anything that's just generic world news with no real angle for him
2. OPPORTUNITIES FOR JOELFLOWSTACK — specific, concrete angles Joel can actually exploit:
   - Real tech trends he can build on or pitch to clients (not vague "AI is booming" statements)
   - Market conditions genuinely affecting his business (especially USD/NGN rate, only if it moved meaningfully)
   - Events creating real demand for bot/web development services
   - Nigeria-specific signals actually worth acting on
3. SIGNALS TO WATCH — only what's genuinely worth monitoring in the next 24-48 hours

Be specific and actionable. Skip generic advice entirely. If there's genuinely nothing noteworthy today, say so directly rather than manufacturing importance.`;
}
