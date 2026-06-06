// ═══════════════════════════════════════════
// ui/chat.js — Message rendering
// ═══════════════════════════════════════════
import { Memory }                   from "../core/memory.js";
import { hasCode, renderWithCode }  from "./codeblock.js";

const colLeft  = () => document.getElementById("col-left");
const colRight = () => document.getElementById("col-right");

function render(text, who, flash) {
  const isUser = who === "user";
  const col    = isUser ? colRight() : colLeft();
  if (!col) return null;

  const wrap = document.createElement("div");
  wrap.className = "mwrap " + (isUser ? "mright" : "mleft");

  const label = document.createElement("div");
  label.className   = "mlabel";
  label.textContent = isUser ? "YOU" : "FLOW";

  const bubble = document.createElement("div");
  bubble.className = "mbubble " + (isUser ? "muser" : "mbot");

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  col.appendChild(wrap);

  // Render content — check for code AFTER bubble is in DOM
  if (!isUser && hasCode(text)) {
    // Async render — sets innerHTML once highlight.js loads
    renderWithCode(text, bubble);
  } else {
    bubble.textContent = text;
  }

  if (flash) {
    wrap.classList.add("fresh");
    setTimeout(() => wrap.classList.remove("fresh"), 4500);
  }

  col.scrollTop = col.scrollHeight;
  return wrap;
}

export const Chat = {

  add(text, who) {
    render(text, who, true);
  },

  addError(msg) {
    const col = colLeft();
    if (!col) return;
    const wrap = document.createElement("div");
    wrap.className = "mwrap mleft merror-wrap";
    const label = document.createElement("div");
    label.className   = "mlabel";
    label.textContent = "ERROR";
    const bubble = document.createElement("div");
    bubble.className   = "mbubble merror";
    bubble.textContent = "⚠️ " + msg;
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    col.appendChild(wrap);
    col.scrollTop = col.scrollHeight;
  },

  loadHistory() {
    Memory.get().forEach(m => render(m.content, m.role === "user" ? "user" : "bot", false));
  },

  showTyping() {
    if (document.getElementById("typing-indicator")) return;
    const col = colLeft();
    if (!col) return;
    const wrap = document.createElement("div");
    wrap.id = "typing-indicator";
    wrap.className = "mwrap mleft";
    const label = document.createElement("div");
    label.className = "mlabel"; label.textContent = "FLOW";
    const b = document.createElement("div");
    b.className = "mbubble mbot mtyping";
    b.innerHTML = "<span></span><span></span><span></span>";
    wrap.appendChild(label);
    wrap.appendChild(b);
    wrap.classList.add("fresh");
    col.appendChild(wrap);
    col.scrollTop = col.scrollHeight;
  },

  hideTyping() {
    document.getElementById("typing-indicator")?.remove();
  },
};
