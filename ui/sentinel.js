// ui/sentinel.js — Flow Sentinel UI control + Watch · Learn · Replicate
// Self-contained: does nothing at all when not running inside the Electron
// desktop app (window.__flowElectron.sentinel won't exist on web/PWA), so
// this is always safe to import everywhere.
//
// Surfaces:
//   - A toggle pill in the top bar: "👁 Sentinel" (off) / pulsing purple (on)
//   - When Sentinel notices something, it's spoken into the chat exactly
//     like any other Flow message, via the same Chat.add() everything else
//     uses — no separate UI surface to maintain.
//   - Watch & Learn recording auto-starts whenever Sentinel is on (no
//     separate third toggle Joel has to remember) — it's just a rolling
//     buffer, nothing is sent anywhere until Joel explicitly asks to
//     replay something.
//   - Replay is always plan-then-confirm-then-execute: Flow describes what
//     it thinks Joel wants repeated in plain chat, and only clicks/types
//     anything after Joel replies "yes"/"go"/"do it". It never acts on
//     its own.

let _Chat = null;

export function initSentinel(Chat) {
  _Chat = Chat;

  const bridge = window.__flowElectron?.sentinel;
  if (!bridge) return; // not running in Electron — Sentinel doesn't exist here

  bridge.status().then(({ enabled, available }) => {
    if (!available) return; // active-win failed to load on this machine
    _buildToggle(enabled);
    if (enabled) bridge.learnToggle(true); // keep learn-recording in sync on reload
  });

  bridge.onObservation((desc) => {
    _Chat.add(`👁 **Sentinel noticed:**\n\n${desc}`, 'bot');
  });

  bridge.onToggled((enabled) => {
    _setToggleState(enabled);
    bridge.learnToggle(enabled); // Watch & Learn always mirrors the main Sentinel toggle
  });
}

// ── Watch · Learn · Replicate ──────────────────────────────────────────
// Called from app.js's command chain. Returns false if this message isn't
// a replay request (so app.js falls through to normal handling), or
// true/null if it handled the message itself.
const REPLAY_INTENT_RX = /\b(do|repeat|replicate) what i (just )?(did|showed you|was doing)\b|\btry (that|it) (out\s*)?(yourself|for me)\b|\bcan you do that (again|yourself)\b/i;
const CONFIRM_RX = /^\s*(yes|yeah|yep|do it|go ahead|go|confirm|proceed)\s*$/i;

let _pendingPlan = null; // { instruction, steps text } awaiting confirmation

export async function parseReplayCommand(text) {
  const bridge = window.__flowElectron?.sentinel;
  if (!bridge) return false; // web/PWA — this feature doesn't exist here

  // Step 2: Joel confirming a plan Flow already described
  if (_pendingPlan && CONFIRM_RX.test(text)) {
    const plan = _pendingPlan;
    _pendingPlan = null;
    _Chat.add("On it — watching what happens as I go.", "bot");
    await _executeConfirmedPlan(plan);
    return true;
  }

  // Any other reply while a plan is pending just cancels it quietly rather
  // than leaving Flow stuck waiting for an exact confirmation phrase.
  if (_pendingPlan && !REPLAY_INTENT_RX.test(text)) {
    _pendingPlan = null;
  }

  // Step 1: does this message ask Flow to replicate something?
  if (!REPLAY_INTENT_RX.test(text)) return false;

  const status = await bridge.learnStatus();
  if (!status.frames) {
    _Chat.add("I haven't been watching anything recent to learn from — turn Sentinel on (top bar toggle) and do the task once, then ask me again.", "bot");
    return true;
  }

  _Chat.add("Let me look at what you were just doing...", "bot");
  const plan = await bridge.replayPlan(text);

  if (!plan.ok) {
    _Chat.add(`I couldn't work out a clear plan: ${plan.error}`, "bot");
    return true;
  }

  _pendingPlan = { instruction: text, stepsText: plan.steps };
  _Chat.add(
    `Here's what I think you want repeated, based on the last ${plan.framesUsed} thing(s) I saw:\n\n${plan.steps}\n\n` +
    `Say **"do it"** if that's right and I'll go ahead — otherwise just tell me what's off.`,
    "bot"
  );
  return true;
}

// Executes the confirmed plan. IMPORTANT HONESTY NOTE surfaced to Joel:
// this reads the AI's step description and only acts on unambiguous,
// literal instructions it can map to a real action — it does NOT invent
// pixel coordinates it was never actually given. For steps it can't map
// to a concrete action, it stops and reports rather than guessing.
async function _executeConfirmedPlan(plan) {
  const bridge = window.__flowElectron.sentinel;
  const lines = plan.stepsText.split("\n").map(l => l.trim()).filter(Boolean);

  let anyExecuted = false;
  for (const line of lines) {
    // Only act on steps the AI phrased as containing an explicit coordinate
    // hint or a clearly literal type/scroll instruction — anything vaguer
    // ("click the button") without coordinates gets reported, not guessed.
    const coordMatch = line.match(/\((\d+)\s*,\s*(\d+)\)/);
    const typeMatch   = line.match(/type[s]?\s*[:\-]?\s*["'](.+?)["']/i);
    const scrollMatch = line.match(/scroll(?:s|ing)?\s+(up|down)/i);

    if (coordMatch) {
      const [, x, y] = coordMatch;
      await bridge.replayExecute('click', Number(x), Number(y));
      anyExecuted = true;
      await new Promise(r => setTimeout(r, 500));
    } else if (typeMatch) {
      await bridge.replayExecute('type', null, null, typeMatch[1]);
      anyExecuted = true;
      await new Promise(r => setTimeout(r, 300));
    } else if (scrollMatch) {
      await bridge.replayExecute('scroll', null, null, null, scrollMatch[1].toLowerCase());
      anyExecuted = true;
      await new Promise(r => setTimeout(r, 300));
    }
  }

  if (anyExecuted) {
    _Chat.add("Done — I went through the steps I could act on directly. Check that it landed the way you wanted.", "bot");
  } else {
    _Chat.add("I described the steps but couldn't find exact click positions or literal text to act on safely — rather than guess and click the wrong thing, I stopped short. You may need to do this one manually, or describe the exact spot to click.", "bot");
  }
}

let _pillEl = null;

function _buildToggle(initialEnabled) {
  const topBar = document.getElementById('top-bar');
  if (!topBar || document.getElementById('sentinel-toggle')) return;

  const pill = document.createElement('button');
  pill.id = 'sentinel-toggle';
  pill.type = 'button';
  pill.style.cssText = `
    display:flex;align-items:center;gap:6px;
    background:rgba(167,139,250,0.08);
    border:1px solid rgba(167,139,250,0.3);
    color:#a78bfa;font-size:11px;font-weight:600;
    border-radius:20px;padding:5px 12px;cursor:pointer;
    margin-left:8px;font-family:inherit;letter-spacing:.02em;
    transition:background .15s,border-color .15s;
  `;
  pill.innerHTML = `<span id="sentinel-pill-dot" style="width:6px;height:6px;border-radius:50%;background:#a78bfa;"></span><span id="sentinel-pill-label">Sentinel</span>`;

  pill.addEventListener('click', async () => {
    const next = !pill.dataset.enabled || pill.dataset.enabled === 'false';
    window.__flowElectron.sentinel.toggle(next);
    window.__flowElectron.sentinel.learnToggle(next);
    _setToggleState(next);
    _Chat.add(
      next
        ? "👁 Sentinel is on — I'll keep half an eye on what you're working on, say something if it looks like you've been stuck a while, and remember recent activity so you can ask me to repeat something you just did. You can turn this off any time, here or from the tray icon."
        : "Sentinel is off. I'm not watching the screen or remembering recent activity anymore.",
      'bot'
    );
  });

  topBar.appendChild(pill);
  _pillEl = pill;
  _setToggleState(initialEnabled);
}

function _setToggleState(enabled) {
  if (!_pillEl) return;
  _pillEl.dataset.enabled = String(enabled);
  const dot = document.getElementById('sentinel-pill-dot');
  if (enabled) {
    _pillEl.style.background = 'rgba(167,139,250,0.22)';
    _pillEl.style.borderColor = 'rgba(167,139,250,0.65)';
    if (dot) dot.style.animation = 'pulse 1.6s ease-in-out infinite';
  } else {
    _pillEl.style.background = 'rgba(167,139,250,0.08)';
    _pillEl.style.borderColor = 'rgba(167,139,250,0.3)';
    if (dot) dot.style.animation = 'none';
  }
}

// Inject the pulse keyframes once
if (!document.getElementById('sentinel-style')) {
  const style = document.createElement('style');
  style.id = 'sentinel-style';
  style.textContent = `@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`;
  document.head.appendChild(style);
}
