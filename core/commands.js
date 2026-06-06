// ═══════════════════════════════════════════
// core/commands.js — Local command parser
// Returns: string (reply) | null (silent) | false (→ API)
// ═══════════════════════════════════════════
import { Weather }       from "./weather.js";
import { Alarms, normaliseTime } from "./alarms.js";
import { Storage }       from "./storage.js";
import { CONFIG }        from "./config.js";

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
  { rx:/open\s+github/i,             url:"https://github.com" },
  { rx:/search\s+(?:for\s+)?(.+)/i,  fn:m=>`https://google.com/search?q=${encodeURIComponent(m[1])}` },
  { rx:/open\s+(https?:\/\/\S+)/i,   fn:m=>m[1] },
  { rx:/open\s+(\w[\w.-]+\.\w{2,})/i,fn:m=>`https://${m[1]}` },
];

export function getTime() {
  return new Date().toLocaleTimeString("en-NG",{hour:"2-digit",minute:"2-digit",hour12:true});
}
export function getDate() {
  return new Date().toLocaleDateString("en-NG",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
}

// notepad reference injected at init to avoid circular imports
let _notepad = null;
export function setNotepad(n) { _notepad = n; }

// speakFn injected at init
let _speak = null;
export function setSpeakFn(fn) { _speak = fn; }

export async function parseCommand(text) {
  const t = text.toLowerCase().trim();

  if (/what('?s| is) the time|time now|current time/i.test(t))
    return `It's ${getTime()}.`;

  if (/what('?s| is) (the )?date|what day/i.test(t))
    return `Today is ${getDate()}.`;

  if (/weather|forecast|temperature|how hot|how cold|rain|humidity/i.test(t))
    return `Weather in ${CONFIG.USER.city}: ${await Weather.get()}`;

  // Notepad
  if (/open\s+(notepad|note|notes)/i.test(t))                              { _notepad?.open(false); return null; }
  if (/take\s+(a\s+)?note|write\s+(this\s+)?down|start\s+note/i.test(t))  { _notepad?.open(true);  return null; }
  if (/close\s+(notepad|note)/i.test(t))                                   { _notepad?.close();     return null; }
  if (/clear\s+(notepad|note|notes)/i.test(t))                             { _notepad?.clear();     return null; }

  // Brain export
  if (/export\s+(brain|memory|backup)/i.test(t)) return Storage.exportBrain();

  // Alarm set
  const alarmSet = text.match(/set\s+(an?\s+)?alarm\s+(?:for\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(.*)?/i);
  if (alarmSet) {
    const timeStr = normaliseTime(alarmSet[2]);
    const label   = alarmSet[3]?.replace(/^[^a-z0-9]+/i,"").trim() || alarmSet[2].trim();
    return Alarms.set(timeStr, label, _speak);
  }

  // Alarm list
  if (/list\s+alarms?|my\s+alarms?|show\s+alarms?/i.test(t))
    return Alarms.list();

  // Alarm delete
  const alarmDel = text.match(/(?:delete|cancel|remove)\s+alarm(?:\s+for)?\s+(.+)/i);
  if (alarmDel) return Alarms.del(alarmDel[1]);

  // Open sites
  for (const p of SITES) {
    const m = text.match(p.rx);
    if (m) {
      window.open(p.fn ? p.fn(m) : p.url, "_blank");
      return `Pulling up ${m[1] || "that"} now.`;
    }
  }

  return false; // pass to API
}

// ── Vision commands (injected at boot) ───
let _vision = null;
export function setVision(v) { _vision = v; }

// Call this AFTER the existing parseCommand function
// by chaining in app.js — see app.js for wiring
export async function parseVisionCommand(text) {
  const t = text.toLowerCase().trim();

  // Camera
  if (/open\s+camera|start\s+camera|turn\s+on\s+camera/i.test(t))  { _vision?.Camera.start();       return null; }
  if (/close\s+camera|stop\s+camera|turn\s+off\s+camera/i.test(t)) { _vision?.Camera.stop();        return null; }

  // Screen
  if (/share\s+screen|open\s+screen|see\s+(my\s+)?screen/i.test(t))         { _vision?.ScreenVision.start(); return null; }
  if (/stop\s+(sharing\s+)?screen|close\s+screen/i.test(t))                  { _vision?.ScreenVision.stop();  return null; }

  // YOLO
  if (/start\s+yolo|object\s+detect|detect\s+objects|eyes?\s+on/i.test(t))  { _vision?.YOLO.start();         return null; }
  if (/stop\s+yolo|eyes?\s+off|stop\s+detect/i.test(t))                      { _vision?.YOLO.stop();          return null; }

  // Look / describe
  if (/what\s+(do\s+you\s+)?(can\s+you\s+)?see|look\s+at\s+(the\s+)?(screen|camera)/i.test(t)) {
    // Try screen first, then camera
    if (_vision?.ScreenVision._video) { _vision.ScreenVision.look(text); return null; }
    if (_vision?.Camera._video)       { _vision.Camera.look(text);       return null; }
    return "I don't have eyes open yet. Say 'open camera' or 'share screen' first.";
  }

  // "What's on my screen?" / "Who is that?" etc
  if (/what('?s|\s+is)\s+(on\s+)?(my\s+)?screen|read\s+(my\s+)?screen/i.test(t)) {
    _vision?.ScreenVision.look(text); return null;
  }
  if (/who\s+is\s+(that|this)|what\s+am\s+i\s+looking\s+at/i.test(t)) {
    _vision?.Camera.look(text); return null;
  }

  // Face recognition
  if (/learn\s+my\s+face|remember\s+my\s+face|who\s+am\s+i/i.test(t)) {
    _vision?.Camera.learnMyFace?.();
    return null;
  }

  // Self-knowledge — Flow describes himself
  if (/what\s+(are|can)\s+you|your\s+capabilities|what\s+do\s+you\s+do|who\s+are\s+you|describe\s+yourself/i.test(t)) {
    return false; // pass to AI — identity is already in system prompt
  }

  return false; // not a vision command
}

// ════════════════════════════════════════════
// Search + Goals commands (appended at boot)
// ════════════════════════════════════════════
import { webSearch, deepResearch, formatResults, businessResearch } from "./websearch.js";
import { saveGoals, getTodayGoals, completeGoal, getStats, formatGoalsForAI } from "./goals.js";

let _searchSend = null;
let _chatAdd    = null;
export function setSearchHandlers(sendFn, chatFn) {
  _searchSend = sendFn;
  _chatAdd    = chatFn;
}

export async function parseSearchGoalCommand(text) {
  const t = text.toLowerCase().trim();

  // ── Web search ──────────────────────────
  if (/^(search|look up|google|find|what is|who is|latest|news about)\s+(.+)/i.test(t)) {
    const query = text.replace(/^(search|look up|google|find)\s+/i,"").trim();
    _chatAdd?.(`Searching for "${query}"...`, "bot");
    const results = await webSearch(query, "quick");
    if (!results?.length) return `Couldn't find anything on "${query}" right now.`;
    const context = formatResults(results, query);
    // Pass to AI with search context
    _searchSend?.(`I searched the web for "${query}". Here are the results:\n\n${context}\n\nBased on this, give me a clear useful answer.`);
    return null; // AI handles the reply
  }

  // ── Deep research ────────────────────────
  if (/research|deep\s+dive|investigate|tell me everything about/i.test(t)) {
    const query = text.replace(/research|deep\s*dive|investigate|tell me everything about/gi,"").trim();
    _chatAdd?.(`Researching "${query}"...`, "bot");
    await deepResearch(query, _searchSend);
    return null;
  }

  // ── Business growth research ─────────────
  if (/grow(th)?\s+(my\s+)?business|joelflowstack|business\s+tips|how\s+to\s+grow/i.test(t)) {
    _chatAdd?.("Researching growth strategies for Joelflowstack...", "bot");
    await businessResearch(_searchSend);
    return null;
  }

  // ── Goals: show today's ──────────────────
  if (/my\s+goals|today'?s?\s+goals|show\s+goals|goals\s+today/i.test(t)) {
    const entry = getTodayGoals();
    return entry ? formatGoalsForAI(entry) : "You haven't uploaded your goals today yet. Send them to me as a message or upload a file.";
  }

  // ── Goals: mark complete ─────────────────
  if (/done\s+(with\s+)?goal\s*#?(\d+)|completed?\s+goal\s*#?(\d+)|mark\s+goal\s*#?(\d+)/i.test(t)) {
    const match = t.match(/(\d+)/);
    if (match) {
      const idx   = parseInt(match[1]) - 1;
      const entry = completeGoal(idx);
      if (!entry) return "No goals uploaded yet today.";
      return formatGoalsForAI(entry);
    }
  }

  // ── Goals: stats ─────────────────────────
  if (/goal\s+stats|my\s+stats|streak|how\s+many\s+goals/i.test(t)) {
    const s = getStats();
    return `Goals stats: ${s.currentStreak} day streak, ${s.totalDaysUploaded} days uploaded, ${s.totalGoalsCompleted} goals completed total.`;
  }

  return false; // not a search/goal command
}
