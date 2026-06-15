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

// ── Search repos ──────────────────────────────────────────────────────────
export async function searchRepos(query) {
  const r = await fetch(`${BASE}?mode=search&query=${encodeURIComponent(query)}`);
  if (!r.ok) throw new Error((await r.json()).error || "Search failed");
  return r.json();
}

// ── Smart file picker ─────────────────────────────────────────────────────
// Given a tree + optional intent, picks the most relevant files to fetch
// Priority: files matching intent keywords, then entry points, then small files
export function pickRelevantFiles(files, intent = "", maxFiles = 12, maxBytes = 60_000) {
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
