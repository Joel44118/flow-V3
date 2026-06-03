// ═══════════════════════════════════════════
// ui/notepad.js
// ═══════════════════════════════════════════
import { Storage } from "../core/storage.js";
import { Speech }  from "../core/speech.js";

const box  = document.getElementById("notepad-box");
const area = document.getElementById("notepad-text");

area.value = Storage.get("notes","");
area.addEventListener("input",()=> Storage.set("notes", area.value));

export const Notepad = {
  open(dictate=false) {
    box.classList.add("open");
    area.focus();
    Speech.speak(dictate ? "Notepad open. Go ahead." : "Notepad open.");
  },
  close() { box.classList.remove("open"); Speech.speak("Saved."); },
  clear() { area.value=""; Storage.set("notes",""); Speech.speak("Cleared."); },
  export() {
    const t=area.value.trim(); if(!t){Speech.speak("Nothing to export.");return;}
    const blob=new Blob([t],{type:"text/plain"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`flow-note-${Date.now()}.txt`; a.click();
    URL.revokeObjectURL(url); Speech.speak("Exported.");
  },
};