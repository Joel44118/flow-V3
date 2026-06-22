// ═══════════════════════════════════════════
// ui/screencontrol.js — Flow Screen Control
//
// Lets Flow control any browser tab via a
// companion Chrome extension. Flow parses
// natural language → structured action →
// postMessage to extension → extension runs
// it inside the target tab.
//
// Supported actions:
//   scroll   — "scroll down/up/to bottom/top"
//   click    — "click the [label/text]"
//   type     — "type [text] in [field]"
//   read     — "read the page / what does it say"
//   back     — "go back"
//   refresh  — "refresh the page"
//   navigate — "go to [url]"
//
// Flow ↔ Extension protocol (window.postMessage):
//   OUT: { source:"flow-control", action, payload }
//   IN:  { source:"flow-ext-reply", ok, result, error }
// ═══════════════════════════════════════════

let _chat     = null;
let _orb      = null;
let _sendAI   = null; // for "read page" — pipes content to Flow's AI
let _connected = false;
let _replyHandlerSet = false;

export function initScreenControl(chat, orb, sendAI) {
  _chat   = chat;
  _orb    = orb;
  _sendAI = sendAI;
  _listenForReplies();
}

// ── Extension reply listener (set once) ───────────────────────────────────
function _listenForReplies() {
  if (_replyHandlerSet) return;
  _replyHandlerSet = true;

  window.addEventListener("message", (e) => {
    if (e.data?.source !== "flow-ext-reply") return;

    const { ok, result, error, action } = e.data;

    if (!ok) {
      _chat?.addError(`Screen control failed: ${error || "unknown error"}`);
      _orb?.setState("idle");
      return;
    }

    if (action === "read") {
      // Pipe page text through Flow's AI for a smart summary
      if (result?.text) {
        _sendAI?.(
          `The user asked Flow to read the page they are sharing. Here is the page content:\n\n${result.text.slice(0, 4000)}\n\nSummarise what this page says clearly and concisely.`
        );
      } else {
        _chat?.add("The page appears to be empty or couldn't be read.", "bot");
      }
    } else if (action === "ping") {
      _connected = true;
      _chat?.add("✅ Flow Screen Control extension is connected. I can now scroll, click, type, and read pages for you.", "bot");
    } else {
      // Confirm other actions
      const confirms = {
        scroll:   "Done — page scrolled.",
        click:    result?.clicked
          ? `Clicked: "${result.clicked}"`
          : "Couldn't find that element — try describing it differently.",
        type:     result?.typed
          ? `Typed "${result.typed}" into the field.`
          : "Couldn't find an input field matching that description.",
        navigate: "Navigating…",
        back:     "Going back.",
        refresh:  "Page refreshing.",
        select:   result?.selected ? `Selected "${result.selected}"` : "Couldn't find that option.",
      };
      _chat?.add(confirms[action] || "Done.", "bot");
    }

    _orb?.setState("idle");
  });
}

// ── Send a command to the extension ──────────────────────────────────────
function _send(action, payload = {}) {
  window.postMessage({ source: "flow-control", action, payload }, "*");
}

// ── Check if extension is connected ──────────────────────────────────────
export function checkExtensionConnected() {
  _send("ping", {});
  // Give extension 800ms to reply — if no reply, it's not installed
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 800);
    const handler = (e) => {
      if (e.data?.source === "flow-ext-reply" && e.data?.action === "ping") {
        clearTimeout(t);
        window.removeEventListener("message", handler);
        resolve(true);
      }
    };
    window.addEventListener("message", handler);
  });
}

// ── Natural language → structured action ─────────────────────────────────
//
// Returns true if the command was a screen control action (handled here),
// false if it wasn't recognised as one (caller should pass to AI instead).
//
export async function parseScreenControl(text) {
  const t = text.toLowerCase().trim();

  // ── Scroll ───────────────────────────────────────────────────────────────
  if (/\bscroll\b/.test(t)) {
    let direction = "down";
    let amount    = 400;

    if (/top|beginning|start/.test(t))        { direction = "top"; }
    else if (/bottom|end/.test(t))            { direction = "bottom"; }
    else if (/up/.test(t))                    { direction = "up"; }
    else if (/down/.test(t))                  { direction = "down"; }

    // "scroll down a lot" / "scroll down a little"
    if (/a\s+lot|far|way\s+down|way\s+up/.test(t))   amount = 1200;
    if (/a\s+little|bit|slightly/.test(t))            amount = 150;

    _orb?.setState("thinking");
    _send("scroll", { direction, amount });
    return true;
  }

  // ── Click ────────────────────────────────────────────────────────────────
  const clickMatch = t.match(
    /\bclick\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button|\s+link|\s+tab|\s+icon|\s+menu)?\s*$/i
  );
  if (clickMatch) {
    const target = clickMatch[1].trim();
    if (target.length > 1) {
      _orb?.setState("thinking");
      _send("click", { target });
      return true;
    }
  }

  // ── Type ─────────────────────────────────────────────────────────────────
  // "type hello in the search box"
  // "type my name in the name field"
  // "write hello world in the input"
  const typeMatch = t.match(
    /\b(?:type|write|enter|input|put)\s+(.+?)\s+(?:in(?:to|side)?|on)\s+(?:the\s+)?(.+)/i
  ) || t.match(
    /\b(?:type|write|enter|input)\s+["']?(.+?)["']?\s*$/i
  );
  if (typeMatch) {
    const what  = typeMatch[1].trim().replace(/^["']|["']$/g, "");
    const where = typeMatch[2]?.trim() || "";
    if (what.length > 0) {
      _orb?.setState("thinking");
      _send("type", { text: what, field: where });
      return true;
    }
  }

  // ── Read page ─────────────────────────────────────────────────────────────
  if (/\bread\s+(?:the\s+)?(?:page|screen|site|website)\b|\bwhat\s+does\s+(?:the\s+)?(?:page|site|screen)\s+say\b|\bsummarise\s+(?:the\s+)?(?:page|site)\b/i.test(t)) {
    _orb?.setState("thinking");
    _send("read", {});
    return true;
  }

  // ── Navigate ─────────────────────────────────────────────────────────────
  const navMatch = t.match(/\bgo\s+to\s+(https?:\/\/\S+|\S+\.\S+)/i);
  if (navMatch) {
    let url = navMatch[1];
    if (!url.startsWith("http")) url = "https://" + url;
    _orb?.setState("thinking");
    _send("navigate", { url });
    return true;
  }

  // ── Back / forward ────────────────────────────────────────────────────────
  if (/\bgo\s+back\b|\bprevious\s+page\b/i.test(t)) {
    _send("back", {});
    return true;
  }

  // ── Refresh ───────────────────────────────────────────────────────────────
  if (/\brefresh\b|\breload\s+(?:the\s+)?page\b/i.test(t)) {
    _send("refresh", {});
    return true;
  }

  // ── Select dropdown option ────────────────────────────────────────────────
  // "select Nigeria from the country dropdown"
  const selectMatch = t.match(
    /\bselect\s+(.+?)\s+(?:from|in)\s+(?:the\s+)?(.+)/i
  );
  if (selectMatch) {
    _orb?.setState("thinking");
    _send("select", { option: selectMatch[1].trim(), field: selectMatch[2].trim() });
    return true;
  }

  // ── Connection check ─────────────────────────────────────────────────────
  if (/\b(?:is\s+(?:the\s+)?extension|screen\s+control)\s+connected\b|\bcheck\s+extension\b/i.test(t)) {
    const connected = await checkExtensionConnected();
    if (connected) {
      _chat?.add("✅ Flow Screen Control extension is connected and ready.", "bot");
    } else {
      _chat?.add(
        "❌ Flow Screen Control extension is not detected.\n\n" +
        "To install it:\n" +
        "1. Open Chrome → chrome://extensions\n" +
        "2. Enable **Developer mode** (top right toggle)\n" +
        "3. Click **Load unpacked**\n" +
        "4. Select the **flow-extension** folder from your Flow V3 project\n" +
        "5. Refresh this page — then try again.",
        "bot"
      );
    }
    return true;
  }

  return false; // not a screen control command
}
