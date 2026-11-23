import { chat, listModels, pickModel } from './llm.js';
import { toolsFor, runTool, initScheduler, activeTimers, store } from './tools.js';

// ------------------------------------------------------------------ settings

const DEFAULTS = {
  provider: 'gemini',
  connection: 'auto',
  geminiKey: '', geminiModel: 'gemini-2.5-flash',
  xaiKey: '', grokModel: 'grok-4',
  ojUrl: '', ojKey: '', ojModel: '',
  serverToken: '',
  wakeWord: 'jarvis',
  lang: navigator.language || 'en-US',
  voiceURI: '', rate: 1.05, speak: true, followUp: true,
  userName: '', contacts: '', musicApp: 'youtube', autoOpen: true,
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => {
  const { _server, ...rest } = settings;
  store.set('settings', rest);
};

// ------------------------------------------------------------------ DOM

const $ = (s) => document.querySelector(s);
const log = $('#log'), orb = $('#orb'), live = $('#live'), statusEl = $('#status');
const textForm = $('#text-form'), textInput = $('#text-input');
const wakeBtn = $('#btn-wake'), dialog = $('#settings');

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
  orb.dataset.state = s;
  statusEl.textContent = s === 'wake' ? `Say “${cap(settings.wakeWord)}…”` : STATUS[s];
  if (s === 'idle' || s === 'thinking') live.textContent = '';
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

// ------------------------------------------------------------------ speech recognition

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
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
    if (mode === 'command' || awaitingCommand || containsWake(interim)) live.textContent = (final || interim).trim();
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
  clearTimeout(awaitTimer);
  awaitTimer = setTimeout(() => { awaitingCommand = false; if (state === 'listening') setState(wakeOn ? 'wake' : 'idle'); live.textContent = ''; }, 9000);
}

function resumeWake() {
  if (!wakeOn || rec || state === 'thinking' || state === 'speaking' || document.hidden) return;
  setTimeout(() => { if (wakeOn && !rec && state !== 'thinking' && state !== 'speaking' && !document.hidden) startRec('wake'); }, 250);
}

async function setWake(on) {
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
  if (document.hidden) { if (state === 'wake') { stopRec(); setState('idle'); } return; }
  if (wakeOn) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
    resumeWake();
  }
});

// ------------------------------------------------------------------ speech output

let voices = [];
function loadVoices() {
  voices = speechSynthesis?.getVoices?.() || [];
  const sel = $('#voice-select');
  const cur = settings.voiceURI;
  sel.innerHTML = '<option value="">Default</option>' + voices
    .map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
  sel.value = cur;
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text) {
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
  const m = settings.provider === 'gemini' ? settings.geminiModel
    : settings.provider === 'grok' ? settings.grokModel : (settings.ojModel || 'OpenJarvis');
  $('#model-label').textContent = `${{ gemini: 'Gemini', grok: 'Grok', openjarvis: 'OpenJarvis' }[settings.provider]} · ${m}`;
}

async function handleCommand(text) {
  text = text.trim();
  if (!text) return;
  live.textContent = '';
  addMsg('user', text);

  // Instant local commands (no AI round-trip)
  if (/^(stop|cancel|never ?mind|shut up|quiet)\.?$/i.test(text)) {
    speechSynthesis?.cancel(); setState('idle'); resumeWake(); return;
  }

  const startLen = history.length;
  history.push({ role: 'user', content: text });
  setState('thinking');
  abort = new AbortController();
  const ctx = {
    settings, ui, signal: abort.signal,
    alert: fireAlert,
  };
  let reply = '';
  try {
    for (let step = 0; step < 6; step++) {
      const res = await chat(settings, {
        system: systemPrompt(), messages: history, tools: toolsFor(settings), signal: abort.signal,
      }, (key, model) => { saveSettings(); updateModelLabel(); syncForm(); addTool('switched model', { model }); });
      history.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, geminiParts: res.geminiParts });
      if (!res.toolCalls.length) { reply = res.text; break; }
      if (res.text) addMsg('assistant', res.text);
      for (const tc of res.toolCalls) {
        addTool(tc.name, tc.args);
        const out = await runTool(tc.name, tc.args, ctx);
        history.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: out });
      }
    }
    if (!reply) reply = 'Done.';
  } catch (e) {
    if (e.name === 'AbortError') { history.length = startLen; setState('idle'); trimHistory(); resumeWake(); return; }
    history.length = startLen; // drop the failed turn so the conversation stays valid
    addMsg('error', e.message || String(e));
    reply = 'Sorry, I ran into a problem reaching the AI. ' + (e.message?.includes('key') ? 'Please check your API key in settings.' : '');
    trimHistory();
    await speak(reply);
    setState('idle'); resumeWake();
    return;
  } finally {
    abort = null;
  }
  trimHistory();
  addMsg('assistant', reply);
  await speak(reply);
  if (state === 'speaking') setState('idle');
  if (settings.followUp && /\?\s*$/.test(reply) && state === 'idle') { chime(660); startRec('command'); return; }
  resumeWake();
}

// ------------------------------------------------------------------ alerts, timers

function fireAlert(title, body) {
  chime(988); setTimeout(() => chime(1318), 220); setTimeout(() => chime(988), 440);
  navigator.vibrate?.([300, 150, 300, 150, 600]);
  ui.card(`⏰ ${title}`, body, []);
  if (window.Notification?.permission === 'granted') {
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

orb.addEventListener('click', () => {
  // A tap also "unlocks" audio on mobile browsers.
  if (state === 'speaking') { speechSynthesis.cancel(); setState('idle'); resumeWake(); return; }
  if (state === 'thinking') { abort?.abort(); return; }
  if (state === 'listening') { stopRec(); awaitingCommand = false; setState('idle'); resumeWake(); return; }
  awaitingCommand = false;
  chime(660);
  startRec('command');
});

wakeBtn.addEventListener('click', () => setWake(!wakeOn));

$('#btn-keyboard').addEventListener('click', () => {
  textForm.hidden = !textForm.hidden;
  if (!textForm.hidden) textInput.focus();
});
textForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = textInput.value; textInput.value = '';
  if (state === 'thinking') return;
  stopRec(); speechSynthesis?.cancel();
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
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  }
  const p = settings.provider;
  for (const el of form.querySelectorAll('[data-show]')) {
    const show = el.dataset.show;
    el.hidden = !(show === p || show === 'openjarvis-any');
  }
  const mem = store.get('memory', []);
  $('#memory-view').textContent = mem.length ? `Remembered: ${mem.join(' · ')}` : 'Jarvis hasn\'t memorised anything about you yet.';
  $('#btn-notify').textContent = window.Notification?.permission === 'granted' ? 'Notifications allowed ✓' : 'Allow notifications';
}

form.addEventListener('input', (e) => {
  const el = e.target.closest('[data-key]');
  if (!el) return;
  const key = el.dataset.key;
  const prevProvider = settings.provider;
  settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value.trim();
  if (key === 'provider' && settings.provider !== prevProvider) { history = []; store.set('history', []); }
  saveSettings();
  if (key === 'provider') syncForm();
  updateModelLabel();
  if (key === 'wakeWord') setState(state);
});

form.addEventListener('click', async (e) => {
  const load = e.target.closest('[data-load]');
  if (!load) return;
  const prov = load.dataset.load;
  load.textContent = '…';
  try {
    const ids = await listModels({ ...settings, provider: prov }, prov);
    $(`#models-${prov}`).innerHTML = ids.map(id => `<option value="${esc(id)}">`).join('');
    const key = { gemini: 'geminiModel', grok: 'grokModel', openjarvis: 'ojModel' }[prov];
    if (!ids.includes(settings[key])) {
      settings[key] = prov === 'openjarvis' ? ids[0] || '' : pickModel(prov, ids) || settings[key];
      saveSettings(); syncForm(); updateModelLabel();
    }
    load.textContent = `${ids.length} ✓`;
  } catch (err) {
    load.textContent = 'Load';
    alert(err.message);
  }
});

$('#btn-test').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.textContent = 'Testing…';
  try {
    const res = await chat(settings, { system: 'Reply with exactly: Online and ready.', messages: [{ role: 'user', content: 'Status check' }], tools: [] },
      () => { saveSettings(); syncForm(); updateModelLabel(); });
    b.textContent = `✓ ${res.text.slice(0, 40) || 'Connected'}`;
  } catch (err) {
    b.textContent = 'Test connection';
    alert(err.message);
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

$('#btn-settings').addEventListener('click', () => { syncForm(); dialog.showModal(); });

// ------------------------------------------------------------------ boot

async function detectServer() {
  const info = $('#server-info');
  try {
    const r = await fetch('api/config', { cache: 'no-store' });
    if (!r.ok) throw 0;
    settings._server = await r.json();
    const s = settings._server;
    const tick = (b) => b ? '✓' : '✗';
    info.innerHTML = `<span class="ok">Jarvis server connected.</span> Keys on server — Gemini ${tick(s.gemini)}, Grok ${tick(s.xai)}, OpenJarvis ${tick(s.openjarvis)}${s.tokenRequired ? ' (token required)' : ''}.`;
  } catch {
    settings._server = null;
    info.textContent = 'No Jarvis server detected (static hosting). Enter your API key(s) below.';
  }
}

async function boot() {
  updateModelLabel();
  setState('idle');
  await detectServer();
  const needsKey = settings.provider === 'gemini' ? !settings.geminiKey && !settings._server?.gemini
    : settings.provider === 'grok' ? !settings.xaiKey && !settings._server?.xai : false;
  if (needsKey) {
    addMsg('assistant', 'Welcome! Open Settings (top right) and add your Gemini or Grok API key to bring me online.');
  }
  if (!SR) addMsg('error', 'This browser has no speech recognition. Use Chrome on Android for voice; typing still works.');
  if (store.get('wake', false)) {
    // Browsers require a tap before the mic starts; arm the wake word on the first tap anywhere.
    statusEl.textContent = 'Tap anywhere to resume wake word';
    document.addEventListener('pointerdown', () => { if (!wakeOn) setWake(true); }, { once: true, capture: true });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  // Home-screen shortcut "Talk to Jarvis" opens with ?listen=1
  if (new URLSearchParams(location.search).has('listen') && SR) {
    window.history.replaceState(null, '', location.pathname);
    startRec('command');
  }
}
boot();
