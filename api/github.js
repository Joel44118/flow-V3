// ═══════════════════════════════════════════
// api/github.js — GitHub repo fetcher
// GITHUB_TOKEN in Vercel env vars (optional but recommended)
// Get one: github.com → Settings → Developer Settings →
//          Personal Access Tokens → Fine-grained → Read-only contents
// ═══════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { mode, owner, repo, path = "", query, branch } = req.query;

  const headers = {
    "Accept":               "application/vnd.github+json",
    "User-Agent":           "Flow-V3",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {

    // ── TREE: full file list of a repo ─────────────────────────────────
    if (mode === "tree") {
      if (!owner || !repo) return res.status(400).json({ error: "owner + repo required" });

      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) return res.status(repoRes.status).json({ error: (await repoRes.json()).message });
      const repoData      = await repoRes.json();
      const defaultBranch = branch || repoData.default_branch || "main";

      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
        { headers }
      );
      if (!treeRes.ok) return res.status(treeRes.status).json({ error: (await treeRes.json()).message });
      const tree = await treeRes.json();

      // Text files only, skip binaries and huge files
      const TEXT_EXT = /\.(js|ts|jsx|tsx|py|html|css|md|json|txt|sh|yaml|yml|env\.example|sql|rs|go|java|cpp|c|h|rb|php|swift|kt)$/i;
      const files = (tree.tree || [])
        .filter(f => f.type === "blob" && f.size < 400_000 && TEXT_EXT.test(f.path))
        .map(f => ({ path: f.path, size: f.size }));

      return res.status(200).json({
        owner, repo,
        branch:      defaultBranch,
        description: repoData.description,
        language:    repoData.language,
        stars:       repoData.stargazers_count,
        files,
        truncated:   tree.truncated || false,
      });
    }

    // ── FILE: single file content ───────────────────────────────────────
    if (mode === "file") {
      if (!owner || !repo || !path) return res.status(400).json({ error: "owner + repo + path required" });

      const r = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        { headers }
      );
      if (!r.ok) return res.status(r.status).json({ error: (await r.json()).message });
      const d = await r.json();
      return res.status(200).json({
        path:    d.path,
        size:    d.size,
        content: Buffer.from(d.content, "base64").toString("utf-8"),
      });
    }

    // ── FILES: multiple files at once (path = comma-separated) ─────────
    if (mode === "files") {
      if (!owner || !repo || !path) return res.status(400).json({ error: "owner + repo + path required" });

      const paths   = path.split(",").map(p => p.trim()).filter(Boolean).slice(0, 20);
      const results = [];

      for (const p of paths) {
        try {
          const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}`, { headers });
          if (!r.ok) { results.push({ path: p, error: "not found" }); continue; }
          const d = await r.json();
          results.push({ path: p, content: Buffer.from(d.content, "base64").toString("utf-8"), size: d.size });
        } catch { results.push({ path: p, error: "fetch failed" }); }
      }

      return res.status(200).json({ owner, repo, files: results });
    }

    // ── SEARCH: find repos on GitHub ────────────────────────────────────
    if (mode === "search") {
      if (!query) return res.status(400).json({ error: "query required" });

      const r = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=8`,
        { headers }
      );
      if (!r.ok) return res.status(r.status).json({ error: (await r.json()).message });
      const d = await r.json();

      return res.status(200).json({
        total:   d.total_count,
        results: (d.items || []).map(r => ({
          full_name:   r.full_name,
          description: r.description,
          stars:       r.stargazers_count,
          language:    r.language,
          url:         r.html_url,
          topics:      r.topics,
        })),
      });
    }

    // ── CREATE-REPO ──────────────────────────────────────────────────────
    if (mode === "create-repo") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { name, description = "", private: isPrivate = false } = body || {};
      if (!name) return res.status(400).json({ error: "name required" });

      const r = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
      });
      if (!r.ok) return res.status(r.status).json({ error: (await r.json()).message });
      const d = await r.json();
      return res.status(200).json({
        full_name: d.full_name,
        url:       d.html_url,
        clone_url: d.clone_url,
        private:   d.private,
      });
    }

    // ── PUT-FILE: create or update a file in a repo ───────────────────────
    if (mode === "put-file") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const { owner: fOwner, repo: fRepo, path: fPath, content, message, branch = "main" } = body || {};
      if (!fOwner || !fRepo || !fPath || content === undefined || !message)
        return res.status(400).json({ error: "owner, repo, path, content, message required" });

      // Check if file already exists (need SHA to update)
      let sha;
      try {
        const existing = await fetch(
          `https://api.github.com/repos/${fOwner}/${fRepo}/contents/${fPath}`,
          { headers }
        );
        if (existing.ok) { const ed = await existing.json(); sha = ed.sha; }
      } catch(_) {}

      const encoded = Buffer.from(content, "utf-8").toString("base64");
      const payload = { message, content: encoded, branch };
      if (sha) payload.sha = sha;

      const r = await fetch(
        `https://api.github.com/repos/${fOwner}/${fRepo}/contents/${fPath}`,
        { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      if (!r.ok) return res.status(r.status).json({ error: (await r.json()).message });
      const d = await r.json();
      return res.status(200).json({
        path: fPath,
        url:  d.content?.html_url,
        sha:  d.content?.sha,
      });
    }

    return res.status(400).json({ error: "Unknown mode" });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
