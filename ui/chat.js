// ═══════════════════════════════════════════
// ui/chat.js — Message rendering with rich text + controls
// ═══════════════════════════════════════════
import { Memory }                  from "../core/memory.js";
import { hasCode, renderWithCode } from "./codeblock.js";
import { Speech }                  from "../core/speech.js";
import { approveTool }             from "../core/selftools.js";
import { awardSelfToolXp }         from "../core/leveling.js";

const colLeft  = () => document.getElementById("col-left");
const colRight = () => document.getElementById("col-right");

// ── Rich text renderer ─────────────────────────────────────────────────────
// Converts markdown-lite to HTML so lists, headers, bold render cleanly
function renderRich(text, container) {
  const lines   = text.split("\n");
  const frags   = [];
  let inList    = false;
  let listEl    = null;

  const closeList = () => {
    if (inList && listEl) { frags.push(listEl); listEl = null; inList = false; }
  };

  const inlineFormat = (s) =>
    s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
     .replace(/\*(.+?)\*/g,     "<em>$1</em>")
     .replace(/`([^`]+)`/g,     "<code class='inline-code'>$1</code>")
     .replace(/(https?:\/\/\S+)/g, "<a href='$1' target='_blank' rel='noopener'>$1</a>");

  lines.forEach(raw => {
    const line = raw.trimEnd();

    // ── Numbered list: "1. item" or "1) item"
    if (/^\d+[.)]\s+/.test(line)) {
      if (!inList || listEl?.tagName !== "OL") {
        closeList();
        listEl = document.createElement("ol");
        listEl.className = "msg-list";
        inList = true;
      }
      const li = document.createElement("li");
      li.innerHTML = inlineFormat(line.replace(/^\d+[.)]\s+/, ""));
      listEl.appendChild(li);
      return;
    }

    // ── Bullet list: "- item" or "• item" or "* item"
    if (/^[-•*]\s+/.test(line)) {
      if (!inList || listEl?.tagName !== "UL") {
        closeList();
        listEl = document.createElement("ul");
        listEl.className = "msg-list";
        inList = true;
      }
      const li = document.createElement("li");
      li.innerHTML = inlineFormat(line.replace(/^[-•*]\s+/, ""));
      listEl.appendChild(li);
      return;
    }

    // ── Heading: ## or ### or ──
    if (/^#{1,3}\s+/.test(line) || /^──+/.test(line)) {
      closeList();
      const h = document.createElement("div");
      h.className = "msg-heading";
      h.innerHTML = inlineFormat(line.replace(/^#+\s*/, "").replace(/^──+\s*/, ""));
      frags.push(h);
      return;
    }

    // ── Empty line → spacer
    if (!line.trim()) {
      closeList();
      const sp = document.createElement("div");
      sp.className = "msg-spacer";
      frags.push(sp);
      return;
    }

    // ── Regular paragraph
    closeList();
    const p = document.createElement("p");
    p.className = "msg-para";
    p.innerHTML = inlineFormat(line);
    frags.push(p);
  });

  closeList();
  container.innerHTML = "";
  container.classList.add("msg-rich");
  frags.forEach(f => container.appendChild(f));
}

// ── Render a message ───────────────────────────────────────────────────────
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

  // ── Controls: ▶ pause/play  🔁 reread  ✕ cancel — Flow only ────────
  if (!isUser) {
    const controls = document.createElement("div");
    controls.className = "msg-controls";

    // Play/Pause toggle
    const playBtn = document.createElement("button");
    playBtn.className     = "msg-play-btn";
    playBtn.textContent   = "▶";
    playBtn.title         = "Read aloud";
    playBtn.dataset.state = "idle";
    playBtn.addEventListener("click", () => {
      const s = playBtn.dataset.state;
      if (s === "playing")  Speech.pause();
      else if (s === "paused") Speech.resume();
      else Speech.speak(text, null, wrap);
    });

    // Re-read from beginning
    const rereadBtn = document.createElement("button");
    rereadBtn.className   = "msg-reread-btn";
    rereadBtn.textContent = "🔁";
    rereadBtn.title       = "Reread from beginning";
    rereadBtn.style.display = "none";
    rereadBtn.addEventListener("click", () => {
      Speech.reread(text, wrap);
    });

    // Cancel
    const cancelBtn = document.createElement("button");
    cancelBtn.className   = "msg-cancel-btn";
    cancelBtn.textContent = "✕";
    cancelBtn.title       = "Stop";
    cancelBtn.style.display = "none";
    cancelBtn.addEventListener("click", () => {
      Speech.cancel();
    });

    controls.appendChild(playBtn);
    controls.appendChild(rereadBtn);
    controls.appendChild(cancelBtn);

    // ── Feedback: thumbs up/down — feedback.js has always listened for
    // clicks on [data-feedback] via event delegation, but no button with
    // that attribute was ever actually rendered anywhere until now, so
    // the RLHF/correction system had no UI hook to fire from.
    const thumbUp = document.createElement("button");
    thumbUp.className = "msg-feedback-btn";
    thumbUp.dataset.feedback = "up";
    thumbUp.textContent = "👍";
    thumbUp.title = "Good response";

    const thumbDown = document.createElement("button");
    thumbDown.className = "msg-feedback-btn";
    thumbDown.dataset.feedback = "down";
    thumbDown.textContent = "👎";
    thumbDown.title = "Bad response — tell Flow what should've been said";

    controls.appendChild(thumbUp);
    controls.appendChild(thumbDown);
    wrap.appendChild(controls);
  }

  col.appendChild(wrap);

  // ── Render content ────────────────────────────────────────────────────
  if (!isUser && hasCode(text)) {
    renderWithCode(text, bubble);
  } else if (!isUser) {
    renderRich(text, bubble);
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
    return render(text, who, true);
  },

  addError(msg) {
    const col = colLeft();
    if (!col) return;
    const wrap   = document.createElement("div");
    wrap.className = "mwrap mleft";
    const label  = document.createElement("div");
    label.className = "mlabel"; label.textContent = "ERROR";
    const bubble = document.createElement("div");
    bubble.className   = "mbubble merror";
    bubble.textContent = "⚠️ " + msg;
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    col.appendChild(wrap);
    col.scrollTop = col.scrollHeight;
  },

  loadHistory() {
    Memory.get().forEach(m =>
      render(m.content, m.role === "user" ? "user" : "bot", false)
    );
  },

  showTyping() {
    if (document.getElementById("typing-indicator")) return;
    const col = colLeft();
    if (!col) return;
    const wrap  = document.createElement("div");
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

  // ── Self-tool proposal — shows Flow's proposed code with real
  // Approve/Reject buttons. Nothing is saved or ever runs until Joel
  // clicks Approve; Reject just removes the message with no side effects.
  // Modeled on the existing message-bubble pattern above rather than a
  // separate ad-hoc UI, so it looks and feels consistent with the rest
  // of the chat.
  addToolProposal(proposal) {
    const col = colLeft();
    if (!col) return;

    const wrap = document.createElement("div");
    wrap.className = "mwrap mleft fresh";

    const label = document.createElement("div");
    label.className = "mlabel";
    label.textContent = "FLOW WANTS TO CREATE A TOOL";

    const bubble = document.createElement("div");
    bubble.className = "mbubble mbot";

    const desc = document.createElement("p");
    desc.textContent = proposal.description;
    desc.style.marginBottom = "8px";

    const codeBlock = document.createElement("pre");
    codeBlock.className = "tool-proposal-code";
    codeBlock.style.cssText = "background:rgba(0,0,0,0.3);padding:10px;border-radius:8px;overflow-x:auto;font-size:12px;white-space:pre-wrap;";
    codeBlock.textContent = `function ${proposal.name}(${proposal.params.join(", ")}) {\n  ${proposal.code}\n}`;

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:10px;";

    const approveBtn = document.createElement("button");
    approveBtn.textContent = "✅ Approve";
    approveBtn.className = "tool-approval-btn tool-approval-btn--approve";

    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = "❌ Reject";
    rejectBtn.className = "tool-approval-btn tool-approval-btn--reject";

    const statusMsg = document.createElement("p");
    statusMsg.style.cssText = "margin-top:8px;font-size:13px;opacity:0.8;";

    approveBtn.addEventListener("click", () => {
      const result = approveTool(proposal);
      if (result.ok) {
        statusMsg.textContent = `✅ "${proposal.name}" saved — Flow can use it from now on.`;
        approveBtn.disabled = true;
        rejectBtn.disabled  = true;
        // Award XP only here — genuine success, Joel's explicit
        // approval, matches leveling.js's own doc comment for this
        // function exactly (never award for a mere proposal).
        awardSelfToolXp(proposal.name);
      } else {
        statusMsg.textContent = `⚠️ ${result.error}`;
      }
      bubble.appendChild(statusMsg);
    });

    rejectBtn.addEventListener("click", () => {
      wrap.remove(); // no side effects — nothing was ever saved or run
    });

    btnRow.appendChild(approveBtn);
    btnRow.appendChild(rejectBtn);

    bubble.appendChild(desc);
    bubble.appendChild(codeBlock);
    bubble.appendChild(btnRow);

    wrap.appendChild(label);
    wrap.appendChild(bubble);
    col.appendChild(wrap);
    col.scrollTop = col.scrollHeight;
  },
};
