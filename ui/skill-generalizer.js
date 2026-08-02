// ═══════════════════════════════════════════
// ui/skill-generalizer.js — REAL, NEW: turns a raw recording (from
// flow-electron/skill-recorder.js) into a named, structured skill
// os-control.js can replay.
//
// Reuses the existing /api/vision endpoint (already vision-capable,
// already has real provider fallback) rather than building a whole new
// endpoint — the generalization task ("describe these recorded clicks/
// keys as semantic steps") is well within what a vision-capable model
// already handles, just with a different, structured-output prompt.
// ═══════════════════════════════════════════

function _summarizeEvents(events) {
  const clicks = events.filter(e => e.type === "click");
  const keys = events.filter(e => e.type === "keydown");
  const lines = [];
  events.forEach(e => {
    if (e.type === "click") lines.push(`[${e.t}ms] Clicked at (${e.x}, ${e.y})`);
    if (e.type === "keydown") lines.push(`[${e.t}ms] Pressed key code ${e.keycode}`);
  });
  return lines.join("\n");
}

export async function generalizeRecording(recording, skillName) {
  const afterShot = recording.events.find(e => e.type === "screenshot" && e.label === "after");
  const beforeShot = recording.events.find(e => e.type === "screenshot" && e.label === "before");
  const eventSummary = _summarizeEvents(recording.events.filter(e => e.type !== "screenshot"));

  if (!afterShot) {
    throw new Error("No screenshot captured for this recording — can't generalize without seeing the screen state.");
  }

  const prompt = `A user recorded these raw screen actions while performing a task called "${skillName}":

${eventSummary}

Looking at the screenshot (the screen state after the actions), describe this as a JSON list of semantic steps a computer-automation script could follow. Respond with ONLY valid JSON, no markdown fences, no other text, in exactly this shape:
{"steps": [{"type": "click", "x": <number>, "y": <number>, "description": "<what this click does, e.g. 'Click the Send button'>"}, {"type": "type", "text": "<text that was typed, if any>", "description": "<what this does>"}]}

Only include click/type steps that correspond to genuinely meaningful actions — merge trivial repeated clicks, and describe each step in terms of WHAT it accomplishes on screen, not just raw coordinates.`;

  const res = await fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: afterShot.dataUrl, prompt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Vision request failed (${res.status})`);

  let parsed;
  try {
    const cleaned = data.description.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Model didn't return valid JSON for this skill — try recording again with clearer, more deliberate actions. Raw response: ${data.description?.slice(0, 200)}`);
  }

  if (!parsed.steps?.length) {
    throw new Error("No usable steps were identified in this recording.");
  }

  return { name: skillName, steps: parsed.steps, recordedAt: Date.now() };
}
