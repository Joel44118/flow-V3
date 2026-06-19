// ═══════════════════════════════════════════
// ui/fileupload.js — File upload handler
//
// Handles a BATCH of files (from the staging tray) plus an
// optional instruction typed alongside them. Multiple files
// go out together as one message instead of one-by-one.
//
// If the instruction implies editing an image ("edit this",
// "remove the background", "make it brighter" etc.) and an
// image was staged, it routes to image editing instead of
// just describing the image.
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

const EDIT_INTENT_RX = /\b(edit|change|modify|remove|erase|delete|fix|recolou?r|recolor|brighten|darken|crop|resize|enhance|touch.?up|retouch|add.{0,15}to (?:it|this|the image)|make it|turn it|background)\b/i;

// ── Main entry — processes a batch of staged files + optional instruction ──
export async function handleFiles(fileList, instruction = "") {
  const files = Array.from(fileList);
  if (!files.length) return;

  _orbFn?.("thinking");

  // Separate by kind first
  const images = [];
  const videos = [];
  const others = [];

  for (const file of files) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (/^image\//.test(file.type) || ["jpg","jpeg","png","gif","webp","bmp","svg"].includes(ext)) images.push(file);
    else if (/^video\//.test(file.type) || ["mp4","mov","webm","avi","mkv"].includes(ext)) videos.push(file);
    else others.push(file);
  }

  // ── Single image + edit instruction → route to image editing ───────────
  if (images.length === 1 && videos.length === 0 && others.length === 0 && instruction && EDIT_INTENT_RX.test(instruction)) {
    await _editImage(images[0], instruction);
    _orbFn?.("idle");
    return;
  }

  // ── Multiple images, or images + instruction (non-edit) ────────────────
  if (images.length) {
    await _processImages(images, instruction);
  }

  // ── Videos ───────────────────────────────────────────────────────────────
  for (const v of videos) {
    await _processVideo(v, instruction);
  }

  // ── Everything else (pdf, text, code, docx, unsupported) ────────────────
  for (const f of others) {
    await _processOther(f, instruction);
  }

  _orbFn?.("idle");
}

// ── Process one or more images together ───────────────────────────────────
async function _processImages(images, instruction) {
  const previews = [];
  for (const img of images) {
    const dataUrl = await _toDataURL(img);
    previews.push({ name: img.name, b64: dataUrl.split(",")[1] });
    _renderImagePreview(dataUrl, img.name, "user");
  }

  window._lastUploadedBase64 = previews[0]?.b64; // for background-removal command compat

  const prompt = instruction
    ? `The user uploaded ${images.length} image(s) and said: "${instruction}". Respond to their request about the image(s).`
    : images.length === 1
      ? `The user uploaded an image called "${images[0].name}". Describe what you see in detail. If it contains text, read it.`
      : `The user uploaded ${images.length} images. Describe each one briefly.`;

  try {
    const res = await fetch("/api/vision", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ image: previews[0].b64, prompt }),
    });
    const data = await res.json();
    if (data.description) {
      _chat?.add(data.description, "bot");
      import("../core/speech.js").then(m => m.Speech.speak(data.description));
    } else {
      _chat?.addError("Vision API couldn't read this image.");
    }
  } catch (e) {
    _chat?.addError("Image processing failed: " + e.message);
  }
}

// ── Edit an image based on instruction ─────────────────────────────────────
async function _editImage(file, instruction) {
  const dataUrl = await _toDataURL(file);
  _renderImagePreview(dataUrl, file.name, "user");
  _chat?.add(`Editing "${file.name}": ${instruction}...`, "bot");

  try {
    const res = await fetch("/api/imageedit", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        image:       dataUrl.split(",")[1],
        instruction,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.image) {
      const editedUrl = `data:image/png;base64,${data.image}`;
      _renderImagePreview(editedUrl, "edited_" + file.name, "bot");
      _chat?.add(`Done — here's the edited version.`, "bot");
    } else {
      throw new Error("No image returned");
    }
  } catch (e) {
    _chat?.addError("Image edit failed: " + e.message + ". Try describing the edit differently, or this model may not support it yet.");
  }
}

// ── Process a video file ────────────────────────────────────────────────────
async function _processVideo(file, instruction) {
  const size = (file.size / 1024 / 1024).toFixed(1);
  _showFileChip(file.name, size + " MB", "🎬", "user");

  // Grab a frame for vision description (first frame at 1s)
  try {
    const frameB64 = await _grabVideoFrame(file);
    const prompt = instruction
      ? `The user uploaded a video called "${file.name}" and said: "${instruction}". Here's a frame from it.`
      : `The user uploaded a video called "${file.name}". Here's a frame from it — describe what you can see.`;
    const res = await fetch("/api/vision", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ image: frameB64, prompt }),
    });
    const data = await res.json();
    if (data.description) {
      _chat?.add(`📹 ${file.name}: ${data.description}\n\n(Note: I can only see a single frame — full video analysis isn't supported yet.)`, "bot");
    } else {
      _chat?.add(`Got the video "${file.name}" (${size} MB) but couldn't extract a preview frame to analyse.`, "bot");
    }
  } catch (e) {
    _chat?.add(`Got "${file.name}" (${size} MB). I can't fully analyse video content yet — only a single frame preview.`, "bot");
  }
}

// ── Process PDF / text / code / docx / unsupported ─────────────────────────
async function _processOther(file, instruction) {
  const name = file.name;
  const ext  = (name.split(".").pop() || "").toLowerCase();
  const size = (file.size / 1024).toFixed(1);

  try {
    if (ext === "pdf" || file.type === "application/pdf") {
      _showFileChip(name, size, "📄", "user");
      _chat?.add("Reading PDF...", "bot");
      const text    = await _extractPDF(file);
      const trimmed = text.slice(0, 8000);
      const ask     = instruction || "Please summarise it and tell me the key points.";
      _sendFn(`I uploaded a PDF called "${name}". Here is its content:\n\n${trimmed}\n\n${ask}`);
      return;
    }

    if (["txt", "md"].includes(ext)) {
      _showFileChip(name, size, "📝", "user");
      const content = await _readText(file);
      const { title } = RAG.parseDocument(name, content);
      const saved = await RAG.save(title, content);
      if (saved) {
        _chat?.add(`Saved "${title}" to my knowledge base. I'll reference it when relevant.`, "bot");
      } else {
        const trimmed = content.slice(0, 10000);
        _sendFn(`I uploaded a text file called "${name}". Here is its content:\n\n${trimmed}\n\n${instruction || "Please analyse it."}`);
      }
      return;
    }

    const codeExts = ["js","ts","jsx","tsx","py","html","css","json","csv","xml","yaml","yml","sh","env","log","sql","php","rb","go","java","c","cpp","cs","swift","kt","rs"];
    if (codeExts.includes(ext) || file.type.startsWith("text/")) {
      _showFileChip(name, size, "💻", "user");
      const text    = await _readText(file);
      const trimmed = text.slice(0, 10000);
      const label   = ext === "csv" ? "CSV data" : ext === "json" ? "JSON file" : `${ext.toUpperCase()} file`;
      const ask     = instruction || "Please analyse it and tell me what you notice.";
      _sendFn(`I uploaded a ${label} called "${name}". Here is its content:\n\n\`\`\`${ext}\n${trimmed}\n\`\`\`\n\n${ask}`);
      return;
    }

    if (["doc", "docx"].includes(ext)) {
      _showFileChip(name, size, "📄", "user");
      _chat?.add(`Got "${name}". I can't read Word docs directly yet — save it as .txt or .pdf first, Boss.`, "bot");
      return;
    }

    _showFileChip(name, size, "📎", "user");
    _chat?.add(`Got "${name}" (${size} KB) but I can't read ${ext.toUpperCase()} files yet. Try images, video, PDFs, text, or code files.`, "bot");

  } catch (err) {
    _chat?.addError("File read failed: " + err.message);
  }
}

// ── Render inline image preview (user or bot uploads) ──────────────────────
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

// ── Render a file chip (non-image files) ────────────────────────────────────
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
  chip.innerHTML = `<span class="file-chip-icon">${icon}</span><span class="file-chip-name">${name}</span><span class="file-chip-size">${size}</span>`;

  wrap.appendChild(label);
  wrap.appendChild(chip);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;

  setTimeout(() => wrap.classList.remove("fresh"), 5000);
}

// ── Grab a single frame from a video file (for vision preview) ─────────────
function _grabVideoFrame(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted   = true;
    video.src     = URL.createObjectURL(file);

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, video.duration / 2);
    };
    video.onseeked = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(video.src);
      resolve(dataUrl.split(",")[1]);
    };
    video.onerror = () => reject(new Error("Could not read video"));
  });
}

// ── PDF extraction via PDF.js CDN ───────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
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
