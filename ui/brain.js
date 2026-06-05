// ═══════════════════════════════════════════
// ui/brain.js — Brain export/import/clear UI
// ═══════════════════════════════════════════

const Brain = (() => {
  const menu = document.getElementById("brain-menu");

  function toggleMenu() {
    menu.classList.toggle("open");
  }

  // Close menu when clicking elsewhere
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#brain-btn") && !e.target.closest("#brain-menu"))
      menu.classList.remove("open");
  });

  function exportFn() {
    menu.classList.remove("open");
    const msg = Storage.exportBrain();
    Chat.addMessage(msg, "bot");
    Speech.speak(msg);
  }

  function importPrompt() {
    menu.classList.remove("open");
    document.getElementById("brain-file-input").click();
  }

  async function importFn(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const msg = await Storage.importBrain(file);
      Chat.addMessage(msg, "bot");
      Speech.speak(msg);
      // Reload page to apply brain
      setTimeout(() => location.reload(), 2000);
    } catch(err) {
      Chat.addMessage("⚠️ " + err, "sys");
    }
    event.target.value = "";
  }

  function clearConfirm() {
    menu.classList.remove("open");
    if (confirm("Clear ALL of Flow's memory? This cannot be undone.")) {
      Storage.clearAll();
      Chat.addMessage("Memory cleared. I'm starting fresh.", "bot");
      Speech.speak("Done. Clean slate.");
    }
  }

  return { toggleMenu, export: exportFn, importPrompt, import: importFn, clearConfirm };
})();