// core/runtime.js — Flow's actual current state, not a static description
//
// THE PROBLEM THIS FIXES: Flow's system prompt has always described what
// Flow CAN do (a fixed list in identity.js), but never what Flow IS
// ACTUALLY DOING right now. So when the camera's been on for ten
// messages, Flow has no way to know that unless it's told fresh every
// single time — which nothing did. Same for Telegram: Flow knew it COULD
// theoretically be an admin somewhere, but had no actual record of WHICH
// chats it really has admin rights in, so every claim was a guess dressed
// up as knowledge.
//
// This is a tiny, dependency-free key-value store any module can read or
// write without importing each other directly (ui/gesture.js reporting
// its own camera state into here, rather than core/ai.js reaching
// directly into a ui/ module — keeps the dependency direction clean).

const _state = {
  cameraOn: false,
  screenShareOn: false,
  gestureActive: false,
  sentinelOn: false,
  telegramAdminChats: [],  // [{ id, title }] — chats/channels Flow has confirmed admin rights in
  knownContacts: {},        // { username: { platform, lastSeen, chatId } } — everyone Flow has ever talked with
};

export function setRuntimeState(key, value) {
  _state[key] = value;
}

export function getRuntimeState(key) {
  return _state[key];
}

// Human-readable block for the system prompt — this is what actually
// replaces guessing with genuine, current, checkable facts.
export function runtimeStateBlock() {
  const lines = [];

  lines.push(`Camera/vision: ${_state.cameraOn ? "ON — Flow can currently see through the camera right now" : "OFF — Flow cannot see anything right now"}`);
  lines.push(`Screen share: ${_state.screenShareOn ? "ON — Flow can currently see Joel's screen right now" : "OFF"}`);
  lines.push(`Gesture control: ${_state.gestureActive ? "ACTIVE — Flow is currently reading hand gestures" : "not active"}`);
  lines.push(`Sentinel (ambient screen awareness): ${_state.sentinelOn ? "ON" : "OFF"}`);

  if (_state.telegramAdminChats.length) {
    lines.push(`Telegram admin rights confirmed in: ${_state.telegramAdminChats.map(c => c.title || c.id).join(", ")}`);
  } else {
    lines.push(`Telegram admin rights: none confirmed yet — do not claim to be an admin anywhere unless this list is non-empty`);
  }

  const contactCount = Object.keys(_state.knownContacts).length;
  lines.push(`Known contacts Flow has messaged with: ${contactCount} people${contactCount ? " (ask Joel for a name/username if he wants to message someone specific by name)" : ""}`);

  return lines.join("\n");
}

// ── Contacts — remembers everyone Flow has ever had a conversation with,
// so Joel can later say "message [username]" and Flow actually knows who
// that is instead of guessing or asking every time. ──────────────────────
export function recordContact(username, platform, chatId) {
  if (!username) return;
  _state.knownContacts[username.toLowerCase()] = {
    platform, chatId,
    lastSeen: Date.now(),
  };
}

export function findContact(username) {
  if (!username) return null;
  return _state.knownContacts[username.toLowerCase().replace(/^@/, "")] || null;
}

export function allContacts() {
  return { ..._state.knownContacts };
}
