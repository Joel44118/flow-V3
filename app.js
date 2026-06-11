// ═══════════════════════════════════════════
// app.js — Single entry point
// ALL imports at top, no duplicates
// ═══════════════════════════════════════════
import { CONFIG }        from "./core/config.js";
import { Storage }       from "./core/storage.js";
import { Memory }        from "./core/memory.js";
import { Weather }       from "./core/weather.js";
import { Alarms }        from "./core/alarms.js";
import { Speech }        from "./core/speech.js";
import { sendMessage, sendToAI, setUI } from "./core/ai.js";
import { initSlash, parseSlashCommand } from "./ui/slash.js";
import { startWakeListener, startCommandListen, init as initWake } from "./core/wakeword.js";
import { loadFromCloud, startAutoSync } from "./core/cloud.js";
import { goalsSummary, startGoalDeadlineWatcher, saveGoals } from "./core/goals.js";
import {
  setNotepad, setSpeakFn, setVision, setSearchHandlers,
  parseCommand, parseVisionCommand,
  getTime, getDate
} from "./core/commands.js";

import { Chat }        from "./ui/chat.js";
import { Orb }         from "./ui/orb.js";
import { Notepad }     from "./ui/notepad.js";
import { handleFiles, initFileUpload } from "./ui/fileupload.js";
import { initImagine, generateImage, removeBackground } from "./ui/imagine.js";
import { Camera, ScreenVision, YOLO, initVision } from "./ui/vision.js";
import { initKnowledge, Knowledge } from "./ui/knowledge.js";
import "./ui/particles.js";


// ── Handle slash commands ────────────────────────────────────────────────
async function handleSlashCmd(cmd, prompt) {
  const p = prompt.trim();
  switch (cmd) {
    // Images
    case "/image-flux":
      if (!p) { Chat.add("Tell me what to generate: /image-flux a sunset over Lagos", "bot"); return; }
      await generateImage(p, p); // force FLUX (non-design)
      break;
    case "/image-design":
      if (!p) { Chat.add("Describe your design: /image-design 'Your text' Twitter banner dark theme", "bot"); return; }
      await generateImage(p, "promotion banner design"); // force design mode
      break;

    // Search
    case "/search":
      if (!p) { Chat.add("What should I search for?", "bot"); return; }
      await sendToAI("Search the web and answer this: " + p);
      break;
    case "/research":
      if (!p) { Chat.add("What topic should I research deeply?", "bot"); return; }
      await sendToAI("Do deep research and give a thorough answer about: " + p);
      break;
    case "/url":
      if (!p) { Chat.add("Paste a URL after /url", "bot"); return; }
      sendMessage(p.startsWith("http") ? p : "https://" + p);
      break;

    // Code
    case "/code":
      if (!p) { Chat.add("Describe what code you need.", "bot"); return; }
      await sendToAI("Write code for this: " + p);
      break;

    // Productivity
    case "/alarm":
      if (!p) { Chat.add("When's the alarm? E.g. /alarm 3pm meeting", "bot"); return; }
      sendMessage("set alarm " + p);
      break;
    case "/goal":
      if (!p) { Chat.add("What's your goal?", "bot"); return; }
      sendMessage("add goal: " + p);
      break;
    case "/note":
      sendMessage("open notepad");
      break;
    case "/weather":
      sendMessage("weather");
      break;

    // Vision
    case "/camera":
      sendMessage("open camera");
      break;
    case "/screen":
      sendMessage("share screen");
      break;
    case "/yolo":
      sendMessage("start yolo");
      break;

    default:
      sendMessage(cmd + " " + p);
  }
}

// ── Wire cross-module dependencies ────────
setUI(Chat, Orb);
setNotepad(Notepad);
setSpeakFn((t) => Speech.speak(t));
initWake(sendMessage, (s) => Orb.setState(s));

const visionObj = { Camera, ScreenVision, YOLO };
initVision(Chat, Orb, sendMessage);
setVision(visionObj);
setSearchHandlers((t) => sendToAI(t), (t, w) => Chat.add(t, w));

// Init slash command palette
const _inputEl = document.getElementById("user-input");
initSlash(_inputEl, (cmd, prompt) => {
  // No-arg slash commands fire immediately
  handleSlashCmd(cmd, "");
});

initFileUpload(Chat, (t) => sendMessage(t), (s) => Orb.setState(s));
initImagine(Chat, Orb);
initKnowledge(Chat);

// ── Master send function ──────────────────
// Checks every command type before hitting API
async function flowSend(text) {
  if (!text?.trim()) return;
  text = text.trim();

  // Guard: if slash skill was just selected (mousedown filled the input),
  // the send-btn click fires ~50ms later. Ignore it.
  const inp = document.getElementById("user-input");
  if (inp?.dataset.slashJustSelected) return;

  // 0. Knowledge base commands
  if (/open\s+knowledge(\s+base)?|knowledge\s+base|my\s+knowledge/i.test(text)) {
    Knowledge.open();
    return;
  }


  // ── Slash command intercept ────────────────────────────────────────
  const slash = parseSlashCommand(text);
  if (slash) {
    const inp = document.getElementById("user-input");
    if (inp) { inp.value = ""; inp.placeholder = "Talk to Flow, Boss..."; inp.closest(".input-panel")?.classList.remove("slash-active"); }
    const hint = document.getElementById("slash-hint");
    if (hint) hint.classList.remove("visible");
    await handleSlashCmd(slash.cmd, slash.prompt);
    return;
  }

  // Images now handled by /image-flux and /image-design slash commands

  // 2. Vision commands
  const vis = await parseVisionCommand(text);
  if (vis !== false) { if (vis !== null) { Chat.add(vis,"bot"); Speech.speak(vis); } return; }

  // Search handled by /search /research /url slash commands

  // 4. Local commands (time, weather, alarms, sites, notepad)
  const local = await parseCommand(text);
  if (local !== false) { if (local !== null) { Chat.add(local,"bot"); Speech.speak(local); } return; }

  // Goals handled by /goal slash command

  // 6. AI (with RAG context automatically injected in ai.js)
  sendMessage(text);
}

// ── Input wiring ──────────────────────────
const inputEl = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const micBtn  = document.getElementById("mic-btn");

inputEl.addEventListener("keydown", e => { if (e.key === "Enter") { flowSend(inputEl.value); inputEl.value = ""; } });
sendBtn.addEventListener("click",   () => { flowSend(inputEl.value); inputEl.value = ""; });
micBtn.addEventListener("click",    () => startCommandListen());

// Pass flowSend to wakeword so voice commands use full pipeline
initWake(flowSend, (s) => Orb.setState(s));

// ── Vision popup ──────────────────────────
const visionToggle = document.getElementById("vision-toggle-btn");
const visionPopup  = document.getElementById("vision-popup");
visionToggle.addEventListener("click", e => { e.stopPropagation(); visionPopup.classList.toggle("open"); });
document.addEventListener("click", e => { if (!e.target.closest("#vision-popup-wrap")) visionPopup.classList.remove("open"); });
document.getElementById("btn-camera").addEventListener("click", () => { Camera.start();       visionPopup.classList.remove("open"); });
document.getElementById("btn-screen").addEventListener("click", () => { ScreenVision.start(); visionPopup.classList.remove("open"); });
document.getElementById("btn-yolo").addEventListener("click",   () => { YOLO.start();         visionPopup.classList.remove("open"); });
document.getElementById("btn-face").addEventListener("click",   () => { Camera.start().then?.(() => setTimeout(() => Camera.learnMyFace?.(), 1500)); visionPopup.classList.remove("open"); });

// ── File upload ───────────────────────────
const fileBtn   = document.getElementById("file-btn");
const fileInput = document.getElementById("file-input");
fileBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", e => { if (e.target.files.length) { handleFiles(e.target.files); e.target.value = ""; } });
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

// ── Notepad buttons ───────────────────────
document.getElementById("btn-clear").addEventListener("click",  () => Notepad.clear());
document.getElementById("btn-export").addEventListener("click", () => Notepad.export());
document.getElementById("btn-close").addEventListener("click",  () => Notepad.close());

// ── Brain menu ────────────────────────────
const brainBtn  = document.getElementById("brain-btn");
const brainMenu = document.getElementById("brain-menu");
const brainFile = document.getElementById("brain-file");
brainBtn.addEventListener("click", e => { e.stopPropagation(); brainMenu.classList.toggle("open"); });
document.addEventListener("click", () => brainMenu.classList.remove("open"));
document.getElementById("brain-export").addEventListener("click", () => {
  const msg = Storage.exportBrain(); Chat.add(msg,"bot"); Speech.speak(msg);
});
document.getElementById("brain-import").addEventListener("click", () => brainFile.click());
document.getElementById("brain-clear").addEventListener("click", () => {
  if (confirm("Clear ALL of Flow's memory?")) { Storage.clearAll(); Chat.add("Memory cleared.","bot"); Speech.speak("Clean slate."); }
});
brainFile.addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try { const msg = await Storage.importBrain(file); Chat.add(msg,"bot"); Speech.speak(msg); setTimeout(() => location.reload(), 2000); }
  catch(err) { Chat.addError(err); }
  e.target.value = "";
});

// ── Boot ──────────────────────────────────
(async () => {
  await loadFromCloud();
  Chat.loadHistory();
  Alarms.init((t) => Speech.speak(t));
  Weather.get();
  startAutoSync();
  startWakeListener();
  startGoalDeadlineWatcher((msg) => Speech.speak(msg), (msg, who) => Chat.add(msg, who));

  const hour     = new Date().getHours();
  const greeting = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  const name     = Memory.getProfile().nickname || Memory.getProfile().name || "Boss";
  const boot     = `${greeting}, ${name}. Flow online.`;
  Chat.add(boot, "bot");
  Orb.setState("speaking");
  Speech.speak(boot, () => Orb.setState("idle"));
})();
