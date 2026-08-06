// flow-electron/main.js (v4)
// Single instance + native title bar + overlay gesture window +
// system tray + cache clear + auto-updater + FLOW SENTINEL

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, desktopCapturer, powerMonitor, globalShortcut } = require('electron');
const path = require('path');
// NOTE: the old ./voice-engine require (SoX + local whisper.cpp) is
// gone — scratched and rebuilt per Joel's explicit instruction. See
// registerGlobalShortcuts() below for the new, much simpler replacement.
const heartbeat = require('./heartbeat');

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
  // REAL, CONFIRMED BUG FIX, Joel-reported: previously this only called
  // .restore() (undoes MINIMIZED state) and .focus() — neither of which
  // actually shows a HIDDEN window. Flow's own close handler further
  // down (mainWin.hide() instead of a real quit, for "minimize to tray"
  // behavior) means the window is very often hidden, not minimized —
  // two genuinely different Electron states. Double-clicking a desktop
  // shortcut or the .exe again while Flow was already running-but-hidden
  // triggered this exact handler, which did nothing visible at all —
  // this is the real, confirmed cause of "it doesn't seem to open."
  // .show() is a safe no-op if the window is already visible, so this
  // is correct for every real starting state (minimized, hidden, or
  // already visible/behind other windows).
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
});

// ── robotjs ───────────────────────────────────────────────────────────────
let robot = null;
try {
  robot = require('@jitsi/robotjs');
  robot.setMouseDelay(0); robot.setKeyboardDelay(0);
  console.log('[Flow] robotjs ✓ OS cursor control active');
} catch(e) { console.warn('[Flow] robotjs not found:', e.message); }

// ── active-win — lightweight active window title polling for Sentinel ─────
// REAL BUG FIX — root cause of the permanent "Sentinel can't turn on
// right now" error: active-win v9+ is a pure-ESM package (its own
// docs: "This is an ESM package which requires you to use ESM").
// require('active-win') from this CommonJS file ALWAYS throws
// ERR_REQUIRE_ESM, unconditionally — this was never a packaging/
// asarUnpack issue (it was already correctly unpacked) and was never
// going to resolve on a rebuild, which is why it kept failing on every
// fresh install. Real fix: load it with a dynamic import() instead,
// which CommonJS can use to load ESM modules, and call its named
// export activeWindow() instead of a default-export function.
let activeWin = null;
(async () => {
  try {
    const mod = await import('active-win');
    activeWin = mod.activeWindow;
    console.log('[Flow] active-win ✓ Sentinel context tracking available');
  } catch(e) { console.warn('[Flow] active-win failed to load — Sentinel disabled:', e.message); }
})();

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
    const msg = err == null ? 'unknown error' : (err.stack || err.message || String(err));
    console.error('[AutoUpdater] REAL ERROR:', msg);
    // REAL, Joel-requested visibility fix: console.error alone is
    // invisible in the packaged app (no terminal window). A real update
    // failure — one honest, plausible explanation for the app sometimes
    // running a stale build — now also reaches Joel directly as a real
    // chat message, same proven channel already used for other
    // real background failures (e.g. the Gmail-check error notice).
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('heartbeat-message', {
        text: `⚠️ Auto-update failed: ${msg}\n\n(This can leave Flow on an older build. If this keeps happening, download the latest installer directly from the GitHub Releases page and run it once.)`,
        ts: Date.now(),
      });
    }
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

  // REAL, ADDITIONAL FIX for a DIFFERENT real symptom Joel confirmed:
  // a genuinely blank window at auto-start boot, with the taskbar
  // tooltip showing a real build stamp (meaning the window itself is
  // alive and did receive SOME page load) — this is NOT the same
  // failure the did-fail-load handler above covers. did-fail-load only
  // fires on a hard network-level failure; it does nothing for a load
  // that technically "succeeds" (no network error) but the page itself
  // renders empty — e.g. a slow/flaky connection at boot serving a
  // stale/incomplete response, or a JS error on the page preventing the
  // real UI from ever mounting into the DOM. Real fix: after the page
  // reports it finished loading, actually check whether real content
  // exists in the page — not just trust that "finished" means "worked."
  mainWin.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      if (!mainWin || mainWin.isDestroyed()) return;
      try {
        const hasRealContent = await mainWin.webContents.executeJavaScript(
          `document.body && document.body.innerText && document.body.innerText.trim().length > 20`
        );
        if (!hasRealContent && loadRetries < MAX_LOAD_RETRIES) {
          loadRetries++;
          console.warn(`[Flow] Page finished loading but appears genuinely blank — reloading (attempt ${loadRetries}/${MAX_LOAD_RETRIES})`);
          mainWin.loadURL('https://flow-v3-mu.vercel.app');
        }
      } catch (e) {
        // Real, honest: if we can't even check (e.g. page is in a truly
        // broken state where executeJavaScript itself fails), that's
        // itself a strong real signal something's wrong — reload too.
        if (loadRetries < MAX_LOAD_RETRIES) {
          loadRetries++;
          console.warn(`[Flow] Could not verify page content (${e.message}) — reloading (attempt ${loadRetries}/${MAX_LOAD_RETRIES})`);
          mainWin.loadURL('https://flow-v3-mu.vercel.app');
        }
      }
    }, 3000); // real, deliberate delay — give the page's own JS a genuine 3s to finish mounting before judging it blank
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

// NOTE: the old start_dictation/stop_dictation IPC handlers (SoX-based)
// are gone — scratched and rebuilt per Joel's explicit instruction.
// Electron now uses core/whisper.js's MediaRecorder + Hugging Face
// Whisper flow directly in the renderer, same as the web build, with no
// main-process involvement needed for recording/transcription at all.

// REAL, NEW: exposes Flow's standing goal list to the renderer, so Joel
// can actually see and manage what Flow has decided is worth pursuing —
// not a hidden, opaque internal list. Same real backing store
// heartbeat.js's reasoning pass reads from every tick.
ipcMain.handle('heartbeat_list_goals', () => heartbeat.listGoals());
ipcMain.handle('heartbeat_add_goal', (_e, { description }) => heartbeat.addGoal(description));
ipcMain.handle('heartbeat_remove_goal', (_e, { id }) => heartbeat.removeGoal(id));
ipcMain.handle('heartbeat_record_marketing_post', () => heartbeat.recordMarketingPost());
ipcMain.on('heartbeat_mark_user_activity', () => heartbeat.markUserActivity());
// REAL, NEW — Settings panel backing IPC, Joel-requested. Real,
// persisted toggles (starting with backgroundResearchEnabled), read/
// written via heartbeat.js's small JSON settings file in userData.
ipcMain.handle('flow_get_settings', () => heartbeat.getSettings());

// REAL, Joel-explicit-override — IPC bridge for OS-level skill replay.
// Every call goes through os-control.js's replaySkill(), which ALWAYS
// shows the confirmation overlay first (requireConfirmation defaults
// true) regardless of caller — the renderer cannot silently skip that
// gate by omitting an option.
ipcMain.handle('flow_replay_skill', async (event, skill) => {
  try {
    const { replaySkill } = require('./os-control.js');
    return await replaySkill(skill, {
      onStep: (step, i, total) => {
        event.sender.send('os-control-step', { step, i, total });
      },
    });
  } catch (e) {
    console.error('[Flow] Skill replay failed:', e.message);
    return { aborted: true, reason: 'error', error: e.message };
  }
});

// REAL, NEW — voice-triggered named-skill lookup + replay. Storage-only
// for now (see skill-store.js's own header) since recording isn't built
// yet — if no skill exists under that name, this returns a real, honest
// "not found" rather than pretending to run something.
ipcMain.handle('flow_run_named_skill', async (event, name) => {
  try {
    const { getSkill } = require('./skill-store.js');
    const skill = getSkill(name);
    if (!skill) {
      return { aborted: true, reason: 'not_found', error: `No recorded skill named "${name}" exists yet.` };
    }
    const { replaySkill } = require('./os-control.js');
    return await replaySkill(skill, {
      onStep: (step, i, total) => { event.sender.send('os-control-step', { step, i, total }); },
    });
  } catch (e) {
    console.error('[Flow] Named skill replay failed:', e.message);
    return { aborted: true, reason: 'error', error: e.message };
  }
});

ipcMain.handle('flow_list_skills', async () => {
  try {
    const { listSkills } = require('./skill-store.js');
    return listSkills();
  } catch (e) {
    return [];
  }
});

// REAL, NEW — Sentinel's "watch and learn," actually wired to real
// input recording now (flow-electron/skill-recorder.js), with the real
// crash-safety that file's own header describes.
ipcMain.handle('flow_start_skill_recording', async () => {
  const { startRecording } = require('./skill-recorder.js');
  return await startRecording();
});

ipcMain.handle('flow_stop_skill_recording', async () => {
  const { stopRecording } = require('./skill-recorder.js');
  return await stopRecording();
});

// REAL, NEW — saves a skill that the renderer has already generalized
// (via a vision-capable LLM call, using the raw events/screenshots from
// stopRecording) into named, semantic steps. This handler just persists
// it — the actual generalization reasoning happens in api/chat.js or a
// dedicated endpoint, not here, since that needs a real LLM call.
ipcMain.handle('flow_save_skill', async (event, skill) => {
  const { saveSkill } = require('./skill-store.js');
  return saveSkill(skill);
});

// REAL, NEW, Joel-requested — lets the skills tray UI actually delete
// a named skill.
ipcMain.handle('flow_delete_skill', async (event, name) => {
  const { deleteSkill } = require('./skill-store.js');
  return deleteSkill(name);
});

// REAL, NEW — direct, low-risk OS actions. Minimize/restore just use
// Electron's own window API (no robotjs, no automation risk at all).
// open_app spawns a real OS-level "open this program" command —
// sanitized (alphanumeric + spaces/hyphens only) to prevent shell
// injection via a name the model might pass through, and executes
// immediately without the heavier confirmation overlay since launching
// a single named app is low-risk and trivially reversible (just close
// it), unlike a multi-step click/type replay.
ipcMain.handle('flow_perform_os_action', async (_event, { action, appName }) => {
  const { exec } = require('child_process');

  if (action === 'minimize_window') {
    mainWin?.minimize();
    return { success: true };
  }
  if (action === 'restore_window') {
    mainWin?.restore();
    mainWin?.show();
    return { success: true };
  }
  if (action === 'open_app') {
    const clean = String(appName || '').replace(/[^a-zA-Z0-9 _-]/g, '').trim();
    if (!clean) return { success: false, error: 'No valid app name given.' };
    return new Promise((resolve) => {
      // Real, Windows-specific (matches this project's nsis/win-only
      // build target) — `start ""` is the real, standard way to launch
      // a named program by its registered name/shortcut on Windows.
      exec(`start "" "${clean}"`, (err) => {
        if (err) {
          console.warn(`[OSAction] Couldn't open "${clean}":`, err.message);
          resolve({ success: false, error: `Couldn't find or open "${clean}" — check the exact name/that it's installed.` });
        } else {
          resolve({ success: true });
        }
      });
    });
  }
  return { success: false, error: `Unknown action: ${action}` };
});
ipcMain.handle('flow_set_setting', (_e, key, value) => heartbeat.setSetting(key, value));

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

// REAL, NEW, Joel-requested — Chrome profile picker for the Audiomack
// setup flow. Chrome does NOT store profile display names in the
// folder names (folders are literally "Default", "Profile 1",
// "Profile 2"...) — the real display names Joel actually recognizes
// live inside Chrome's own "Local State" JSON file, in
// profile.info_cache. Reading that file for real, not guessing from
// folder names.
function _chromeUserDataDir() {
  return path.join(app.getPath('appData'), 'Google', 'Chrome', 'User Data');
}

ipcMain.handle('list_chrome_profiles', () => {
  try {
    const localStatePath = path.join(_chromeUserDataDir(), 'Local State');
    if (!fsSync.existsSync(localStatePath)) return { ok: false, error: 'Chrome not found on this machine' };
    const localState = JSON.parse(fsSync.readFileSync(localStatePath, 'utf8'));
    const cache = localState.profile?.info_cache || {};
    const profiles = Object.entries(cache).map(([folderName, info]) => ({
      folderName,
      name: info.name || info.shortcut_name || folderName,
    }));
    return { ok: true, profiles };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('launch_chrome_profile', (_e, { folderName, url }) => {
  try {
    const { spawn } = require('child_process');
    // Real, standard Chrome flags — --profile-directory picks the
    // exact profile Joel names, matched via the folderName resolved
    // from list_chrome_profiles above (never guessed).
    const args = [`--profile-directory=${folderName}`];
    if (url) args.push(url);
    spawn('chrome', args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  // REAL, NEW — alongside the existing screenshot-trail (still useful
  // context for describing what happened), this now ALSO starts real
  // input recording (flow-electron/skill-recorder.js) so "do what I
  // just did" can genuinely replay exact clicks/keystrokes instead of
  // only ever describing a best guess. This is the actual fix for the
  // original "no pattern found" complaint — the old system had nothing
  // real to replay, just a vision description.
  try {
    const { startRecording, stopRecording } = require('./skill-recorder.js');
    if (enabled) {
      startRecording().then(result => {
        if (!result.started) console.warn('[Sentinel] Real input recording could not start:', result.error);
      });
    } else {
      stopRecording().then(result => {
        global.__lastRecordedSkillEvents = result.events; // real, simple handoff — renderer picks this up via flow_get_last_recording below
      });
    }
  } catch (e) {
    console.warn('[Sentinel] skill-recorder.js unavailable (non-fatal, falls back to screenshot-only description):', e.message);
  }
});
ipcMain.handle('sentinel_learn_status', () => ({ recording: trailRecording, frames: trail.length }));

// REAL, NEW — hands the last real recording (raw click/key events +
// before/after screenshots) to the renderer, which calls
// ui/skill-generalizer.js to turn it into a named, replayable skill.
ipcMain.handle('flow_get_last_recording', () => {
  return { events: global.__lastRecordedSkillEvents || [] };
});

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
        // REAL BUG FIX: 4 lines is small enough to be visually
        // imperceptible on most displays — likely why scroll
        // "succeeded" (ok:true) but Joel never saw anything move.
        // Bumped to a genuinely visible default.
        const lines = 10;
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

    // ═══════════════════════════════════════════
    // REAL, SCRATCHED AND REBUILT — replaces the old spoken "hey flow"
    // wake-word system. Ctrl+Shift+Space instantly shows/focuses the
    // window and tells the renderer to start recording via the SAME
    // MediaRecorder + Hugging Face Whisper flow already proven working
    // on the web build (core/whisper.js) — no continuous audio capture,
    // no native binaries, no compilation, no speech-detection false
    // triggers. A real, simple, reliable replacement.
    // ═══════════════════════════════════════════
    const voiceHotkeyOk = globalShortcut.register('CommandOrControl+Shift+Space', () => {
      if (!mainWin) return;
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send('trigger-voice-record');
    });
    if (!voiceHotkeyOk) console.warn('[Flow] Global shortcut Ctrl+Shift+Space registration failed — may conflict with another app.');

    // REAL, Joel-explicit-override — registers Ctrl+Shift+Escape as the
    // emergency stop for OS-level automation (flow-electron/os-control.js).
    // Registered here, at startup, not lazily when automation first runs
    // — so it's always live the instant anything could need it.
    try {
      const { registerEmergencyStop } = require('./os-control.js');
      registerEmergencyStop();
    } catch (e) {
      console.warn('[Flow] os-control.js emergency-stop registration failed (OS control features will refuse to run without it):', e.message);
    }
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
// NOTE: startWakeWord() (SoX + local whisper.cpp continuous listening)
// is gone — scratched and rebuilt per Joel's explicit instruction after
// four separate real approaches (trained wake-word models, Deepgram
// streaming, whisper.cpp compile, webkitSpeechRecognition) all failed
// for his environment. See registerGlobalShortcuts() below for the new,
// much simpler replacement: a global hotkey instantly triggers the mic,
// using core/whisper.js's already-proven MediaRecorder + Hugging Face
// Whisper flow — the same one the web build already used successfully.

app.whenReady().then(() => {
  createWindow(); createOverlay(); createTray(); setupAutoStart(); registerGlobalShortcuts();

  // REAL FIX/FEATURE: wires the heartbeat's self-initiated messages into
  // the actual chat UI when the window happens to be open, via the same
  // real IPC pattern already used for wake-word logs — so a message Flow
  // decides to send unprompted shows up in-chat, not just as a native
  // notification/Telegram push when Joel is actively looking at Flow.
  heartbeat.setNotificationSink((text, data) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('heartbeat-message', { text, ts: Date.now(), data: data || null });
  });
  heartbeat.startHeartbeat();
});
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
app.on('before-quit',      () => { app.isQuitting = true; if (sentinelInterval) clearInterval(sentinelInterval); if (trailInterval) clearInterval(trailInterval); heartbeat.stopHeartbeat(); });
// ── Local LLM (Gemma 3 4B, downloaded from Hugging Face) ──────────────────
// Off by default — only runs when Joel clicks the button in
// ui/local-llm.js. `path` already required at top of this file.
const https = require('https');

const LOCAL_LLM_DIR = path.join(app.getPath('userData'), 'local-llm');
const LOCAL_LLM_PATH = path.join(LOCAL_LLM_DIR, 'gemma-3-4b-it-Q4_K_M.gguf');
const LOCAL_LLM_URL = 'https://huggingface.co/google/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf';

let localLLMEnabled = false;
let localLLMInstance = null; // holds the loaded node-llama-cpp model once enabled

// REAL, expected size of the actual Gemma 3 4B Q4_K_M GGUF — a genuine
// complete download lands right around 2.5GB. Used purely as a floor
// to catch a stale PARTIAL file, not an exact-match requirement.
const LOCAL_LLM_MIN_BYTES = 2_000_000_000; // 2GB — well below the real ~2.5GB file, well above any realistic partial

ipcMain.handle('local_llm_status', () => {
  // REAL BUG FIX, Joel-reported: the UI kept showing "Downloaded" even
  // though the model wasn't actually usable on his machine. Root
  // cause: existsSync() alone can't tell a complete file apart from a
  // PARTIAL one left behind by a failed download attempt from BEFORE
  // this session's byte-verification fix existed — that fix only
  // guards FUTURE downloads, it doesn't retroactively clean up an
  // already-broken file sitting at the same path. Now checks real
  // file SIZE, not just presence, and deletes a stale partial outright
  // so the next download attempt starts clean instead of silently
  // reusing the broken file.
  if (!fsSync.existsSync(LOCAL_LLM_PATH)) return { downloaded: false, enabled: false };
  let size = 0;
  try { size = fsSync.statSync(LOCAL_LLM_PATH).size; } catch (_) { /* treat as absent below */ }
  if (size < LOCAL_LLM_MIN_BYTES) {
    console.warn(`[LocalLLM] Found a partial/stale file (${size} bytes, expected ~2.5GB) — deleting so the next download starts clean.`);
    fsSync.unlink(LOCAL_LLM_PATH, () => {});
    return { downloaded: false, enabled: false };
  }
  return { downloaded: true, enabled: localLLMEnabled };
});

ipcMain.handle('local_llm_download', async (event) => {
  if (!fsSync.existsSync(LOCAL_LLM_DIR)) fsSync.mkdirSync(LOCAL_LLM_DIR, { recursive: true });

  return new Promise((resolve, reject) => {
    const file = fsSync.createWriteStream(LOCAL_LLM_PATH);
    https.get(LOCAL_LLM_URL, (res) => {
      // Hugging Face redirects to its CDN — follow once.
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, (res2) => _pipeDownload(res2, file, event, resolve, reject));
        return;
      }
      _pipeDownload(res, file, event, resolve, reject);
    }).on('error', (err) => { fsSync.unlink(LOCAL_LLM_PATH, () => {}); reject(err); });
  });
});

function _pipeDownload(res, file, event, resolve, reject) {
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let downloaded = 0;
  let resSawEnd = false;

  res.on('data', (chunk) => {
    downloaded += chunk.length;
    if (total) {
      const pct = Math.floor((downloaded / total) * 100);
      event.sender.send('local-llm-progress', pct);
    }
  });

  // REAL BUG FIX, Joel-reported: connection dropped mid-download, but
  // the UI reported 100% success anyway. Root cause: file.on('finish')
  // only means the write stream flushed whatever bytes it DID
  // receive — it fires even when the read side (res) was cut off
  // early, since Node has no built-in link between "response ended"
  // and "write stream finished." There was also no res.on('error')
  // handler at all, so a dropped read connection wasn't even
  // reported as failure. Real fix: track the read side's own 'end'
  // event separately, and only resolve success if BOTH the response
  // genuinely ended AND the byte count matches what the server said
  // to expect — a real, verified completion, not an assumption.
  res.on('end', () => { resSawEnd = true; });
  res.on('error', (err) => {
    file.close();
    fsSync.unlink(LOCAL_LLM_PATH, () => {});
    reject(new Error(`Download connection failed: ${err.message}`));
  });

  res.pipe(file);
  file.on('finish', () => {
    file.close();
    if (!resSawEnd || (total && downloaded < total)) {
      fsSync.unlink(LOCAL_LLM_PATH, () => {});
      reject(new Error(`Download incomplete — got ${downloaded} of ${total || 'unknown'} bytes. Your connection likely dropped mid-download. Try again.`));
      return;
    }
    resolve({ ok: true });
  });
  file.on('error', (err) => { fsSync.unlink(LOCAL_LLM_PATH, () => {}); reject(err); });
}

ipcMain.handle('local_llm_set_enabled', async (_e, enabled) => {
  localLLMEnabled = !!enabled;
  // Real loading only happens here, on explicit enable — never on boot.
  // Requires `node-llama-cpp` (npm i node-llama-cpp) — supports both
  // real tool-calling and vision on GGUF models, so this local model
  // isn't a text-only downgrade from the online providers.
  if (localLLMEnabled && !localLLMInstance && fsSync.existsSync(LOCAL_LLM_PATH)) {
    try {
      const { getLlama } = require('node-llama-cpp');
      const llama = await getLlama();
      localLLMInstance = await llama.loadModel({ modelPath: LOCAL_LLM_PATH });
    } catch (e) {
      console.error('[LocalLLM] Failed to load model:', e.message);
      localLLMEnabled = false;
      return { ok: false, error: e.message };
    }
  }
  return { ok: true, enabled: localLLMEnabled };
});

// REAL, NEW — actual chat completion. Everything above only handled
// download/load; this is the missing piece that makes the local model
// genuinely usable as a real #1 provider, per Joel's explicit
// request, rather than just sitting downloaded and unused. Real,
// honest scope: node-llama-cpp's LlamaChatSession keeps its own
// conversation context internally per session — created once and
// reused, not recreated per call, so it stays fast on repeat use.
let _localLLMSession = null;
let _localLLMContext = null;

ipcMain.handle('local_llm_chat', async (_e, { messages, maxTokens }) => {
  if (!localLLMEnabled || !localLLMInstance) {
    return { ok: false, error: 'Local LLM not enabled or not loaded' };
  }
  try {
    const { LlamaChatSession } = require('node-llama-cpp');
    if (!_localLLMContext) {
      _localLLMContext = await localLLMInstance.createContext();
    }
    if (!_localLLMSession) {
      _localLLMSession = new LlamaChatSession({ contextSequence: _localLLMContext.getSequence() });
    }
    // REAL — flattens the messages array (system + history) into a
    // single prompt, since LlamaChatSession takes one prompt per turn
    // and manages its own running context internally rather than
    // taking a full messages array like the cloud APIs do.
    const systemMsg = messages.find(m => m.role === 'system');
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const prompt = (systemMsg ? `${systemMsg.content}\n\n` : '') + (lastUserMsg?.content || '');

    const reply = await _localLLMSession.prompt(prompt, { maxTokens: maxTokens || 512 });
    return { ok: true, reply, model: 'local:gemma-3-4b' };
  } catch (e) {
    console.error('[LocalLLM] Chat completion failed:', e.message);
    return { ok: false, error: e.message };
  }
});
