// flow-electron/main.js (v1)
// Electron desktop app for Flow AI
// Loads live Vercel deployment — auto-updates when you push
// Uses robotjs for real OS cursor control

const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');

// robotjs — real OS cursor/click/scroll
// Install with: npm install @jitsi/robotjs
let robot = null;
try {
  robot = require('@jitsi/robotjs');
  robot.setMouseDelay(0);   // zero delay for smooth gesture tracking
  robot.setKeyboardDelay(0);
  console.log('[Flow] robotjs loaded ✓ — OS cursor control active');
} catch (e) {
  console.warn('[Flow] robotjs not found — run: npm install @jitsi/robotjs');
  console.warn('[Flow] Gesture cursor will still work within Flow window only');
}

let mainWin = null;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    width:           Math.min(1200, Math.round(width  * 0.85)),
    height:          Math.min(800,  Math.round(height * 0.85)),
    minWidth:        480,
    minHeight:       360,
    frame:           false,      // use custom titlebar injected via preload
    backgroundColor: '#060a1a',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    icon: path.join(__dirname, 'icon.png'),
    show: false,
  });

  // Always load the live Vercel URL — auto-updates with every push
  mainWin.loadURL('https://flow-v3-mu.vercel.app');

  // Auto-grant mic + camera in the app — no popups
  mainWin.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(['media', 'microphone', 'camera', 'notifications', 'geolocation'].includes(permission));
    }
  );

  mainWin.once('ready-to-show', () => mainWin.show());

  // F12 = DevTools, F5 = reload
  mainWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') mainWin.webContents.toggleDevTools();
    if (input.key === 'F5')  mainWin.webContents.reload();
  });

  mainWin.on('closed', () => { mainWin = null; });

  // Remove default menu bar (looks cleaner)
  Menu.setApplicationMenu(null);
}

// ── IPC: OS cursor + input control via robotjs ────────────────────────────

ipcMain.on('cursor_move', (_e, { x, y }) => {
  try { robot?.moveMouse(Math.round(x), Math.round(y)); } catch (_) {}
});

ipcMain.on('gesture_click', (_e, { x, y }) => {
  try {
    robot?.moveMouse(Math.round(x), Math.round(y));
    robot?.mouseClick('left');
  } catch (_) {}
});

ipcMain.on('right_click', (_e, { x, y }) => {
  try {
    robot?.moveMouse(Math.round(x), Math.round(y));
    robot?.mouseClick('right');
  } catch (_) {}
});

ipcMain.on('scroll', (_e, { direction, amount }) => {
  try {
    const lines = Math.max(1, Math.round((amount || 120) / 40));
    if (direction === 'up')    robot?.scrollMouse(0, -lines);
    else if (direction === 'down') robot?.scrollMouse(0,  lines);
    else if (direction === 'left') robot?.scrollMouse(-lines, 0);
    else                           robot?.scrollMouse( lines, 0);
  } catch (_) {}
});

ipcMain.on('type_text', (_e, { text }) => {
  try { robot?.typeString(text || ''); } catch (_) {}
});

// Renderer calls this to get real screen size for gesture coordinate mapping
ipcMain.handle('get_screen_size', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.bounds.width, height: d.bounds.height };
});

// Window controls (called from Flow's custom title bar buttons)
ipcMain.on('win_minimize', () => mainWin?.minimize());
ipcMain.on('win_maximize', () => {
  if (!mainWin) return;
  mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize();
});
ipcMain.on('win_close', () => mainWin?.close());

// ── App lifecycle ─────────────────────────────────────────────────────────

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
