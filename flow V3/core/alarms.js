// ═══════════════════════════════════════════
// core/alarms.js
// ═══════════════════════════════════════════
import { Storage } from "./storage.js";

let alarms = Storage.get("alarms", []);

function save()  { Storage.set("alarms", alarms); }

function updateUI() {
  const el = document.getElementById("alarm-list");
  if (!el) return;
  el.innerHTML = alarms.length
    ? alarms.map(a => `<div class="alarm-item">⏰ ${a.label}</div>`).join("")
    : `<div class="alarm-item dim">No alarms</div>`;
}

function schedule(alarm, speakFn) {
  const [h, m] = alarm.time.split(":").map(Number);
  const t = new Date(); t.setHours(h, m, 0, 0);
  if (t <= new Date()) t.setDate(t.getDate() + 1);
  setTimeout(() => {
    speakFn(`Hey Boss, alarm — ${alarm.label}. Time's up.`);
    alarms = alarms.filter(a => a.id !== alarm.id);
    save(); updateUI();
  }, t - new Date());
}

export function normaliseTime(raw) {
  raw = raw.trim().toLowerCase();
  const ampm = raw.includes("pm") ? "pm" : raw.includes("am") ? "am" : null;
  raw = raw.replace(/am|pm/g,"").trim();
  let [h, m = "00"] = raw.split(":").map(Number);
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

export const Alarms = {
  init(speakFn) {
    alarms.forEach(a => schedule(a, speakFn));
    updateUI();
  },
  set(timeStr, label, speakFn) {
    const alarm = { id: Date.now(), time: timeStr, label: label || timeStr };
    alarms.push(alarm);
    save(); schedule(alarm, speakFn); updateUI();
    return `Alarm set for ${timeStr}${label ? " — "+label : ""}. Got you, Boss.`;
  },
  list() {
    return alarms.length
      ? "Alarms: " + alarms.map(a => a.label).join(", ") + "."
      : "No alarms set.";
  },
  del(label) {
    const before = alarms.length;
    alarms = alarms.filter(a => !a.label.toLowerCase().includes(label.toLowerCase()));
    save(); updateUI();
    return before > alarms.length ? `Alarm "${label}" deleted.` : `No alarm matching "${label}".`;
  },
};