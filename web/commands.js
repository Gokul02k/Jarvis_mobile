// Instant commands: common phrases handled on the phone, without asking the AI (like Android Voice Access).
// Your own saved commands run first; anything not understood here goes to the AI.
//
//   const r = await runLocal(text, ctx)   // → { say, label } when handled, or null to ask the AI
//
// ctx: { settings, ui, signal, alert, ai(text) → Promise<reply> }

import { runTool, screenAction, newsHeadlines } from './tools.js';
import { NATIVE, nativeSync } from './native.js';

// ------------------------------------------------------------------ text helpers

const FILLER = /^(hey|ok|okay|hi|yo)\b[\s,]*|^(please|can you|could you|would you|will you|i want to|i'd like to|i need to|let's)\s+|\s+(please|for me|now|right now)$/g;

export function normalize(text, wakeWord = 'jarvis') {
  let s = String(text || '').toLowerCase()
    .replace(/[“”"!?¿¡]/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\.$/, '');
  const wake = wakeWord.toLowerCase().trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(FILLER, '').trim();
    if (wake && s.startsWith(wake)) s = s.slice(wake.length).replace(/^[\s,.]+/, '');
    if (s === before) break;
  }
  return s;
}

const NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90,
};
const numWords = (s) => s.replace(/\b(twenty five|forty five|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\b(?=\s+(hours?|hrs?|minutes?|mins?|seconds?|secs?))/g, (w) => NUM[w]);

/** "5 minutes", "1 hour 30 minutes", "half an hour", "90 seconds" → seconds */
export function parseDuration(str) {
  const s = numWords(str.replace(/-/g, ' '));
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h\b|minutes?|mins?|m\b|seconds?|secs?|s\b)/g)) {
    const n = parseFloat(m[1]), u = m[2][0];
    total += u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
  }
  if (/half an hour/.test(s)) total += 1800;
  if (/and a half/.test(s) && total) total += /hour/.test(s) ? 1800 : 30;
  return total > 0 ? Math.round(total) : null;
}

/** "6:30 am", "6.30 pm", "18:30", "7 in the morning", "6 a.m." → { hour, minute } */
export function parseClock(str) {
  const s = str.replace(/a\.\s?m\.?/g, 'am').replace(/p\.\s?m\.?/g, 'pm').replace(/o'?\s?clock/g, '').trim();
  const m = s.match(/\b(\d{1,2})(?:[:.\s](\d{2}))?\s*(am|pm)?\b(?:.*?(morning|afternoon|evening|night|tonight))?/);
  if (!m) return null;
  let hour = +m[1];
  const minute = +(m[2] || 0);
  const ap = m[3] || (m[4] ? (m[4] === 'morning' ? 'am' : 'pm') : '');
  if (hour > 23 || minute > 59) return null;
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

const clockText = (h, m) => new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const durationText = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, s && `${s} second${s > 1 ? 's' : ''}`].filter(Boolean).join(' ');
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Android can't let apps switch these directly, so Jarvis opens the right settings panel.
const SETTING_PAGES = [
  [/wi-?fi|wireless|internet/, 'wifi', 'Wi-Fi'], [/bluetooth/, 'bluetooth', 'Bluetooth'],
  [/mobile data|data/, 'mobile_data', 'mobile data'], [/airplane|aeroplane|flight/, 'airplane', 'airplane mode'],
  [/hotspot|tethering/, 'hotspot', 'hotspot'], [/location|gps/, 'location', 'location'],
  [/do not disturb|dnd/, 'do_not_disturb', 'Do Not Disturb'], [/display|brightness/, 'display', 'display'],
  [/sound|ringtone/, 'sound', 'sound'], [/battery|power saving/, 'battery', 'battery'],
  [/accessibility/, 'accessibility', 'accessibility'], [/storage/, 'storage', 'storage'],
  [/apps?/, 'apps', 'apps'], [/date|time/, 'date_time', 'date and time'],
];

// ------------------------------------------------------------------ notifications

// A reply waiting for "yes" (Jarvis always reads it back first).
let pendingReply = null;

function notifState(r) {
  if (r?.needsSetup) return 'Notification access is off. Turn it on in Settings, under Commands.';
  return null;
}

function speakNotifications(list) {
  return list.map(n => `${n.app}${n.from && n.from !== n.app ? `, ${n.from}` : ''}: ${n.text || 'new notification'}`).join('. ');
}

// ------------------------------------------------------------------ built-in commands
// run(m, ctx, text) → string to say ('' = handled quietly), null to let the AI handle it,
// or undefined when it isn't this command after all (keep looking).

async function screen(action, text, ok) {
  const r = screenAction(action, text);
  if (r?.needsSetup) return 'Screen control is off. Turn it on in Settings, under Commands.';
  if (!r?.ok) return r?.error || 'I couldn\'t do that.';
  return ok;
}

export const BUILTINS = [
  // ---- screen control (Voice Access style)
  { group: 'Screen', examples: ['go back', 'go home', 'recent apps'], native: true,
    re: /^(?:go )?back$|^go to (?:the )?previous (?:screen|page)$/, run: () => screen('back', '', '') },
  { group: 'Screen', native: true, re: /^(?:go )?home(?: screen)?$|^go to (?:the )?home ?screen$/, run: () => screen('home', '', '') },
  { group: 'Screen', native: true, re: /^(?:show |open )?(?:my )?(?:recent apps|recents|recent)$|^switch apps?$/, run: () => screen('recents', '', '') },
  { group: 'Screen', examples: ['show notifications', 'quick settings'], native: true,
    re: /^(?:show|open|pull down|check)(?: my| the)? notifications?(?: panel| shade)?$|^notifications$/, run: () => screen('notifications', '', '') },
  { group: 'Screen', native: true, re: /^(?:show |open )?quick settings$/, run: () => screen('quick_settings', '', '') },
  { group: 'Screen', examples: ['lock the phone', 'take a screenshot'], native: true,
    re: /^lock(?: the| my)?(?: phone| screen| device)?$/, run: () => screen('lock', '', '') },
  { group: 'Screen', native: true, re: /^(?:take a )?screen ?shot$/, run: () => screen('screenshot', '', '') },
  { group: 'Screen', examples: ['scroll down', 'scroll up'], native: true,
    re: /^(?:scroll|swipe|page)(?: (up|down|left|right))?$/, run: (m) => screen(`scroll_${(m[1] || 'down').toLowerCase()}`, '', '') },
  { group: 'Screen', examples: ['tap Send', 'click Subscribe'], native: true,
    re: /^(?:tap|click|press|touch|hit|select)(?: on)?(?: the)? (.+?)(?: button| link)?$/, run: (m) => screen('tap', m[1], '') },
  { group: 'Screen', examples: ['type hello how are you'], native: true,
    re: /^(?:type|enter)(?: in)? (.+)$/, run: (m) => screen('type', m[1], '') },
  { group: 'Screen', examples: ['read the screen', 'read this'], native: true,
    re: /^read(?: out| me)?(?: the| this| my)?(?: screen| page| message| article| it)?(?: aloud| out loud)?$/,
    run: () => {
      const r = nativeSync('screenRead', '2500');
      if (r?.needsSetup) return 'Screen control is off. Turn it on in Settings, under Commands.';
      if (!r?.ok) return r?.error || 'I couldn\'t read the screen.';
      return r.text ? r.text : 'There\'s no text on the screen.';
    } },

  // ---- notifications
  { group: 'Notifications', native: true, re: /^(yes|yeah|yep|send( it)?|ok(ay)? send( it)?|go ahead|sure)$/,
    run: () => {
      if (!pendingReply || Date.now() - pendingReply.at > 90_000) return undefined; // not a reply confirmation
      const { to, message } = pendingReply; pendingReply = null;
      const r = nativeSync('notifyReply', to, message);
      return notifState(r) || (r?.ok ? `Sent to ${r.to}.` : r?.error || 'I couldn\'t send it.');
    } },
  { group: 'Notifications', native: true, re: /^(no|nope|don't send( it)?|cancel( it)?|don't)$/,
    run: () => { if (!pendingReply) return undefined; pendingReply = null; return 'Okay, not sent.'; } },
  { group: 'Notifications', examples: ['read my notifications', 'messages from Amma', 'reply to Amma coming in 10 minutes'], native: true,
    re: /^(?:read|check|show|what are|any)(?: me)?(?: my| the)?(?: new)? notifications?(?: please)?$|^do i have any (?:new )?notifications$/,
    run: () => {
      const r = nativeSync('notifications', '8');
      const off = notifState(r); if (off) return off;
      const list = r?.notifications || [];
      if (!list.length) return 'No new notifications.';
      return `${list.length === 1 ? 'One notification' : `${r.count} notifications`}. ${speakNotifications(list)}.`;
    } },
  { group: 'Notifications', native: true, re: /^(?:read|any|show|check)(?: me)?(?: my| the)?(?: new)? (?:messages?|notifications?|texts?) from (.+)$/,
    run: (m) => {
      const r = nativeSync('notifications', '40');
      const off = notifState(r); if (off) return off;
      const who = m[1].toLowerCase();
      const list = (r?.notifications || []).filter(n => `${n.from} ${n.app}`.toLowerCase().includes(who));
      return list.length ? speakNotifications(list) + '.' : `No messages from ${m[1]}.`;
    } },
  { group: 'Notifications', native: true,
    re: /^(?:reply|respond|answer)(?: back)? to (.+?)(?:\s*:\s*|\s+(?:saying|that|with)\s+)(.+)$|^(?:reply|respond|answer)(?: back)? to (\S+) (.+)$/,
    run: (m) => {
      const to = m[1] || m[3], message = m[2] || m[4];
      pendingReply = { to, message, at: Date.now() };
      return `Reply to ${to}: “${message}”. Should I send it?`;
    } },

  // ---- phone
  { group: 'Phone', examples: ['flashlight on', 'turn off the torch'],
    re: /\b(?:flash ?light|torch)\b/, run: async (m, ctx, t) => {
      const on = !/\boff\b/.test(t);
      const r = await runTool('flashlight', { on }, ctx);
      return r?.error ? r.error : `Flashlight ${on ? 'on' : 'off'}.`;
    } },
  { group: 'Phone', examples: ['what time is it'],
    re: /^(?:what(?:'s| is) the )?time(?: is it)?(?: now)?$|^what time is it(?: now)?$|^tell me the time$/,
    run: () => `It's ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` },
  { group: 'Phone', examples: ['what\'s the date'],
    re: /^(?:what(?:'s| is) )?(?:the |today's )?date(?: today)?$|^what day is (?:it|today)$|^what(?:'s| is) today$/,
    run: () => `It's ${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}.` },
  { group: 'Phone', examples: ['battery level'],
    re: /^(?:what(?:'s| is) )?(?:my |the )?battery(?: level| percentage| status| life)?(?: now)?$|^how much (?:battery|charge)(?: do i have| is left| left)?$/,
    run: async (m, ctx) => {
      const r = await runTool('device_status', {}, ctx);
      if (r?.battery_pct == null) return 'I can\'t read the battery here.';
      return `Battery is at ${r.battery_pct} percent${r.charging ? ', charging' : ''}.`;
    } },
  { group: 'Phone', examples: ['volume up', 'set volume to 40', 'mute'],
    re: /^(?:turn (?:the )?volume (up|down)|volume (up|down)|(increase|raise|decrease|lower|reduce) (?:the )?volume|(louder|quieter|softer))$/,
    run: async (m, ctx, t) => {
      const up = /up|increase|raise|louder/.test(t);
      const r = await runTool('volume', { action: up ? 'up' : 'down' }, ctx);
      return r?.error ? r.error : '';
    } },
  { group: 'Phone', native: true, re: /^(?:set )?(?:the )?volume (?:to |at )?(\d{1,3})(?: percent|%)?$|^(?:max|maximum|full) volume$|^volume (?:max|full)$/,
    run: async (m, ctx) => {
      const level = m[1] ? Math.min(100, +m[1]) : 100;
      const r = await runTool('volume', { action: 'set', level }, ctx);
      return r?.error ? r.error : `Volume ${level} percent.`;
    } },
  { group: 'Phone', native: true, re: /^(mute|unmute|silence)(?: the)?(?: volume| sound| phone| media| music)?$/,
    run: async (m, ctx) => {
      const r = await runTool('volume', { action: /^unmute/i.test(m[1]) ? 'unmute' : 'mute' }, ctx);
      return r?.error ? r.error : '';
    } },
  { group: 'Phone', examples: ['find my phone'],
    re: /^(?:find|where(?:'s| is)) my phone$|^ring my phone$/,
    run: async (m, ctx) => { await runTool('vibrate', { seconds: 4 }, ctx); return 'I\'m right here!'; } },
  { group: 'Phone', examples: ['take a selfie', 'open camera'], native: true,
    re: /^(?:take a (?:photo|picture|pic|selfie)|open (?:the )?camera|record a video)$/,
    run: async (m, ctx, t) => { const r = await runTool('take_photo', { video: /video/.test(t) }, ctx); return r?.error || ''; } },
  { group: 'Phone', examples: ['turn on bluetooth', 'open wifi settings'], native: true,
    re: /^(?:(?:turn|switch) (?:on|off)|enable|disable)(?: the| my)? (.+)$|^(?:open|show)(?: the| my)? (.+?) settings?$|^(.+?) (?:on|off)$/,
    run: async (m, ctx) => {
      const what = (m[1] || m[2] || m[3] || '').toLowerCase();
      const hit = SETTING_PAGES.find(([re]) => re.test(what));
      if (!hit) return undefined; // e.g. "turn on the lights": not a phone setting
      const r = await runTool('open_settings', { page: hit[1] }, ctx);
      return r?.error ? r.error : `Opening ${hit[2]} settings.`;
    } },
  { group: 'Phone', native: true, re: /^open (?:the |my )?(?:phone )?settings$/,
    run: async (m, ctx) => { await runTool('open_settings', { page: 'main' }, ctx); return ''; } },

  // ---- clock
  { group: 'Clock', examples: ['set an alarm for 6:30 am', 'wake me up at 7'], native: true,
    re: /^(?:set (?:an |the |my )?alarm|wake me(?: up)?|alarm)(?: for| at)? (.+)$/,
    run: async (m, ctx) => {
      const c = parseClock(m[1]);
      if (!c) return null;
      const r = await runTool('set_alarm', { hour: c.hour, minute: c.minute }, ctx);
      return r?.error ? r.error : `Alarm set for ${clockText(c.hour, c.minute)}.`;
    } },
  { group: 'Clock', examples: ['timer for 10 minutes', '5 minute timer'],
    re: /^(?:set (?:a |the )?timer|start (?:a )?timer|timer)(?: for)? (.+)$|^(.+?) timer$/,
    run: async (m, ctx) => {
      const sec = parseDuration(m[1] || m[2]);
      if (!sec) return null;
      const r = await runTool('set_timer', { seconds: sec }, ctx);
      return r?.error ? r.error : `Timer set for ${durationText(sec)}.`;
    } },

  // ---- media
  { group: 'Music', examples: ['pause', 'next song', 'play Believer'], native: true,
    re: /^(?:pause|stop)(?: the)?(?: music| song| video| playback| it)?$/,
    run: async (m, ctx) => { const r = await runTool('media_control', { action: 'pause' }, ctx); return r?.error || ''; } },
  { group: 'Music', native: true, re: /^(?:resume|continue|unpause)(?: the)?(?: music| song| video| playback)?$|^play(?: the)?(?: music)?$/,
    run: async (m, ctx) => { const r = await runTool('media_control', { action: 'play' }, ctx); return r?.error || ''; } },
  { group: 'Music', native: true, re: /^(?:next|skip)(?: this| the)?(?: song| track| video)?$|^play (?:the )?next(?: song| track)?$/,
    run: async (m, ctx) => { const r = await runTool('media_control', { action: 'next' }, ctx); return r?.error || ''; } },
  { group: 'Music', native: true, re: /^(?:previous|last)(?: song| track| video)?$|^play (?:the )?previous(?: song| track)?$/,
    run: async (m, ctx) => { const r = await runTool('media_control', { action: 'previous' }, ctx); return r?.error || ''; } },
  { group: 'Music', re: /^play (.+?)(?: on (youtube music|youtube|spotify))?$/,
    run: async (m, ctx) => {
      const platform = m[2] ? m[2].toLowerCase().replace(' ', '_') : undefined;
      await runTool('play_media', { query: m[1], platform }, ctx);
      return `Playing ${m[1]}.`;
    } },

  // ---- web, maps, weather
  { group: 'Web & maps', examples: ['search for cricket score', 'navigate to the airport'],
    re: /^(?:search(?: for)?|google|look up)(?: on)? (.+?)(?: on (youtube|google))?$|^search (youtube) for (.+)$/,
    run: async (m, ctx) => {
      const query = m[1] || m[4], type = /youtube/i.test(m[2] || m[3] || '') ? 'youtube' : 'web';
      await runTool('web_search', { query, type }, ctx);
      return '';
    } },
  { group: 'Web & maps', re: /^(?:navigate|directions|get directions|take me|drive|route)(?: me)? to (.+)$/,
    run: async (m, ctx) => { await runTool('navigate', { destination: m[1] }, ctx); return `Starting directions to ${m[1]}.`; } },
  { group: 'Web & maps', examples: ['what\'s the weather', 'will it rain tomorrow'],
    re: /^(?:what(?:'s| is) the |how(?:'s| is) the )?weather(?: like)?(?: today| now| tomorrow)?(?: in (.+?))?(?: today| now| tomorrow)?$|^will it rain(?: today| tomorrow)?$/,
    run: async (m, ctx, t) => {
      const r = await runTool('get_weather', { location: m[1] }, ctx);
      if (r?.error) return r.error;
      const tomorrow = /tomorrow/.test(t);
      const d = r.forecast?.[tomorrow ? 1 : 0];
      const where = r.place === 'your location' ? '' : ` in ${r.place.split(',')[0]}`;
      if (/rain/.test(t) && d) return `${d.rain_chance_pct} percent chance of rain ${tomorrow ? 'tomorrow' : 'today'}${where}.`;
      if (tomorrow && d) return `Tomorrow${where}: ${d.conditions}, ${Math.round(d.min_c)} to ${Math.round(d.max_c)} degrees.`;
      return `It's ${Math.round(r.now.temp_c)} degrees and ${r.now.conditions}${where}.${d ? ` Today ${Math.round(d.min_c)} to ${Math.round(d.max_c)}, ${d.rain_chance_pct} percent chance of rain.` : ''}`;
    } },

  { group: 'Web & maps', examples: ['what\'s the news', 'news about cricket'], native: true,
    re: /^(?:what(?:'s| is) the |read (?:me )?the |today's |latest |top )?(?:news|headlines)(?: today| now)?$|^(?:news|headlines|latest news) (?:about|on) (.+)$/,
    run: async (m, ctx) => {
      const list = await newsHeadlines(ctx.settings, m[1], ctx.signal, 5).catch(() => []);
      if (!list.length) return 'I couldn\'t get the news right now.';
      return `${m[1] ? `News about ${m[1]}` : 'Top headlines'}. ${list.map(n => `${n.title}, from ${n.source}`).join('. ')}.`;
    } },

  // ---- notes
  { group: 'Notes', examples: ['note buy milk', 'read my notes'],
    re: /^(?:take a note|make a note|add a note|note down|note|write down)(?: that)?:? (.+)$/,
    run: async (m, ctx) => { await runTool('notes', { action: 'add', text: m[1] }, ctx); return 'Noted.'; } },
  { group: 'Notes', re: /^(?:read|show|list|what are)(?: me)? my notes$|^my notes$/,
    run: async (m, ctx) => {
      const r = await runTool('notes', { action: 'list' }, ctx);
      const notes = r?.notes || [];
      return notes.length ? `You have ${notes.length} note${notes.length > 1 ? 's' : ''}: ${notes.map(n => n.text).join('. ')}.` : 'You have no notes.';
    } },

  // ---- calls and apps (last: they match broadly)
  { group: 'Calls & apps', examples: ['call Mom', 'call 98765 43210', 'open YouTube'],
    re: /^(?:call|dial|phone|ring)(?: up)? (.+?)(?: on (?:the )?(?:phone|mobile))?$/,
    run: async (m, ctx) => {
      const who = m[1], whoL = who.toLowerCase();
      if (/whatsapp|video|speaker/.test(whoL)) return null;
      if (/^[+\d][\d\s()-]{5,}$/.test(who)) {
        await runTool('make_call', { phone_number: who }, ctx);
        return `Calling ${who}.`;
      }
      const r = await runTool('find_contact', { name: who }, ctx);
      const matches = r?.matches || [];
      const exact = matches.filter(c => c.name.toLowerCase() === whoL);
      const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
      if (!matches.length) return `I couldn't find ${who} in your contacts.`;
      if (!pick) return null; // several people match: let the AI ask which one
      await runTool('make_call', { phone_number: pick.number, name: pick.name }, ctx);
      return `Calling ${pick.name}.`;
    } },
  { group: 'Calls & apps', re: /^(?:open|launch|start|run|go to)(?: the| my)? (.+?)(?: app)?$/,
    run: async (m, ctx) => {
      const r = await runTool('open_app', { app_name: m[1] }, ctx);
      if (r?.error) return `I couldn't find an app called ${m[1]}.`;
      return `Opening ${cap(r.app || m[1])}.`;
    } },
];

// ------------------------------------------------------------------ your saved commands

export const TEMPLATES = [
  { phrases: 'good night, going to sleep', actions: 'turn off the flashlight\nset an alarm for 6:30 am\nmute', reply: 'Good night! Alarm set for 6:30.' },
  { phrases: 'good morning', actions: 'what time is it\nwhat\'s the weather\nbattery level', reply: '' },
  { phrases: 'i\'m driving, driving mode', actions: 'open maps\nset volume to 80', reply: 'Drive safe.' },
  { phrases: 'movie time', actions: 'set volume to 70\nopen netflix', reply: 'Enjoy the movie.' },
];

function findSaved(text, settings) {
  for (const cmd of settings.customCommands || []) {
    const phrases = String(cmd.phrases || '').split(',').map(p => normalize(p, settings.wakeWord)).filter(Boolean);
    if (phrases.includes(text)) return cmd;
  }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Captured words come from the lower-cased text; give them back their original capitals for speaking.
function restoreCase(group, raw) {
  if (!group) return group;
  const i = raw.toLowerCase().indexOf(group);
  return i < 0 ? group : raw.substr(i, group.length);
}

async function runBuiltin(text, ctx, raw = text) {
  // Several steps in one sentence ("open YouTube and play Believer"): the AI plans those.
  if (/\bthen\b| and (?:also |then )?(?:open|call|play|set|turn|send|text|message|tell|search|navigate|remind|take)\b/.test(text)) return null;
  for (const b of BUILTINS) {
    if (b.native && !NATIVE) continue;
    const lower = text.match(b.re);
    if (!lower) continue;
    const m = lower.map(g => restoreCase(g, raw));
    const say = await b.run(m, ctx, text);
    if (say === undefined) continue;
    if (say === null) return null;
    return { say, label: text };
  }
  return null;
}

/** Handles `text` on the phone if it can. Returns { say, label } or null (= ask the AI). */
export async function runLocal(rawText, ctx) {
  const s = ctx.settings;
  const text = normalize(rawText, s.wakeWord);
  if (!text) return null;

  const saved = findSaved(text, s);
  if (saved) {
    const said = [];
    for (const line of String(saved.actions || '').split('\n').map(l => l.trim()).filter(Boolean)) {
      const t = normalize(line, s.wakeWord);
      if (/^say /.test(t)) { said.push(line.replace(/^\s*say\s+/i, '')); continue; }
      const wait = t.match(/^wait (\d+)/);
      if (wait) { await sleep(Math.min(10, +wait[1]) * 1000); continue; }
      const r = await runBuiltin(t, ctx, line);
      if (r) { if (r.say) said.push(r.say); continue; }
      if (ctx.ai) { const reply = await ctx.ai(line); if (reply) said.push(reply); }
    }
    return { say: saved.reply || said.join(' ') || 'Done.', label: `“${text}”` };
  }

  if (s.localCommands === false) return null;
  return runBuiltin(text, ctx, String(rawText));
}
