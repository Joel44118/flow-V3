// core/feedback.js — RLHF-style feedback system
// Thumbs up/down on any Flow response
// Stores corrections in localStorage → injected into every prompt
// Gives Flow memory of what you liked and didn't like

import { Storage } from './storage.js';
import { awardCorrectionXp } from './leveling.js';

const FEEDBACK_KEY = 'flow_feedback_v1';
const MAX_FEEDBACK = 40;  // keep last 40 corrections

let _chatAddFn = null;

export function initFeedback(Chat) {
  _chatAddFn = (t, r) => Chat.add(t, r);

  // Wire thumbs up/down to every bot message via event delegation
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-feedback]');
    if (!btn) return;
    const wrap = btn.closest('.mwrap');
    if (!wrap) return;
    const bubbleEl = wrap.querySelector('.mbubble');
    if (!bubbleEl) return;

    const type    = btn.dataset.feedback;  // 'up' or 'down'
    const msgText = bubbleEl.textContent?.trim().slice(0, 400) || '';
    const userMsg = _getLastUserMsg(wrap);

    _recordFeedback(type, userMsg, msgText);

    // Visual feedback
    btn.textContent = type === 'up' ? '👍✓' : '👎✓';
    btn.style.color = type === 'up' ? '#4ade80' : '#f87171';
    btn.disabled    = true;

    if (type === 'down') {
      // Ask for correction
      _chatAddFn?.('What should I have said instead? (or just say "wrong topic" to flag it)', 'bot');
      window._flowAwaitingCorrection = { userMsg, badResponse: msgText };
    }
  });

  // Intercept correction replies
  document.addEventListener('flow:usersend', (e) => {
    const text = e.detail?.text;
    if (window._flowAwaitingCorrection && text) {
      const { userMsg, badResponse } = window._flowAwaitingCorrection;
      window._flowAwaitingCorrection = null;
      _recordCorrection(userMsg, badResponse, text);
      _chatAddFn?.("Got it, Boss. I'll do better with that next time.", 'bot');
    }
  });
}

function _getLastUserMsg(botWrap) {
  // Walk backwards through sibling messages to find the last user bubble
  let el = botWrap.previousElementSibling;
  while (el) {
    if (el.classList.contains('mwrap')) {
      const bubble = el.querySelector('.muser');
      if (bubble) return bubble.textContent?.trim().slice(0, 200) || '';
    }
    el = el.previousElementSibling;
  }
  return '';
}

function _recordFeedback(type, userMsg, botMsg) {
  const all = Storage.get(FEEDBACK_KEY, []);
  all.push({
    type,
    userMsg,
    botMsg: botMsg.slice(0, 200),
    ts: Date.now(),
  });
  Storage.set(FEEDBACK_KEY, all.slice(-MAX_FEEDBACK));
  console.log(`[Flow Feedback] ${type}:`, userMsg.slice(0, 50));
}

function _recordCorrection(userMsg, badResponse, correction) {
  const all = Storage.get(FEEDBACK_KEY, []);
  all.push({
    type:       'correction',
    userMsg,
    botMsg:     badResponse.slice(0, 200),
    correction: correction.slice(0, 400),
    ts:         Date.now(),
  });
  Storage.set(FEEDBACK_KEY, all.slice(-MAX_FEEDBACK));
  awardCorrectionXp(userMsg);
}

// Called by ai.js to inject feedback context into prompts
export function getFeedbackContext() {
  const all = Storage.get(FEEDBACK_KEY, []);
  if (!all.length) return '';

  const corrections = all.filter(f => f.type === 'correction').slice(-8);
  const dislikes    = all.filter(f => f.type === 'down').slice(-6);
  const likes       = all.filter(f => f.type === 'up').slice(-4);

  const lines = [];

  if (corrections.length) {
    lines.push('CORRECTIONS FROM JOEL (high priority — learn from these):');
    corrections.forEach(c => {
      lines.push(`  When Joel said: "${c.userMsg}"`);
      lines.push(`  My wrong response was about: "${c.botMsg.slice(0, 80)}"`);
      lines.push(`  Correct response: "${c.correction}"`);
    });
  }

  if (dislikes.length) {
    lines.push('RESPONSES JOEL DISLIKED (avoid these patterns):');
    dislikes.forEach(d => {
      if (d.userMsg) lines.push(`  Context: "${d.userMsg.slice(0, 80)}" → Bad: "${d.botMsg.slice(0, 80)}"`);
    });
  }

  if (likes.length) {
    lines.push('RESPONSES JOEL LIKED (do more of this):');
    likes.forEach(l => {
      if (l.botMsg) lines.push(`  "${l.botMsg.slice(0, 80)}"`);
    });
  }

  return lines.length ? lines.join('\n') : '';
}

export function getAllFeedback() {
  return Storage.get(FEEDBACK_KEY, []);
}

export function clearFeedback() {
  Storage.set(FEEDBACK_KEY, []);
}
