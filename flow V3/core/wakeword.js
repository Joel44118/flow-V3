// ═══════════════════════════════════════════
// core/wakeword.js
// ═══════════════════════════════════════════
import { CONFIG }  from "./config.js";
import { Speech }  from "./speech.js";

let _sendFn = null;
let _orbFn  = null;
export function init(sendFn, setOrbState) {
  _sendFn = sendFn;
  _orbFn  = setOrbState;
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let wakeRec = null;
let cmdRec  = null;

export function startWakeListener() {
  if (!SR) { console.warn("[Flow] SR not supported"); return; }

  wakeRec = new SR();
  wakeRec.continuous     = true;
  wakeRec.interimResults = true;
  wakeRec.lang           = "en-US";
  wakeRec.maxAlternatives = 5;

  wakeRec.onresult = (e) => {
    if (Speech.isSpeaking()) return;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      let all = "";
      for (let a = 0; a < res.length; a++) all += " " + res[a].transcript.toLowerCase();

      if (CONFIG.WAKE_REGEX.test(all)) {
        document.getElementById("wake-indicator")?.classList.add("active");
        _orbFn?.("listening");

        if (res.isFinal) {
          document.getElementById("wake-indicator")?.classList.remove("active");
          const cmd = res[0].transcript.toLowerCase()
            .replace(CONFIG.WAKE_REGEX, "").replace(/[.,!?]/g,"").trim();
          if (cmd.length > 2) {
            _sendFn(cmd);
          } else {
            Speech.speak("Yeah, what's up?", () => startCommandListen());
            _orbFn?.("speaking");
          }
        }
      } else {
        if (res.isFinal) document.getElementById("wake-indicator")?.classList.remove("active");
      }
    }
  };

  wakeRec.onerror = (e) => {
    if (e.error !== "no-speech" && e.error !== "aborted")
      console.warn("[Flow] Wake SR error:", e.error);
  };

  wakeRec.onend = () => setTimeout(() => { try { wakeRec.start(); } catch(_){} }, 250);
  try { wakeRec.start(); } catch(_){}
}

export function startCommandListen() {
  if (!SR) return;
  try { wakeRec?.stop(); } catch(_){}
  if (cmdRec) { try { cmdRec.stop(); } catch(_){} }

  const micBtn = document.getElementById("mic-btn");
  cmdRec = new SR();
  cmdRec.lang = "en-US"; cmdRec.continuous = false; cmdRec.interimResults = false;
  cmdRec.maxAlternatives = 1;

  _orbFn?.("listening");
  if (micBtn) micBtn.textContent = "⏹";

  cmdRec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    const conf = e.results[0][0].confidence;
    if (conf < 0.35 && conf !== 0) {
      // low confidence — just try again silently
      _orbFn?.("idle"); return;
    }
    const inp = document.getElementById("user-input");
    if (inp) inp.value = text;
    _sendFn(text);
  };

  cmdRec.onerror = (e) => {
    if (e.error === "no-speech") console.log("[Flow] No speech detected");
    _orbFn?.("idle");
    if (micBtn) micBtn.textContent = "🎤";
  };

  cmdRec.onend = () => {
    if (micBtn) micBtn.textContent = "🎤";
    setTimeout(() => { try { wakeRec?.start(); } catch(_){} }, 350);
  };

  try { cmdRec.start(); } catch(e) {
    console.error("[Flow] cmdRec start failed:", e);
    if (micBtn) micBtn.textContent = "🎤";
    _orbFn?.("idle");
  }
}