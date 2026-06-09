import { CONFIG } from "./config.js";
import { Memory } from "./memory.js";
import { FLOW_IDENTITY } from "./identity.js";
import { Commands } from "./commands.js";
import { RAG } from "./rag.js";

let UI = null;
let Notepad = null;
let Vision = null;

export const AI = {
  setUI(ui) { UI = ui; },
  setNotepad(n) { Notepad = n; },
  setVision(v) { Vision = v; },

  async send(overrideText) {
    const inputEl = document.getElementById("user-input");
    const text = (typeof overrideText === "string" ? overrideText : inputEl?.value || "").trim();
    if (!text) return;

    if (inputEl) inputEl.value = "";
    if (UI) UI.setOrbState("thinking");

    // Show user message
    if (UI) UI.addMessage(text, "user");
    Memory.add("user", text);

    // Try local commands first (time, weather, alarms, open sites, etc.)
    const localReply = await Commands.handle(text);
    if (localReply) {
      if (UI) {
        UI.addMessage(localReply, "flow");
        UI.setOrbState("speaking");
        await UI.speak(localReply);
        UI.setOrbState("idle");
      }
      Memory.add("assistant", localReply);
      return;
    }

    // Build system prompt
    const ragContext = await RAG.search(text).catch(() => null);
    const systemPrompt = buildSystemPrompt(ragContext);

    // Detect intent locally
    const intent = detectIntent(text);

    // Build message history (last N turns)
    const history = Memory.getRecent(CONFIG.HISTORY_LIMIT || 10);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, systemPrompt, intent })
      });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error("Server returned invalid JSON. Check Vercel logs.");
      }

      if (!res.ok || data.error) {
        const errMsg = data?.error || `Server error ${res.status}`;
        console.error("[Flow] API error:", errMsg);
        if (UI) UI.addError("⚠️ " + errMsg);
        if (UI) UI.setOrbState("idle");
        return;
      }

      const reply = data.reply || "";
      Memory.add("assistant", reply);

      if (UI) {
        UI.addMessage(reply, "flow");
        UI.setOrbState("speaking");
        await UI.speak(reply);
        UI.setOrbState("idle");
      }

    } catch (e) {
      console.error("[Flow] Error:", e);
      if (UI) {
        UI.addError("⚠️ " + (e.message || "Connection failed. Check your internet and try again."));
        UI.setOrbState("idle");
      }
    }
  }
};

function detectIntent(msg) {
  const m = msg.toLowerCase();
  if (/\b(code|function|script|html|css|js|python|write me|build me|create a|implement)\b/.test(m)) return "code";
  if (/\b(search|find|look up|latest|news|research|what is|who is|when did)\b/.test(m)) return "research";
  if (/\b(image|picture|photo|generate|draw|design|logo|banner|wallpaper)\b/.test(m)) return "image";
  return "chat";
}

function buildSystemPrompt(ragContext) {
  const goals = Memory.get("goals") || [];
  const profile = Memory.get("profile") || {};
  const facts = Memory.get("facts") || [];

  let prompt = `${FLOW_IDENTITY.systemPrompt}\n\n`;

  if (profile.name) prompt += `You are talking to: ${profile.name}.\n`;
  prompt += `Current time: ${new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" })}.\n`;

  if (goals.length > 0) {
    prompt += `\nToday's goals:\n${goals.map((g, i) => `${i + 1}. ${g.text}${g.done ? " ✓" : ""}`).join("\n")}\n`;
  }

  if (facts.length > 0) {
    prompt += `\nThings I know about you:\n${facts.slice(-10).join("\n")}\n`;
  }

  if (ragContext) {
    prompt += `\nRelevant knowledge base:\n${ragContext}\n`;
  }

  return prompt;
}
