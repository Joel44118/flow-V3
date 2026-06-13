// ═══════════════════════════════════════════
// core/skills.js — Skills system
//
// Skill files live in /skills/*.md (served as static files by Vercel)
// On every AI call, detectSkill() picks the best matching skill,
// loadSkill() fetches it, and the content is injected into the prompt.
//
// Skills are cached in memory after first load (no repeat fetches).
// ═══════════════════════════════════════════

// ── Skill definitions ─────────────────────────────────────────────────────
// Each has:
//   file     — path under /skills/
//   keywords — regex that triggers it from the user's message
//   name     — human-readable label (for debug/logging)

const SKILLS = [
  {
    name:     "coding",
    file:     "/skills/coding.md",
    keywords: /\b(code|coding|write|function|script|debug|fix|bug|error|html|css|javascript|js|typescript|ts|python|react|component|api|endpoint|deploy|vercel|github|module|import|export|class|loop|array|object|json|fetch|async|await|promise|sql|database|regex)\b/i,
  },
  {
    name:     "web_design",
    file:     "/skills/web_design.md",
    keywords: /\b(design|ui|ux|layout|style|theme|colour|color|font|animation|responsive|mobile|landing page|website|webpage|navbar|footer|hero|card|button|form|dark mode|glassmorphism|gradient|flex|grid)\b/i,
  },
  {
    name:     "business",
    file:     "/skills/business.md",
    keywords: /\b(business|client|customer|revenue|pricing|market|marketing|joelflowstack|brand|fiverr|upwork|freelance|niche|service|proposal|pitch|portfolio|invoice|contract|grow|growth|strategy|competitor|nigeria|lagos|ibadan)\b/i,
  },
  {
    name:     "content",
    file:     "/skills/content.md",
    keywords: /\b(content|post|article|blog|write up|tweet|thread|linkedin|instagram|copy|caption|newsletter|email|ad|advertisement|headline|hook|cta|call to action|social media|viral|engagement|audience)\b/i,
  },
  {
    name:     "research",
    file:     "/skills/research.md",
    keywords: /\b(research|explain|how does|what is|compare|difference between|pros and cons|review|best|top|recommend|guide|overview|breakdown|deep dive|analyse|analyze|summarise|summarize)\b/i,
  },
  {
    name:     "youtube",
    file:     "/skills/youtube.md",
    keywords: /\b(youtube|video|channel|thumbnail|script|vlog|tutorial video|shorts|subscriber|views|monetise|monetize|record|edit|premiere)\b/i,
  },
];

// ── In-memory cache ───────────────────────────────────────────────────────
const _cache = {};

// ── Detect which skill matches the message ────────────────────────────────
// Returns the best matching skill object or null
export function detectSkill(text) {
  if (!text) return null;

  // Score each skill by number of keyword matches
  let best = null, bestScore = 0;

  for (const skill of SKILLS) {
    const matches = text.match(new RegExp(skill.keywords.source, "gi"));
    const score   = matches ? matches.length : 0;
    if (score > bestScore) { bestScore = score; best = skill; }
  }

  // Only inject a skill if there's at least one clear keyword hit
  return bestScore > 0 ? best : null;
}

// ── Load a skill file (cached after first fetch) ──────────────────────────
export async function loadSkill(skill) {
  if (!skill) return null;
  if (_cache[skill.name]) return _cache[skill.name];

  try {
    const res  = await fetch(skill.file);
    if (!res.ok) throw new Error(`${res.status}`);
    const text = await res.text();
    _cache[skill.name] = text;
    return text;
  } catch (e) {
    console.warn(`[Skills] Failed to load ${skill.file}:`, e.message);
    return null;
  }
}

// ── Convenience: detect + load in one call ────────────────────────────────
export async function getSkillContext(text) {
  const skill   = detectSkill(text);
  if (!skill) return null;
  const content = await loadSkill(skill);
  if (!content) return null;
  console.log(`[Skills] Loaded: ${skill.name}`);
  return { name: skill.name, content };
}
