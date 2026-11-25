"use strict";
// AI Assistant (extensions/ai-assistant): provider adapters against recorded SSE streams
// (Anthropic Messages and OpenAI Chat Completions, with tool-use turns), retries, limits and
// cancellation; then the whole extension in the extension host, in a separate JS realm with a
// mocked fetch: panel, consent, DRC through a tool call, and a proposal applied through review.
// No real network: every response below is a fixture.
const assert = require("node:assert/strict");
require("../../app/core/model.js"); require("../../app/library/parts.js"); require("../../app/core/spatial.js"); require("../../app/checks/altium-rules.js");
require("../../app/checks/rules.js"); require("../../app/checks/connectivity.js"); require("../../app/editor/keymap.js"); require("../../app/automation/proposal.js");
require("../../app/checks/drc.js"); require("../../app/checks/erc.js"); require("../../app/formats/bom.js"); require("../../app/notebook/annotate.js");
require("../../app/core/atrium-api.js"); require("../../app/workers/extension-host-worker.js"); require("../../app/extension-host/extensions.js");
require("../../app/extensions/manifests.js"); require("../../app/automation/ai.js");
const agent = require("../../extensions/ai-assistant/agent.js");
const tools = require("../../extensions/ai-assistant/tools.js");
const X = AtriumExtensions;

// ------------------------------------------------------------------ fixtures
const sse = list => list.map(([event, data]) => (event ? "event: " + event + "\n" : "") + "data: " + (typeof data === "string" ? data : JSON.stringify(data)) + "\n\n").join("");
// Split a stream at awkward places so the parser sees partial lines and events.
const pieces = (text, size = 17) => { const out = []; for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size)); return out; };
function response(status, text, headers = {}) {
  const parts = pieces(text);
  return {ok: status >= 200 && status < 300, status, headers: {get: k => headers[k.toLowerCase()] ?? null},
    body: {getReader() { let i = 0; return {read: async () => (i < parts.length ? {done: false, value: parts[i++]} : {done: true}), releaseLock() {}}; }},
    text: async () => text};
}
const anthropicTurn = (blocks, stop, usage = {input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0}) => {
  const ev = [["message_start", {type: "message_start", message: {id: "msg_1", model: "claude-opus-5-5", usage: {input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, output_tokens: 1}}}]];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev.push(["content_block_start", {type: "content_block_start", index, content_block: {type: "text", text: ""}}]);
      for (const t of b.chunks) ev.push(["content_block_delta", {type: "content_block_delta", index, delta: {type: "text_delta", text: t}}]);
    } else if (b.type === "thinking") {
      ev.push(["content_block_start", {type: "content_block_start", index, content_block: {type: "thinking", thinking: ""}}]);
      ev.push(["content_block_delta", {type: "content_block_delta", index, delta: {type: "signature_delta", signature: b.signature}}]);
    } else if (b.type === "tool_use") {
      ev.push(["content_block_start", {type: "content_block_start", index, content_block: {type: "tool_use", id: b.id, name: b.name, input: {}}}]);
      for (const j of b.json) ev.push(["content_block_delta", {type: "content_block_delta", index, delta: {type: "input_json_delta", partial_json: j}}]);
    }
    ev.push(["content_block_stop", {type: "content_block_stop", index}]);
    if (index === 0) ev.push(["ping", {type: "ping"}]);
  });
  ev.push(["message_delta", {type: "message_delta", delta: {stop_reason: stop}, usage: {output_tokens: usage.output_tokens}}]);
  ev.push(["message_stop", {type: "message_stop"}]);
  return sse(ev);
};
const openaiTurn = (text, calls = [], usage = {prompt_tokens: 90, completion_tokens: 30}) => {
  const ev = [];
  for (const t of text) ev.push([null, {id: "c1", model: "gpt-x", choices: [{index: 0, delta: {content: t}, finish_reason: null}]}]);
  calls.forEach((c, index) => {
    ev.push([null, {choices: [{index: 0, delta: {tool_calls: [{index, id: c.id, type: "function", function: {name: c.name, arguments: ""}}]}}]}]);
    for (const a of c.args) ev.push([null, {choices: [{index: 0, delta: {tool_calls: [{index, function: {arguments: a}}]}}]}]);
  });
  ev.push([null, {choices: [{index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop"}]}]);
  ev.push([null, {choices: [], usage}]);
  ev.push([null, "[DONE]"]);
  return sse(ev);
};
// A fetch that serves queued responses and records requests.
function mockFetch(queue) {
  const requests = [];
  const f = async (url, init) => {
    requests.push({url, headers: Array.isArray(init.headers) ? Object.fromEntries(init.headers) : init.headers, body: JSON.parse(init.body)});
    if (init.signal?.aborted) throw Object.assign(Error("aborted"), {name: "AbortError"});
    const next = queue.shift();
    if (!next) throw Error("No fixture left for " + url);
    return typeof next === "function" ? next(init) : next;
  };
  f.requests = requests;
  return f;
}
const TOOLS = tools.TOOLS.map(({name, description, parameters}) => ({name, description, parameters}));

const done = (async () => {
  // ------------------------------------------------------------ SSE parser
  const p = agent.sseParser();
  assert.deepEqual(p.push("event: a\nda"), []);
  assert.deepEqual(p.push("ta: {\"x\":1}\n\n: comment\n\ndata: two\ndata: lines\r\n\r\n"), [{event: "a", data: "{\"x\":1}"}, {event: "message", data: "two\nlines"}]);
  assert.deepEqual(p.push("data: tail"), []); assert.deepEqual(p.end(), [{event: "message", data: "tail"}]);

  // UTF-8 split across chunks, without TextDecoder.
  { const d = agent.utf8Decoder(), bytes = new TextEncoder().encode("4.7 kΩ ✓ 😀"); let out = "";
    for (let i = 0; i < bytes.length; i++) out += d.decode(bytes.subarray(i, i + 1), {stream: true});
    assert.equal(out + d.decode(), "4.7 kΩ ✓ 😀"); }

  // ------------------------------------------------------------ Anthropic: tool use, then an answer
  {
    const fetch = mockFetch([
      response(200, anthropicTurn([{type: "thinking", signature: "sig-abc"}, {type: "text", chunks: ["Let me ", "run the DRC."]},
        {type: "tool_use", id: "toolu_1", name: "run_drc", json: ["{\"ru", "les\": [\"clear", "ance\"]}"]}], "tool_use", {input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0})),
      response(200, anthropicTurn([{type: "text", chunks: ["There is ", "1 violation."]}], "end_turn", {input_tokens: 1200, output_tokens: 20, cache_read_input_tokens: 900}))
    ]);
    const messages = [], events = [], executed = [];
    agent.addUser("anthropic", messages, "Check my board");
    const r = await agent.run({provider: "anthropic", model: "claude-opus-5-5", key: "sk-ant-test", system: "S", tools: TOOLS, messages, fetch, maxTurns: 8,
      execute: async call => { executed.push(call); return {content: "{\"total\":1}"}; }, emit: e => events.push(e)});
    assert.equal(r.stop, "end_turn"); assert.equal(r.turns, 2);
    assert.deepEqual(r.usage, {input: 2200, output: 70, cacheRead: 900, cacheWrite: 0, model: "claude-opus-5-5"});
    const [first, second] = fetch.requests;
    assert.equal(first.url, "https://api.anthropic.com/v1/messages");
    assert.equal(first.headers["x-api-key"], "sk-ant-test"); assert.equal(first.headers["anthropic-version"], "2023-06-01");
    assert.equal(first.headers["anthropic-dangerous-direct-browser-access"], "true"); assert.equal(first.headers["content-type"], "application/json");
    assert.equal(first.body.model, "claude-opus-5-5"); assert.equal(first.body.stream, true); assert.equal(first.body.system, "S");
    assert.ok(first.body.max_tokens >= 16000, "max_tokens leaves room for long replies");
    assert.equal(first.body.thinking, undefined, "thinking is left to the model default (adaptive on current models)");
    assert.equal(first.body.fallbacks, "default"); assert.equal(first.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    const drcTool = first.body.tools.find(t => t.name === "run_drc");
    assert.ok(drcTool.input_schema.properties.rules && drcTool.eager_input_streaming === true, "tools use input_schema");
    assert.deepEqual(executed.map(c => [c.name, c.input]), [["run_drc", {rules: ["clearance"]}]], "streamed tool input JSON is reassembled");
    assert.deepEqual(second.body.messages.map(m => m.role), ["user", "assistant", "user"]);
    const replayed = second.body.messages[1].content;
    assert.deepEqual(replayed.map(b => b.type), ["thinking", "text", "tool_use"], "the assistant turn goes back unchanged, thinking first");
    assert.equal(replayed[0].signature, "sig-abc"); assert.equal(replayed[1].text, "Let me run the DRC.");
    assert.deepEqual(second.body.messages[2].content, [{type: "tool_result", tool_use_id: "toolu_1", content: "{\"total\":1}"}]);
    assert.equal(events.filter(e => e.type === "text").map(e => e.delta).join(""), "Let me run the DRC.There is 1 violation.", "text streams as deltas");
    assert.ok(events.some(e => e.type === "tool_start") && events.some(e => e.type === "tool_end"));
    assert.equal(messages.length, 4, "history ends with the final assistant turn");
    // The next user message starts a new turn; after a stop, open tool calls are closed.
    const h = [{role: "user", content: [{type: "text", text: "x"}]}, {role: "assistant", content: [{type: "tool_use", id: "t9", name: "run_erc", input: {}}]}];
    agent.repair("anthropic", h); agent.addUser("anthropic", h, "next");
    assert.deepEqual(h[2].content, [{type: "tool_result", tool_use_id: "t9", content: "Cancelled by the user.", is_error: true}, {type: "text", text: "next"}]);
    // Other models get no fallbacks parameter.
    const req = agent.anthropicRequest({model: "claude-haiku-5-5", key: "k", system: "", messages: [], tools: []});
    assert.equal(req.body.fallbacks, undefined); assert.equal(req.headers["anthropic-beta"], undefined); assert.equal(req.body.tools, undefined);
  }

  // ------------------------------------------------------------ OpenAI: split tool-call arguments
  {
    const fetch = mockFetch([
      response(200, openaiTurn(["Checking"], [{id: "call_a", name: "list_nets", args: ["{\"lim", "it\": 5}"]}, {id: "call_b", name: "project_summary", args: ["{}"]}])),
      response(200, openaiTurn(["Six ", "nets."]))
    ]);
    const messages = [], executed = [];
    agent.addUser("openai", messages, "What nets?");
    const r = await agent.run({provider: "openai", model: "gpt-test", key: "sk-test", system: "S", tools: TOOLS, messages, fetch,
      execute: async call => { executed.push(call.name); return {content: call.name === "list_nets" ? "[6]" : "{}"}; }});
    assert.equal(r.stop, "end_turn"); assert.deepEqual(executed, ["list_nets", "project_summary"]);
    assert.deepEqual(r.usage, {input: 180, output: 60, cacheRead: 0, cacheWrite: 0});
    const [first, second] = fetch.requests;
    assert.equal(first.url, "https://api.openai.com/v1/chat/completions"); assert.equal(first.headers.authorization, "Bearer sk-test");
    assert.deepEqual(first.body.stream_options, {include_usage: true}); assert.equal(first.body.model, "gpt-test");
    assert.deepEqual(first.body.messages[0], {role: "system", content: "S"});
    assert.equal(first.body.tools[0].type, "function"); assert.ok(first.body.tools[0].function.parameters.type === "object");
    const m = second.body.messages;
    assert.deepEqual(m.map(x => x.role), ["system", "user", "assistant", "tool", "tool"]);
    assert.deepEqual(m[2].tool_calls.map(c => [c.id, c.function.name, c.function.arguments]), [["call_a", "list_nets", "{\"limit\": 5}"], ["call_b", "project_summary", "{}"]]);
    assert.deepEqual(m[3], {role: "tool", tool_call_id: "call_a", content: "[6]"});
    assert.equal(messages.at(-1).content, "Six nets.");
  }

  // ------------------------------------------------------------ Local OpenAI-compatible endpoint
  {
    const fetch = mockFetch([response(200, openaiTurn(["Hi"]))]);
    await agent.run({provider: "local", model: "llama3.1:8b", key: "", endpoint: "http://localhost:11434/v1/", system: "S", tools: TOOLS, messages: [{role: "user", content: "hi"}], fetch, execute: async () => ({content: ""})});
    assert.equal(fetch.requests[0].url, "http://localhost:11434/v1/chat/completions");
    assert.equal(fetch.requests[0].headers.authorization, undefined); assert.equal(fetch.requests[0].body.stream_options, undefined);
    for (const bad of ["http://example.com:11434/v1", "file:///etc", "http://user:pw@localhost:1/v1", "http://10.0.0.2/v1"]) assert.throws(() => agent.localEndpoint(bad), /this computer|URL|credentials/);
    assert.equal(agent.localEndpoint("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
    // An unreachable server explains itself.
    const down = async () => { throw new TypeError("Load failed"); };
    await assert.rejects(agent.run({provider: "local", model: "m", endpoint: "http://localhost:11434/v1", system: "", tools: [], messages: [{role: "user", content: "x"}], fetch: down, execute: async () => ({})}), /OLLAMA_ORIGINS/);
  }

  // ------------------------------------------------------------ 429 / overloaded: retry with backoff
  {
    const waits = [], events = [];
    const overloaded = sse([["message_start", {type: "message_start", message: {usage: {input_tokens: 1}}}], ["error", {type: "error", error: {type: "overloaded_error", message: "Overloaded"}}]]);
    const fetch = mockFetch([response(429, JSON.stringify({type: "error", error: {type: "rate_limit_error", message: "Slow down"}}), {"retry-after": "2"}),
      response(200, overloaded), response(529, "{}"), response(200, anthropicTurn([{type: "text", chunks: ["ok"]}], "end_turn"))]);
    const r = await agent.run({provider: "anthropic", model: "claude-sonnet-5-5", key: "k", system: "", tools: [], messages: [{role: "user", content: [{type: "text", text: "x"}]}], fetch,
      execute: async () => ({}), emit: e => events.push(e), wait: async ms => { waits.push(ms); }});
    assert.equal(r.stop, "end_turn");
    assert.deepEqual(waits, [2000, 3000, 6000], JSON.stringify(waits) + " retry-after is honoured, then exponential backoff");
    assert.match(events.find(e => e.type === "retry").message, /rate limit.*Slow down/);
    // Non-retryable errors surface at once, and say what to do.
    const bad = mockFetch([response(401, JSON.stringify({type: "error", error: {type: "authentication_error", message: "invalid x-api-key"}}))]);
    await assert.rejects(agent.run({provider: "anthropic", model: "claude-opus-5-5", key: "k", system: "", tools: [], messages: [], fetch: bad, execute: async () => ({}), wait: async () => {}}), /rejected the API key \(401\)/);
    assert.equal(bad.requests.length, 1);
    // Retries give up after the limit.
    const always = mockFetch(Array.from({length: 10}, () => response(503, "{}")));
    await assert.rejects(agent.run({provider: "openai", model: "m", key: "k", system: "", tools: [], messages: [], fetch: always, execute: async () => ({}), wait: async () => {}}), /returned 503/);
    assert.equal(always.requests.length, 5);
    await assert.rejects(agent.run({provider: "anthropic", model: "claude-opus-5-5", key: "", system: "", tools: [], messages: [], fetch: always, execute: async () => ({})}), /API key in Settings/);
    await assert.rejects(agent.run({provider: "anthropic", model: "bad model!", key: "k", system: "", tools: [], messages: [], fetch: always, execute: async () => ({})}), /not valid/);
    await assert.rejects(agent.run({provider: "anthropic", model: "claude-opus-5-5", key: "k", system: "", tools: [], messages: [], fetch: undefined, execute: async () => ({})}), /Network access is off/);
  }

  // ------------------------------------------------------------ the tool-round limit and bad tool input
  {
    const turn = n => response(200, anthropicTurn([{type: "tool_use", id: "t" + n, name: "project_summary", json: n === 1 ? ["{not json"] : ["{}"]}], "tool_use"));
    const fetch = mockFetch([turn(1), turn(2), turn(3)]);
    const messages = [{role: "user", content: [{type: "text", text: "loop"}]}], results = [];
    const r = await agent.run({provider: "anthropic", model: "claude-opus-5-5", key: "k", system: "", tools: TOOLS, messages, fetch, maxTurns: 3,
      execute: async () => ({content: "{}"}), emit: e => e.type === "tool_end" && results.push(e.result)});
    assert.equal(r.stop, "max_turns"); assert.equal(r.turns, 3); assert.equal(fetch.requests.length, 3);
    assert.deepEqual(results[0], {content: "The tool input was not valid JSON.", isError: true}, "invalid streamed JSON becomes an error result");
    assert.equal(messages.at(-1).content[0].type, "tool_result", "history stays valid at the limit");
  }

  // ------------------------------------------------------------ Stop during a stream
  {
    const ctrl = new (globalThis.AbortController || class { constructor() { const l = []; this.signal = {aborted: false, addEventListener: (t, f) => l.push(f), removeEventListener() {}}; this.abort = () => { this.signal.aborted = true; l.forEach(f => f()); }; } })();
    const text = anthropicTurn([{type: "text", chunks: ["one ", "two ", "three"]}], "end_turn");
    const slow = {ok: true, status: 200, headers: {get: () => null}, body: {getReader() { let i = 0; const parts = pieces(text, 40); return {read: async () => { if (i === 3) ctrl.abort(); return i < parts.length ? {done: false, value: parts[i++]} : {done: true}; }}; }}};
    const fetch = mockFetch([slow]);
    await assert.rejects(agent.run({provider: "anthropic", model: "claude-opus-5-5", key: "k", system: "", tools: [], messages: [], fetch, signal: ctrl.signal, execute: async () => ({})}), e => e.aborted === true);
  }

  // ------------------------------------------------------------ tool argument validation
  assert.throws(() => tools.validate(tools.TOOLS.find(t => t.name === "run_drc").parameters, {rules: "clearance"}), /must be array/);
  assert.throws(() => tools.validate(tools.TOOLS.find(t => t.name === "list_nets").parameters, {nope: 1}), /unknown field nope/);
  assert.throws(() => tools.validate(tools.TOOLS.find(t => t.name === "propose_component_edits").parameters, {changes: [{component_id: "a", field: "net", value: "x"}]}), /must be one of/);
  for (const t of tools.TOOLS) { assert.equal(t.parameters.type, "object"); assert.ok(t.description.length > 20, t.name); }
  for (const shared of ["project_summary", "list_components", "inspect_component", "list_nets", "list_library", "run_drc", "run_erc", "list_rules", "net_lengths", "stackup_get", "generate_bom", "generate_fabrication", "propose_component_edits", "annotate", "pour_polygons", "autoroute", "fanout"])
    assert.ok(tools.TOOLS.some(t => t.name === shared), "MCP tool name reused: " + shared);

  // The same concrete feature stays in the editor from the first card to the commit.
  {
    const p=AtriumParts.example(), sheet=p.documents.find(d=>d.kind==="schematic"), part=sheet.items.find(i=>i.ref==="R1");
    part.ref="R?";
    const perms={"read:project":true,"propose:edits":true};
    let plans=0, decisions=0, choose=()=>true;
    const module=AtriumAnnotate; globalThis.AtriumAnnotate={...module,plan(...args){plans++;return module.plan(...args);}};
    const h=AtriumAPI.headless(p,{extension:{id:"tester",permissions:perms},approve:r=>{decisions++;return choose(r);}});
    const cards={proposals:new Map(),nextId:()=>String(cards.proposals.size+1)};
    const annotate=()=>tools.execute(h.api,"annotate",{mode:"proposal",action:"update"},cards);
    try{
      const first=await annotate();
      assert.equal(plans,1);assert.match(first.data.changes[0],/R1/);assert.equal(h.steps.length,0);
      const api2=AtriumAPI.create(h.host).api;
      api2.transaction("Place another resistor",tx=>tx.add({...part,id:"new-r1",ref:"R1"},{doc:sheet.id}));
      assert.equal((await tools.review(h.api,cards.proposals.get(first.proposal))).status,"stale");
      assert.equal(part.ref,"R?");assert.equal(plans,1);assert.equal(decisions,0);
      const second=await annotate();assert.equal(plans,2);assert.match(second.data.changes[0],/R2|R3/);
      assert.equal((await tools.review(h.api,cards.proposals.get(second.proposal))).status,"applied");
      assert.equal(plans,2);assert.equal(h.steps.length,2);assert.equal(decisions,1);
      const op={op:"add",doc:sheet.id,item:{kind:"junction",x:2,y:3}};
      const draft=h.api.proposals.draft("transaction",{ops:[op]});const id=draft.added[0];
      assert.ok(id&&!sheet.items.some(i=>i.id===id));
      assert.equal(api2.proposals.review(draft.handle).stale,true,"another actor cannot review this handle");
      choose=r=>{assert.equal(r.proposal.ops[0].value.id,id);return [0];};
      assert.equal(h.api.proposals.review(draft.handle).applied,1);assert.ok(sheet.items.some(i=>i.id===id));
      const pending=h.api.proposals.draft("transaction",{ops:[{op:"update",id:part.id,set:{value:"draft"}}]});
      choose=()=>{perms["propose:edits"]=false;return [0];};
      assert.equal(h.api.proposals.review(pending.handle).revoked,true);
      assert.notEqual(part.value,"draft");
    }finally{globalThis.AtriumAnnotate=module;}
  }

  // ------------------------------------------------------------ one-click MCP setup texts
  for (const os of ["mac", "windows", "linux"]) {
    const list = AtriumAI.clients({serverPath: "/Apps/Waffle/mcp/server.py", projectPath: "/Users/me/My Board/board.atrium", os});
    assert.deepEqual(list.map(c => c.id), ["claude-desktop", "claude-code", "cursor", "vscode", "codex", "chatgpt"]);
    const by = Object.fromEntries(list.map(c => [c.id, c]));
    const args = ["/Apps/Waffle/mcp/server.py", "--project", "/Users/me/My Board/board.atrium"];
    assert.deepEqual(JSON.parse(by["claude-desktop"].text), {mcpServers: {"waffle-eda": {command: "python3", args}}});
    assert.match(by["claude-desktop"].file, {mac: /Library\/Application Support\/Claude\/claude_desktop_config\.json$/, windows: /%APPDATA%\\Claude\\claude_desktop_config\.json/, linux: /\.config\/Claude/}[os]);
    assert.equal(by["claude-code"].text, "claude mcp add waffle-eda -- python3 /Apps/Waffle/mcp/server.py --project '/Users/me/My Board/board.atrium'");
    assert.deepEqual(JSON.parse(by["claude-code"].alternate.text).mcpServers["waffle-eda"].args, args);
    assert.deepEqual(JSON.parse(by.cursor.text).mcpServers["waffle-eda"].args, args);
    assert.deepEqual(JSON.parse(by.vscode.text), {servers: {"waffle-eda": {type: "stdio", command: "python3", args}}});
    assert.equal(by.codex.text, '[mcp_servers.waffle-eda]\ncommand = "python3"\nargs = ["/Apps/Waffle/mcp/server.py", "--project", "/Users/me/My Board/board.atrium"]\n');
    assert.match(by.chatgpt.note, /Uncertain/);
  }
  assert.match(AtriumAI.clients({serverPath: "/s.py", projectPath: "/a/it's.waffle", os: "mac"})[1].text, /'\/a\/it'\\''s\.waffle'$/, "shell quoting");

  // ================================================================ the extension in the host
  // Binary-safe JSON across the realm boundary (the host streams response bodies as ArrayBuffers).
  const CODEC = `const __enc = (k, v) => v instanceof ArrayBuffer ? {$ab: Array.from(new Uint8Array(v))} : ArrayBuffer.isView(v) ? {$view: v.constructor.name, $ab: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))} : v;
const __dec = (k, v) => v && typeof v === "object" && Array.isArray(v.$ab) ? (b => v.$view ? new globalThis[v.$view](b) : b)(new Uint8Array(v.$ab).buffer) : v;`;
  const {__enc, __dec} = new Function(CODEC + ";return {__enc, __dec};")();
  // Inside the realm: a fetch that serves fixtures pushed from the test (as strings).
  // JavaScriptCore's shell has no URL; Workers do. A minimal one for the host's fetch guard.
  const URLSHIM = `if (typeof URL !== "function") globalThis.URL = class { constructor(t) { const m = /^([a-z][a-z0-9+.-]*:)\\/\\/([^/?#]*)([^?#]*)/i.exec(String(t)); if (!m) throw new TypeError("Invalid URL"); this.protocol = m[1].toLowerCase(); this.host = m[2].toLowerCase(); this.href = String(t); this.username = this.password = ""; } };`;
  // The host side (this realm) parses URLs too when it makes requests for the worker.
  if (typeof URL !== "function") new Function(URLSHIM)();
  // Every provider request is served here, whether the worker calls fetch itself or the host
  // makes the request for it (options.fetch): both paths share one fixture queue.
  const net = {fixtures: [], requests: []};
  const serve = (url, init = {}) => {
    const headers = Array.isArray(init.headers) ? Object.fromEntries(init.headers) : {...(init.headers || {})};
    net.requests.push({url: String(url), headers, body: init.body});
    const f = net.fixtures.shift();
    if (!f) return Promise.reject(new TypeError("no fixture"));
    const parts = []; for (let i = 0; i < f.text.length; i += 23) parts.push(f.text.slice(i, i + 23));
    let i = 0;
    return Promise.resolve({ok: f.status === 200, status: f.status, statusText: "", headers: {get: () => null, forEach() {}}, text: async () => f.text,
      body: {getReader: () => ({read: async () => (i < parts.length ? {done: false, value: parts[i++]} : {done: true}), releaseLock() {}, cancel: async () => {}})}});
  };
  const FETCH = URLSHIM + `globalThis.fetch = (u, i) => globalThis.__serve(u, i);`;
  const BOOT = CODEC + `(function(){
    const post = globalThis.__hostPost; delete globalThis.__hostPost;
    const inbox = [];
    globalThis.self = globalThis;
    self.postMessage = m => post(JSON.stringify(m, __enc));
    self.addEventListener = (type, f) => { if (type === "message") inbox.push(f); };
    globalThis.__deliver = text => { const data = JSON.parse(text, __dec); for (const f of inbox) f({data}); };
    if (typeof clearTimeout !== "function" && typeof setTimeout === "function") {
      const native = setTimeout, live = new Map(); let id = 0, ticking = false;
      const tick = () => { const now = Date.now(); for (const [k, t] of [...live]) if (t.at <= now && live.delete(k)) t.f(); if (live.size) native(tick, 4); else ticking = false; };
      globalThis.setTimeout = (f, ms) => { live.set(++id, {f, at: Date.now() + (ms || 0)}); if (!ticking) { ticking = true; native(tick, 0); } return id; };
      globalThis.clearTimeout = k => { live.delete(k); };
    }
  })();` + FETCH;
  let realm = null;
  function realmWorker(source) {
    const outer = {onmessage: null, terminated: false, terminate() { this.terminated = true; }};
    const hostPost = text => { if (!outer.terminated) Promise.resolve().then(() => { if (!outer.terminated) outer.onmessage?.({data: JSON.parse(text, __dec)}); }); };
    let deliver;
    if (globalThis.$262?.createRealm) {
      const r = $262.createRealm(); r.global.__hostPost = hostPost; r.global.__serve = serve; r.evalScript(BOOT); deliver = r.global.__deliver; r.evalScript(source); realm = r.global;
    } else {
      const vm = require("node:vm"), ctx = vm.createContext({__hostPost: hostPost, __serve: serve, setTimeout, clearTimeout});
      vm.runInContext(BOOT, ctx); deliver = vm.runInContext("__deliver", ctx); vm.runInContext(source, ctx); realm = ctx;
    }
    outer.postMessage = m => { const text = JSON.stringify(m, __enc); Promise.resolve().then(() => { if (!outer.terminated) deliver(text); }); };
    return outer;
  }
  // The sample passes DRC; put U1's pin-1 dot back over pad 1's mask opening so "Run DRC" has one violation to report.
  let project = AtriumParts.example(), current = project.documents.find(d => d.kind === "pcb").id, selection = new Set(), revision = 0;
  project.library.find(d => d.footprint?.name === "SOT-23-5").footprint.shapes.find(s => s.kind === "circle").x = -0.44;
  const history = [], messages = [], prompts = [];
  const host = {
    project: () => project, documentId: () => current, revision: () => revision, selection: () => selection,
    select(ids) { selection = new Set(ids); X.notify("selectionChanged"); },
    edit(fn) { const before = JSON.stringify(project); try { fn(); } catch (e) { project = JSON.parse(before); throw e; } history.push(before); revision++; X.notify("documentChanged"); },
    info: t => messages.push(t), activate(id) { current = id; }, locate: id => messages.push("locate " + id)
  };
  let reviewAnswer = r => r.rows.map(x => x.index);
  X.attach(host, {createWorker: realmWorker, fetch: serve, consent: r => { prompts.push(r.kind); return r.kind === "review" ? reviewAnswer(r) : null; }});
  const ID = "waffle.ai-assistant", PANEL = "waffle.ai-assistant";
  const info = X.list().find(e => e.id === ID);
  assert.ok(info && info.origin === "builtin" && info.enabled && info.status === "inactive", "the assistant ships as a built-in, inactive until used");
  assert.deepEqual(X.permissions(ID).network, [], "network hosts stay off until the user turns them on");
  assert.ok(X.commands().some(c => c.id === "ai.askSelection"), "Ask AI about Selection is a command");
  assert.deepEqual(AtriumKeymap.bindingsFor("ai.askSelection").map(b => b.key).length, 1, "…with a default shortcut in the keymap");
  const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise(r => setTimeout(r, 5)); } return false; };
  const texts = () => { const out = []; const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (v.text) out.push(v.text); if (v.label) out.push(v.label); walk(v.children); walk(v.items); } }; walk(X._panel(ID, PANEL)); return out.join("\n"); };
  const buttons = () => { const out = []; const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (v.command) out.push(v); walk(v.children); walk(v.items); } }; walk(X._panel(ID, PANEL)); return out; };

  // Without network access the panel says how to turn it on.
  await X.execute("ai.show");
  assert.equal(X.list().find(e => e.id === ID).status, "active");
  assert.match(texts(), /Network access is off.*network:api\.anthropic\.com/s);
  assert.match(texts(), /Privacy: .*sent to api\.anthropic\.com/s, "the privacy note says what is sent and where");
  await X.grant(ID, "network:api.anthropic.com", true);
  assert.deepEqual(X.permissions(ID).network, ["api.anthropic.com"]);
  await X.execute("ai.show");
  assert.ok(X.workers.some(w => w.members.includes(ID) && !w.members.some(m => m !== ID)), "the assistant runs in its own sandboxed worker");
  assert.match(texts(), /Add your Claude \(Anthropic\) API key/);
  await X.execute("ai.saveSettings", {model: "", key: "sk-ant-secret-1234", askBeforeSend: true, maxTurns: 8});
  assert.ok(!JSON.stringify(X._panel(ID, PANEL)).includes("sk-ant-secret"), "the key is never rendered back");
  assert.match(texts(), /saved ••••1234|claude-opus-5-5/);
  assert.ok(!JSON.stringify(X.logs(ID)).includes("secret"), "nor logged");
  assert.ok(!JSON.stringify(project).includes("secret"), "nor written into the project");

  // 1) Consent: the first design-data read asks; declining sends an error result instead of data.
  net.fixtures.push({status: 200, text: anthropicTurn([{type: "tool_use", id: "toolu_a", name: "project_summary", json: ["{}"]}], "tool_use")},
    {status: 200, text: anthropicTurn([{type: "text", chunks: ["I can't see the design."]}], "end_turn")});
  await X.execute("ai.send", {prompt: "Summarize"});
  assert.ok(await until(() => /I can't see the design\./.test(texts()) && !/■ Stop/.test(texts())), texts());
  const req = () => net.requests;
  let sent = req();
  assert.equal(sent.length, 2); assert.equal(sent[0].headers["x-api-key"], "sk-ant-secret-1234");
  assert.ok(!sent[0].url.includes("secret") && sent.every(r => /^https:\/\/api\.anthropic\.com\//.test(r.url)), "the key goes only to the provider, in a header");
  const declined = JSON.parse(sent[1].body).messages[2].content[0];
  assert.equal(declined.is_error, true); assert.match(declined.content, /declined to share design data/);
  assert.ok(!JSON.stringify(sent).includes("Sensor interface"), "no design data left the editor");
  assert.match(texts(), /you declined to share design data/);

  // 2) DRC through a tool call, then a component edit proposal reviewed and applied.
  await X.execute("ai.reset");
  await X.execute("ai.saveSettings", {askBeforeSend: false});
  const r1 = project.documents.find(d => d.kind === "pcb").items.find(i => i.ref === "R1");
  net.fixtures.push(
    {status: 200, text: anthropicTurn([{type: "text", chunks: ["Running the DRC."]}, {type: "tool_use", id: "toolu_d", name: "run_drc", json: ["{}"]}], "tool_use")},
    {status: 200, text: anthropicTurn([{type: "tool_use", id: "toolu_p", name: "propose_component_edits", json: [JSON.stringify({changes: [{component_id: r1.id, field: "value", value: "4.7 kΩ"}], summary: "Set R1 to 4.7 kΩ"})]}], "tool_use")},
    {status: 200, text: anthropicTurn([{type: "text", chunks: ["I found 1 violation and proposed ", "a new value for R1."]}], "end_turn", {input_tokens: 2000, output_tokens: 30, cache_read_input_tokens: 1500})});
  await X.execute("ai.send", {prompt: "Run DRC and fix R1"});
  assert.ok(await until(() => /proposed a new value for R1/.test(texts()) && !/■ Stop/.test(texts())), texts());
  sent = req().slice(2);
  const drcResult = JSON.parse(JSON.parse(sent[1].body).messages[2].content[0].content);
  assert.equal(drcResult.total, 1, "the DRC ran in the editor and its result went back to the model");
  assert.match(texts(), /Ran DRC: 1 violation/, "a tool card summarises the call");
  assert.match(texts(), /Proposed: Set R1 to 4\.7 kΩ \(1 change\)/);
  assert.match(texts(), /R1 value: "10 kΩ" → "4\.7 kΩ"/);
  assert.match(texts(), /tokens/, "token usage is shown per reply");
  assert.equal(r1.value, "10 kΩ", "nothing changed before review");
  assert.equal(history.length, 0);
  const review = buttons().find(b => b.command === "ai.review");
  assert.ok(review && review.label === "Review proposal");
  assert.equal(await X.execute("ai.review", ...review.args), "applied");
  assert.ok(prompts.includes("review"), "the editor's review dialog decided");
  assert.equal(project.documents.find(d => d.kind === "pcb").items.find(i => i.id === r1.id).value, "4.7 kΩ");
  assert.equal(history.length, 1, "one undo step");
  assert.match(texts(), /Proposal P1: applied \(1 change\)/);
  assert.ok(!buttons().some(b => b.command === "ai.review"), "a reviewed proposal cannot be applied twice");

  // 3) A stale proposal is refused; a discarded one changes nothing.
  net.fixtures.push(
    {status: 200, text: anthropicTurn([{type: "tool_use", id: "toolu_q", name: "propose_edits", json: [JSON.stringify({summary: "Move R1", operations: [{action: "move", id: r1.id, dx: 1, dy: 0}]})]}], "tool_use")},
    {status: 200, text: anthropicTurn([{type: "text", chunks: ["Queued."]}], "end_turn")});
  await X.execute("ai.send", {prompt: "Move R1"});
  assert.ok(await until(() => /Queued\./.test(texts()) && !/■ Stop/.test(texts())));
  const reviewNote = JSON.parse(req().at(-2).body).messages.at(-1).content[0].text;
  assert.match(reviewNote, /\[Waffle: The user reviewed proposal P1: applied/, "the model hears how the review went");
  host.edit(() => { project.documents.find(d => d.kind === "pcb").items.find(i => i.id === r1.id).value = "5k"; });
  assert.equal(await X.execute("ai.review", "P2"), "stale");
  assert.match(texts(), /Proposal P2: stale/);

  // 4) Stop cancels a reply; Ask AI about Selection sends the selection request.
  await X.execute("ai.reset");
  assert.equal(X.execute("ai.askSelection").constructor, Promise);
  host.select([r1.id]);
  net.fixtures.push({status: 200, text: anthropicTurn([{type: "text", chunks: ["R1 is a resistor."]}], "end_turn")});
  await X.execute("ai.askSelection");
  assert.ok(await until(() => /R1 is a resistor/.test(texts()) && !/■ Stop/.test(texts())));
  assert.match(JSON.parse(req().at(-1).body).messages[0].content[0].text, /get_selection/);
  assert.match(texts(), /Ask about the selection \(1 object\)/);

  // 5) Errors from the provider show in the panel; switching provider starts a new chat.
  net.fixtures.push({status: 401, text: JSON.stringify({type: "error", error: {type: "authentication_error", message: "invalid x-api-key"}})});
  await X.execute("ai.send", {prompt: "hi"});
  assert.ok(await until(() => /rejected the API key/.test(texts())));
  await X.execute("ai.setProvider", "openai");
  assert.match(texts(), /Switched to ChatGPT \(OpenAI\)\. A new chat started\./);
  assert.match(texts(), /no model chosen/, "OpenAI has no hard-coded default model");
  await X.execute("ai.setModel", "gpt-test-1");
  await X.execute("ai.saveSettings", {key: "sk-openai-9999"});
  net.fixtures.push({status: 200, text: openaiTurn(["Hello from GPT"])});
  await X.execute("ai.send", {prompt: "hi"});
  assert.ok(await until(() => /Network access is off|not permitted/.test(texts()) || /Hello from GPT/.test(texts())));
  assert.match(texts(), /network:api\.openai\.com/, "a host that is not switched on is refused, with directions");
  await X.grant(ID, "network:api.openai.com", true);
  await X.execute("ai.show");
  net.fixtures.push({status: 200, text: openaiTurn(["Hello from GPT"])});
  await X.execute("ai.send", {prompt: "hi"});
  assert.ok(await until(() => /Hello from GPT/.test(texts())), texts());
  assert.equal(JSON.parse(req().at(-1).body).model, "gpt-test-1"); assert.equal(req().at(-1).headers.authorization, "Bearer sk-openai-9999");
  X.shutdown();
  console.log("PASS AI assistant: Anthropic and OpenAI streams with tool turns, retries, limits, cancel; extension panel, consent, DRC tool card, reviewed proposals");
})();
globalThis.__testDone = done.catch(e => { console.error(e); X.shutdown(); if (globalThis.process) process.exitCode = 1; throw e; });
