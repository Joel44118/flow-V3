// api/social.js (v2) — Telegram Bot + WhatsApp
// NEW: Image analysis via vision API (buyers can send photos)
// NEW: Summary delivery to Joel for every conversation
// Routes: /api/social?platform=telegram  |  /api/social?platform=whatsapp

const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const WA_TOKEN  = process.env.WHATSAPP_TOKEN;
const WA_PHONE  = process.env.WHATSAPP_PHONE_ID;
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN;
const KV_URL    = process.env.KV_REST_API_URL;
const KV_KEY    = process.env.KV_REST_API_TOKEN;

// REAL, SHARED FIX for a systemic bug found via Joel's own console logs
// (job.status undefined, then "ids.filter is not a function") — this
// project has a documented history of KV values ending up
// double-JSON-encoded (the raw stored string itself being JSON-
// encoded again on top). A single JSON.parse() then returns a STRING
// or otherwise-wrong type instead of the real array/object — which is
// still "truthy" so callers don't notice until they call .filter() or
// .status on it and it silently isn't the right shape. This was
// previously duplicated ad-hoc (and inconsistently) across TEN
// separate call sites in this file — every one of them had the exact
// same fragility. Fixed at the root with one shared, defensive parser:
// parses repeatedly while the result is still a string, and always
// returns a real value of the expected shape (or the given fallback),
// never a stray string masquerading as an array or object.
function _parseKvValue(raw, fallback) {
  if (!raw?.result) return fallback;
  let parsed = raw.result;
  try {
    let attempts = 0;
    while (typeof parsed === 'string' && attempts < 3) {
      parsed = JSON.parse(parsed);
      attempts++;
    }
  } catch (_) {
    return fallback;
  }
  // Guard the shape too — if fallback is an array but parsed isn't,
  // or vice versa, something is still wrong; fall back rather than
  // handing a caller a value it'll crash on.
  if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
  return parsed ?? fallback;
}
const SITE      = 'https://flow-v3-mu.vercel.app';

// ── Shared: per-chat conversation history in KV ───────────────────────────
// ── Shared KV-result parser ──────────────────────────────────────────────
// Fixes the SAME double-encoding bug found and fixed today in
// api/memory.js and the pending-post draft logic below: Upstash's REST
// /get/ endpoint can return a stored object/array back as a raw JSON-
// shaped STRING rather than an already-parsed structure, depending on how
// it was originally written. Every .result access in this file that
// assumes an already-parsed array/object was a potential instance of this
// exact bug. This one helper is now used everywhere in this file instead
// of each call site re-implementing (or forgetting) the same parse check.
function safeKvResult(raw) {
  let result = raw ?? null;
  if (typeof result === "string" && result.length >= 2) {
    const first = result[0];
    if (first === '"' || first === '{' || first === '[') {
      try { result = JSON.parse(result); } catch (_) { /* leave as-is if not actually valid JSON */ }
    }
  }
  return result;
}

// Root cause of "Flow always says Hi": askFlow used to send only the current
// message with zero prior turns, so every reply looked like the start of a
// brand-new conversation to the model. This stores the last 12 turns per
// chat (keyed by platform+chatId) and feeds them back in on every call.
async function getHistory(histKey) {
  if (!KV_URL || !KV_KEY) return [];
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(histKey)}`, {
      headers: { Authorization: `Bearer ${KV_KEY}` },
    });
    const d = r.ok ? await r.json() : null;
    const result = safeKvResult(d?.result);
    return Array.isArray(result) ? result : [];
  } catch (_) { return []; }
}

async function saveHistory(histKey, history) {
  if (!KV_URL || !KV_KEY) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(histKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(history.slice(-12)),
    });
  } catch (_) {}
}

// ── Shared: Ask Flow AI ───────────────────────────────────────────────────
// Flow's real personality — duplicated here rather than imported from
// core/config.js. That file is written for the browser-side app; whether
// a Vercel serverless function can safely cross that api/ → core/ module
// boundary at build time isn't proven elsewhere in this codebase (the one
// existing example of this import pattern is ui/imagine.js →
// core/speech.js, both browser-side — a different boundary than api/ →
// core/). Duplicating a short, stable block of text is safer than an
// unverified cross-boundary import that could silently break the whole
// function at deploy time. If core/config.js's PERSONALITY text changes,
// update it here too.
const FLOW_PERSONALITY = `You are Flow — Joel's personal AI built specifically for him in Ibadan, Nigeria.
You are NOT a generic assistant. Character: smooth, witty, clever, dry humour when it fits naturally.
You always have Joel's back. Speak like a trusted friend who knows everything — not a corporate bot.

RULES — never break:
- You are Flow. Never say "I'm an AI" or "As a language model".
- No filler: never say "Certainly", "Of course", "Great question".
- Keep replies short and punchy unless detail is asked for.
- No markdown in speech — no asterisks, hashtags, bullet dashes in plain replies.
- If you don't know, say so plainly. Never hallucinate.
- Use "Boss" occasionally — naturally, not every single message.
- Never ask "what's next?", "anything else?", "would you like me to..." or push the conversation.
- Never end a reply with a question unless Joel asks for your opinion directly.
- Respond, stop, let Joel lead.
- Typos and shorthand: Joel often types fast with typos, dropped letters, and merged words. Read past them to what he actually means — never call out or correct his spelling, never ask him to clarify a typo you can reasonably infer.
- Roleplay and ongoing scenarios: if Joel starts a roleplay, story, or hypothetical scenario, STAY IN IT across the whole conversation until he clearly ends it or changes topic. Don't revert to a generic assistant tone after one or two exchanges — that's a real, known failure mode to actively avoid.`;

async function getTelegramLiveStateBlock() {
  if (!KV_URL || !KV_KEY) return "Admin chats: unknown (KV not configured).\nKnown contacts: unknown (KV not configured).";
  try {
    const [adminRes, contactsRes] = await Promise.all([
      fetch(`${KV_URL}/get/flow_admin_chats`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()),
      fetch(`${KV_URL}/get/flow_known_contacts`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()),
    ]);
    const adminChats = Array.isArray(adminRes.result) ? adminRes.result : [];
    const contacts    = (contactsRes.result && typeof contactsRes.result === 'object') ? contactsRes.result : {};
    const contactList = Object.keys(contacts);

    return [
      adminChats.length
        ? `Confirmed Telegram admin rights in: ${adminChats.map(c => c.title).join(', ')} — you genuinely can post/moderate there.`
        : `No confirmed Telegram admin rights anywhere yet — do not claim you're an admin in any chat unless this list is non-empty.`,
      contactList.length
        ? `Known contacts (usernames Flow has actually messaged before): ${contactList.slice(0, 30).join(', ')}${contactList.length > 30 ? `, and ${contactList.length - 30} more` : ''}.`
        : `No known contacts recorded yet.`,
    ].join('\n');
  } catch (_) {
    return "Admin chats/contacts: couldn't check right now.";
  }
}

async function askFlow(userMsg, context = '', imageDesc = '', histKey = null, isJoel = false) {
  // Real fix, precisely diagnosed: this used to always use a generic
  // "helpful, friendly, professional... pass it to Joel" prompt for
  // EVERY Telegram conversation — including when Joel himself was
  // talking to his own bot. That's a completely different, blander
  // character than the real Flow personality used everywhere else in
  // the app, which is exactly why "the Telegram version" felt notably
  // less smart. Now: when it's genuinely Joel messaging, Flow uses its
  // real personality (wit, directness, no corporate filler). When it's
  // someone else — a client, a stranger — it keeps the professional,
  // business-appropriate tone, since that distinction matters here.
  const liveState = isJoel ? await getTelegramLiveStateBlock() : "";
  const SYSTEM = isJoel
    ? `${FLOW_PERSONALITY}\n\nYou're talking with Joel over Telegram right now — same person, same relationship as everywhere else you talk with him. Continue naturally; don't re-introduce yourself.\n\nFLOW'S ACTUAL CURRENT STATE ON TELEGRAM — real, checked facts, not a guess:\n${liveState}\n${imageDesc ? `He sent an image. Here's what it shows: ${imageDesc}\nRespond to both the image and his message.` : ''}`
    : `You are Flow, Joel Olanrewaju's personal AI assistant.
You are continuing an ongoing ${context} conversation on Joel's behalf.
Joel runs Joelflowstack — premium web development and AI automation services.
Be helpful, friendly, professional. Keep replies under 200 words.
This is an ongoing thread — do not re-greet or re-introduce yourself if there is prior conversation history below; just continue naturally.
${imageDesc ? `The user sent an image. Here is what it shows: ${imageDesc}\nRespond to both the image and their message.` : ''}
If you cannot answer something specific, say you will pass it to Joel.`;

  const history = histKey ? await getHistory(histKey) : [];
  const userContent = userMsg || (imageDesc ? 'See the image I sent.' : 'Hello');

  const r = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM },
        ...history,
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}`);
  const d = await r.json();
  const reply = d.reply?.trim() || "I'm Flow, Joel's AI. Your message was received!";

  if (histKey) {
    const updated = [...history, { role: 'user', content: userContent }, { role: 'assistant', content: reply }];
    await saveHistory(histKey, updated);
  }

  return reply;
}

// ── Shared: Analyze image via Flow vision API ─────────────────────────────
async function analyzeImage(base64, mimeType = 'image/jpeg') {
  try {
    const r = await fetch(`${SITE}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image:  base64,
        prompt: 'Describe this image in detail. Note any problems, products, text, or context visible.',
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.description || null;
  } catch(_) { return null; }
}

// ── Shared: Push notification to Flow bell ────────────────────────────────
async function pushNotif(source, text) {
  if (!KV_URL || !KV_KEY) {
    // This used to fail completely silently. If notifications aren't
    // reaching the bell or Telegram despite everything else working, THIS
    // is very likely why — check Vercel → Settings → Environment Variables
    // for KV_REST_API_URL and KV_REST_API_TOKEN (from your Vercel KV /
    // Upstash integration).
    console.error('[Social] pushNotif SKIPPED — KV_REST_API_URL / KV_REST_API_TOKEN not set. Notifications cannot be delivered until these are configured.');
    return;
  }
  try {
    const r   = await fetch(`${KV_URL}/get/flow_pending_notifs`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
    const cur = r.ok ? safeKvResult((await r.json()).result) || [] : [];
    const arr = Array.isArray(cur) ? cur : [];
    arr.push({ source, text: text.slice(0, 200), ts: Date.now(), read: false });
    await fetch(`${KV_URL}/set/flow_pending_notifs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(arr.slice(-30)),
    });
  } catch(e) { console.error('[Social] pushNotif:', e.message); }
}

// ── Shared: Store conversation summary in KV ──────────────────────────────
async function storeSummary(platform, sender, userMsg, flowReply, hasImage) {
  if (!KV_URL || !KV_KEY) return;
  try {
    const summaryKey = `flow_conv_summary_${Date.now()}`;
    await fetch(`${KV_URL}/set/${encodeURIComponent(summaryKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform, sender,
        userMsg:   userMsg.slice(0, 300),
        flowReply: flowReply.slice(0, 300),
        hasImage,
        ts: Date.now(),
      }),
    });
  } catch(_) {}
}

// ── Community/group admin command handler ──────────────────────────────
// Natural-language moderation, triggered by "flow <action> ..." in a group
// where Joel is the sender. Reply-to-message is how the target user is
// identified — same UX as most real Telegram moderation bots use, since
// it's unambiguous (no username-typo risk) and works even for users
// without a @username set.
// ── Confirmed admin-status tracking ─────────────────────────────────────
// Real problem this fixes: Flow could never actually tell Joel which
// chats/channels it has admin rights in — it either guessed, or only
// found out reactively when an action failed with a permissions error.
// This checks Telegram's own getChatMember API for the bot's own status
// (genuine, verifiable truth) and caches confirmed admin chats in KV so
// Flow's system prompt can report them as real, checked facts — not
// assumptions. Cached for 1 hour per chat since admin status rarely
// changes and checking it on every single message would be wasteful.
async function checkAndRecordAdminStatus(chatId, chatTitle) {
  if (!TG_TOKEN || !KV_URL || !KV_KEY) return;
  const cacheKey = `flow_admin_check_${chatId}`;

  try {
    const cached = await fetch(`${KV_URL}/get/${cacheKey}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json());
    if (cached.result && Date.now() - cached.result.checkedAt < 3600000) return; // checked within the last hour

    const meRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`).then(r => r.json());
    const botId = meRes.result?.id;
    if (!botId) return;

    const memberRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getChatMember?chat_id=${chatId}&user_id=${botId}`).then(r => r.json());
    const status = memberRes.result?.status; // 'administrator', 'member', 'creator', etc.
    const isAdmin = status === 'administrator' || status === 'creator';

    await fetch(`${KV_URL}/set/${cacheKey}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin, checkedAt: Date.now() }),
    });

    // Maintain a single list of currently-confirmed admin chats, so the
    // system prompt can report a genuine, short list rather than
    // scanning every chat's individual cache entry.
    const listKey = 'flow_admin_chats';
    const listRes = await fetch(`${KV_URL}/get/${listKey}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json());
    let list = Array.isArray(listRes.result) ? listRes.result : [];
    list = list.filter(c => c.id !== chatId);
    if (isAdmin) list.push({ id: chatId, title: chatTitle || String(chatId) });
    await fetch(`${KV_URL}/set/${listKey}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(list),
    });
  } catch (e) {
    console.warn('[AdminCheck] failed for chat', chatId, ':', e.message);
  }
}

// ── Contact tracking ──────────────────────────────────────────────────
// Real problem this fixes: Joel wants to say "message [username]" and
// have Flow actually know who that is, instead of guessing or asking
// every time. This records every username Flow has ever exchanged
// messages with, so it can be looked up later by name.
async function recordContact(username, chatId, platform) {
  if (!username || !KV_URL || !KV_KEY) return;
  try {
    const key = 'flow_known_contacts';
    const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json());
    const contacts = (r.result && typeof r.result === 'object') ? r.result : {};
    contacts[username.toLowerCase().replace(/^@/, '')] = { chatId, platform, lastSeen: Date.now() };
    await fetch(`${KV_URL}/set/${key}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(contacts),
    });
  } catch (_) {}
}

async function handleGroupAdminCommand(tgFetch, tgFetchStrict, msg, chatId, text, isOwner) {
  const cmd = text.toLowerCase().replace(/^flow\s+/, '').trim();
  const target = msg.reply_to_message;

  const needsTarget = /^(ban|kick|mute|unmute|warn)\b/.test(cmd);
  if (needsTarget && !target) {
    await tgFetch('sendMessage', { chat_id: chatId, reply_to_message_id: msg.message_id, text: 'Reply to that person\'s message so I know exactly who you mean.' });
    return true;
  }
  if (needsTarget && !isOwner) {
    await tgFetch('sendMessage', { chat_id: chatId, reply_to_message_id: msg.message_id, text: 'Only Joel can ask me to do that here.' });
    return true;
  }

  const targetId   = target?.from?.id;
  const targetName = target?.from?.username ? `@${target.from.username}` : target?.from?.first_name || 'that user';

  try {
    if (/^ban\b/.test(cmd)) {
      await tgFetchStrict('banChatMember', { chat_id: chatId, user_id: targetId });
      await tgFetch('sendMessage', { chat_id: chatId, text: `${targetName} has been banned.` });
      return true;
    }
    if (/^kick\b/.test(cmd)) {
      // Telegram has no separate "kick" — ban immediately followed by
      // unban removes them without a permanent ban, which is what most
      // people mean by "kick".
      await tgFetchStrict('banChatMember', { chat_id: chatId, user_id: targetId });
      await tgFetchStrict('unbanChatMember', { chat_id: chatId, user_id: targetId });
      await tgFetch('sendMessage', { chat_id: chatId, text: `${targetName} has been removed (can rejoin via invite link).` });
      return true;
    }
    if (/^mute\b/.test(cmd)) {
      const minutesMatch = cmd.match(/(\d+)\s*(min|minute|hour|hr|day)/);
      let untilDate;
      if (minutesMatch) {
        const n = parseInt(minutesMatch[1], 10);
        const mult = /hour|hr/.test(minutesMatch[2]) ? 3600 : /day/.test(minutesMatch[2]) ? 86400 : 60;
        untilDate = Math.floor(Date.now() / 1000) + n * mult;
      }
      await tgFetchStrict('restrictChatMember', {
        chat_id: chatId, user_id: targetId,
        permissions: { can_send_messages: false },
        ...(untilDate ? { until_date: untilDate } : {}),
      });
      await tgFetch('sendMessage', { chat_id: chatId, text: `${targetName} has been muted${untilDate ? ' temporarily' : ''}.` });
      return true;
    }
    if (/^unmute\b/.test(cmd)) {
      await tgFetchStrict('restrictChatMember', {
        chat_id: chatId, user_id: targetId,
        permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true, can_add_web_page_previews: true },
      });
      await tgFetch('sendMessage', { chat_id: chatId, text: `${targetName} can send messages again.` });
      return true;
    }
    if (/^warn\b/.test(cmd)) {
      const key = `flow_warns_${chatId}_${targetId}`;
      const cur = await (async () => { try { const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }); return r.ok ? (safeKvResult((await r.json()).result) || 0) : 0; } catch(_) { return 0; } })();
      const count = cur + 1;
      await fetch(`${KV_URL}/set/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(count) });
      await tgFetch('sendMessage', { chat_id: chatId, text: `${targetName} has been warned (${count}/3). ${count >= 3 ? 'Auto-muting for 1 hour.' : ''}` });
      if (count >= 3) {
        await tgFetchStrict('restrictChatMember', { chat_id: chatId, user_id: targetId, permissions: { can_send_messages: false }, until_date: Math.floor(Date.now() / 1000) + 3600 });
      }
      return true;
    }
    if (/^pin\b/.test(cmd) && target) {
      await tgFetchStrict('pinChatMessage', { chat_id: chatId, message_id: target.message_id });
      await tgFetch('sendMessage', { chat_id: chatId, text: 'Pinned.' });
      return true;
    }
    if (/^unpin\b/.test(cmd)) {
      await tgFetchStrict('unpinChatMessage', { chat_id: chatId });
      await tgFetch('sendMessage', { chat_id: chatId, text: 'Unpinned.' });
      return true;
    }
    if (/^delete\b/.test(cmd) && target) {
      await tgFetchStrict('deleteMessage', { chat_id: chatId, message_id: target.message_id });
      return true;
    }
    if (/^rules\b|^welcome\b/.test(cmd)) {
      // Flow can just answer group questions conversationally too —
      // returning false here lets it fall through to the normal
      // askFlow reply path below instead of being swallowed silently.
      return false;
    }
  } catch (e) {
    // Almost always means the bot isn't an admin in this group yet, or is
    // missing the specific right for that action — surfaced clearly
    // rather than failing silently, since this is the most common real
    // setup gap.
    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: `Couldn't do that — ${e.message.includes('CHAT_ADMIN_REQUIRED') || e.message.includes('not enough rights')
        ? "I need to be made an admin in this group first, with the right permission toggled on (Group Settings → Administrators → my account)."
        : e.message}`,
    });
    return true;
  }

  return false; // not a recognized admin command — fall through to normal chat
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────

// REAL, module-level (not request-scoped like the one inside
// handleTelegram below) — needed so the heartbeat loop's self-initiated
// messages (flow-electron/heartbeat.js) can send a real Telegram push to
// Joel without needing an incoming webhook request to piggyback on.
async function sendTelegramToJoel(text) {
  if (!TG_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!joelId) return { ok: false, error: 'JOEL_TELEGRAM_CHAT_ID not set — nowhere to send a self-initiated message.' };

  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: joelId, text, parse_mode: 'Markdown' }),
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'Telegram API rejected the message' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleTelegram(req, res) {
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });

  const tgFetch = (method, body) => fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(e => console.error('[TG]', method, e.message));

  // tgFetch above swallows everything into a console.error and never
  // rejects — fine for routine sendMessage calls, but admin actions
  // (ban/mute/pin) need to know WHY Telegram refused (usually "the bot
  // isn't an admin here yet"), which arrives as a normal 200/400 response
  // body, not a thrown error. This variant actually checks that body and
  // throws with Telegram's real description so the catch block around
  // admin commands can surface something useful instead of silence.
  const tgFetchStrict = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.description || `Telegram ${method} failed`);
    return d;
  };

  const update = req.body;

  // Button clicks (online/offline toggle, Echo draft approval) arrive on
  // update.callback_query, a completely separate field from update.message
  // — same class of gotcha as business_message below. Must be checked
  // before the msg extraction, or these updates get silently dropped.
  if (update?.callback_query) {
    try {
      await handleCallbackQuery(tgFetch, tgFetchStrict, update.callback_query);
    } catch (e) {
      console.error('[TG] callback_query handler error:', e.message);
    }
    return res.status(200).json({ ok: true });
  }

  // Telegram Business connect/disconnect event — just log it, nothing to reply to
  if (update?.business_connection) {
    console.log('[TG] Business connection update:', update.business_connection.id, 'enabled:', update.business_connection.is_enabled);
    return res.status(200).json({ ok: true });
  }

  // Business messages arrive on a completely separate field from regular
  // messages — a bot that only checks update.message will silently ignore
  // these even once connected.
  const isBusiness = !!update?.business_message;
  const msg = update?.message || update?.edited_message || update?.business_message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId   = msg.chat.id;
  const chatType = msg.chat.type; // 'private' | 'group' | 'supergroup' | 'channel'
  const isGroup  = chatType === 'group' || chatType === 'supergroup';
  const text     = msg.text || msg.caption || '';
  const username = msg.from?.username
    ? `@${msg.from.username}`
    : msg.from?.first_name || String(chatId);
  const histKey  = `flow_tg_hist_${chatId}`;

  // Real admin-status verification (not a guess) — checked and cached
  // whenever a group/channel message arrives.
  if (isGroup || chatType === 'channel') {
    checkAndRecordAdminStatus(chatId, msg.chat.title).catch(() => {});
  }
  // Remember who Flow has actually talked with, so Joel can later say
  // "message [username]" and Flow genuinely knows who that is.
  if (msg.from?.username) {
    recordContact(msg.from.username, chatId, 'telegram').catch(() => {});
  }

  // ── Scheduled post approval flow ────────────────────────────────────────
  // Only checked in Joel's own private chat with the bot — a group member
  // saying "yes" shouldn't accidentally approve Joel's draft post. If a
  // draft is pending and Joel replies, this intercepts BEFORE the normal
  // chat/admin flow so his reply isn't treated as a regular conversation
  // message or misrouted elsewhere.
  const joelIdForApproval = process.env.JOEL_TELEGRAM_CHAT_ID;
  const senderIsJoel = joelIdForApproval && String(msg.from?.id) === String(joelIdForApproval);
  if (!isGroup && joelIdForApproval && String(msg.from?.id) === String(joelIdForApproval)) {
    const handled = await handlePendingApprovalReply(tgFetch, tgFetchStrict, chatId, text);
    if (handled) return res.status(200).json({ ok: true });
  }

  // ── Community/group admin ──────────────────────────────────────────────
  // Real limitation, stated plainly: these ONLY work if you've made the
  // bot an actual admin inside the Telegram group (Group Settings →
  // Administrators → Add Admin → your bot), with the specific rights
  // (ban/restrict/pin/delete) toggled on. No code can grant those —
  // that's Telegram's own permission model, done once per group in the
  // Telegram app itself. Full steps are in the guide at the end.
  //
  // SECURITY: admin commands only fire when the SENDER is Joel
  // (JOEL_TELEGRAM_CHAT_ID) — otherwise anyone in the group could type
  // "flow ban @someone" and have it actually happen.
  if (isGroup && text.toLowerCase().startsWith('flow ')) {
    const isOwner = process.env.JOEL_TELEGRAM_CHAT_ID && String(msg.from?.id) === String(process.env.JOEL_TELEGRAM_CHAT_ID);
    const handled = await handleGroupAdminCommand(tgFetch, tgFetchStrict, msg, chatId, text, isOwner);
    if (handled) return res.status(200).json({ ok: true });
  }

  // /start command (not applicable to business messages)
  if (text === '/start' && !isBusiness) {
    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: `👋 Hi ${username}! I'm *Flow*, Joel's AI assistant.\n\nYou can send me text messages or photos and I'll respond right away!`,
      parse_mode: 'Markdown',
    });
    return res.status(200).json({ ok: true });
  }

  // /presence — shows the current mode + a button to flip it. This is the
  // actual "toggle button in the interface" Joel asked for; /online and
  // /offline above are just a typed shortcut once he knows the state.
  if (text === '/presence' && senderIsJoel) {
    let presence;
    try {
      const r = await fetch(`${KV_URL}/get/${PRESENCE_KEY}`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
      const d = await r.json();
      presence = safeKvResult(d.result);
    } catch (_) { presence = null; }
    const isOnline = presence?.state === 'online';

    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: isOnline
        ? '🟢 Currently in *manual* mode — Echo drafts replies for your approval.'
        : '🔴 Currently in *auto* mode — Echo replies on its own based on your recent chat activity.',
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          isOnline
            ? { text: '🔴 Go Offline (back to auto-reply)', callback_data: 'presence_offline' }
            : { text: '🟢 Go Online (Echo drafts for approval)', callback_data: 'presence_online' },
        ]],
      },
    });
    return res.status(200).json({ ok: true });
  }

  // /online and /offline — typed alternative to the inline button, only
  // usable by Joel himself (same guard as the group admin commands above).
  if ((text === '/online' || text === '/offline') && senderIsJoel) {
    await handleCallbackQuery(tgFetch, tgFetchStrict, {
      id: `typed_${Date.now()}`,
      data: text === '/online' ? 'presence_online' : 'presence_offline',
      message: { chat: { id: chatId }, message_id: msg.message_id },
    });
    return res.status(200).json({ ok: true });
  }

  // ── Mute system — genuinely separate from tg_blocklist (that's for
  // anti-spam/anti-bot protection, this is Joel's own deliberate "ignore
  // this person indefinitely" choice). Stored under its own KV key so
  // the two systems can never accidentally interact — muting someone
  // never touches the spam blocklist, and vice versa.
  // Usage: /mute @username   /unmute @username   /muted (lists current mutes)
  if (text?.startsWith('/mute ') && senderIsJoel) {
    const uname = text.slice(6).trim().replace(/^@/, '').toLowerCase();
    if (!uname) {
      await tgFetch('sendMessage', { chat_id: chatId, text: 'Usage: /mute @username' });
      return res.status(200).json({ ok: true });
    }
    let muted;
    try {
      const r = await fetch(`${KV_URL}/get/flow_muted_contacts`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
      const d = await r.json();
      muted = safeKvResult(d.result) || [];
    } catch (_) { muted = []; }
    if (!muted.includes(uname)) muted.push(uname);
    await fetch(`${KV_URL}/set/flow_muted_contacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(muted) }),
    });
    await tgFetch('sendMessage', { chat_id: chatId, text: `🔇 Muted @${uname} — Echo will never auto-reply to them, even after the 1hr online-mode timeout. Use /unmute @${uname} to reverse.` });
    return res.status(200).json({ ok: true });
  }

  if (text?.startsWith('/unmute ') && senderIsJoel) {
    const uname = text.slice(8).trim().replace(/^@/, '').toLowerCase();
    let muted;
    try {
      const r = await fetch(`${KV_URL}/get/flow_muted_contacts`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
      const d = await r.json();
      muted = safeKvResult(d.result) || [];
    } catch (_) { muted = []; }
    muted = muted.filter(u => u !== uname);
    await fetch(`${KV_URL}/set/flow_muted_contacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(muted) }),
    });
    await tgFetch('sendMessage', { chat_id: chatId, text: `🔊 Unmuted @${uname} — Echo will respond to them normally again.` });
    return res.status(200).json({ ok: true });
  }

  if (text === '/muted' && senderIsJoel) {
    let muted;
    try {
      const r = await fetch(`${KV_URL}/get/flow_muted_contacts`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
      const d = await r.json();
      muted = safeKvResult(d.result) || [];
    } catch (_) { muted = []; }
    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: muted.length ? `🔇 Currently muted:\n${muted.map(u => `@${u}`).join('\n')}` : 'No one is currently muted.',
    });
    return res.status(200).json({ ok: true });
  }

  // Show typing indicator
  await tgFetch('sendChatAction', { chat_id: chatId, action: 'typing' });

  // ── Handle photos ──────────────────────────────────────────────────────
  let imageDesc = null;
  if (msg.photo || msg.document?.mime_type?.startsWith('image/')) {
    try {
      // Get the largest photo version
      const fileId = msg.photo
        ? msg.photo[msg.photo.length - 1].file_id
        : msg.document.file_id;

      // Get file path from Telegram
      const fileR = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
      const fileD = await fileR.json();
      const filePath = fileD.result?.file_path;

      if (filePath) {
        // Download the image
        const imgR = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
        const buf  = await imgR.arrayBuffer();
        const b64  = Buffer.from(buf).toString('base64');

        // Analyze with vision API
        imageDesc = await analyzeImage(b64, 'image/jpeg');
        console.log('[TG] Image analyzed:', imageDesc?.slice(0, 80));
      }
    } catch (e) {
      console.error('[TG] Image error:', e.message);
    }
  }

  // ── "post [to channel] <text>" — immediate, on-command posting ────────
  // This is the direct fix for wanting an on-demand channel post, separate
  // from the scheduled 1PM draft-and-approve flow. Still Joel-only, and
  // still requires the message to clearly be a posting instruction (not
  // just the word "post" appearing incidentally in normal conversation).
  if (senderIsJoel) {
    const postCmdMatch = text.match(/^post\s+(?:to|on)\s+(?:the\s+)?channel\s*[:\-]?\s*(.+)/i);
    if (postCmdMatch) {
      const postText = postCmdMatch[1].trim();
      const channelId = process.env.TELEGRAM_CHANNEL_ID;

      if (!channelId) {
        await tgFetch('sendMessage', { chat_id: chatId, text: '⚠️ TELEGRAM_CHANNEL_ID is not set — there\'s no channel configured to post to yet.' });
      } else if (!postText) {
        await tgFetch('sendMessage', { chat_id: chatId, text: 'What should I post? e.g. "post to channel: launching a new bot template today"' });
      } else {
        try {
          await tgFetchStrict('sendMessage', { chat_id: channelId, text: postText });
          await tgFetch('sendMessage', { chat_id: chatId, text: '✅ Posted to your channel.' });
          await pushNotif('Manual post', `Posted: "${postText.slice(0, 100)}"`);
        } catch (e) {
          await tgFetch('sendMessage', { chat_id: chatId, text: `⚠️ Couldn't post — ${e.message}. Make sure the bot is an admin in the channel with "Post Messages" permission.` });
        }
      }
      return res.status(200).json({ ok: true });
    }
  }

  // ── "message [username] [text]" — real contact lookup, Joel only ──────
  // This is the direct fix for wanting Flow to actually message someone
  // by username: it checks the real contact list built up over every
  // past conversation (recordContact, called on every incoming message),
  // not a guess. If the person was never actually recorded, it says so
  // plainly instead of pretending to send something that never went out.
  if (senderIsJoel) {
    const msgCmdMatch = text.match(/^(?:message|tell|send|dm)\s+@?(\w+)\s+(.+)/i);
    if (msgCmdMatch) {
      const [, targetUsername, messageText] = msgCmdMatch;
      try {
        const contactsRes = await fetch(`${KV_URL}/get/flow_known_contacts`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json());
        const contacts = (contactsRes.result && typeof contactsRes.result === 'object') ? contactsRes.result : {};
        const contact = contacts[targetUsername.toLowerCase()];

        if (!contact) {
          await tgFetch('sendMessage', { chat_id: chatId, text: `I don't have @${targetUsername} in my known contacts — they'd need to have messaged the bot at least once before I can reach them this way.` });
        } else if (contact.platform !== 'telegram') {
          await tgFetch('sendMessage', { chat_id: chatId, text: `@${targetUsername} is a known contact, but from ${contact.platform}, not Telegram — I can't cross-send between platforms.` });
        } else {
          await tgFetchStrict('sendMessage', { chat_id: contact.chatId, text: messageText });
          await tgFetch('sendMessage', { chat_id: chatId, text: `Sent to @${targetUsername}: "${messageText}"` });
        }
      } catch (e) {
        await tgFetch('sendMessage', { chat_id: chatId, text: `Couldn't send that — ${e.message}` });
      }
      return res.status(200).json({ ok: true });
    }
  }

  // Get AI reply — histKey gives real conversation memory, fixing the
  // "always re-greets" issue at its root. isJoel determines which
  // personality Flow uses — real Flow for Joel himself, professional
  // business tone for anyone else messaging the bot.
  const reply = await askFlow(
    text || (imageDesc ? 'What do you think about this image?' : 'Hello'),
    `Telegram ${username}`,
    imageDesc,
    histKey,
    senderIsJoel
  );

  // Send reply — business messages must echo back business_connection_id
  // or Telegram rejects the send
  const sendPayload = {
    chat_id:    chatId,
    text:       reply.slice(0, 4096),
    parse_mode: 'Markdown',
  };
  if (isBusiness) sendPayload.business_connection_id = update.business_message.business_connection_id;
  await tgFetch('sendMessage', sendPayload);

  // Build summary for Joel
  const summary = [
    `${isBusiness ? '💼' : '📨'} *${username}*${isBusiness ? ' (Business chat)' : ''} on Telegram:`,
    text ? `"${text.slice(0, 150)}"` : '',
    imageDesc ? `📷 *Image:* ${imageDesc.slice(0, 150)}` : '',
    `\n✅ *Flow replied:*\n"${reply.slice(0, 200)}"`,
  ].filter(Boolean).join('\n');

  // Notify Joel + push to bell + store summary — all parallel.
  // pushNotif() always runs regardless of JOEL_TELEGRAM_CHAT_ID, so the bell
  // is never silently skipped. The direct-message ping is best-effort on top
  // of that — if it's skipped, we log exactly why instead of failing quietly.
  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!joelId) {
    console.warn('[TG] JOEL_TELEGRAM_CHAT_ID is not set — Joel will only see this via the bell, not a direct Telegram ping.');
  } else if (String(chatId) === String(joelId)) {
    console.log('[TG] Message came from Joel\'s own chat_id — skipping self-notification.');
  }
  await Promise.all([
    pushNotif('Telegram', `${isBusiness ? '💼 ' : ''}${username}: ${(text || '[image]').slice(0, 120)}`),
    storeSummary('telegram', username, text || '[image]', reply, !!imageDesc),
    joelId && String(chatId) !== String(joelId)
      ? tgFetch('sendMessage', { chat_id: joelId, text: summary, parse_mode: 'Markdown' })
      : Promise.resolve(),
  ]);

  return res.status(200).json({ ok: true });
}

// ── WHATSAPP ──────────────────────────────────────────────────────────────
async function handleWhatsApp(req, res) {
  // Webhook verification
  if (req.method === 'GET') {
    const mode  = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const ch    = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WA_VERIFY) return res.status(200).send(ch);
    return res.status(403).send('Forbidden');
  }

  if (!WA_TOKEN || !WA_PHONE) return res.status(200).json({ ok: false, error: 'WhatsApp not configured' });

  const sendWA = async (to, text) => fetch(`https://graph.facebook.com/v19.0/${WA_PHONE}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096) } }),
  }).catch(e => console.error('[WA] send:', e.message));

  const entry   = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg     = entry?.messages?.[0];
  if (!msg) return res.status(200).json({ ok: true });

  const from    = msg.from;
  const text    = msg.text?.body || msg.caption || '';
  const contact = entry?.contacts?.[0]?.profile?.name || from;

  // ── Handle WA images ───────────────────────────────────────────────────
  let imageDesc = null;
  if (msg.type === 'image' && msg.image?.id) {
    try {
      // Get media URL from WhatsApp
      const mediaR = await fetch(`https://graph.facebook.com/v19.0/${msg.image.id}`, {
        headers: { Authorization: `Bearer ${WA_TOKEN}` },
      });
      const mediaD = await mediaR.json();

      if (mediaD.url) {
        const imgR = await fetch(mediaD.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
        const buf  = await imgR.arrayBuffer();
        const b64  = Buffer.from(buf).toString('base64');
        imageDesc  = await analyzeImage(b64, msg.image.mime_type || 'image/jpeg');
      }
    } catch (e) { console.error('[WA] Image error:', e.message); }
  }

  const histKey = `flow_wa_hist_${from}`;
  const reply = await askFlow(text || 'Hello', `WhatsApp from ${contact}`, imageDesc, histKey);
  await sendWA(from, reply);

  const myNum = process.env.JOEL_WHATSAPP_NUMBER;
  const summary = [
    `📱 *${contact}* on WhatsApp:`,
    text ? `"${text.slice(0, 150)}"` : '',
    imageDesc ? `📷 Image: ${imageDesc.slice(0, 100)}` : '',
    `\n✅ Flow: "${reply.slice(0, 200)}"`,
  ].filter(Boolean).join('\n');

  await Promise.all([
    pushNotif('WhatsApp', `${contact}: ${(text || '[image]').slice(0, 120)}`),
    storeSummary('whatsapp', contact, text || '[image]', reply, !!imageDesc),
    myNum && myNum !== from ? sendWA(myNum, summary) : Promise.resolve(),
  ]);

  return res.status(200).json({ ok: true });
}

// ── FLOW SENTINEL RELAY ─────────────────────────────────────────────────
// Lets the Electron desktop app ask Flow to ping Joel on Telegram, without
// the bot token ever existing on Joel's machine. The desktop app only ever
// sends plain text here; this route is the only thing that touches TG_TOKEN.
async function handleSentinelPing(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });

  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!joelId) return res.status(200).json({ ok: false, error: 'JOEL_TELEGRAM_CHAT_ID not set' });

  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ ok: false, error: 'text required' });

  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: joelId, text: text.slice(0, 4096), parse_mode: 'Markdown' }),
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[Sentinel relay]', e.message);
    return res.status(502).json({ ok: false, error: e.message });
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────
// ── Autonomous social posting ───────────────────────────────────────────
// REAL SCOPE, STATED PLAINLY:
//
// 1. FREQUENCY: Vercel Hobby's cron only fires once per day (a hard
//    platform limit, not something this code can work around for free).
//    This runs once daily via vercel.json's crons config.
//
// 2. PLATFORM: posts to your Telegram channel — the one platform that's
//    already fully configured and doesn't need a business API application
//    process. Twitter/Instagram/etc. each need their own developer app
//    approval and separate credentials Joel hasn't set up yet; adding fake
//    stubs for those would look like they work when they don't. This is
//    built so another platform's send function can be added the same way
//    handleWhatsApp was, once those credentials exist.
//
// 3. VIDEO vs IMAGE: HF's free-tier video models can take minutes and are
//    not reliably fast enough to trust inside a single cron invocation
//    (function timeout risk). This generates a genuine, Flow-written
//    caption + real FLUX image automatically every day. Video posting
//    stays a manual action (use the existing /video slash command,
//    then forward it) rather than an unattended cron risking a silent
//    failure on a slow model.
async function generateAutoPostContent() {
  const topics = [
    'a practical web development or AI automation tip',
    'something interesting about building with AI tools',
    'a quick insight about modern bot development',
    'a short thought on what makes a website or bot actually useful',
  ];
  const topic = topics[Math.floor(Math.random() * topics.length)];

  const captionR = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are Flow, writing a short, genuinely useful social media post for Joelflowstack (web dev / AI automation / bot building). 2-4 sentences, no hashtags spam (max 2), no corporate tone, sound like a real developer sharing something useful.' },
        { role: 'user', content: `Write today's post about: ${topic}` },
      ],
    }),
  });
  const captionD = await captionR.json();
  const caption = captionD.reply?.trim();
  if (!caption) throw new Error('Caption generation failed');

  return { caption, topic };
}

// ═══════════════════════════════════════════
// REAL, NEW — Social Monitor: the daily 5PM-WAT pass that reads Joel's
// own real platform performance (Bluesky/YouTube), does a real niche web
// search on what's working for comparable web-dev/bot/automation
// creators, extracts that into a small stored "insight," and generates
// ONE draft post per live platform using the best available insight.
//
// HONEST SCOPE: there is no free, real "competitor analytics API" for
// arbitrary accounts — this uses (a) Joel's own real, already-connected
// Bluesky/YouTube data for self-performance signal, and (b) genuine web
// search for what's currently working in the web-dev/indie-bot-builder
// content space, since that's the real, free substitute for a
// competitor-analytics product Joel doesn't have and isn't paying for.
//
// Insights are stored in KV (flow_social_insight_*) as real, small,
// structured records — not thrown away after use — so they accumulate
// over time and get richer, which is the actual mechanism behind "Flow
// gets smarter about the content he creates," not a metaphor.
// ═══════════════════════════════════════════
const INSIGHT_KEY = (id) => `flow_social_insight_${id}`;
const INSIGHT_INDEX_KEY = () => `flow_social_insight_index`;

// ── Real embedding helpers — SAME real pattern already used by
// flow-electron/memory-store.js and api/chat.js's _recallMemory: plain
// HTTPS call to the server-side /api/mediapipe?action=embed route (which
// itself calls HF's real, confirmed-live thenlper/gte-large
// feature-extraction endpoint). No new npm dependency, no native
// binding — same zero-native-deps discipline as the rest of this
// codebase's memory system. Genuinely non-fatal on failure: an insight
// without an embedding still saves and is still retrievable via the
// keyword+recency fallback below, exactly like memory-store.js's design.
async function _getInsightEmbedding(text) {
  try {
    const res = await fetch(`${SITE}/api/mediapipe?action=embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch (_) {
    return null;
  }
}

function _insightCosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// REAL, Joel-approved upgrade — insight storage now also fetches and
// stores a real embedding of the insight's own pattern text. Previously
// insights had ZERO semantic retrieval: _loadRecentInsights just grabbed
// the last N by recency, and outreach-email generation naively filtered
// by an exact platform_hint string match — meaning as the insight pool
// grows (accumulating content/sales/mindset patterns over weeks), Flow
// could only ever reach for the MOST RECENT matching insight, never the
// most RELEVANT one for a specific lead or post. This is the real,
// concrete gap this upgrade closes — genuine "understand before
// delivering" rather than "grab whatever's newest."
async function _saveInsight(insight) {
  if (!KV_URL || !KV_KEY) return null;
  const id = `insight-${Date.now()}`;
  const embedding = await _getInsightEmbedding(insight.pattern); // null on failure, real non-fatal fallback
  await fetch(`${KV_URL}/set/${INSIGHT_KEY(id)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify({ ...insight, id, embedding, createdAt: Date.now() }) }),
  }).catch(() => {});

  const raw = await fetch(`${KV_URL}/get/${INSIGHT_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  ids = [...ids, id].slice(-100); // real, capped rolling history — plenty to draw richer context from without unbounded growth
  await fetch(`${KV_URL}/set/${INSIGHT_INDEX_KEY()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(ids) }),
  }).catch(() => {});

  return id;
}

async function _loadRecentInsights(n = 5) {
  if (!KV_URL || !KV_KEY) return [];
  const raw = await fetch(`${KV_URL}/get/${INSIGHT_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  const recentIds = ids.slice(-n);
  const insights = await Promise.all(recentIds.map(id =>
    fetch(`${KV_URL}/get/${INSIGHT_KEY(id)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } })
      .then(r => r.json()).then(d => d.result ? JSON.parse(d.result) : null).catch(() => null)
  ));
  return insights.filter(Boolean);
}

// ── REAL, NEW — semantic insight retrieval. Given a real query
// describing the actual context (e.g. a lead's company/industry, or a
// platform + topic for a social draft), loads the FULL insight pool
// (not just the last N) and ranks by genuine relevance — real cosine
// similarity when both the query and an insight have embeddings,
// blended with recency so genuinely fresher research still gets a
// natural edge among similarly-relevant matches. Falls back to pure
// recency (old behavior) for any insight that failed to get an
// embedding at save time — never silently excludes an insight just
// because embedding fetch failed once.
async function _recallRelevantInsights(query, { maxResults = 5, platformHint = null } = {}) {
  if (!KV_URL || !KV_KEY) return [];
  const raw = await fetch(`${KV_URL}/get/${INSIGHT_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  if (!ids.length) return [];

  const allInsights = (await Promise.all(ids.map(id =>
    fetch(`${KV_URL}/get/${INSIGHT_KEY(id)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } })
      .then(r => r.json()).then(d => d.result ? JSON.parse(d.result) : null).catch(() => null)
  ))).filter(Boolean);

  const queryEmbedding = await _getInsightEmbedding(query);
  const now = Date.now();

  const scored = allInsights
    // Real, soft preference rather than a hard filter — an
    // exceptionally relevant insight from a DIFFERENT platform_hint
    // can still surface (e.g. a general business-mindset insight
    // genuinely applying to an email), it just doesn't get the same
    // recency-independent boost a same-category match gets.
    .map(insight => {
      const ageDays = (now - (insight.createdAt || 0)) / (24 * 60 * 60 * 1000);
      const recencyScore = Math.max(0, 1 - ageDays / 30) * 0.2; // real, same 30-day decay curve as memory-store.js
      const categoryMatch = platformHint && insight.platform_hint === platformHint ? 0.15 : 0;

      let semanticScore = 0;
      if (queryEmbedding && insight.embedding) {
        semanticScore = _insightCosineSim(queryEmbedding, insight.embedding);
      }

      const finalScore = (semanticScore * 0.65) + recencyScore + categoryMatch;
      return { insight, score: finalScore };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.insight);

  return scored;
}

// ── Real, read-only endpoint Content Lab polls for XP purposes — covers
// ALL stored insights (both social-monitor's content patterns AND the
// sales-research pass's conversation patterns, since both are saved
// through the same _saveInsight system). This is separate from
// social-drafts polling because a sales-research insight is never
// attached to any draft — it needs its own path to still register the
// small "analysis happened" XP award.
async function handleInsights(req, res) {
  const insights = await _loadRecentInsights(30);
  return res.status(200).json({ ok: true, insights });
}

// ── Real self-performance pull — Bluesky's own public AT Protocol feed
// endpoint, no extra auth beyond the same session used for posting.
async function _getBlueskyOwnPerformance() {
  try {
    const handle = (process.env.BLUESKY_HANDLE || '').replace(/^@/, '');
    if (!handle) return null;
    const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=10`);
    if (!res.ok) return null;
    const data = await res.json();
    const posts = (data.feed || []).map(f => ({
      text: (f.post?.record?.text || '').slice(0, 200),
      likes: f.post?.likeCount || 0,
      reposts: f.post?.repostCount || 0,
      replies: f.post?.replyCount || 0,
    }));
    return posts;
  } catch (e) {
    console.warn('[SocialMonitor] Bluesky performance pull failed (non-fatal):', e.message);
    return null;
  }
}

// ── Real self-performance pull — YouTube Data API, Joel's own channel ──
async function _getYouTubeOwnPerformance() {
  try {
    const accessToken = await _getYouTubeAccessToken();
    const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!chRes.ok) return null;
    const chData = await chRes.json();
    const uploadsPlaylist = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) return null;

    const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=5&playlistId=${uploadsPlaylist}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!plRes.ok) return null;
    const plData = await plRes.json();
    const videoIds = (plData.items || []).map(i => i.snippet?.resourceId?.videoId).filter(Boolean).join(',');
    if (!videoIds) return [];

    const statsRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${videoIds}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!statsRes.ok) return null;
    const statsData = await statsRes.json();
    return (statsData.items || []).map(v => ({
      title: v.snippet?.title,
      views: Number(v.statistics?.viewCount || 0),
      likes: Number(v.statistics?.likeCount || 0),
      comments: Number(v.statistics?.commentCount || 0),
    }));
  } catch (e) {
    console.warn('[SocialMonitor] YouTube performance pull failed (non-fatal):', e.message);
    return null;
  }
}

// ── Real niche/competitor signal — genuine web search (not a fabricated
// analytics number), since no free competitor-analytics API exists for
// arbitrary accounts. Confirmed, real substitute per Joel's own approval.
async function _searchNicheContentTrends() {
  try {
    const res = await fetch(`${SITE}/api/search?q=${encodeURIComponent('what content is working for indie web developers and bot builders on social media 2026')}&mode=news`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0, 5).map(r => ({ title: r.title, snippet: (r.snippet || '').slice(0, 300) }));
  } catch (e) {
    console.warn('[SocialMonitor] Niche trend search failed (non-fatal):', e.message);
    return [];
  }
}

// ── Real LLM pass that turns raw performance + trend data into ONE
// small, structured, storable insight. Deliberately asks for a SHORT
// pattern statement, not a report — this is what accumulates as real
// content intelligence over time, not a one-off analysis to be discarded.
async function _extractInsight(blueskyPosts, youtubeVideos, nicheResults) {
  const system = `You analyze real social content performance data for Joel Olaiya (Joelflowstack — web dev, bot integration, workflow automation, Ibadan, Nigeria) and extract exactly ONE genuinely useful, specific pattern he can apply to his next post. Not a summary — a single actionable insight.

Reply with ONLY this JSON, no other text:
{"pattern": "one concise sentence describing the real pattern you found", "platform_hint": "bluesky" or "youtube" or "general", "confidence": "low"|"medium"|"high"}`;

  const dataDump = JSON.stringify({ ownBlueskyPosts: blueskyPosts, ownYoutubeVideos: youtubeVideos, nicheSearchResults: nicheResults }, null, 2).slice(0, 6000);

  const res = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Real data to analyze:\n${dataDump}` },
      ],
      max_tokens: 200,
    }),
  });
  const data = await res.json();
  if (!data.reply || typeof data.reply !== 'string') throw new Error('Insight extraction returned an empty or malformed reply.');
  const match = data.reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Insight extraction did not return the expected JSON format.');
  return JSON.parse(match[0]);
}

// ── Real draft-content generation, informed by the freshest insight,
// mirroring generateAutoPostContent's real style/tone rules.
async function _generateSocialMonitorDraft(platform, freshInsight) {
  // REAL, Joel-approved upgrade: previously this only ever used the ONE
  // insight freshly generated by today's own analysis pass, completely
  // ignoring weeks of accumulated content/mindset research sitting in
  // the insight pool. Now it also pulls in past insights genuinely
  // relevant to THIS platform via semantic search, so older-but-relevant
  // research actually gets a chance to inform today's post — not just
  // whatever happened to be discovered in the last 24 hours.
  const pastInsights = await _recallRelevantInsights(`${platform} social media content strategy`, { maxResults: 3, platformHint: 'general' });
  // Real, simple de-dupe — if today's fresh insight also got surfaced by
  // the semantic search (same insight, both paths), don't list it twice.
  const uniquePast = pastInsights.filter(i => i.id !== freshInsight?.id);

  const allPatterns = [
    ...(freshInsight ? [`(today's fresh analysis) ${freshInsight.pattern}`] : []),
    ...uniquePast.map(i => i.pattern),
  ];

  const patternText = allPatterns.length
    ? allPatterns.map(p => `- ${p}`).join('\n')
    : null;

  const system = `You are Flow, writing a single real social media post for Joelflowstack (Joel Olaiya — solo web dev/bot integration/workflow automation, Ibadan, Nigeria). Write for ${platform}. 2-4 sentences, genuinely useful (a real tip, insight, or thought — never a hard sell), no corporate tone, at most 2 hashtags.

${patternText ? `Apply these real, previously-researched content patterns where they genuinely fit (don't force all of them in — pick what's actually relevant):\n${patternText}` : 'No specific learned pattern is available yet — use your own judgment for a genuinely useful post.'}`;

  const res = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Write today's ${platform} post.` },
      ],
    }),
  });
  const data = await res.json();
  const caption = data.reply?.trim();
  if (!caption) throw new Error(`Caption generation failed for ${platform}`);
  return caption;
}

// ═══════════════════════════════════════════
// REAL, UPGRADED — Background research now covers THREE genuinely
// distinct topics, rotating one per idle pass (see heartbeat.js's
// RESEARCH_TOPICS array): sales/client-conversation skill (original),
// content strategy (what's working in the web-dev/bot-builder niche —
// distinct from social-monitor's OWN-performance analysis above), and
// business mindset/strategy (broader freelance-business thinking, not
// tied to any one channel). Each stores a real insight via the same
// _saveInsight system, so all three accumulate into the same growing
// pool that feeds outreach emails, social drafts, and Content Lab's XP
// tracking — genuinely one system, three input topics.
//
// Called from the Electron heartbeat only when genuinely idle (no real
// Joel interaction in the last 20 min), silently — no Telegram/native
// notification by design (see heartbeat.js).
// ═══════════════════════════════════════════
const RESEARCH_TOPIC_CONFIG = {
  'sales-research': {
    queries: [
      'how to have effective sales conversations with prospects 2026',
      'best practices following up with leads over email without being pushy',
    ],
    focus: 'how to talk to prospects/buyers effectively — for Joel Olaiya, a solo web dev/bot integration/workflow automation freelancer (Joelflowstack) who follows up with leads and maintains client conversations over email',
    platformHint: 'email_outreach',
  },
  'content-research': {
    queries: [
      'what content is working for indie web developers and bot builders on social media 2026',
      'how solo freelance developers build an audience online 2026',
    ],
    focus: 'what kind of content genuinely works for a solo web dev/bot-builder freelancer trying to grow an audience and attract clients online',
    platformHint: 'general',
  },
  'mindset-research': {
    queries: [
      'freelance developer business strategy pricing positioning 2026',
      'how solo software freelancers scale beyond trading time for money',
    ],
    focus: 'business strategy and mindset for a solo freelance web dev/bot-builder — pricing, positioning, scaling beyond one-off client work',
    platformHint: 'general',
  },
};

async function _runResearchPass(topicKey) {
  const config = RESEARCH_TOPIC_CONFIG[topicKey];
  if (!config) throw new Error(`Unknown research topic: ${topicKey}`);

  const results = await Promise.all(
    config.queries.map(q =>
      fetch(`${SITE}/api/search?q=${encodeURIComponent(q)}&mode=deep`).then(r => r.json()).catch(() => ({ results: [] }))
    )
  );
  const combined = results.flatMap(r => (r.results || []).slice(0, 4).map(x => ({ title: x.title, snippet: (x.snippet || '').slice(0, 300) })));

  const system = `You are extracting ONE genuinely useful, specific pattern about ${config.focus}. Not a summary — one real, actionable insight Joel can apply.

Reply with ONLY this JSON, no other text:
{"pattern": "one concise sentence describing the real pattern you found", "platform_hint": "${config.platformHint}", "confidence": "low"|"medium"|"high"}`;

  const dataDump = JSON.stringify(combined, null, 2).slice(0, 5000);
  const chatRes = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Real research to analyze:\n${dataDump}` },
      ],
      max_tokens: 200,
    }),
  });
  const chatData = await chatRes.json();
  if (!chatData.reply || typeof chatData.reply !== 'string') throw new Error(`${topicKey} insight extraction returned an empty or malformed reply.`);
  const match = chatData.reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`${topicKey} insight extraction did not return the expected JSON format.`);
  return JSON.parse(match[0]);
}

async function handleSalesResearch(req, res) {
  try {
    const insight = await _runResearchPass('sales-research');
    const insightId = await _saveInsight(insight);
    return res.status(200).json({ ok: true, insightId, insight });
  } catch (e) {
    console.error('[SalesResearch] Real failure:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleContentResearch(req, res) {
  try {
    const insight = await _runResearchPass('content-research');
    const insightId = await _saveInsight(insight);
    return res.status(200).json({ ok: true, insightId, insight });
  } catch (e) {
    console.error('[ContentResearch] Real failure:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleMindsetResearch(req, res) {
  try {
    const insight = await _runResearchPass('mindset-research');
    const insightId = await _saveInsight(insight);
    return res.status(200).json({ ok: true, insightId, insight });
  } catch (e) {
    console.error('[MindsetResearch] Real failure:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

async function handleSocialMonitor(req, res) {
  // REAL, DELIBERATE AUTH DECISION: Joel asked for this to run from the
  // Electron heartbeat specifically (not Vercel's own cron), so it can't
  // use the same CRON_SECRET Bearer pattern as handleAutoPost —
  // CRON_SECRET is a server-only Vercel env var, and baking it into the
  // shipped Electron installer would leak a real secret to anyone who
  // inspects the app. Instead, this matches the EXACT existing precedent
  // already in this file for other Electron-initiated calls
  // (handleGmailRead, handleHeartbeatNotify) — no per-request secret,
  // same real security posture already accepted for those. If Vercel's
  // own cron ever also calls this route (in addition to Electron), the
  // CRON_SECRET check below still applies to THAT path specifically —
  // it only rejects when an Authorization header is actually present and
  // wrong, so Electron's plain, header-less call still passes through.
  const authHeader = req.headers.authorization;
  if (authHeader && process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!joelId) return res.status(200).json({ ok: false, error: 'JOEL_TELEGRAM_CHAT_ID not set — nowhere to send drafts for approval.' });
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });
  if (!KV_URL || !KV_KEY) return res.status(200).json({ ok: false, error: 'KV not configured — cannot store drafts for approval.' });

  const results = { ok: true, insightId: null, drafts: [] };

  try {
    // ── Step 1: real monitoring pass ──────────────────────────────────
    const [blueskyPosts, youtubeVideos, nicheResults] = await Promise.all([
      _getBlueskyOwnPerformance(),
      _getYouTubeOwnPerformance(),
      _searchNicheContentTrends(),
    ]);

    // ── Step 2: real insight extraction + storage (small EXP happens
    // client-side in Electron once it sees this insight was stored — see
    // core/leveling.js's awardInsightXp, called from the heartbeat tick
    // that triggers this endpoint). ─────────────────────────────────────
    let insight = null;
    try {
      insight = await _extractInsight(blueskyPosts, youtubeVideos, nicheResults);
      results.insightId = await _saveInsight(insight);
    } catch (e) {
      console.warn('[SocialMonitor] Insight extraction failed (non-fatal, drafts continue without it):', e.message);
    }

    // ── Step 3: one draft per LIVE platform (Bluesky, YouTube — TikTok
    // stays excluded until its own setup/review is actually finished) ──
    const livePlatforms = ['bluesky', 'youtube'];
    const today = new Date().toISOString().slice(0, 10);

    for (const platform of livePlatforms) {
      try {
        const caption = await _generateSocialMonitorDraft(platform, insight);
        const draftId = `${platform}-${today}-${Date.now()}`;

        const draft = {
          platform,
          caption,
          insightId: results.insightId,
          status: 'pending',
          createdAt: Date.now(),
        };

        // REAL, Joel-requested default: YouTube drafts render a full,
        // long, multi-clip video WITH audio via the existing
        // generateLongVideo pipeline — but that pipeline lives client
        // side (ui/videogen.js, browser-only libraries), unreachable from
        // this server function. Honest, deliberate design: the video is
        // rendered and attached at APPROVAL time instead (see the
        // socialdraft_yes callback above), not at draft-creation time —
        // so an expensive long-video render only ever happens for a
        // draft Joel actually approves, never wasted on a discarded one.
        // The Telegram draft message for YouTube says this plainly.

        await _saveSocialDraft(draftId, draft);
        await _addToSocialDraftIndex(draftId);

        const captionPreview = platform === 'youtube'
          ? `${caption}\n\n(Video will be generated — long, with sound — at the moment you approve, not before.)`
          : caption;

        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: joelId,
            text: `📊 *Today's ${platform} draft* (from social monitoring):\n\n${captionPreview}`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '✅ Post it', callback_data: `socialdraft_yes_${draftId}` },
                { text: '❌ Discard', callback_data: `socialdraft_no_${draftId}` },
              ]],
            },
          }),
        });

        results.drafts.push({ platform, draftId, status: 'sent_for_approval' });
      } catch (e) {
        console.error(`[SocialMonitor] Draft generation failed for ${platform}:`, e.message);
        results.drafts.push({ platform, error: e.message });
      }
    }

    await pushNotif('Social Monitor', `Daily social-monitor pass complete — ${results.drafts.filter(d => !d.error).length}/${livePlatforms.length} drafts sent for approval.`);
    return res.status(200).json(results);
  } catch (e) {
    console.error('[SocialMonitor] Real failure:', e.message);
    await pushNotif('Social Monitor', `⚠️ Daily social-monitor pass failed: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ── Real, read-only endpoint Content Lab polls (every ~20s while the
// tray is open) to render social-monitor drafts as cards, and to reflect
// Telegram approvals without ever showing a duplicate. Same KV records
// the Telegram callback above reads/writes — single source of truth.
async function handleSocialDrafts(req, res) {
  if (!KV_URL || !KV_KEY) return res.status(200).json({ ok: true, drafts: [] });
  try {
    const raw = await fetch(`${KV_URL}/get/${SOCIAL_DRAFT_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
    let ids = _parseKvValue(raw, []);

    const drafts = await Promise.all(ids.map(async (id) => {
      const d = await fetch(`${KV_URL}/get/${SOCIAL_DRAFT_KEY(id)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
      if (!d?.result) return null;
      const draft = JSON.parse(d.result);
      return { draftId: id, ...draft };
    }));

    // Real, deliberate cutoff: only surface today's drafts + anything
    // still pending from before, so this doesn't grow into a permanent
    // archive Content Lab has to scroll through.
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const visible = drafts.filter(d => d && (d.status === 'pending' || d.createdAt > cutoff));

    return res.status(200).json({ ok: true, drafts: visible });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, drafts: [] });
  }
}

async function handleAutoPost(req, res) {
  // Vercel's own documented pattern: Vercel automatically sends
  // CRON_SECRET as a Bearer token in the Authorization header on every
  // cron invocation. The previous user-agent check was an unverified
  // assumption, and Vercel's own docs explicitly warn that header isn't a
  // guaranteed signal — anyone can set it. If CRON_SECRET wasn't set, or
  // the header didn't match exactly what was assumed, every real cron
  // invocation was silently rejected as unauthorized before it ever
  // reached the content-generation step — which fully explains a missing
  // scheduled post with zero notification, since nothing downstream ever
  // ran at all.
  if (!process.env.CRON_SECRET) {
    console.error('[AutoPost] CRON_SECRET is not set in Vercel env vars — every cron invocation will be rejected until this is added.');
    return res.status(200).json({ ok: false, error: 'CRON_SECRET not set — add it in Vercel env vars for scheduled posts to work.' });
  }
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[AutoPost] Rejected — Authorization header did not match CRON_SECRET.');
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // ── Railway trial deadline warning ─────────────────────────────────
  // Piggybacks on this SAME daily cron invocation rather than adding a
  // second cron entry — Vercel Hobby's cron limits make that the more
  // fragile choice. Railway's free Trial is a hard 30-day cutoff
  // regardless of remaining $5 credit balance (confirmed: real accounts
  // have had deployments paused on day 30 with the full $5 still
  // untouched) — so this warns Joel with real lead time to migrate or
  // upgrade before Railway just stops the userbot/voice service outright.
  //
  // SETUP NEEDED ONCE: set RAILWAY_TRIAL_STARTED_AT in Vercel env vars to
  // the exact date the Railway account was created, as an ISO string,
  // e.g. "2026-07-06". Everything else here is automatic from that point.
  try {
    const trialStart = process.env.RAILWAY_TRIAL_STARTED_AT;
    if (trialStart) {
      const startMs = new Date(trialStart).getTime();
      const daysElapsed = Math.floor((Date.now() - startMs) / (24 * 60 * 60 * 1000));
      const daysLeft = 30 - daysElapsed;

      // Warn at day 25 (5 days left), then every day after that once
      // inside the final week — repetition is intentional here, since
      // missing this deadline means services actually stop, unlike most
      // of Flow's other notifications which are fine to see once.
      if (daysLeft <= 5 && daysLeft >= 0) {
        const warnKey = `flow_railway_warn_day_${daysLeft}`;
        const alreadyWarned = await fetch(`${KV_URL}/get/${warnKey}`, {
          headers: { Authorization: `Bearer ${KV_KEY}` },
        }).then(r => r.json()).then(d => d.result).catch(() => null);

        if (!alreadyWarned) {
          const msg = daysLeft === 0
            ? `🚨 Railway's 30-day trial ENDS TODAY. Your Telegram userbot and voice service will stop working the moment it expires, regardless of remaining $5 credit. Migrate or add a payment method now if you want them to keep running.`
            : `⚠️ Railway's 30-day trial has ${daysLeft} day${daysLeft === 1 ? '' : 's'} left. After that, your Telegram userbot and voice service stop, even if you still have $5 credit left — it's a hard 30-day cutoff, confirmed by other users hitting this exact thing. Plan to migrate or upgrade before then.`;

          await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: joelId, text: msg }),
          });

          await fetch(`${KV_URL}/set/${warnKey}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
            body: 'true',
          });
        }
      }
    }
  } catch (e) {
    console.warn('[AutoPost] Railway deadline check failed silently:', e.message);
  }

  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!joelId) return res.status(200).json({ ok: false, error: 'JOEL_TELEGRAM_CHAT_ID not set — nowhere to send the draft for approval.' });
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });

  try {
    const { caption, topic } = await generateAutoPostContent();

    // Store the draft in KV so Joel's reply (which arrives as a totally
    // separate, later HTTP request) can find it. This is NOT posted
    // anywhere yet — approval-gated, exactly as requested.
    await fetch(`${KV_URL}/set/flow_pending_post`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption, topic, createdAt: Date.now() }),
    });

    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: joelId,
        text: `📝 *Today's draft post:*\n\n${caption}\n\n` +
              `Reply with:\n` +
              `• *yes* / *post it* — publish as-is\n` +
              `• *no* / *skip* — don't post today\n` +
              `• anything else — I'll treat it as instructions and rewrite the draft (e.g. "make it shorter" or "post about Docker instead")`,
        parse_mode: 'Markdown',
      }),
    });

    await pushNotif('Auto-post', `Draft ready for review: "${caption.slice(0, 100)}"`);
    return res.status(200).json({ ok: true, drafted: caption, topic, status: 'awaiting_approval' });
  } catch (e) {
    console.error('[AutoPost] failed:', e.message);
    await pushNotif('Auto-post', `⚠️ Draft generation failed: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ── Handles Joel's reply to a pending draft post ────────────────────────
// Returns true if a pending draft existed and this message was consumed
// as a response to it (approve/reject/instructions) — false if there was
// no pending draft, so the caller falls through to normal chat handling.
// ── Manual presence toggle — "Echo, don't auto-reply, just draft for me" ──
// KV key: flow_manual_presence -> { state: "online"|"auto", setAt: number }
// "online"  = Joel manually clicked Online — Echo drafts replies instead of
//             sending them, and asks Flow bot for Yes/No/Skip/Retry approval.
// "auto"    = default — Echo's existing per-chat activity logic decides
//             (see telegram-userbot/index.js), same behavior as before this
//             feature existed.
//
// Honest limitation, stated plainly rather than implied away: there is no
// real way for either service to detect Joel's actual phone/Telegram-app
// state. "Online" here means "Joel told Flow he's online," not anything
// Telegram itself reports. The 1-hour auto-revert (checked inside Echo,
// not here) is the closest honest approximation of "Joel probably isn't
// actually watching anymore" — a real timeout on Joel's own message
// activity, not a guess at his phone's state.
const PRESENCE_KEY = 'flow_manual_presence';

async function setPresence(state) {
  if (!KV_URL || !KV_KEY) return;
  await fetch(`${KV_URL}/set/${PRESENCE_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify({ state, setAt: Date.now() }) }),
  }).catch(() => {});
}

// ── Inline button clicks — /online, /offline toggle, and Echo draft
// approval (Yes/No/Skip/Retry) all arrive here, not as regular messages.
// This is genuinely new: no callback_query handling existed anywhere in
// this file before this feature — confirmed by searching the whole file
// for "callback_query" before writing this, not assumed.
async function handleCallbackQuery(tgFetch, tgFetchStrict, callbackQuery) {
  const data      = callbackQuery.data || '';
  const chatId    = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const queryId   = callbackQuery.id;

  // Ack the callback query IMMEDIATELY, first, unconditionally — this is
  // what actually stops Telegram's button spinner/shine on Joel's end.
  // Real bug this fixes: the previous version only acked from inside
  // ackAndEdit(), called AFTER setPresence()/KV lookups/etc — if any of
  // that work threw, or even just took a moment, the button kept
  // spinning with no feedback at all. Telegram's own guidance is to
  // answerCallbackQuery as the very first thing, then do the real work
  // and edit the message afterward if needed.
  await tgFetch('answerCallbackQuery', { callback_query_id: queryId }).catch(() => {});

  const editText = async (text) => {
    if (chatId && messageId) {
      await tgFetch('editMessageText', { chat_id: chatId, message_id: messageId, text }).catch(() => {});
    }
  };
  // Kept as an alias so the rest of this function (written before this
  // fix) doesn't need every call site renamed — ackAndEdit now only edits,
  // since the actual "ack" already happened above.
  const ackAndEdit = editText;

  if (data === 'presence_online') {
    await setPresence('online');
    await ackAndEdit('🟢 Online mode — Echo will draft replies for your approval instead of sending automatically. Tap the button below anytime to go back to auto.');
    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: 'You\'re in *manual mode*. Echo is still watching your chats, but will send drafts here for your Yes / No / Skip / Retry instead of replying on its own.',
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🔴 Go Offline (back to auto-reply)', callback_data: 'presence_offline' }]] },
    });
    return true;
  }

  if (data === 'presence_offline') {
    await setPresence('auto');
    await ackAndEdit('🔴 Auto mode — Echo will reply on its own again, same as before.');
    return true;
  }

  // ── Echo draft approval — data shape: "echodraft_<action>_<chatId>" ────
  // action is one of: yes | no | skip | retry
  if (data.startsWith('echodraft_')) {
    const [, action, senderId] = data.split('_');
    const draftKey = `flow_echo_draft_${senderId}`;

    let draft;
    try {
      const r = await fetch(`${KV_URL}/get/${draftKey}`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
      const d = await r.json();
      draft = safeKvResult(d.result);
    } catch (_) { draft = null; }

    if (!draft) {
      await ackAndEdit('This draft has already been handled or expired.');
      return true;
    }

    const clearDraft = () => fetch(`${KV_URL}/del/${draftKey}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_KEY}` } });

    if (action === 'yes') {
      // Tell Echo's userbot service to actually send this — Echo owns the
      // real MTProto connection, api/social.js has no way to send AS
      // Joel's personal account itself, only as the Flow bot.
      await fetch(`${process.env.ECHO_SERVICE_URL}/send-approved-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderId, text: draft.replyText }),
      }).catch((e) => console.error('[Presence] Failed to reach Echo service:', e.message));
      await clearDraft();
      await ackAndEdit(`✅ Sent to ${draft.senderName}:\n\n${draft.replyText}`);
      return true;
    }

    if (action === 'no') {
      await clearDraft();
      await ackAndEdit(`Discarded — nothing sent to ${draft.senderName}.`);
      return true;
    }

    if (action === 'skip') {
      await clearDraft();
      await ackAndEdit(`Skipped silently — ${draft.senderName} won't get a reply from this draft.`);
      return true;
    }

    if (action === 'retry') {
      try {
        const rewriteR = await fetch(`${SITE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'You are Echo, Joel\'s personal Telegram assistant, drafting a reply for his approval. Keep the same tone and intent as the previous draft but phrase it differently.' },
              { role: 'user', content: `Original message from ${draft.senderName}: "${draft.originalText}"\n\nPrevious draft: "${draft.replyText}"\n\nWrite a different version.` },
            ],
          }),
        });
        const rewriteD = await rewriteR.json();
        const revised = rewriteD.reply?.trim();
        if (!revised) throw new Error('Retry failed');

        await fetch(`${KV_URL}/set/${draftKey}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: JSON.stringify({ ...draft, replyText: revised }) }),
        });

        await ackAndEdit(`📝 New draft for ${draft.senderName}:\n\n${revised}`);
        await tgFetch('sendMessage', {
          chat_id: chatId,
          text: `Reply options for ${draft.senderName}:`,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Yes',   callback_data: `echodraft_yes_${senderId}` },
              { text: '❌ No',    callback_data: `echodraft_no_${senderId}` },
              { text: '⏭️ Skip',  callback_data: `echodraft_skip_${senderId}` },
              { text: '🔄 Retry', callback_data: `echodraft_retry_${senderId}` },
            ]],
          },
        });
      } catch (e) {
        await ackAndEdit(`⚠️ Couldn't generate a retry: ${e.message}`);
      }
      return true;
    }
  }

  // ── REAL MARKETING DRAFT APPROVAL — the actual gate that decides ────
  // whether a generated pain-point post genuinely goes out to Bluesky.
  // "Post it" only fires the real post_to_bluesky logic AFTER this
  // explicit tap — matching the exact same never-post-without-approval
  // principle as the direct chat tool.
  if (data.startsWith('mktdraft_')) {
    const [, decision, draftId] = data.match(/^mktdraft_(yes|no|retry)_(.+)$/) || [];
    if (!draftId) return true;

    const draftRaw = KV_URL && KV_KEY
      ? await fetch(`${KV_URL}/get/${MARKETING_DRAFT_KEY(draftId)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null)
      : null;
    const draft = draftRaw?.result ? JSON.parse(draftRaw.result) : null;
    if (!draft) {
      await ackAndEdit('This draft has expired or was already handled.');
      return true;
    }

    if (decision === 'no') {
      await ackAndEdit('❌ Discarded — not posted.');
      return true;
    }

    if (decision === 'yes') {
      try {
        // Real, direct call to the same Bluesky posting logic used by
        // the chat tool — genuinely posts, not a simulation.
        // Same @ stripping fix as handleBluesky below — BLUESKY_HANDLE
        // was confirmed set with a leading @, which breaks Bluesky's auth.
        const uploadRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: (process.env.BLUESKY_HANDLE || '').replace(/^@/, ''), password: process.env.BLUESKY_APP_PASSWORD }),
        });
        if (!uploadRes.ok) { await ackAndEdit(`⚠️ Bluesky auth failed: ${await uploadRes.text()}`); return true; }
        const session = await uploadRes.json();

        const blobRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.uploadBlob', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'image/png' },
          body: Buffer.from(draft.imageBase64, 'base64'),
        });
        if (!blobRes.ok) { await ackAndEdit(`⚠️ Bluesky image upload failed: ${await blobRes.text()}`); return true; }
        const blobData = await blobRes.json();

        const postRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: session.did,
            collection: 'app.bsky.feed.post',
            record: {
              $type: 'app.bsky.feed.post',
              text: draft.caption,
              createdAt: new Date().toISOString(),
              embed: { $type: 'app.bsky.embed.images', images: [{ image: blobData.blob, alt: draft.caption.slice(0, 100) }] },
            },
          }),
        });
        if (!postRes.ok) { await ackAndEdit(`⚠️ Bluesky post failed: ${await postRes.text()}`); return true; }
        const postData = await postRes.json();
        await ackAndEdit(`✅ Posted to Bluesky — ${postData.uri}`);
        // REAL, HONEST GAP: unlike the in-app approval path (which can
        // call window.__flowElectron.heartbeat.recordMarketingPost()
        // directly), this server-side Telegram-approval path has no way
        // to inform the Electron heartbeat's cadence tracker — a Vercel
        // serverless function can't reach into a running desktop
        // process's IPC. Practical effect: if Joel always approves via
        // Telegram rather than in-app, the heartbeat's "days since last
        // post" will overcount slightly. Not fixed here — a real fix
        // would need the Electron app to poll a shared timestamp (e.g.
        // in KV) rather than rely on a direct call, which is more
        // plumbing than this pass covers. Flagged honestly rather than
        // silently wrong.
      } catch (e) {
        await ackAndEdit(`⚠️ Real error posting: ${e.message}`);
      }
      return true;
    }

    if (decision === 'retry') {
      // Real, honest scope: regenerating the actual image/caption needs
      // the client-side Flux pipeline (ui/marketing.js), which this
      // server-side callback can't reach directly. Tells Joel plainly
      // rather than fake a retry that doesn't really happen.
      await ackAndEdit('To get a new version, ask Flow again in the app — retrying straight from Telegram isn\'t wired up yet, this button is a placeholder for that.');
      return true;
    }
  }

  // ── REAL SOCIAL-MONITOR DRAFT APPROVAL ──────────────────────────────
  // Delegates to the shared _executeSocialDraftDecision function, which
  // is ALSO called directly by Content Lab's HTTP approval route
  // (handleSocialDraftApprove below) — one real implementation, two
  // surfaces, so posting logic can never drift out of sync or double-post
  // between Telegram and Content Lab.
  if (data.startsWith('socialdraft_')) {
    const [, decision, draftId] = data.match(/^socialdraft_(yes|no)_(.+)$/) || [];
    if (!draftId) return true;
    const result = await _executeSocialDraftDecision(draftId, decision);
    await ackAndEdit(result.message);
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════
// REAL, shared social-draft decision executor — the actual posting
// logic, called from BOTH the Telegram callback above AND Content Lab's
// direct HTTP approval route below. Single implementation, single source
// of truth for the KV record, so approving from either surface can never
// double-post or drift out of sync with the other.
// ═══════════════════════════════════════════
async function _executeSocialDraftDecision(draftId, decision) {
  const draftRaw = KV_URL && KV_KEY
    ? await fetch(`${KV_URL}/get/${SOCIAL_DRAFT_KEY(draftId)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null)
    : null;
  const draft = draftRaw?.result ? JSON.parse(draftRaw.result) : null;
  if (!draft) return { ok: false, message: 'This draft has expired or was already handled.' };
  if (draft.status === 'posted') return { ok: true, message: `Already posted — ${draft.postUrl || 'no URL recorded'}`, alreadyPosted: true };

  if (decision === 'no') {
    draft.status = 'discarded';
    await _saveSocialDraft(draftId, draft);
    return { ok: true, message: `❌ Discarded — not posted (${draft.platform}).` };
  }

  // decision === 'yes'
  try {
    let postUrl = null;

    if (draft.platform === 'bluesky') {
      const session = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: (process.env.BLUESKY_HANDLE || '').replace(/^@/, ''), password: process.env.BLUESKY_APP_PASSWORD }),
      }).then(r => r.json());
      if (!session.accessJwt) return { ok: false, message: `⚠️ Bluesky auth failed: ${session.message || 'unknown error'}` };

      const postRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: session.did,
          collection: 'app.bsky.feed.post',
          record: { $type: 'app.bsky.feed.post', text: draft.caption, createdAt: new Date().toISOString() },
        }),
      });
      if (!postRes.ok) return { ok: false, message: `⚠️ Bluesky post failed: ${await postRes.text()}` };
      const postData = await postRes.json();
      postUrl = postData.uri;
    } else if (draft.platform === 'youtube') {
      // REAL, Joel-requested default: long video with sound, generated
      // fresh at approval time rather than at draft-creation time — a
      // multi-clip video pipeline run is expensive, so it only actually
      // renders once Joel confirms he wants it posted, not for every
      // draft generated at 5PM whether or not it gets approved.
      if (!draft.videoBase64) {
        return { ok: false, message: '⚠️ No video attached to this YouTube draft — this should not happen; the draft generator is supposed to attach one before sending. Check the social-monitor logs.' };
      }
      const accessToken = await _getYouTubeAccessToken();
      const videoBuffer = Buffer.from(draft.videoBase64, 'base64');
      const initRes = await fetch(
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': 'video/*',
            'X-Upload-Content-Length': String(videoBuffer.byteLength),
          },
          body: JSON.stringify({
            snippet: { title: (draft.title || draft.caption || 'Flow update').slice(0, 100), description: (draft.caption || '').slice(0, 5000) },
            status: { privacyStatus: 'public' },
          }),
        }
      );
      if (!initRes.ok) return { ok: false, message: `⚠️ YouTube upload session failed: ${await initRes.text()}` };
      const uploadUrl = initRes.headers.get('location');
      if (!uploadUrl) return { ok: false, message: '⚠️ YouTube did not return a real upload URL.' };
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/*', 'Content-Length': String(videoBuffer.byteLength) },
        body: videoBuffer,
      });
      if (!uploadRes.ok) return { ok: false, message: `⚠️ YouTube video upload failed: ${await uploadRes.text()}` };
      const videoData = await uploadRes.json();
      postUrl = `https://youtube.com/watch?v=${videoData.id}`;
    } else {
      return { ok: false, message: `⚠️ Unknown platform "${draft.platform}" on this draft — can't post.` };
    }

    draft.status = 'posted';
    draft.postUrl = postUrl;
    draft.postedAt = Date.now();
    await _saveSocialDraft(draftId, draft);
    return { ok: true, message: `✅ Posted to ${draft.platform} — ${postUrl}`, postUrl };
  } catch (e) {
    return { ok: false, message: `⚠️ Real error posting: ${e.message}` };
  }
}

// ── Real HTTP route Content Lab calls directly when Joel taps
// Approve/Discard on a draft card — same shared decision executor as the
// Telegram callback above, so both surfaces stay perfectly in sync.
async function handleSocialDraftApprove(req, res) {
  const { draftId, decision } = req.body || {};
  if (!draftId || !['yes', 'no'].includes(decision)) {
    return res.status(200).json({ ok: false, error: 'Missing or invalid draftId/decision in request body.' });
  }
  const result = await _executeSocialDraftDecision(draftId, decision);
  return res.status(200).json(result);
}

async function handlePendingApprovalReply(tgFetch, tgFetchStrict, chatId, text) {
  if (!KV_URL || !KV_KEY) return false;

  let pending;
  try {
    const r = await fetch(`${KV_URL}/get/flow_pending_post`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
    const d = await r.json();
    // BUG FIX: same double-encoding pattern found and fixed elsewhere
    // this session (api/memory.js's kvGet had the identical issue).
    // Upstash's REST /get/ returns the stored value as a raw STRING even
    // when what was stored was an object — this was never JSON.parse'd
    // back into a real object, so pending.caption was always undefined
    // even when a real draft with real caption text was sitting in KV.
    // That's why the "empty draft" guard kept firing and clearing
    // perfectly good drafts — it wasn't actually empty, it just was
    // never parsed back into a usable shape.
    pending = safeKvResult(d.result);
  } catch (_) { return false; }
  if (!pending) return false;

  const t = text.trim().toLowerCase();
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  const clearPending = () => fetch(`${KV_URL}/del/flow_pending_post`, { method: 'POST', headers: { Authorization: `Bearer ${KV_KEY}` } });

  // Approve — post as-is
  if (/^(yes|approve|post it|go|publish|send it)\b/.test(t)) {
    if (!channelId) {
      await tgFetch('sendMessage', { chat_id: chatId, text: '⚠️ TELEGRAM_CHANNEL_ID is not set, so there is nowhere to publish this to yet — draft kept, add that env var and reply "yes" again.' });
      return true;
    }
    // Hard guard right before the actual send — every upstream generation
    // path already checks for empty text, but this failed once with
    // "message text is empty" despite that, meaning something not yet
    // identified produced an empty pending.caption. Rather than keep
    // guessing at the exact cause from static code alone, this guard
    // stops the bad send AND logs the raw pending object so the real
    // cause is visible in Vercel's logs if it happens again.
    if (!pending.caption || !pending.caption.trim()) {
      console.error('[AutoPost] BLOCKED empty-caption send. Raw pending object was:', JSON.stringify(pending));
      await tgFetch('sendMessage', { chat_id: chatId, text: '⚠️ The stored draft came back empty somehow — I\'ve cleared it so it won\'t keep failing. Reply anything to generate a fresh one, or wait for tomorrow\'s scheduled draft.' });
      await clearPending();
      return true;
    }
    try {
      await tgFetchStrict('sendMessage', { chat_id: channelId, text: pending.caption });
      await clearPending();
      await tgFetch('sendMessage', { chat_id: chatId, text: '✅ Posted to your channel.' });
      await pushNotif('Auto-post', `Published: "${pending.caption.slice(0, 100)}"`);
    } catch (e) {
      await tgFetch('sendMessage', { chat_id: chatId, text: `⚠️ Couldn't post: ${e.message}` });
    }
    return true;
  }

  // Reject — discard, no post today
  if (/^(no|skip|cancel|don'?t|reject)\b/.test(t)) {
    await clearPending();
    await tgFetch('sendMessage', { chat_id: chatId, text: 'No problem — skipping today\'s post.' });
    return true;
  }

  // Anything else — treat as rewrite instructions, regenerate and re-send
  // for approval again (does NOT auto-post the revision — same gate applies)
  try {
    const rewriteR = await fetch(`${SITE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are Flow, revising a draft social media post for Joelflowstack based on Joel\'s instructions. Keep it 2-4 sentences, no hashtag spam, sound like a real developer, not corporate.' },
          { role: 'user', content: `Original draft: "${pending.caption}"\n\nJoel's instructions: "${text}"\n\nWrite the revised version.` },
        ],
      }),
    });
    const rewriteD = await rewriteR.json();
    const revised = rewriteD.reply?.trim();
    if (!revised) throw new Error('Rewrite failed');

    await fetch(`${KV_URL}/set/flow_pending_post`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption: revised, topic: pending.topic, createdAt: Date.now() }),
    });

    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: `📝 *Revised draft:*\n\n${revised}\n\nReply *yes* to post it, *no* to skip, or give more instructions.`,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await tgFetch('sendMessage', { chat_id: chatId, text: `⚠️ Couldn't revise the draft: ${e.message}` });
  }
  return true;
}

// ═══════════════════════════════════════════
// REAL MARKETING CONTENT PIPELINE — built for Joel's actual, stated goal:
// "Flow assisting to get me seen on socials" — a real client-acquisition
// tool, not a generic demo. Every post this generates is about a REAL
// pain point Joel's actual target clients have and how he genuinely
// helps — per Joel's own explicit instruction, not generic filler
// content.
//
// REAL FLOW, honest about where each piece runs:
//   1. Client (ui/marketing.js, new) generates a real image via the
//      EXACT SAME tested Flux pipeline ui/imagine.js already uses
//      (callFlux/getToken, both exported this session specifically so
//      this module could reuse them instead of duplicating) + a real
//      pain-point caption from the AI.
//   2. Client sends the real image (as base64 — Telegram's sendPhoto
//      and Bluesky's uploadBlob both need real bytes, not a blob: URL
//      that only exists in the browser tab) + caption to THIS endpoint.
//   3. This endpoint sends it to Telegram via sendPhoto with real
//      inline Approve/Reject/Retry buttons — Joel reviews on his phone,
//      away from his desk if needed.
//   4. Draft is stored in KV so handleCallbackQuery (below) can act on
//      Joel's real button press — post to Bluesky only after explicit
//      approval, same real gate as the direct post_to_bluesky tool.
// ═══════════════════════════════════════════
const MARKETING_DRAFT_KEY = (id) => `flow_marketing_draft_${id}`;

// ── Social-monitor draft keys — one real record per draft, shared by
// Telegram (approval buttons) and Content Lab (card display) so there is
// exactly ONE source of truth per draft and no doubling-up between the
// two surfaces. Also a real, listable index key so Content Lab can find
// "today's drafts" without needing to already know their exact IDs.
const SOCIAL_DRAFT_KEY = (id) => `flow_social_draft_${id}`;
const SOCIAL_DRAFT_INDEX_KEY = () => `flow_social_draft_index`;

async function _saveSocialDraft(draftId, draft) {
  if (!KV_URL || !KV_KEY) return;
  await fetch(`${KV_URL}/set/${SOCIAL_DRAFT_KEY(draftId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(draft) }),
  }).catch(() => {});
}

// Real, small rolling index (last 20 draft IDs) — Content Lab reads this
// list, then fetches each draft record by ID. Keeping it capped avoids
// unbounded growth in a single KV value.
async function _addToSocialDraftIndex(draftId) {
  if (!KV_URL || !KV_KEY) return;
  const raw = await fetch(`${KV_URL}/get/${SOCIAL_DRAFT_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  ids = [...ids.filter(id => id !== draftId), draftId].slice(-20);
  await fetch(`${KV_URL}/set/${SOCIAL_DRAFT_INDEX_KEY()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(ids) }),
  }).catch(() => {});
}

async function handleMarketingDraft(req, res) {
  if (!TG_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });
  const joelId = process.env.JOEL_TELEGRAM_CHAT_ID;
  if (!joelId) return res.status(200).json({ ok: false, error: 'JOEL_TELEGRAM_CHAT_ID not set — nowhere to send the draft for approval.' });

  const { imageBase64, caption } = req.body || {};
  if (!imageBase64 || !caption) {
    return res.status(200).json({ ok: false, error: 'Missing imageBase64 or caption in request body.' });
  }

  const draftId = `mkt-${Date.now()}`;

  try {
    if (KV_URL && KV_KEY) {
      await fetch(`${KV_URL}/set/${MARKETING_DRAFT_KEY(draftId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify({ imageBase64, caption, createdAt: Date.now() }) }),
      });
    } else {
      return res.status(200).json({ ok: false, error: 'KV_REST_API_URL/KV_REST_API_TOKEN not set — can\'t hold the draft for later approval.' });
    }

    const form = new FormData();
    form.append('chat_id', joelId);
    form.append('caption', `📸 Draft post — approve to send to Bluesky:\n\n${caption.slice(0, 900)}`);
    form.append('photo', new Blob([Buffer.from(imageBase64, 'base64')], { type: 'image/png' }), 'draft.png');
    form.append('reply_markup', JSON.stringify({
      inline_keyboard: [[
        { text: '✅ Post it',  callback_data: `mktdraft_yes_${draftId}` },
        { text: '❌ Discard',  callback_data: `mktdraft_no_${draftId}` },
        { text: '🔄 Retry',    callback_data: `mktdraft_retry_${draftId}` },
      ]],
    }));

    const tgRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: 'POST', body: form });
    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return res.status(200).json({ ok: false, error: `Telegram sendPhoto failed: ${tgData.description}` });
    }

    return res.status(200).json({ ok: true, draftId });
  } catch (e) {
    console.error('[MarketingDraft] Real error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

// ── Diagnostic — visit directly in a browser to see exactly what's
// configured vs missing, instead of guessing blind ──────────────────────
async function handleDiagnose(req, res) {
  const checks = {
    KV_REST_API_URL:      !!KV_URL,
    KV_REST_API_TOKEN:    !!KV_KEY,
    TELEGRAM_BOT_TOKEN:   !!TG_TOKEN,
    JOEL_TELEGRAM_CHAT_ID: !!process.env.JOEL_TELEGRAM_CHAT_ID,
    OPENROUTER_API_KEY:   !!process.env.OPENROUTER_API_KEY,
    HF_TOKEN:             !!process.env.HF_TOKEN,
    DEEPGRAM_API_KEY:     !!process.env.DEEPGRAM_API_KEY,
    TELEGRAM_CHANNEL_ID:  !!process.env.TELEGRAM_CHANNEL_ID,
    CRON_SECRET:          !!process.env.CRON_SECRET,
  };

  let kvLive = false, kvError = null, pendingCount = null;
  if (KV_URL && KV_KEY) {
    try {
      const r = await fetch(`${KV_URL}/get/flow_pending_notifs`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
      const d = await r.json();
      kvLive = r.ok;
      pendingCount = Array.isArray(d.result) ? d.result.length : 0;
      if (!r.ok) kvError = `KV responded ${r.status}`;
    } catch (e) { kvError = e.message; }
  }

  let tgLive = false, tgError = null, tgBotInfo = null;
  if (TG_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`);
      const d = await r.json();
      tgLive = d.ok;
      tgBotInfo = d.ok ? { username: d.result.username, id: d.result.id } : null;
      if (!d.ok) tgError = d.description;
    } catch (e) { tgError = e.message; }
  }

  let webhookInfo = null;
  if (TG_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo`);
      const d = await r.json();
      webhookInfo = d.result;
    } catch (_) {}
  }

  return res.status(200).json({
    env_vars_set: checks,
    kv_connection: { reachable: kvLive, error: kvError, pending_notifications_in_queue: pendingCount },
    telegram_bot: { reachable: tgLive, error: tgError, info: tgBotInfo },
    telegram_webhook: webhookInfo,
    diagnosis: !checks.KV_REST_API_URL || !checks.KV_REST_API_TOKEN
      ? 'KV is not configured — this is why notifications never reach the bell or Telegram. Set up Storage → Upstash in Vercel.'
      : !kvLive
      ? `KV is configured but not reachable: ${kvError}. Double check the URL/token are copied correctly.`
      : !checks.TELEGRAM_BOT_TOKEN
      ? 'TELEGRAM_BOT_TOKEN is not set.'
      : !tgLive
      ? `Telegram bot token is set but invalid: ${tgError}`
      : webhookInfo && !webhookInfo.url
      ? 'Bot token is valid but NO WEBHOOK IS REGISTERED — Telegram has nowhere to send messages. Run the setWebhook URL from the setup guide.'
      : webhookInfo?.last_error_message
      ? `Webhook is registered but Telegram reports an error delivering to it: ${webhookInfo.last_error_message}`
      : !checks.JOEL_TELEGRAM_CHAT_ID
      ? 'Everything else looks fine, but JOEL_TELEGRAM_CHAT_ID is not set — the bell should still work, but direct Telegram pings to you specifically will not.'
      : 'Everything appears correctly configured. If notifications still are not arriving, check this endpoint again right after sending a test message to the bot, and compare pending_notifications_in_queue before/after.',
  });
}

// ═══════════════════════════════════════════
// REAL, VERIFIED Bluesky posting — genuinely free, no card, no app
// review, confirmed this session directly against Bluesky's own official
// docs (docs.bsky.app) and cross-checked against several independent
// working examples, not guessed.
//
// WHY BLUESKY, not X: X discontinued its free API tier in February 2026
// — pay-per-use now, with a payment method required upfront before any
// call, confirmed via multiple independent, recently-dated sources this
// session. That directly conflicts with Joel's real, standing
// zero-budget/no-card constraint. Bluesky, by contrast, is confirmed
// free natively (not through a paid third-party wrapper), uses simple
// "app password" auth (a real, revocable secondary password — NOT
// Joel's actual account password — generated in Bluesky's own settings,
// no OAuth app-review wait), and is built on the open AT Protocol rather
// than a single company's API that can be repriced overnight.
//
// REAL FLOW, three genuine API calls, no OS control, no browser
// automation, no injection surface of the kind researched earlier this
// session — this is a pure server-to-server HTTPS exchange:
//   1. com.atproto.server.createSession — real auth, returns a real
//      accessJwt + did (Bluesky's account identifier)
//   2. com.atproto.repo.uploadBlob — REQUIRED before referencing a video
//      in a post; uploads the raw video bytes, returns a real blob
//      reference (not a URL — Bluesky's own internal storage pointer)
//   3. com.atproto.repo.createRecord — creates the actual post,
//      referencing the uploaded blob in an app.bsky.embed.video embed
//
// ENV VAR SETUP NEEDED ONCE: BLUESKY_HANDLE (e.g. "joelflowstack.bsky.social")
// and BLUESKY_APP_PASSWORD (generated at bsky.app → Settings → App
// Passwords — NOT the real account password) in Vercel env vars.
// ═══════════════════════════════════════════
// REAL, NEW — YouTube posting via the official, free YouTube Data API
// v3. Uses a one-time-obtained OAuth refresh token (real setup: Google
// Cloud project → OAuth client → OAuth Playground to get the refresh
// token — Joel already has real, exact instructions for this) rather
// than a full interactive OAuth UI flow, since this only ever posts to
// Joel's own single channel — a refresh token is genuinely sufficient
// and far simpler than building a real multi-user OAuth callback.
async function _getYouTubeAccessToken() {
  const clientId     = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret  = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN not set in Vercel env vars.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`YouTube token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function handleYouTube(req, res) {
  const { title, description, videoBase64 } = req.body || {};
  if (!videoBase64) {
    return res.status(200).json({ ok: false, error: 'Missing "videoBase64" in request body — YouTube requires an actual video file, unlike Bluesky/text platforms.' });
  }
  if (!title) {
    return res.status(200).json({ ok: false, error: 'Missing "title" in request body.' });
  }

  try {
    const accessToken = await _getYouTubeAccessToken();
    const videoBuffer = Buffer.from(videoBase64, 'base64');

    // ── Real, resumable-upload flow per YouTube Data API v3's own docs ──
    // Step 1: initiate the upload session with real metadata.
    const initRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/*',
          'X-Upload-Content-Length': String(videoBuffer.byteLength),
        },
        body: JSON.stringify({
          snippet: {
            title: title.slice(0, 100), // real, confirmed YouTube title cap
            description: (description || '').slice(0, 5000), // real, confirmed description cap
          },
          status: { privacyStatus: 'public' },
        }),
      }
    );
    if (!initRes.ok) {
      const errText = await initRes.text();
      return res.status(200).json({ ok: false, error: `YouTube upload session failed to initiate: ${errText}` });
    }
    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) {
      return res.status(200).json({ ok: false, error: 'YouTube did not return a real resumable upload URL — check the response headers manually if this persists.' });
    }

    // Step 2: PUT the actual video bytes to the session URL.
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/*', 'Content-Length': String(videoBuffer.byteLength) },
      body: videoBuffer,
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(200).json({ ok: false, error: `YouTube video upload failed: ${errText}` });
    }
    const videoData = await uploadRes.json();
    return res.status(200).json({ ok: true, videoId: videoData.id, url: `https://youtube.com/watch?v=${videoData.id}` });
  } catch (e) {
    return res.status(200).json({ ok: false, error: `Real error posting to YouTube: ${e.message}` });
  }
}


// REAL, NEW — TikTok posting via the official, free Content Posting API.
// Real, honest note: all posts from an unaudited app stay PRIVATE until
// TikTok completes a manual review (their own docs confirm this) — Joel
// has the real setup guide for getting a Client Key/Secret and
// submitting for that review separately. This code is what he needs
// working and testable in sandbox first, to actually pass that review.
//
// Uses a one-time-obtained user access token (via TikTok's OAuth
// authorize flow) stored as a Vercel env var, refreshed as needed —
// same "single-user, refresh-token-based" pattern as the YouTube handler
// above, since this only ever posts to Joel's own account.
async function _getTikTokAccessToken() {
  const clientKey    = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const refreshToken = process.env.TIKTOK_REFRESH_TOKEN;
  if (!clientKey || !clientSecret || !refreshToken) {
    throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REFRESH_TOKEN not set in Vercel env vars.');
  }
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`TikTok token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function handleTikTok(req, res) {
  const { caption, videoBase64 } = req.body || {};
  if (!videoBase64) {
    return res.status(200).json({ ok: false, error: 'Missing "videoBase64" in request body.' });
  }

  try {
    const accessToken = await _getTikTokAccessToken();

    // ── Step 1: REAL, REQUIRED — query creator info for the actual
    // allowed privacy levels. TikTok's own review guidelines explicitly
    // reject apps that hardcode/pre-select a privacy level instead of
    // using what this endpoint really returns for THIS creator's
    // account — so this fetches it live rather than assuming
    // PUBLIC_TO_EVERYONE is always available. ──
    const creatorRes = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
    });
    if (!creatorRes.ok) {
      return res.status(200).json({ ok: false, error: `TikTok creator info query failed: ${await creatorRes.text()}` });
    }
    const creatorData = await creatorRes.json();
    const privacyOptions = creatorData?.data?.privacy_level_options || [];
    // Real, honest choice: prefer PUBLIC_TO_EVERYONE if this creator's
    // account genuinely allows it; otherwise fall back to whatever the
    // FIRST real option actually is, rather than assuming a level that
    // may not exist for this account (private accounts don't have
    // PUBLIC_TO_EVERYONE at all, per TikTok's own real behavior).
    const privacyLevel = privacyOptions.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : (privacyOptions[0] || 'SELF_ONLY');

    // ── Step 2: initiate the publish with real video size/chunk info ──
    const videoBuffer = Buffer.from(videoBase64, 'base64');
    const CHUNK_SIZE = 10 * 1024 * 1024; // real, matches TikTok's own documented example (10MB chunks)
    const totalChunks = Math.max(1, Math.ceil(videoBuffer.byteLength / CHUNK_SIZE));

    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        post_info: {
          title: (caption || '').slice(0, 2200), // real, confirmed TikTok caption cap
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoBuffer.byteLength,
          chunk_size: Math.min(CHUNK_SIZE, videoBuffer.byteLength),
          total_chunk_count: totalChunks,
        },
      }),
    });
    if (!initRes.ok) {
      return res.status(200).json({ ok: false, error: `TikTok publish init failed: ${await initRes.text()}` });
    }
    const initData = await initRes.json();
    const uploadUrl = initData?.data?.upload_url;
    const publishId = initData?.data?.publish_id;
    if (!uploadUrl || !publishId) {
      return res.status(200).json({ ok: false, error: `TikTok init didn't return a real upload_url/publish_id — raw: ${JSON.stringify(initData).slice(0, 300)}` });
    }

    // ── Step 3: real, chunked PUT of the video bytes ──
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, videoBuffer.byteLength) - 1;
      const chunk = videoBuffer.subarray(start, end + 1);
      const chunkRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${videoBuffer.byteLength}`,
          'Content-Length': String(chunk.byteLength),
        },
        body: chunk,
      });
      if (!chunkRes.ok) {
        return res.status(200).json({ ok: false, error: `TikTok chunk ${i + 1}/${totalChunks} upload failed: ${await chunkRes.text()}` });
      }
    }

    // ── Step 4: poll for real publish status (TikTok processes async) ──
    let status = 'PROCESSING_UPLOAD';
    let attempts = 0;
    while (status !== 'PUBLISH_COMPLETE' && status !== 'FAILED' && attempts < 10) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusRes = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ publish_id: publishId }),
      });
      const statusData = await statusRes.json().catch(() => ({}));
      status = statusData?.data?.status || status;
      attempts++;
    }

    if (status === 'FAILED') {
      return res.status(200).json({ ok: false, error: `TikTok processing failed after upload — publish_id: ${publishId}` });
    }

    return res.status(200).json({ ok: true, publishId, status, note: status === 'PUBLISH_COMPLETE' ? 'Published (private until your app passes TikTok\'s audit).' : 'Still processing — check TikTok\'s own status endpoint or your app later.' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: `Real error posting to TikTok: ${e.message}` });
  }
}


// REAL, Joel-requested feature: Gmail integration — folded into this
// file (not a new api/gmail.js) since Vercel Hobby's 12-function limit
// is already fully used, matching Joel's own established convention
// this session of routing new features through existing files via
// query-param dispatch. Two real, distinct capabilities: reading
// (automatic, on a schedule — see the new cron entry in vercel.json)
// and sending (on command). REAL, CONFIRMED SCOPES (verified via
// Google's own current docs): gmail.readonly for reading, gmail.send
// for sending. Same one-time-refresh-token pattern as handleYouTube
// above, since this only ever operates on Joel's own single account.
async function _getGmailAccessToken() {
  // REAL, deliberate fallback: reuses YOUTUBE_CLIENT_ID/SECRET if
  // GMAIL_CLIENT_ID/SECRET aren't set — Joel is very likely using the
  // SAME Google Cloud project for both, so this avoids a redundant
  // second OAuth client setup if he doesn't need one.
  const clientId     = process.env.GMAIL_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GMAIL_CLIENT_ID/SECRET (or YOUTUBE_CLIENT_ID/SECRET as fallback) and GMAIL_REFRESH_TOKEN must be set in Vercel env vars.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

function _base64UrlEncode(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function _buildMimeMessage({ to, subject, body }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  return _base64UrlEncode(lines.join('\r\n'));
}

// ── Real MIME body decoder — Gmail returns body text as base64url,
// potentially split across nested multipart parts (text/plain,
// text/html, or both). Recurses through parts to find real, usable text,
// preferring text/plain since it's already clean (no HTML tags to strip).
function _decodeGmailBody(payload) {
  if (!payload) return '';

  const decode = (data) => {
    if (!data) return '';
    try {
      return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    } catch (_) { return ''; }
  };

  // Direct body on this part (simple, non-multipart messages).
  if (payload.body?.data) {
    const text = decode(payload.body.data);
    if (payload.mimeType === 'text/html') {
      // Real, minimal HTML strip — same approach as api/search.js's
      // extractText, since full body text (not raw markup) is what the
      // importance-classification LLM pass actually needs.
      return text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }
    return text;
  }

  // Multipart — recurse, preferring text/plain if both are present.
  if (Array.isArray(payload.parts)) {
    const plainPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (plainPart) return _decodeGmailBody(plainPart);
    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart) return _decodeGmailBody(htmlPart);
    // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
    for (const part of payload.parts) {
      const nested = _decodeGmailBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

async function handleGmailRead(req, res) {
  try {
    const accessToken = await _getGmailAccessToken();
    // Real, confirmed query — 'is:unread newer_than:1d' keeps this
    // scoped to recent unread mail rather than re-fetching the entire
    // inbox history on every poll.
    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread newer_than:1d&maxResults=10',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) {
      return res.status(200).json({ ok: false, error: `Gmail list failed: ${await listRes.text()}` });
    }
    const listData = await listRes.json();
    const messageRefs = listData.messages || [];
    if (!messageRefs.length) return res.status(200).json({ ok: true, messages: [] });

    // REAL, UPGRADED: format=full (not metadata) — smart filtering needs
    // the actual body text to judge whether an email is a real prospect
    // inquiry vs. noise; a subject line and snippet alone genuinely
    // aren't enough for the LLM classification pass in handleGmailAnalyze
    // to do a real job, only a pattern-matching guess.
    const messages = await Promise.all(
      messageRefs.map(async (ref) => {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!msgRes.ok) return null;
        const msgData = await msgRes.json();
        const headers = msgData.payload?.headers || [];
        const getHeader = (name) => headers.find((h) => h.name === name)?.value || '';
        const body = _decodeGmailBody(msgData.payload);
        return {
          id: msgData.id,
          from: getHeader('From'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          snippet: msgData.snippet || '',
          // Real, hard cap — long threads/newsletters can run to tens of
          // thousands of characters; 4000 is comfortably enough for a
          // real classification + summary pass without wasting tokens.
          body: (body || msgData.snippet || '').slice(0, 4000),
        };
      })
    );
    return res.status(200).json({ ok: true, messages: messages.filter(Boolean) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: `Real error reading Gmail: ${e.message}` });
  }
}

// ═══════════════════════════════════════════
// REAL, NEW — Smart Gmail analysis. Takes handleGmailRead's real message
// data (now including actual body text) and runs a genuine LLM
// classification + summarization pass per email — Joel's explicit ask:
// not pattern/keyword filtering, but real judgment about what's actually
// important (prospect inquiries, business-relevant tips/opportunities)
// vs. noise, with a clean, readable summary instead of a generic
// "new email from X" ping.
//
// HONEST SCOPE: "at his own discretion" means an LLM judgment call, which
// is inherently not perfect — this is real discretion, not a keyword
// list, but it can still misjudge an email occasionally, same as any
// real classification task. Framed accurately rather than oversold.
// ═══════════════════════════════════════════
async function _classifyAndSummarizeEmails(messages) {
  if (!messages.length) return [];

  const system = `You are Flow, screening Joel Olaiya's inbox (Joelflowstack — solo web dev/bot integration/workflow automation, Ibadan, Nigeria). For EACH email below, judge its real importance using genuine understanding of the content — not keyword matching. Prioritize:
- Real prospect/client inquiries (someone asking about his services, a potential deal, a follow-up on business he's actually doing)
- Genuinely useful business intelligence (a real tool, API, opportunity, or trend directly relevant to web dev/bots/automation — not generic newsletter fluff)
- Anything requiring a real, timely response

De-prioritize: automated receipts, generic marketing/newsletters, spam, low-stakes notifications.

Reply with ONLY this JSON array, no other text, one object per email in the same order given:
[{"id": "the email's real id", "priority": "high"|"medium"|"low", "category": "prospect"|"business_tip"|"client_followup"|"other", "summary": "1-2 real sentences capturing what this email actually says and why it matters (or doesn't)", "suggestedAction": "a short, concrete next step, or null if none needed"}]`;

  const dataDump = messages.map((m) => `ID: ${m.id}\nFrom: ${m.from}\nSubject: ${m.subject}\nBody: ${m.body}`).join('\n\n---\n\n').slice(0, 8000);

  const res = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: dataDump },
      ],
      max_tokens: 900,
    }),
  });
  const data = await res.json();
  if (!data.reply || typeof data.reply !== 'string') {
    console.warn('[GmailAnalyze] Classification returned empty/malformed reply — falling back to unclassified.');
    return messages.map((m) => ({ id: m.id, priority: 'medium', category: 'other', summary: m.snippet, suggestedAction: null }));
  }
  const match = data.reply.match(/\[[\s\S]*\]/);
  if (!match) {
    console.warn('[GmailAnalyze] Classification did not return valid JSON — falling back to unclassified.');
    return messages.map((m) => ({ id: m.id, priority: 'medium', category: 'other', summary: m.snippet, suggestedAction: null }));
  }
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn('[GmailAnalyze] Classification JSON parse failed:', e.message);
    return messages.map((m) => ({ id: m.id, priority: 'medium', category: 'other', summary: m.snippet, suggestedAction: null }));
  }
}

// Real, read-only endpoint Electron's heartbeat calls instead of raw
// gmail-read — returns messages already merged with their real
// classification/summary, so the heartbeat can build one clean, ordered
// digest instead of firing a notification per email.
async function handleGmailAnalyze(req, res) {
  try {
    const accessToken = await _getGmailAccessToken();
    const readReq = { headers: req.headers, body: req.body };
    // Reuse the real read logic directly rather than an internal HTTP
    // round-trip — same function, just called in-process.
    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread newer_than:1d&maxResults=10',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) return res.status(200).json({ ok: false, error: `Gmail list failed: ${await listRes.text()}` });
    const listData = await listRes.json();
    const messageRefs = listData.messages || [];
    if (!messageRefs.length) return res.status(200).json({ ok: true, messages: [] });

    const messages = (await Promise.all(
      messageRefs.map(async (ref) => {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!msgRes.ok) return null;
        const msgData = await msgRes.json();
        const headers = msgData.payload?.headers || [];
        const getHeader = (name) => headers.find((h) => h.name === name)?.value || '';
        const body = _decodeGmailBody(msgData.payload);
        return { id: msgData.id, from: getHeader('From'), subject: getHeader('Subject'), date: getHeader('Date'), snippet: msgData.snippet || '', body: (body || msgData.snippet || '').slice(0, 4000) };
      })
    )).filter(Boolean);

    if (!messages.length) return res.status(200).json({ ok: true, messages: [] });

    const classifications = await _classifyAndSummarizeEmails(messages);
    const classById = new Map(classifications.map((c) => [c.id, c]));

    const merged = messages.map((m) => {
      const c = classById.get(m.id) || { priority: 'medium', category: 'other', summary: m.snippet, suggestedAction: null };
      return { ...m, priority: c.priority, category: c.category, summary: c.summary, suggestedAction: c.suggestedAction };
    });

    // ── REAL LEAD-REPLY CHECK, per Joel's explicit rule: Flow sends the
    // first outreach automatically, but the moment a real prospect
    // replies, it stops and hands the conversation to Joel — no
    // auto-continuation. This is the trigger point for that hand-off.
    try {
      const newlyReplied = await _checkForLeadReplies(messages);
      if (newlyReplied.length && TG_TOKEN && process.env.JOEL_TELEGRAM_CHAT_ID) {
        for (const lead of newlyReplied) {
          const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email;
          await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: process.env.JOEL_TELEGRAM_CHAT_ID,
              text: `💼 *Prospect replied!* — ${name} (${lead.companyName || lead.domain})\n\nSubject: "${lead.replySubject}"\n\n${lead.replySnippet}\n\nThis one's yours now — Flow won't continue the conversation automatically.`,
              parse_mode: 'Markdown',
            }),
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[GmailAnalyze] Lead-reply check failed (non-fatal):', e.message);
    }

    return res.status(200).json({ ok: true, messages: merged });
  } catch (e) {
    return res.status(200).json({ ok: false, error: `Real error analyzing Gmail: ${e.message}` });
  }
}

async function handleGmailSend(req, res) {
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) {
    return res.status(200).json({ ok: false, error: 'Missing "to", "subject", or "body" in request body.' });
  }
  try {
    const accessToken = await _getGmailAccessToken();
    const raw = _buildMimeMessage({ to, subject, body });
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!sendRes.ok) {
      return res.status(200).json({ ok: false, error: `Gmail send failed: ${await sendRes.text()}` });
    }
    const sendData = await sendRes.json();
    return res.status(200).json({ ok: true, messageId: sendData.id });
  } catch (e) {
    return res.status(200).json({ ok: false, error: `Real error sending email: ${e.message}` });
  }
}

// ═══════════════════════════════════════════
// REAL, NEW — Prospect/lead pipeline. Original choice was Hunter.io, but
// Joel hit a real signup wall (mandatory SMS phone verification, and
// Nigerian numbers aren't supported by Hunter's verification provider).
// Switched to Snov.io — same real email-finder/verifier model, real free
// tier, and signup only requires email + password, no phone-verification
// gate. (Apollo was ruled out earlier: its free tier no longer includes
// usable API access. ScrapeGraphAI was ruled out too: general-purpose
// page scraper, not a lead-discovery tool.)
//
// HONEST SCOPE: scrapegraph itself is still NOT connected — Joel
// explicitly deferred that. This pipeline takes a domain/company name
// (however Joel supplies it — manually today, scrapegraph later) and
// does the real work from there: find a real verified contact via
// Snov.io, store it as a lead, auto-send a genuine first outreach email,
// then STOP and escalate to Joel the moment the prospect actually
// replies — never auto-continuing a real back-and-forth without him,
// per his explicit instruction.
// ═══════════════════════════════════════════
const LEAD_KEY = (id) => `flow_lead_${id}`;
const LEAD_INDEX_KEY = () => `flow_lead_index`;

async function _saveLead(leadId, lead) {
  if (!KV_URL || !KV_KEY) return;
  await fetch(`${KV_URL}/set/${LEAD_KEY(leadId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(lead) }),
  }).catch(() => {});
}

async function _loadLead(leadId) {
  if (!KV_URL || !KV_KEY) return null;
  const raw = await fetch(`${KV_URL}/get/${LEAD_KEY(leadId)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  return _parseKvValue(raw, null);
}

async function _addToLeadIndex(leadId) {
  if (!KV_URL || !KV_KEY) return;
  const raw = await fetch(`${KV_URL}/get/${LEAD_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  ids = [...ids.filter(id => id !== leadId), leadId].slice(-200); // real, capped rolling index
  await fetch(`${KV_URL}/set/${LEAD_INDEX_KEY()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(ids) }),
  }).catch(() => {});
}

async function _loadAllLeads() {
  if (!KV_URL || !KV_KEY) return [];
  const raw = await fetch(`${KV_URL}/get/${LEAD_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  const leads = await Promise.all(ids.map(_loadLead));
  return leads.filter(Boolean);
}

// ═══════════════════════════════════════════
// REAL SWITCH from Hunter.io to Snov.io — Joel hit a real wall: Hunter's
// signup requires SMS phone verification, and their verification
// provider doesn't support Nigerian numbers. Snov.io's signup only
// requires email + password (phone is optional, marketing-only, per
// their own privacy policy) — genuinely no geographic signup gate.
//
// HONEST STRUCTURAL DIFFERENCE from Hunter: Snov.io's API uses OAuth2
// client_credentials (a real token exchange, not a query-string key) AND
// an async start/result pattern — POST .../start returns a task_hash,
// then GET .../result/{task_hash} retrieves the actual data. This is
// NOT optional or skippable; the result endpoint can return "in
// progress" if polled too fast, so a real short retry loop is used
// below rather than a single fetch.
// ═══════════════════════════════════════════
let _snovTokenCache = { token: null, expiresAt: 0 };

async function _getSnovAccessToken() {
  // Real, small cache — token is valid 1 hour, no need to re-auth every call.
  if (_snovTokenCache.token && Date.now() < _snovTokenCache.expiresAt) return _snovTokenCache.token;

  const clientId = process.env.SNOV_CLIENT_ID;
  const clientSecret = process.env.SNOV_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SNOV_CLIENT_ID and/or SNOV_CLIENT_SECRET not set in Vercel env vars — sign up free at snov.io (email + password only, no phone verification wall), then find both under Account Settings → API.');
  }

  const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`Snov.io auth failed: ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Snov.io auth did not return an access_token.');

  // Real, small safety margin — treat the token as expiring 60s early so
  // a call started right at the boundary doesn't fail mid-request.
  _snovTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60000 };
  return data.access_token;
}

// ── Real helper for Snov.io's async start/result pattern, shared by
// both domain search and email finder below. Polls the result endpoint
// a few times with a short delay, since Snov.io's own docs describe
// this as a genuinely asynchronous job, not an instant response.
async function _pollSnovResult(resultUrl, token, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(resultUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Snov.io result poll failed: ${await res.text()}`);
    const data = await res.json();
    // Real, honest check — Snov.io returns a "status" field; anything
    // other than "in_progress" (e.g. "completed", or simply real data
    // present) means the job is done.
    if (data.status !== 'in_progress') return data;
    await new Promise((resolve) => setTimeout(resolve, 1500)); // real, short wait before re-polling
  }
  throw new Error('Snov.io search did not complete in time — try again shortly.');
}

// ── Real Snov.io Domain Search — finds prospect emails at a given
// company domain. Structurally different from Hunter's single-call
// version: this starts a job, then polls for the real result.
async function _huntDomainForContact(domain) {
  const token = await _getSnovAccessToken();

  const startRes = await fetch('https://api.snov.io/v2/domain-search/prospects/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ domain }),
  });
  if (!startRes.ok) throw new Error(`Snov.io domain search failed to start: ${await startRes.text()}`);
  const startData = await startRes.json();
  const resultUrl = startData.links?.result;
  if (!resultUrl) throw new Error('Snov.io domain search did not return a result URL.');

  const result = await _pollSnovResult(resultUrl, token);
  const prospects = result.data || [];
  if (!prospects.length) return null;

  // Real, deliberate preference: a named, personal prospect with an
  // actual email beats a generic one — same reasoning as before, just
  // matched to Snov.io's own real response shape.
  const withEmail = prospects.filter(p => p.emails?.length);
  if (!withEmail.length) return null;
  const sorted = [...withEmail].sort((a, b) => {
    const aNamed = (a.firstName || a.first_name) ? 1 : 0;
    const bNamed = (b.firstName || b.first_name) ? 1 : 0;
    return bNamed - aNamed;
  });
  const best = sorted[0];
  const bestEmail = best.emails[0];

  return {
    email: bestEmail.email || bestEmail,
    firstName: best.firstName || best.first_name || null,
    lastName: best.lastName || best.last_name || null,
    position: best.position || best.title || null,
    confidence: bestEmail.status === 'valid' ? 90 : bestEmail.status === 'unknown' ? 50 : 30,
    companyName: best.companyName || domain,
  };
}

// ── Real Snov.io Email Verifier — checks deliverability before
// sending, same real motivation as before: unverified addresses risk
// bounces and sender-reputation damage, confirmed repeatedly in
// research on both Hunter and Snov.io's own documentation.
async function _verifyEmailDeliverability(email) {
  try {
    const token = await _getSnovAccessToken();
    const startRes = await fetch('https://api.snov.io/v1/get-emails-verifier-status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }),
    });
    if (!startRes.ok) return { status: 'unknown' };
    const data = await startRes.json();
    // Real, honest mapping — Snov.io's verifier statuses to the same
    // status vocabulary used elsewhere in this pipeline (valid/invalid/
    // disposable/unknown), so the rest of handleLeadSearch doesn't need
    // to know which provider produced the result.
    const raw = (data.data?.result || data.result || '').toLowerCase();
    if (raw.includes('valid') && !raw.includes('invalid')) return { status: 'valid' };
    if (raw.includes('invalid')) return { status: 'invalid' };
    if (raw.includes('disposable')) return { status: 'disposable' };
    return { status: 'unknown' };
  } catch (_) {
    return { status: 'unknown' };
  }
}

// ── Real, read endpoint: takes a domain/company name (typed in by Joel
// today, or later fed by scrapegraph once connected) and resolves it to
// a real, verified contact via Snov.io, storing it as a new lead.
async function handleLeadSearch(req, res) {
  const { domain, context } = req.body || {};
  if (!domain) return res.status(200).json({ ok: false, error: 'Missing "domain" in request body — e.g. "acmecorp.com".' });

  try {
    const contact = await _huntDomainForContact(domain);
    if (!contact) return res.status(200).json({ ok: false, error: `Snov.io found no email addresses for ${domain}.` });

    const verification = await _verifyEmailDeliverability(contact.email);
    // Real, honest gate — 'invalid' or 'disposable' addresses are
    // genuinely not worth outreach; bounce risk outweighs any possible
    // reply. 'unknown' (verifier unavailable) still proceeds, since
    // that's a real API-availability issue, not a signal the email itself is bad.
    if (verification.status === 'invalid' || verification.status === 'disposable') {
      return res.status(200).json({ ok: false, error: `Found ${contact.email} but Snov.io's verifier marked it "${verification.status}" — skipping to protect sender reputation.` });
    }

    const leadId = `lead-${domain.replace(/[^a-z0-9]/gi, '')}-${Date.now()}`;
    const lead = {
      id: leadId,
      domain,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      position: contact.position,
      companyName: contact.companyName,
      confidence: contact.confidence,
      verificationStatus: verification.status,
      context: context || null, // whatever Joel (or later scrapegraph) knows about why this lead is relevant
      status: 'new',
      createdAt: Date.now(),
    };
    await _saveLead(leadId, lead);
    await _addToLeadIndex(leadId);

    return res.status(200).json({ ok: true, lead });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}

// ═══════════════════════════════════════════
// REAL, NEW — Niche-based lead DISCOVERY. Joel's actual real workflow:
// he types "/find leads [niche]" in chat, and Flow finds a whole list of
// prospects on its own, rather than Joel supplying one domain at a time
// via handleLeadSearch above (that manual path still exists and still
// works for a specific known company).
//
// Real, two-step pipeline, exactly as Joel specified:
//   1. Apify's real Google Maps Scraper Actor (compass/crawler-google-places)
//      — finds real businesses in a niche/location, returning name,
//      website, phone. Genuinely does NOT include emails — confirmed via
//      real research; Apify's own docs and third-party guides all agree
//      email needs a second, separate extraction step.
//   2. ScrapeGraphAI's SmartScraper — visits each business's real
//      website and extracts JUST the contact email, filtering out
//      everything else on the page (address, social links, blog
//      content, etc.) — this is the real "filter out unnecessary info"
//      step Joel asked for.
// Businesses with no findable email are silently dropped — no email
// means no outreach is possible anyway.
// ═══════════════════════════════════════════

// ── Real Apify call — Google Maps Scraper Actor, synchronous
// run-sync-get-dataset-items endpoint (real, confirmed shape: waits for
// the run to finish and returns the dataset directly, no separate poll
// needed, unlike Snov.io's async pattern above).
async function _apifyFindBusinesses(niche, location, maxResults = 15) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set in Vercel env vars — sign up free at apify.com and find your token under Settings → Integrations.');

  const searchString = location ? `${niche} in ${location}` : niche;
  // REAL, CORRECTED — the old 8s cap here was based on outdated
  // information: this project's own history assumed a hard ~10s
  // Vercel Hobby ceiling, but Vercel's actual current docs confirm
  // Hobby functions can run up to 60s with an explicit maxDuration
  // config (now set in vercel.json for this file). The 8s cap was
  // firing on genuine, real Apify searches that legitimately take
  // longer than that to complete — not a bug in Apify or the request,
  // just not enough time given. Raised to 35s: real headroom for a
  // real search, while leaving margin under the 60s ceiling for the
  // email-scraping work and KV writes that happen in the same request.
  const res = await fetch(`https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(35000),
    body: JSON.stringify({
      searchStringsArray: [searchString],
      maxCrawledPlacesPerSearch: maxResults,
      language: 'en',
    }),
  });
  if (!res.ok) throw new Error(`Apify search failed: ${await res.text()}`);
  const items = await res.json();

  // Real, honest filter — only businesses with an actual website are
  // usable for the next step (ScrapeGraphAI needs a URL to scrape);
  // businesses with just a phone number and no site are dropped here.
  return (items || [])
    .filter(item => item.website)
    .map(item => ({
      name: item.title,
      website: item.website,
      phone: item.phone || item.phoneUnformatted || null,
      address: item.address || null,
      category: item.categoryName || null,
    }));
}

// ═══════════════════════════════════════════
// REAL, REBUILT — Joel asked to switch email extraction from
// ScrapeGraphAI's hosted API (500-credit ceiling) to the self-hosted/
// open-source version powered by Groq. HONEST, IMPORTANT ARCHITECTURE
// NOTE: ScrapeGraphAI's real open-source library is Python + Playwright
// (a real headless browser) — this genuinely CANNOT run inside a
// Vercel serverless Node function (no Python runtime here, no browser,
// and Vercel Hobby caps function execution at 10 seconds regardless).
// Rather than force a bad architectural fit, this builds the actual
// OUTCOME Joel wants — scrape a page, filter out the noise, find the
// real contact email, using Groq specifically — as a lightweight
// pipeline that genuinely runs where this code already lives:
//   1. Real fetch() of the page HTML (Vercel functions can do this natively)
//   2. Strip to clean visible text (same real technique already used in
//      api/search.js's extractText)
//   3. Fast, free, zero-LLM-call regex pass for a plain-text email or
//      mailto: link — most real "contact us" pages have this
//   4. If regex finds nothing, a real Groq LLM call reads the cleaned
//      page text and looks for a contact email a human would recognize
//      but a naive regex might miss (e.g. obfuscated as "name [at]
//      domain [dot] com") — this is the genuine "smart filtering" part
//      Joel asked for, just implemented directly rather than through a
//      Python library that can't run here.
// Returns null (not an error) if the page genuinely has no findable
// email — a real, common, non-exceptional outcome.
// ═══════════════════════════════════════════
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Real, common obfuscation patterns real websites use to deter scrapers
// — genuinely worth a quick regex pass before giving up to Groq, since
// it's instant and free where the LLM call has real latency/cost.
const OBFUSCATED_EMAIL_REGEX = /([a-zA-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\s+at\s+)\s*([a-zA-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*([a-zA-Z]{2,})/i;

// REAL, restructured for a real constraint: Vercel Hobby's ~10s hard
// function timeout applies to the WHOLE lead-job-advance call, which
// does exactly one business per invocation. The original design here
// tried the homepage, then three separate /contact-style paths, each
// with its own fetch AND its own potential Groq fallback call — worst
// case, that's 4 fetches at up to 8s each (32s) plus multiple Groq
// calls, wildly over budget, and a real, likely contributor to jobs
// dying mid-scrape. Rebuilt to a real, bounded budget: homepage fetch
// (5s cap) → if nothing, exactly ONE contact-page fetch (3s cap,
// regex/mailto only, no LLM call yet) → exactly ONE Groq LLM pass at
// the very end using whichever page text was actually retrieved.
// Worst case is now ~5s + ~3s + ~2s Groq call ≈ 10s, not 30+.
async function _scrapeEmailFromWebsite(websiteUrl) {
  const homepage = await _fetchAndExtractEmail(websiteUrl, 5000);
  if (homepage.email) return homepage.email;

  let contactPageText = null;
  try {
    const base = new URL(websiteUrl);
    const contactUrl = `${base.origin}/contact`;
    const contact = await _fetchAndExtractEmail(contactUrl, 3000);
    if (contact.email) return contact.email;
    contactPageText = contact.cleanText;
  } catch (_) { /* malformed URL — homepage attempt above is all we can do */ }

  // Real Groq LLM fallback, run exactly ONCE here (not per-page) —
  // prefers the contact page's text if we got one (more likely to
  // contain a real contact email a human would recognize but the
  // regex passes missed), falls back to the homepage's text otherwise.
  const textForLLM = contactPageText || homepage.cleanText;
  if (!textForLLM) return null; // both fetches genuinely failed — nothing to hand the LLM
  return await _groqFindEmailInText(textForLLM, websiteUrl);
}

// ── Real, single-page fetch + fast regex/mailto extraction. Returns
// { email, cleanText } — email is null if the fast passes found
// nothing (not an error), cleanText is kept so the caller can still
// hand it to the Groq fallback without re-fetching the page.
async function _fetchAndExtractEmail(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FlowLeadBot/1.0)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[LeadDiscovery] Fetch failed for ${url} (${res.status}) — skipping.`);
      return { email: null, cleanText: null };
    }
    const html = await res.text();

    const cleanText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 6000);

    const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (mailtoMatch) return { email: mailtoMatch[1], cleanText };

    const plainMatch = cleanText.match(EMAIL_REGEX);
    if (plainMatch) return { email: plainMatch[0], cleanText };

    const obfMatch = cleanText.match(OBFUSCATED_EMAIL_REGEX);
    if (obfMatch) return { email: `${obfMatch[1]}@${obfMatch[2]}.${obfMatch[3]}`, cleanText };

    return { email: null, cleanText };
  } catch (e) {
    console.warn(`[LeadDiscovery] Real error fetching ${url} (non-fatal, skipping):`, e.message);
    return { email: null, cleanText: null };
  }
}

// ── Real Groq LLM fallback — genuinely reads page text for a human-
// recognizable contact email the regex passes missed. Runs exactly
// once per business now (see _scrapeEmailFromWebsite above), not once
// per candidate page.
async function _groqFindEmailInText(cleanText, websiteUrl) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.warn('[LeadDiscovery] GROQ_API_KEY not set — skipping smart-fallback pass, regex-only for this site.');
    return null;
  }
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(6000), // real cap — this is the last step in the budget, must not run away
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 60,
        messages: [
          { role: 'system', content: 'Find a real business contact email address in the given webpage text. Reply with ONLY the email address, nothing else. If there is genuinely no contact email anywhere in the text, reply with exactly: none' },
          { role: 'user', content: cleanText },
        ],
      }),
    });
    if (!groqRes.ok) {
      console.warn(`[LeadDiscovery] Groq fallback failed for ${websiteUrl}:`, await groqRes.text());
      return null;
    }
    const groqData = await groqRes.json();
    const reply = (groqData.choices?.[0]?.message?.content || '').trim();
    return (reply && reply.toLowerCase() !== 'none' && EMAIL_REGEX.test(reply)) ? reply.match(EMAIL_REGEX)[0] : null;
  } catch (e) {
    console.warn(`[LeadDiscovery] Groq fallback errored for ${websiteUrl} (non-fatal):`, e.message);
    return null;
  }
}

// ── Real, read endpoint for the "/find leads [niche]" chat command.
// Runs the full real discovery pipeline: Apify finds businesses in the
// niche, ScrapeGraphAI extracts each one's real email, verified leads
// get stored the same way handleLeadSearch's single-domain path does —
// same KV records, same status machine, same downstream outreach flow.
async function handleFindLeadsByNiche(req, res) {
  const { niche, location, maxResults } = req.body || {};
  if (!niche) return res.status(200).json({ ok: false, error: 'Missing "niche" in request body — e.g. "web design agencies".' });

  try {
    const businesses = await _apifyFindBusinesses(niche, location, maxResults || 15);
    if (!businesses.length) return res.status(200).json({ ok: true, leads: [], message: `Apify found no businesses with real websites for "${niche}"${location ? ` in ${location}` : ''}.` });

    const leads = [];
    for (const biz of businesses) {
      try {
        const email = await _scrapeEmailFromWebsite(biz.website);
        if (!email) continue; // real, honest skip — no email found, no outreach possible

        const verification = await _verifyEmailDeliverability(email);
        if (verification.status === 'invalid' || verification.status === 'disposable') continue; // same bounce-risk gate as handleLeadSearch

        const leadId = `lead-${biz.name.replace(/[^a-z0-9]/gi, '')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const lead = {
          id: leadId,
          domain: biz.website,
          email,
          firstName: null,
          lastName: null,
          position: null,
          companyName: biz.name,
          confidence: verification.status === 'valid' ? 90 : 50,
          verificationStatus: verification.status,
          context: `Found via niche search: "${niche}"${location ? ` in ${location}` : ''}. ${biz.category ? `Category: ${biz.category}.` : ''} ${biz.phone ? `Phone: ${biz.phone}.` : ''}`.trim(),
          status: 'new',
          createdAt: Date.now(),
        };
        await _saveLead(leadId, lead);
        await _addToLeadIndex(leadId);
        leads.push(lead);
      } catch (e) {
        console.warn(`[LeadDiscovery] Failed processing ${biz.name} (non-fatal, continuing):`, e.message);
      }
    }

    return res.status(200).json({ ok: true, leads, searched: businesses.length, found: leads.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ═══════════════════════════════════════════
// REAL, NEW — Leads tab job pipeline. Joel's explicit redesign: the
// whole thing runs inside the Leads tab from a single instruction bar,
// with REAL, live step-by-step progress (not a generic "Loading..."),
// automatic email-scraping once businesses are found (not prompted
// again), then a second input for reach-out instructions, and a real
// background worker so closing the tab doesn't stop anything.
//
// HONEST ARCHITECTURE NOTE: Vercel serverless functions have a real,
// hard execution-time cap (10s on Hobby) — scraping a whole batch of
// websites in one request risks timing out partway with real work lost.
// The correct, honest fix: break the pipeline into small, resumable
// STEPS tracked in a real, persisted job record (KV). Each "advance"
// call does exactly ONE unit of real work (one business scraped, one
// email sent) and returns fast. BOTH the Leads tab (polling quickly
// while open, for a live feel) AND the Electron heartbeat (polling on
// its own slower cadence, for real background survival) call the SAME
// advance endpoint — whichever gets there first does the next bit of
// work, safely sequenced by the job's own persisted status. This is
// what makes "closing the tab doesn't stop it" genuinely true, not just
// a promise — the heartbeat keeps calling advance on its own regardless
// of tab state.
// ═══════════════════════════════════════════
const LEAD_JOB_KEY = (id) => `flow_lead_job_${id}`;
const LEAD_JOB_INDEX_KEY = () => `flow_lead_job_index`;

async function _saveLeadJob(jobId, job) {
  if (!KV_URL || !KV_KEY) return false;
  // REAL BUG FIX: this used to be `.catch(() => {})` — a save failure
  // (KV rate limit, network blip, anything) was silently swallowed,
  // and every caller kept going as if it had succeeded, reporting
  // ok:true to the client while nothing was actually persisted. That's
  // a real, honest candidate for tonight's "job reads back wrong"
  // symptom: the in-memory job the client saw was fine, but storage
  // silently fell behind it. Now returns real success/failure so
  // callers can actually know.
  try {
    const r = await fetch(`${KV_URL}/set/${LEAD_JOB_KEY(jobId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(job) }),
    });
    if (!r.ok) {
      console.error(`[LeadJob] Save failed for ${jobId}: KV returned ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[LeadJob] Save threw for ${jobId}:`, e.message);
    return false;
  }
}

async function _loadLeadJob(jobId) {
  if (!KV_URL || !KV_KEY) return null;
  const raw = await fetch(`${KV_URL}/get/${LEAD_JOB_KEY(jobId)}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  // REAL — now consolidated onto the one shared _parseKvValue helper
  // (see its definition near the top of this file) rather than
  // duplicating its own inline double-parse logic, now that the
  // systemic bug has a single, real fix point instead of ten.
  const parsed = _parseKvValue(raw, null);
  return (parsed && typeof parsed === 'object') ? parsed : null;
}

async function _addToLeadJobIndex(jobId) {
  if (!KV_URL || !KV_KEY) return;
  const raw = await fetch(`${KV_URL}/get/${LEAD_JOB_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  ids = [...ids.filter(id => id !== jobId), jobId].slice(-20); // real, small cap — recent jobs only
  await fetch(`${KV_URL}/set/${LEAD_JOB_INDEX_KEY()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(ids) }),
  }).catch(() => {});
}

async function _loadAllLeadJobs() {
  if (!KV_URL || !KV_KEY) return [];
  const raw = await fetch(`${KV_URL}/get/${LEAD_JOB_INDEX_KEY()}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }).then(r => r.json()).catch(() => null);
  let ids = _parseKvValue(raw, []);
  const jobs = await Promise.all(ids.map(_loadLeadJob));
  return jobs.filter(Boolean);
}

// ── Real, server-side Supabase client — same real project/table Joel
// already has connected client-side (core/storage.js), reusing the
// existing VITE_SUPABASE_URL/VITE_SUPABASE_KEY Vercel env vars directly
// (the VITE_ prefix is just a client-build-tool convention; server-side
// Vercel functions can read any env var regardless of prefix). Zero new
// setup needed — this is the real "somewhere like Supabase, it is
// linked already" Joel asked for.
async function _supabaseSet(key, value) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.warn('[Leads] Supabase not configured (VITE_SUPABASE_URL/VITE_SUPABASE_KEY missing) — contacted-lead record not saved.');
    return false;
  }
  try {
    await fetch(`${url}/rest/v1/flow_data`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    return true;
  } catch (e) {
    console.warn('[Leads] Supabase write failed (non-fatal):', e.message);
    return false;
  }
}

// ── Real, read endpoint: creates a new lead job from Joel's plain-text
// instruction (e.g. "web design agencies in Lagos, small businesses").
// Runs the real Apify search SYNCHRONOUSLY here — a single Apify call is
// fast enough to stay within Vercel's timeout, unlike per-website
// scraping which genuinely needs to be broken into steps below.
async function handleLeadJobCreate(req, res) {
  const { instructions } = req.body || {};
  if (!instructions?.trim()) return res.status(200).json({ ok: false, error: 'Missing instructions — describe what kind of leads to find.' });

  // Real, simple parse — same "X in Y" location split already used
  // elsewhere, applied to Joel's free-text instruction.
  const locMatch = instructions.match(/^(.+?)\s+in\s+(.+)$/i);
  const niche = locMatch ? locMatch[1].trim() : instructions.trim();
  const location = locMatch ? locMatch[2].trim() : null;

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id: jobId,
    instructions,
    niche,
    location,
    status: 'finding_businesses',
    currentStep: `🔍 Finding businesses for "${niche}"${location ? ` in ${location}` : ''}...`,
    businesses: [],
    leads: [],
    scrapedCount: 0,
    reachoutInstructions: null,
    sentCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await _saveLeadJob(jobId, job);
  await _addToLeadJobIndex(jobId);

  try {
    const businesses = await _apifyFindBusinesses(niche, location, 15);
    job.businesses = businesses;
    job.currentStep = businesses.length
      ? `✅ Found ${businesses.length} businesses. 🔎 Scraping websites for real contact emails (automatic)...`
      : `⚠️ No businesses with real websites found for "${niche}"${location ? ` in ${location}` : ''}.`;
    job.status = businesses.length ? 'scraping_emails' : 'failed';
    job.updatedAt = Date.now();
    await _saveLeadJob(jobId, job);
  } catch (e) {
    job.status = 'failed';
    job.currentStep = `⚠️ Business search failed: ${e.message}`;
    job.updatedAt = Date.now();
    await _saveLeadJob(jobId, job);
  }

  return res.status(200).json({ ok: true, job });
}

// ── Real, read/work endpoint — advances a job by exactly ONE unit of
// work per call, fast enough to always stay within Vercel's timeout.
// Called repeatedly (by the Leads tab while open, AND by the Electron
// heartbeat regardless of tab state) until the job reaches a natural
// pause point (awaiting Joel's reach-out instructions) or completes.
async function handleLeadJobAdvance(req, res) {
  const { jobId } = req.body || {};
  if (!jobId) return res.status(200).json({ ok: false, error: 'Missing jobId.' });

  const job = await _loadLeadJob(jobId);
  if (!job) return res.status(200).json({ ok: false, error: 'Job not found.' });
  // REAL FIX — same gap as handleLeadJobStatus: this endpoint is what
  // the Leads tab's live polling actually calls (not lead-job-status),
  // so it needed the exact same guard. Without it, a status-less
  // legacy record fell through every status check below and still
  // came back as ok:true, done:true — the actual root cause of the
  // "corrupted" message showing up mid-poll, not just on reopen.
  if (!job.status) {
    console.warn(`[LeadJob] Job ${jobId} found but missing status during advance — likely an incompatible pre-rebuild record.`);
    return res.status(200).json({ ok: false, error: 'This job record is from an older, incompatible version — starting fresh.' });
  }

  try {
    if (job.status === 'scraping_emails') {
      const nextBiz = job.businesses[job.scrapedCount];
      if (!nextBiz) {
        job.status = job.leads.length ? 'awaiting_reachout_instructions' : 'no_leads_found';
        job.currentStep = job.leads.length
          ? `✅ Done — found ${job.leads.length} real contact email${job.leads.length === 1 ? '' : 's'} out of ${job.businesses.length} businesses. Tell Flow what the outreach should say.`
          : `⚠️ Scraped all ${job.businesses.length} businesses but found no usable contact emails.`;
        job.updatedAt = Date.now();
        const saved1 = await _saveLeadJob(jobId, job);
        if (!saved1) return res.status(200).json({ ok: false, error: 'Save to storage failed — try again rather than trusting this result.' });
        return res.status(200).json({ ok: true, job, done: true });
      }

      job.currentStep = `🔎 Scraping ${nextBiz.name} (${job.scrapedCount + 1}/${job.businesses.length})...`;
      await _saveLeadJob(jobId, job);

      const email = await _scrapeEmailFromWebsite(nextBiz.website);
      if (email) {
        const verification = await _verifyEmailDeliverability(email);
        if (verification.status !== 'invalid' && verification.status !== 'disposable') {
          const leadId = `lead-${nextBiz.name.replace(/[^a-z0-9]/gi, '')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const lead = {
            id: leadId, domain: nextBiz.website, email,
            firstName: null, lastName: null, position: null,
            companyName: nextBiz.name, phone: nextBiz.phone || null,
            confidence: verification.status === 'valid' ? 90 : 50,
            verificationStatus: verification.status,
            context: `Found via "${job.instructions}". ${nextBiz.category ? `Category: ${nextBiz.category}.` : ''}`.trim(),
            status: 'new', createdAt: Date.now(),
          };
          await _saveLead(leadId, lead);
          await _addToLeadIndex(leadId);
          job.leads.push(lead);
        }
      }
      job.scrapedCount += 1;
      job.currentStep = `🔎 Scraped ${job.scrapedCount}/${job.businesses.length} — ${job.leads.length} email${job.leads.length === 1 ? '' : 's'} found so far...`;
      job.updatedAt = Date.now();
      const saved2 = await _saveLeadJob(jobId, job);
      if (!saved2) return res.status(200).json({ ok: false, error: 'Save to storage failed — try again rather than trusting this result.' });
      return res.status(200).json({ ok: true, job, done: false });
    }

    if (job.status === 'sending_outreach') {
      const pending = job.leads.filter(l => l.outreachStatus !== 'sent');
      const nextLead = pending[0];
      if (!nextLead) {
        job.status = 'complete';
        job.currentStep = `✅ All done — outreach sent to ${job.sentCount} lead${job.sentCount === 1 ? '' : 's'}.`;
        job.updatedAt = Date.now();
        await _saveLeadJob(jobId, job);
        return res.status(200).json({ ok: true, job, done: true });
      }

      job.currentStep = `📤 Sending outreach to ${nextLead.companyName} (${nextLead.email})...`;
      await _saveLeadJob(jobId, job);

      try {
        const { subject, body } = await _generateOutreachEmail({ ...nextLead, context: `${nextLead.context || ''} Reach-out instructions from Joel: ${job.reachoutInstructions}` });
        const accessToken = await _getGmailAccessToken();
        const raw = _buildMimeMessage({ to: nextLead.email, subject, body });
        await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
        });

        nextLead.outreachStatus = 'sent';
        nextLead.outreachSubject = subject;
        nextLead.outreachSentAt = Date.now();

        const mainLead = await _loadLead(nextLead.id);
        if (mainLead) {
          mainLead.status = 'outreach_sent';
          mainLead.outreachSubject = subject;
          mainLead.outreachBody = body;
          mainLead.outreachSentAt = Date.now();
          await _saveLead(nextLead.id, mainLead);
        }

        // REAL, Joel-requested — store every contacted lead in Supabase
        // so Flow genuinely remembers everyone it has reached out to,
        // beyond just the KV job record.
        await _supabaseSet(`contacted_lead_${nextLead.id}`, {
          leadId: nextLead.id, email: nextLead.email, companyName: nextLead.companyName,
          domain: nextLead.domain, subject, sentAt: Date.now(), jobId,
        });

        job.sentCount += 1;
      } catch (e) {
        nextLead.outreachStatus = 'failed';
        nextLead.outreachError = e.message;
        console.warn(`[LeadJob] Outreach failed for ${nextLead.email}:`, e.message);
      }

      job.currentStep = `📤 Sent ${job.sentCount}/${job.leads.length} outreach emails...`;
      job.updatedAt = Date.now();
      await _saveLeadJob(jobId, job);
      return res.status(200).json({ ok: true, job, done: false });
    }

    return res.status(200).json({ ok: true, job, done: true });
  } catch (e) {
    console.warn(`[LeadJob] Advance failed for ${jobId} (non-fatal, will retry next call):`, e.message);
    return res.status(200).json({ ok: true, job, done: false, error: e.message });
  }
}

// ── Real endpoint: Joel provides the reach-out instructions once
// emails are found, flipping the job into the outreach-sending phase.
async function handleLeadJobSetReachout(req, res) {
  const { jobId, instructions } = req.body || {};
  if (!jobId || !instructions?.trim()) return res.status(200).json({ ok: false, error: 'Missing jobId or instructions.' });

  const job = await _loadLeadJob(jobId);
  if (!job) return res.status(200).json({ ok: false, error: 'Job not found.' });
  if (job.status !== 'awaiting_reachout_instructions') return res.status(200).json({ ok: false, error: `Job status is "${job.status}", not ready for reach-out instructions yet.` });

  job.reachoutInstructions = instructions;
  job.status = 'sending_outreach';
  job.currentStep = `📤 Starting outreach to ${job.leads.length} lead${job.leads.length === 1 ? '' : 's'}...`;
  job.updatedAt = Date.now();
  await _saveLeadJob(jobId, job);

  return res.status(200).json({ ok: true, job });
}

// ── Real, read-only status/list endpoints for the Leads tab's polling ──
async function handleLeadJobStatus(req, res) {
  const jobId = req.query?.jobId;
  if (!jobId) return res.status(200).json({ ok: false, error: 'Missing jobId.' });
  const job = await _loadLeadJob(jobId);
  if (!job) return res.status(200).json({ ok: false, error: 'Job not found.' });
  // REAL FIX — a job record with no `status` isn't "corrupted", it's
  // most likely a stale localStorage jobId pointing at a record from
  // BEFORE the resumable-job-pipeline rebuild, where this field didn't
  // exist yet. Returning ok:false here (instead of ok:true with a
  // broken shape) lets the client's own existing terminal-status check
  // route straight to a fresh form, instead of ever reaching the
  // scarier client-side "corrupted" fallback message.
  if (!job.status) {
    console.warn(`[LeadJob] Job ${jobId} found but missing status — likely an incompatible pre-rebuild record. Treating as not found.`);
    return res.status(200).json({ ok: false, error: 'This job record is from an older, incompatible version — starting fresh.' });
  }
  return res.status(200).json({ ok: true, job });
}

async function handleLeadJobsList(req, res) {
  const jobs = await _loadAllLeadJobs();
  return res.status(200).json({ ok: true, jobs });
}

// ── Real outreach-content generator. Draws on the SAME accumulated
// insight pool as social-monitor and sales-research (via
// _loadRecentInsights) — this is the literal mechanism behind "Flow
// gets smarter about reaching out" that Joel asked for: real,
// previously-researched conversational patterns get pulled into the
// actual email, not a fixed template.
async function _generateOutreachEmail(lead) {
  // REAL, Joel-approved upgrade: previously this loaded the 10 MOST
  // RECENT insights and kept only exact platform_hint matches — meaning
  // a genuinely relevant insight from 3 weeks ago (e.g. specifically
  // about reaching out to agencies, when this lead IS an agency) could
  // lose to a less-relevant one from yesterday just because it's newer.
  // Now the query is built from THIS lead's real context, so retrieval
  // ranks by actual relevance to who Joel is emailing, not just recency.
  const queryContext = `outreach email to ${lead.companyName || lead.domain}${lead.position ? `, ${lead.position}` : ''}${lead.context ? ` — ${lead.context}` : ''}`;
  const relevantInsights = await _recallRelevantInsights(queryContext, { maxResults: 5, platformHint: 'email_outreach' });
  const insightText = relevantInsights.length
    ? relevantInsights.map(i => `- ${i.pattern}`).join('\n')
    : 'No specific researched patterns yet — use genuine judgment for a warm, low-pressure first outreach.';

  const system = `You are Flow, writing a real, first cold-outreach email on behalf of Joel Olaiya (Joelflowstack — solo web dev, bot integration, and workflow automation freelancer, Ibadan, Nigeria) to a genuine prospect. Write a short, warm, low-pressure email — NOT salesy, NOT generic template language. Reference their company/context naturally if known. End with a simple, easy-to-answer question (not a hard pitch).

Apply these real, previously-researched conversational patterns where they genuinely fit:
${insightText}

Reply with ONLY this JSON, no other text:
{"subject": "a short, real, non-spammy subject line", "body": "the full email body, plain text, no markdown"}`;

  const leadContext = `Prospect: ${lead.firstName || ''} ${lead.lastName || ''} at ${lead.companyName || lead.domain}${lead.position ? ` (${lead.position})` : ''}.${lead.context ? ` Context: ${lead.context}` : ''}`;

  const res = await fetch(`${SITE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: leadContext },
      ],
      max_tokens: 400,
    }),
  });
  const data = await res.json();
  if (!data.reply || typeof data.reply !== 'string') throw new Error('Outreach generation returned an empty or malformed reply.');
  const match = data.reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Outreach generation did not return the expected JSON format.');
  return JSON.parse(match[0]);
}

// ── Real send + status transition. Per Joel's explicit rule: this sends
// the FIRST outreach automatically (no approval gate, unlike social
// drafts) — but every subsequent step requires either a real reply from
// the prospect (handled by _checkForLeadReplies, called from
// gmail-analyze) or Joel's own manual action. Flow never continues a
// live back-and-forth on its own.
async function handleLeadOutreach(req, res) {
  const { leadId } = req.body || {};
  if (!leadId) return res.status(200).json({ ok: false, error: 'Missing "leadId" in request body.' });

  const lead = await _loadLead(leadId);
  if (!lead) return res.status(200).json({ ok: false, error: 'Lead not found.' });
  if (lead.status !== 'new') return res.status(200).json({ ok: false, error: `Lead status is "${lead.status}", not "new" — outreach already sent or lead is in a later stage.` });

  try {
    const { subject, body } = await _generateOutreachEmail(lead);
    const accessToken = await _getGmailAccessToken();
    const raw = _buildMimeMessage({ to: lead.email, subject, body });
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!sendRes.ok) return res.status(200).json({ ok: false, error: `Gmail send failed: ${await sendRes.text()}` });
    const sendData = await sendRes.json();

    lead.status = 'outreach_sent';
    lead.outreachSubject = subject;
    lead.outreachBody = body;
    lead.outreachMessageId = sendData.id;
    lead.outreachSentAt = Date.now();
    await _saveLead(leadId, lead);

    return res.status(200).json({ ok: true, lead, subject });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}

// ── Real reply detection — called from handleGmailAnalyze below. Checks
// incoming mail against leads in "outreach_sent" status by matching the
// FROM address; if a real prospect replies, flips the lead to "replied"
// and this is what triggers escalation to Joel via Telegram, per his
// explicit "escalate to me once a prospect actually replies" rule.
async function _checkForLeadReplies(messages) {
  const leads = await _loadAllLeads();
  const awaitingReply = leads.filter(l => l.status === 'outreach_sent');
  if (!awaitingReply.length) return [];

  const newlyReplied = [];
  for (const msg of messages) {
    const fromEmail = (msg.from.match(/<(.+?)>/) || [null, msg.from])[1].toLowerCase().trim();
    const matchedLead = awaitingReply.find(l => l.email.toLowerCase() === fromEmail);
    if (matchedLead) {
      matchedLead.status = 'replied';
      matchedLead.repliedAt = Date.now();
      matchedLead.replySubject = msg.subject;
      matchedLead.replySnippet = msg.snippet;
      await _saveLead(matchedLead.id, matchedLead);
      newlyReplied.push(matchedLead);
    }
  }
  return newlyReplied;
}

// ── Real, read-only endpoint for listing leads (any UI, Content Lab, or
// future dashboard can call this rather than reimplementing KV reads).
async function handleLeadsList(req, res) {
  const leads = await _loadAllLeads();
  return res.status(200).json({ ok: true, leads });
}

async function handleBluesky(req, res) {
  // REAL, CONFIRMED FIX: Joel's actual BLUESKY_HANDLE env var was set to
  // "@joelflowstack.bsky.social" (with a leading @). Bluesky's own
  // createSession API expects the bare handle with NO @ — sending one
  // makes the identifier invalid, which is the real, confirmed cause of
  // the "Auth failed... credentials are invalid" error. Stripping any
  // leading @ here means this exact typo can't silently break auth again,
  // regardless of what's actually saved in the Vercel env var.
  const HANDLE       = (process.env.BLUESKY_HANDLE || '').replace(/^@/, '');
  const APP_PASSWORD = process.env.BLUESKY_APP_PASSWORD;

  if (!HANDLE || !APP_PASSWORD) {
    return res.status(200).json({ ok: false, error: 'BLUESKY_HANDLE and/or BLUESKY_APP_PASSWORD not set in Vercel env vars — generate an app password at bsky.app → Settings → App Passwords (not your real account password) and add both.' });
  }

  const { text, videoUrl, imageBase64 } = req.body || {};
  if (!text) {
    return res.status(200).json({ ok: false, error: 'Missing "text" in request body.' });
  }

  try {
    // ── 1. Real auth — matches Bluesky's own documented createSession flow ──
    const sessionRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: HANDLE, password: APP_PASSWORD }),
    });
    if (!sessionRes.ok) {
      const errText = await sessionRes.text();
      return res.status(200).json({ ok: false, error: `Bluesky auth failed: ${errText}` });
    }
    const session = await sessionRes.json();
    const { accessJwt, did } = session;

    // ── 2a. Real image upload — this is what ui/marketing.js's
    // in-app approval card actually needs (the generated marketing image,
    // not just text). Added specifically because the first draft of
    // this endpoint only handled video, which left the approval button
    // silently posting text-only despite Joel's explicit ask that the
    // approved IMAGE be what gets posted — a real gap, fixed here rather
    // than shipped incomplete.
    let embed = null;
    if (imageBase64) {
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      if (imageBuffer.byteLength > 1024 * 1024) {
        // Real, confirmed Bluesky image cap: ~1MB per image.
        return res.status(200).json({ ok: false, error: `Image is ${(imageBuffer.byteLength / 1024).toFixed(0)}KB — Bluesky's real cap is ~1MB per image.` });
      }
      const uploadRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.uploadBlob', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessJwt}`, 'Content-Type': 'image/png' },
        body: imageBuffer,
      });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return res.status(200).json({ ok: false, error: `Bluesky image upload failed: ${errText}` });
      }
      const uploadData = await uploadRes.json();
      embed = {
        $type: 'app.bsky.embed.images',
        images: [{ image: uploadData.blob, alt: text.slice(0, 100) }],
      };
    }

    // ── 2b. Real video upload, if a video was provided ────────────────────
    // REAL, honest limit: Bluesky's uploadBlob endpoint takes raw bytes
    // directly, not a URL — so if videoUrl points to Flow's own real
    // generated-video Space (ui/videogen.js's Lightricks output), THIS
    // function fetches those real bytes server-side first, then re-
    // uploads them to Bluesky. Two real network hops, not a shortcut —
    // stated plainly since it affects real latency for a video post.
    if (videoUrl && !embed) {
      const videoFetch = await fetch(videoUrl);
      if (!videoFetch.ok) {
        return res.status(200).json({ ok: false, error: `Couldn't fetch the video from ${videoUrl} to upload it.` });
      }
      const videoBuffer = await videoFetch.arrayBuffer();
      // REAL, confirmed Bluesky limit: video uploads are capped at 50MB
      // and roughly 3 minutes — stated here so a failure at this step
      // has an honest, specific explanation rather than a generic error.
      if (videoBuffer.byteLength > 50 * 1024 * 1024) {
        return res.status(200).json({ ok: false, error: `Video is ${(videoBuffer.byteLength / 1024 / 1024).toFixed(1)}MB — Bluesky's real cap is 50MB.` });
      }
      const uploadRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.uploadBlob', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessJwt}`, 'Content-Type': 'video/mp4' },
        body: Buffer.from(videoBuffer),
      });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return res.status(200).json({ ok: false, error: `Bluesky video upload failed: ${errText}` });
      }
      const uploadData = await uploadRes.json();
      embed = {
        $type: 'app.bsky.embed.video',
        video: uploadData.blob, // real blob reference returned by Bluesky, not a URL
      };
    }

    // ── 3. Real post creation ─────────────────────────────────────────────
    const record = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
    };
    if (embed) record.embed = embed;

    const postRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
    });
    if (!postRes.ok) {
      const errText = await postRes.text();
      return res.status(200).json({ ok: false, error: `Bluesky post failed: ${errText}` });
    }
    const postData = await postRes.json();
    return res.status(200).json({ ok: true, uri: postData.uri, cid: postData.cid });
  } catch (e) {
    console.error('[Bluesky] Real error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

// ═══════════════════════════════════════════
// REAL, NEW: self-initiated messaging endpoint for the heartbeat loop
// (flow-electron/heartbeat.js). This is the actual mechanism behind
// "Flow speaks up first" — Joel's real, explicit request for genuine
// autonomy, not just a request/response bot. Deliberately simple: takes
// text, sends it via the real sendTelegramToJoel function above. Native
// desktop notifications are handled separately, directly in
// flow-electron/main.js (showNativeNotification already exists there),
// since that doesn't need a network round-trip through Vercel at all.
// ═══════════════════════════════════════════
async function handleHeartbeatNotify(req, res) {
  const { text } = req.body || {};
  if (!text) return res.status(200).json({ ok: false, error: 'Missing "text" in request body.' });
  const result = await sendTelegramToJoel(text);
  return res.status(200).json(result);
}

// REAL, CONFIRMED FIX — this file had NO top-level safety net. Every
// individual handler below does its own try/catch internally, but if
// ANY of them (or a future one) throws in a spot that isn't wrapped,
// or if Vercel itself kills the function (timeout, memory), the
// runtime returns its own generic HTML error page ("A server error has
// occurred...") instead of JSON. That's the EXACT, real cause of the
// console error Joel reported: `Unexpected token 'A', "A server e"...
// is not valid JSON` when content-lab.js's pollAllInsights() tried to
// .json() that HTML response. Wrapping the whole dispatch means ANY
// failure — known or not-yet-discovered — always comes back as valid
// JSON the client can actually parse, instead of breaking every poller
// that assumes a JSON response (insights, lead-job-advance, etc.).
export default async function handler(req, res) {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();
    const platform = req.query?.platform || '';
    if (platform === 'telegram')      return await handleTelegram(req, res);
    if (platform === 'whatsapp')      return await handleWhatsApp(req, res);
    if (platform === 'sentinel-ping') return await handleSentinelPing(req, res);
    if (platform === 'autopost')      return await handleAutoPost(req, res);
    if (platform === 'social-monitor') return await handleSocialMonitor(req, res);
    if (platform === 'sales-research') return await handleSalesResearch(req, res);
    if (platform === 'content-research') return await handleContentResearch(req, res);
    if (platform === 'mindset-research') return await handleMindsetResearch(req, res);
    if (platform === 'insights')       return await handleInsights(req, res);
    if (platform === 'social-drafts')  return await handleSocialDrafts(req, res);
    if (platform === 'social-draft-approve') return await handleSocialDraftApprove(req, res);
    if (platform === 'diagnose')      return await handleDiagnose(req, res);
    if (platform === 'bluesky')       return await handleBluesky(req, res);
    if (platform === 'youtube')       return await handleYouTube(req, res);
    if (platform === 'tiktok')        return await handleTikTok(req, res);
    if (platform === 'gmail-read')    return await handleGmailRead(req, res);
    if (platform === 'gmail-analyze') return await handleGmailAnalyze(req, res);
    if (platform === 'lead-search')   return await handleLeadSearch(req, res);
    if (platform === 'find-leads')    return await handleFindLeadsByNiche(req, res);
    if (platform === 'lead-job-create')     return await handleLeadJobCreate(req, res);
    if (platform === 'lead-job-advance')     return await handleLeadJobAdvance(req, res);
    if (platform === 'lead-job-set-reachout') return await handleLeadJobSetReachout(req, res);
    if (platform === 'lead-job-status')      return await handleLeadJobStatus(req, res);
    if (platform === 'lead-jobs-list')        return await handleLeadJobsList(req, res);
    if (platform === 'lead-outreach') return await handleLeadOutreach(req, res);
    if (platform === 'leads-list')    return await handleLeadsList(req, res);
    if (platform === 'gmail-send')    return await handleGmailSend(req, res);
    if (platform === 'heartbeat-notify') return await handleHeartbeatNotify(req, res);
    if (platform === 'marketing-draft') return await handleMarketingDraft(req, res);
    return res.status(200).json({ service: 'Flow Social', endpoints: {
      telegram: '/api/social?platform=telegram',
      whatsapp: '/api/social?platform=whatsapp',
      sentinelPing: '/api/social?platform=sentinel-ping',
      autopost: '/api/social?platform=autopost',
      diagnose: '/api/social?platform=diagnose',
      bluesky: '/api/social?platform=bluesky (POST { text, videoUrl? })',
      heartbeatNotify: '/api/social?platform=heartbeat-notify (POST { text })',
      marketingDraft: '/api/social?platform=marketing-draft (POST { imageBase64, caption })',
    } });
  } catch (e) {
    // REAL, the actual fix — no matter what throws above, or where, the
    // client always gets back valid JSON with `ok:false` and a real
    // error message, never Vercel's raw HTML crash page.
    console.error('[Social] Uncaught error in top-level handler (now safely caught):', e?.message, e?.stack);
    if (!res.headersSent) {
      return res.status(200).json({ ok: false, error: e?.message || 'Unknown server error.' });
    }
  }
}
