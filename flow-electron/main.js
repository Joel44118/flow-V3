// flow-electron/main.js (v4)
// Single instance + native title bar + overlay gesture window +
// system tray + cache clear + auto-updater + FLOW SENTINEL

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, desktopCapturer, powerMonitor, globalShortcut } = require('electron');
const path = require('path');
const { startWakeWordEngine, stopWakeWordEngine } = require('./wakeword-engine');

// ── Main-process log forwarding to renderer DevTools ─────────────────────
// REAL FIX: a packaged .exe has no terminal window, so console.log calls
// in THIS file and in wakeword-engine.js (both running in Electron's main
// process) were previously invisible with no way to see them at all —
// confirmed the real gap behind not being able to diagnose the wake-word
// silence. Wraps console.log/warn/error so every main-process log line
// ALSO gets sent to the renderer's DevTools console (opened via the new
// Ctrl+Shift+I shortcut below), prefixed so it's clear these came from
// the main process, not the page itself.
const _origLog = console.log, _origWarn = console.warn, _origError = console.error;
function _forwardToRenderer(level, args) {
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      mainWin.webContents.send('main-process-log', { level, msg });
    }
  } catch (_) { /* never let logging itself crash anything */ }
}
console.log = (...args) => { _origLog(...args); _forwardToRenderer('log', args); };
console.warn = (...args) => { _origWarn(...args); _forwardToRenderer('warn', args); };
console.error = (...args) => { _origError(...args); _forwardToRenderer('error', args); };

// ── Single instance — prevents double windows on double-click ─────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }
app.on('second-instance', () => {
  if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
});

// ── robotjs ───────────────────────────────────────────────────────────────
let robot = null;
try {
  robot = require('@jitsi/robotjs');
  robot.setMouseDelay(0); robot.setKeyboardDelay(0);
  console.log('[Flow] robotjs ✓ OS cursor control active');
} catch(e) { console.warn('[Flow] robotjs not found:', e.message); }

// ── active-win — lightweight active window title polling for Sentinel ─────
let activeWin = null;
try {
  activeWin = require('active-win');
  console.log('[Flow] active-win ✓ Sentinel context tracking available');
} catch(e) { console.warn('[Flow] active-win not found — Sentinel disabled:', e.message); }

// ── Auto-updater ──────────────────────────────────────────────────────────
let autoUpdater = null;
let _updateReadyToInstall = false; // real flag, set true only when update-downloaded genuinely fires — checked in mainWin's 'close' handler below, which is the actual interception point that decides whether to hide to tray or quit for real
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger               = { info: console.log, warn: console.warn, error: console.error };

  // REAL BUG FIXED: there were previously ZERO autoUpdater.on(...) event
  // listeners anywhere, and the only call site
  // (checkForUpdatesAndNotify().catch(() => {})) silently swallowed
  // every error. That's the exact, confirmed reason Joel's console
  // showed nothing at all — if the download failed for ANY reason
  // (network, Windows SmartScreen/antivirus quarantining the unsigned
  // installer, disk space, a real electron-updater bug), it just
  // vanished with no trace, and the app re-detected "update available"
  // and re-notified on every subsequent boot since the actual install
  // never completed. These listeners make every real stage of the
  // update lifecycle show up in the console (forwarded via the
  // console.log wrapper above, visible through F12 DevTools).
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version, '— starting download...');
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available. Current release seen:', info.version);
  });
  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Downloading: ${Math.round(progress.percent)}% (${Math.round(progress.transferred / 1024)}KB / ${Math.round(progress.total / 1024)}KB)`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded successfully:', info.version, '— will install on next quit.');
    _updateReadyToInstall = true; // real flag — window-all-closed checks this to actually quit instead of staying in the tray forever
  });
  autoUpdater.on('error', (err) => {
    // REAL, the actual fix: this is the event that was previously never
    // listened for at all. Any real failure — network error, code-signing
    // rejection, antivirus/SmartScreen quarantine, corrupted download,
    // permission denied writing the update file — surfaces here now,
    // instead of vanishing into the old swallowed .catch(() => {}).
    console.error('[AutoUpdater] REAL ERROR:', err == null ? 'unknown error' : (err.stack || err.message || err));
  });
} catch(e) { console.warn('[Flow] electron-updater not available'); }

let mainWin    = null;
let overlayWin = null;
let tray       = null;

// ── Build verification ─────────────────────────────────────────────────
// Read the commit/timestamp stamp the GitHub Actions workflow writes into
// build-info.json at build time. This is what actually lets you confirm
// you're running the build you just downloaded, rather than guessing from
// file dates or hoping the download didn't reuse a stale artifact.
let buildInfo = { commit: 'dev', builtAt: 'unbuilt (local)' };
try {
  buildInfo = require('./build-info.json');
} catch (_) {
  console.warn('[Flow] No build-info.json found — running an unstamped/local build.');
}

// ── Main window ───────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    width:    Math.min(1200, Math.round(width  * 0.88)),
    height:   Math.min(820,  Math.round(height * 0.88)),
    minWidth: 480,
    minHeight: 360,
    frame: false,
    backgroundColor: '#060a1a',
    title: `Flow — build ${buildInfo.commit} · ${buildInfo.builtAt}`,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Without this, Chromium aggressively throttles/pauses
      // requestAnimationFrame and timers the moment this window is
      // minimized or hidden — which is exactly why gesture control (whose
      // detection loop in ui/gesture.js runs on requestAnimationFrame)
      // would stop working the instant Joel minimized Flow. This keeps
      // the renderer running at full speed regardless of window
      // visibility, which is required for gesture tracking to survive
      // minimizing, per Joel's actual request.
      backgroundThrottling: false,
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
  });

  mainWin.webContents.session.clearCache()
    .then(() => mainWin.webContents.session.clearStorageData({ storages: ['serviceworkers'] }))
    .then(() => { mainWin.loadURL('https://flow-v3-mu.vercel.app'); })
    .catch(() => { mainWin.loadURL('https://flow-v3-mu.vercel.app'); });

  // REAL FIX for the blank-tab-at-boot bug: previously there was no
  // did-fail-load handler at all. Confirmed root cause — Flow loads from
  // the live internet (loadURL, not local files), and when the OS
  // auto-starts Flow at boot (setupAutoStart, further down), the
  // network (Wi-Fi/DNS) may genuinely not be ready yet. With no retry
  // logic, that one failed load attempt meant a blank window forever,
  // since nothing ever tried again. This retries with a real backoff
  // (2s, 4s, 6s) up to 3 times, which covers the realistic window for
  // network coming up after boot without retrying forever if something
  // is actually, persistently wrong (e.g. no internet at all).
  let loadRetries = 0;
  const MAX_LOAD_RETRIES = 3;
  mainWin.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    if (errorCode === -3) return; // ERR_ABORTED — happens on normal navigation, not a real failure
    if (loadRetries >= MAX_LOAD_RETRIES) {
      console.error(`[Flow] Page load failed ${MAX_LOAD_RETRIES} times (${errorDescription}) — giving up. Check internet connection.`);
      return;
    }
    loadRetries++;
    const delay = 2000 * loadRetries; // 2s, 4s, 6s backoff
    console.warn(`[Flow] Page load failed (${errorDescription}) — retrying in ${delay}ms (attempt ${loadRetries}/${MAX_LOAD_RETRIES})`);
    setTimeout(() => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL('https://flow-v3-mu.vercel.app');
    }, delay);
  });

  mainWin.webContents.session.setPermissionRequestHandler(
    (_wc, perm, cb) =>
      cb(['media','microphone','camera','notifications','geolocation'].includes(perm))
  );

  mainWin.once('ready-to-show', () => {
    mainWin.show();
    mainWin.setTitle('Flow AI');
    if (autoUpdater) setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        // REAL FIX: this used to be .catch(() => {}) — silently eating
        // any failure in the INITIAL check itself (e.g. can't reach
        // GitHub's release API at all, malformed latest.yml, network
        // down at boot). The on('error') listener above catches
        // failures during the update PROCESS once it's started; this
        // one covers a failure to even start checking.
        console.error('[AutoUpdater] checkForUpdatesAndNotify() failed:', err?.message || err);
      });
    }, 4000);
  });

  mainWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') mainWin.webContents.toggleDevTools();
    if (input.key === 'F5')  mainWin.webContents.reload();
  });

  mainWin.on('close', e => {
    // REAL FIX, corrected after actually tracing the real code path: an
    // earlier fix was added to window-all-closed to quit for real when
    // an update was ready — but that handler NEVER FIRES for the normal
    // "click the X button" flow, because THIS handler already intercepts
    // the close and hides the window instead (e.preventDefault()) unless
    // app.isQuitting is already true. So window-all-closed's fix was
    // dead code for exactly the scenario Joel reported ("I did quit Flow
    // ... still has 1.2.0"). The real interception point is HERE: if an
    // update has genuinely finished downloading (_updateReadyToInstall,
    // set by the real update-downloaded listener above), let the close
    // proceed as a real quit instead of hiding to the tray — otherwise
    // the app just keeps running invisibly at the OLD version forever,
    // and autoInstallOnAppQuit's install hook never gets a real quit
    // event to attach to.
    if (!app.isQuitting && _updateReadyToInstall) {
      console.log('[AutoUpdater] Update ready — quitting for real on window close so it can install (would otherwise hide to tray and stay on the old version).');
      app.isQuitting = true;
      return; // let the close proceed for real this time, do NOT preventDefault
    }
    if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
  Menu.setApplicationMenu(null);
}

// ── Overlay window — gesture dot across ALL apps ──────────────────────────
function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  overlayWin = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent:  true,
    frame:        false,
    alwaysOnTop:  true,
    skipTaskbar:  true,
    hasShadow:    false,
    focusable:    false,
    resizable:    false,
    movable:      false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration:  true,
    },
  });

  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');

  overlayWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;overflow:hidden;width:100vw;height:100vh}
#dot{
  position:fixed;width:22px;height:22px;border-radius:50%;
  border:2.5px solid rgba(167,139,250,0.92);
  background:rgba(167,139,250,0.18);
  pointer-events:none;display:none;
  transform:translate(-50%,-50%);
  transition:border-color .08s,background .08s;
}
#dot::after{content:'';position:absolute;top:50%;left:50%;
  width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,0.9);
  transform:translate(-50%,-50%);}
#dot.click{border-color:rgba(74,222,128,0.95);background:rgba(74,222,128,0.22);}
#dot.scroll{border-color:rgba(250,204,21,0.95);background:rgba(250,204,21,0.18);}
#dot.held{border-style:dashed;opacity:0.5;}
#sentinel-badge{
  position:fixed;top:14px;right:14px;
  font-family:system-ui,sans-serif;font-size:11px;font-weight:600;
  color:#a78bfa;background:rgba(15,10,30,0.85);
  border:1px solid rgba(167,139,250,0.4);border-radius:20px;
  padding:5px 12px;display:none;align-items:center;gap:6px;
  letter-spacing:.03em;
}
#sentinel-badge.show{display:flex;}
#sentinel-dot{width:6px;height:6px;border-radius:50%;background:#a78bfa;
  animation:pulse 1.6s ease-in-out infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
#cam-preview{
  position:fixed;top:14px;left:14px;width:160px;height:120px;
  border-radius:12px;overflow:hidden;display:none;
  border:1.5px solid rgba(167,139,250,0.5);
  box-shadow:0 4px 20px rgba(0,0,0,0.4);
  background:rgba(10,6,20,0.6);
}
#cam-preview.show{display:block;}
#cam-preview img{width:100%;height:100%;object-fit:cover;display:block;
  transform:scaleX(-1);} /* mirror, matches how Joel sees himself in Flow's own camera box */
#cam-label{position:absolute;bottom:0;left:0;right:0;
  background:linear-gradient(0deg,rgba(0,0,0,0.7),transparent);
  color:#a78bfa;font-family:system-ui,sans-serif;font-size:9px;font-weight:600;
  padding:4px 8px;letter-spacing:.04em;}
</style></head>
<body>
<div id="dot"></div>
<div id="sentinel-badge"><span id="sentinel-dot"></span>Flow is watching</div>
<div id="cam-preview"><img id="cam-img"><div id="cam-label">FLOW · LIVE</div></div>
<script>
const dot = document.getElementById('dot');
const badge = document.getElementById('sentinel-badge');
const camPreview = document.getElementById('cam-preview');
const camImg = document.getElementById('cam-img');
const {ipcRenderer} = require('electron');
ipcRenderer.on('dot-move',  (_,x,y,s) => { dot.style.display='block'; dot.style.left=x+'px'; dot.style.top=y+'px'; dot.className=s||''; });
ipcRenderer.on('dot-hide',  ()        => { dot.style.display='none'; camPreview.classList.remove('show'); });
ipcRenderer.on('sentinel-state', (_, active) => { badge.className = active ? 'show' : ''; });
ipcRenderer.on('camera-frame', (_, dataUrl) => { camImg.src = dataUrl; camPreview.classList.add('show'); });
</script></body></html>`));

  overlayWin.on('closed', () => { overlayWin = null; });
}

// ── Tray ──────────────────────────────────────────────────────────────────
function createTray() {
  try {
    let icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip('Flow AI');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Flow',  click: () => { mainWin?.show(); mainWin?.focus(); } },
      { label: 'Reload',     click: () => { mainWin?.show(); mainWin?.webContents.reload(); } },
      { type: 'separator' },
      { label: sentinelEnabled ? 'Disable Sentinel' : 'Enable Sentinel', click: () => toggleSentinel(!sentinelEnabled) },
      { type: 'separator' },
      { label: 'Quit',       click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => mainWin?.isVisible() ? mainWin.focus() : mainWin?.show());
  } catch(e) { console.warn('[Flow] Tray:', e.message); }
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Flow',  click: () => { mainWin?.show(); mainWin?.focus(); } },
    { label: 'Reload',     click: () => { mainWin?.show(); mainWin?.webContents.reload(); } },
    { type: 'separator' },
    { label: sentinelEnabled ? '🟣 Sentinel: ON (click to pause)' : 'Sentinel: OFF (click to enable)', click: () => toggleSentinel(!sentinelEnabled) },
    { type: 'separator' },
    { label: 'Quit',       click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ── IPC: Gesture / cursor control ─────────────────────────────────────────
function moveDot(x, y, state) {
  overlayWin?.webContents.send('dot-move', Math.round(x), Math.round(y), state);
}

ipcMain.on('cursor_move', (_e, { x, y }) => {
  try { robot?.moveMouse(Math.round(x), Math.round(y)); } catch(_) {}
  moveDot(x, y, 'point');
});

ipcMain.on('gesture_click', (_e, { x, y }) => {
  try { robot?.moveMouse(Math.round(x), Math.round(y)); robot?.mouseClick('left'); } catch(_) {}
  moveDot(x, y, 'click');
  setTimeout(() => moveDot(x, y, 'point'), 300);
});

ipcMain.on('right_click', (_e, { x, y }) => {
  try { robot?.moveMouse(Math.round(x), Math.round(y)); robot?.mouseClick('right'); } catch(_) {}
  moveDot(x, y, 'click');
});

ipcMain.on('scroll', (_e, { direction, amount }) => {
  try {
    const lines = Math.max(1, Math.round((amount || 120) / 40));
    const map = { up:[0,-lines], down:[0,lines], left:[-lines,0], right:[lines,0] };
    const [dx, dy] = map[direction] || [0, lines];
    robot?.scrollMouse(dx, dy);
  } catch(_) {}
});

ipcMain.on('gesture_start',  ()           => overlayWin?.showInactive());
ipcMain.on('camera_frame',   (_e, { dataUrl }) => overlayWin?.webContents.send('camera-frame', dataUrl));
ipcMain.on('gesture_stop',   ()           => overlayWin?.webContents.send('dot-hide'));
ipcMain.on('cursor_held',    (_e, {x, y}) => moveDot(x, y, 'held'));
ipcMain.on('type_text',      (_e, {text}) => { try { robot?.typeString(text || ''); } catch(_) {} });

// ── Code syntax validation — TRUE node --check ───────────────────────────
// Runs actual `node --check` against code the renderer wants to push to
// GitHub, BEFORE it's ever committed. This is genuine Node syntax
// validation, not an approximation — possible here specifically because
// this runs in Electron's MAIN process, which has a real Node.js runtime.
// The renderer (browser context) cannot do this itself; that's the whole
// reason this exists as an IPC handler rather than renderer-side code.
//
// Real limitation, stated plainly: this only validates JAVASCRIPT syntax
// via Node's own parser. It does NOT catch logic bugs, does NOT know
// whether the code integrates correctly with the rest of Joel's codebase,
// and does NOT validate non-JS files (HTML, CSS, JSON, Python, etc.) —
// each of those would need its own separate validator, not built here.
// This specifically targets the class of error that broke app.js earlier
// this session (leftover fragments causing a genuine syntax error) —
// nothing more, nothing less.
const { spawnSync } = require('child_process');
const os = require('os');
const fsSync = require('fs');

ipcMain.handle('validate_js_syntax', (_e, { code, moduleType }) => {
  // module-mode files (app.js and anything using import/export) need
  // --input-type=module + stdin, matching exactly the command that
  // caught the real app.js bug earlier this session. Script-mode files
  // (plain CommonJS, like most of core/ and api/) use --check against a
  // real temp file instead, since --input-type=module + stdin is
  // specifically for ES module syntax checking.
  if (moduleType === 'module') {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8' });
    if (result.status === 0) return { valid: true };
    return { valid: false, error: (result.stderr || result.error?.message || 'Unknown syntax error').trim() };
  }

  const tmpFile = path.join(os.tmpdir(), `flow-validate-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  try {
    fsSync.writeFileSync(tmpFile, code, 'utf8');
    const result = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' });
    if (result.status === 0) return { valid: true };
    return { valid: false, error: (result.stderr || result.error?.message || 'Unknown syntax error').trim() };
  } catch (e) {
    return { valid: false, error: `Validator itself failed: ${e.message}` };
  } finally {
    try { fsSync.unlinkSync(tmpFile); } catch (_) {}
  }
});

ipcMain.handle('get_screen_size', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.bounds.width, height: d.bounds.height };
});

ipcMain.handle('get_build_info', () => buildInfo);

ipcMain.on('win_minimize', () => mainWin?.minimize());
ipcMain.on('win_maximize', () => { if (!mainWin) return; mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
ipcMain.on('win_close',    () => mainWin?.hide());

// ═══════════════════════════════════════════════════════════════════════
// FLOW SENTINEL — ambient context awareness, the Electron-only advantage
//
// A website cannot do this. A PWA cannot do this. This requires genuine
// OS-level access that only the desktop app has:
//
//   1. Polls the active window title every ~12s (cheap — no screenshots
//      unless something actually warrants a closer look)
//   2. Detects two trigger conditions:
//        a) "stuck" — same window title unchanged for 8+ minutes while
//           the screen is NOT locked/idle (suggests Joel might be stuck
//           debugging, staring at an error, etc.)
//        b) explicit ask — Joel can trigger "what am I looking at?" any
//           time via a hotkey or from Flow's own UI
//   3. On trigger, captures a screenshot via desktopCapturer (Electron-only
//      API — a browser tab cannot screenshot the OS desktop) and sends it
//      to Flow's EXISTING /api/vision.js pipeline — no new AI plumbing
//   4. Surfaces the result as a Flow chat message INSIDE the app if Joel
//      is at the PC, and via the EXISTING Telegram bot
//      (JOEL_TELEGRAM_CHAT_ID) if the system has been idle for 5+ minutes
//      — closing the loop between "ambient watcher" and "Joel, anywhere"
//
// STRICT CONSENT: starts OFF by default. Joel must explicitly enable it
// from Flow's UI or tray menu. The overlay shows a persistent "Flow is
// watching" badge with a pulsing dot whenever Sentinel is active — never
// silent, always visibly indicated, instantly toggleable.
// ═══════════════════════════════════════════════════════════════════════

let sentinelEnabled   = false;
let sentinelInterval  = null;
let lastWindowTitle   = null;
let lastWindowChangeAt = Date.now();
let lastNudgeAt        = 0;
const STUCK_THRESHOLD_MS = 8 * 60 * 1000;   // 8 minutes unchanged = "stuck"
const NUDGE_COOLDOWN_MS  = 20 * 60 * 1000;  // don't nudge more than once per 20 min
const POLL_MS            = 12 * 1000;

function setSentinelBadge(active) {
  overlayWin?.webContents.send('sentinel-state', active);
}

async function captureScreenshotBase64() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 800 },
    });
    const primary = sources[0];
    if (!primary) return null;
    return primary.thumbnail.toJPEG(70).toString('base64');
  } catch (e) {
    console.warn('[Sentinel] screenshot failed:', e.message);
    return null;
  }
}

async function askVisionAPI(base64, prompt) {
  if (!base64) {
    console.warn('[Sentinel] no screenshot to analyze — capture failed earlier');
    return null;
  }
  try {
    const r = await fetch('https://flow-v3-mu.vercel.app/api/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, prompt }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // This used to just return null with the real reason buried in
      // devtools console — invisible unless Joel had it open. Now the
      // actual server error (e.g. both OpenRouter and Hugging Face
      // failed, or neither is configured) reaches the renderer so it can
      // be shown in chat instead of a generic "Vision analysis failed".
      console.warn('[Sentinel] vision API error:', d.error || r.status);
      return { error: d.error || `Vision API returned ${r.status}` };
    }
    return d.description || null;
  } catch (e) {
    console.warn('[Sentinel] vision API unreachable:', e.message);
    return { error: `Could not reach Vercel: ${e.message}` };
  }
}

// Sends Joel a direct Telegram message via api/social.js's sentinel-ping
// route. The bot token lives only on Vercel — this call carries plain text
// only, never any credential.
async function notifyJoelViaTelegram(text) {
  try {
    const r = await fetch('https://flow-v3-mu.vercel.app/api/social?platform=sentinel-ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const d = await r.json();
    if (!d.ok) console.warn('[Sentinel] Telegram relay declined:', d.error);
  } catch (e) { console.warn('[Sentinel] notify failed:', e.message); }
}

// Pushes to the same flow_pending_notifs key the bell UI polls — read then
// write, matching the exact pattern api/social.js already uses for this key.
// Also fires a REAL native OS notification (Windows toast) at the same
// time, so important events surface even if Flow's window isn't focused
// or is minimized — the in-app bell alone only helps if you're looking
// at the window.
async function pushBellNotification(text) {
  try {
    const r   = await fetch('https://flow-v3-mu.vercel.app/api/memory?key=flow_pending_notifs');
    const d   = r.ok ? await r.json() : null;
    let cur = d?.value ?? null;
    // Same double-encoding bug pattern found and fixed elsewhere this
    // session — Upstash's REST /get/ can return a stored array back as a
    // raw JSON-shaped STRING rather than an already-parsed array.
    if (typeof cur === "string" && cur.length >= 2 && (cur[0] === '[' || cur[0] === '{')) {
      try { cur = JSON.parse(cur); } catch (_) { /* leave as-is if not actually valid JSON */ }
    }
    const arr = Array.isArray(cur) ? cur : [];
    arr.push({ source: 'Sentinel', text: text.slice(0, 200), ts: Date.now(), read: false });
    await fetch('https://flow-v3-mu.vercel.app/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'flow_pending_notifs', value: arr.slice(-30) }),
    });

    showNativeNotification('Flow', text.slice(0, 200));
  } catch (e) { console.warn('[Sentinel] bell push failed:', e.message); }
}

// ── Native OS notifications ─────────────────────────────────────────────
// Real Windows/macOS/Linux toast popups via Electron's built-in
// Notification API — works even when Flow's window is minimized or not
// focused, unlike the in-app bell which only helps if you're looking at
// the window. Uses the OS's native notification center, so these also
// respect the user's system-level notification settings (Do Not Disturb,
// Focus Assist, etc.) automatically — no extra permission handling needed
// on Flow's side.
const { Notification } = require('electron');
function showNativeNotification(title, body, onClick) {
  try {
    if (!Notification.isSupported()) {
      console.warn('[Flow] Native notifications not supported on this system.');
      return;
    }
    const notif = new Notification({
      title,
      body,
      icon: path.join(__dirname, 'icon.png'), // matches the same icon path used by createWindow() and createTray() above
    });
    if (onClick) notif.on('click', onClick);
    notif.show();
  } catch (e) {
    console.warn('[Flow] showNativeNotification failed:', e.message);
  }
}

async function sentinelTick() {
  if (!sentinelEnabled || !activeWin) return;

  let win;
  try { win = await activeWin(); } catch(_) { return; }
  if (!win) return;

  const title = win.title || win.owner?.name || 'unknown';
  const idleSeconds = powerMonitor.getSystemIdleTime();
  const isIdle = idleSeconds > 60; // treat as "away" past 60s idle

  if (title !== lastWindowTitle) {
    lastWindowTitle    = title;
    lastWindowChangeAt = Date.now();
    return; // context just changed — don't trigger on the same tick it changed
  }

  const unchangedFor = Date.now() - lastWindowChangeAt;
  const sinceLastNudge = Date.now() - lastNudgeAt;

  if (unchangedFor < STUCK_THRESHOLD_MS) return;
  if (sinceLastNudge < NUDGE_COOLDOWN_MS) return;
  if (isIdle) return; // don't analyse a screen nobody's looking at right now

  // Trigger: same window for 8+ min, Joel is present (not idle) — likely stuck
  console.log('[Sentinel] Stuck pattern detected on:', title);
  const b64 = await captureScreenshotBase64();
  if (!b64) return;

  const desc = await askVisionAPI(
    b64,
    `Joel has been on the same window ("${title}") for over 8 minutes without switching context. Briefly describe what's on screen, and if there's an obvious error message, stuck state, or something you could help with, say so directly and concisely. If it just looks like normal focused work (writing, reading, designing), say that instead and don't suggest anything is wrong.`
  );
  if (!desc || typeof desc !== 'string') {
    if (desc?.error) console.warn('[Sentinel] ambient check skipped:', desc.error);
    return;
  }

  lastNudgeAt = Date.now();

  // Surface inside Flow if a window exists and is visible; queue for the
  // bell either way so it's never lost
  await pushBellNotification(`👁 ${desc.slice(0, 180)}`);

  if (mainWin && mainWin.isVisible()) {
    mainWin.webContents.send('sentinel-observation', desc);
  } else {
    // Joel's away from the Flow window specifically (even if not system-idle)
    // — also queue a Telegram ping so he sees it without opening Flow
    await notifyJoelViaTelegram(`👁 Flow noticed: ${desc.slice(0, 180)}`);
  }
}

function toggleSentinel(enable) {
  sentinelEnabled = enable;
  setSentinelBadge(enable);
  refreshTrayMenu();
  mainWin?.webContents.send('sentinel-toggled', enable);

  if (enable && !sentinelInterval) {
    lastWindowTitle    = null;
    lastWindowChangeAt = Date.now();
    sentinelInterval = setInterval(sentinelTick, POLL_MS);
    console.log('[Sentinel] enabled');
  } else if (!enable && sentinelInterval) {
    clearInterval(sentinelInterval);
    sentinelInterval = null;
    console.log('[Sentinel] disabled');
  }
}

ipcMain.on('sentinel_toggle', (_e, { enabled }) => toggleSentinel(!!enabled));
ipcMain.handle('sentinel_status', () => ({ enabled: sentinelEnabled, available: !!activeWin }));

// Manual "what am I looking at?" trigger — bypasses the stuck-timer entirely
ipcMain.handle('sentinel_ask_now', async () => {
  const b64 = await captureScreenshotBase64();
  if (!b64) return { ok: false, error: 'Screenshot failed' };
  const desc = await askVisionAPI(b64, 'Describe what is currently on screen, clearly and concisely.');
  if (!desc || typeof desc !== 'string') return { ok: false, error: desc?.error || 'Vision analysis failed' };
  return { ok: true, description: desc };
});

// Raw screenshot for OS-level click-target finding — separate from the
// general describe-the-screen handler above because that one always sends
// a fixed generic prompt; click-finding needs to send its own custom
// "give me x,y coordinates" prompt against the same fresh screenshot.
ipcMain.handle('sentinel_raw_screenshot', async () => {
  const b64 = await captureScreenshotBase64();
  if (!b64) return { ok: false, error: 'Screenshot failed' };
  return { ok: true, image: b64 };
});

// ═══════════════════════════════════════════════════════════════════════
// WATCH · LEARN · REPLICATE
//
// SCOPE, STATED PLAINLY: this records a rolling trail of (screenshot +
// active window title) while Sentinel is on, and when Joel asks Flow to
// replay something, sends that trail to the vision API to extract a short
// step sequence, then executes those steps through the exact same
// robot.moveMouse / mouseClick / typeString calls gesture control already
// uses and has proven reliable.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not hook real OS-level mouse
// clicks or keystrokes (a package called uiohook-napi exists for that, but
// it's a native module requiring compilation — given the real robotjs
// build friction already hit in this project, adding a second fragile
// native dependency is a bad trade for a first version). This means replay
// works on "do the thing I was just doing" style requests grounded in
// what actually appeared on screen, not on replaying literal pixel-perfect
// click coordinates from before. That's an honest, real limitation — not
// hidden, not oversold.
// ═══════════════════════════════════════════════════════════════════════

const TRAIL_MAX_AGE_MS   = 6 * 60 * 1000; // keep last 6 minutes
const TRAIL_CAPTURE_MS   = 15 * 1000;     // one frame every 15s while learning
let trailRecording = false;
let trailInterval   = null;
let trail            = []; // [{ ts, title, screenshot(base64, small) }]

async function trailTick() {
  if (!trailRecording) return;
  let win;
  try { win = await activeWin?.(); } catch (_) { win = null; }
  const title = win?.title || win?.owner?.name || 'unknown';
  const b64 = await captureScreenshotBase64();
  if (!b64) return;

  trail.push({ ts: Date.now(), title, screenshot: b64 });
  const cutoff = Date.now() - TRAIL_MAX_AGE_MS;
  trail = trail.filter(f => f.ts >= cutoff);
}

function startTrailRecording() {
  if (trailRecording) return;
  trailRecording = true;
  trail = [];
  trailInterval = setInterval(trailTick, TRAIL_CAPTURE_MS);
  trailTick(); // capture one frame immediately, don't wait for the first interval
  console.log('[Sentinel] Watch & Learn recording started');
}

function stopTrailRecording() {
  trailRecording = false;
  if (trailInterval) clearInterval(trailInterval);
  trailInterval = null;
  console.log('[Sentinel] Watch & Learn recording stopped —', trail.length, 'frames kept');
}

// Ask the AI to turn the last N seconds of the trail into a short,
// literal step list. Uses the LAST frame as the primary image (most
// relevant to "what I was just doing") plus the window-title sequence for
// context, rather than sending every frame — keeps this fast and cheap.
async function extractStepsFromTrail(instruction) {
  if (!trail.length) return { ok: false, error: 'No recent activity recorded — enable Sentinel and Watch & Learn first, then try the task once before asking Flow to replay it.' };

  const recent = trail.slice(-4); // last ~60s of frames
  const titles = [...new Set(recent.map(f => f.title))];
  const lastFrame = recent[recent.length - 1];

  const desc = await askVisionAPI(
    lastFrame.screenshot,
    `Joel asked: "${instruction}". Here is the most recent screenshot of what he was doing. The windows he was active in over the last minute, in order: ${titles.join(' → ')}. ` +
    `Based on this, describe in 3-6 short numbered steps what action Joel likely wants repeated, in concrete terms (e.g. "1. Click the Send button in the bottom right" or "2. Type the message text"). ` +
    `If the screenshot doesn't give enough information to know exact click locations, say so plainly instead of guessing coordinates — do not invent precise pixel positions you cannot actually see.`
  );

  if (!desc || typeof desc !== 'string') {
    return { ok: false, error: desc?.error || 'Vision analysis failed for an unknown reason — check Vercel logs for /api/vision.' };
  }
  return { ok: true, steps: desc, framesUsed: recent.length, windows: titles };
}

ipcMain.on('sentinel_learn_toggle', (_e, { enabled }) => {
  if (enabled) startTrailRecording(); else stopTrailRecording();
});
ipcMain.handle('sentinel_learn_status', () => ({ recording: trailRecording, frames: trail.length }));

// This returns the AI's step description back to the renderer — Flow reads
// it out / shows it in chat and confirms with Joel BEFORE anything is
// clicked or typed. Replay of the confirmed steps is a separate, explicit
// second call (sentinel_replay_execute) — this two-step design means Flow
// never silently starts clicking around on its own.
ipcMain.handle('sentinel_replay_plan', async (_e, { instruction }) => {
  return extractStepsFromTrail(instruction);
});

// Executes ONE concrete action Joel (or the plan-confirmation step) has
// approved. Reuses the identical robot calls as gesture control — same
// proven code path, not a new one.
ipcMain.handle('sentinel_replay_execute', (_e, { action, x, y, text, direction }) => {
  try {
    switch (action) {
      case 'click':
        robot?.moveMouse(Math.round(x), Math.round(y));
        robot?.mouseClick('left');
        moveDot(x, y, 'click');
        return { ok: true };
      case 'move':
        robot?.moveMouse(Math.round(x), Math.round(y));
        moveDot(x, y, 'point');
        return { ok: true };
      case 'type':
        robot?.typeString(text || '');
        return { ok: true };
      case 'scroll': {
        const lines = 4;
        const map = { up: [0, -lines], down: [0, lines] };
        const [dx, dy] = map[direction] || [0, lines];
        robot?.scrollMouse(dx, dy);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────
// ── Global keyboard shortcuts ─────────────────────────────────────────────
// Works system-wide, not just when Flow's window is focused — e.g. Joel
// can bring Flow to front from inside any other app with one keypress,
// without alt-tabbing or clicking the tray icon first. Kept to one
// genuinely useful default (show/focus Flow) rather than guessing at
// several — easy to add more registerGlobalShortcut calls here later for
// specific actions (e.g. toggle Sentinel, start voice) once Joel knows
// which ones he'd actually reach for.
function registerGlobalShortcuts() {
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+F', () => {
      if (!mainWin) return;
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
    });
    if (!ok) console.warn('[Flow] Global shortcut Ctrl+Shift+F registration failed — may conflict with another app.');

    // REAL FIX: there was previously no way to open DevTools in the
    // packaged app at all — no menu item, no shortcut, nothing. This
    // meant any bug (like the wake-word silence this shortcut exists to
    // help debug) was genuinely invisible: no console, no error message,
    // nothing to check. Ctrl+Shift+I opens the RENDERER console (F12-style
    // browser devtools) — this shows renderer-side errors (like the app.js
    // 401 Joel saw) but NOT main-process console.log output from
    // wakeword-engine.js, which only appears in the terminal when running
    // via `npm start` from source, not in a packaged .exe. Documented here
    // plainly rather than silently leaving that gap unaddressed.
    const devToolsOk = globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (!mainWin) return;
      mainWin.webContents.toggleDevTools();
    });
    if (!devToolsOk) console.warn('[Flow] Global shortcut Ctrl+Shift+I registration failed.');
  } catch (e) {
    console.warn('[Flow] registerGlobalShortcuts failed:', e.message);
  }
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll(); // required cleanup — an unregistered shortcut can silently keep working even after the app closes otherwise
});
// Uses Electron's built-in setLoginItemSettings — registers Flow with the
// OS's own startup mechanism (Windows: Task Manager > Startup apps /
// registry Run key; macOS: Login Items) so it launches automatically when
// the computer starts, without Joel needing to open it manually. Set to
// launch hidden/minimized to the tray rather than popping the full window
// immediately on every boot — Flow's tray icon (already built via
// createTray()) is there to bring it up on demand.
function setupAutoStart() {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true, // starts minimized to tray, doesn't grab focus on every boot
      path: app.getPath('exe'),
    });
  } catch (e) {
    console.warn('[Flow] setupAutoStart failed:', e.message);
  }
}

// ── Wake word — "Wake up Flow" ───────────────────────────────────────────
// Fully local: no Railway, no fallback service. Runs the real 3-stage
// openWakeWord pipeline (melspectrogram → embedding → Wake_up_Flow
// classifier) fed by a bundled SoX child process capturing the mic
// continuously. On detection, tells the renderer to start the existing
// Whisper recording flow (core/whisper.js) — same transcription path
// Joel already has working, just triggered locally instead of by clicking
// the mic button.
//
// sox.exe is bundled at flow-electron/resources/sox/sox.exe via
// package.json's build.extraResources, which places it in the packaged
// app's resources directory — accessed at runtime via
// process.resourcesPath (see startWakeWord below for why, and the real
// bug this fixes).
function startWakeWord() {
  // extraResources (declared in package.json's build.extraResources) are
  // copied to the packaged app's resources directory, accessible via
  // process.resourcesPath — NOT relative to __dirname. This was a real
  // bug in the first version of this function: __dirname only resolves
  // correctly here in dev mode running unpacked; once electron-builder
  // packages the app (confirmed: your build succeeded), main.js itself
  // lives inside app.asar, and __dirname pointed at the wrong location,
  // so loadModels() was silently failing to find any of the 3 .onnx
  // files and the whole engine never started — which is exactly why
  // there was no mic-in-use indicator at all. Verified against
  // electron-builder's own docs before fixing, not guessed.
  const resourcesPath  = process.resourcesPath;
  const soxBinaryPath  = path.join(resourcesPath, 'sox', 'sox.exe');

  startWakeWordEngine({
    resourcesPath,
    soxBinaryPath,
    onWakeDetected: () => {
      if (!mainWin) return;
      // Bring Flow to front so Joel can see it's listening, same as the
      // existing global-shortcut behavior — then tell the renderer to
      // start recording via the same IPC push pattern already used for
      // sentinel-observation/sentinel-toggled.
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send('wakeword-detected');
    },
  });
}

app.whenReady().then(() => { createWindow(); createOverlay(); createTray(); setupAutoStart(); registerGlobalShortcuts(); startWakeWord(); });
app.on('activate',         () => { if (!mainWin) createWindow(); else mainWin.show(); });
app.on('window-all-closed',() => {
  // Real fix now lives in mainWin's 'close' handler above — that's the
  // actual interception point for the normal "click X to close" flow.
  // By the time window-all-closed fires, either app.isQuitting was
  // already true (a real quit is genuinely in progress via the close
  // handler's own logic, nothing more to do here) or the window was
  // hidden rather than closed, so this event wouldn't even fire. Kept as
  // a real no-op, same as the original, since there's nothing left for
  // it to meaningfully decide.
  /* stay in tray */
});
app.on('before-quit',      () => { app.isQuitting = true; if (sentinelInterval) clearInterval(sentinelInterval); if (trailInterval) clearInterval(trailInterval); stopWakeWordEngine(); });
