// ═══════════════════════════════════════════
// ui/chat.js — Scrollable, invisible until hover
// ═══════════════════════════════════════════
import { Memory }                 from "../core/memory.js";
import { hasCode, renderWithCode } from "./codeblock.js";

const colLeft  = () => document.getElementById("col-left");
const colRight = () => document.getElementById("col-right");

function render(text, who, flash) {
  const isUser = who === "user";
  const col    = isUser ? colRight() : colLeft();
  if (!col) return null;

  const wrap   = document.createElement("div");
  wrap.className = "mwrap " + (isUser ? "mright" : "mleft");

  const label  = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = isUser ? "YOU" : "FLOW";

  const bubble = document.createElement("div");
  bubble.className   = "mbubble " + (isUser ? "muser" : "mbot");
  bubble.textContent = text;

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  col.appendChild(wrap);
  col.scrollTop = col.scrollHeight;

  if (flash) {
    // New message: visible for 4s then becomes hover-only
    wrap.classList.add("fresh");
    setTimeout(() => wrap.classList.remove("fresh"), 4000);
  }
  return wrap;
}

export const Chat = {
  add(text, who) { render(text, who, true); },

  addError(msg) {
    const col = colLeft();
    if (!col) return;
    const wrap   = document.createElement("div");
    wrap.className = "mwrap mleft merror-wrap";
    const label  = document.createElement("div");
    label.className = "mlabel"; label.textContent = "ERROR";
    const bubble = document.createElement("div");
    bubble.className = "mbubble merror";
    bubble.textContent = "⚠️ " + msg;
    wrap.appendChild(label); wrap.appendChild(bubble);
    col.appendChild(wrap);
    col.scrollTop = col.scrollHeight;
  },

  loadHistory() {
    Memory.get().forEach(m => render(m.content, m.role === "user" ? "user" : "bot", false));
  },

  showTyping() {
    if (document.getElementById("typing-indicator")) return;
    const col  = colLeft(); if (!col) return;
    const wrap = document.createElement("div");
    wrap.id = "typing-indicator"; wrap.className = "mwrap mleft";
    const label = document.createElement("div");
    label.className = "mlabel"; label.textContent = "FLOW";
    const b = document.createElement("div");
    b.className = "mbubble mbot mtyping";
    b.innerHTML = "<span></span><span></span><span></span>";
    wrap.appendChild(label); wrap.appendChild(b);
    col.appendChild(wrap); wrap.classList.add("fresh");
    col.scrollTop = col.scrollHeight;
  },

  hideTyping() {
    document.getElementById("typing-indicator")?.remove();
  },
};
