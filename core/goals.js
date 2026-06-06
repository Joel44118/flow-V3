// ═══════════════════════════════════════════
// core/goals.js — Daily goals tracker
//
// - Joel uploads his goals (text/file) each morning
// - If no goals uploaded by 1PM Mon-Fri, Flow alerts
// - Goals persist per day in localStorage
// - Lifetime stats tracked
// ═══════════════════════════════════════════
import { Storage } from "./storage.js";

const DEADLINE_HOUR = 13; // 1PM

// ── Goal storage keys ────────────────────
function todayKey() {
  return "goals_" + new Date().toISOString().slice(0,10);
}
function statsKey() { return "goals_lifetime_stats"; }

// ── Save today's goals ───────────────────
export function saveGoals(goalsText) {
  const today = todayKey();
  const entry = {
    date:      today,
    goals:     goalsText,
    uploaded:  new Date().toISOString(),
    completed: [],
    noted:     false,
  };
  Storage.set(today, entry);
  _updateStats("uploaded");
  return entry;
}

// ── Get today's goals ────────────────────
export function getTodayGoals() {
  return Storage.get(todayKey(), null);
}

// ── Mark a goal complete ─────────────────
export function completeGoal(index) {
  const entry = getTodayGoals();
  if (!entry) return null;
  if (!entry.completed.includes(index)) entry.completed.push(index);
  Storage.set(todayKey(), entry);
  _updateStats("completed");
  return entry;
}

// ── Get lifetime stats ───────────────────
export function getStats() {
  return Storage.get(statsKey(), {
    totalDaysUploaded: 0,
    totalGoalsCompleted: 0,
    currentStreak: 0,
    lastUploadDate: null,
    missedDays: 0,
  });
}

function _updateStats(action) {
  const stats = getStats();
  const today = todayKey();
  if (action === "uploaded") {
    if (stats.lastUploadDate !== today) {
      stats.totalDaysUploaded++;
      // Check streak
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yKey = yesterday.toISOString().slice(0,10);
      stats.currentStreak = stats.lastUploadDate === yKey
        ? stats.currentStreak + 1
        : 1;
      stats.lastUploadDate = today;
    }
  }
  if (action === "completed") stats.totalGoalsCompleted++;
  Storage.set(statsKey(), stats);
}

// ── Deadline alert system ─────────────────
// Call this on boot — sets up the daily check
let _alertFired = false;
export function startGoalDeadlineWatcher(speakFn, chatFn) {
  _alertFired = false;

  function check() {
    const now  = new Date();
    const hour = now.getHours();
    const day  = now.getDay(); // 0=Sun, 6=Sat
    const isWeekday = day >= 1 && day <= 5;

    if (!isWeekday) return; // Mon-Fri only
    if (hour < DEADLINE_HOUR) return; // before 1PM
    if (_alertFired) return; // only alert once per day
    if (getTodayGoals()) return; // already uploaded

    // It's past 1PM on a weekday and no goals uploaded
    _alertFired = true;
    _updateStats("missed"); // (add missed to stats logic if needed)

    const msg = "Boss, it's past 1 and you haven't uploaded your goals for today. What's the plan?";
    chatFn?.(msg, "bot");
    speakFn?.(msg);
  }

  // Check immediately on boot
  check();

  // Then check every 5 minutes
  setInterval(check, 5 * 60 * 1000);

  // Reset alert flag at midnight
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 5) {
      _alertFired = false;
    }
  }, 60 * 1000);
}

// ── Format goals for display ─────────────
export function formatGoalsForAI(entry) {
  if (!entry) return "No goals uploaded today.";
  const lines  = entry.goals.split("\n").filter(l => l.trim());
  const done   = entry.completed;
  const list   = lines.map((g, i) => `${done.includes(i) ? "✅" : "⬜"} ${g.trim()}`).join("\n");
  const pct    = lines.length ? Math.round(done.length/lines.length*100) : 0;
  return `Today's goals (${pct}% complete):\n${list}`;
}

// ── Summary string for system prompt ─────
export function goalsSummary() {
  const entry = getTodayGoals();
  const stats = getStats();
  if (!entry) return `No goals uploaded today. ${stats.currentStreak} day streak, ${stats.totalGoalsCompleted} goals completed all time.`;
  const lines = entry.goals.split("\n").filter(l => l.trim());
  return `${formatGoalsForAI(entry)}\nStreak: ${stats.currentStreak} days | All-time: ${stats.totalGoalsCompleted} completed`;
}
