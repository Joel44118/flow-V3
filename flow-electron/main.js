// flow-electron/main.js (v3)
// Single instance + native title bar + overlay gesture window +
// system tray + cache clear + auto-updater

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

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

// ── Auto-updater ──────────────────────────────────────────────────────────
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger               = { info: console.log, warn: console.warn, error: console.error };
} catch(e) { console.warn('[Flow] electron-updater not available'); }

let mainWin    = null;
let overlayWin = null;
let tray       = null;

// ── Main window ───────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    width:    Math.min(1200, Math.round(width  * 0.88)),
    height:   Math.min(820,  Math.round(height * 0.88)),
    minWidth: 480,
    minHeight: 360,
    // Native Windows title bar overlay — buttons are OUTSIDE Flow's interface
    // Real OS chrome, not HTML buttons
    titleBarStyle:   'hidden',
    titleBarOverlay: {
      color:       '#060a1a',  // Flow background color
      symbolColor: '#38bdf8',  // cyan minimize/maximize/close symbols
      height:      32,
    },
    backgroundColor: '#060a1a',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
  });

  // ── Clear cache on EVERY launch ───────────────────────────────────────
  // This is the permanent fix for stale content on first open
  // Service worker handles offline — Electron always gets fresh content
  mainWin.webContents.session.clearCache()
    .then(() => mainWin.webContents.session.clearStorageData({
      storages: ['serviceworkers'],  // force fresh SW registration too
    }))
    .then(() => {
      mainWin.loadURL('https://flow-v3-mu.vercel.app');
    })
    .catch(() => {
      mainWin.loadURL('https://flow-v3-mu.vercel.app');
    });

  // Auto-grant all permissions — no annoying popups
  mainWin.webContents.session.setPermissionRequestHandler(
    (_wc, perm, cb) =>
      cb(['media','microphone','camera','notifications','geolocation'].includes(perm))
  );

  mainWin.once('ready-to-show', () => {
    mainWin.show();
    mainWin.setTitle('Flow AI');
    // Check for updates 4s after launch (background, silent)
    if (autoUpdater) setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 4000);
  });

  // Keyboard shortcuts
  mainWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') mainWin.webContents.toggleDevTools();
    if (input.key === 'F5')  mainWin.webContents.reload();
  });

  // Close → hide to tray (keeps Flow running, "Hey Flow" always listening)
  mainWin.on('close', e => {
    if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
  Menu.setApplicationMenu(null);
}

// ── Overlay window — gesture dot across ALL apps ──────────────────────────
// Transparent, always-on-top, click-through window covering full screen
// The purple dot appears on top of EVERYTHING — Chrome, File Explorer, etc.
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
  overlayWin.setAlwaysOnTop(true, 'screen-saver');  // above everything

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
</style></head>
<body><div id="dot"></div>
<script>
const dot = document.getElementById('dot');
const {ipcRenderer} = require('electron');
ipcRenderer.on('dot-move',  (_,x,y,s) => { dot.style.display='block'; dot.style.left=x+'px'; dot.style.top=y+'px'; dot.className=s||''; });
ipcRenderer.on('dot-hide',  ()        => { dot.style.display='none'; });
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
      { label: 'Quit',       click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => mainWin?.isVisible() ? mainWin.focus() : mainWin?.show());
  } catch(e) { console.warn('[Flow] Tray:', e.message); }
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
ipcMain.on('gesture_stop',   ()           => overlayWin?.webContents.send('dot-hide'));
ipcMain.on('cursor_held',    (_e, {x, y}) => moveDot(x, y, 'held'));
ipcMain.on('type_text',      (_e, {text}) => { try { robot?.typeString(text || ''); } catch(_) {} });

ipcMain.handle('get_screen_size', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.bounds.width, height: d.bounds.height };
});

ipcMain.on('win_minimize', () => mainWin?.minimize());
ipcMain.on('win_maximize', () => { if (!mainWin) return; mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize(); });
ipcMain.on('win_close',    () => mainWin?.hide());

// ── Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => { createWindow(); createOverlay(); createTray(); });
app.on('activate',         () => { if (!mainWin) createWindow(); else mainWin.show(); });
app.on('window-all-closed',() => { /* stay in tray */ });
app.on('before-quit',      () => { app.isQuitting = true; });
