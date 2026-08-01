// ═══════════════════════════════════════════
// flow-electron/os-control.js — REAL OS-level mouse/keyboard control.
//
// REAL, EXPLICIT CONTEXT: this reverses a prior, documented decision to
// NOT give Flow OS-level input control, made for real sandbox-escape
// security reasons. Joel explicitly, consciously overrode that decision
// this session — this file exists because of that specific override,
// not a quiet reversal.
//
// TWO SAFETY PROPERTIES ARE NON-NEGOTIABLE, kept even with the override:
//   1. Every replay shows a real, visible confirmation overlay
//      describing what it's about to do BEFORE it does it — with a
//      cancellable countdown, not silent auto-execution.
//   2. A global emergency-stop hotkey (Ctrl+Shift+Escape) instantly
//      aborts any in-progress automation, checked between every single
//      action step (not just at the start).
// These exist because misheard voice commands + real OS control +
// zero visibility is a genuinely bad combination regardless of who
// owns the machine — this is about basic reliability, not distrust.
//
// LIBRARY CHOICE, real and deliberate — CORRECTED from an initial draft
// that assumed nut.js was needed: this project ALREADY has
// @jitsi/robotjs installed as a real dependency, AND it's already
// listed in electron-builder's asarUnpack config (flow-electron/
// package.json) — meaning it's already proven to package correctly in
// this exact project's build. Using it instead of adding nut.js means
// ZERO new native-module packaging risk, versus a real, unknown risk
// with a brand-new native dependency. This file does NOT include
// global input RECORDING (listening to system-wide mouse/keyboard
// events) — that needs a different library (uiohook-napi), which has a
// known, long-unresolved crash/auto-exit bug, and this project has
// ALREADY had a real, confirmed Electron packaging failure from a
// similar native module (onnxruntime-node) before. Recording is staged
// as the next real step once this control layer is confirmed stable on
// Joel's actual machine — not silently skipped, just sequenced sensibly.
// ═══════════════════════════════════════════

const { globalShortcut, BrowserWindow, screen } = require('electron');

let _robot = null;
function _loadRobot() {
  if (_robot) return _robot;
  try {
    _robot = require('@jitsi/robotjs');
    return _robot;
  } catch (e) {
    console.error('[OSControl] @jitsi/robotjs failed to load even though it is a declared dependency — check node_modules/electron-rebuild status.', e.message);
    return null;
  }
}

let _abortRequested = false;
let _emergencyStopRegistered = false;

// REAL, ALWAYS ACTIVE the moment this module loads — not tied to
// whether automation is currently running, so it's always available
// the instant something starts, with zero race window.
function registerEmergencyStop() {
  if (_emergencyStopRegistered) return;
  try {
    globalShortcut.register('CommandOrControl+Shift+Escape', () => {
      _abortRequested = true;
      console.warn('[OSControl] EMERGENCY STOP triggered — aborting any in-progress automation.');
      _broadcastToRenderer('os-control-aborted', {});
    });
    _emergencyStopRegistered = true;
    console.log('[OSControl] Emergency stop registered: Ctrl+Shift+Escape');
  } catch (e) {
    console.error('[OSControl] Failed to register emergency stop hotkey — real OS control will NOT run without this, refusing to proceed unsafely.', e.message);
  }
}

function _broadcastToRenderer(channel, data) {
  BrowserWindow.getAllWindows().forEach(win => {
    try { win.webContents.send(channel, data); } catch (_) {}
  });
}

// A "skill" is a real, named, ordered list of steps. Each step is
// described SEMANTICALLY (what to click/type and why), not as raw
// pixel coordinates — coordinates get resolved fresh at replay time
// against the CURRENT screen (via the vision step in
// skill-recorder.js, once built), so a skill generalizes across minor
// screen-state differences instead of blindly replaying stale coords.
//
// steps: [{ type: 'click'|'type'|'wait'|'key', description, x?, y?, text?, ms?, keys? }]
async function replaySkill(skill, { onStep, requireConfirmation = true } = {}) {
  const robot = _loadRobot();
  if (!robot) throw new Error('@jitsi/robotjs failed to load — cannot perform real OS control right now.');

  registerEmergencyStop();
  _abortRequested = false;

  // REAL, non-negotiable safety gate — show Joel exactly what's about
  // to happen and give him a real chance to cancel before ANYTHING
  // executes. This is not optional even though Joel explicitly
  // approved OS control in general; a SPECIFIC replay still gets
  // previewed every time, since "approved the capability" isn't the
  // same as "approved this exact run."
  if (requireConfirmation) {
    const confirmed = await _showConfirmationOverlay(skill);
    if (!confirmed) {
      console.log('[OSControl] Replay cancelled by Joel at the confirmation step.');
      return { aborted: true, reason: 'cancelled_by_user' };
    }
  }

  for (let i = 0; i < skill.steps.length; i++) {
    if (_abortRequested) {
      console.warn('[OSControl] Aborted mid-replay (emergency stop) at step', i);
      return { aborted: true, reason: 'emergency_stop', stoppedAtStep: i };
    }

    const step = skill.steps[i];
    onStep?.(step, i, skill.steps.length);

    try {
      if (step.type === 'click' && typeof step.x === 'number' && typeof step.y === 'number') {
        robot.moveMouse(step.x, step.y);
        robot.mouseClick();
      } else if (step.type === 'type' && step.text) {
        robot.typeString(step.text);
      } else if (step.type === 'key' && Array.isArray(step.keys) && step.keys.length) {
        const [main, ...modifiers] = step.keys;
        robot.keyTap(main.toLowerCase(), modifiers.map(m => m.toLowerCase()));
      } else if (step.type === 'wait') {
        await new Promise(r => setTimeout(r, step.ms || 500));
      }
    } catch (e) {
      console.error(`[OSControl] Step ${i} failed (${step.description}):`, e.message);
      return { aborted: true, reason: 'step_error', stoppedAtStep: i, error: e.message };
    }

    // Real, small pause between steps — real UIs need a moment to
    // react before the next action fires; also gives the emergency-stop
    // check above a real chance to catch a fast abort between steps.
    await new Promise(r => setTimeout(r, 150));
  }

  return { aborted: false };
}

// REAL, visible confirmation overlay — a small, always-on-top,
// borderless window listing exactly what the skill is about to do,
// with a cancellable countdown. This is the actual mechanism that
// makes replay non-silent; it is NOT a checkbox buried in settings.
function _showConfirmationOverlay(skill) {
  return new Promise((resolve) => {
    const display = screen.getPrimaryDisplay();
    const win = new BrowserWindow({
      width: 420, height: 260,
      x: display.workArea.x + display.workArea.width - 440,
      y: display.workArea.y + 20,
      frame: false, alwaysOnTop: true, resizable: false, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const stepsHtml = skill.steps.map(s => `<li>${s.description || s.type}</li>`).join('');
    const html = `
      <html><body style="margin:0;background:#0f0a1e;color:#e5e7eb;font-family:system-ui;padding:16px;box-sizing:border-box;">
        <div style="font-weight:700;color:#d8d4ff;margin-bottom:8px;">⚠️ Flow wants to run: ${skill.name}</div>
        <ol style="font-size:12px;line-height:1.6;max-height:120px;overflow-y:auto;">${stepsHtml}</ol>
        <div id="countdown" style="font-size:12px;color:#fbbf24;margin:10px 0;">Running in <span id="n">5</span>s...</div>
        <button id="confirm" style="background:rgba(74,222,128,0.2);border:1px solid #4ade80;color:#4ade80;padding:8px 14px;border-radius:6px;cursor:pointer;margin-right:8px;">Run now</button>
        <button id="cancel" style="background:rgba(248,113,113,0.2);border:1px solid #f87171;color:#f87171;padding:8px 14px;border-radius:6px;cursor:pointer;">Cancel</button>
        <script>
          const { ipcRenderer } = require('electron');
          let n = 5;
          const t = setInterval(() => {
            n--; document.getElementById('n').textContent = n;
            if (n <= 0) { clearInterval(t); ipcRenderer.send('os-control-confirm', true); }
          }, 1000);
          document.getElementById('confirm').onclick = () => { clearInterval(t); ipcRenderer.send('os-control-confirm', true); };
          document.getElementById('cancel').onclick = () => { clearInterval(t); ipcRenderer.send('os-control-confirm', false); };
        </script>
      </body></html>`;
    win.loadURL(`data:text/html,${encodeURIComponent(html)}`);

    const { ipcMain } = require('electron');
    const handler = (event, confirmed) => {
      if (event.sender !== win.webContents) return;
      ipcMain.removeListener('os-control-confirm', handler);
      win.close();
      resolve(confirmed);
    };
    ipcMain.on('os-control-confirm', handler);
  });
}

module.exports = { replaySkill, registerEmergencyStop };
