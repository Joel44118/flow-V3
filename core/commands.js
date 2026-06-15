// ═══════════════════════════════════════════
// core/commands.js — ALL imports at top
// ═══════════════════════════════════════════
import { Weather }         from "./weather.js";
import { Alarms, normaliseTime } from "./alarms.js";
import { Storage }         from "./storage.js";
import { CONFIG }          from "./config.js";
import { webSearch, deepResearch, smartSearch, formatResults, businessResearch, inspectUrl, formatUrlResult } from "./websearch.js";
import { saveGoals, getTodayGoals, completeGoal, getStats, formatGoalsForAI } from "./goals.js";
import { parseGithubUrl, getRepoTree, getFile, getFiles, searchRepos, pickRelevantFiles, formatRepoSummary, formatSearchResults, createRepo, scaffoldRepo } from "./github.js";

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


  // ── Create GitHub repository ───────────────────────────────────────────
  const createRepoMatch = text.match(/create\s+(a\s+)?(?:new\s+)?(?:github\s+)?(?:repo|repository)\s+(?:called|named|for)?\s*["']?([\w._-]+)["']?(?:\s+(.+))?/i);
  if (createRepoMatch) {
    const repoName = createRepoMatch[2].trim();
    const repoDesc = createRepoMatch[3]?.trim() || "";
    _chatAdd?.(`Creating GitHub repo "${repoName}"...`, "bot");
    try {
      const result = await createRepo(repoName, repoDesc);
      _searchSend?.(`I just created a GitHub repository. Here are the details:\n\nName: ${result.full_name}\nURL: ${result.url}\nClone: ${result.clone_url}\n\nTell Joel the repo is live and share the URL. If he gave you a structure to scaffold, ask if he wants you to push the initial files now.`);
    } catch(e) {
      _searchSend?.(`I tried to create the repo "${repoName}" but hit an error: ${e.message}. Tell Joel what went wrong.`);
    }
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
