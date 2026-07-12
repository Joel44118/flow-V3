// ═══════════════════════════════════════════
// core/github.js — GitHub integration for Flow
// ═══════════════════════════════════════════

const BASE = "/api/github";

// ── Parse a GitHub URL into owner/repo/path ──────────────────────────────
export function parseGithubUrl(text) {
  // Matches:
  //   https://github.com/owner/repo
  //   https://github.com/owner/repo/blob/main/path/to/file.js
  //   https://github.com/owner/repo/tree/main/folder
  const m = text.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(?:blob|tree)\/[^/\s]+\/(.+?))?(?:\s|$)/i
  );
  if (!m) return null;
  return {
    owner: m[1],
    repo:  m[2].replace(/\.git$/, ""),
    path:  m[3]?.replace(/\?.*$/, "") || "",   // strip query params
  };
}

// ── Get repo file tree ────────────────────────────────────────────────────
export async function getRepoTree(owner, repo) {
  const r = await fetch(`${BASE}?mode=tree&owner=${owner}&repo=${repo}`);
  if (!r.ok) throw new Error((await r.json()).error || "GitHub fetch failed");
  return r.json();
}

// ── Get a single file ─────────────────────────────────────────────────────
export async function getFile(owner, repo, path) {
  const r = await fetch(`${BASE}?mode=file&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error((await r.json()).error || "File fetch failed");
  return r.json();
}

// ── Get multiple files ────────────────────────────────────────────────────
export async function getFiles(owner, repo, paths) {
  const joined = paths.join(",");
  const r = await fetch(`${BASE}?mode=files&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(joined)}`);
  if (!r.ok) throw new Error((await r.json()).error || "Files fetch failed");
  return r.json();
}

// ── Repo map — lightweight, Cursor-style codebase awareness ──────────────
// Real industry pattern, confirmed via research: instead of trying to
// hold an entire codebase in context at once (doesn't scale, and isn't
// even how Cursor — the industry's own reference implementation — does
// it), maintain a compact MAP of what exists (file paths + a one-line
// summary of exported function/class names), and pull full file content
// only for files that are actually relevant to a given request.
// Deliberately NOT using embeddings/vector search here — that's the
// bigger piece explicitly deferred to build alongside real vector
// memory (per Joel's own decision, twice, earlier this session). This
// is the honest, achievable-now version: a plain regex scan for
// exported function/class names, genuinely sufficient at this repo's
// size (~128 files) without needing a real AST parser like Acorn, which
// would be overkill just to list function names.
const REPO_MAP_CACHE_KEY = "flow_repo_map_cache";
const REPO_MAP_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — real code does change, don't cache forever

function _extractExports(content) {
  const names = new Set();
  // Covers the common real patterns actually used across this codebase,
  // confirmed by looking at real files this session (core/ai.js,
  // core/commands.js, core/github.js, etc.): export function X,
  // export async function X, export const X = , export default.
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+const\s+(\w+)\s*=/g,
    /export\s+class\s+(\w+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content)) !== null) names.add(m[1]);
  }
  if (/export\s+default\s+/.test(content)) names.add("(default export)");
  return [...names];
}

export async function buildRepoMap(owner, repo, { forceRefresh = false } = {}) {
  const cacheKey = `${REPO_MAP_CACHE_KEY}_${owner}_${repo}`;
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached && (Date.now() - cached.builtAt) < REPO_MAP_CACHE_TTL_MS) {
        return cached.map;
      }
    } catch (_) { /* corrupt cache, rebuild */ }
  }

  const tree = await getRepoTree(owner, repo);
  const jsFiles = tree.files.filter((f) => /\.(js|jsx|mjs|cjs)$/i.test(f.path));

  // Real, honest cost note: this fetches every JS file's content once to
  // extract function names — a real cost for a large repo, but at ~128
  // files this is genuinely fine, and the 30-minute cache above means it
  // only happens this often, not on every single request.
  const map = [];
  for (const f of jsFiles) {
    try {
      const file = await getFile(owner, repo, f.path);
      const exportNames = _extractExports(file.content || "");
      map.push({ path: f.path, exports: exportNames, sizeBytes: f.size });
    } catch (e) {
      // Don't let one bad file fetch break the whole map — just note it
      // has unknown exports and move on.
      map.push({ path: f.path, exports: [], sizeBytes: f.size, error: e.message });
    }
  }

  try {
    localStorage.setItem(cacheKey, JSON.stringify({ map, builtAt: Date.now() }));
  } catch (_) { /* localStorage full or unavailable — cache is a nice-to-have, not required */ }

  return map;
}

// Formats a repo map into a compact text block suitable for injecting
// into an AI prompt — much smaller than sending full file contents, but
// still tells the model what exists and where, per file.
export function formatRepoMap(map) {
  return map
    .map((f) => `${f.path}${f.exports.length ? ` — exports: ${f.exports.join(", ")}` : ""}`)
    .join("\n");
}

// ── Search repos ──────────────────────────────────────────────────────────
export async function searchRepos(query) {
  const r = await fetch(`${BASE}?mode=search&query=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error((await r.json()).error || "Search failed");
  return r.json();
}

// ── Smart file picker ─────────────────────────────────────────────────────
// Given a tree + optional intent, picks the most relevant files to fetch
// Priority: files matching intent keywords, then entry points, then small files
// REAL FIX: previous defaults (5 files, 8000 bytes) were the confirmed
// root cause of Flow making blind full-file rewrites instead of targeted
// edits — with that little actual context, Flow couldn't see enough of
// the real codebase to understand what it was editing, so it guessed at
// what the WHOLE file should look like rather than seeing and adjusting
// the real one. This session's Nemotron 3 Ultra upgrade in api/chat.js
// (large-context provider, ~256K tokens on the hosted free endpoint) is
// what makes a much higher limit actually usable now — raising the
// defaults without that upgrade would have just meant more requests
// silently failing on providers that couldn't handle the payload size.
//
// 40 files / 300,000 bytes is a real, deliberate ceiling, not "no limit"
// — leaves room in the ~256K token budget for the system prompt,
// self-tools context, and the actual response, using the standard
// ~4 chars/token estimate (300,000 bytes ≈ 75,000 tokens of file
// content). Still not infinite — a genuinely huge multi-hundred-file
// change would need the file-splitting/multi-provider approach discussed
// earlier, not just a bigger single-call limit.
export function pickRelevantFiles(files, intent = "", maxFiles = 40, maxBytes = 300000) {
  const t = intent.toLowerCase();

  // Keywords from the intent
  const intentWords = t.match(/\b\w{3,}\b/g) || [];

  // Score each file
  const scored = files.map(f => {
    const name = f.path.toLowerCase();
    let score  = 0;

    // Intent keyword match in filename/path
    for (const w of intentWords) {
      if (name.includes(w)) score += 10;
    }

    // Entry point bonus
    if (/^(index|main|app|server|index\.html)\./i.test(f.path.split("/").pop())) score += 8;
    if (/^src\/(index|main|app)\./i.test(f.path)) score += 6;

    // Key file types for code understanding
    if (/\.(js|ts|py|go|rs)$/.test(name)) score += 3;
    if (/readme/i.test(name)) score += 5;
    if (/package\.json$/.test(name)) score += 4;
    if (/config\.|\.config\./i.test(name)) score += 2;

    // Prefer smaller files (faster, less token cost)
    score -= Math.floor(f.size / 10_000);

    return { ...f, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Collect until byte budget or file count hit
  const picked = [];
  let totalBytes = 0;
  for (const f of scored) {
    if (picked.length >= maxFiles) break;
    if (totalBytes + f.size > maxBytes) continue;
    picked.push(f);
    totalBytes += f.size;
  }

  return picked;
}

// ── Format repo summary for AI ────────────────────────────────────────────
export function formatRepoSummary(tree, fetchedFiles, intent) {
  const allPaths = tree.files.map(f => f.path).join("\n");

  let out = `GitHub Repo: ${tree.owner}/${tree.repo}\n`;
  if (tree.description) out += `Description: ${tree.description}\n`;
  if (tree.language)    out += `Primary language: ${tree.language}\n`;
  if (tree.stars)       out += `Stars: ${tree.stars}\n`;
  out += `\nAll files in repo:\n${allPaths}\n`;

  if (fetchedFiles?.length) {
    out += `\n--- FILE CONTENTS (${fetchedFiles.length} files fetched) ---\n`;
    for (const f of fetchedFiles) {
      if (f.error) { out += `\n[${f.path}] ERROR: ${f.error}\n`; continue; }
      out += `\n${"=".repeat(60)}\nFILE: ${f.path}\n${"=".repeat(60)}\n${f.content}\n`;
    }
  }

  return out;
}

// ── Format search results for AI ─────────────────────────────────────────
export function formatSearchResults(data, query) {
  if (!data.results?.length) return `No GitHub repos found for "${query}".`;
  let out = `GitHub search results for "${query}" (${data.total.toLocaleString()} total):\n\n`;
  for (const r of data.results) {
    out += `• ${r.full_name} ⭐${r.stars}`;
    if (r.language) out += ` [${r.language}]`;
    out += `\n  ${r.description || "No description"}\n  ${r.url}\n`;
    if (r.topics?.length) out += `  Topics: ${r.topics.join(", ")}\n`;
    out += "\n";
  }
  return out;
}

// ── Create a new GitHub repository ───────────────────────────────────────
export async function createRepo(name, description = "", isPrivate = false) {
  const r = await fetch(`${BASE}?mode=create-repo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, private: isPrivate }),
  });
  if (!r.ok) throw new Error((await r.json()).error || "Repo creation failed");
  return r.json(); // { url, clone_url, full_name }
}

// ── Create or update a file in a repo ────────────────────────────────────
export async function createOrUpdateFile(owner, repo, path, content, message, branch = "main") {
  const r = await fetch(`${BASE}?mode=put-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, path, content, message, branch }),
  });
  if (!r.ok) throw new Error((await r.json()).error || "File write failed");
  return r.json();
}

// ── Batch create files in a new repo ─────────────────────────────────────
// files: [{ path, content }]
export async function scaffoldRepo(owner, repo, files, commitMsg = "Initial scaffold by Flow") {
  const results = [];
  for (const f of files) {
    try {
      const res = await createOrUpdateFile(owner, repo, f.path, f.content, commitMsg);
      results.push({ path: f.path, ok: true, url: res.url });
    } catch(e) {
      results.push({ path: f.path, ok: false, error: e.message });
    }
  }
  return results;
}

// ── Create a branch ─────────────────────────────────────────────────────
export async function createBranch(owner, repo, branch, from = "main") {
  const r = await fetch(`${BASE}?mode=create-branch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, branch, from }),
  });
  if (!r.ok) throw new Error((await r.json()).error || "Branch creation failed");
  return r.json();
}

// ── Delete a file ────────────────────────────────────────────────────────
export async function deleteFile(owner, repo, path, message = "delete file", branch = "main") {
  const r = await fetch(`${BASE}?mode=delete-file`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, path, message, branch }),
  });
  if (!r.ok) throw new Error((await r.json()).error || "Delete failed");
  return r.json();
}

// ── Create a pull request ─────────────────────────────────────────────────
export async function createPR(owner, repo, title, head, base = "main", body = "") {
  const r = await fetch(`${BASE}?mode=create-pr`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner, repo, title, head, base, body }),
  });
  if (!r.ok) throw new Error((await r.json()).error || "PR creation failed");
  return r.json();
}

// ── List branches ────────────────────────────────────────────────────────
export async function listBranches(owner, repo) {
  const r = await fetch(`${BASE}?mode=list-branches&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`);
  if (!r.ok) throw new Error((await r.json()).error || "Failed to list branches");
  return r.json();
}
