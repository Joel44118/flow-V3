// ═══════════════════════════════════════════
// core/commands.js — ALL imports at top
// ═══════════════════════════════════════════
import { Weather }         from "./weather.js";
import { Alarms, normaliseTime } from "./alarms.js";
import { Storage }         from "./storage.js";
import { CONFIG }          from "./config.js";
import { webSearch, deepResearch, smartSearch, formatResults, businessResearch, inspectUrl, formatUrlResult } from "./websearch.js";
import { saveGoals, getTodayGoals, completeGoal, getStats, formatGoalsForAI } from "./goals.js";
import { parseGithubUrl, getRepoTree, getFile, getFiles, searchRepos, pickRelevantFiles, formatRepoSummary, formatSearchResults, createRepo, createOrUpdateFile, scaffoldRepo } from "./github.js";
import { parseAgentCommand, activateAgent, deactivateAgent, getActiveAgent, AGENTS } from "./agent.js";

// ── Injected refs (set at boot to avoid circular imports) ──
let _notepad = null;
let _speak   = null;
let _vision  = null;
let _searchSend = null;
let _chatAdd    = null;

export function setNotepad(n)          { _notepad    = n; }
export function setSpeakFn(fn)         { _speak      = fn; }
export function setVision(v)           { _vision     = v; }
export function setSearchHandlers(s,c) { _searchSend = s; _chatAdd = c; }

// ── Site open map ──────────────────────────
const SITES = [
  { rx:/open\s+youtube/i,            url:"https://youtube.com" },
  { rx:/open\s+google(?!\s+maps?)/i, url:"https://google.com" },
  { rx:/open\s+gmail/i,              url:"https://mail.google.com" },
  { rx:/open\s+(google\s+)?maps?/i,  url:"https://maps.google.com" },
  { rx:/open\s+(twitter|x\.com)/i,   url:"https://x.com" },
  { rx:/open\s+reddit/i,             url:"https://reddit.com" },
  { rx:/open\s+github/i,             url:"https://github.com" },
  { rx:/open\s+spotify/i,            url:"https://open.spotify.com" },
  { rx:/open\s+netflix/i,            url:"https://netflix.com" },
  { rx:/open\s+whatsapp/i,           url:"https://web.whatsapp.com" },
  { rx:/open\s+telegram/i,           url:"https://web.telegram.org" },
  { rx:/open\s+instagram/i,          url:"https://instagram.com" },
  { rx:/open\s+facebook/i,           url:"https://facebook.com" },
  { rx:/open\s+tiktok/i,             url:"https://tiktok.com" },
  { rx:/open\s+discord/i,            url:"https://discord.com/app" },
  { rx:/open\s+claude/i,             url:"https://claude.ai" },
  { rx:/open\s+chatgpt/i,            url:"https://chatgpt.com" },
  { rx:/open\s+notion/i,             url:"https://notion.so" },
  { rx:/open\s+figma/i,              url:"https://figma.com" },
  { rx:/open\s+canva/i,              url:"https://canva.com" },
  { rx:/open\s+(google\s+)?drive/i,  url:"https://drive.google.com" },
  { rx:/open\s+(google\s+)?docs/i,   url:"https://docs.google.com" },
  { rx:/open\s+(google\s+)?sheets/i, url:"https://sheets.google.com" },
  { rx:/open\s+linkedin/i,           url:"https://linkedin.com" },
  { rx:/open\s+twitch/i,             url:"https://twitch.tv" },
  { rx:/open\s+vercel/i,             url:"https://vercel.com/dashboard" },
  { rx:/open\s+stackover/i,          url:"https://stackoverflow.com" },
   { rx:/open\s+fiverr/i,             url:"https://fiverr.com" },
  { rx:/open\s+mdn/i,                url:"https://developer.mozilla.org" },
  { rx:/open\s+(https?:\/\/\S+)/i,   fn: m => m[1] },
  { rx:/open\s+(\w[\w.-]+\.\w{2,})/i,fn: m => `https://${m[1]}` },
];

export function getTime() {
  return new Date().toLocaleTimeString("en-NG", { hour:"2-digit", minute:"2-digit", hour12:true });
}
export function getDate() {
  return new Date().toLocaleDateString("en-NG", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
}

// ── Local command parser ───────────────────
// Returns: string (reply) | null (handled silently) | false (→ API)
export async function parseCommand(text) {
  const t = text.toLowerCase().trim();

  if (/what.s the time|time now|current time/i.test(t))  return `It's ${getTime()}.`;
  if (/what.s the date|what day/i.test(t))               return `Today is ${getDate()}.`;
  if (/weather|forecast|temperature|how hot|rain/i.test(t))
    return `Weather in ${CONFIG.USER.city}: ${await Weather.get()}`;

  // Notepad
  if (/open\s+(notepad|note)/i.test(t))                         { _notepad?.open(false); return null; }
  if (/take\s+a?\s*note|write.*down|start\s+note/i.test(t))    { _notepad?.open(true);  return null; }
  if (/close\s+(notepad|note)/i.test(t))                        { _notepad?.close();     return null; }
  if (/clear\s+(notepad|note)/i.test(t))                        { _notepad?.clear();     return null; }

  // Brain
  if (/export\s+(brain|memory|backup)/i.test(t)) return Storage.exportBrain();

  // Alarm set
  const alarmSet = text.match(/set\s+an?\s*alarm\s+(?:for\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(.*)?/i);
  if (alarmSet) {
    const timeStr = normaliseTime(alarmSet[1]);
    const label   = alarmSet[2]?.replace(/^[^a-z0-9]+/i,"").trim() || alarmSet[1].trim();
    return Alarms.set(timeStr, label, _speak);
  }
  if (/list\s+alarms?|my\s+alarms?|show\s+alarms?/i.test(t)) return Alarms.list();
  const alarmDel = text.match(/(?:delete|cancel|remove)\s+alarm(?:\s+for)?\s+(.+)/i);
  if (alarmDel) return Alarms.del(alarmDel[1]);

  // Sites
  for (const p of SITES) {
    const m = text.match(p.rx);
    if (m) { window.open(p.fn ? p.fn(m) : p.url, "_blank"); return `Opening ${m[1] || "that"} now.`; }
  }

  return false;
}

// ── Vision commands ────────────────────────
export async function parseVisionCommand(text) {
  const t = text.toLowerCase().trim();

  if (/open\s+camera|start\s+camera|turn\s+on\s+camera/i.test(t))         { _vision?.Camera.start();        return null; }
  if (/close\s+camera|stop\s+camera|turn\s+off\s+camera/i.test(t))        { _vision?.Camera.stop();         return null; }
  if (/share\s+screen|open\s+screen|see\s+my\s+screen/i.test(t))          { _vision?.ScreenVision.start();  return null; }
  if (/stop\s+screen|close\s+screen|stop\s+sharing/i.test(t))             { _vision?.ScreenVision.stop();   return null; }
  if (/start\s+yolo|object\s+detect|detect\s+objects|eyes?\s+on/i.test(t)){ _vision?.YOLO.start();          return null; }
  if (/stop\s+yolo|eyes?\s+off|stop\s+detect/i.test(t))                   { _vision?.YOLO.stop();           return null; }
  if (/learn\s+my\s+face|remember\s+my\s+face/i.test(t))                  { _vision?.Camera.learnMyFace?.(); return null; }

  if (/what\s+(?:do\s+you\s+)?see|look\s+at\s+(?:the\s+)?(?:screen|camera)/i.test(t)) {
    if (_vision?.ScreenVision._video) { _vision.ScreenVision.look(text); return null; }
    if (_vision?.Camera._video)       { _vision.Camera.look(text);       return null; }
    return "No camera or screen open yet. Say 'open camera' or 'share screen' first.";
  }
  if (/what.s on my screen|read.*screen/i.test(t)) { _vision?.ScreenVision.look(text); return null; }
  if (/who is that|who am i/i.test(t))              { _vision?.Camera.look(text);       return null; }

  return false;
}

// ── Search + Goals commands ────────────────
export async function parseSearchGoalCommand(text) {
  const t = text.toLowerCase().trim();

  // ── Push structure from conversation history ───────────────────
  // ── Repo structure: create OR push ────────────────────────────────────
  // Catches: "create a structure for flowpay", "push it to flowpay repo",
  //          "push the files to flowpay", "scaffold myapp repo", etc.
  const _structureCreateRx = /(?:create|build|generate|make|set up|setup)\s+(?:a\s+)?(?:(?:folder|file|project|repo)\s+)?structure\s+(?:for\s+)?/i;
  const _pushRx1 = /(?:push|scaffold|commit|upload)\s+(?:it|them|everything|all|this)?\s*(?:to|into|in)?\s*(?:the\s+)?(?:[a-z0-9_.-]+\s+)?(?:repo|github|structure|files?|code|that)?/i;
  const _pushRx2 = /(?:create|add)\s+(?:the|that)\s+\w+\s+(?:structure|files?|code)/i;
  const _pushExclude = /create\s+(?:a\s+)?(?:new\s+)?(?:github\s+)?repo(?!\s+structure)/i;

  const _isStructureCreate = _structureCreateRx.test(t);
  const _isPush = (_pushRx1.test(t) || _pushRx2.test(t)) && !_pushExclude.test(t);

  if (_isStructureCreate || _isPush) {
    // Extract target repo — owner/repo, or word before "repo", or word after preposition
    let owner = "Joel44118", repo = "";
    const _fullRepoM = text.match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
    const _beforeRepo = t.match(/(\b(?!github\b|the\b|my\b|a\b)\w{3,})\s+repo\b/i);
    const _afterPrep  = t.match(/(?:for|into|to|in)\s+(?:(?:the|he|a)\s+)?(?:repo\s+)?([a-z][a-z0-9_.-]{2,})(?:\s+repo)?/i);
    if (_fullRepoM) { owner = _fullRepoM[1]; repo = _fullRepoM[2]; }
    else if (_beforeRepo) { repo = _beforeRepo[1]; }
    else if (_afterPrep && _afterPrep[1] !== "github") { repo = _afterPrep[1]; }

    if (!repo) return false; // can't determine repo — let AI handle it

    // Build the AI prompt based on intent
    const history = (_getHistory?.() || []).slice(-24);
    let aiPrompt;

    if (_isStructureCreate) {
      // Fresh structure creation — Joel is asking Flow to design AND push the structure
      const projectHint = t.replace(_structureCreateRx, "").replace(/\s*repo\s*/i, "").trim() || repo;
      aiPrompt =
        "Create a complete project folder structure for: " + projectHint + "\n" +
        "Repo: " + owner + "/" + repo + "\n\n" +
        "Respond ONLY with a valid JSON array. No markdown, no backticks, no explanation. Format:\n" +
        '[{ "path": "relative/path/file.ext", "content": "file content here" }]\n\n' +
        "Rules:\n" +
        "- Every file must have real, working content (no TODOs, no placeholders)\n" +
        "- README.md must describe the project\n" +
        "- Max 12 files\n" +
        "- Relative paths, no leading slash\n" +
        "- Pick the right tech stack from the project name and description";
    } else {
      // Push — re-extract structure from conversation history
      aiPrompt =
        "The user wants to push the project structure from this conversation to GitHub repo " + owner + "/" + repo + ".\n" +
        "Look through the conversation history and find the file structure or code that was discussed.\n" +
        "Respond ONLY with a valid JSON array. No markdown, no backticks, no explanation. Format:\n" +
        '[{ "path": "relative/path/file.ext", "content": "complete file content" }]\n\n' +
        "Rules: all file contents complete and working, max 15 files, relative paths only.";
    }

    _chatAdd?.(_isStructureCreate
      ? "Creating project structure for " + owner + "/" + repo + "..."
      : "Preparing files for " + owner + "/" + repo + "...", "bot");

    try {
      const res = await fetch("/api/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          messages: [...history, { role: "user", content: aiPrompt }]
        }),
      });
      if (!res.ok) throw new Error("AI error " + res.status);
      const data = await res.json();
      let raw = data.reply || data.content || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
      raw = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim();

      let files;
      try { files = JSON.parse(raw); }
      catch (_) {
        const m = raw.match(/\[[\s\S]+\]/);
        if (!m) throw new Error("AI didn't return a valid file list. Try: /scaffold " + owner + "/" + repo + " <description>");
        files = JSON.parse(m[0]);
      }

      if (!Array.isArray(files) || !files.length) throw new Error("AI returned no files.");

      _chatAdd?.("Pushing " + files.length + " files to " + owner + "/" + repo + "...", "bot");

      const results = [];
      for (const f of files) {
        if (!f.path || f.content === undefined) continue;
        try {
          await createOrUpdateFile(owner, repo, f.path, f.content, (_isStructureCreate ? "scaffold: " : "update: ") + f.path);
          results.push({ path: f.path, ok: true });
          _chatAdd?.("✅ " + f.path, "bot");
        } catch (e) {
          results.push({ path: f.path, ok: false, error: e.message });
          _chatAdd?.("❌ " + f.path + " — " + e.message, "bot");
        }
      }

      const ok   = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok).length;
      const repoUrl = "https://github.com/" + owner + "/" + repo;
      _chatAdd?.(
        ok + " file" + (ok !== 1 ? "s" : "") + " pushed to " + owner + "/" + repo +
        (fail ? ", " + fail + " failed" : "") + ":\n" +
        results.map(r => (r.ok ? "\u2705" : "\u274c") + " " + r.path).join("\n") +
        "\n\n\uD83D\uDD17 " + repoUrl,
        "bot"
      );
    } catch (e) {
      _chatAdd?.("❌ " + e.message, "bot");
    }
    return null;
  }

  // ── Agent mode activation / deactivation ───────────────────────────
  const agentCmd = parseAgentCommand(text);
  if (agentCmd.action === "activate") {
    const agent = await activateAgent(agentCmd.id);
    if (agent) {
      _chatAdd?.(agent.icon + " " + agent.name + " is live, Boss. Just talk to me naturally — no commands needed. Every response is now fully optimised for " + agent.id + " work. Say exit agent when you're done.", "bot");
    }
    return null;
  }
  if (agentCmd.action === "deactivate") {
    const was = getActiveAgent();
    deactivateAgent();
    _chatAdd?.((was ? was.icon + " " + was.name : "Agent mode") + " deactivated. Back to standard Flow.", "bot");
    return null;
  }

  // ── Smart web search (news, research, general) ───────────────────────────
  // Triggers: search/news/latest/look up/tell me about + any topic
  const isSearch = /^(search|look up|find|tell me|what\'s|whats|latest|recent|news on|news about|update on|give me|show me)/i.test(t)
    && !/github\.com/i.test(t);

  if (isSearch) {
    await smartSearch(text, _searchSend, _chatAdd);
    return null;
  }

  // ── GitHub repo extraction ─────────────────────────────────────────────
  // Triggers: github.com URL anywhere in text, or explicit "from github" phrasing
  const ghUrl = parseGithubUrl(text);
  const isGhSearch = /search\s+github|find\s+(on|in)\s+github|github\s+repos?\s+for/i.test(t);

  if (isGhSearch) {
    const q = text.replace(/search\s+github|find\s+(on|in)\s+github|github\s+repos?\s+for/gi, "").trim();
    if (q) {
      _chatAdd?.(`Searching GitHub for "${q}"...`, "bot");
      try {
        const data = await searchRepos(q);
        const formatted = formatSearchResults(data, q);
        _searchSend?.(`I searched GitHub for "${q}". Results:\n\n${formatted}\n\nSummarise the best options and recommend which looks most useful for what was asked.`);
      } catch(e) { _chatAdd?.(`GitHub search failed: ${e.message}`, "bot"); }
      return null;
    }
  }

  if (ghUrl) {
    const { owner, repo, path } = ghUrl;
    const isDeep = /deep|full|entire|all files|everything|explain|analyse|analyze|how does|understand/i.test(t);

    // If a specific file path was in the URL — fetch just that file
    if (path && /\.\w+$/.test(path)) {
      _chatAdd?.(`Fetching ${owner}/${repo}/${path}...`, "bot");
      try {
        const file = await getFile(owner, repo, path);
        _searchSend?.(`Here is the file ${file.path} from GitHub repo ${owner}/${repo}:\n\n\`\`\`\n${file.content}\n\`\`\`\n\nAnalyse this code: explain what it does, how it works, and anything notable.`);
      } catch(e) { _chatAdd?.(`Couldn't fetch that file: ${e.message}`, "bot"); }
      return null;
    }

    // Fetch the full repo tree
    _chatAdd?.(`Reading ${owner}/${repo}...`, "bot");
    try {
      const tree = await getRepoTree(owner, repo);
      if (!tree.files?.length) {
        _chatAdd?.("That repo appears to be empty or has no readable files.", "bot");
        return null;
      }

      // Pick most relevant files based on intent
      const intent  = text.replace(/https?:\/\/\S+/g, "").trim();
      const toFetch = pickRelevantFiles(tree.files, intent, isDeep ? 16 : 8, isDeep ? 80_000 : 40_000);

      _chatAdd?.(`Fetching ${toFetch.length} of ${tree.files.length} files...`, "bot");
      const fetched = await getFiles(owner, repo, toFetch.map(f => f.path));
      const summary = formatRepoSummary(tree, fetched.files, intent);

      const aiPrompt = isDeep
        ? `Do a thorough analysis of this GitHub repo. Cover: what it does, how the code is structured, key design decisions, tech stack, and anything worth learning or reusing.\n\n${summary}`
        : `Summarise this GitHub repo. What does it do, how is it structured, and what are the key files?\n\n${summary}`;

      _searchSend?.(aiPrompt);
    } catch(e) { _chatAdd?.(`GitHub fetch failed: ${e.message}`, "bot"); }
    return null;
  }

  // ── URL inspection ─────────────────────────────────────────────────────
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    const url  = urlMatch[0];
    const deep = /deep research|full analysis|audit|everything about/i.test(t);
    _chatAdd?.(`Fetching ${url}...`, "bot");
    const data = await inspectUrl(url, deep);
    if (!data) return "I couldn\'t reach that URL. It might be offline or blocking bots.";
    const formatted = formatUrlResult(data, deep);
    const intent    = deep
      ? `Do a thorough analysis of this website. Cover: purpose, features, tech stack clues, content quality, target audience, pricing if any, and anything notable.\n\n${formatted}`
      : `Summarise this website briefly. What does it do, who is it for, and what are the main features?\n\n${formatted}`;
    _searchSend?.(intent);
    return null;
  }

  if (/^(search|look up|google|find|latest|news about)\s+(.+)/i.test(t)) {
    const query = text.replace(/^(search|look up|google|find)\s+/i,"").trim();
    _chatAdd?.(`Searching for "${query}"...`, "bot");
    const results = await webSearch(query, "quick");
    if (!results?.length) return `Nothing found for "${query}" right now.`;
    const context = formatResults(results, query);
    _searchSend?.(`I searched the web for "${query}". Results:\n\n${context}\n\nGive me a clear useful answer based on this.`);
    return null;
  }
  if (/research|deep\s*dive|investigate|tell me everything about/i.test(t)) {
    const query = text.replace(/research|deep\s*dive|investigate|tell me everything about/gi,"").trim();
    _chatAdd?.(`Researching "${query}"...`, "bot");
    await deepResearch(query, _searchSend);
    return null;
  }
  if (/grow.*business|joelflowstack|business\s+tips/i.test(t)) {
    _chatAdd?.("Researching growth strategies...", "bot");
    await businessResearch(_searchSend);
    return null;
  }

  // Goals
  if (/my\s+goals|today.s\s+goals|show\s+goals/i.test(t)) {
    const e = getTodayGoals();
    return e ? formatGoalsForAI(e) : "No goals uploaded today yet.";
  }
  if (/done\s+(?:with\s+)?goal\s*#?(\d+)|completed?\s+goal\s*#?(\d+)/i.test(t)) {
    const m = t.match(/(\d+)/);
    if (m) { const e = completeGoal(parseInt(m[1])-1); return e ? formatGoalsForAI(e) : "No goals yet."; }
  }
  if (/goal\s+stats|my\s+stats|streak/i.test(t)) {
    const s = getStats();
    return `${s.currentStreak} day streak, ${s.totalDaysUploaded} days uploaded, ${s.totalGoalsCompleted} goals completed.`;
  }

  return false;
}

// ── Repo creation — called directly from app.js /repo slash command ───────
export async function handleRepoCommand(rawInput) {
  const parts    = rawInput.trim().split(/\s+/);
  const repoName = parts[0].replace(/[^\w._-]/g, "");
  const repoDesc = parts.slice(1).join(" ").trim();
  if (!repoName) { _chatAdd?.("Give me a repo name — e.g. /repo my-project", "bot"); return; }
  _chatAdd?.(`Creating GitHub repo "${repoName}"...`, "bot");
  try {
    const result = await createRepo(repoName, repoDesc);
    _chatAdd?.(
      "\u2705 Repo created: " + result.full_name + "\n" +
      "\uD83D\uDD17 " + result.url + "\n" +
      "Clone: " + result.clone_url + "\n\n" +
      "Say \"create a structure for " + repoName + "\" and I\'ll scaffold and push the files.",
      "bot"
    );
  } catch(e) {
    _chatAdd?.(`❌ Repo creation failed: ${e.message}`, "bot");
  }
}

// ── Scaffold repo (/scaffold owner/repo <project description>) ───────────
// Calls AI to generate file tree + contents as JSON, then pushes each file
export async function handleScaffoldCommand(rawInput) {
  const trimmed  = rawInput.trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) {
    _chatAdd?.("Usage: /scaffold owner/repo-name  description of the project\nExample: /scaffold Joel44118/Flowpay A payment API with Express and Stripe", "bot");
    return;
  }
  const repoFull    = trimmed.slice(0, spaceIdx);
  const projectDesc = trimmed.slice(spaceIdx + 1).trim();
  const slashIdx    = repoFull.indexOf("/");
  if (slashIdx === -1) {
    _chatAdd?.(`Format must be owner/repo — got "${repoFull}"`, "bot");
    return;
  }
  const owner = repoFull.slice(0, slashIdx);
  const repo  = repoFull.slice(slashIdx + 1);

  _chatAdd?.(`Generating file structure for ${owner}/${repo}...`, "bot");

  const aiPrompt = `You are a senior software engineer. Generate a complete starter project scaffold for:

Project: ${projectDesc}
Repo: ${owner}/${repo}

Respond ONLY with a valid JSON array. No markdown, no backticks, no explanation — just the raw JSON.
Each element: { "path": "relative/path/to/file.ext", "content": "complete file content" }

Rules:
- All file contents must be complete and working — no placeholders or TODOs
- Include: README.md, entry point, config files, folder structure appropriate for the stack
- Max 12 files — practical and clean
- Relative paths only (no leading slash)
- README.md must describe the project clearly`;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: aiPrompt }] }),
    });
    if (!res.ok) throw new Error(`AI call failed (${res.status})`);
    const data = await res.json();

    // Extract AI text — handle both OpenRouter and Groq response shapes
    let raw = data.content || data.choices?.[0]?.message?.content || "";
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    let files;
    try {
      files = JSON.parse(raw);
    } catch (_) {
      const match = raw.match(/\[[\s\S]+\]/);
      if (!match) throw new Error("AI didn't return valid JSON. Try rephrasing the project description.");
      files = JSON.parse(match[0]);
    }

    if (!Array.isArray(files) || !files.length) throw new Error("AI returned an empty file list.");

    _chatAdd?.(`Pushing ${files.length} files to ${owner}/${repo}...`, "bot");

    const results = [];
    for (const f of files) {
      if (!f.path || f.content === undefined) continue;
      try {
        await createOrUpdateFile(owner, repo, f.path, f.content, `scaffold: add ${f.path}`);
        results.push({ path: f.path, ok: true });
        _chatAdd?.(`✅ ${f.path}`, "bot");
      } catch (e) {
        results.push({ path: f.path, ok: false, error: e.message });
        _chatAdd?.(`❌ ${f.path} — ${e.message}`, "bot");
      }
    }

    const ok   = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    _chatAdd?.(
      ok + " file" + (ok !== 1 ? "s" : "") + " pushed to " + owner + "/" + repo +
      (fail ? ", " + fail + " failed" : "") + ":\n" +
      results.map(r => (r.ok ? "\u2705" : "\u274c") + " " + r.path).join("\n") +
      "\n\n\uD83D\uDD17 https://github.com/" + owner + "/" + repo,
      "bot"
    );
  } catch (e) {
    _chatAdd?.(`❌ Scaffold failed: ${e.message}`, "bot");
  }
}

// ── Push a single file (/push owner/repo path/to/file.js) ─────────────────
// If content follows inline after the path, push immediately.
// If not, set a pending state and push on next message.
export async function handlePushCommand(rawInput) {
  const tokens = rawInput.trim().split(/\s+/);
  if (tokens.length < 2) {
    _chatAdd?.("Usage: /push owner/repo path/to/file.js\nThen paste your code as the next message.", "bot");
    return;
  }
  const repoFull    = tokens[0];
  const filePath    = tokens[1];
  const inlineContent = tokens.slice(2).join(" ").trim();
  const slashIdx    = repoFull.indexOf("/");
  if (slashIdx === -1) {
    _chatAdd?.(`Format must be owner/repo — got "${repoFull}"`, "bot");
    return;
  }
  const owner = repoFull.slice(0, slashIdx);
  const repo  = repoFull.slice(slashIdx + 1);

  if (inlineContent) {
    await _doPush(owner, repo, filePath, inlineContent);
  } else {
    window._flowPendingPush = { owner, repo, filePath };
    _chatAdd?.(`Ready. Paste the content for \`${filePath}\` in \`${owner}/${repo}\` and send it.`, "bot");
  }
}

// ── Internal: do the actual file push ────────────────────────────────────
async function _doPush(owner, repo, filePath, content) {
  _chatAdd?.(`Pushing \`${filePath}\` → \`${owner}/${repo}\`...`, "bot");
  try {
    const result = await createOrUpdateFile(owner, repo, filePath, content, `update ${filePath}`);
    _chatAdd?.(
      "\u2705 Pushed: " + filePath + "\n\uD83D\uDD17 " + (result.url || "https://github.com/" + owner + "/" + repo + "/blob/main/" + filePath),
      "bot"
    );
  } catch (e) {
    _chatAdd?.(`❌ Push failed: ${e.message}`, "bot");
  }
}

// ── Intercept pending push before sending to AI ──────────────────────────
// Call this at the top of flowSend(). Returns true if consumed.
export async function checkPendingPush(text) {
  if (!window._flowPendingPush) return false;
  const { owner, repo, filePath } = window._flowPendingPush;
  window._flowPendingPush = null;
  await _doPush(owner, repo, filePath, text);
  return true;
}
