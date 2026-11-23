// Bridge to the Android app (window.JarvisNative is injected by the app's WebView).
// In a normal browser NATIVE is null and everything falls back to web APIs.

export const NATIVE = window.JarvisNative || null;
export const IS_BUBBLE = new URLSearchParams(location.search).has('bubble');

const pending = new Map();
let seq = 0;

// Kotlin calls back: window.__jarvisNative("<id>", "<json>")
window.__jarvisNative = (id, json) => {
  const resolve = pending.get(String(id));
  if (!resolve) return;
  pending.delete(String(id));
  let data;
  try { data = JSON.parse(json); } catch { data = { error: 'Bad response from app' }; }
  resolve(data);
};

/** Call an async native method: NATIVE[method](callbackId, ...args) → Promise<object> */
export function nativeCall(method, ...args) {
  if (!NATIVE || typeof NATIVE[method] !== 'function') return Promise.reject(new Error(`Not available: ${method}`));
  const id = String(++seq);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    NATIVE[method](id, ...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a ?? null))));
  });
}

/** Synchronous native call that returns JSON. */
export function nativeSync(method, ...args) {
  if (!NATIVE || typeof NATIVE[method] !== 'function') return null;
  try {
    const out = NATIVE[method](...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a ?? null))));
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
}

/** fetch() replacement that runs in the app (no CORS limits, keeps working in background). */
export async function nativeFetch(url, { method = 'GET', headers = {}, body = '', signal } = {}) {
  const job = nativeCall('http', url, method, headers, body || '');
  const res = await (signal
    ? Promise.race([job, new Promise((_, rej) => {
      if (signal.aborted) rej(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true });
    })])
    : job);
  if (res.error) throw new TypeError(res.error);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: '',
    text: async () => res.body,
    json: async () => JSON.parse(res.body),
  };
}

// ------------------------------------------------------------ speech recognition shim
// Mimics the Web Speech API (webkitSpeechRecognition) on top of Android's SpeechRecognizer.

let activeRec = null;
window.__jarvisSpeech = (json) => {
  const ev = JSON.parse(json);
  const r = activeRec;
  if (!r) return;
  if (ev.type === 'result') {
    r.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: ev.text }], { isFinal: !!ev.final })] });
  } else if (ev.type === 'error') {
    r.onerror?.({ error: ev.error });
  } else if (ev.type === 'end') {
    activeRec = null;
    r.onend?.();
  } else if (ev.type === 'start') {
    r.onstart?.();
  }
};

export class NativeSpeechRecognition {
  constructor() { this.lang = 'en-US'; this.continuous = false; this.interimResults = true; this.maxAlternatives = 1; }
  start() {
    activeRec = this;
    NATIVE.startListening(this.lang, !!this.continuous);
  }
  stop() { NATIVE.stopListening(); }
  abort() {
    if (activeRec === this) activeRec = null;
    NATIVE.stopListening();
  }
}

// ------------------------------------------------------------ text to speech

const ttsDone = new Map();
window.__jarvisTts = (id) => { ttsDone.get(String(id))?.(); ttsDone.delete(String(id)); };

export function nativeSpeak(text, lang, rate, voice) {
  const id = String(++seq);
  return new Promise((resolve) => {
    ttsDone.set(id, resolve);
    NATIVE.speak(id, text, lang || '', String(rate || 1), voice || '');
  });
}
export function nativeStopSpeaking() {
  NATIVE?.stopSpeaking();
  for (const [, resolve] of ttsDone) resolve();
  ttsDone.clear();
}
