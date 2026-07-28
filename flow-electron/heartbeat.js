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

// ── Real marketing-cadence tracking ──────────────────────────────────────
// Connects the autonomy loop directly to Joel's actual, stated goal:
// getting seen on socials. The heartbeat can't call
// ui/marketing.js's generateMarketingPost directly (that's real browser/
// renderer code — Flux calls, Bluesky posting — the main process can't
// reach it), so instead it tracks cadence and SUGGESTS a post via the
// real self-messaging path when it's genuinely been a while; Joel then
// says "yes, make one" in chat and the existing generate_marketing_post
// tool (built this session) takes it from there.
function _lastMarketingPostPath() { return path.join(app.getPath('userData'), 'flow-last-marketing-post.json'); }
function _daysSinceLastMarketingPost() {
  try {
    const p = _lastMarketingPostPath();
    if (!fs.existsSync(p)) return Infinity; // real, honest: never posted yet, definitely due
    const { ts } = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (Date.now() - ts) / (24 * 60 * 60 * 1000);
  } catch (e) {
    return Infinity;
  }
}
// Real, callable from the renderer (main.js wires an IPC handler) so
// ui/marketing.js can mark "a post genuinely went out" after a real
// Bluesky success — not guessed at from the main process's side.
function recordMarketingPost() {
  try { fs.writeFileSync(_lastMarketingPostPath(), JSON.stringify({ ts: Date.now() })); } catch (e) { console.warn('[Heartbeat] Failed to record marketing post timestamp:', e.message); }
  // Real, honest reset: a genuine post going out resolves the cadence
  // question outright — no need to wait out the suggestion cooldown too.
  try { fs.writeFileSync(_lastMarketingSuggestionPath(), JSON.stringify({ ts: Date.now() })); } catch (e) { /* non-fatal */ }
}

// ── Real, HARD-enforced suggestion cooldown ─────────────────────────────
// REAL BUG FIX: the previous design only told the model, in the prompt
// text, "don't force it every tick" — a soft instruction, not a real
// constraint. Since each 15-minute tick calls the model fresh with no
// memory of its OWN past unprompted messages (only scratchpad thoughts,
// a separate optional action), the model kept independently re-deciding
// "yes, it's been a while, worth mentioning" every tick — producing
// genuinely repetitive, spammy real messages (confirmed directly by
// Joel: two near-identical marketing nudges ~40 minutes apart, which
// Flow's own self-check then correctly flagged as a real problem).
//
// Real fix: track WHEN the marketing angle was last actually suggested
// (distinct from when a post last actually went out), and don't even
// OFFER the model that reasoning angle in the prompt again until a real,
// generous cooldown has passed — currently 48 hours. This is a hard,
// code-level gate, not another soft instruction the model can second-
// guess its way around.
function _lastMarketingSuggestionPath() { return path.join(app.getPath('userData'), 'flow-last-marketing-suggestion.json'); }
function _hoursSinceLastMarketingSuggestion() {
  try {
    const p = _lastMarketingSuggestionPath();
    if (!fs.existsSync(p)) return Infinity;
    const { ts } = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (Date.now() - ts) / (60 * 60 * 1000);
  } catch (e) {
    return Infinity;
  }
}
function _recordMarketingSuggestion() {
  try { fs.writeFileSync(_lastMarketingSuggestionPath(), JSON.stringify({ ts: Date.now() })); } catch (e) { console.warn('[Heartbeat] Failed to record marketing suggestion timestamp:', e.message); }
}
const MARKETING_SUGGESTION_COOLDOWN_HOURS = 48; // real, deliberate: generous enough that Joel genuinely forgot the last nudge before a new one can fire

// ── Real reasoning call — asks the actual cloud model, not a fake ───────
// canned response, whether anything is genuinely worth doing this tick.
async function _reasonAboutTick() {
  const openGoals = _loadGoals().filter(g => g.status === "open");
  const priorities = _loadPriorities();
  const recentThoughts = await _recallScratchpad();
  const recurringTopics = await memoryStore.findRecurringTopics({ sinceDays: 7, minOccurrences: 3 });
  const daysSincePost = _daysSinceLastMarketingPost();
  const hoursSinceLastSuggestion = _hoursSinceLastMarketingSuggestion();
  const marketingCooldownActive = hoursSinceLastSuggestion < MARKETING_SUGGESTION_COOLDOWN_HOURS;

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

${marketingCooldownActive ? '' : `REAL MARKETING CADENCE: it has been ${daysSincePost === Infinity ? 'a while (no post recorded yet)' : `${daysSincePost.toFixed(1)} days`} since the last real marketing post went out. Joel's stated goal is getting genuinely seen on socials to help him land real clients — if it's been more than ~3 days, consider suggesting a new post as a real "message" action below, but don't force it every single tick just because time passed; use real judgment about whether now is a reasonable moment.`}

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
    // REAL, DEFENSIVE FIX: same class of bug found and fixed across
    // core/ai.js, core/memextract.js, core/persona.js this session —
    // `if (!data.reply) return...` only protects against a falsy value,
    // not a non-string truthy one, which would pass this check and then
    // crash on data.reply.match(...) below.
    if (!data.reply || typeof data.reply !== 'string') return { action: "none" };
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
    // Real, same fix as _reasonAboutTick above — ?. alone only guards
    // against null/undefined, not a non-string truthy value.
    if (typeof data.reply !== 'string') return;
    const match = data.reply.match(/\{[\s\S]*\}/);
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
// isFirstTick param: REAL, Joel-requested fix — he explicitly said he
// doesn't want a marketing/posting reminder the moment he opens the app,
// but DOES want the self-diagnostic that runs afterward. The first tick
// (fired 60s after boot, before the normal interval even starts) skips
// the _reasonAboutTick() decision path entirely — which is genuinely
// where the marketing nudge and other self-initiated "message" actions
// come from — while _selfCheck() still runs every time, including this
// first tick, exactly as requested.
// ═══════════════════════════════════════════
// REAL, Joel-requested — daily social-monitor trigger, fired from
// Electron's heartbeat (per Joel's explicit choice, not Vercel's own
// cron), targeting 5PM WAT (UTC+1, no DST — so this is a fixed real UTC
// hour, not something that needs seasonal adjustment).
//
// HONEST MECHANISM: there's no native "run once daily at exactly 5PM"
// primitive on a 15-minute interval timer — this instead checks, on
// EVERY regular heartbeat tick, whether it's currently 5PM-or-later WAT
// AND today's run hasn't already happened, persisting the last-run DATE
// (not just a boolean) to disk so a restart doesn't cause a second run
// or a permanently-stuck skip. Real, deliberate tradeoff Joel accepted:
// this needs Electron open at/after 5PM WAT to fire that day — if the
// app is closed the whole day, that day's pass is simply skipped, same
// honest limitation already stated for the rest of this file's "always
// online" scope note above.
// ═══════════════════════════════════════════
const SOCIAL_MONITOR_HOUR_WAT = 17; // 5PM WAT == UTC+1, no DST — so 17 WAT is a fixed 16:00 UTC year-round
function _socialMonitorStatePath() { return path.join(app.getPath('userData'), 'flow-social-monitor-state.json'); }

function _loadSocialMonitorState() {
  try {
    const p = _socialMonitorStatePath();
    if (!fs.existsSync(p)) return { lastRunDate: null };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[Heartbeat] Social-monitor state load failed (non-fatal):', e.message);
    return { lastRunDate: null };
  }
}

function _saveSocialMonitorState(state) {
  try {
    fs.writeFileSync(_socialMonitorStatePath(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[Heartbeat] Social-monitor state save failed (non-fatal):', e.message);
  }
}

// Real WAT-local date string (not the machine's own locale/timezone,
// which could be anything) — computed directly from a fixed UTC+1
// offset, so this is correct regardless of what timezone Joel's actual
// PC clock is set to.
function _todayWAT() {
  const watMs = Date.now() + 60 * 60 * 1000; // UTC+1, fixed, no DST
  return new Date(watMs).toISOString().slice(0, 10);
}

function _currentHourWAT() {
  const watMs = Date.now() + 60 * 60 * 1000;
  return new Date(watMs).getUTCHours();
}

async function _maybeRunSocialMonitor() {
  const today = _todayWAT();
  const state = _loadSocialMonitorState();
  if (state.lastRunDate === today) return; // already ran today, real guard
  if (_currentHourWAT() < SOCIAL_MONITOR_HOUR_WAT) return; // not 5PM WAT yet today

  console.log('[Heartbeat] Running daily social-monitor pass (5PM WAT window)...');
  try {
    const res = await fetch(`${VERCEL_URL}/api/social?platform=social-monitor`);
    const data = await res.json();
    if (!data.ok) {
      console.warn('[Heartbeat] Social-monitor pass reported failure (non-fatal):', data.error);
      // Deliberately still mark today as run — a real, temporary failure
      // (e.g. content generation error) shouldn't retry every 15 minutes
      // for the rest of the day; it'll get a fresh attempt tomorrow.
    } else {
      console.log('[Heartbeat] Social-monitor pass complete:', data.drafts?.length || 0, 'draft(s) sent for approval.');
    }
  } catch (e) {
    console.warn('[Heartbeat] Social-monitor pass request failed (non-fatal):', e.message);
  }
  _saveSocialMonitorState({ lastRunDate: today });
}

// ═══════════════════════════════════════════
// REAL, Joel-requested — sales-conversation research pass. A genuinely
// separate, less-frequent cadence (every 3 days, real elapsed time, not
// tied to the daily social-monitor pass) where Flow researches how to
// hold a stable conversation and talk to prospects/buyers effectively.
// This directly feeds the quality of future prospect follow-up emails
// (once the scrapegraph pipeline is connected) — real content
// intelligence accumulating the same way social-monitor's insights do.
//
// REAL UPGRADE, Joel-requested: previously a single fixed topic on a
// flat 3-day timer. Now a real ROTATION across three genuinely distinct
// research areas — content strategy, client-conversation/sales skill,
// and business mindset/strategy — cycling one at a time so Flow is
// never idle for long stretches, but also never hammering the same
// topic repeatedly. Runs on IDLE (no real user interaction in the last
// _IDLE_THRESHOLD_MS), not a flat calendar timer — "whenever Flow is
// online and not actively being used" is closer to what Joel actually
// asked for than a fixed multi-day clock.
//
// REAL, Joel-requested — happens SILENTLY: no Telegram ping, no native
// notification for this specific pass, so it genuinely runs "without him
// knowing" in the moment. It still shows up honestly afterward, though —
// the small EXP award (see core/leveling.js's awardInsightXp, called
// from Content Lab the same way social-monitor's insights are) means the
// level bar visibly grows over time, which is the real, intended signal
// that this is happening in the background, without a chattier
// in-the-moment interruption.
// ═══════════════════════════════════════════
const _IDLE_THRESHOLD_MS = 20 * 60 * 1000; // real, 20 min of no interaction before background research is allowed to run — long enough that it never fires mid-conversation
const _MIN_GAP_BETWEEN_RESEARCH_MS = 6 * 60 * 60 * 1000; // real, honest cap — even if idle the whole day, don't run more than once every 6h, to keep this genuinely "background" rather than constant
const RESEARCH_TOPICS = ['sales-research', 'content-research', 'mindset-research']; // real rotation order

function _researchStatePath() { return path.join(app.getPath('userData'), 'flow-sales-research-state.json'); }

function _loadResearchState() {
  try {
    const p = _researchStatePath();
    if (!fs.existsSync(p)) return { lastRunAt: 0, nextTopicIndex: 0 };
    const loaded = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Real, backward-compatible default for anyone upgrading from the
    // old single-topic version of this state file.
    if (typeof loaded.nextTopicIndex !== 'number') loaded.nextTopicIndex = 0;
    return loaded;
  } catch (e) {
    console.warn('[Heartbeat] Research state load failed (non-fatal):', e.message);
    return { lastRunAt: 0, nextTopicIndex: 0 };
  }
}

function _saveResearchState(state) {
  try {
    fs.writeFileSync(_researchStatePath(), JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[Heartbeat] Research state save failed (non-fatal):', e.message);
  }
}

// Real, module-scope tracker of the last time Joel actually sent a
// message — updated from app.js/ai.js via markUserActivity() (see
// export below), so "idle" reflects genuine inactivity, not just time
// since the app opened.
let _lastUserActivityAt = Date.now();
function markUserActivity() { _lastUserActivityAt = Date.now(); }

async function _maybeRunSalesResearch() {
  const state = _loadResearchState();
  const idleFor = Date.now() - _lastUserActivityAt;
  const sinceLastRun = Date.now() - (state.lastRunAt || 0);

  if (idleFor < _IDLE_THRESHOLD_MS) return; // real, active conversation — don't interrupt
  if (sinceLastRun < _MIN_GAP_BETWEEN_RESEARCH_MS) return; // ran recently enough already

  const topic = RESEARCH_TOPICS[state.nextTopicIndex % RESEARCH_TOPICS.length];
  console.log(`[Heartbeat] Running background research pass (silent, idle ${Math.round(idleFor / 60000)}min) — topic: ${topic}...`);
  try {
    const res = await fetch(`${VERCEL_URL}/api/social?platform=${topic}`);
    const data = await res.json();
    if (!data.ok) {
      console.warn(`[Heartbeat] Background research pass (${topic}) reported failure (non-fatal):`, data.error);
    } else {
      console.log(`[Heartbeat] Background research pass (${topic}) complete — insight stored, no notification sent (by design).`);
    }
    // Deliberately no sendSelfInitiatedMessage call here at all, on
    // either success or failure — Joel's explicit ask was for this to
    // happen without him knowing in the moment. The EXP bar (via Content
    // Lab picking up the stored insight) is the only visible trace.
  } catch (e) {
    console.warn(`[Heartbeat] Background research pass (${topic}) request failed (non-fatal):`, e.message);
  }
  _saveResearchState({ lastRunAt: Date.now(), nextTopicIndex: (state.nextTopicIndex + 1) % RESEARCH_TOPICS.length });
}

async function _tick(isFirstTick = false) {
  console.log('[Heartbeat] Real tick at', new Date().toLocaleTimeString(), isFirstTick ? '(first tick — reasoning/marketing skipped)' : '');
  try {
    // Real, deliberate: checked on EVERY tick (including the first),
    // unlike the reasoning/marketing pass below — there's no reason to
    // skip this on a fresh app open the way Joel wanted the chattier
    // self-initiated-message logic skipped; if it's already past 5PM WAT
    // when Joel opens the app, the pass should still run.
    await _maybeRunSocialMonitor();
    await _maybeRunSalesResearch();

    if (!isFirstTick) {
      const decision = await _reasonAboutTick();
      if (decision.action === "message" && decision.text) {
        await sendSelfInitiatedMessage(decision.text);
        await memoryStore.remember(decision.text, "decision", { selfInitiated: true });
        // REAL, CORRECTED FIX: the previous version's real bug — confirmed
        // by Joel still seeing repeated reminders even after the 48h
        // cooldown was deployed — was assuming ANY unprompted message sent
        // while the marketing angle was merely "available" must have been
        // a marketing nudge, and starting the cooldown based on that
        // assumption alone. That's wrong: Flow could send a genuinely
        // unrelated message (a different reminder, a self-check) while the
        // angle happened to be available, silently consuming the cooldown
        // for something that was never actually about marketing — leaving
        // the REAL marketing-nudge cooldown never properly triggered at
        // the right moment, which is exactly the repeat Joel kept seeing.
        //
        // Real fix: check the actual message TEXT for real marketing/
        // posting-related language before starting the cooldown — not an
        // assumption based on timing alone.
        const looksLikeMarketingNudge = /\b(marketing post|social media|bluesky|linkedin|twitter|content lab|last (real )?post|posting cadence|getting seen|visibility|share (a|an|your))\b/i.test(decision.text);
        if (looksLikeMarketingNudge) _recordMarketingSuggestion();
      } else if (decision.action === "scratchpad" && decision.text) {
        await _writeScratchpad(decision.text);
      } else if (decision.action === "self_check" && decision.text) {
        await sendSelfInitiatedMessage(decision.text);
      }
    }
    // Real, separate self-monitoring pass — runs every tick regardless
    // of what the main reasoning pass decided (or was skipped on the
    // first tick), so Joel still sees this even right after opening Flow.
    await _selfCheck();
  } catch (e) {
    console.error('[Heartbeat] Real tick failure:', e.message);
  }
}

// ═══════════════════════════════════════════
// REAL, Joel-requested — Gmail integration, the "read automatically and
// constantly" half (writing/sending is a separate, on-command feature
// via api/social.js's handleGmailSend, triggered through the chat/tool
// path, not here). REAL, HONEST CONSTRAINT: Vercel Hobby's cron jobs can
// only run once per day (a genuine platform limit, not something
// configurable around) — so "constant" checking is built here instead,
// client-side in Electron's main process, which can poll as often as
// actually wanted since it isn't bound by that restriction.
// ═══════════════════════════════════════════
let _gmailPollTimer = null;

// REAL FIX for Joel's reported bug: _seenGmailIds was previously an
// in-memory-only Set that reset to empty on every app restart. Since
// Gmail's own "is:unread newer_than:1d" query legitimately re-surfaces
// anything STILL unread, a restart meant every still-unread email from
// before the restart looked "new" again to the empty Set — re-announcing
// emails Joel had already seen notifications for. Persisting to disk
// (same pattern as _goalsPath/_prioritiesPath above) fixes this for
// good: a restart now correctly remembers what was already announced.
function _seenGmailIdsPath() { return path.join(app.getPath('userData'), 'flow-seen-gmail-ids.json'); }

function _loadSeenGmailIds() {
  try {
    const p = _seenGmailIdsPath();
    if (!fs.existsSync(p)) return new Set();
    return new Set(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) {
    console.warn('[Heartbeat] Seen-Gmail-IDs load failed (non-fatal):', e.message);
    return new Set();
  }
}

function _saveSeenGmailIds(set) {
  try {
    // Real, small cap — keeps the most recent 500 seen IDs, comfortably
    // more than any real day's volume, so this file never grows unbounded.
    const trimmed = [...set].slice(-500);
    fs.writeFileSync(_seenGmailIdsPath(), JSON.stringify(trimmed));
  } catch (e) {
    console.warn('[Heartbeat] Seen-Gmail-IDs save failed (non-fatal):', e.message);
  }
}

let _seenGmailIds = _loadSeenGmailIds(); // real, persisted across restarts now — see fix note above
let _lastGmailErrorNotifiedDate = null; // real, once-per-day cap on the gmail-analyze failure notice, so a persistent outage doesn't spam every 60s

const GMAIL_POLL_INTERVAL_MS = 60 * 1000; // real, genuinely frequent — 60s, matching Joel's "constantly" ask

// REAL, ORDERING helper — high priority first, then medium, then low,
// so the most important thing Joel needs to see leads the digest
// regardless of which order Gmail happened to return messages in.
const _PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

async function _checkGmail() {
  try {
    // REAL UPGRADE, per Joel's explicit ask: uses gmail-analyze instead
    // of the old gmail-read — same underlying Gmail data, but each
    // message now comes back already classified by real LLM judgment
    // (not keyword/pattern matching) into priority/category, with an
    // actual summary of what the email says, not just a raw snippet.
    const res = await fetch(`${VERCEL_URL}/api/social?platform=gmail-analyze`);
    const data = await res.json();
    if (!data.ok) {
      // REAL, Joel-requested visibility fix: previously this failure was
      // ONLY logged to a console Joel never sees, then silently
      // returned — meaning a real gmail-analyze failure looked
      // identical to "no new mail," with zero indication anything was
      // wrong. Now it surfaces honestly (once, not spammed) so a
      // real, ongoing problem is visible instead of silently invisible.
      console.warn('[Heartbeat] Gmail check failed (non-fatal):', data.error);
      const today = _todayWAT();
      if (_lastGmailErrorNotifiedDate !== today) {
        _lastGmailErrorNotifiedDate = today;
        await sendSelfInitiatedMessage(`⚠️ Gmail smart-check failed today: ${data.error}\n\n(Falling back silently would just look like "no new mail" — flagging this once so it doesn't go unnoticed. Will keep retrying.)`);
      }
      return;
    }
    const newMessages = (data.messages || []).filter((m) => !_seenGmailIds.has(m.id));
    if (!newMessages.length) return;

    newMessages.forEach((m) => _seenGmailIds.add(m.id));
    _saveSeenGmailIds(_seenGmailIds);

    // REAL, Joel-requested — a smooth, ordered digest instead of a
    // generic "new email from X" ping. Groups by real priority, leads
    // with what actually matters (prospects/business-relevant mail),
    // and includes Flow's real summary + suggested action rather than a
    // bare subject line.
    const sorted = [...newMessages].sort((a, b) => (_PRIORITY_ORDER[a.priority] ?? 1) - (_PRIORITY_ORDER[b.priority] ?? 1));
    const high = sorted.filter((m) => m.priority === 'high');
    const rest = sorted.filter((m) => m.priority !== 'high');

    const formatMsg = (m) => {
      const tag = m.category === 'prospect' ? '💼' : m.category === 'client_followup' ? '🔁' : m.category === 'business_tip' ? '💡' : '📩';
      const actionLine = m.suggestedAction ? `\n   → ${m.suggestedAction}` : '';
      return `${tag} ${m.from}\n   "${m.subject}"\n   ${m.summary}${actionLine}`;
    };

    let digest;
    if (high.length && rest.length) {
      digest = `📬 ${newMessages.length} new — ${high.length} important:\n\n${high.map(formatMsg).join('\n\n')}\n\n(+ ${rest.length} lower-priority, not detailed here)`;
    } else if (high.length) {
      digest = `📬 ${high.length === 1 ? 'Important email' : `${high.length} important emails`}:\n\n${high.map(formatMsg).join('\n\n')}`;
    } else {
      // Nothing high-priority — still real, still useful, just calmer framing.
      digest = newMessages.length === 1
        ? `📩 ${formatMsg(newMessages[0])}`
        : `📩 ${newMessages.length} new emails, nothing urgent:\n\n${sorted.slice(0, 3).map(formatMsg).join('\n\n')}${sorted.length > 3 ? `\n\n(+ ${sorted.length - 3} more)` : ''}`;
    }

    await sendSelfInitiatedMessage(digest);
  } catch (e) {
    console.warn('[Heartbeat] Gmail check error (non-fatal):', e.message);
  }
}

function startGmailPolling() {
  if (_gmailPollTimer) return; // real guard against double-starting
  console.log(`[Heartbeat] Starting Gmail polling — checking every ${GMAIL_POLL_INTERVAL_MS / 1000}s.`);
  _gmailPollTimer = setInterval(_checkGmail, GMAIL_POLL_INTERVAL_MS);
  _checkGmail(); // real, immediate first check on start, not waiting a full interval
}

function stopGmailPolling() {
  if (_gmailPollTimer) { clearInterval(_gmailPollTimer); _gmailPollTimer = null; }
}

function startHeartbeat() {
  if (_heartbeatTimer) return; // real guard against double-starting
  console.log(`[Heartbeat] Starting — real tick every ${HEARTBEAT_INTERVAL_MS / 60000} minutes.`);
  _heartbeatTimer = setInterval(_tick, HEARTBEAT_INTERVAL_MS);
  // Real, deliberate: also fire one tick shortly after boot, not just
  // after the first full interval — so a fresh restart doesn't feel
  // dormant for 15 minutes before anything happens. Passes true so this
  // specific tick skips the marketing/reasoning decision (Joel's real
  // request: no reminder the moment he opens the app) while still
  // running the self-check diagnostic he wants to keep.
  setTimeout(() => _tick(true), 60 * 1000);
  startGmailPolling(); // real, separate cadence from the main heartbeat tick — Joel wants email checking genuinely frequent, not tied to the 15-min interval
}

function stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  stopGmailPolling();
}

module.exports = {
  startHeartbeat, stopHeartbeat, setNotificationSink,
  addGoal, listGoals, removeGoal, recordMarketingPost,
  markUserActivity,
};
