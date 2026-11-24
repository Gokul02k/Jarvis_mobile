// LLM adapters. Every provider takes a neutral message list and returns { text, toolCalls, geminiParts? }.
//
// Neutral messages:
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, args }], geminiParts? }
//   { role: 'tool', toolCallId, name, content }

import { NATIVE, nativeFetch } from './native.js';

// ------------------------------------------------------------------ providers
// kind: 'gemini' | 'anthropic' | 'openai' (OpenAI-compatible chat completions).
// keyField / modelField: where the key and model live in settings. A blank model is picked automatically.
// server: name of the Jarvis server proxy route, for providers the server can hold keys for.

export const PROVIDERS = {
  gemini: {
    label: 'Gemini', kind: 'gemini', base: 'https://generativelanguage.googleapis.com', server: 'gemini',
    keyField: 'geminiKey', modelField: 'geminiModel', keyPattern: /^AIza/, keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey', note: 'Free tier',
  },
  openai: {
    label: 'OpenAI', kind: 'openai', base: 'https://api.openai.com',
    keyField: 'openaiKey', modelField: 'openaiModel', keyPattern: /^sk-/, keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys', note: 'Paid',
  },
  claude: {
    label: 'Claude', kind: 'anthropic', base: 'https://api.anthropic.com',
    keyField: 'claudeKey', modelField: 'claudeModel', keyPattern: /^sk-ant-/, keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys', note: 'Paid',
  },
  grok: {
    label: 'Grok', kind: 'openai', base: 'https://api.x.ai', server: 'xai',
    keyField: 'xaiKey', modelField: 'grokModel', keyPattern: /^xai-/, keyHint: 'xai-…',
    keyUrl: 'https://console.x.ai', note: 'Paid',
  },
  groq: {
    label: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai',
    keyField: 'groqKey', modelField: 'groqModel', keyPattern: /^gsk_/, keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys', note: 'Free tier · very fast',
  },
  openrouter: {
    label: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api',
    keyField: 'openrouterKey', modelField: 'openrouterModel', keyPattern: /^sk-or-/, keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys', note: 'Many models, some free',
  },
  deepseek: {
    label: 'DeepSeek', kind: 'openai', base: 'https://api.deepseek.com',
    keyField: 'deepseekKey', modelField: 'deepseekModel', keyPattern: /^sk-/, keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys', note: 'Paid · cheap',
  },
  mistral: {
    label: 'Mistral', kind: 'openai', base: 'https://api.mistral.ai',
    keyField: 'mistralKey', modelField: 'mistralModel', keyPattern: null, keyHint: 'your Mistral key',
    keyUrl: 'https://console.mistral.ai/api-keys', note: 'Free tier',
  },
  custom: {
    label: 'Custom', kind: 'openai', base: null, urlField: 'customUrl',
    keyField: 'customKey', modelField: 'customModel', keyPattern: null, keyHint: 'optional',
    keyUrl: '', note: 'Any OpenAI-compatible server', keyOptional: true,
  },
  openjarvis: {
    label: 'OpenJarvis', kind: 'openai', base: null, urlField: 'ojUrl', server: 'openjarvis',
    keyField: 'ojKey', modelField: 'ojModel', keyPattern: null, keyHint: 'optional',
    keyUrl: '', note: 'Your computer', keyOptional: true,
  },
};

export const providerOf = (s) => PROVIDERS[s.provider] || PROVIDERS.gemini;
export const modelOf = (s, id = s.provider) => s[(PROVIDERS[id] || PROVIDERS.gemini).modelField] || '';

/** True when this provider can be used: a key on the phone (or the server), or a URL for keyless ones. */
export function hasCredentials(s, id) {
  const p = PROVIDERS[id];
  if (!p) return false;
  if (p.server && s._server?.[p.server]) return true;
  if (p.urlField) return !!s[p.urlField];
  return !!cleanKey(s[p.keyField]);
}

// Pasted keys often carry spaces, line breaks, quotes or a "Bearer " prefix.
export function cleanKey(k) {
  return String(k || '').replace(/^\s*(bearer|key)\s*[:=]?\s*/i, '').replace(/["'`\s​-‍﻿]/g, '');
}

export function serverBase(s) {
  return (s.serverUrl || location.origin).replace(/\/+$/, '');
}

function useServer(s, p) {
  if (!p.server) return false;
  if (s.connection === 'server') return true;
  if (s.connection === 'direct') return false;
  // auto: use the server if it has credentials for this provider and the phone has none
  if (!s._server?.[p.server]) return false;
  return p.urlField ? true : !cleanKey(s[p.keyField]);
}

function endpoint(s, id) {
  const p = PROVIDERS[id];
  if (useServer(s, p)) return { base: `${serverBase(s)}/api/${p.server}`, viaServer: true };
  if (p.urlField) {
    const url = (s[p.urlField] || '').trim();
    if (!url) throw new Error(`Set the ${p.label} URL in Settings → Brain.`);
    return { base: url.replace(/\/+$/, '').replace(/\/v1$/, ''), viaServer: false };
  }
  return { base: p.base, viaServer: false };
}

function headersFor(s, id, viaServer) {
  const p = PROVIDERS[id];
  const key = cleanKey(s[p.keyField]);
  const h = { 'Content-Type': 'application/json' };
  if (viaServer) {
    if (s.serverToken) h['X-Jarvis-Token'] = s.serverToken;
    if (key && id !== 'openjarvis') addAuth(h, p, key);
    return h;
  }
  if (!key && !p.keyOptional) throw new Error(`No ${p.label} API key. Add one in Settings → Brain.`);
  if (key) addAuth(h, p, key);
  return h;
}

function addAuth(h, p, key) {
  if (p.kind === 'gemini') h['x-goog-api-key'] = key;
  else if (p.kind === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
    if (!NATIVE) h['anthropic-dangerous-direct-browser-access'] = 'true';
  } else h['Authorization'] = `Bearer ${key}`;
  if (p === PROVIDERS.openrouter) h['X-Title'] = 'Jarvis';
}

async function request(url, opts) {
  let res;
  try {
    res = await (NATIVE ? nativeFetch(url, opts) : fetch(url, opts));
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Network error reaching ${new URL(url).host}. ${location.protocol === 'https:' && url.startsWith('http:') ? 'An HTTPS page cannot call an HTTP address; route it through the Jarvis server.' : 'Check your connection, or use the Jarvis server as a proxy.'}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || data?.detail || data?.raw || res.statusText;
    const err = new Error(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 400));
    err.status = res.status;
    throw err;
  }
  return data;
}

const MODEL_MISSING = /not.?found|does not exist|unknown model|invalid model|no such model|not supported|model_not_found|decommissioned/i;

// ---------------------------------------------------------------- Gemini

function toGemini(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.geminiParts?.length) { out.push({ role: 'model', parts: m.geminiParts }); continue; }
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls || []) parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
      if (parts.length) out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name, response: { result: m.content } } };
      if (m.toolCallId && !m.toolCallId.startsWith('call_local_')) part.functionResponse.id = m.toolCallId;
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.parts.every(p => p.functionResponse)) last.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
    }
  }
  return out;
}

// Settings to try, fastest first; null = the model's default. Voice replies should not "think" for long.
function thinkingFor(model) {
  if (/^gemini-2\.5-flash/.test(model)) return [{ thinkingBudget: 0 }, null]; // off
  if (/^gemini-2\.5-pro/.test(model)) return [{ thinkingBudget: 128 }, null]; // pro can't turn it off; use the minimum
  if (/^gemini-[3-9].*flash/.test(model)) return [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, null];
  if (/^gemini-[3-9]/.test(model)) return [{ thinkingLevel: 'low' }, null];
  return [null];
}

async function geminiChat(s, model, { system, messages, tools, signal }) {
  const { base, viaServer } = endpoint(s, 'gemini');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGemini(messages),
    generationConfig: { temperature: 0.6, maxOutputTokens: 1024 },
  };
  const thinking = thinkingFor(model);
  if (thinking[0]) body.generationConfig.thinkingConfig = thinking[0];
  if (tools?.length) {
    body.tools = [{
      functionDeclarations: tools.map(t => {
        const d = { name: t.name, description: t.description };
        if (t.parameters && Object.keys(t.parameters.properties || {}).length) d.parameters = t.parameters;
        return d;
      }),
    }];
  }
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const headers = headersFor(s, 'gemini', viaServer);
  let data;
  try {
    data = await request(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    // A model that rejects the thinking setting: step to the next one (finally, the model's default).
    let err = e;
    for (const next of thinking.slice(1)) {
      if (!(err.status === 400 && /think/i.test(err.message))) throw err;
      if (next) body.generationConfig.thinkingConfig = next; else delete body.generationConfig.thinkingConfig;
      try { data = await request(url, { method: 'POST', headers, body: JSON.stringify(body), signal }); err = null; break; } catch (e2) { err = e2; }
    }
    if (err) throw err;
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(reason ? `Gemini blocked the request (${reason}).` : 'Gemini returned no answer.');
  }
  const parts = cand.content?.parts || [];
  const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
  const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({
    id: p.functionCall.id || `call_local_${Date.now()}_${i}`,
    name: p.functionCall.name,
    args: p.functionCall.args || {},
  }));
  return { text, toolCalls, geminiParts: parts };
}

async function geminiModels(s) {
  const { base, viaServer } = endpoint(s, 'gemini');
  const data = await request(`${base}/v1beta/models?pageSize=200`, { headers: headersFor(s, 'gemini', viaServer) });
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(id => /^gemini/.test(id) && !/embed|image|tts|audio|live|robotics|computer/.test(id));
}

// ---------------------------------------------------------------- Claude (Anthropic Messages API)

function toAnthropic(messages) {
  const out = [];
  const push = (role, block) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', { type: 'text', text: m.content || ' ' });
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) push('assistant', { type: 'tool_use', id: safeId(tc.id), name: tc.name, input: tc.args || {} });
    } else if (m.role === 'tool') {
      push('user', { type: 'tool_result', tool_use_id: safeId(m.toolCallId), content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
  }
  return out;
}
const safeId = (id) => String(id || 'call').replace(/[^a-zA-Z0-9_-]/g, '_');

async function anthropicChat(s, model, { system, messages, tools, signal }) {
  const { base, viaServer } = endpoint(s, 'claude');
  const body = { model, max_tokens: 1024, temperature: 0.6, system, messages: toAnthropic(messages) };
  if (tools?.length) {
    body.tools = tools.map(t => ({
      name: t.name, description: t.description,
      input_schema: t.parameters || { type: 'object', properties: {} },
    }));
  }
  const data = await request(`${base}/v1/messages`, {
    method: 'POST', headers: headersFor(s, 'claude', viaServer), body: JSON.stringify(body), signal,
  });
  const blocks = data.content || [];
  return {
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim(),
    toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })),
  };
}

// ------------------------------------------------- OpenAI-compatible (OpenAI, Grok, Groq, OpenRouter, …)

function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
  }
  return out;
}

async function openaiChat(s, id, model, { system, messages, tools, signal }) {
  const { base, viaServer } = endpoint(s, id);
  const headers = headersFor(s, id, viaServer);
  const body = { model, messages: toOpenAI(system, messages) };
  // Reasoning models (o-series, gpt-5) only accept the default temperature.
  if (!(id === 'openai' && /^(o\d|gpt-5)/.test(model))) body.temperature = 0.6;
  if (tools?.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } },
    }));
    body.tool_choice = 'auto';
  }
  const url = `${base}/v1/chat/completions`;
  let data;
  try {
    data = await request(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    // Some models / local servers don't accept tools; retry without them.
    const noTools = body.tools && ([400, 404, 422].includes(e.status) && /tool|function/i.test(e.message)
      || (id === 'openjarvis' && e.status >= 400 && e.status < 500));
    if (!noTools) throw e;
    delete body.tools; delete body.tool_choice;
    data = await request(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map(tc => {
    let args = {};
    try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); } catch { }
    return { id: tc.id || `call_local_${Date.now()}`, name: tc.function.name, args };
  });
  return { text: (msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), toolCalls };
}

async function openaiModels(s, id) {
  const { base, viaServer } = endpoint(s, id);
  const data = await request(`${base}/v1/models`, { headers: headersFor(s, id, viaServer) });
  return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
}

// ------------------------------------------------------------ model choice

function versionScore(id) {
  const m = id.match(/(\d+(?:[.-]\d+)?)/);
  return m ? parseFloat(m[1].replace('-', '.')) : 0;
}

const newest = (list) => [...list].sort((a, b) => versionScore(b) - versionScore(a) || a.length - b.length);
const NOT_CHAT = /embed|image|vision-only|tts|whisper|transcri|audio|realtime|moderation|guard|dall-e|search|computer|codex|instruct|davinci|babbage|ocr/i;

/** Picks a fast, capable default from a provider's model list. */
export function pickModel(provider, ids) {
  if (!ids.length) return null;
  const pref = (...filters) => {
    let pool = ids.filter(id => !NOT_CHAT.test(id));
    for (const f of filters) { const next = pool.filter(f); if (next.length) pool = next; }
    return newest(pool)[0] || ids[0];
  };
  switch (provider) {
    case 'gemini': return pref(id => /flash/.test(id) && !/lite|thinking|exp/.test(id), id => !/preview/.test(id));
    case 'grok': return pref(id => /grok/.test(id) && !/image|vision|imagine|video/.test(id), id => /fast/.test(id), id => /non-reasoning/.test(id));
    case 'openai': return pref(id => /^gpt-/.test(id) && !/preview|audio|realtime|search/.test(id), id => /mini/.test(id) && !/nano/.test(id), id => !/\d{4}-\d\d-\d\d/.test(id));
    case 'claude': return pref(id => /haiku/.test(id), id => !/\d{8}$/.test(id));
    case 'groq': return pref(id => /llama|gpt-oss|qwen|kimi/.test(id), id => /versatile|gpt-oss-120b/.test(id));
    case 'openrouter': return pref(id => /:free$/.test(id), id => /llama|gemini|deepseek|qwen/.test(id));
    case 'deepseek': return ids.includes('deepseek-chat') ? 'deepseek-chat' : pref();
    case 'mistral': return pref(id => /small|medium/.test(id), id => /latest/.test(id));
    default: return ids[0];
  }
}

export async function listModels(s, provider) {
  const p = PROVIDERS[provider];
  if (!p) return [];
  if (p.kind === 'gemini') return geminiModels(s);
  if (p.kind === 'anthropic') {
    const { base, viaServer } = endpoint(s, provider);
    const data = await request(`${base}/v1/models?limit=100`, { headers: headersFor(s, provider, viaServer) });
    return (data.data || []).map(m => m.id);
  }
  return openaiModels(s, provider);
}

// ------------------------------------------------------------ public API

async function chatWith(s, id, model, req) {
  const p = PROVIDERS[id];
  if (p.kind === 'gemini') return geminiChat(s, model, req);
  if (p.kind === 'anthropic') return anthropicChat(s, model, req);
  return openaiChat(s, id, model, req);
}

// Fills in a blank model by asking the provider what it has.
async function ensureModel(s, id, onModelChange) {
  const p = PROVIDERS[id];
  if (s[p.modelField]) return s[p.modelField];
  const ids = await listModels(s, id).catch(() => []);
  const model = (id === 'openjarvis' || id === 'custom') ? ids[0] || 'default' : pickModel(id, ids);
  if (!model) throw new Error(`Couldn't find a ${p.label} model. Type one in Settings → Brain.`);
  s[p.modelField] = model;
  onModelChange?.(p.modelField, model);
  return model;
}

const BUSY = (e) => [429, 500, 502, 503, 504, 529].includes(e.status);
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// Gemini models this key can use, newest Flash first (asked once per app start).
const GEMINI_BACKUPS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash'];
let geminiIds = null;
async function geminiBackups(s) {
  if (!geminiIds) geminiIds = await geminiModels(s).catch(() => []);
  const usable = geminiIds.filter(id => /flash/.test(id) && !/thinking|exp|tts|image|live|audio/.test(id));
  const full = newest(usable.filter(id => !/lite/.test(id)));
  const stable = full.filter(id => !/preview/.test(id));
  const lite = newest(usable.filter(id => /lite/.test(id) && !/preview/.test(id)));
  return [...new Set([...stable.slice(0, 2), ...full.slice(0, 1), ...lite.slice(0, 1), ...GEMINI_BACKUPS])]
    .filter(id => id !== s.geminiModel);
}

// One provider: retry when busy; for Gemini, try other models (each has its own capacity and quota).
// Whichever model works becomes the setting, so the next request goes straight there.
async function chatProvider(s, id, req, onModelChange) {
  const p = PROVIDERS[id];
  let model = await ensureModel(s, id, onModelChange);
  try {
    return await chatWith(s, id, model, req);
  } catch (e) {
    // Retired model name: pick a current one.
    if ((e.status === 404 || ([400, 403].includes(e.status) && MODEL_MISSING.test(e.message))) && id !== 'openjarvis' && id !== 'custom') {
      const next = pickModel(id, await listModels(s, id).catch(() => []));
      if (!next || next === model) throw e;
      s[p.modelField] = next;
      onModelChange?.(p.modelField, next);
      return chatWith(s, id, next, req);
    }
    if (!BUSY(e)) throw e;
    if (e.status !== 429) {
      await sleep(900, req.signal);
      try { return await chatWith(s, id, model, req); } catch (e2) { if (!BUSY(e2)) throw e2; }
    }
    if (id !== 'gemini') throw e;
    for (const backup of await geminiBackups(s)) {
      try {
        const res = await chatWith(s, id, backup, req);
        s.geminiModel = backup;
        onModelChange?.('geminiModel', backup);
        return res;
      } catch (e3) {
        if (e3.name === 'AbortError') throw e3;
      }
    }
    throw e;
  }
}

// A different provider can't read another's tool-call history; give it the plain conversation.
function plainHistory(messages) {
  return messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => ({ role: m.role, content: m.content }));
}

/**
 * Chat with recovery: busy / out of quota / retired model on the chosen provider, then (if enabled)
 * the other providers you have keys for. onModelChange(key, value) is called when a setting changes;
 * onFallback(providerId) when another provider answered.
 */
export async function chat(s, req, onModelChange, onFallback) {
  try {
    return await chatProvider(s, s.provider, req, onModelChange);
  } catch (e) {
    if (e.name === 'AbortError' || !s.fallbackProviders || !e.status) throw e;
    const others = Object.keys(PROVIDERS).filter(id => id !== s.provider && id !== 'openjarvis' && id !== 'custom' && hasCredentials(s, id));
    for (const id of others) {
      try {
        const res = await chatProvider(s, id, { ...req, messages: plainHistory(req.messages) }, onModelChange);
        onFallback?.(id);
        return { ...res, fallback: id };
      } catch (e2) {
        if (e2.name === 'AbortError') throw e2;
      }
    }
    throw e;
  }
}

/** Turns an API error into a short sentence Jarvis can say out loud. */
export function explainError(e) {
  const msg = String(e?.message || e || '');
  if (/^No .*API key/i.test(msg)) return 'I don\'t have an API key for that provider yet. Add one in Settings, under Brain.';
  if (/API.?key not valid|API_KEY_INVALID|invalid api key|incorrect api key|invalid x-api-key|invalid_api_key|authentication/i.test(msg) || e?.status === 401) {
    return 'The AI rejected the API key. Please check it in Settings, under Brain.';
  }
  if (/credit|billing|spending limit|payment|insufficient.?(funds|balance|quota)|exceeded your current quota/i.test(msg)) {
    return 'Your AI account has no credits left. Add credits on the provider\'s website, or switch provider in Settings.';
  }
  if (e?.status === 429) {
    const wait = msg.match(/retry in ([\d.]+)\s*s/i);
    if (/per.?day|daily|PerDay/i.test(msg)) return 'You\'ve used up today\'s free AI requests. It resets tomorrow, or you can use a different key or provider.';
    return `The AI's usage limit was hit. Try again in ${wait ? Math.ceil(Number(wait[1])) + ' seconds' : 'a minute'}.`;
  }
  if (e?.status === 403) {
    const why = msg.replace(/^\d+:\s*/, '').split(/(?<=[.!?])\s/)[0].slice(0, 140);
    return `The AI refused the request: ${why}`;
  }
  if (BUSY(e)) return 'The AI service is overloaded right now. Please try again in a moment.';
  if (e?.status === 404 || (e?.status === 400 && MODEL_MISSING.test(msg))) return 'That AI model isn\'t available. Pick another one in Settings, under Brain.';
  if (/^Network error/i.test(msg)) return 'I can\'t reach the internet right now. Check your connection.';
  if (/^Set the .* URL/i.test(msg)) return msg;
  if (/blocked/i.test(msg)) return 'The AI refused to answer that one.';
  return 'Sorry, I ran into a problem reaching the AI.';
}

// Used by the ask_openjarvis tool: send a task to the OpenJarvis agent on your computer.
export async function askOpenJarvis(s, task, signal) {
  const res = await chatProvider(s, 'openjarvis', {
    system: 'You are OpenJarvis running on the user\'s computer. Complete the task and reply with the result concisely.',
    messages: [{ role: 'user', content: task }],
    tools: [],
    signal,
  });
  return res.text;
}

export function openJarvisAvailable(s) {
  return !!(s.ojUrl || s._server?.openjarvis);
}
