// "Check for updates" in Settings → About.
// Android app: reads version.json from the latest GitHub release, downloads the APK and opens the installer.
// Browser: reloads the newest files from the server.

import { NATIVE, IS_BUBBLE, nativeCall, nativeFetch, nativeSync } from './native.js';
import { store } from './tools.js';

const $ = (s) => document.querySelector(s);
const CHECK_EVERY_MS = 60 * 60 * 1000;

let app = null;      // this install: { versionName, versionCode, sha, installedAt, manifestUrl, canInstall }
let latest = null;   // version.json from the release: { versionCode, build, sha, notes, date, size }
let busy = false;
let resumeInstall = false;
let onAvailable = () => { };

const isNewer = () => !!(app && latest && latest.versionCode > app.versionCode);

function buildLabel(code) { return code >= 100 ? `Build #${code - 100}` : 'Developer build'; }

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function status(tone, title, detail = '') {
  const el = $('#upd-status');
  if (!el) return;
  el.dataset.tone = tone;
  $('#upd-title').textContent = title;
  $('#upd-detail').textContent = detail;
}

function progress(pct) {
  const bar = $('#upd-progress');
  if (pct == null) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.classList.toggle('indeterminate', pct < 0);
  bar.firstElementChild.style.width = pct < 0 ? '' : `${pct}%`;
}

function button(label, disabled = false) {
  const b = $('#btn-update');
  b.textContent = label;
  b.disabled = disabled;
}

function renderNotes() {
  const box = $('#upd-notes');
  if (!isNewer() || !latest.notes) { box.hidden = true; return; }
  const [title, ...rest] = latest.notes.trim().split('\n');
  box.hidden = false;
  box.replaceChildren();
  const h = document.createElement('b');
  h.textContent = `What's new: ${title}`;
  const body = document.createElement('p');
  body.textContent = rest.join('\n').trim();
  box.append(h);
  if (body.textContent) box.append(body);
}

function renderKV() {
  const kv = $('#app-kv');
  if (!kv) return;
  const rows = NATIVE && app
    ? [
      ['Build', buildLabel(app.versionCode)],
      ['Commit', app.sha],
      ['Installed', `${new Date(app.installedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} (${ago(app.installedAt)})`],
      ['Running as', 'Android app'],
    ]
    : [['Running as', 'Web app'], ['Address', location.host || 'local file']];
  const lastCheck = store.get('update.checkedAt', 0);
  if (NATIVE && lastCheck) rows.push(['Last checked', ago(lastCheck)]);
  kv.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

function render() {
  renderKV();
  renderNotes();
  if (busy) return;
  progress(null);
  if (!NATIVE) {
    status('idle', 'Web version', 'reload to get the newest files from the server');
    button('Reload latest');
    return;
  }
  if (!latest) {
    status('idle', 'Not checked yet', 'tap Check for updates');
    button('Check for updates');
  } else if (isNewer()) {
    const size = latest.size ? ` · ${(latest.size / 1048576).toFixed(1)} MB` : '';
    status('new', 'Update available', `${buildLabel(latest.versionCode)} · ${ago(Date.parse(latest.date))}${size}`);
    button('Update now');
  } else {
    status('ok', 'You\'re up to date', `${buildLabel(app.versionCode)} is the latest`);
    button('Check again');
  }
  onAvailable(isNewer());
}

export async function checkForUpdates({ quiet = false } = {}) {
  if (!NATIVE || busy) return null;
  app = nativeSync('appInfo') || app;
  if (!app) return null;
  if (!quiet) { busy = true; status('busy', 'Checking…', 'asking GitHub for the latest build'); button('Checking…', true); }
  try {
    const res = await nativeFetch(`${app.manifestUrl}?t=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) throw new Error('No published build yet.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    latest = await res.json();
    store.set('update.latest', latest);
    store.set('update.checkedAt', Date.now());
  } catch (e) {
    if (!quiet) {
      busy = false;
      status('error', 'Couldn\'t check for updates', e.message?.startsWith('Network') ? 'check your internet connection' : e.message || String(e));
      button('Try again');
      renderKV();
      return null;
    }
  }
  busy = false;
  render();
  return isNewer();
}

async function install() {
  busy = true;
  button('Downloading…', true);
  status('busy', 'Downloading update…', buildLabel(latest.versionCode));
  progress(-1);
  window.__jarvisUpdate = (pct) => {
    progress(pct);
    if (pct >= 0) $('#upd-detail').textContent = `${pct}% downloaded`;
  };
  const res = await nativeCall('installUpdate', '');
  busy = false;
  window.__jarvisUpdate = null;
  if (res.ok) {
    progress(100);
    status('ok', 'Ready to install', 'tap Install on Android\'s screen. Jarvis restarts by itself.');
    button('Install again');
    return;
  }
  progress(null);
  if (res.needsPermission) {
    resumeInstall = true;
    status('warn', 'One-time permission needed', 'turn on “Allow from this source” for Jarvis, then come back');
    button('Update now');
  } else if (res.upToDate) {
    latest = { ...latest, versionCode: app.versionCode };
    render();
  } else {
    status('error', 'Update failed', res.error || 'please try again');
    button('Try again');
  }
}

async function onButton() {
  if (!NATIVE) {
    button('Reloading…', true);
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all(regs.map(r => r.update().catch(() => { })));
      const keys = await caches?.keys?.() || [];
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch { }
    location.reload();
    return;
  }
  if (isNewer()) return install();
  checkForUpdates();
}

/** Wire up the About tab. `notify(available)` lets the app show a dot / message. */
export function initUpdates({ notify, settings }) {
  onAvailable = notify || onAvailable;
  if (NATIVE) {
    app = nativeSync('appInfo');
    latest = store.get('update.latest', null);
  }
  $('#btn-update')?.addEventListener('click', onButton);
  render();

  // Coming back from Android's "Install unknown apps" screen: carry on with the install.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !resumeInstall || !NATIVE) return;
    app = nativeSync('appInfo') || app;
    if (app?.canInstall) { resumeInstall = false; install(); }
  });

  // Quiet check on launch (main app only, at most once an hour).
  if (NATIVE && !IS_BUBBLE && settings.autoUpdateCheck !== false
    && Date.now() - store.get('update.checkedAt', 0) > CHECK_EVERY_MS) {
    setTimeout(() => checkForUpdates({ quiet: true }), 3000);
  }
}

export const refreshAbout = render;
