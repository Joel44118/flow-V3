// ═══════════════════════════════════════════
// ui/fileupload.js — File upload handler
//
// Supports: images, PDFs, text, code, JSON,
//           CSV, Word docs, folders (via zip)
//
// Images → sent as base64 to vision API
// Text/code/JSON/CSV → sent as text in message
// PDF → text extracted client-side, sent to AI
// ═══════════════════════════════════════════

let _chat    = null;
let _sendFn  = null;
let _orbFn   = null;

export function initFileUpload(chat, sendFn, orbFn) {
  _chat   = chat;
  _sendFn = sendFn;
  _orbFn  = orbFn;
}

// ── Main entry — called when file(s) selected ──
export async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  for (const file of files) {
    await _processFile(file);
  }
}

async function _processFile(file) {
  const name = file.name;
  const ext  = name.split(".").pop().toLowerCase();
  const size  = (file.size / 1024).toFixed(1);

  _chat?.add(`📎 Uploading: ${name} (${size} KB)`, "user");
  _orbFn?.("thinking");

  try {
    // ── IMAGE ───────────────────────────────
    if (/^image\//.test(file.type) || ["jpg","jpeg","png","gif","webp","bmp"].includes(ext)) {
      const base64 = await _toBase64(file);
      const prompt = `The user uploaded an image called "${name}". Describe what you see in detail. If it contains text, read it. If it's a screenshot, describe what's on screen. If it's a diagram or chart, explain it.`;

      const res = await fetch("/api/vision", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ image: base64.split(",")[1], prompt }),
      });
      const data = await res.json();
      if (data.description) {
        _chat?.add(data.description, "bot");
        import("../core/speech.js").then(m => m.Speech.speak(data.description));
        _orbFn?.("idle");
        return;
      }
    }

    // ── PDF ─────────────────────────────────
    if (ext === "pdf" || file.type === "application/pdf") {
      _chat?.add("Reading PDF...", "bot");
      // Use PDF.js from CDN to extract text
      const text = await _extractPDF(file);
      const trimmed = text.slice(0, 8000); // keep it sane
      _sendFn(`I uploaded a PDF called "${name}". Here is its content:\n\n${trimmed}\n\nPlease summarise it and tell me the key points.`);
      _orbFn?.("idle");
      return;
    }

    // ── TEXT / CODE / JSON / CSV / MD ───────
    if (["txt","md","js","ts","jsx","tsx","py","html","css","json","csv",
         "xml","yaml","yml","sh","env","log","sql"].includes(ext)
        || file.type.startsWith("text/")) {
      const text = await _readText(file);
      const trimmed = text.slice(0, 10000);
      const label = ext === "csv" ? "CSV data" : ext === "json" ? "JSON" : "file";
      _sendFn(`I uploaded a ${label} called "${name}". Here is its content:\n\n${trimmed}\n\nPlease analyse it and tell me what you notice.`);
      _orbFn?.("idle");
      return;
    }

    // ── WORD / DOCX ─────────────────────────
    if (["doc","docx"].includes(ext)) {
      _chat?.add(`Received "${name}". I can't read Word docs directly yet — try saving it as a .txt or .pdf first.`, "bot");
      _orbFn?.("idle");
      return;
    }

    // ── UNSUPPORTED ─────────────────────────
    _chat?.add(`Got "${name}" (${size} KB) but I can't read ${ext.toUpperCase()} files yet. Try images, PDFs, text, or code files.`, "bot");
    _orbFn?.("idle");

  } catch(err) {
    _chat?.addError("File read failed: " + err.message);
    _orbFn?.("idle");
  }
}

// ── PDF text extraction via PDF.js CDN ───────
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

// ── Helpers ───────────────────────────────────
function _readText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = () => rej(new Error("Could not read file"));
    r.readAsText(file);
  });
}

function _toBase64(file) {
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