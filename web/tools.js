// Tools Jarvis can use on the phone. Each tool: { name, description, parameters, run(args, ctx) }.
// ctx = { settings, ui: { card(title, detail, actions) }, speak(text), notify(title, body), signal }

import { askOpenJarvis, openJarvisAvailable } from './llm.js';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
const B = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

// ---------------------------------------------------------------- storage

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`jarvis.${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`jarvis.${key}`, JSON.stringify(value)); } catch { }
  },
};
export { store };

// ---------------------------------------------------------------- helpers

// Open a URL / app link. Browsers only allow this right after a tap, so we also
// show a card with a button the user can tap if the automatic open was blocked.
function launch(ctx, url, title, detail) {
  let opened = false;
  if (ctx.settings.autoOpen) {
    try {
      if (/^https?:/i.test(url)) {
        const w = window.open(url, '_blank');
        if (w) { try { w.opener = null; } catch { } opened = true; }
      } else {
        window.location.href = url;
        opened = true; // can't detect if the OS blocked it
      }
    } catch { }
  }
  ctx.ui.card(title, detail || url, [{ label: 'Open', href: url }]);
  return opened;
}

function cleanNumber(n) {
  return String(n || '').replace(/[^\d+*#]/g, '');
}

function parseContacts(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.*?)[\s:=,-]+(\+?[\d\s()-]{5,})$/);
    return m ? { name: m[1].trim(), number: cleanNumber(m[2]) } : null;
  }).filter(Boolean);
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location not available on this device'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy) }),
      e => reject(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get location')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  });
}

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

function pad(n) { return String(n).padStart(2, '0'); }
function gcalStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}
function parseWhen(s) {
  const d = new Date(s);
  if (isNaN(d)) throw new Error(`Could not understand the time "${s}". Use ISO format like 2026-11-24T09:00.`);
  return d;
}

// --------------------------------------------------------- timers & reminders

const timers = new Map(); // id -> { label, due, handle }

export function initScheduler(ctx) {
  // Reminders survive reloads (stored); checked every 15 s while the app is open.
  setInterval(() => {
    const now = Date.now();
    const list = store.get('reminders', []);
    const due = list.filter(r => r.due <= now);
    if (!due.length) return;
    store.set('reminders', list.filter(r => r.due > now));
    for (const r of due) ctx.alert('Reminder', r.text);
  }, 15000);
}

// ---------------------------------------------------------------- flashlight

let torchStream = null;
async function setTorch(on) {
  if (!on) {
    torchStream?.getTracks().forEach(t => t.stop());
    torchStream = null;
    return { ok: true, flashlight: 'off' };
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser');
  torchStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
  const track = torchStream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  if (!caps.torch) {
    torchStream.getTracks().forEach(t => t.stop()); torchStream = null;
    throw new Error('This browser cannot control the flashlight (works in Chrome on most Android phones)');
  }
  await track.applyConstraints({ advanced: [{ torch: true }] });
  return { ok: true, flashlight: 'on' };
}

// ---------------------------------------------------------------- apps

const APPS = {
  youtube: 'https://www.youtube.com/',
  'youtube music': 'https://music.youtube.com/',
  spotify: 'https://open.spotify.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  whatsapp: 'https://wa.me/',
  telegram: 'https://t.me/',
  x: 'https://x.com/', twitter: 'https://x.com/',
  linkedin: 'https://www.linkedin.com/',
  gmail: 'https://mail.google.com/',
  'google maps': 'https://maps.google.com/', maps: 'https://maps.google.com/',
  'google drive': 'https://drive.google.com/', drive: 'https://drive.google.com/',
  'google photos': 'https://photos.google.com/', photos: 'https://photos.google.com/',
  calendar: 'https://calendar.google.com/',
  'google keep': 'https://keep.google.com/', keep: 'https://keep.google.com/',
  netflix: 'https://www.netflix.com/',
  amazon: 'https://www.amazon.in/',
  flipkart: 'https://www.flipkart.com/',
  'prime video': 'https://www.primevideo.com/',
  hotstar: 'https://www.hotstar.com/',
  github: 'https://github.com/',
  reddit: 'https://www.reddit.com/',
  'play store': 'https://play.google.com/store/apps',
  gemini: 'https://gemini.google.com/',
  grok: 'https://grok.com/',
  phone: 'tel:', dialer: 'tel:',
  messages: 'sms:', sms: 'sms:',
  camera: 'intent:#Intent;action=android.media.action.STILL_IMAGE_CAMERA;end',
  settings: 'intent:#Intent;action=android.settings.SETTINGS;end',
  wifi: 'intent:#Intent;action=android.settings.WIFI_SETTINGS;end',
  bluetooth: 'intent:#Intent;action=android.settings.BLUETOOTH_SETTINGS;end',
  clock: 'intent:#Intent;action=android.intent.action.SHOW_ALARMS;end',
  alarm: 'intent:#Intent;action=android.intent.action.SHOW_ALARMS;end',
};

// ---------------------------------------------------------------- tools

export const TOOLS = [
  {
    name: 'get_datetime',
    description: 'Get the current local date, time, day of week and timezone.',
    parameters: obj({}),
    run: () => {
      const d = new Date();
      return {
        iso_local: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
        readable: d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    },
  },
  {
    name: 'open_website',
    description: 'Open a website or web URL in the browser.',
    parameters: obj({ url: S('Full URL, e.g. https://example.com') }, ['url']),
    run: ({ url }, ctx) => {
      if (!/^[a-z]+:/i.test(url)) url = `https://${url}`;
      return { opened: launch(ctx, url, 'Open website', url) };
    },
  },
  {
    name: 'web_search',
    description: 'Open a Google search (or images/news/YouTube search) for a query on the phone. Use when the user asks to search, or for live info you do not know.',
    parameters: obj({
      query: S('What to search for'),
      type: S('Kind of search', { enum: ['web', 'images', 'news', 'youtube'] }),
    }, ['query']),
    run: ({ query, type = 'web' }, ctx) => {
      const q = encodeURIComponent(query);
      const url = {
        web: `https://www.google.com/search?q=${q}`,
        images: `https://www.google.com/search?tbm=isch&q=${q}`,
        news: `https://www.google.com/search?tbm=nws&q=${q}`,
        youtube: `https://www.youtube.com/results?search_query=${q}`,
      }[type] || `https://www.google.com/search?q=${q}`;
      return { opened: launch(ctx, url, `Search: ${query}`, type) };
    },
  },
  {
    name: 'open_app',
    description: `Open an app on the phone. Known apps: ${Object.keys(APPS).join(', ')}.`,
    parameters: obj({ app_name: S('Name of the app') }, ['app_name']),
    run: ({ app_name }, ctx) => {
      const key = String(app_name).toLowerCase().trim();
      const url = APPS[key] || APPS[key.replace(/^google /, '')] ||
        Object.entries(APPS).find(([k]) => key.includes(k))?.[1];
      if (!url) return { error: `I don't have a shortcut for "${app_name}". Try open_website with its site.` };
      return { opened: launch(ctx, url, `Open ${app_name}`) };
    },
  },
  {
    name: 'find_contact',
    description: 'Look up a phone number by name in the contacts the user saved in Jarvis settings. Use before calling or messaging someone by name.',
    parameters: obj({ name: S('Contact name') }, ['name']),
    run: ({ name }, ctx) => {
      const all = parseContacts(ctx.settings.contacts);
      const q = name.toLowerCase();
      const hits = all.filter(c => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
      if (!hits.length) return { found: false, note: 'Not in saved contacts. Ask the user for the number, or tell them to add it in Jarvis settings > Contacts.' };
      return { found: true, matches: hits };
    },
  },
  {
    name: 'make_call',
    description: 'Start a phone call to a number (opens the dialer).',
    parameters: obj({ phone_number: S('Phone number with country code if known'), name: S('Who is being called') }, ['phone_number']),
    run: ({ phone_number, name }, ctx) => {
      const n = cleanNumber(phone_number);
      return { opened: launch(ctx, `tel:${n}`, `Call ${name || n}`, n) };
    },
  },
  {
    name: 'send_sms',
    description: 'Compose a text message (SMS) to a number. The user taps send.',
    parameters: obj({ phone_number: S('Recipient number'), message: S('Message text') }, ['phone_number', 'message']),
    run: ({ phone_number, message }, ctx) => {
      const n = cleanNumber(phone_number);
      return { opened: launch(ctx, `sms:${n}?body=${encodeURIComponent(message)}`, `SMS to ${n}`, message) };
    },
  },
  {
    name: 'send_whatsapp',
    description: 'Compose a WhatsApp message. If no number is given, WhatsApp asks the user to pick a chat.',
    parameters: obj({ phone_number: S('Recipient number with country code, digits only, e.g. 919876543210'), message: S('Message text') }, ['message']),
    run: ({ phone_number, message }, ctx) => {
      const n = cleanNumber(phone_number).replace(/^\+/, '');
      const url = `https://wa.me/${n}?text=${encodeURIComponent(message)}`;
      return { opened: launch(ctx, url, `WhatsApp${n ? ' to ' + n : ''}`, message) };
    },
  },
  {
    name: 'send_email',
    description: 'Compose an email in the mail app.',
    parameters: obj({ to: S('Recipient email'), subject: S('Subject'), body: S('Body text') }, ['to']),
    run: ({ to, subject = '', body = '' }, ctx) => {
      const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      return { opened: launch(ctx, url, `Email ${to}`, subject) };
    },
  },
  {
    name: 'navigate',
    description: 'Start Google Maps directions to a destination, or show a place on the map.',
    parameters: obj({
      destination: S('Place or address'),
      mode: S('Travel mode', { enum: ['driving', 'walking', 'bicycling', 'transit', 'show'] }),
    }, ['destination']),
    run: ({ destination, mode = 'driving' }, ctx) => {
      const d = encodeURIComponent(destination);
      const url = mode === 'show'
        ? `https://www.google.com/maps/search/?api=1&query=${d}`
        : `https://www.google.com/maps/dir/?api=1&destination=${d}&travelmode=${mode}`;
      return { opened: launch(ctx, url, `Directions to ${destination}`, mode) };
    },
  },
  {
    name: 'play_media',
    description: 'Play a song, video, artist or podcast on YouTube, YouTube Music or Spotify.',
    parameters: obj({
      query: S('Song / video / artist'),
      platform: S('Where to play', { enum: ['youtube', 'youtube_music', 'spotify'] }),
    }, ['query']),
    run: ({ query, platform }, ctx) => {
      platform = platform || ctx.settings.musicApp || 'youtube';
      const q = encodeURIComponent(query);
      const url = {
        youtube: `https://www.youtube.com/results?search_query=${q}`,
        youtube_music: `https://music.youtube.com/search?q=${q}`,
        spotify: `https://open.spotify.com/search/${q}`,
      }[platform];
      return { opened: launch(ctx, url, `Play: ${query}`, platform.replace('_', ' ')) };
    },
  },
  {
    name: 'get_weather',
    description: 'Get current weather and a 3-day forecast. Uses the phone location if no place is given.',
    parameters: obj({ location: S('City or place name (optional)') }),
    run: async ({ location }, ctx) => {
      let lat, lon, place = location;
      if (location) {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`, { signal: ctx.signal }).then(r => r.json());
        const hit = g.results?.[0];
        if (!hit) return { error: `Couldn't find a place called ${location}` };
        ({ latitude: lat, longitude: lon } = hit);
        place = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
      } else {
        ({ lat, lon } = await getPosition());
        place = 'your location';
      }
      const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3',
      { signal: ctx.signal }).then(r => r.json());
      const c = w.current;
      return {
        place,
        now: {
          temp_c: c.temperature_2m, feels_like_c: c.apparent_temperature, humidity_pct: c.relative_humidity_2m,
          wind_kmh: c.wind_speed_10m, conditions: WMO[c.weather_code] || 'unknown',
        },
        forecast: w.daily.time.map((day, i) => ({
          day, conditions: WMO[w.daily.weather_code[i]] || 'unknown',
          max_c: w.daily.temperature_2m_max[i], min_c: w.daily.temperature_2m_min[i],
          rain_chance_pct: w.daily.precipitation_probability_max[i],
        })),
      };
    },
  },
  {
    name: 'get_location',
    description: "Get the phone's current GPS location and the nearest place name.",
    parameters: obj({}),
    run: async (_, ctx) => {
      const p = await getPosition();
      let address;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${p.lat}&lon=${p.lon}`, { signal: ctx.signal }).then(r => r.json());
        address = r.display_name;
      } catch { }
      return { ...p, address, map: `https://maps.google.com/?q=${p.lat},${p.lon}` };
    },
  },
  {
    name: 'set_timer',
    description: 'Set a countdown timer. Jarvis announces it when done (the Jarvis app must stay open).',
    parameters: obj({ seconds: N('Duration in seconds'), label: S('What the timer is for') }, ['seconds']),
    run: ({ seconds, label = 'Timer' }, ctx) => {
      const ms = Math.max(1, Number(seconds)) * 1000;
      const id = Math.random().toString(36).slice(2, 7);
      const handle = setTimeout(() => { timers.delete(id); ctx.alert('Timer done', label); }, ms);
      timers.set(id, { label, due: Date.now() + ms, handle });
      ctx.ui.timersChanged?.();
      return { ok: true, id, label, ends_at: new Date(Date.now() + ms).toLocaleTimeString() };
    },
  },
  {
    name: 'list_or_cancel_timers',
    description: 'List running timers, or cancel one (by id) or all of them.',
    parameters: obj({ cancel: S('Timer id to cancel, or "all". Omit to just list.') }),
    run: ({ cancel }, ctx) => {
      if (cancel) {
        for (const [id, t] of timers) if (cancel === 'all' || cancel === id) { clearTimeout(t.handle); timers.delete(id); }
        ctx.ui.timersChanged?.();
      }
      return { timers: [...timers].map(([id, t]) => ({ id, label: t.label, seconds_left: Math.round((t.due - Date.now()) / 1000) })) };
    },
  },
  {
    name: 'set_reminder',
    description: 'Remind the user about something at a specific local date/time. Jarvis announces it while the app is open; set add_to_calendar=true for a reliable phone notification via Google Calendar.',
    parameters: obj({
      text: S('What to remind about'),
      when: S('Local date-time in ISO format, e.g. 2026-11-24T09:00'),
      add_to_calendar: B('Also create a Google Calendar event'),
    }, ['text', 'when']),
    run: ({ text, when, add_to_calendar }, ctx) => {
      const d = parseWhen(when);
      const list = store.get('reminders', []);
      list.push({ text, due: d.getTime() });
      store.set('reminders', list);
      if (add_to_calendar) {
        const end = new Date(d.getTime() + 15 * 60000);
        launch(ctx, `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(text)}&dates=${gcalStamp(d)}/${gcalStamp(end)}&ctz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`, 'Add reminder to Calendar', text);
      }
      return { ok: true, text, at: d.toLocaleString() };
    },
  },
  {
    name: 'list_reminders',
    description: 'List upcoming reminders, or delete them.',
    parameters: obj({ delete_all: B('Delete all reminders') }),
    run: ({ delete_all }) => {
      if (delete_all) store.set('reminders', []);
      return { reminders: store.get('reminders', []).map(r => ({ text: r.text, at: new Date(r.due).toLocaleString() })) };
    },
  },
  {
    name: 'add_calendar_event',
    description: 'Create a Google Calendar event (opens a pre-filled event for the user to save).',
    parameters: obj({
      title: S('Event title'),
      start: S('Local start date-time ISO, e.g. 2026-11-24T15:00'),
      end: S('Local end date-time ISO (optional, default 1 hour)'),
      location: S('Location'),
      details: S('Description'),
    }, ['title', 'start']),
    run: ({ title, start, end, location = '', details = '' }, ctx) => {
      const s = parseWhen(start);
      const e = end ? parseWhen(end) : new Date(s.getTime() + 3600000);
      const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}` +
        `&dates=${gcalStamp(s)}/${gcalStamp(e)}&location=${encodeURIComponent(location)}&details=${encodeURIComponent(details)}` +
        `&ctz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
      return { opened: launch(ctx, url, `Event: ${title}`, s.toLocaleString()) };
    },
  },
  {
    name: 'notes',
    description: 'Save, list, search or delete notes and to-do items kept on the phone.',
    parameters: obj({
      action: S('What to do', { enum: ['add', 'list', 'delete', 'clear'] }),
      text: S('Note text (for add) or search words (for list)'),
      index: N('1-based note number (for delete)'),
    }, ['action']),
    run: ({ action, text, index }, ctx) => {
      let notes = store.get('notes', []);
      if (action === 'add') {
        notes.push({ text, at: new Date().toISOString() });
        store.set('notes', notes);
        ctx.ui.card('Note saved', text, []);
        return { ok: true, count: notes.length };
      }
      if (action === 'delete') {
        const removed = notes.splice(Number(index) - 1, 1);
        store.set('notes', notes);
        return removed.length ? { ok: true, removed: removed[0].text } : { error: 'No such note' };
      }
      if (action === 'clear') { store.set('notes', []); return { ok: true }; }
      const q = (text || '').toLowerCase();
      return { notes: notes.map((n, i) => ({ n: i + 1, text: n.text, saved: n.at.slice(0, 10) })).filter(n => !q || n.text.toLowerCase().includes(q)) };
    },
  },
  {
    name: 'remember',
    description: 'Permanently remember a fact about the user (name, preferences, people, places). Also use action=forget to remove one.',
    parameters: obj({ fact: S('The fact to remember or forget'), action: S('remember or forget', { enum: ['remember', 'forget'] }) }, ['fact']),
    run: ({ fact, action = 'remember' }) => {
      let mem = store.get('memory', []);
      if (action === 'forget') {
        const q = fact.toLowerCase();
        const before = mem.length;
        mem = mem.filter(m => !m.toLowerCase().includes(q) && !q.includes(m.toLowerCase()));
        store.set('memory', mem);
        return { ok: true, removed: before - mem.length };
      }
      if (!mem.includes(fact)) mem.push(fact);
      store.set('memory', mem.slice(-100));
      return { ok: true };
    },
  },
  {
    name: 'device_status',
    description: 'Get phone battery level, charging state and network status.',
    parameters: obj({}),
    run: async () => {
      const out = { online: navigator.onLine };
      try {
        const b = await navigator.getBattery();
        out.battery_pct = Math.round(b.level * 100);
        out.charging = b.charging;
      } catch { out.battery = 'unavailable'; }
      const c = navigator.connection;
      if (c) out.network = { type: c.type || c.effectiveType, downlink_mbps: c.downlink };
      return out;
    },
  },
  {
    name: 'flashlight',
    description: 'Turn the phone flashlight (torch) on or off.',
    parameters: obj({ on: B('true to turn on, false to turn off') }, ['on']),
    run: ({ on }) => setTorch(!!on),
  },
  {
    name: 'vibrate',
    description: 'Vibrate the phone, e.g. to help find it.',
    parameters: obj({ seconds: N('How long') }),
    run: ({ seconds = 1 }) => ({ ok: !!navigator.vibrate?.(Math.min(10, seconds) * 1000) }),
  },
  {
    name: 'copy_to_clipboard',
    description: 'Copy text to the clipboard.',
    parameters: obj({ text: S('Text to copy') }, ['text']),
    run: async ({ text }, ctx) => {
      try { await navigator.clipboard.writeText(text); return { ok: true }; } catch {
        ctx.ui.card('Copy text', text, [{ label: 'Copy', onClick: () => navigator.clipboard.writeText(text) }]);
        return { ok: false, note: 'Shown a Copy button for the user to tap' };
      }
    },
  },
  {
    name: 'share_text',
    description: 'Share text or a link to another app via the phone share sheet.',
    parameters: obj({ text: S('Text to share'), url: S('Optional link') }, ['text']),
    run: ({ text, url }, ctx) => {
      ctx.ui.card('Share', text, [{ label: 'Share', onClick: () => navigator.share?.({ text, url }) }]);
      return { ok: true, note: 'Share button shown; the user taps it to choose an app' };
    },
  },
  {
    name: 'ask_openjarvis',
    description: "Send a task to the OpenJarvis agent running on the user's computer (it has its own tools: files, code, web research, scheduled agents, messaging). Use for heavy or computer-side tasks.",
    parameters: obj({ task: S('Full description of the task') }, ['task']),
    available: (s) => openJarvisAvailable(s),
    run: async ({ task }, ctx) => ({ result: await askOpenJarvis(ctx.settings, task, ctx.signal) }),
  },
];

export function toolsFor(settings) {
  return TOOLS.filter(t => !t.available || t.available(settings));
}

export async function runTool(name, args, ctx) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { error: `Unknown tool ${name}` };
  try {
    return (await tool.run(args || {}, ctx)) ?? { ok: true };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { error: String(e.message || e) };
  }
}

export function activeTimers() {
  return [...timers.values()];
}
