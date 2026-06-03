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