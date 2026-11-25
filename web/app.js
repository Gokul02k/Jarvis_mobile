import { PROVIDERS, chat, cleanKey, explainError, hasCredentials, listModels, modelOf, pickModel, providerOf, serverBase } from './llm.js';
import { toolsFor, runTool, initScheduler, activeTimers, store } from './tools.js';
import { createBuddy } from './buddy.js';
import { NATIVE, IS_BUBBLE, NativeSpeechRecognition, nativeSpeak, nativeStopSpeaking, nativeSync } from './native.js';
import { initUpdates, refreshAbout } from './update.js';
import { runLocal, BUILTINS, TEMPLATES } from './commands.js';

if (IS_BUBBLE) document.documentElement.classList.add('bubble-mode');
if (NATIVE) document.documentElement.classList.add('in-app');

// ------------------------------------------------------------------ settings

const DEFAULTS = {
  provider: 'gemini',
  connection: 'auto',
  geminiKey: '', geminiModel: 'gemini-2.5-flash',
  xaiKey: '', grokModel: '',
  openaiKey: '', openaiModel: '', claudeKey: '', claudeModel: '',
  groqKey: '', groqModel: '', openrouterKey: '', openrouterModel: '',
  deepseekKey: '', deepseekModel: '', mistralKey: '', mistralModel: '',
  customUrl: '', customKey: '', customModel: '',
  ojUrl: '', ojKey: '', ojModel: '',
  fallbackProviders: true,
  localCommands: true, customCommands: [],
  serverToken: '',
  wakeWord: 'jarvis',
  lang: navigator.language || 'en-US',
  voiceURI: '', rate: 1.05, speak: true, followUp: true,
  userName: '', contacts: '', musicApp: 'youtube', autoOpen: true,
  buddySound: true, serverUrl: '', autoUpdateCheck: true,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
if (!PROVIDERS[settings.provider]) settings.provider = 'gemini';
if (settings.grokModel === 'grok-4') settings.grokModel = ''; // old slow default: let Jarvis pick a fast one
const saveSettings = () => {
  const { _server, ...rest } = settings;
  store.set('settings', rest);
  // Tell the floating bubble (a separate WebView) to pick up the new settings.
  if (NATIVE && !IS_BUBBLE) NATIVE.settingsChanged();
};

// ------------------------------------------------------------------ DOM

const $ = (s) => document.querySelector(s);
const log = $('#log'), live = $('#live'), statusEl = $('#status');
const textForm = $('#text-form'), textInput = $('#text-input');
const wakeBtn = $('#btn-wake'), dialog = $('#settings');

// ------------------------------------------------------------------ the floating companion

const buddyEl = document.createElement('div');
buddyEl.id = 'buddy';
document.body.append(buddyEl);
const buddy = createBuddy(buddyEl, {
  sound: settings.buddySound,
  onTap: () => onTalk(),
  onDoubleTap: () => {
    if (IS_BUBBLE) NATIVE?.openApp();            // bubble → open the full Jarvis app
    else { textForm.hidden = false; textInput.focus(); }
  },
  onCancel: () => { stopRec(); stopSpeaking(); abort?.abort(); setState('idle'); },
  onCaption: (shown) => { if (IS_BUBBLE) NATIVE?.setExpanded(!!shown); },
  // In the Android bubble the app moves the whole window natively; here we move the element.
  onDrag: IS_BUBBLE ? null : dragBuddy,
});

// Android tells the bubble which screen edge it is docked to, so the caption opens inward.
window.__jarvisSide = (side) => buddyEl.classList.toggle('on-right', side === 'right');
window.__jarvisDrag = (phase) => { if (phase === 'start') buddy.say(''); else buddy.react('boing'); };
// Reminders fired by Android while the bubble is running: say them out loud.
window.__jarvisAlert = (title, body) => {
  buddy.react('wake');
  if (state === 'idle' || state === 'wake') {
    stopRec();
    speak(`${title}. ${body}`).then(() => { if (state === 'speaking') setState('idle'); resumeWake(); });
  }
};
// Native "tap to talk" from the notification / quick-settings tile.
window.__jarvisTalk = () => onTalk();

let dragFrom = null;
function placeBuddy(x, y, snap) {
  const size = buddyEl.offsetWidth || 68;
  const maxX = window.innerWidth - size - 8, maxY = window.innerHeight - size - 8;
  x = Math.max(8, Math.min(maxX, x));
  y = Math.max(8 + (document.querySelector('.top')?.offsetHeight || 0), Math.min(maxY, y));
  if (snap) x = x + size / 2 < window.innerWidth / 2 ? 8 : maxX;
  buddyEl.classList.toggle('snap', !!snap);
  buddyEl.style.left = `${x}px`;
  buddyEl.style.top = `${y}px`;
  buddyEl.classList.toggle('on-right', x + size / 2 > window.innerWidth / 2);
  return { x, y };
}
function dragBuddy(phase, dx, dy) {
  if (!dragFrom) dragFrom = { x: buddyEl.offsetLeft, y: buddyEl.offsetTop };
  if (phase === 'move') placeBuddy(dragFrom.x + dx, dragFrom.y + dy, false);
  else {
    const pos = placeBuddy(dragFrom.x + dx, dragFrom.y + dy, true);
    store.set('buddyPos', { rx: pos.x / window.innerWidth, ry: pos.y / window.innerHeight });
    dragFrom = null;
  }
}
function restoreBuddy() {
  if (IS_BUBBLE) return;
  const p = store.get('buddyPos', null);
  const dock = document.querySelector('.dock')?.offsetHeight || 150;
  if (p) placeBuddy(p.rx * window.innerWidth, p.ry * window.innerHeight, true);
  else placeBuddy(window.innerWidth, window.innerHeight - dock - 90, true);
}
window.addEventListener('resize', restoreBuddy);
requestAnimationFrame(restoreBuddy);

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function scrollDown() { log.scrollTop = log.scrollHeight; }
function hideWelcome() { $('#welcome')?.remove(); }

function addMsg(role, text) {
  hideWelcome();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  log.append(el); scrollDown();
  return el;
}
function addTool(name, args) {
  const el = document.createElement('div');
  el.className = 'tool';
  const brief = Object.values(args || {}).filter(v => typeof v !== 'object').join(' · ');
  el.textContent = `⚙ ${name}${brief ? ' — ' + brief.slice(0, 60) : ''}`;
  log.append(el); scrollDown();
}
const ui = {
  card(title, detail, actions = []) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div class="t">${esc(title)}</div>${detail ? `<div class="d">${esc(detail)}</div>` : ''}<div class="acts"></div>`;
    const acts = el.querySelector('.acts');
    for (const a of actions) {
      if (a.href) {
        const link = document.createElement('a');
        link.href = a.href; link.textContent = a.label;
        if (/^https?:/.test(a.href)) { link.target = '_blank'; link.rel = 'noopener'; }
        acts.append(link);
      } else {
        const b = document.createElement('button');
        b.textContent = a.label; b.onclick = a.onClick;
        acts.append(b);
      }
    }
    if (!actions.length) acts.remove();
    log.append(el); scrollDown();
  },
  timersChanged: renderTimers,
};

// ------------------------------------------------------------------ state machine
// idle | wake (listening for wake word) | listening (command) | thinking | speaking

let state = 'idle';
const STATUS = { idle: 'Tap to speak', wake: `Say “${settings.wakeWord}”`, listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking — tap to stop' };
function setState(s) {
  state = s;
  buddy.setState(s);
  statusEl.textContent = s === 'wake' ? `Say “${cap(settings.wakeWord)}…”` : STATUS[s];
  if (s === 'idle' || s === 'thinking') live.textContent = '';
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

// ------------------------------------------------------------------ speech recognition

const SR = NATIVE ? NativeSpeechRecognition : (window.SpeechRecognition || window.webkitSpeechRecognition);
let rec = null;
let wakeOn = false;
let awaitingCommand = false, awaitTimer = null;
let wakeLock = null;

function stopRec() {
  if (!rec) return;
  const r = rec; rec = null;
  try { r.abort(); } catch { }
}

function startRec(mode) { // mode: 'command' | 'wake'
  if (!SR) {
    addMsg('error', 'Voice input is not supported in this browser. Use Chrome on Android (or Safari on iPhone), or type your command.');
    return;
  }
  stopRec();
  const r = new SR();
  rec = r;
  r.lang = settings.lang || 'en-US';
  r.continuous = mode === 'wake';
  r.interimResults = true;
  r.maxAlternatives = 1;
  let gotFinal = false;

  r.onresult = (e) => {
    if (rec !== r) return;
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) final += res[0].transcript; else interim += res[0].transcript;
    }
    if (mode === 'command' || awaitingCommand || containsWake(interim)) {
      live.textContent = (final || interim).trim();
      if (IS_BUBBLE && live.textContent) buddy.say(live.textContent, 0);
    }
    if (final.trim()) { gotFinal = true; onFinal(final.trim(), mode); }
  };
  r.onerror = (e) => {
    if (rec !== r) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setWake(false);
      addMsg('error', location.protocol !== 'https:' && location.hostname !== 'localhost'
        ? 'Microphone blocked: phones only allow the mic on HTTPS pages. Run the server with --https (see README).'
        : 'Microphone permission denied. Allow it in the browser site settings.');
    } else if (e.error === 'network') {
      addMsg('error', 'Speech recognition needs an internet connection.');
    }
  };
  r.onend = () => {
    if (rec !== r) return;
    rec = null;
    if (mode === 'command' && !gotFinal && state === 'listening') setState('idle');
    resumeWake();
  };
  try { r.start(); } catch { }
  setState(mode === 'wake' ? 'wake' : 'listening');
}

function containsWake(text) {
  const w = (settings.wakeWord || 'jarvis').toLowerCase();
  return text.toLowerCase().includes(w);
}

function onFinal(text, mode) {
  if (mode === 'command') { stopRec(); return handleCommand(text); }
  if (awaitingCommand) {
    clearTimeout(awaitTimer); awaitingCommand = false;
    stopRec(); return handleCommand(text);
  }
  const w = (settings.wakeWord || 'jarvis').toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.lastIndexOf(w);
  if (idx < 0) { live.textContent = ''; return; }
  const cmd = text.slice(idx + w.length).replace(/^[\s,.!?:;-]+/, '').trim();
  if (cmd.length > 1) { stopRec(); return handleCommand(cmd); }
  // Just the wake word: wait for the command.
  chime();
  awaitingCommand = true;
  setState('listening');
  live.textContent = 'Yes?';
  buddy.say('Yes?', 9000);
  clearTimeout(awaitTimer);
  awaitTimer = setTimeout(() => { awaitingCommand = false; if (state === 'listening') setState(wakeOn ? 'wake' : 'idle'); live.textContent = ''; }, 9000);
}

const visible = () => IS_BUBBLE || !document.hidden;
function resumeWake() {
  if (!wakeOn || rec || state === 'thinking' || state === 'speaking' || !visible()) return;
  setTimeout(() => { if (wakeOn && !rec && state !== 'thinking' && state !== 'speaking' && visible()) startRec('wake'); }, NATIVE ? 400 : 250);
}

async function setWake(on) {
  // While the floating bubble runs, it does the listening; the full app just flips the setting.
  if (NATIVE && !IS_BUBBLE && nativeSync('bubbleState')?.running) {
    store.set('wake', on);
    wakeBtn.setAttribute('aria-pressed', String(on));
    NATIVE.settingsChanged();
    addMsg('assistant', on ? `Wake word on: say “${cap(settings.wakeWord)}” any time, even in other apps.` : 'Wake word off.');
    return;
  }
  wakeOn = on;
  wakeBtn.setAttribute('aria-pressed', String(on));
  if (on) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
    if (state === 'idle') startRec('wake');
  } else {
    awaitingCommand = false;
    try { await wakeLock?.release(); } catch { }
    wakeLock = null;
    if (state === 'wake' || state === 'listening') { stopRec(); setState('idle'); }
  }
  store.set('wake', on);
}

document.addEventListener('visibilitychange', async () => {
  if (IS_BUBBLE) return;
  if (document.hidden) { if (state === 'wake') { stopRec(); setState('idle'); } return; }
  if (wakeOn) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
    resumeWake();
  }
});

// ------------------------------------------------------------------ speech output

let voices = [];
function loadVoices() {
  voices = NATIVE ? (nativeSync('voices') || []).map(v => ({ voiceURI: v.name, name: v.name, lang: v.lang }))
    : (window.speechSynthesis?.getVoices?.() || []);
  const sel = $('#voice-select');
  const cur = settings.voiceURI;
  sel.innerHTML = '<option value="">Default</option>' + voices
    .map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  sel.value = cur;
}
if (NATIVE) setTimeout(loadVoices, 1500);
else if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function stopSpeaking() {
  if (NATIVE) nativeStopSpeaking(); else window.speechSynthesis?.cancel();
}

async function speak(text) {
  if (text) buddy.say(text);
  if (NATIVE && settings.speak && text) {
    setState('speaking');
    await nativeSpeak(text.replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, 'the link'), voices.find(v => v.voiceURI === settings.voiceURI)?.lang || settings.lang, settings.rate, settings.voiceURI);
    return;
  }
  return new Promise((resolve) => {
    if (!settings.speak || !text || !('speechSynthesis' in window)) return resolve();
    speechSynthesis.cancel();
    const clean = text.replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, 'the link');
    // Chrome cuts off long utterances, so speak sentence by sentence.
    const chunks = clean.match(/[^.!?\n]+[.!?]*|\n+/g)?.map(s => s.trim()).filter(Boolean) || [clean];
    const voice = voices.find(v => v.voiceURI === settings.voiceURI);
    let i = 0;
    setState('speaking');
    const next = () => {
      if (state !== 'speaking' || i >= chunks.length) return resolve();
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || settings.lang;
      u.rate = Number(settings.rate) || 1;
      u.onend = next;
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    };
    next();
  });
}

function chime(freq = 880) {
  try {
    const ac = chime.ac || (chime.ac = new (window.AudioContext || window.webkitAudioContext)());
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
    o.connect(g).connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.3);
  } catch { }
}

// ------------------------------------------------------------------ the agent loop

let history = store.get('history', []);
let abort = null;

function systemPrompt() {
  const now = new Date();
  const memory = store.get('memory', []);
  return [
    `You are J.A.R.V.I.S., a sharp, witty and loyal personal assistant living on ${settings.userName || 'the user'}'s phone.`,
    settings.userName ? `Address the user as ${settings.userName} (or "sir"/"boss" occasionally, Iron-Man style, but don't overdo it).` : '',
    'Your replies are SPOKEN ALOUD: keep them short (1–3 sentences), natural, no markdown, no lists, no emojis, no URLs.',
    'You can act on the phone with tools. When the user asks you to do something, DO it with the tools instead of explaining how.',
    'If a name is given for calling/messaging, use find_contact first. If a number is missing, ask for it briefly.',
    'Apps and links open automatically; if the phone blocks it, a card with an Open button appears – mention "tap Open" only if relevant.',
    'For times, interpret relative phrases ("in 10 minutes", "tomorrow at 9") using the current local time below and pass ISO local times.',
    'When you need live facts (news, scores, prices) and have no tool for it, give your best knowledge and offer to search.',
    'Use the remember tool when the user tells you a lasting personal fact or preference.',
    NATIVE ? 'You can see and control the phone screen: use read_screen when the user asks about what is on their screen (read, summarise, explain, reply to a message), and screen_action to go back, scroll, tap a button by its label or type text.' : '',
    `Current local time: ${now.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
    memory.length ? `What you remember about the user:\n- ${memory.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
}

function trimHistory() {
  const MAX = 30;
  if (history.length > MAX) history = history.slice(-MAX);
  // never start with an orphaned tool result / tool call
  while (history.length && history[0].role !== 'user') history.shift();
  try { store.set('history', history); } catch { }
}

function updateModelLabel() {
  $('#model-label').textContent = `${providerOf(settings).label} · ${modelOf(settings) || 'automatic'}`;
}

// The AI agent loop: asks the model, runs the tools it picks, repeats until it answers. Returns the reply.
async function askAI(text, signal) {
  const startLen = history.length;
  history.push({ role: 'user', content: text });
  const ctx = { settings, ui, signal, alert: fireAlert };
  try {
    for (let step = 0; step < 6; step++) {
      const res = await chat(settings, {
        system: systemPrompt(), messages: history, tools: toolsFor(settings), signal,
      }, (key, model) => { saveSettings(); updateModelLabel(); syncForm(); addTool('switched model', { model }); },
      (id) => addTool('answered by', { provider: PROVIDERS[id].label }));
      history.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, geminiParts: res.geminiParts });
      if (!res.toolCalls.length) return res.text || 'Done.';
      if (res.text) addMsg('assistant', res.text);
      for (const tc of res.toolCalls) {
        addTool(tc.name, tc.args);
        const out = await runTool(tc.name, tc.args, ctx);
        history.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: out });
      }
    }
    return 'Done.';
  } catch (e) {
    history.length = startLen; // drop the failed turn so the conversation stays valid
    throw e;
  } finally {
    trimHistory();
  }
}

async function finishReply(reply) {
  addMsg('assistant', reply);
  await speak(reply);
  if (state === 'speaking' || state === 'thinking') setState('idle');
  if (settings.followUp && /\?\s*$/.test(reply) && state === 'idle') { chime(660); startRec('command'); return; }
  resumeWake();
}

async function handleCommand(text) {
  text = text.trim();
  if (!text) return;
  live.textContent = '';
  addMsg('user', text);

  if (/^(stop|cancel|never ?mind|shut up|quiet)\.?$/i.test(text)) {
    stopSpeaking(); buddy.say(''); setState('idle'); resumeWake(); return;
  }

  setState('thinking');
  abort = new AbortController();
  const signal = abort.signal;
  try {
    // 1. Your saved commands and the built-in phone commands: instant, no AI.
    const local = await runLocal(text, {
      settings, ui, signal, alert: fireAlert,
      ai: (line) => askAI(line, signal), // a saved command's step that only the AI understands
    });
    if (local) {
      history.push({ role: 'user', content: text });
      if (local.say) history.push({ role: 'assistant', content: local.say });
      trimHistory();
      addTool('instant', { command: local.label });
      if (local.say) return await finishReply(local.say);
      chime(880); // done quietly (e.g. "go back", "volume up")
      setState('idle'); resumeWake();
      return;
    }
    // 2. Everything else: the AI.
    await finishReply(await askAI(text, signal));
  } catch (e) {
    if (e.name === 'AbortError') { setState('idle'); resumeWake(); return; }
    addMsg('error', e.message || String(e));
    buddy.react('sad');
    await speak(explainError(e));
    setState('idle'); resumeWake();
  } finally {
    abort = null;
  }
}

// ------------------------------------------------------------------ alerts, timers

function fireAlert(title, body) {
  chime(988); setTimeout(() => chime(1318), 220); setTimeout(() => chime(988), 440);
  navigator.vibrate?.([300, 150, 300, 150, 600]);
  ui.card(`⏰ ${title}`, body, []);
  buddy.react('wake');
  if (NATIVE) NATIVE.notify(title, body);
  else if (window.Notification?.permission === 'granted') {
    navigator.serviceWorker?.ready.then(reg => reg.showNotification(title, { body, icon: 'icons/icon-192.png', vibrate: [300, 150, 300] }))
      .catch(() => { try { new Notification(title, { body }); } catch { } });
  }
  if (state === 'idle' || state === 'wake') {
    stopRec();
    speak(`${title}. ${body}`).then(() => { if (state === 'speaking') setState('idle'); resumeWake(); });
  }
  renderTimers();
}

function renderTimers() {
  const el = $('#timers');
  const list = activeTimers();
  el.hidden = !list.length;
  el.innerHTML = list.map(t => {
    const s = Math.max(0, Math.round((t.due - Date.now()) / 1000));
    return `<span>⏱ ${esc(t.label)} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</span>`;
  }).join('');
}
setInterval(() => { if (activeTimers().length || !$('#timers').hidden) renderTimers(); }, 1000);
initScheduler({ alert: fireAlert });

// ------------------------------------------------------------------ controls

function onTalk() {
  // A tap also "unlocks" audio on mobile browsers.
  if (state === 'speaking') { stopSpeaking(); buddy.say(''); setState('idle'); resumeWake(); return; }
  if (state === 'thinking') { abort?.abort(); return; }
  if (state === 'listening') { stopRec(); awaitingCommand = false; setState('idle'); resumeWake(); return; }
  awaitingCommand = false;
  startRec('command');
}

wakeBtn.addEventListener('click', () => setWake(!wakeOn));

$('#btn-keyboard').addEventListener('click', () => {
  textForm.hidden = !textForm.hidden;
  if (!textForm.hidden) textInput.focus();
});
textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = textInput.value; textInput.value = '';
  if (state === 'thinking') return;
  stopRec(); stopSpeaking();
  handleCommand(t);
});
log.addEventListener('click', (e) => {
  const li = e.target.closest('.examples li');
  if (li) handleCommand(li.textContent.replace(/[“”]/g, ''));
});

// ------------------------------------------------------------------ settings UI

const form = $('#settings-form');
function syncForm() {
  for (const el of form.querySelectorAll('[data-key]')) {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else el.value = v ?? '';
  }
  $('#rate-out').textContent = `${Number(settings.rate).toFixed(2)}×`;
  syncProviderUI();
  const mem = store.get('memory', []);
  $('#memory-view').textContent = mem.length ? `Remembered: ${mem.join(' · ')}` : 'Jarvis hasn\'t memorised anything about you yet.';
  $('#btn-notify').textContent = window.Notification?.permission === 'granted' ? 'Notifications allowed ✓' : 'Allow notifications';
}

// ---- Brain tab: provider chips, model field and the API key list are built from PROVIDERS.
const escA = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('#provider-chips').innerHTML = Object.entries(PROVIDERS).map(([id, p]) =>
  `<label class="chip" data-provider="${id}"><input type="radio" name="provider" data-key="provider" value="${id}"><span>${escA(p.label)}</span></label>`).join('');
$('#key-list').innerHTML = Object.entries(PROVIDERS).filter(([id]) => id !== 'openjarvis').map(([id, p]) => `
  <div class="key-row" data-provider="${id}">
    <div class="key-top">
      <b>${escA(p.label)}</b><small>${escA(p.note)}</small>
      ${p.keyUrl ? `<a href="${p.keyUrl}" target="_blank" rel="noopener">Get key ↗</a>` : ''}
    </div>
    ${p.urlField ? `<input data-key="${p.urlField}" type="url" placeholder="https://my-server:8000/v1" autocomplete="off" aria-label="${escA(p.label)} URL">` : ''}
    <input data-key="${p.keyField}" type="password" placeholder="${escA(p.keyHint)}" autocomplete="off" aria-label="${escA(p.label)} API key">
    <small class="key-hint"></small>
  </div>`).join('');

function syncProviderUI() {
  const id = settings.provider, p = providerOf(settings);
  const model = $('#model-input');
  model.dataset.key = p.modelField;
  model.value = settings[p.modelField] || '';
  $('#btn-load-models').dataset.load = id;
  $('#models-list').innerHTML = '';
  $('#model-note').textContent = `${p.label} · blank = Jarvis picks a fast one`;
  for (const chip of form.querySelectorAll('#provider-chips .chip')) {
    chip.classList.toggle('has-key', hasCredentials(settings, chip.dataset.provider));
  }
  for (const row of form.querySelectorAll('.key-row')) {
    const rp = PROVIDERS[row.dataset.provider];
    const v = cleanKey(settings[rp.keyField]);
    const hint = row.querySelector('.key-hint');
    const looksWrong = v && rp.keyPattern && !rp.keyPattern.test(v);
    hint.textContent = !v ? '' : `Saved ${v.slice(0, 5)}…${v.slice(-4)} · ${v.length} characters${looksWrong ? ` · ${rp.label} keys usually start with ${rp.keyHint.replace('…', '')}` : ''}`;
    hint.classList.toggle('warn', !!looksWrong);
    row.classList.toggle('current', row.dataset.provider === id);
  }
}

form.addEventListener('input', (e) => {
  const el = e.target.closest('[data-key]');
  if (!el) return;
  const key = el.dataset.key;
  const prevProvider = settings.provider;
  settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value.trim();
  if (/Key$/.test(key)) settings[key] = cleanKey(settings[key]);
  if (key === 'provider' && settings.provider !== prevProvider) { history = []; store.set('history', []); }
  saveSettings();
  if (key === 'provider') syncForm();
  else if (/Key$|Url$/.test(key)) syncProviderUI();
  updateModelLabel();
  if (key === 'wakeWord') setState(state);
  if (key === 'buddySound') buddy.setSound(settings.buddySound);
  if (key === 'serverUrl') detectServer();
  if (key === 'rate') $('#rate-out').textContent = `${Number(settings.rate).toFixed(2)}×`;
});

// ---- tabs and the (i) explanations
const tabs = [...form.querySelectorAll('[data-tab]')];
function showTab(name) {
  const tab = tabs.find(t => t.dataset.tab === name && getComputedStyle(t).display !== 'none') || tabs[0];
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  for (const p of form.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab.dataset.tab;
  $('#settings-sub').textContent = tab.dataset.sub;
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  form.querySelector('.settings-body').scrollTop = 0;
  if (tab.dataset.tab === 'about') refreshAbout();
  if (tab.dataset.tab === 'commands') { renderCustom(); refreshScreenState(); }
  try { localStorage.setItem('jarvis.settingsTab', tab.dataset.tab); } catch { }
}
form.querySelector('.tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) showTab(t.dataset.tab);
});
form.addEventListener('click', (e) => {
  const info = e.target.closest('.info');
  if (!info) return;
  const more = info.closest('.s-card').querySelector('.s-more');
  more.hidden = !more.hidden;
  info.setAttribute('aria-expanded', String(!more.hidden));
});
function openSettings(tab) {
  syncForm();
  let last = 'general';
  try { last = localStorage.getItem('jarvis.settingsTab') || last; } catch { }
  showTab(tab || last);
  dialog.showModal();
}


// ---- Commands tab: built-in examples, your saved commands, screen control
{
  const groups = {};
  for (const b of BUILTINS) {
    if (b.native && !NATIVE) continue;
    for (const ex of b.examples || []) (groups[b.group] ||= []).push(ex);
  }
  $('#builtin-list').innerHTML = Object.entries(groups).map(([g, list]) =>
    `<div class="cmd-group"><b>${escA(g)}</b><div>${list.map(x => `<span class="ex">“${escA(x)}”</span>`).join('')}</div></div>`).join('');
  $('#cmd-templates').innerHTML = TEMPLATES.map((t, i) =>
    `<button type="button" class="chip-btn" data-template="${i}">+ ${escA(cap1(t.phrases.split(',')[0]))}</button>`).join('');
}
function cap1(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

function renderCustom(focusLast) {
  const list = $('#custom-list');
  const cmds = settings.customCommands || [];
  list.innerHTML = cmds.length ? cmds.map((c, i) => `
    <div class="cmd-row" data-i="${i}">
      <label>When I say <small>separate options with commas</small>
        <input data-f="phrases" value="${escA(c.phrases || '')}" placeholder="good night, going to sleep" autocomplete="off"></label>
      <label>Do this <small>one step per line</small>
        <textarea data-f="actions" rows="3" placeholder="turn off the flashlight&#10;set an alarm for 6:30 am">${escA(c.actions || '')}</textarea></label>
      <label>Then say <small>optional</small>
        <input data-f="reply" value="${escA(c.reply || '')}" placeholder="Good night!" autocomplete="off"></label>
      <div class="row"><button type="button" class="btn small" data-act="try">Try it</button><button type="button" class="btn small danger" data-act="delete">Delete</button></div>
    </div>`).join('') : '<p class="hint">No commands yet. Add one, or start from an example below.</p>';
  if (focusLast) list.querySelector('.cmd-row:last-child [data-f="phrases"]')?.focus();
}
const customList = $('#custom-list');
customList.addEventListener('input', (e) => {
  const f = e.target.dataset.f, row = e.target.closest('.cmd-row');
  if (!f || !row) return;
  settings.customCommands[row.dataset.i][f] = e.target.value;
  saveSettings();
});
customList.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const i = +e.target.closest('.cmd-row')?.dataset.i;
  if (!act) return;
  const cmd = settings.customCommands[i];
  if (act === 'delete') {
    if (!confirm(`Delete “${cmd.phrases || 'this command'}”?`)) return;
    settings.customCommands.splice(i, 1);
    saveSettings(); renderCustom();
  } else if (act === 'try') {
    const phrase = String(cmd.phrases || '').split(',')[0].trim();
    if (!phrase) return alert('Type what you will say first.');
    dialog.close();
    handleCommand(phrase);
  }
});
$('#btn-add-cmd').addEventListener('click', () => {
  settings.customCommands = [...(settings.customCommands || []), { phrases: '', actions: '', reply: '' }];
  saveSettings(); renderCustom(true);
});
$('#cmd-templates').addEventListener('click', (e) => {
  const t = TEMPLATES[e.target.closest('[data-template]')?.dataset.template];
  if (!t) return;
  settings.customCommands = [...(settings.customCommands || []), { ...t }];
  saveSettings(); renderCustom(true);
});

function refreshScreenState() {
  if (!NATIVE) return;
  const st = nativeSync('screenState') || {};
  const box = $('#screen-status');
  const [tone, title, detail, btn] = st.enabled && st.connected
    ? ['ok', 'On', 'try “go back”, “scroll down” or “tap Send”', 'Accessibility settings']
    : st.enabled ? ['busy', 'Starting…', 'Android is connecting Jarvis; this takes a moment', 'Accessibility settings']
      : ['idle', 'Off', 'turn it on to control apps by voice', 'Turn on “Jarvis screen control”'];
  box.dataset.tone = tone;
  $('#screen-title').textContent = title;
  $('#screen-detail').textContent = detail;
  $('#btn-screen-on').textContent = btn;
}
if (NATIVE) {
  $('#btn-screen-on').addEventListener('click', () => NATIVE.openScreenSetup('accessibility'));
  $('#btn-app-info').addEventListener('click', () => NATIVE.openScreenSetup('app_info'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dialog.open) refreshScreenState(); });
}

// Show the cleaned-up key once the field is left.
form.addEventListener('change', (e) => {
  const el = e.target.closest('[data-key$="Key"]');
  if (el) el.value = settings[el.dataset.key] || '';
});

// ---- Android-only controls
if (NATIVE) {
  $('#btn-perms').addEventListener('click', () => NATIVE.requestPermissions());
  $('#btn-battery').addEventListener('click', () => NATIVE.requestBackground());
  $('#btn-bubble-start').addEventListener('click', () => {
    const r = nativeSync('startBubble');
    if (r && !r.ok && r.reason) alert(r.reason);
    else { dialog.close(); setWake(false); }
  });
  $('#btn-bubble-stop').addEventListener('click', () => NATIVE.stopBubble());
  const boot = $('#chk-boot');
  boot.checked = !!nativeSync('bubbleState')?.onBoot;
  boot.addEventListener('change', () => NATIVE.setStartOnBoot(String(boot.checked)));
}

form.addEventListener('click', async (e) => {
  const load = e.target.closest('[data-load]');
  if (!load) return;
  const prov = load.dataset.load;
  load.textContent = '…';
  try {
    const ids = await listModels({ ...settings, provider: prov }, prov);
    $('#models-list').innerHTML = ids.map(id => `<option value="${esc(id)}">`).join('');
    const key = PROVIDERS[prov].modelField;
    if (!ids.includes(settings[key])) {
      settings[key] = prov === 'openjarvis' || prov === 'custom' ? ids[0] || '' : pickModel(prov, ids) || settings[key];
      saveSettings(); syncForm(); updateModelLabel();
    }
    load.textContent = `${ids.length} ✓`;
  } catch (err) {
    load.textContent = 'Load';
    alert(`${explainError(err)}\n\nDetails: ${err.message}`);
  }
});

$('#btn-test').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.textContent = 'Testing…';
  const t0 = performance.now();
  try {
    // Test only the chosen provider (no fallback), so a bad key isn't hidden by another provider.
    await chat({ ...settings, fallbackProviders: false },
      { system: 'Reply with exactly: Online and ready.', messages: [{ role: 'user', content: 'Status check' }], tools: [] },
      (key, value) => { settings[key] = value; saveSettings(); syncForm(); updateModelLabel(); });
    b.textContent = `✓ ${((performance.now() - t0) / 1000).toFixed(1)} s · ${modelOf(settings) || 'connected'}`;
  } catch (err) {
    b.textContent = 'Test connection';
    alert(`${explainError(err)}\n\nDetails: ${err.message}`);
  }
});

$('#btn-notify').addEventListener('click', async () => {
  if (!window.Notification) return alert('Notifications are not supported here.');
  await Notification.requestPermission();
  syncForm();
});
$('#btn-clear-chat').addEventListener('click', () => {
  history = []; store.set('history', []);
  log.innerHTML = ''; addMsg('assistant', 'Conversation cleared.');
});
$('#btn-clear-mem').addEventListener('click', () => {
  if (!confirm('Forget all remembered facts, notes and reminders?')) return;
  store.set('memory', []); store.set('notes', []); store.set('reminders', []);
  syncForm();
});

$('#btn-settings').addEventListener('click', () => openSettings());

// ---- updates (Settings → About)
initUpdates({
  settings,
  notify(available) {
    $('#gear-dot').hidden = !available;
    $('#about-dot').hidden = !available;
    if (!available || IS_BUBBLE) return;
    const code = store.get('update.latest', {})?.versionCode;
    if (code && store.get('update.announced', 0) !== code) {
      store.set('update.announced', code);
      ui.card('A new version of Jarvis is ready', 'Open Settings → About to update. Your settings and memory are kept.',
        [{ label: 'Update', onClick: () => openSettings('about') }]);
    }
  },
});

// ------------------------------------------------------------------ boot

async function detectServer() {
  const info = $('#server-info');
  try {
    if (NATIVE && !settings.serverUrl) throw 0;
    const r = await fetch(`${serverBase(settings)}/api/config`, { cache: 'no-store' });
    if (!r.ok) throw 0;
    settings._server = await r.json();
    const s = settings._server;
    const tick = (b) => b ? '✓' : '✗';
    info.innerHTML = `<span class="ok">Jarvis server connected.</span> Keys on server — Gemini ${tick(s.gemini)}, Grok ${tick(s.xai)}, OpenJarvis ${tick(s.openjarvis)}${s.tokenRequired ? ' (token required)' : ''}.`;
  } catch {
    settings._server = null;
    info.textContent = NATIVE ? 'Requests go straight from your phone to the AI. Add a Jarvis server only if you run one.' : 'No Jarvis server detected. Requests go straight from this browser to the AI.';
  }
}

async function boot() {
  updateModelLabel();
  setState('idle');
  await detectServer();
  if (!hasCredentials(settings, settings.provider)) {
    addMsg('assistant', 'Welcome! Open Settings → Brain and add an API key (Gemini, Groq and Mistral have free tiers) to bring me online.');
  }
  if (!SR) addMsg('error', 'This browser has no speech recognition. Use Chrome on Android for voice; typing still works.');
  if (NATIVE && !IS_BUBBLE && nativeSync('bubbleState')?.running) wakeBtn.setAttribute('aria-pressed', String(!!store.get('wake', false)));
  if (store.get('wake', false) && (IS_BUBBLE || (NATIVE && !nativeSync('bubbleState')?.running))) {
    setWake(true);
  } else if (store.get('wake', false) && !NATIVE) {
    // Browsers require a tap before the mic starts; arm the wake word on the first tap anywhere.
    statusEl.textContent = 'Tap anywhere to resume wake word';
    document.addEventListener('pointerdown', () => { if (!wakeOn) setWake(true); }, { once: true, capture: true });
  }
  if (!NATIVE && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  // Home-screen shortcut "Talk to Jarvis" opens with ?listen=1
  if (new URLSearchParams(location.search).has('listen') && SR) {
    window.history.replaceState(null, '', location.pathname);
    startRec('command');
  }
}
boot();
