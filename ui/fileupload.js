// ═══════════════════════════════════════════
// ui/fileupload.js — File upload handler
//
// FIXES:
//   - Shows image preview inline when user uploads
//   - Knowledge base (.txt/.md) auto-saved to RAG
//   - All file types previewed in chat before processing
// ═══════════════════════════════════════════

import { RAG } from "../core/rag.js";

let _chat    = null;
let _sendFn  = null;
let _orbFn   = null;

export function initFileUpload(chat, sendFn, orbFn) {
  _chat   = chat;
  _sendFn = sendFn;
  _orbFn  = orbFn;
}

// ── Main entry ────────────────────────────
export async function handleFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) await _processFile(file);
}

async function _processFile(file) {
  const name = file.name;
  const ext  = name.split(".").pop().toLowerCase();
  const size = (file.size / 1024).toFixed(1);

  _orbFn?.("thinking");

  try {
    // ── IMAGE ──────────────────────────────
    if (/^image\//.test(file.type) || ["jpg","jpeg","png","gif","webp","bmp","svg"].includes(ext)) {
      const dataUrl = await _toDataURL(file);

      // Show preview inline in user column
      _renderImagePreview(dataUrl, name, "user");

      // Send to vision API for description
      const res = await fetch("/api/vision", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          image:  dataUrl.split(",")[1],
          prompt: `The user uploaded an image called "${name}". Describe what you see in detail. If it contains text, read it. If it's a screenshot, describe what's on screen. If it's a diagram or chart, explain it.`,
        }),
      });
      const data = await res.json();
      if (data.description) {
        _chat?.add(data.description, "bot");
        import("../core/speech.js").then(m => m.Speech.speak(data.description));
      } else {
        _chat?.addError("Vision API couldn't read this image.");
      }
      _orbFn?.("idle");
      return;
    }

    // ── PDF ────────────────────────────────
    if (ext === "pdf" || file.type === "application/pdf") {
      _showFileChip(name, size, "📄", "user");
      _chat?.add("Reading PDF...", "bot");
      const text    = await _extractPDF(file);
      const trimmed = text.slice(0, 8000);
      _sendFn(`I uploaded a PDF called "${name}". Here is its content:\n\n${trimmed}\n\nPlease summarise it and tell me the key points.`);
      _orbFn?.("idle");
      return;
    }

    // ── KNOWLEDGE BASE FILES (.txt / .md) ──
    // Auto-offer to save to RAG knowledge base
    if (["txt","md"].includes(ext)) {
      _showFileChip(name, size, "📝", "user");
      const content = await _readText(file);
      const { title } = RAG.parseDocument(name, content);

      // Save to RAG automatically
      const saved = await RAG.save(title, content);
      if (saved) {
        _chat?.add(`Saved "${title}" to my knowledge base. I'll reference it when relevant.`, "bot");
      } else {
        // KV not connected — still send content to AI for this session
        const trimmed = content.slice(0, 10000);
        _sendFn(`I uploaded a text file called "${name}". Here is its content:\n\n${trimmed}\n\nPlease analyse it.`);
      }
      _orbFn?.("idle");
      return;
    }

    // ── CODE / JSON / CSV / OTHER TEXT ─────
    if (["js","ts","jsx","tsx","py","html","css","json","csv",
         "xml","yaml","yml","sh","env","log","sql","php","rb","go",
         "java","c","cpp","cs","swift","kt","rs"].includes(ext)
        || file.type.startsWith("text/")) {
      _showFileChip(name, size, "💻", "user");
      const text    = await _readText(file);
      const trimmed = text.slice(0, 10000);
      const label   = ext === "csv" ? "CSV data" : ext === "json" ? "JSON file" : `${ext.toUpperCase()} file`;
      _sendFn(`I uploaded a ${label} called "${name}". Here is its content:\n\n\`\`\`${ext}\n${trimmed}\n\`\`\`\n\nPlease analyse it and tell me what you notice.`);
      _orbFn?.("idle");
      return;
    }

    // ── WORD / DOCX ────────────────────────
    if (["doc","docx"].includes(ext)) {
      _showFileChip(name, size, "📄", "user");
      _chat?.add(`Got "${name}". I can't read Word docs directly yet — save it as .txt or .pdf first, Boss.`, "bot");
      _orbFn?.("idle");
      return;
    }

    // ── UNSUPPORTED ────────────────────────
    _showFileChip(name, size, "📎", "user");
    _chat?.add(`Got "${name}" (${size} KB) but I can't read ${ext.toUpperCase()} files yet. Try images, PDFs, text, or code files.`, "bot");
    _orbFn?.("idle");

  } catch(err) {
    _chat?.addError("File read failed: " + err.message);
    _orbFn?.("idle");
  }
}

// ── Render inline image preview (user uploads) ──
function _renderImagePreview(dataUrl, name, who) {
  const colId = who === "user" ? "col-right" : "col-left";
  const col   = document.getElementById(colId);
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = `mwrap ${who === "user" ? "mright" : "mleft"} fresh`;

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = who === "user" ? "YOU" : "FLOW";

  const card = document.createElement("div");
  card.className = "img-card";

  const img = document.createElement("img");
  img.src   = dataUrl;
  img.alt   = name;
  img.style.cssText = "max-width:100%;border-radius:10px;display:block;cursor:pointer;border:1px solid rgba(56,189,248,.2);";
  img.onclick = () => {
    const win = window.open();
    win.document.write(`<img src="${dataUrl}" style="max-width:100%;background:#000;">`);
  };

  const meta = document.createElement("div");
  meta.className   = "img-meta";
  meta.textContent = `📎 ${name} · click to enlarge`;

  card.appendChild(img);
  card.appendChild(meta);
  wrap.appendChild(label);
  wrap.appendChild(card);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;

  setTimeout(() => wrap.classList.remove("fresh"), 8000);
}

// ── Render a file chip (non-image files) ──
function _showFileChip(name, size, icon, who) {
  const colId = who === "user" ? "col-right" : "col-left";
  const col   = document.getElementById(colId);
  if (!col) return;

  const wrap = document.createElement("div");
  wrap.className = `mwrap ${who === "user" ? "mright" : "mleft"} fresh`;

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = who === "user" ? "YOU" : "FLOW";

  const chip = document.createElement("div");
  chip.className = "file-chip";
  chip.innerHTML = `<span class="file-chip-icon">${icon}</span><span class="file-chip-name">${name}</span><span class="file-chip-size">${size} KB</span>`;

  wrap.appendChild(label);
  wrap.appendChild(chip);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;

  setTimeout(() => wrap.classList.remove("fresh"), 5000);
}

// ── PDF extraction via PDF.js CDN ─────────
async function _extractPDF(file) {
  if (!window.pdfjsLib) {
    await _loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const arrayBuffer = await file.arrayBuffer();
  const pdf   = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let   text  = "";
  for (let p = 1; p <= Math.min(pdf.numPages, 20); p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(i => i.str).join(" ") + "\n";
  }
  return text.trim() || "[No readable text found in PDF]";
}

// ── Helpers ───────────────────────────────
function _readText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error("Could not read file"));
    r.readAsText(file);
  });
}

function _toDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error("Could not read image"));
    r.readAsDataURL(file);
  });
}

function _loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}
