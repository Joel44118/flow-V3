// ═══════════════════════════════════════════
// ui/stagedfiles.js — File staging tray
//
// Holds selected files (images, video, docs, code) above the
// input bar with an X button per file. Nothing is sent or
// processed until the user hits send — multiple files can be
// queued together and go out in one message.
// ═══════════════════════════════════════════

let _tray      = null;
let _staged    = [];   // [{ id, file, kind, previewUrl }]
let _onChange  = null; // callback fired whenever staged list changes

export function initStagedFiles(onChangeFn) {
  _onChange = onChangeFn || null;
  _buildTray();
}

function _buildTray() {
  if (_tray) return;
  _tray = document.createElement("div");
  _tray.id = "staged-tray";
  _tray.style.display = "none";

  const panel = document.querySelector(".input-panel");
  if (panel && panel.parentNode) {
    panel.parentNode.insertBefore(_tray, panel);
  } else {
    document.body.appendChild(_tray);
  }
}

// ── Classify a file ─────────────────────────────────────────────────────
function _kindOf(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (/^image\//.test(file.type) || ["jpg","jpeg","png","gif","webp","bmp","svg"].includes(ext)) return "image";
  if (/^video\//.test(file.type) || ["mp4","mov","webm","avi","mkv"].includes(ext)) return "video";
  if (/^audio\//.test(file.type) || ["mp3","wav","ogg","m4a"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "file";
}

const ICONS = { image: "🖼️", video: "🎬", audio: "🎵", pdf: "📄", file: "📎" };

// ── Add files to the tray (does NOT send or process them) ────────────────
export function stageFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    const kind = _kindOf(file);
    const id   = "f" + Date.now() + Math.random().toString(36).slice(2, 7);
    const entry = { id, file, kind, previewUrl: null };
    _staged.push(entry);

    if (kind === "image") {
      const reader = new FileReader();
      reader.onload = e => {
        entry.previewUrl = e.target.result;
        _render();
      };
      reader.readAsDataURL(file);
    }
  }
  _render();
}

// ── Remove a staged file by id ────────────────────────────────────────────
function _remove(id) {
  _staged = _staged.filter(f => f.id !== id);
  _render();
}

// ── Clear all staged files (called after send) ───────────────────────────
export function clearStaged() {
  _staged = [];
  _render();
}

// ── Get current staged files (for sending) ────────────────────────────────
export function getStagedFiles() {
  return _staged.map(f => f.file);
}

export function hasStagedFiles() {
  return _staged.length > 0;
}

// ── Render the tray ────────────────────────────────────────────────────────
function _render() {
  if (!_tray) return;
  _tray.innerHTML = "";

  if (!_staged.length) {
    _tray.style.display = "none";
    _onChange?.(_staged.length);
    return;
  }

  _tray.style.display = "flex";

  for (const entry of _staged) {
    const card = document.createElement("div");
    card.className = "staged-card";
    card.dataset.kind = entry.kind;

    const closeBtn = document.createElement("button");
    closeBtn.className = "staged-x";
    closeBtn.textContent = "✕";
    closeBtn.title = "Remove";
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); _remove(entry.id); });

    if (entry.kind === "image" && entry.previewUrl) {
      const img = document.createElement("img");
      img.src = entry.previewUrl;
      img.className = "staged-thumb";
      card.appendChild(img);
    } else if (entry.kind === "video") {
      const vid = document.createElement("video");
      vid.src = URL.createObjectURL(entry.file);
      vid.className = "staged-thumb";
      vid.muted = true;
      card.appendChild(vid);
      const badge = document.createElement("span");
      badge.className = "staged-badge";
      badge.textContent = "🎬";
      card.appendChild(badge);
    } else {
      const iconWrap = document.createElement("div");
      iconWrap.className = "staged-icon-wrap";
      iconWrap.textContent = ICONS[entry.kind] || "📎";
      card.appendChild(iconWrap);
    }

    const name = document.createElement("div");
    name.className = "staged-name";
    name.textContent = entry.file.name.length > 16
      ? entry.file.name.slice(0, 13) + "..."
      : entry.file.name;
    card.appendChild(name);
    card.appendChild(closeBtn);
    _tray.appendChild(card);
  }

  _onChange?.(_staged.length);
}
