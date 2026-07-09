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
import { initSlash, getSlashState, clearSlash } from "./ui/slash.js";
import { activateAgent, deactivateAgent, getActiveAgent, onAgentChange, AGENTS } from "./core/agent.js";
import { startRecording, stopRecordingAndTranscribe, cancelRecording } from "./core/whisper.js";
import { loadFromCloud, startAutoSync } from "./core/cloud.js";
import { goalsSummary, startGoalDeadlineWatcher, saveGoals } from "./core/goals.js";
import {
  setNotepad, setSpeakFn, setVision, setSearchHandlers, setScreenControl,
  parseCommand, parseVisionCommand, parseSearchGoalCommand,
  handleRepoCommand, handleScaffoldCommand, handlePushCommand,
  checkPendingPush, setHistoryFn, getTime, getDate
} from "./core/commands.js";

import { Chat }        from "./ui/chat.js";
import { Orb }         from "./ui/orb.js";
import { Notepad }     from "./ui/notepad.js";
import { handleFiles, initFileUpload } from "./ui/fileupload.js";
import { initStagedFiles, stageFiles, clearStaged, getStagedFiles, hasStagedFiles } from "./ui/stagedfiles.js";
import { initImagine, generateImage, removeBackground } from "./ui/imagine.js";
import { initVideoGen, generateVideo, generateVideoFromImage } from "./ui/videogen.js";
import { Camera, ScreenVision, YOLO, initVision } from "./ui/vision.js";
import { initKnowledge, Knowledge } from "./ui/knowledge.js";
import { setGlobeBackground } from "./ui/particles.js";
import { fetchIntel, buildIntelPrompt } from "./core/intel.js";
import { extractMemory, getExtractedMemoryContext } from "./core/memextract.js";
import { Projects } from "./core/projects.js";
import { initAuth, resetPin, enrollFace, resetFace, hasFaceEnrolled } from "./ui/auth.js";
import { initNotifications } from "./ui/notifications.js";
import { initLeveling, getLevelState } from "./core/leveling.js";
import { initSentinel, parseReplayCommand } from "./ui/sentinel.js";
import { initFeedback } from "./core/feedback.js";
import { initProjects, handleProjectCommand } from "./ui/projects.js";
import { initScreenControl, parseScreenControl } from "./ui/screencontrol.js";
import { Gesture, initGesture } from "./ui/gesture.js";

// ── Handle slash commands ─────────────────────────────────────────────────
function _openProjects() { document.getElementById('proj-btn')?.click(); }

async function handleSlashCmd(cmd, prompt) {
  const p = prompt.trim();
  // Reset globe if switching to a non-intel skill
  if (cmd !== "/intel") setGlobeBackground(false);
  switch (cmd) {
    case "/image-flux":
      if (!p) { Chat.add("What should I generate? e.g. a sunset over Lagos", "bot"); return; }
      await generateImage(p, p);
      break;
    case "/video": {
      // If Joel attached an image (via the existing staged-files upload
      // UI) before running this command, animate that image instead of
      // generating from text alone — this is the image-to-video path,
      // using Stable Video Diffusion (see ui/videogen.js for why that
      // model specifically, and its real limitation: it animates the
      // image only, it does not also follow a text prompt).
      const staged = getStagedFiles?.() || [];
      const imageFile = staged.find(f => f.type?.startsWith("image/"));
      if (imageFile) {
        await generateVideoFromImage(imageFile);
        clearStaged?.();
        return;
      }
      if (!p) { Chat.add("What should the video show? e.g. waves crashing on a beach at sunset — or attach an image first to animate it instead.", "bot"); return; }
      await generateVideo(p);
      break;
    }
    case "/scrape":
      if (!p) { Chat.add("What URL should I scrape? e.g. https://client-website.com", "bot"); return; }
      Chat.add(`🕸️ Scraping ${p}...`, "bot");
      try {
        const scrapeR = await fetch("/api/rag?action=scrape", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: p }),
        });
        const scrapeD = await scrapeR.json();
        if (!scrapeD.ok) { Chat.addError(scrapeD.error); break; }
        Chat.add(`✅ Scraped ${scrapeD.count} page(s) from ${p}. Want me to save this to the knowledge base? Say "save [a title] to knowledge base" and I'll use what was just scraped.`, "bot");
        window.__lastScrapedPages = scrapeD.pages; // held in memory for an immediate follow-up save
      } catch (e) { Chat.addError(e.message); }
      break;
    case "/find-leads":
      if (!p) { Chat.add("What should I search for? e.g. web design agencies in Lagos", "bot"); return; }
      Chat.add(`🔍 Searching for "${p}"...`, "bot");
      try {
        const leadR = await fetch("/api/rag?action=find-leads", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: p }),
        });
        const leadD = await leadR.json();
        if (!leadD.ok) { Chat.addError(leadD.error); break; }
        if (!leadD.count) { Chat.add("No results with public contact info found for that search.", "bot"); break; }
        const list = leadD.leads.map(l => `**${l.name}**${l.website ? `\n  🌐 ${l.website}` : ""}${l.phone ? `\n  📞 ${l.phone}` : ""}${l.email ? `\n  ✉️ ${l.email}` : ""}`).join("\n\n");
        Chat.add(`Found ${leadD.count} result(s) with public contact info:\n\n${list}`, "bot");
      } catch (e) { Chat.addError(e.message); }
      break;
    case "/image-design":
      if (!p) { Chat.add("Describe your design. e.g. 'Joelflowstack' Twitter promo, dark theme", "bot"); return; }
      await generateImage(p, "promotion banner design");
      break;
    case "/search":
      if (!p) { Chat.add("What should I search for?", "bot"); return; }
      await sendToAI("Search the web and answer this: " + p);
      break;
    case "/research":
      if (!p) { Chat.add("What topic should I research?", "bot"); return; }
      await sendToAI("Do deep research and give a thorough answer about: " + p);
      break;
    case "/url":
      if (!p) { Chat.add("Paste a URL after /url", "bot"); return; }
      sendMessage(p.startsWith("http") ? p : "https://" + p);
      break;
    case "/code":
      if (!p) { Chat.add("What code do you need?", "bot"); return; }
      await sendToAI("Write code for this: " + p);
      break;
    case "/alarm":
      if (!p) { Chat.add("When's the alarm? e.g. 3pm meeting", "bot"); return; }
      sendMessage("set alarm " + p);
      break;
    case "/goal":
      if (!p) { Chat.add("What's your goal?", "bot"); return; }
      sendMessage("add goal: " + p);
      break;
    case "/note":    sendMessage("open notepad");   break;
    case "/weather": sendMessage("weather");        break;
    case "/camera":  sendMessage("open camera");    break;
    case "/screen":  sendMessage("share screen");   break;
    case "/yolo":    sendMessage("start yolo");     break;
    case "/github":
      if (!p) { Chat.add("Paste a GitHub repo URL or say what to search for. e.g. /github https://github.com/owner/repo", "bot"); return; }
      await parseSearchGoalCommand(p.startsWith("http") ? p : "search github " + p);
      break;
    case "/branch":
      if (!p) { Chat.add("Usage: create dev in flowpay\nor: create dev from main in flowpay", "bot"); return; }
      await parseSearchGoalCommand("create a branch " + p);
      break;
    case "/pr":
      if (!p) { Chat.add("Usage: dev to main in flowpay\nor: dev to main in flowpay title: My PR", "bot"); return; }
      await parseSearchGoalCommand("create a pull request from " + p);
      break;
    case "/delete":
      if (!p) { Chat.add("Usage: src/old.js from flowpay", "bot"); return; }
      await parseSearchGoalCommand("delete " + p);
      break;
    case "/branches":
      if (!p) { Chat.add("Which repo? e.g. /branches flowpay", "bot"); return; }
      await parseSearchGoalCommand("list branches in " + p);
      break;
    case "/repo":
      if (!p) { Chat.add("Name the repo: e.g. /repo my-project  A short description", "bot"); return; }
      await handleRepoCommand(p);
      break;
    case "/scaffold":
      // Free-form: /scaffold <anything> — e.g. "flowpay repo" or "Joel44118/flowpay a payment app"
      if (!p) { Chat.add("Tell me what to scaffold. e.g.:\n/scaffold flowpay\n/scaffold Joel44118/myapp  A REST API with Express", "bot"); return; }
      await parseSearchGoalCommand("create a structure for " + p);
      break;
    case "/push":
      // Free-form: /push <anything> — e.g. "it to flowpay" or "the files to Joel44118/myapp"
      if (!p) { Chat.add("Tell me what to push. e.g.:\n/push it to flowpay\n/push the structure to Joel44118/myapp", "bot"); return; }
      await parseSearchGoalCommand("push " + p);
      break;
    case "/agent": {
      if (!p || p === "exit" || p === "off") {
        const was = getActiveAgent();
        deactivateAgent();
        Chat.add((was ? was.icon + " " + was.name : "Agent mode") + " deactivated. Back to standard Flow.", "bot");
      } else {
        const id = p.toLowerCase().trim().split(/\s/)[0];
        if (AGENTS[id]) {
          activateAgent(id).then(agent => {
            if (agent) Chat.add(agent.icon + " " + agent.name + " is live, Boss. Just talk to me naturally — no commands or patterns needed.", "bot");
          });
        } else {
          Chat.add("Which agent?\n💻 /agent coding\n🔬 /agent research\n✍️ /agent content\n📈 /agent business\n\nOr just say: \"enter coding agent\" anytime.", "bot");
        }
      }
      break;
    }
        case "/intel": {
      const focus = p || "general";
      Chat.add("Pulling world intelligence" + (p ? ` (focus: ${p})` : "") + "...", "bot");
      setGlobeBackground(true);   // transform background to world map
      try {
        const data   = await fetchIntel(focus);

        // Real images, pulled directly from each story's own RSS feed
        // entry (media:thumbnail/enclosure tags) — NOT a generic web
        // image search, so every image shown is actually the real
        // photo attached to that specific real news item, correctly
        // attributed to its source, not a loosely-related stock photo.
        const allItems = [
          ...(data.news || []),
          ...(data.conflicts || []),
          ...(data.targeted || []),
        ];
        const withImages = allItems.filter(item => item.image).slice(0, 4);

        if (withImages.length) {
          _renderIntelGallery(withImages);
        }

        const prompt = buildIntelPrompt(data, focus);
        await sendToAI(prompt);
      } catch(e) {
        setGlobeBackground(false);
        Chat.add("⚠️ Intel fetch failed: " + e.message, "bot");
      }
      break;
    }
    case "/project": {
      if (!p) { _openProjects(); return; }
      const parsed = Projects.parse(p);
      if (parsed) { handleProjectCommand(parsed); return; }
      sendMessage(p);
      break;
    }
    case "/gesture": {
      // Detection needs a real <video> element for MediaPipe's Camera
      // utility to attach to, but Joel never sees this one directly —
      // the actual visible camera preview is the separate, always-on-top,
      // click-through Electron overlay window (see main.js createOverlay,
      // which already renders the feed pinned to the screen's top-left
      // corner, independent of Flow's own window). This hidden element
      // exists purely as MediaPipe's required attachment point.
      if (/^stop\b/i.test(p || "")) {
        Gesture.stop?.();
        Chat.add("✋ Gesture control stopped.", "bot");
        break;
      }
      let hiddenVideo = document.getElementById("gesture-hidden-video");
      if (!hiddenVideo) {
        hiddenVideo = document.createElement("video");
        hiddenVideo.id = "gesture-hidden-video";
        hiddenVideo.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;";
        hiddenVideo.autoplay = true;
        hiddenVideo.muted = true;
        document.body.appendChild(hiddenVideo);
      }
      await Gesture.start(hiddenVideo);
      break;
    }
    default:         sendMessage(cmd + " " + p);
  }
}

// ── Wire cross-module dependencies ────────────────────────────────────────
setUI(Chat, Orb);
window.__flowOrb = Orb; // used by speech.js cancel/pause to reset orb state
setNotepad(Notepad);
setSpeakFn((t) => Speech.speak(t));

const visionObj = { Camera, ScreenVision, YOLO, Gesture };
initVision(Chat, Orb, sendMessage);
setVision(visionObj);
setSearchHandlers((t) => sendToAI(t), (t, w) => Chat.add(t, w));
setHistoryFn(() => Memory.forAPI());

// Screen control — gives Flow the ability to scroll/click/type on
// any tab that's being shared. Only fires when ScreenVision is active.
initScreenControl(Chat, Orb, sendToAI);
setScreenControl({ parseScreenControl });

// Gesture control — MediaPipe Hands, lazy-loaded on first use
initGesture(Chat, Orb);

// Agent mode badge — updates orb area label when agent activates/deactivates
onAgentChange(agent => {
  const badge = document.getElementById("agent-badge");
  if (!badge) return;
  if (agent) {
    badge.textContent = agent.icon + " " + agent.name;
    badge.style.display = "block";
    badge.style.color   = agent.color;
  } else {
    badge.style.display = "none";
  }
});

// Init slash palette
const _inputEl = document.getElementById("user-input");
initSlash(_inputEl, (cmd) => handleSlashCmd(cmd, ""));

initFileUpload(Chat, (t) => sendMessage(t), (s) => Orb.setState(s));
initImagine(Chat, Orb);
initVideoGen(Chat, Orb);
initKnowledge(Chat);
initProjects(Chat, (t) => sendToAI(t));

// ── Master send function ──────────────────────────────────────────────────
async function flowSend(text) {
  if (!text?.trim()) return;
  text = text.trim();

  // Internal status notices from wakeword.js (voice engine start/fail
  // messages) use a __SYSTEM__ prefix. These must render as a bot message,
  // never be echoed as something the user typed or sent to the AI —
  // otherwise voice-engine diagnostics would look like broken user input.
  if (text.startsWith("__SYSTEM__")) {
    Chat.add(text.slice("__SYSTEM__".length), "bot");
    return;
  }

  // Echo the user's own message + record it to memory FIRST, before any
  // local-command parsing runs. Previously this only happened deep inside
  // sendMessage() in core/ai.js — so if any parser below it threw (more
  // likely the longer a session ran and the bigger history/repo context
  // got), the message never rendered at all and Flow looked dead. Now it
  // always shows immediately, and a real error is surfaced if something
  // downstream breaks instead of failing silently.
  Chat.add(text, "user");
  Memory.add("user", text);

  try {
    // Intercept pending file push (set by /push command)
    if (await checkPendingPush(text)) return;

    // Watch · Learn · Replicate — Electron-only, safely no-ops elsewhere.
    // Checked early so a confirmation like "do it" isn't swallowed by a
    // more generic parser further down the chain.
    if (await parseReplayCommand(text)) return;

    // Knowledge base
    if (/open\s+knowledge(\s+base)?|knowledge\s+base|my\s+knowledge/i.test(text)) {
      Knowledge.open(); return;
    }

    // Vision commands (camera, screen, yolo)
    const vis = await parseVisionCommand(text);
    if (vis !== false) { if (vis !== null) { Chat.add(vis,"bot"); Speech.speak(vis); } return; }

    // Gesture control — explicit phrase check here rather than relying on
    // whatever mechanism the other slash commands use for natural-language
    // matching (not fully traced), since this needs to reliably work from
    // both typed text and voice transcripts without guessing.
    if (/\b(start|begin|activate)\b.*\bgesture\b|\bgesture\s*control\b/i.test(text) && !/\bstop\b/i.test(text)) {
      await handleSlashCmd("/gesture", "");
      return;
    }
    if (/\bstop\b.*\bgesture\b/i.test(text)) {
      await handleSlashCmd("/gesture", "stop");
      return;
    }

    // Project workspace commands
    const projCmd = Projects.parse(text);
    if (projCmd) { handleProjectCommand(projCmd); return; }

    // Local commands (time, weather, alarms, sites, notepad)
    const local = await parseCommand(text);
    if (local !== false) { if (local !== null) { Chat.add(local,"bot"); Speech.speak(local); } return; }

    // Search, GitHub, goals, agents, push/scaffold
    const search = await parseSearchGoalCommand(text);
    if (search !== false) { if (search !== null) { Chat.add(search,"bot"); Speech.speak(search); } return; }

    // AI — user bubble already echoed above, so skip the duplicate
    await sendMessage(text, { skipEcho: true });
    setGlobeBackground(false);  // reset world map after response
    setTimeout(() => extractMemory(Memory.get()), 1500);
  } catch (err) {
    // Safety net — without this, any uncaught error in the parsers above
    // (e.g. on a huge pasted error log / code block) silently killed the
    // whole turn: no reply, no error, nothing. Now it always surfaces.
    console.error("[Flow] flowSend error:", err);
    Chat.hideTyping();
    Chat.addError("Something broke handling that — " + (err?.message || "unknown error") + ". Try again or rephrase it.");
    Orb.setState("idle");
  }
}

// ── Input wiring ──────────────────────────────────────────────────────────
const inputEl = document.getElementById("user-input");
const getInput = () => inputEl.textContent.trim();
const setInput = (v) => { inputEl.textContent = v; };
const clearInput = () => { inputEl.textContent = ""; };
const sendBtn = document.getElementById("send-btn");
const micBtn  = document.getElementById("mic-btn");

async function doSend() {
  // Check if a slash chip is active first
  const slash = getSlashState();
  if (slash) {
    clearSlash();
    await handleSlashCmd(slash.cmd, slash.prompt);
    return;
  }
  const text = getInput();

  // Staged files present — process them together, with the typed text as context/instruction
  if (hasStagedFiles()) {
    const files = getStagedFiles();
    clearInput();
    clearStaged();
    await handleFiles(files, text); // text passed as the instruction (e.g. "edit this image")
    return;
  }

  // Plain text only
  if (!text) return;
  clearInput();
  flowSend(text).catch(err => {
    // flowSend already has its own try/catch, but this is a last-resort
    // net in case something throws before that (e.g. Memory.add itself).
    console.error("[Flow] Unhandled send error:", err);
    Chat.addError("Something went wrong sending that — " + (err?.message || "unknown error"));
    Orb.setState("idle");
  });
}

// Enter key — only fires if palette is NOT open
inputEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    if (!document.getElementById("slash-palette")?.classList.contains("open")) {
      e.preventDefault();
      doSend();
    }
  }
});

sendBtn.addEventListener("click", doSend);

// ── Mic button: click-to-record, click again to stop + transcribe ──────
// Replaces the old wake-word/Deepgram continuous-listening approach —
// after extensive debugging (token freshness, TTL, scope, think-provider
// config all checked and fixed, then a completely raw WebSocket test
// OUTSIDE Flow's own code ALSO failed with zero diagnostic detail),
// Deepgram's connection kept failing for reasons pointing at Joel's local
// network/security-software environment, not a code bug. This uses
// Hugging Face's hosted Whisper instead — same proven-working token
// pattern already used by ui/imagine.js and ui/videogen.js — via
// click-to-record, PLUS local wake-word ("Wake up Flow") in the Electron
// build specifically. The Electron main process runs its own always-on
// detection pipeline (flow-electron/wakeword-engine.js) and pushes a
// 'wakeword-detected' IPC event here when it hears the phrase — see the
// listener below. Web/browser builds still rely on click-to-record only,
// since a browser tab can't keep a mic hot in the background.
let _isRecording = false;
micBtn.addEventListener("click", async () => {
  if (!_isRecording) {
    try {
      await startRecording();
      _isRecording = true;
      micBtn.classList.add("recording");
      Orb.setState("listening");
    } catch (e) {
      Chat.addError?.(`Couldn't access microphone: ${e.message}`);
    }
    return;
  }

  _isRecording = false;
  micBtn.classList.remove("recording");
  Orb.setState("thinking");
  try {
    const text = await stopRecordingAndTranscribe();
    Orb.setState("idle");
    if (text) flowSend(text);
  } catch (e) {
    Orb.setState("idle");
    Chat.addError?.(`Transcription failed: ${e.message}`);
  } finally {
    cancelRecording?.();
  }
});

// ── Wake word — "Wake up Flow" (Electron only) ──────────────────────────
// window.__flowElectron only exists inside the Electron build (exposed by
// preload.js's contextBridge) — this whole block is a silent no-op in the
// regular web app, so it's safe to leave in shared app.js without an
// extra environment check beyond this one guard.
if (window.__flowElectron?.wakeword) {
  window.__flowElectron.wakeword.onDetected(async () => {
    // Ignore if already mid-recording (e.g. Joel clicked the mic manually
    // right before saying the wake word) — avoids double-triggering the
    // same start/stop cycle from two different sources at once.
    if (_isRecording) return;

    try {
      await startRecording();
      _isRecording = true;
      micBtn.classList.add("recording");
      Orb.setState("listening");
    } catch (e) {
      Chat.addError?.(`Couldn't access microphone: ${e.message}`);
      return;
    }

    // Wake-word start has no manual "click again to stop" step — Flow
    // needs to decide on its own when Joel has stopped talking. Reuses
    // whatever silence/end-of-speech detection startRecording()/
    // stopRecordingAndTranscribe() already implement internally; this
    // just waits a fixed window before calling stop. If core/whisper.js
    // has its own voice-activity-detection already built in, this timeout
    // can likely be removed entirely — worth checking before assuming a
    // fixed delay is the best approach long-term.
    setTimeout(async () => {
      if (!_isRecording) return; // already stopped some other way
      _isRecording = false;
      micBtn.classList.remove("recording");
      Orb.setState("thinking");
      try {
        const text = await stopRecordingAndTranscribe();
        Orb.setState("idle");
        if (text) flowSend(text);
      } catch (e) {
        Orb.setState("idle");
        Chat.addError?.(`Transcription failed: ${e.message}`);
      } finally {
        cancelRecording?.();
      }
    }, 4000); // 4s recording window after wake word — tune based on real testing
  });
}
    Chat.addError?.(`Voice transcription failed: ${e.message}`);
}
});

// ── Vision popup ──────────────────────────────────────────────────────────
const visionToggle = document.getElementById("vision-toggle-btn");
const visionPopup  = document.getElementById("vision-popup");
visionToggle.addEventListener("click", e => { e.stopPropagation(); visionPopup.classList.toggle("open"); });
document.addEventListener("click", e => { if (!e.target.closest("#vision-popup-wrap")) visionPopup.classList.remove("open"); });
document.getElementById("btn-camera").addEventListener("click", () => { Camera.start();       visionPopup.classList.remove("open"); });
document.getElementById("btn-screen").addEventListener("click", () => { ScreenVision.start(); visionPopup.classList.remove("open"); });
document.getElementById("btn-yolo").addEventListener("click",   () => { YOLO.start();         visionPopup.classList.remove("open"); });
document.getElementById("btn-face").addEventListener("click",   () => { Camera.start().then?.(() => setTimeout(() => Camera.learnMyFace?.(), 1500)); visionPopup.classList.remove("open"); });

// ── File upload ───────────────────────────────────────────────────────────
const fileBtn   = document.getElementById("file-btn");
const fileInput = document.getElementById("file-input");
fileBtn.addEventListener("click", () => fileInput.click());
// Stage files instead of processing immediately — user can remove with X before sending
fileInput.addEventListener("change", e => { if (e.target.files.length) { stageFiles(e.target.files); e.target.value = ""; } });
initStagedFiles((count) => {
  sendBtn.classList.toggle("has-staged", count > 0);
});
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); if (e.dataTransfer.files.length) stageFiles(e.dataTransfer.files); });

// ── Notepad ───────────────────────────────────────────────────────────────
document.getElementById("btn-clear").addEventListener("click",  () => Notepad.clear());
document.getElementById("btn-export").addEventListener("click", () => Notepad.export());
document.getElementById("btn-close").addEventListener("click",  () => Notepad.close());

// ── Brain menu ────────────────────────────────────────────────────────────
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

// Reset PIN
const resetPinBtn = document.getElementById("brain-resetpin");
if (resetPinBtn) resetPinBtn.addEventListener("click", () => resetPin());

// Face Unlock — enroll / remove
const enrollFaceBtn = document.getElementById("brain-enrollface");
if (enrollFaceBtn) enrollFaceBtn.addEventListener("click", () => {
  enrollFace((success, message) => Chat.add(success ? `✅ ${message}` : `⚠️ ${message}`, "bot"));
});
const resetFaceBtn = document.getElementById("brain-resetface");
if (resetFaceBtn) resetFaceBtn.addEventListener("click", () => {
  if (!hasFaceEnrolled()) { Chat.add("No face is currently set up.", "bot"); return; }
  if (!confirm("Remove Face Unlock? The 👁 button will stop appearing on your lock screen — your PIN keeps working as normal.")) return;
  resetFace();
  Chat.add("Face Unlock removed.", "bot");
});

// Init feedback (RLHF learning)
initFeedback(Chat);
initNotifications(Chat);
initSentinel(Chat);

// ── Leveling system UI ──────────────────────────────────────────────────
function _renderLevelBar() {
  const s = getLevelState();
  const numEl  = document.getElementById("level-bar-num");
  const fillEl = document.getElementById("level-bar-fill");
  const xpEl   = document.getElementById("level-bar-xp");
  if (numEl)  numEl.textContent = s.level;
  if (fillEl) fillEl.style.width = s.percent + "%";
  if (xpEl)   xpEl.textContent = `${s.xp}/${s.xpNeeded}`;
}

// Renders a small inline image gallery in chat for /intel results — real
// images pulled directly from each story's own RSS entry (see
// api/intel.js), each one clickable through to its actual source
// article. Kept simple (a lightweight <div> grid, not a full Visualizer
// widget) since this is chat-embedded content, not a standalone view.
function _renderIntelGallery(items) {
  const wrap = document.createElement("div");
  wrap.className = "mwrap mleft";

  const gallery = document.createElement("div");
  gallery.className = "intel-gallery";

  items.forEach(item => {
    const card = document.createElement("a");
    card.className = "intel-gallery-card";
    card.href = item.link || item.url || "#";
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.title = item.title;

    const img = document.createElement("img");
    img.src = item.image;
    img.alt = item.title;
    img.loading = "lazy";
    img.onerror = () => card.remove(); // if the image URL is dead/blocked, just drop that card rather than show a broken image icon

    const caption = document.createElement("div");
    caption.className = "intel-gallery-caption";
    caption.textContent = `${item.source || ""} — ${item.title}`.slice(0, 90);

    card.appendChild(img);
    card.appendChild(caption);
    gallery.appendChild(card);
  });

  wrap.appendChild(gallery);
  document.getElementById("col-left")?.appendChild(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "end" });
}

function _showLevelUpCard(newLevel) {
  const card = document.getElementById("level-up-card");
  if (!card) return;
  card.innerHTML = `
    <div class="lu-title">LEVEL UP</div>
    <div class="lu-level">${newLevel}</div>
    <div class="lu-sub">Flow just learned something new</div>
  `;
  card.classList.add("show");
  setTimeout(() => card.classList.remove("show"), 3200);
}

// Small "+N XP" toast that floats up near the level bar on every award,
// separate from the (rarer) full level-up card — this is what makes XP
// gains visible in real time instead of only becoming visible after a
// page reload, which was the actual gap: _renderLevelBar existed, but
// nothing was calling it except on boot and on a full level-up.
let _xpToastTimeout = null;
function _showXpToast(amount, reason) {
  let toast = document.getElementById("xp-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "xp-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = `+${amount} XP`;
  toast.title = reason || "";
  toast.classList.remove("show"); // restart animation even if a toast is already mid-fade
  void toast.offsetWidth; // force reflow so the removed class actually re-applies
  toast.classList.add("show");
  clearTimeout(_xpToastTimeout);
  _xpToastTimeout = setTimeout(() => toast.classList.remove("show"), 1800);
}

initLeveling(
  (newLevel, reason) => { _showLevelUpCard(newLevel); },     // fires only on an actual level-up
  (amount, reason, leveledUp) => {                              // fires on EVERY award, level-up or not
    _renderLevelBar();
    if (amount) _showXpToast(amount, reason);
  }
).then(_renderLevelBar);

// ── Boot ──────────────────────────────────────────────────────────────────
(async () => {
  // Auth gate — blocks until correct PIN entered
  await initAuth();

  await loadFromCloud();
  Chat.loadHistory();
  Alarms.init((t) => Speech.speak(t));
  Weather.get();
  startAutoSync();
  // startWakeListener() removed — replaced by click-to-record Whisper
  // flow on the mic button (see micBtn handler above). No continuous
  // background listener needed for this simpler, more reliable approach.
  startGoalDeadlineWatcher((msg) => Speech.speak(msg), (msg, who) => Chat.add(msg, who));

  // Greeting throttle — only greet if >5 hours since last greeting
  const GREET_KEY      = "flow_last_greeted";
  const GREET_INTERVAL = 5 * 60 * 60 * 1000; // 5 hours
  const lastGreeted    = parseInt(localStorage.getItem(GREET_KEY) || "0", 10);
  const shouldGreet    = Date.now() - lastGreeted > GREET_INTERVAL;

  if (shouldGreet) {
    const hour     = new Date().getHours();
    const greeting = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
    const name     = Memory.getProfile().nickname || Memory.getProfile().name || "Boss";
    const boot     = `${greeting}, ${name}. Flow online.`;
    Chat.add(boot, "bot");
    Orb.setState("speaking");
    Speech.speak(boot, () => Orb.setState("idle"));
    localStorage.setItem(GREET_KEY, String(Date.now()));
  } else {
    Orb.setState("idle");
  }
})();
