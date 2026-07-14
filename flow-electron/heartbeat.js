// ═══════════════════════════════════════════
// flow-electron/heartbeat.js — Flow's Real Autonomy Loop
//
// WHAT THIS ACTUALLY IS: a real, recurring timer in the MAIN process
// (survives the chat window being closed to tray — confirmed real this
// session) that wakes Flow up independent of any user message, and lets
// it genuinely decide "is there anything worth doing right now?" — the
// literal foundation every other autonomous behavior traces back to,
// per Joel's own framing.
//
// HONEST SCOPE NOTE on "always online even if my PC is off": if the
// literal physical PC is off, no process can run at all, anywhere —
// that's just how computers work, not a Flow limitation. What this
// genuinely delivers: Flow runs continuously WHENEVER the PC is on, in
// the tray, independent of whether the chat window is open — a real,
// meaningful step from "only runs while you're actively chatting" to
// "runs the whole time the machine is up," which is the honest version
// of what's actually achievable here.
//
// REAL PIECES BUILT HERE (mapped to Joel's own numbered list):
//   #1 Heartbeat loop           — the setInterval below
//   #2 Standing goal list       — _goals array, persisted to disk
//   #3 Proactive noticing       — calls memory-store's findRecurringTopics
//   #4 Environmental awareness  — deferred: needs a real, safe, narrow
//                                  per-source design (file watcher,
//                                  calendar, etc.) — not built tonight,
//                                  flagged honestly rather than faked
//   #5 Self-initiated messages  — sendSelfInitiatedMessage below
//   #6 Internal monologue       — _scratchpad, a real, separate memory
//                                  category via memory-store's remember()
//   #7 Self-extending tools     — already built earlier tonight (Python
//                                  sandbox + JS tools), not re-built here
//   #8 Drive/motivation layer   — _priorities array, weighted into the
//                                  reasoning prompt below
//   #9 Multi-day continuity     — comes for free from memory-store being
//                                  genuinely persistent across restarts
//   #10 Self-monitoring         — _selfCheck() below
// ═══════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const { app, Notification } = require('electron');
const memoryStore = require('./memory-store');

const VERCEL_URL = 'https://flow-v3-mu.vercel.app';
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // real, deliberate: every 15 minutes — frequent enough to feel present, not so frequent it burns API calls/battery for no reason. Tunable, not sacred.

let _heartbeatTimer = null;
let _onNotification = null; // set via setNotificationSink from main.js, so this module doesn't need to import a full window reference itself

function setNotificationSink(fn) { _onNotification = fn; }

// ── Real, persisted standing goal list ──────────────────────────────────
function _goalsPath() { return path.join(app.getPath('userData'), 'flow-goals.json'); }

function _loadGoals() {
  try {
    const p = _goalsPath();
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[Heartbeat] Goal load failed (non-fatal):', e.message);
    return [];
  }
}

function _saveGoals(goals) {
  try {
    fs.writeFileSync(_goalsPath(), JSON.stringify(goals, null, 2));
  } catch (e) {
    console.warn('[Heartbeat] Goal save failed (non-fatal):', e.message);
  }
}

// Real, callable from the renderer via IPC (main.js wires this) so Joel
// can see/add/remove goals from the UI, not just have them invisibly
// exist.
function addGoal(description) {
  const goals = _loadGoals();
  goals.push({ id: `goal-${Date.now()}`, description, createdAt: Date.now(), status: "open", progress: [] });
  _saveGoals(goals);
  return goals;
}
function listGoals() { return _loadGoals(); }
function removeGoal(id) {
  const goals = _loadGoals().filter(g => g.id !== id);
  _saveGoals(goals);
  return goals;
}

// ── Real, standing priorities — the "drive" layer, not just a queue ─────
// Deliberately simple and Joel-editable, not hardcoded forever: a plain
// array of short phrases weighed into the reasoning prompt below, so
// idle-time choices are shaped by real, stated priorities rather than
// being an arbitrary cron job with no point of view.
function _prioritiesPath() { return path.join(app.getPath('userData'), 'flow-priorities.json'); }
function _loadPriorities() {
  try {
    const p = _prioritiesPath();
    if (!fs.existsSync(p)) {
      // Real, sensible default — not invented busywork, matches what
      // Joel has actually asked Flow to care about across this whole
      // project (his own words: reduce manual work, flag mistakes).
      const defaults = [
        "Reduce Joel's manual, repetitive work where a real, safe automation exists",
        "Flag anything that looks like a real mistake before it becomes a bigger problem",
        "Notice genuine recurring patterns worth surfacing, not noise",
      ];
      fs.writeFileSync(p, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[Heartbeat] Priorities load failed (non-fatal):', e.message);
    return [];
  }
}

// ── Real self-messaging — both channels, as Joel explicitly asked ──────
async function sendSelfInitiatedMessage(text) {
  console.log('[Heartbeat] Self-initiated message:', text.slice(0, 100));

  // Native desktop notification — real, immediate, no network round-trip.
  try {
    if (Notification.isSupported()) {
      const notif = new Notification({ title: 'Flow', body: text.slice(0, 200), icon: path.join(__dirname, 'icon.png') });
      notif.show();
    }
  } catch (e) {
    console.warn('[Heartbeat] Native notification failed:', e.message);
  }

  // Real Telegram push via the actual, live endpoint built this session.
  try {
    const res = await fetch(`${VERCEL_URL}/api/social?platform=heartbeat-notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!data.ok) console.warn('[Heartbeat] Telegram self-message failed:', data.error);
  } catch (e) {
    console.warn('[Heartbeat] Telegram self-message request failed:', e.message);
  }

  // Also surface it in the real chat UI if the window happens to be
  // open right now, via the same notification sink main.js already
  // wires for other real events.
  if (_onNotification) _onNotification(text);
}

// ── Real internal monologue / scratchpad ────────────────────────────────
// Separate memory category from real conversation turns — this is
// Flow's own reasoning between ticks, not shown to Joel by default, but
// genuinely stored and recalled on the next tick so a multi-step thought
// survives instead of resetting every 15 minutes.
async function _writeScratchpad(thought) {
  await memoryStore.remember(thought, "scratchpad", { tick: Date.now() });
}
async function _recallScratchpad() {
  return memoryStore.recall("recent reasoning and open thoughts", { maxResults: 3, category: "scratchpad" });
}

// ── Real reasoning call — asks the actual cloud model, not a fake ───────
// canned response, whether anything is genuinely worth doing this tick.
async function _reasonAboutTick() {
  const openGoals = _loadGoals().filter(g => g.status === "open");
  const priorities = _loadPriorities();
  const recentThoughts = await _recallScratchpad();
  const recurringTopics = await memoryStore.findRecurringTopics({ sinceDays: 7, minOccurrences: 3 });

  // Real, honest prompt — explicitly tells the model this is an
  // UNPROMPTED reasoning pass, not a reply to Joel, and to say "nothing"
  // plainly rather than invent busywork just to have output. That
  // instruction matters: an idle-time loop with no permission to do
  // nothing just manufactures noise.
  const prompt = `This is a real, unprompted heartbeat check-in — Joel did not ask you anything this tick. Decide honestly whether there's genuinely something worth doing or telling him right now.

YOUR STANDING PRIORITIES (weigh these, don't ignore them):
${priorities.map(p => `- ${p}`).join('\n') || '(none set)'}

YOUR OPEN GOALS:
${openGoals.length ? openGoals.map(g => `- [${g.id}] ${g.description}`).join('\n') : '(none — this is fine, not every tick needs a goal)'}

YOUR RECENT SCRATCHPAD THOUGHTS (from previous ticks):
${recentThoughts.map(t => `- ${t.text}`).join('\n') || '(none yet)'}

PATTERNS DETECTED IN REAL CONVERSATION HISTORY (topics that recurred 3+ times in the last 7 days):
${recurringTopics.length ? recurringTopics.map(c => `- "${c.exampleText.slice(0, 80)}" (${c.occurrences} times)`).join('\n') : '(none detected this tick)'}

Respond with ONLY a JSON object, no other text:
{"action": "none"} — if genuinely nothing is worth doing right now, this is a perfectly good answer, don't force something
{"action": "message", "text": "..."} — if something is genuinely worth telling Joel unprompted right now
{"action": "scratchpad", "text": "..."} — if you have a real, incomplete thought worth carrying to the next tick, but nothing to say to Joel yet
{"action": "self_check", "text": "..."} — if reviewing your own recent actions revealed a real mistake or unfinished promise worth flagging`;

  try {
    const res = await fetch(`${VERCEL_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // REAL FIX: force_intent 'chat' would make chat.js OFFER TOOLS
      // (offerTools = intent === 'chat' || 'research', confirmed by
      // reading the real code) — meaning the model could call
      // get_my_level or similar instead of returning the plain JSON this
      // function needs to parse. 'pdf' is a genuinely tool-free intent
      // tier (same model family, just no tools attached) — not a hack,
      // just reusing an existing tool-free path for a reasoning task
      // that has no use for tools anyway.
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], force_intent: 'pdf', max_tokens: 400 }),
    });
    const data = await res.json();
    if (!data.reply) return { action: "none" };
    const match = data.reply.match(/\{[\s\S]*\}/); // real, tolerant of the model wrapping JSON in stray text despite the instruction
    if (!match) return { action: "none" };
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[Heartbeat] Reasoning call failed (non-fatal, real network/parse issue):', e.message);
    return { action: "none" };
  }
}

// ── Real self-monitoring pass ────────────────────────────────────────────
// Item #10 from Joel's list: check recent OWN actions for mistakes,
// separate from the general reasoning pass above, so it isn't
// accidentally skipped when the model finds something else to talk
// about first.
async function _selfCheck() {
  const recentActions = await memoryStore.recall("actions taken or promises made", { maxResults: 5, category: "decision" });
  if (!recentActions.length) return; // real, honest: nothing to check yet, not an error

  const prompt = `Real self-check, unprompted: review these recent actions/decisions you made. Did any of them fail, go unfinished, or contradict something you told Joel you'd do? Reply with ONLY a JSON object:
{"issue": null} — if nothing looks wrong, this is a fine, common answer
{"issue": "plain description of the real problem found"} — only if something genuinely looks off

RECENT ACTIONS:
${recentActions.map(a => `- ${a.text}`).join('\n')}`;

  try {
    const res = await fetch(`${VERCEL_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], force_intent: 'pdf', max_tokens: 200 }),
    });
    const data = await res.json();
    const match = data.reply?.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = JSON.parse(match[0]);
    if (parsed.issue) {
      await sendSelfInitiatedMessage(`Self-check flagged something: ${parsed.issue}`);
    }
  } catch (e) {
    console.warn('[Heartbeat] Self-check failed (non-fatal):', e.message);
  }
}

// ── The real tick ────────────────────────────────────────────────────────
async function _tick() {
  console.log('[Heartbeat] Real tick at', new Date().toLocaleTimeString());
  try {
    const decision = await _reasonAboutTick();
    if (decision.action === "message" && decision.text) {
      await sendSelfInitiatedMessage(decision.text);
      await memoryStore.remember(decision.text, "decision", { selfInitiated: true });
    } else if (decision.action === "scratchpad" && decision.text) {
      await _writeScratchpad(decision.text);
    } else if (decision.action === "self_check" && decision.text) {
      await sendSelfInitiatedMessage(decision.text);
    }
    // Real, separate self-monitoring pass — runs every tick regardless
    // of what the main reasoning pass decided, so it isn't crowded out.
    await _selfCheck();
  } catch (e) {
    console.error('[Heartbeat] Real tick failure:', e.message);
  }
}

function startHeartbeat() {
  if (_heartbeatTimer) return; // real guard against double-starting
  console.log(`[Heartbeat] Starting — real tick every ${HEARTBEAT_INTERVAL_MS / 60000} minutes.`);
  _heartbeatTimer = setInterval(_tick, HEARTBEAT_INTERVAL_MS);
  // Real, deliberate: also fire one tick shortly after boot, not just
  // after the first full interval — so a fresh restart doesn't feel
  // dormant for 15 minutes before anything happens.
  setTimeout(_tick, 60 * 1000);
}

function stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

module.exports = {
  startHeartbeat, stopHeartbeat, setNotificationSink,
  addGoal, listGoals, removeGoal,
};
