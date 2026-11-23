// LLM adapters: Gemini (Google), Grok (xAI) and OpenJarvis (OpenAI-compatible).
// All take a neutral message list and return { text, toolCalls, geminiParts }.
//
// Neutral messages:
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, args }], geminiParts? }
//   { role: 'tool', toolCallId, name, content }

const DIRECT = {
  gemini: 'https://generativelanguage.googleapis.com',
  xai: 'https://api.x.ai',
};

function useServer(s, backend) {
  if (s.connection === 'server') return true;
  if (s.connection === 'direct') return false;
  // auto: use the server if it has a key for this backend and the phone has none
  const info = s._server || {};
  if (backend === 'gemini') return !!info.gemini && !s.geminiKey;
  if (backend === 'xai') return !!info.xai && !s.xaiKey;
  if (backend === 'openjarvis') return !!info.openjarvis;
  return false;
}

function endpoint(s, backend) {
  if (useServer(s, backend)) {
    return { base: `${location.origin}/api/${backend}`, viaServer: true };
  }
  if (backend === 'openjarvis') {
    if (!s.ojUrl) throw new Error('Set the OpenJarvis URL in settings, or set OPENJARVIS_URL on the Jarvis server.');
    return { base: s.ojUrl.replace(/\/+$/, ''), viaServer: false };
  }
  return { base: DIRECT[backend], viaServer: false };
}

function headersFor(s, backend, viaServer) {
  const h = { 'Content-Type': 'application/json' };
  if (viaServer && s.serverToken) h['X-Jarvis-Token'] = s.serverToken;
  if (backend === 'gemini' && s.geminiKey) h['x-goog-api-key'] = s.geminiKey;
  if (backend === 'xai' && s.xaiKey) h['Authorization'] = `Bearer ${s.xaiKey}`;
  if (backend === 'openjarvis' && !viaServer && s.ojKey) h['Authorization'] = `Bearer ${s.ojKey}`;
  if (!viaServer) {
    if (backend === 'gemini' && !s.geminiKey) throw new Error('No Gemini API key. Add one in settings (or on the Jarvis server).');
    if (backend === 'xai' && !s.xaiKey) throw new Error('No Grok (xAI) API key. Add one in settings (or on the Jarvis server).');
  }
  return h;
}

async function request(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`Network error reaching ${new URL(url).host}. ${location.protocol === 'https:' && url.startsWith('http:') ? 'An HTTPS page cannot call an HTTP address; route it through the Jarvis server.' : 'Check your connection, or use the Jarvis server as a proxy.'}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.detail || data?.raw || res.statusText;
    const err = new Error(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 400));
    err.status = res.status;
    throw err;
  }
  return data;
}

const MODEL_MISSING = /not.?found|does not exist|unknown model|invalid model|no such model|not supported/i;

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

async function geminiChat(s, { system, messages, tools, signal }) {
  const { base, viaServer } = endpoint(s, 'gemini');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGemini(messages),
    generationConfig: { temperature: 0.6, maxOutputTokens: 2048 },
  };
  if (tools?.length) {
    body.tools = [{
      functionDeclarations: tools.map(t => {
        const d = { name: t.name, description: t.description };
        if (t.parameters && Object.keys(t.parameters.properties || {}).length) d.parameters = t.parameters;
        return d;
      }),
    }];
  }
  const model = (s.geminiModel || 'gemini-2.5-flash').replace(/^models\//, '');
  const data = await request(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: headersFor(s, 'gemini', viaServer), body: JSON.stringify(body), signal,
  });
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

// ------------------------------------------------- OpenAI-compatible (Grok, OpenJarvis)

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

async function openaiChat(s, backend, model, { system, messages, tools, signal }) {
  const { base, viaServer } = endpoint(s, backend);
  const headers = headersFor(s, backend, viaServer);
  const body = { model, messages: toOpenAI(system, messages), temperature: 0.6 };
  if (tools?.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } },
    }));
    body.tool_choice = 'auto';
  }
  let data;
  try {
    data = await request(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    // Some local servers (e.g. OpenJarvis with a small model) don't accept tools; retry without.
    if (backend === 'openjarvis' && body.tools && e.status && e.status >= 400 && e.status < 500) {
      delete body.tools; delete body.tool_choice;
      data = await request(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } else throw e;
  }
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map(tc => {
    let args = {};
    try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : (tc.function.arguments || {}); } catch { }
    return { id: tc.id, name: tc.function.name, args };
  });
  return { text: (msg.content || '').trim(), toolCalls };
}

async function openaiModels(s, backend) {
  const { base, viaServer } = endpoint(s, backend);
  const data = await request(`${base}/v1/models`, { headers: headersFor(s, backend, viaServer) });
  return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
}

// ------------------------------------------------------------ public API

function versionScore(id) {
  const m = id.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

export function pickModel(provider, ids) {
  if (!ids.length) return null;
  let pool = ids;
  if (provider === 'gemini') {
    const flash = ids.filter(id => /flash/.test(id) && !/lite|thinking|exp/.test(id));
    if (flash.length) pool = flash;
    const stable = pool.filter(id => !/preview/.test(id));
    if (stable.length) pool = stable;
  } else if (provider === 'grok') {
    pool = ids.filter(id => /grok/.test(id) && !/image|vision|imagine|video/.test(id));
    const fast = pool.filter(id => /fast/.test(id));
    if (fast.length) pool = fast;
    if (!pool.length) pool = ids;
  }
  return [...pool].sort((a, b) => versionScore(b) - versionScore(a) || a.length - b.length)[0];
}

export async function listModels(s, provider) {
  if (provider === 'gemini') return geminiModels(s);
  if (provider === 'grok') return openaiModels(s, 'xai');
  return openaiModels(s, 'openjarvis');
}

async function chatOnce(s, req) {
  if (s.provider === 'gemini') return geminiChat(s, req);
  if (s.provider === 'grok') return openaiChat(s, 'xai', s.grokModel || 'grok-4', req);
  if (s.provider === 'openjarvis') {
    let model = s.ojModel;
    if (!model) {
      model = (await listModels(s, 'openjarvis').catch(() => []))[0] || 'default';
      s.ojModel = model;
    }
    return openaiChat(s, 'openjarvis', model, req);
  }
  throw new Error(`Unknown provider ${s.provider}`);
}

// Chat with automatic recovery when the configured model name has been retired.
export async function chat(s, req, onModelChange) {
  try {
    return await chatOnce(s, req);
  } catch (e) {
    if (s.provider === 'openjarvis' || !(e.status === 404 || (e.status === 400 && MODEL_MISSING.test(e.message)))) throw e;
    const ids = await listModels(s, s.provider).catch(() => []);
    const next = pickModel(s.provider, ids);
    const key = s.provider === 'gemini' ? 'geminiModel' : 'grokModel';
    if (!next || next === s[key]) throw e;
    s[key] = next;
    onModelChange?.(key, next);
    return chatOnce(s, req);
  }
}

// Used by the ask_openjarvis tool: send a task to the OpenJarvis agent on your computer.
export async function askOpenJarvis(s, task, signal) {
  const sub = { ...s, provider: 'openjarvis' };
  const res = await chatOnce(sub, {
    system: 'You are OpenJarvis running on the user\'s computer. Complete the task and reply with the result concisely.',
    messages: [{ role: 'user', content: task }],
    tools: [],
    signal,
  });
  if (sub.ojModel && !s.ojModel) s.ojModel = sub.ojModel;
  return res.text;
}

export function openJarvisAvailable(s) {
  return !!(s.ojUrl || s._server?.openjarvis);
}
