// ui/dock-reveal.js — NEW. Apple-taskbar-style hover reveal: buttons
// stay hidden until the cursor gets near them, then fade/scale in.
// Generic by design — pass in the real selectors for your leads,
// workflow, and content-lab buttons (whatever their actual IDs are in
// your build; I couldn't find them in the fragment I had, so this
// takes selectors as config instead of guessing wrong ones).

const REVEAL_DISTANCE = 90; // px — how close the cursor needs to get

export function initDockReveal(selectors) {
  const style = document.createElement("style");
  style.textContent = `
    .dock-hidden { opacity: 0; transform: scale(0.85); pointer-events: none; transition: opacity 0.2s ease, transform 0.2s ease; }
    .dock-visible { opacity: 1; transform: scale(1); pointer-events: auto; transition: opacity 0.2s ease, transform 0.2s ease; }
  `;
  document.head.appendChild(style);

  const els = selectors.map(sel => document.querySelector(sel)).filter(Boolean);
  els.forEach(el => el.classList.add("dock-hidden"));

  document.addEventListener("mousemove", (e) => {
    els.forEach(el => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      el.classList.toggle("dock-visible", dist < REVEAL_DISTANCE);
      el.classList.toggle("dock-hidden", dist >= REVEAL_DISTANCE);
    });
  });
}
