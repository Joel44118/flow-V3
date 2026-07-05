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
const SITE      = 'https://flow-v3-mu.vercel.app';

// ── Shared: per-chat conversation history in KV ───────────────────────────
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
    return Array.isArray(d?.result) ? d.result : [];
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
    const cur = r.ok ? ((await r.json()).result || []) : [];
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
      const cur = await (async () => { try { const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_KEY}` } }); return r.ok ? ((await r.json()).result || 0) : 0; } catch(_) { return 0; } })();
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
async function handlePendingApprovalReply(tgFetch, tgFetchStrict, chatId, text) {
  if (!KV_URL || !KV_KEY) return false;

  let pending;
  try {
    const r = await fetch(`${KV_URL}/get/flow_pending_post`, { headers: { Authorization: `Bearer ${KV_KEY}` } });
    const d = await r.json();
    pending = d.result || null;
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const platform = req.query?.platform || '';
  if (platform === 'telegram')      return handleTelegram(req, res);
  if (platform === 'whatsapp')      return handleWhatsApp(req, res);
  if (platform === 'sentinel-ping') return handleSentinelPing(req, res);
  if (platform === 'autopost')      return handleAutoPost(req, res);
  if (platform === 'diagnose')      return handleDiagnose(req, res);
  return res.status(200).json({ service: 'Flow Social', endpoints: {
    telegram: '/api/social?platform=telegram',
    whatsapp: '/api/social?platform=whatsapp',
    sentinelPing: '/api/social?platform=sentinel-ping',
    autopost: '/api/social?platform=autopost',
    diagnose: '/api/social?platform=diagnose',
  } });
}
