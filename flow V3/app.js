// ═══════════════════════════════════════════
// app.js — Single entry point (ES module)
// Controls exact load order. No race conditions.
// ═══════════════════════════════════════════
import { CONFIG }        from "./core/config.js";
import { Storage }       from "./core/storage.js";
import { Memory }        from "./core/memory.js";
import { Weather }       from "./core/weather.js";
import { Alarms }        from "./core/alarms.js";
import { Speech }        from "./core/speech.js";
import { setNotepad, setSpeakFn } from "./core/commands.js";
import { sendMessage, setUI }     from "./core/ai.js";
import { startWakeListener, startCommandListen, init as initWake } from "./core/wakeword.js";
import { Chat }          from "./ui/chat.js";
import { Orb }           from "./ui/orb.js";
import { Notepad }       from "./ui/notepad.js";
import "./ui/particles.js";

// ── Wire cross-module dependencies ───────
// (avoids circular imports by injecting at boot)
setUI(Chat, Orb);
setNotepad(Notepad);
setSpeakFn((t) => Speech.speak(t));
initWake(sendMessage, (s) => Orb.setState(s));

// ── Input bar wiring ─────────────────────
const inputEl  = document.getElementById("user-input");
const sendBtn  = document.getElementById("send-btn");
const micBtn   = document.getElementById("mic-btn");

inputEl.addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
sendBtn.addEventListener("click",   ()  => sendMessage());
micBtn.addEventListener("click",    ()  => startCommandListen());

// ── Notepad buttons ──────────────────────
document.getElementById("btn-clear").addEventListener("click",  () => Notepad.clear());
document.getElementById("btn-export").addEventListener("click", () => Notepad.export());
document.getElementById("btn-close").addEventListener("click",  () => Notepad.close());

// ── Brain menu ───────────────────────────
const brainBtn  = document.getElementById("brain-btn");
const brainMenu = document.getElementById("brain-menu");
const brainFile = document.getElementById("brain-file");

brainBtn.addEventListener("click", (e) => { e.stopPropagation(); brainMenu.classList.toggle("open"); });
document.addEventListener("click", () => brainMenu.classList.remove("open"));

document.getElementById("brain-export").addEventListener("click", () => {
  const msg = Storage.exportBrain();
  Chat.add(msg,"bot"); Speech.speak(msg);
});
document.getElementById("brain-import").addEventListener("click", () => brainFile.click());
document.getElementById("brain-clear").addEventListener("click", () => {
  if (confirm("Clear ALL of Flow's memory? Cannot be undone.")) {
    Storage.clearAll();
    Chat.add("Memory cleared. Fresh start.", "bot");
    Speech.speak("Done. Clean slate.");
  }
});
brainFile.addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const msg = await Storage.importBrain(file);
    Chat.add(msg,"bot"); Speech.speak(msg);
    setTimeout(()=> location.reload(), 2000);
  } catch(err) { Chat.addError(err); }
  e.target.value="";
});

// ── Boot ─────────────────────────────────
Chat.loadHistory();
Alarms.init((t) => Speech.speak(t));
Weather.get(); // warm cache

startWakeListener();

const hour     = new Date().getHours();
const greeting = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
const name     = Memory.getProfile().nickname || Memory.getProfile().name || "Boss";
const boot     = `${greeting}, ${name}. Flow online. What are we doing today?`;
Chat.add(boot, "bot");
Speech.speak(boot, () => Orb.setState("idle"));
Orb.setState("speaking");