// AI Assistant: provider adapters and the tool loop. Pure logic with no editor or DOM
// access: the caller passes fetch, the tool executor and an event callback, so the same
// code runs in the extension worker and in tests against recorded SSE streams.
//
// Providers
//   anthropic  Messages API (POST https://api.anthropic.com/v1/messages, SSE)
//   openai     Chat Completions with function tools (POST https://api.openai.com/v1/chat/completions, SSE)
//   local      OpenAI-compatible server on this computer (Ollama, LM Studio, llama.cpp)
//
// History is kept in the provider's own message format so thinking blocks, tool calls
// and tool results go back exactly as they came. Switching provider starts a new chat.
"use strict";

const PROVIDERS = {
  anthropic: {
    label: "Claude (Anthropic)", host: "api.anthropic.com", keyed: true, defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    keyHint: "sk-ant-…", keyUrl: "console.anthropic.com"
  },
  openai: {
    label: "ChatGPT (OpenAI)", host: "api.openai.com", keyed: true, defaultModel: "",
    models: [], modelHint: "Model ID, e.g. from platform.openai.com/docs/models", keyHint: "sk-…", keyUrl: "platform.openai.com"
  },
  local: {
    label: "Local model (OpenAI-compatible)", host: "localhost", keyed: false, defaultModel: "",
    models: [], modelHint: "e.g. llama3.1 or qwen2.5-coder", defaultEndpoint: "http://localhost:11434/v1"
  }
};
const MAX_TOKENS = 16000;
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 4;
// Server-side refusal fallbacks are offered for these models (Anthropic beta).
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-[12])$/;

const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/;
function checkModel(model) {
  if (!model) throw Error("Choose a model in Settings.");
  if (!MODEL_ID.test(model)) throw Error("The model ID " + JSON.stringify(String(model).slice(0, 40)) + " is not valid.");
  return model;
}
// Local endpoints must stay on this computer: http(s)://localhost or 127.0.0.1 with any port.
function localEndpoint(text) {
  const m = /^(https?):\/\/([^/?#]*)(\/[^?#]*)?([?#].*)?$/i.exec(String(text || PROVIDERS.local.defaultEndpoint).trim());
  if (!m) throw Error("The local endpoint is not a URL.");
  const [, scheme, authority, path = "", rest] = m;
  if (authority.includes("@") || rest) throw Error("The local endpoint cannot include credentials or a query.");
  const host = /^(localhost|127\.0\.0\.1|\[::1\])(:(\d{1,5}))?$/i.exec(authority);
  if (!host || (host[3] && +host[3] > 65535)) throw Error("The local endpoint must be on this computer, e.g. http://localhost:11434/v1.");
  return scheme.toLowerCase() + "://" + authority.toLowerCase() + path.replace(/\/+$/, "");
}
// The host part (with port) of a local endpoint, as the network permission sees it.
const localHost = text => /^https?:\/\/([^/]+)/i.exec(localEndpoint(text))[1];

// ------------------------------------------------------------------ SSE
// Incremental parser: feed text chunks, get {event, data} records for complete events.
function sseParser() {
  let buffer = "";
  const parse = block => {
    let event = "message", data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line[0] === ":") continue;
      const i = line.indexOf(":"), field = i < 0 ? line : line.slice(0, i), value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value; else if (field === "data") data.push(value);
    }
    return data.length ? {event, data: data.join("\n")} : null;
  };
  return {
    push(text) {
      buffer += text;
      const out = [];
      let m;
      while ((m = /\r?\n\r?\n/.exec(buffer))) { const r = parse(buffer.slice(0, m.index)); buffer = buffer.slice(m.index + m[0].length); if (r) out.push(r); }
      return out;
    },
    end() { const r = buffer.trim() ? parse(buffer) : null; buffer = ""; return r ? [r] : []; }
  };
}
// Streaming UTF-8 for realms without TextDecoder: keeps a split character for the next chunk.
function utf8Decoder() {
  let carry = [];
  return {decode(bytes, o) {
    const b = carry.concat(Array.from(bytes || [])); let s = "", i = 0;
    for (; i < b.length;) {
      const c = b[i], n = c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
      if (i + n > b.length) break;
      const cp = n === 1 ? c : n === 2 ? (c & 31) << 6 | b[i + 1] & 63 : n === 3 ? (c & 15) << 12 | (b[i + 1] & 63) << 6 | b[i + 2] & 63 : (c & 7) << 18 | (b[i + 1] & 63) << 12 | (b[i + 2] & 63) << 6 | b[i + 3] & 63;
      s += String.fromCodePoint(cp); i += n;
    }
    carry = o?.stream ? b.slice(i) : [];
    return s;
  }};
}
// Read a fetch Response body as text chunks (streams when the body is a ReadableStream).
async function* chunks(res) {
  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (!reader) { yield await res.text(); return; }
  const decoder = typeof TextDecoder === "function" ? new TextDecoder() : utf8Decoder();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      yield typeof value === "string" ? value : decoder.decode(value instanceof Uint8Array ? value : new Uint8Array(value), {stream: true});
    }
    const tail = decoder.decode(); if (tail) yield tail;
  } finally { try { reader.releaseLock?.(); } catch {} }
}
async function* events(res) {
  const p = sseParser();
  for await (const text of chunks(res)) for (const e of p.push(text)) yield e;
  for (const e of p.end()) yield e;
}

// ------------------------------------------------------------------ errors
class ProviderError extends Error {
  constructor(message, {status = 0, retryable = false, retryAfter = null, kind = ""} = {}) {
    super(message); this.status = status; this.retryable = retryable; this.retryAfter = retryAfter; this.kind = kind;
  }
}
const aborted = () => Object.assign(Error("Stopped."), {name: "AbortError", aborted: true});
const isAbort = e => e?.aborted || e?.name === "AbortError";
async function httpError(res, provider) {
  let detail = "";
  try { const body = await res.text(); try { const j = JSON.parse(body); detail = j?.error?.message || j?.message || ""; } catch { detail = body.slice(0, 300); } } catch {}
  const raw = res.headers?.get?.("retry-after"), ra = raw == null || raw === "" ? NaN : Number(raw);
  const name = PROVIDERS[provider].label;
  let message;
  if (res.status === 401 || res.status === 403) message = name + " rejected the API key (" + res.status + "). Check it in Settings.";
  else if (res.status === 429) message = name + " rate limit reached (429).";
  else if (res.status === 529) message = name + " is overloaded (529).";
  else if (res.status === 404) message = name + ": not found (404). Check the model ID.";
  else message = name + " returned " + res.status + ".";
  if (detail) message += " " + String(detail).replace(/\s+/g, " ").slice(0, 400);
  return new ProviderError(message, {status: res.status, retryable: RETRYABLE.has(res.status), retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null});
}
function networkError(e, provider, url) {
  const msg = String(e?.message || e);
  if (/not permitted/i.test(msg) || typeof url === "undefined") return new ProviderError(msg, {kind: "permission"});
  if (provider === "local") return new ProviderError("Could not reach " + url + ". Is the local model server running, and does it allow requests from Waffle (for Ollama, set OLLAMA_ORIGINS)?", {kind: "network"});
  return new ProviderError("Could not reach " + PROVIDERS[provider].host + ": " + msg, {kind: "network", retryable: true});
}

// ------------------------------------------------------------------ requests
function anthropicRequest(o) {
  const headers = {"content-type": "application/json", "x-api-key": o.key, "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"};
  const body = {model: o.model, max_tokens: MAX_TOKENS, stream: true, system: o.system, messages: o.messages,
    // Caches the stable prefix (tools, system, earlier turns) across the tool loop.
    cache_control: {type: "ephemeral"}};
  if (o.tools.length) body.tools = o.tools.map(t => ({name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true}));
  if (FALLBACK_MODELS.test(o.model)) { headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; body.fallbacks = "default"; }
  return {url: "https://api.anthropic.com/v1/messages", headers, body};
}
function openaiRequest(o) {
  const local = o.provider === "local";
  const url = (local ? localEndpoint(o.endpoint) : "https://api.openai.com/v1") + "/chat/completions";
  const headers = {"content-type": "application/json"};
  if (o.key) headers.authorization = "Bearer " + o.key;
  const body = {model: o.model, stream: true, messages: [{role: "system", content: o.system}, ...o.messages]};
  if (!local) body.stream_options = {include_usage: true};
  if (o.tools.length) body.tools = o.tools.map(t => ({type: "function", function: {name: t.name, description: t.description, parameters: t.parameters}}));
  return {url, headers, body};
}

// Headers go as [name, value] pairs: standard fetch accepts them, and so does the host's
// network proxy, which takes no other form.
// One model call with streaming. Returns the assistant turn in provider format plus the
// tool calls it asked for. Emits text deltas as they arrive.
async function anthropicTurn(o, res, emit) {
  const blocks = [], json = new Map();
  let stop = null, stopDetails = null, usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, sawContent = false;
  for await (const ev of events(res)) {
    if (o.signal?.aborted) throw aborted();
    let d;
    try { d = JSON.parse(ev.data); } catch { continue; }
    switch (d.type) {
      case "message_start": {
        const u = d.message?.usage || {};
        usage.input = u.input_tokens || 0; usage.cacheRead = u.cache_read_input_tokens || 0; usage.cacheWrite = u.cache_creation_input_tokens || 0;
        usage.output = u.output_tokens || 0; usage.model = d.message?.model;
        break;
      }
      case "content_block_start": {
        const b = {...d.content_block};
        if (b.type === "text") b.text = b.text || "";
        if (b.type === "tool_use") { json.set(d.index, ""); b.input = {}; }
        blocks[d.index] = b; sawContent = true;
        if (b.type === "thinking" || b.type === "redacted_thinking") emit({type: "thinking"});
        break;
      }
      case "content_block_delta": {
        const b = blocks[d.index], x = d.delta || {};
        if (!b) break;
        if (x.type === "text_delta") { b.text += x.text; emit({type: "text", delta: x.text}); }
        else if (x.type === "input_json_delta") json.set(d.index, json.get(d.index) + (x.partial_json || ""));
        else if (x.type === "thinking_delta") b.thinking = (b.thinking || "") + (x.thinking || "");
        else if (x.type === "signature_delta") b.signature = (b.signature || "") + (x.signature || "");
        else if (x.type === "citations_delta") (b.citations ||= []).push(x.citation);
        break;
      }
      case "content_block_stop": {
        const b = blocks[d.index];
        if (b?.type === "tool_use") {
          const text = json.get(d.index) || "";
          try { b.input = text.trim() ? JSON.parse(text) : {}; if (!b.input || typeof b.input !== "object" || Array.isArray(b.input)) throw 0; }
          catch { b.input = {}; b._invalid = "The tool input was not valid JSON."; }
        }
        break;
      }
      case "message_delta":
        if (d.delta?.stop_reason) stop = d.delta.stop_reason;
        if (d.delta?.stop_details) stopDetails = d.delta.stop_details;
        if (d.usage?.output_tokens != null) usage.output = d.usage.output_tokens;
        if (d.usage?.input_tokens != null) usage.input = d.usage.input_tokens;
        break;
      case "error": {
        const t = d.error?.type || "error";
        throw new ProviderError(PROVIDERS.anthropic.label + ": " + (d.error?.message || t), {retryable: !sawContent && /overloaded|api_error|rate_limit/.test(t), kind: t});
      }
    }
  }
  if (o.signal?.aborted) throw aborted();
  const content = blocks.filter(Boolean);
  const calls = content.filter(b => b.type === "tool_use").map(b => ({id: b.id, name: b.name, input: b.input, invalid: b._invalid}));
  for (const b of content) delete b._invalid;
  return {message: {role: "assistant", content}, calls, stop: stop || "end_turn", stopDetails, usage,
    text: content.filter(b => b.type === "text").map(b => b.text).join("")};
}
async function openaiTurn(o, res, emit) {
  let text = "", stop = null, usage = null;
  const calls = [];
  for await (const ev of events(res)) {
    if (o.signal?.aborted) throw aborted();
    if (ev.data === "[DONE]") break;
    let d;
    try { d = JSON.parse(ev.data); } catch { continue; }
    if (d.error) throw new ProviderError(PROVIDERS[o.provider].label + ": " + (d.error.message || "error"), {retryable: !text && !calls.length});
    if (d.usage) usage = {input: d.usage.prompt_tokens || 0, output: d.usage.completion_tokens || 0, cacheRead: d.usage.prompt_tokens_details?.cached_tokens || 0, cacheWrite: 0, model: d.model};
    const c = d.choices?.[0];
    if (!c) continue;
    const delta = c.delta || {};
    if (typeof delta.content === "string" && delta.content) { text += delta.content; emit({type: "text", delta: delta.content}); }
    for (const tc of delta.tool_calls || []) {
      const i = Number.isInteger(tc.index) ? tc.index : calls.length;
      const call = calls[i] ||= {id: "", name: "", args: ""};
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.args += tc.function.arguments;
    }
    if (c.finish_reason) stop = c.finish_reason;
  }
  if (o.signal?.aborted) throw aborted();
  const list = calls.filter(Boolean).map((c, n) => {
    let input = {}, invalid;
    try { input = c.args.trim() ? JSON.parse(c.args) : {}; if (!input || typeof input !== "object" || Array.isArray(input)) throw 0; }
    catch { input = {}; invalid = "The tool arguments were not valid JSON."; }
    return {id: c.id || "call_" + n, name: c.name, input, args: c.args, invalid};
  });
  const message = {role: "assistant", content: text || null};
  if (list.length) message.tool_calls = list.map(c => ({id: c.id, type: "function", function: {name: c.name, arguments: c.args || "{}"}}));
  return {message, calls: list, stop: list.length ? "tool_use" : stop === "length" ? "max_tokens" : stop === "content_filter" ? "refusal" : "end_turn",
    usage: usage || {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, text};
}

// ------------------------------------------------------------------ history helpers
function addUser(provider, messages, text) {
  if (provider === "anthropic") {
    const last = messages[messages.length - 1];
    if (last?.role === "user") last.content.push({type: "text", text});
    else messages.push({role: "user", content: [{type: "text", text}]});
  } else messages.push({role: "user", content: text});
}
function addResults(provider, messages, results) {
  if (provider === "anthropic") messages.push({role: "user", content: results.map(r => ({type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.isError ? {is_error: true} : {})}))});
  else for (const r of results) messages.push({role: "tool", tool_call_id: r.id, content: (r.isError ? "Error: " : "") + r.content});
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(aborted());
  const t = setTimeout(() => { signal?.removeEventListener?.("abort", stopIt); resolve(); }, ms);
  const stopIt = () => { clearTimeout(t); reject(aborted()); };
  signal?.addEventListener?.("abort", stopIt, {once: true});
});

// ------------------------------------------------------------------ the loop
// o: {provider, model, key, endpoint, system, tools:[{name, description, parameters}], messages (mutated),
//     fetch, signal, maxTurns, execute(call) -> {content, isError}, emit(event), wait?(ms, signal)}
// Events: turn {n}, text {delta}, thinking, retry {wait, attempt, message}, tool_start {call},
//         tool_end {call, result}, usage {usage, total}, done {stop, turns, usage}
async function run(o) {
  const provider = o.provider, spec = PROVIDERS[provider];
  if (!spec) throw Error("Unknown provider " + provider + ".");
  checkModel(o.model);
  if (spec.keyed && !o.key) throw new ProviderError("Add your " + spec.label + " API key in Settings.", {kind: "key"});
  if (typeof o.fetch !== "function") throw new ProviderError("Network access is off for this extension.", {kind: "permission"});
  const emit = e => { try { o.emit?.(e); } catch {} };
  const wait = o.wait || sleep, maxTurns = Math.max(1, Math.min(50, o.maxTurns || 8));
  const total = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
  let stop = "end_turn", turn = 0;
  for (turn = 1; turn <= maxTurns; turn++) {
    emit({type: "turn", n: turn});
    const req = provider === "anthropic" ? anthropicRequest(o) : openaiRequest(o);
    let result;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw aborted();
      try {
        let res;
        try { res = await o.fetch(req.url, {method: "POST", headers: Object.entries(req.headers), body: JSON.stringify(req.body), signal: o.signal}); }
        catch (e) { if (isAbort(e) || o.signal?.aborted) throw aborted(); throw networkError(e, provider, provider === "local" ? localEndpoint(o.endpoint) : req.url); }
        if (!res.ok) throw await httpError(res, provider);
        result = await (provider === "anthropic" ? anthropicTurn(o, res, emit) : openaiTurn(o, res, emit));
        break;
      } catch (e) {
        if (isAbort(e) || o.signal?.aborted) throw aborted();
        if (!(e instanceof ProviderError) || !e.retryable || attempt >= MAX_RETRIES) throw e;
        const delay = Math.min(30, e.retryAfter != null ? e.retryAfter : 2 ** attempt * 1.5) * 1000;
        emit({type: "retry", wait: delay, attempt: attempt + 1, message: e.message});
        await wait(delay, o.signal);
      }
    }
    for (const k of Object.keys(total)) total[k] += result.usage[k] || 0;
    if (result.usage.model) total.model = result.usage.model;
    emit({type: "usage", usage: result.usage, total: {...total}});
    o.messages.push(result.message);
    stop = result.stop;
    if (stop === "refusal") { emit({type: "refusal", details: result.stopDetails}); break; }
    if (!result.calls.length) break;
    // Tool calls run one at a time; all results go back in one message.
    const results = [];
    for (const call of result.calls) {
      if (o.signal?.aborted) { results.push({id: call.id, content: "Cancelled by the user.", isError: true}); continue; }
      emit({type: "tool_start", call});
      let r;
      try { r = call.invalid ? {content: call.invalid, isError: true} : await o.execute(call); }
      catch (e) { r = {content: String(e?.message || e), isError: true}; }
      r = {content: String(r?.content ?? ""), isError: !!r?.isError};
      results.push({id: call.id, ...r});
      emit({type: "tool_end", call, result: r});
    }
    addResults(provider, o.messages, results);
    if (o.signal?.aborted) throw aborted();
    if (turn === maxTurns) { stop = "max_turns"; break; }
  }
  emit({type: "done", stop, turns: Math.min(turn, maxTurns), usage: total});
  return {stop, usage: total, turns: Math.min(turn, maxTurns)};
}

// After a stop mid-loop, close any tool calls left without results so the next request is valid.
function repair(provider, messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return;
  const ids = provider === "anthropic" ? (last.content || []).filter(b => b.type === "tool_use").map(b => b.id) : (last.tool_calls || []).map(c => c.id);
  if (ids.length) addResults(provider, messages, ids.map(id => ({id, content: "Cancelled by the user.", isError: true})));
}

module.exports = {utf8Decoder, PROVIDERS, MAX_TOKENS, run, repair, addUser, sseParser, localEndpoint, localHost, checkModel, ProviderError, anthropicRequest, openaiRequest, sleep};
