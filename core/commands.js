// ═══════════════════════════════════════════
// core/commands.js — ALL imports at top
// ═══════════════════════════════════════════
import { Weather }         from "./weather.js";
import { Alarms, normaliseTime } from "./alarms.js";
import { Storage }         from "./storage.js";
import { CONFIG }          from "./config.js";
import { webSearch, deepResearch, smartSearch, formatResults, businessResearch, inspectUrl } from "./websearch.js";
import { saveGoals, getTodayGoals, completeGoal, getStats, formatGoalsForAI } from "./goals.js";
import { parseGithubUrl, getRepoTree, getFile, getFiles, searchRepos, pickRelevantFiles, formatRepoSummary, formatSearchResults, createRepo, createOrUpdateFile, scaffoldRepo, createBranch, deleteFile, createPR, listBranches } from "./github.js";
import { parseAgentCommand, activateAgent, deactivateAgent, getActiveAgent, AGENTS } from "./agent.js";

// Sanitize file content before pushing — removes control chars that break JSON
function _sanitizeContent(str) {
  if (typeof str !== "string") return String(str || "");
  let s = "";
  const input = str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // Keep tab(9), newline(10), and all printable chars(32+)
    if (code === 9 || code === 10 || code >= 32) s += input[i];
  }
  return s;
}


// ── Injected refs (set at boot to avoid circular imports) ──
let _notepad = null;
let _speak   = null;
let _vision  = null;
let _screenControl = null;
let _searchSend  = null;
let _chatAdd     = null;
let _getHistory  = null;

export function setNotepad(n)          { _notepad       = n; }
export function setSpeakFn(fn)         { _speak         = fn; }
export function setVision(v)           { _vision        = v; }
export function setScreenControl(sc)   { _screenControl = sc; }
export function setSearchHandlers(s,c) { _searchSend = s; _chatAdd = c; }
export function setHistoryFn(fn)       { _getHistory = fn; }

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

  if (/open\s+camera|start\s+camera|turn\s+on\s+camera/i.test(t))          { _vision?.Camera.start();         return null; }
  if (/close\s+camera|stop\s+camera|turn\s+off\s+camera/i.test(t))         { _vision?.Camera.stop();          return null; }
  if (/share\s+screen|open\s+screen|see\s+my\s+screen/i.test(t))           { _vision?.ScreenVision.start();   return null; }
  if (/stop\s+screen|close\s+screen|stop\s+sharing/i.test(t))              { _vision?.ScreenVision.stop();    return null; }
  if (/start\s+yolo|object\s+detect|detect\s+objects|eyes?\s+on/i.test(t)) { _vision?.YOLO.start();           return null; }
  if (/stop\s+yolo|eyes?\s+off|stop\s+detect/i.test(t))                    { _vision?.YOLO.stop();            return null; }
  if (/learn\s+my\s+face|remember\s+my\s+face/i.test(t))                   { _vision?.Camera.learnMyFace?.(); return null; }

  // ── Gesture control ──────────────────────────────────────────────────────
  if (/start\s+gesture|gesture\s+(?:control|mode)|hand\s+control|finger\s+control/i.test(t)) {
    const vid = _vision?.Camera._video;
    _vision?.Gesture?.start(vid);
    return null;
  }
  if (/stop\s+gesture|gesture\s+off|stop\s+hand\s+control/i.test(t)) {
    _vision?.Gesture?.stop();
    return null;
  }

  if (/what\s+(?:do\s+you\s+)?see|look\s+at\s+(?:the\s+)?(?:screen|camera)/i.test(t)) {
    if (_vision?.ScreenVision._video) { _vision.ScreenVision.look(text); return null; }
    if (_vision?.Camera._video)       { _vision.Camera.look(text);       return null; }
    return "No camera or screen open yet. Say 'open camera' or 'share screen' first.";
  }
  if (/what.s on my screen|read.*screen/i.test(t)) { _vision?.ScreenVision.look(text); return null; }
  if (/who is that|who am i/i.test(t))              { _vision?.Camera.look(text);       return null; }

  // ── Screen control (scroll/click/type/read) ────────────────────────────
  // Only attempt when screen is actively shared — avoids false positives on
  // casual messages containing words like "scroll" or "click".
  if (_screenControl && _vision?.ScreenVision._video) {
    const handled = await _screenControl.parseScreenControl(text);
    if (handled) return null;
  }

  return false;
}

// ── Search + Goals commands ────────────────
export async function parseSearchGoalCommand(text) {
  const t = text.toLowerCase().trim();

  // ── Push structure from conversation history ───────────────────
  // ── Repo-aware development ────────────────────────────────────────────
  // "develop the flowpay app", "add a login page to flowpay",
  // "continue building flowpay", "what should i add next to flowpay"
  // Requires an explicit repo signal: a project-like word (pay/app/bot/api/web/site/shop/store/flow)
  // followed by app/repo/project, OR the word "repo"/"repository" itself, OR owner/repo format.
  // This prevents generic phrases like "bot development" or "web development" from matching.
  const _devRx = /(?:develop|continue|build|add|improve|update|work on|next (?:step|feature)).{0,30}\b([a-z][a-z0-9_-]*(?:pay|app|bot|api|web|site|shop|store|flow)[a-z0-9_-]*)\b\s*(?:app|repo|project|site)?\b|(?:develop|continue|build|add|improve|update|work on).{0,30}\b(?:repo|repository)\b/i;
  const _devExclude = /(?:create|push|scaffold|delete|branch|pr|pull.?request)/i;
  if (_devRx.test(t) && !_devExclude.test(t)) {
    // Extract repo name
    const _dm = t.match(/([a-z][a-z0-9_-]*(?:pay|app|bot|api|web|site|shop|store|flow|pay)[a-z0-9_-]*)(?:\s+(?:app|repo|project|site))?/i)
             || t.match(/(?:on|for|to)\s+(?:the\s+)?([a-z][a-z0-9_.-]{2,})(?:\s+(?:app|repo|project))?/i);
    const _drepo = _dm ? _dm[1].toLowerCase() : "";
    if (_drepo && !["develop","continue","build","add","improve","update","work","next","step","feature","the","for","on","to","what","should"].includes(_drepo)) {
      await _repoAwareDevelop("Joel44118", _drepo, text, _chatAdd, _searchSend, _getHistory);
      return null;
    }
  }

  // ── Phase 5: GitHub write operations (branch/delete/PR/branches) ───────

  // ── List branches ──
  if (/\b(list|show|what).{0,20}branches?.{0,20}\b([a-z][a-z0-9_.-]{2,})\b/i.test(t) || /\bbranches?\s+(of|in|for)\s+([a-z][a-z0-9_.-]{2,})/i.test(t)) {
    const _bm = t.match(/\b(?:of|in|for|repo)?\s*([a-z][a-z0-9_.-]{3,})\b/i);
    const _bo = "Joel44118", _br = _bm ? _bm[1] : "";
    if (_br && !["list","show","what","the","my","branches","branch"].includes(_br)) {
      try {
        const _bd = await listBranches(_bo, _br);
        _chatAdd?.(_br + " branches: " + _bd.branches.join(", "), "bot");
      } catch (_e) { _chatAdd?.("\u274c " + _e.message, "bot"); }
      return null;
    }
  }

  // ── Create branch ──
  if (/(?:create|make|add)\s+(a\s+)?(?:new\s+)?branch/i.test(t)) {
    const _nm = t.match(/branch\s+(?:called|named)?\s*["']?([a-z][a-z0-9_/-]{1,39})["']?/i);
    const _rm = t.match(/(?:in|on|for|repo)?\s+(?:the\s+)?([a-z][a-z0-9_.-]{2,})\s+repo/i) ||
               t.match(/(?:in|on|for)\s+(?:the\s+)?([a-z][a-z0-9_.-]{2,})/i);
    const _fm = t.match(/(?:from|off)\s+([a-z][a-z0-9_/-]{1,39})/i);
    const _bname = _nm ? _nm[1] : "";
    const _brepo = _rm ? _rm[1] : "";
    const _bfrom = _fm ? _fm[1] : "main";
    if (_bname && _brepo && !["create","make","add","branch","new","the","for"].includes(_brepo)) {
      _chatAdd?.("Creating branch \"" + _bname + "\" in " + _brepo + "...", "bot");
      try {
        const _bd = await createBranch("Joel44118", _brepo, _bname, _bfrom);
        _chatAdd?.("\u2705 Branch \"" + _bname + "\" created.\n\uD83D\uDD17 " + _bd.url, "bot");
      } catch (_e) { _chatAdd?.("\u274c " + _e.message, "bot"); }
      return null;
    }
  }

  // ── Delete file ──
  if (/(?:delete|remove)\s+.{0,40}\.(js|ts|css|html|md|json|py|txt|env)/i.test(t)) {
    const _pm = t.match(/(?:delete|remove)\s+(?:the\s+)?(?:file\s+)?([\w./\-]+\.\w+)/i);
    const _rm = t.match(/(?:from|in)\s+(?:the\s+)?([a-z][a-z0-9_.-]{2,})(?:\s+repo)?/i);
    const _fp = _pm ? _pm[1] : "", _fr = _rm ? _rm[1] : "";
    if (_fp && _fr && !["from","the","in"].includes(_fr)) {
      _chatAdd?.("Deleting " + _fp + " from " + _fr + "...", "bot");
      try {
        await deleteFile("Joel44118", _fr, _fp, "delete " + _fp);
        _chatAdd?.("\u2705 Deleted: " + _fp + " from Joel44118/" + _fr, "bot");
      } catch (_e) { _chatAdd?.("\u274c " + _e.message, "bot"); }
      return null;
    }
  }

  // ── Create PR ──
  if (/(?:create|open|make)\s+(a\s+)?(?:pull.?request|pr)/i.test(t)) {
    const _hm = t.match(/(?:from|merge)\s+([a-z][a-z0-9_/-]{1,39})\s+(?:to|into)/i);
    const _bm = t.match(/(?:to|into)\s+([a-z][a-z0-9_/-]{1,39})/i);
    const _rm = t.match(/(?:in|on|for)\s+(?:the\s+)?([a-z][a-z0-9_.-]{2,})(?:\s+repo)?/i);
    const _tm = t.match(/(?:title|called|named)\s+["']?([^"']+?)["']?(?:\s|$)/i);
    const _head = _hm ? _hm[1] : "dev";
    const _base = _bm ? _bm[1] : "main";
    const _prepo = _rm ? _rm[1] : "";
    const _title = _tm ? _tm[1] : "Merge " + _head + " into " + _base;
    if (_prepo && !["create","open","make","the","for","in"].includes(_prepo)) {
      _chatAdd?.("Creating PR: " + _head + " \u2192 " + _base + " in " + _prepo + "...", "bot");
      try {
        const _pd = await createPR("Joel44118", _prepo, _title, _head, _base);
        _chatAdd?.("\u2705 PR #" + _pd.number + " created.\n\uD83D\uDD17 " + _pd.url, "bot");
      } catch (_e) { _chatAdd?.("\u274c " + _e.message, "bot"); }
      return null;
    }
  }

  // ── Targeted push: "push those files", "push what you just wrote" ────────
  // Catches when Joel wants to push exactly what Flow just generated
  const _targetedPushRx = /push\s+(?:those|these|the(?:se)?\s+(?:\d+\s+)?|what\s+you|them|the\s+code|the\s+files?\s+(?:you|above|below)|(?:all\s+)?(?:\d+\s+)?files?\s+(?:you|above)|that\s+code)/i;
  if (_targetedPushRx.test(t)) {
    // Extract repo from the message
    let _to = "Joel44118", _tr = "";
    const _tfull = text.match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
    const _tbr   = t.match(/(\b(?!github\b|the\b|my\b|a\b|to\b|it\b|those\b|these\b|them\b|push\b|files?\b)\w{3,})\s+repo\b/i);
    const _tap   = t.match(/(?:to|into|in)\s+(?:the\s+|a\s+)?(?:repo\s+)?(?:github\s+)?([a-z][a-z0-9_.-]{2,})(?:\s+repo)?/i);
    const _tpj   = t.match(/\b([a-z][a-z0-9_-]*(?:pay|app|bot|api|web|site|shop|store|flow)[a-z0-9_-]*)\b/i);
    if (_tfull)                                                                    { _to = _tfull[1]; _tr = _tfull[2]; }
    else if (_tbr && !["those","these","the","push","files"].includes(_tbr[1]))   { _tr = _tbr[1]; }
    else if (_tap && !["github","those","these","push","files"].includes(_tap[1])){ _tr = _tap[1]; }
    else if (_tpj)                                                                 { _tr = _tpj[1]; }

    if (_tr) {
      // Get the last AI message from history and extract code blocks from it
      const _hist = (_getHistory?.() || []);
      const _lastAI = [..._hist].reverse().find(m => m.role === "assistant");
      if (!_lastAI || !_lastAI.content) {
        _chatAdd?.("I don't have the files in memory yet. Tell me what to build first, then say push those to " + _tr + ".", "bot");
        return null;
      }

      // Extract code blocks from AI message
      // Supports multiple filename patterns:
      // 1. ```css\n/* styles.css */  (comment inside block)
      // 2. ```css\n// styles.css     (comment inside block)
      // 3. **styles.css**\n```css     (bold before block)
      // 4. `styles.css`\n```css       (backtick before block)
      // 5. styles.css\n```css         (plain text before block)
      const _codeBlockRx = /```([\w]*)\n([\s\S]*?)```/g;
      const _fileNameRx  = /([\w./\-]+\.(?:js|ts|jsx|tsx|css|html|json|md|py|txt|env|yml|yaml|sh))/i;
      const _files = [];
      let _cbm;
      while ((_cbm = _codeBlockRx.exec(_lastAI.content)) !== null) {
        let _code = _cbm[2]?.trim();
        if (!_code) continue;
        let _path = "";

        // Check first line of code block for filename in comment
        const _firstLine = _code.split("\n")[0];
        const _firstLineM = _firstLine.match(/(?:\/\/|\*|#|<!--)\s*([\w./\-]+\.(?:js|ts|jsx|tsx|css|html|json|md|py|txt|env|yml|yaml|sh))/i);
        if (_firstLineM) {
          _path = _firstLineM[1];
          _code = _code.slice(_firstLine.length).trim(); // strip the comment line
        }

        // If no inline comment, look in text BEFORE the block (up to 300 chars)
        if (!_path) {
          const _before = _lastAI.content.slice(Math.max(0, _cbm.index - 300), _cbm.index);
          // Match last filename mention before the block
          const _beforeMatches = [..._before.matchAll(/([\w./\-]+\.(?:js|ts|jsx|tsx|css|html|json|md|py|txt|env|yml|yaml|sh))/gi)];
          if (_beforeMatches.length) _path = _beforeMatches[_beforeMatches.length - 1][1];
        }

        // Also check: user message might specify the filename (e.g. 'push styles.css')
        if (!_path) {
          const _userFileM = text.match(_fileNameRx);
          if (_userFileM) _path = _userFileM[1];
        }

        // Last resort: use lang hint or numbered fallback
        if (!_path) {
          const _lang = _cbm[1];
          const _ext  = _lang === "javascript" || _lang === "js" ? "js"
                      : _lang === "css"        ? "css"
                      : _lang === "html"       ? "html"
                      : _lang === "python"     ? "py"
                      : _lang === "typescript" ? "ts"
                      : _lang || "js";
          _path = "file_" + (_files.length + 1) + "." + _ext;
        }

        _files.push({ path: _path, content: _code });
      }

      if (!_files.length) {
        _chatAdd?.("I couldn't find code blocks in my last message. Show me the code first, then I'll push it.", "bot");
        return null;
      }

      _chatAdd?.("Pushing " + _files.length + " file" + (_files.length !== 1 ? "s" : "") + " to " + _to + "/" + _tr + "...", "bot");
      const _res = [];
      for (const _f of _files) {
        try {
          await createOrUpdateFile(_to, _tr, _f.path, _sanitizeContent(_f.content), "update " + _f.path);
          _res.push({ path: _f.path, ok: true });
          _chatAdd?.("\u2705 " + _f.path, "bot");
        } catch (_pe) {
          _res.push({ path: _f.path, ok: false });
          _chatAdd?.("\u274c " + _f.path + " \u2014 " + _pe.message, "bot");
        }
      }
      const _tok = _res.filter(r => r.ok).length;
      _chatAdd?.("\n" + _tok + " file" + (_tok !== 1 ? "s" : "") + " pushed.\n\uD83D\uDD17 https://github.com/" + _to + "/" + _tr, "bot");
      return null;
    }
  }

  // ── Repo structure: create OR push ─────────────────────────────────
  // "create a structure for flowpay", "push it to flowpay repo", "scaffold myapp"
  const _structureRx = /(?:create|build|make|scaffold|push|commit|upload)\s+.{0,60}(?:structure|files?|code|scaffold|it|them|everything)?.{0,30}(?:repo|github|[a-z]{3,})/i;
  const _repoOnlyRx  = /(?:push|scaffold|commit)\s+(?:it|that|them|everything|all|this)\s+(?:to|into)\s+/i;
  const _excludeRx   = /create\s+(?:a\s+)?(?:new\s+)?(?:github\s+)?repo\b(?!.*structure)/i;

  if ((_structureRx.test(t) || _repoOnlyRx.test(t)) && !_excludeRx.test(t)) {
    let owner = "Joel44118", repo = "";
    const _full       = text.match(/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
    const _beforeRepo = t.match(/(\b(?!github\b|the\b|my\b|a\b|to\b|it\b)\w{3,})\s+repo\b/i);
    const _afterPrep  = t.match(/(?:for|into|to|in)\s+(?:the\s+|a\s+|he\s+)?(?:repo\s+)?(?:github\s+)?([a-z][a-z0-9_.-]{2,})(?:\s+repo)?/i);
    const _anyProject = t.match(/\b([a-z][a-z0-9_-]*(?:pay|app|bot|api|web|site|shop|store|flow)[a-z0-9_-]*)\b/i);

    if (_full)                                                                    { owner = _full[1];       repo = _full[2]; }
    else if (_beforeRepo && !["the","its","our","github"].includes(_beforeRepo[1])) { repo = _beforeRepo[1]; }
    else if (_afterPrep  && !["github","the","that","this","it","push","create","make","build","scaffold"].includes(_afterPrep[1])) { repo = _afterPrep[1]; }
    else if (_anyProject)                                                         { repo = _anyProject[1];  }

    if (!repo) return false;

    const projectDesc = text
      .replace(/create\s+(a\s+)?(?:folder\s+|file\s+|project\s+|repo\s+)?structure\s+(for\s+)?/i, "")
      .replace(/(?:push|scaffold|commit|upload).{0,30}(?:to|into).{0,30}/i, "")
      .replace(new RegExp(repo, "gi"), "").replace(/Joel44118/gi, "").trim() || repo;

    _chatAdd?.("Creating structure for " + owner + "/" + repo + "...", "bot");

    const _prompt =
      "Generate a complete starter project for: " + projectDesc + "\n" +
      "Target repo: " + owner + "/" + repo + "\n\n" +
      "IMPORTANT: Respond ONLY with a raw JSON array. No text, no markdown, no backticks.\n" +
      'Format: [{"path":"relative/path/file.ext","content":"complete file content"}]\n' +
      "Rules: real working content in every file, no TODOs, max 10 files, relative paths only.";

    try {
      const _res = await fetch("/api/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages: [{ role: "user", content: _prompt }] }),
      });
      if (!_res.ok) throw new Error("AI request failed: " + _res.status);
      const _aiData = await _res.json();
      let _raw = _aiData.reply || _aiData.content ||
                 (_aiData.choices && _aiData.choices[0] && _aiData.choices[0].message && _aiData.choices[0].message.content) || "";
      _raw = _raw.replace(/^```json\s*/im, "").replace(/^```\s*/im, "").replace(/\s*```\s*$/im, "").trim();
      const _arr = _raw.match(/\[[\s\S]*\]/);
      if (!_arr) throw new Error("AI did not return JSON. Got: " + _raw.slice(0, 100));
      const _files = JSON.parse(_arr[0]);
      if (!Array.isArray(_files) || !_files.length) throw new Error("Empty file list.");

      _chatAdd?.("Pushing " + _files.length + " files to " + owner + "/" + repo + "...", "bot");
      const _results = [];
      for (const _f of _files) {
        if (!_f.path || _f.content === undefined) continue;
        try {
          await createOrUpdateFile(owner, repo, _f.path, _sanitizeContent(_f.content), "scaffold: " + _f.path);
          _results.push({ path: _f.path, ok: true });
          _chatAdd?.("\u2705 " + _f.path, "bot");
        } catch (_pe) {
          _results.push({ path: _f.path, ok: false });
          _chatAdd?.("\u274c " + _f.path + " \u2014 " + _pe.message, "bot");
        }
      }
      const _ok   = _results.filter(r => r.ok).length;
      const _fail = _results.filter(r => !r.ok).length;
      _chatAdd?.(
        "\n" + _ok + " file" + (_ok !== 1 ? "s" : "") + " pushed" + (_fail ? ", " + _fail + " failed" : "") + ".\n" +
        "\uD83D\uDD17 https://github.com/" + owner + "/" + repo,
        "bot"
      );
    } catch (_e) {
      _chatAdd?.("\u274c " + _e.message, "bot");
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
  const _searchGreetings = /^(what's\s+up|what's\s+good|what's\s+new|how's\s+it|sup\b|hey\b|hi\b|hello\b|good\s+(?:morning|evening|afternoon|night)|how\s+are\s+you|yo\b)/i;
  const isSearch = /^(search|look up|find|tell me about|latest|recent|news on|news about|update on)/i.test(t)
    && !/github\.com/i.test(t)
    && !_searchGreetings.test(t);

  if (isSearch) {
    await smartSearch(text, _searchSend, _chatAdd);
    return null;
  }

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

  // ── Direct GitHub URL pasted in conversation (e.g. "explain github.com/x/y") ──
  const ghUrl = parseGithubUrl(text);
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
      const toFetch = pickRelevantFiles(tree.files, intent, isDeep ? 5 : 3, 8000);

      _chatAdd?.(`Fetching ${toFetch.length} of ${tree.files.length} files...`, "bot");
      const fetched = await getFiles(owner, repo, toFetch.map(f => f.path));
      let summary = formatRepoSummary(tree, fetched.files, intent);
      if (summary.length > 5500) summary = summary.slice(0, 5500) + "\n\n[truncated]";

      const aiPrompt = isDeep
        ? `Analyse this GitHub repo: what it does, code structure, tech stack, key decisions.\n\n${summary}`
        : `Briefly summarise this repo: what it does and its key files.\n\n${summary}`;
      _searchSend?.(aiPrompt);
    } catch(e) { _chatAdd?.(`GitHub fetch failed: ${e.message}`, "bot"); }
    return null;
  }

  // ── URL inspection ─────────────────────────────────────────────────────
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    const url  = urlMatch[0];
    // inspectUrl(url, sendToAI, chatAdd) handles the full lifecycle —
    // fetches the URL, formats it, calls sendToAI with the result.
    // commands.js was previously calling it as if it returned data,
    // which meant sendToAI was receiving the boolean `deep` as its
    // second argument and being ignored entirely → "sendToAI is not a function"
    await inspectUrl(url, _searchSend, _chatAdd);
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

// ═══════════════════════════════════════════════════════════════
// Repo-aware development — reads repo, shows progress, generates next code
// ═══════════════════════════════════════════════════════════════
async function _repoAwareDevelop(owner, repo, userRequest, chatAdd, searchSend, getHistory) {
  chatAdd?.("\uD83D\uDD0D Scanning " + owner + "/" + repo + "...", "bot");

  // 1. Get file tree
  let tree;
  try {
    tree = await getRepoTree(owner, repo);
  } catch (e) {
    chatAdd?.("\u274c Couldn't read repo: " + e.message, "bot");
    return;
  }

  const files = tree.files || [];
  if (!files.length) {
    chatAdd?.("Repo is empty. Tell me what to build and I'll create the structure.", "bot");
    return;
  }

  // 2. Show live analysis progress — read key files one by one
  const keyFiles = files
    .filter(f => /\.(html|css|js|ts|json|md|py|jsx|tsx)$/i.test(f.path))
    .slice(0, 6); // max 6 files to stay within token limits

  const fileContents = [];
  for (const f of keyFiles) {
    chatAdd?.("\uD83D\uDCC4 Analysing " + f.path + "...", "bot");
    try {
      const fetched = await getFile(owner, repo, f.path);
      // Cap each file at 800 chars to stay within limits
      const preview = (fetched.content || "").slice(0, 800);
      fileContents.push({ path: f.path, preview });
    } catch (_) {
      fileContents.push({ path: f.path, preview: "[could not read]" });
    }
  }

  chatAdd?.("\uD83E\uDDE0 Thinking about what to develop next...", "bot");

  // 3. Build a focused prompt — current state + what Joel wants
  const repoSummary = fileContents
    .map(f => "FILE: " + f.path + "\n" + f.preview)
    .join("\n\n---\n\n");

  const allPaths = files.map(f => f.path).join(", ");

  const devPrompt =
    "You are a senior developer working on the " + owner + "/" + repo + " project.\n" +
    "Joel's request: \"" + userRequest + "\"\n\n" +
    "ALL FILES IN REPO:\n" + allPaths + "\n\n" +
    "KEY FILE CONTENTS:\n" + repoSummary + "\n\n" +
    "Based on what exists, write the NEXT logical code addition or improvement.\n" +
    "Rules:\n" +
    "1. Only write code that builds on what already exists\n" +
    "2. Start every code block with a comment on line 1: // filename.ext\n" +
    "3. Write complete working code — no placeholders\n" +
    "4. If you spot a bug or problem in existing code, say so and fix it\n" +
    "5. Keep code blocks focused — one file per block\n" +
    "6. After the code, explain in 1-2 sentences what changed and why";

  // 4. Send to AI
  try {
    const res = await fetch("/api/chat", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ messages: [{ role: "user", content: devPrompt }] }),
    });
    if (!res.ok) throw new Error("AI error " + res.status);
    const data = await res.json();
    const reply = data.reply || data.content ||
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    if (!reply) throw new Error("Empty response from AI");
    // Send reply to chat as a normal AI response (will render code blocks)
    searchSend?.(reply);
  } catch (e) {
    chatAdd?.("\u274c Development step failed: " + e.message, "bot");
  }
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
        await createOrUpdateFile(owner, repo, f.path, _sanitizeContent(f.content), `scaffold: add ${f.path}`);
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
  content = _sanitizeContent(content);
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
