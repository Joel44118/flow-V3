// flow-electron/preload.js (v2)
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__flowElectron", {
  send: (action, payload) => {
    const ALLOWED = ["cursor_move", "gesture_click", "right_click", "scroll", "type_text"];
    if (ALLOWED.includes(action)) ipcRenderer.send(action, payload);
  },
  getScreenSize: () => ipcRenderer.invoke("get_screen_size"),
  minimize: () => ipcRenderer.send("win_minimize"),
  maximize: () => ipcRenderer.send("win_maximize"),
  close:    () => ipcRenderer.send("win_close"),
});

// Inject Apple-style traffic light title bar
window.addEventListener("DOMContentLoaded", () => {
  // Only inject in Electron (not browser)
  const bar = document.createElement("div");
  bar.id = "electron-titlebar";
  bar.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 14px;
    gap: 8px;
    z-index: 999999;
    -webkit-app-region: drag;
    background: linear-gradient(180deg, rgba(6,10,26,0.98) 0%, transparent 100%);
  `;

  const buttons = [
    { id: "tb-close",    color: "#ff5f57", hover: "#ff3b30", action: "close",    title: "Close"    },
    { id: "tb-minimize", color: "#febc2e", hover: "#ffcc00", action: "minimize", title: "Minimize" },
    { id: "tb-maximize", color: "#28c840", hover: "#34c759", action: "maximize", title: "Maximize" },
  ];

  buttons.forEach(({ id, color, hover, action, title }) => {
    const btn = document.createElement("button");
    btn.id    = id;
    btn.title = title;
    btn.style.cssText = `
      width: 13px; height: 13px; border-radius: 50%;
      background: ${color}; border: none; cursor: pointer;
      -webkit-app-region: no-drag;
      transition: filter 0.15s;
      flex-shrink: 0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
    `;
    btn.addEventListener("mouseenter", () => btn.style.filter = "brightness(1.15)");
    btn.addEventListener("mouseleave", () => btn.style.filter = "brightness(1)");
    btn.addEventListener("click", () => window.__flowElectron[action]?.());
    bar.appendChild(btn);
  });

  document.body.prepend(bar);
});
