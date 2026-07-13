// ═══════════════════════════════════════════
// core/leveltools.js — Level-Up Tool Rewards
//
// REAL DESIGN CONSTRAINT, decided from reading core/selftools.js's own
// documented safety model rather than assumed: that file explicitly
// restricts self-tools to plain JS with a static blocklist (no fetch,
// no Node built-ins, no OS/IPC access) — a deliberate choice Joel made
// to keep the worst case "bad math," not "deleted files." A level-based
// reward system CANNOT grant more system access at higher levels
// without contradicting that explicit decision. So "bigger, more useful
// at higher levels" means more SOPHISTICATED pure-JS utilities — more
// parameters, more real-world usefulness, more polish — not more
// privilege.
//
// REAL FLOW, no bypass of existing safety: on level-up, this module
// picks one tool from the curated library appropriate to the new
// level's tier, and feeds it through the EXACT SAME proposal → approval
// pipeline every other self-tool uses (core/selftools.js's
// parseToolProposal/approveTool shape, and the real UI approval button
// already built for self-tool proposals). Joel still approves every
// one — this only changes WHO initiates the proposal (Flow, on level-
// up) not HOW it gets approved.
//
// Every tool below was written and manually checked against
// core/selftools.js's real BLOCKED_PATTERNS list to confirm it
// genuinely passes checkToolSafety — not assumed safe, verified against
// the actual regex list at write time. If selftools.js's blocklist ever
// changes, these should be re-checked.
// ═══════════════════════════════════════════
import { checkToolSafety } from "./selftools.js";

// ── Tier definitions ─────────────────────────────────────────────────
// Real tiering: low levels get small, single-purpose utilities;
// higher levels get more parameters and more genuinely useful logic —
// bigger in scope and usefulness, never in system privilege.
const TIER_1_TOOLS = [ // levels 2-5 — simple, single-purpose
  {
    name: "celsius_to_fahrenheit",
    description: "Converts a Celsius temperature to Fahrenheit.",
    params: ["celsius"],
    code: "return (celsius * 9/5) + 32;",
  },
  {
    name: "word_count",
    description: "Counts the number of words in a string of text.",
    params: ["text"],
    code: "return text.trim().split(/\\s+/).filter(Boolean).length;",
  },
  {
    name: "capitalize_words",
    description: "Capitalizes the first letter of every word in a string.",
    params: ["text"],
    code: "return text.replace(/\\b\\w/g, c => c.toUpperCase());",
  },
];

const TIER_2_TOOLS = [ // levels 6-10 — a bit more logic, still one job
  {
    name: "reading_time_estimate",
    description: "Estimates reading time in minutes for a block of text, given words-per-minute (defaults to 200).",
    params: ["text", "wpm"],
    code: "const words = text.trim().split(/\\s+/).filter(Boolean).length; const rate = wpm || 200; return Math.max(1, Math.ceil(words / rate));",
  },
  {
    name: "slugify",
    description: "Turns a title into a URL-friendly slug (lowercase, hyphens, no special characters).",
    params: ["text"],
    code: "return text.toLowerCase().trim().replace(/[^a-z0-9\\s-]/g, '').replace(/\\s+/g, '-').replace(/-+/g, '-');",
  },
  {
    name: "percentage_change",
    description: "Calculates the percentage change between an old value and a new value.",
    params: ["oldValue", "newValue"],
    code: "if (oldValue === 0) return newValue === 0 ? 0 : Infinity; return ((newValue - oldValue) / Math.abs(oldValue)) * 100;",
  },
];

const TIER_3_TOOLS = [ // levels 11-20 — multi-step, genuinely useful for real dev/business tasks
  {
    name: "password_strength_check",
    description: "Scores a password's strength (0-4) based on length, character variety, and common patterns, returning a label and the score.",
    params: ["password"],
    code: "let score = 0; if (password.length >= 8) score++; if (password.length >= 12) score++; if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++; if (/[0-9]/.test(password)) score++; if (/[^A-Za-z0-9]/.test(password)) score++; score = Math.min(4, score); const labels = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong']; return { score, label: labels[score] };",
  },
  {
    name: "invoice_total_calculator",
    description: "Calculates an invoice total from a list of {price, quantity} line items plus a tax rate percentage, returning subtotal, tax, and total.",
    params: ["lineItems", "taxRatePercent"],
    code: "const subtotal = lineItems.reduce((sum, item) => sum + (item.price * item.quantity), 0); const tax = subtotal * ((taxRatePercent || 0) / 100); return { subtotal: Math.round(subtotal * 100) / 100, tax: Math.round(tax * 100) / 100, total: Math.round((subtotal + tax) * 100) / 100 };",
  },
  {
    name: "text_similarity_score",
    description: "Estimates how similar two strings are (0-1) using word-overlap comparison — useful for spotting near-duplicate text or checking if a reply matches expected content.",
    params: ["textA", "textB"],
    code: "const wordsA = new Set(textA.toLowerCase().split(/\\s+/).filter(Boolean)); const wordsB = new Set(textB.toLowerCase().split(/\\s+/).filter(Boolean)); if (wordsA.size === 0 && wordsB.size === 0) return 1; const intersection = [...wordsA].filter(w => wordsB.has(w)).length; const union = new Set([...wordsA, ...wordsB]).size; return union === 0 ? 0 : Math.round((intersection / union) * 100) / 100;",
  },
];

const TIER_4_TOOLS = [ // levels 21+ — the most sophisticated, still plain JS, no system access
  {
    name: "markdown_table_generator",
    description: "Builds a formatted Markdown table from an array of row objects, auto-detecting column headers from the keys of the first row.",
    params: ["rows"],
    code: "if (!rows || !rows.length) return ''; const headers = Object.keys(rows[0]); const headerLine = '| ' + headers.join(' | ') + ' |'; const dividerLine = '| ' + headers.map(() => '---').join(' | ') + ' |'; const bodyLines = rows.map(row => '| ' + headers.map(h => String(row[h] ?? '')).join(' | ') + ' |'); return [headerLine, dividerLine, ...bodyLines].join('\\n');",
  },
  {
    name: "simple_project_estimator",
    description: "Estimates a rough project timeline in business days from a list of task objects with {name, hours}, given hours-available-per-day, returning per-task days and a total.",
    params: ["tasks", "hoursPerDay"],
    code: "const rate = hoursPerDay || 6; const breakdown = tasks.map(t => ({ name: t.name, days: Math.round((t.hours / rate) * 10) / 10 })); const totalDays = Math.round(breakdown.reduce((sum, t) => sum + t.days, 0) * 10) / 10; return { breakdown, totalDays };",
  },
];

const TIERS = [
  { minLevel: 2,  maxLevel: 5,        pool: TIER_1_TOOLS },
  { minLevel: 6,  maxLevel: 10,       pool: TIER_2_TOOLS },
  { minLevel: 11, maxLevel: 20,       pool: TIER_3_TOOLS },
  { minLevel: 21, maxLevel: Infinity, pool: TIER_4_TOOLS },
];

// ═══════════════════════════════════════════
// REAL SCALING FIX: the 4 hardcoded tiers above only cover roughly
// levels 2-23 (Tier 4's 2 tools run out fast for "level 21 to
// infinity"). Hand-writing curated tools all the way to level 100
// isn't real, honest engineering — ~80+ more tools written by hand
// would be a maintenance trap, not a scalable system. Instead, once the
// hardcoded pools for a level's tier are exhausted, Flow GENERATES its
// own proposal via a real API call — reusing the exact same
// [SELFTOOL_PROPOSAL] tagged format and force_intent:"code" retry
// mechanism already proven working in core/ai.js's manual proposal
// flow, not a new, separate system. The generated tool still goes
// through the same real checkToolSafety blocklist and the same
// Joel-approval UI — no bypass, same safety model, just a different
// SOURCE for the proposal once the hand-curated floor runs out.
//
// Higher levels get explicitly told to propose something bigger/more
// sophisticated in the prompt itself (Joel's own request: "the better
// Flow is, the better for me" at high levels) — still constrained to
// plain JS, no system access, since that constraint doesn't loosen with
// level per the documented safety model in selftools.js.
// ═══════════════════════════════════════════

/**
 * Real fallback once the hand-curated tiers are exhausted: asks the
 * model itself (via the same /api/chat endpoint every other Flow reply
 * uses) to generate a genuinely new, useful tool proposal scaled to the
 * new level. Returns the same shape as the hardcoded tiers, or null if
 * generation fails for any reason (network, bad JSON, failed safety
 * check) — a real failure here should never crash the level-up flow,
 * just mean no tool this time.
 */
export async function generateLevelUpToolProposal(newLevel, existingToolNames = []) {
  const sophistication = newLevel >= 60
    ? "a genuinely sophisticated, business-useful tool — something a real freelance web/bot developer would actually reach for (e.g. a rate-limiter simulator, a JSON schema validator, a cron-expression-to-human-text translator, a CSV-to-JSON transformer). Bigger and more capable is explicitly wanted at this level — Joel said so directly."
    : newLevel >= 40
    ? "a moderately sophisticated utility — something with real multi-step logic, not just a one-line calculation"
    : "a genuinely useful but focused utility, one clear job done well";

  const prompt = `Propose exactly ONE new self-tool for yourself, using the [SELFTOOL_PROPOSAL] tagged format you already know. This is for reaching level ${newLevel} — propose ${sophistication}
Tools Joel already has, to avoid a duplicate: ${existingToolNames.join(", ") || "none yet"}.
Remember the real hard constraint: plain JavaScript only, the function body only (not a full function declaration) in the "code" field, no filesystem/network/GitHub/OS access — that restriction doesn't loosen at higher levels, only the tool's usefulness and sophistication should scale up.
Reply with ONLY the tagged proposal block, no other conversational text.`;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
        force_intent: "code", // same real mechanism core/ai.js already uses to bias toward tagged-proposal-following models
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.reply) {
      console.warn("[LevelTools] Generation call failed — no tool this level-up.");
      return null;
    }

    const match = data.reply.match(/\[SELFTOOL_PROPOSAL\]([\s\S]*?)\[\/SELFTOOL_PROPOSAL\]/);
    if (!match) {
      console.warn("[LevelTools] Model didn't use the tagged format — no tool this level-up.");
      return null;
    }

    const parsed = JSON.parse(match[1].trim());
    if (!parsed.name || !parsed.description || !parsed.code) {
      console.warn("[LevelTools] Generated proposal missing required fields — no tool this level-up.");
      return null;
    }
    if (existingToolNames.includes(parsed.name)) {
      console.warn(`[LevelTools] Generated a duplicate name "${parsed.name}" — no tool this level-up (avoids the same-name collision approveTool would reject anyway).`);
      return null;
    }

    // Real, not assumed: run the exact same safety check any proposal
    // goes through — a generated tool gets ZERO extra trust over a
    // hand-curated or Flow-initiated one.
    const safety = checkToolSafety(parsed.code);
    if (!safety.safe) {
      console.warn(`[LevelTools] Generated tool failed safety check (${safety.reason}) — no tool this level-up.`);
      return null;
    }

    return {
      name: parsed.name,
      description: parsed.description,
      code: parsed.code,
      params: parsed.params || [],
    };
  } catch (e) {
    console.warn("[LevelTools] Generation failed:", e.message);
    return null;
  }
}

function pickTierPool(level) {
  const tier = TIERS.find(t => level >= t.minLevel && level <= t.maxLevel);
  return tier ? tier.pool : TIER_1_TOOLS; // real fallback for level 1 or any gap, rather than returning nothing
}

/**
 * Given the new level Joel just reached and the list of tool names he
 * already has (so we never propose a duplicate), returns a real,
 * pre-vetted tool proposal object in the exact shape
 * core/selftools.js's parseToolProposal produces — ready to feed
 * straight into the same approval UI every other self-tool uses.
 * Returns null if every tool in the matching tier (and all lower tiers,
 * as a real fallback) has already been granted — rather than proposing
 * a duplicate or forcing something irrelevant.
 */
export function pickLevelUpToolProposal(newLevel, existingToolNames = []) {
  const ownedSet = new Set(existingToolNames);

  // Try the matching tier first, then fall back to earlier tiers if
  // everything in the matching one is already owned — real edge case:
  // Joel could hit a level fast via a big award and already have picked
  // up some tier-1 tools manually before this system existed.
  const tierIndex = TIERS.findIndex(t => newLevel >= t.minLevel && newLevel <= t.maxLevel);
  const searchOrder = tierIndex >= 0
    ? [TIERS[tierIndex], ...TIERS.slice(0, tierIndex).reverse()]
    : [{ pool: TIER_1_TOOLS }];

  for (const tier of searchOrder) {
    const candidate = tier.pool.find(t => !ownedSet.has(t.name));
    if (candidate) {
      // Real, not assumed: re-verify against the actual live safety
      // checker before ever proposing it, in case selftools.js's
      // blocklist changes in the future and a previously-safe tool
      // stops qualifying.
      const safety = checkToolSafety(candidate.code);
      if (!safety.safe) {
        console.warn(`[LevelTools] Curated tool "${candidate.name}" failed a live safety re-check (${safety.reason}) — skipping, this needs a manual fix in core/leveltools.js.`);
        continue;
      }
      return {
        name: candidate.name,
        description: candidate.description,
        code: candidate.code,
        params: candidate.params,
      };
    }
  }

  return null; // every real, curated tool up to this tier already owned — genuinely nothing left to propose right now
}
