// flow-electron/preload.js (v3)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__flowElectron', {
  send: (action, payload) => {
    const ALLOWED = ['cursor_move', 'gesture_click', 'right_click', 'scroll', 'type_text'];
    if (ALLOWED.includes(action)) ipcRenderer.send(action, payload);
  },
  getScreenSize: () => ipcRenderer.invoke('get_screen_size'),
  minimize: () => ipcRenderer.send('win_minimize'),
  maximize: () => ipcRenderer.send('win_maximize'),
  close:    () => ipcRenderer.send('win_close'),
});

// Inject Apple traffic lights AFTER page fully loads
window.addEventListener('load', () => {
  setTimeout(() => {
    document.getElementById('electron-titlebar')?.remove();
    document.getElementById('electron-dragzone')?.remove();

    // Traffic light buttons
    const bar = document.createElement('div');
    bar.id = 'electron-titlebar';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'width:76px', 'height:40px',
      'display:flex', 'align-items:center', 'padding:0 14px', 'gap:8px',
      'z-index:2147483647',   // max z-index
      'pointer-events:all',
    ].join('!important;') + '!important';

    [
      { color: '#ff5f57', action: 'close',    label: '×' },
      { color: '#febc2e', action: 'minimize', label: '−' },
      { color: '#28c840', action: 'maximize', label: '+' },
    ].forEach(({ color, action, label }) => {
      const btn = document.createElement('button');
      btn.setAttribute('style', [
        `background:${color}`,
        'width:13px', 'height:13px', 'border-radius:50%',
        'border:none', 'cursor:pointer', 'padding:0',
        'display:flex', 'align-items:center', 'justify-content:center',
        'font-size:0px',           // hide label by default
        'color:rgba(0,0,0,0.6)',
        'font-weight:bold',
        'flex-shrink:0',
        'box-shadow:0 1px 3px rgba(0,0,0,0.5)',
        'pointer-events:all',
      ].join('!important;') + '!important');

      // Show symbol on hover
      bar.addEventListener('mouseenter', () => { btn.style.fontSize = '9px'; });
      bar.addEventListener('mouseleave', () => { btn.style.fontSize = '0px'; });
      btn.textContent = label;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        window.__flowElectron[action]?.();
      });
      bar.appendChild(btn);
    });

    document.body.appendChild(bar);

    // Drag zone (right of buttons, full top strip)
    const drag = document.createElement('div');
    drag.id = 'electron-dragzone';
    drag.setAttribute('style', [
      'position:fixed', 'top:0', 'left:76px', 'right:0', 'height:40px',
      'z-index:2147483646',
      '-webkit-app-region:drag',
      'pointer-events:all',
    ].join('!important;') + '!important');
    document.body.appendChild(drag);

  }, 1200);  // wait for Flow's CSS to fully paint
});
