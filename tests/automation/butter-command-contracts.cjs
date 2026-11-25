"use strict";

// The standalone broker accepts the same feature declarations that the editor and MCP compile.
const assert = require("node:assert/strict");
require("../../app/automation/command-broker.js");
require("../../app/automation/command-catalog.js");
const broker = globalThis.AtriumButter;
const catalogue = globalThis.AtriumButterCatalog;
const sources = ["editor", "extension", "macro", "mcp", "mcp-macro"];
const modes = [undefined, "read", "plan", "proposal", "write"];
const argsCases = require("../fixtures/butter-command-arguments.json");

function outcome(spec, args, source, mode, granted) {
  try { return {mode:broker.check(spec, args, source, mode, granted)}; }
  catch (error) {
    assert.equal(typeof error.code, "string", error.message);
    return {error:error.code};
  }
}

let commands = 0;
for (const feature of Object.values(catalogue)) {
  for (const spec of feature.commands) {
    const {contract, ...raw} = spec;
    const id = "butter." + feature.feature + "." + spec.id;
    assert.ok(contract, id);
    for (const source of sources) {
      assert.equal(broker.eligible(raw, source), broker.eligible(spec, source), id + " / " + source);
      for (const mode of modes) {
        for (const granted of [false, true]) {
          assert.deepEqual(outcome(raw, {}, source, mode, granted), outcome(spec, {}, source, mode, granted),
            id + " / " + source + " / " + (mode ?? "default") + " / " + (granted ? "granted" : "ungranted"));
        }
      }
    }
    for (const row of argsCases.filter(row => row.command === id)) {
      const args = JSON.parse(row.args), expected = row.outcome === "accepted" ? {mode:"plan"} : {error:row.outcome};
      assert.deepEqual(outcome(raw, args, "editor", "plan", false), expected, id);
      assert.deepEqual(outcome(spec, args, "editor", "plan", false), expected, id);
    }
    commands++;
  }
}
assert.ok(commands && argsCases.every(row => {
  const [, feature, command] = row.command.split(".");
  return catalogue[feature]?.commands.some(spec => spec.id === command);
}), "Each public argument fixture must exercise a shipped command");
// Partial standalone descriptors keep default surfaces, mode order and the denial priority.
const partial = {kind:"edit"};
assert.deepEqual(outcome(partial, {}, "editor"), {mode:"proposal"});
assert.deepEqual(outcome(partial, {}, "extension", "plan", false), {mode:"plan"});
assert.deepEqual(outcome(partial, {}, "mcp-macro", "plan", false), {mode:"plan"});
assert.deepEqual(outcome(partial, {extra:true}, "editor", "write", false), {error:"write_not_allowed"});
assert.deepEqual(outcome(partial, {extra:true}, "editor", "write", true), {error:"invalid_arguments"});
assert.deepEqual(outcome(partial, {}, "extension", "read", true), {error:"unsupported_mode"});
assert.deepEqual(outcome({kind:"read"}, {}, "mcp"), {mode:"read"});
assert.deepEqual(outcome({kind:"output"}, {}, "macro", "plan", false), {error:"unsupported_surface"});

// A standalone caller can replace fields or mutate its surface list and schema.
const mutable = {kind:"edit", surfaces:["editor","macro","mcp"], mcpAdapter:true};
assert.equal(broker.eligible(mutable, "mcp-macro"), false);
mutable.mcpMacro = {type:["csv"]};
mutable.properties = {type:{type:"string"}};
mutable.required = ["type"];
assert.deepEqual(outcome(mutable, {type:"csv"}, "mcp-macro", "plan", false), {mode:"plan"});
assert.deepEqual(outcome(mutable, {type:"json"}, "mcp-macro", "plan", false), {error:"unsupported_surface"});
assert.deepEqual(outcome(mutable, {}, "mcp-macro", "plan", false), {error:"invalid_arguments"});
mutable.surfaces.splice(1, 1);
assert.equal(broker.eligible(mutable, "mcp-macro"), false);
assert.equal(broker.eligible(mutable, "extension"), true);
mutable.kind = "state";
assert.equal(broker.eligible(mutable, "extension"), false);
assert.deepEqual(outcome(mutable, {type:"csv"}, "editor"), {mode:"plan"});
mutable.properties.type.type = "number";
assert.deepEqual(outcome(mutable, {type:"csv"}, "editor"), {error:"invalid_arguments"});
assert.deepEqual(outcome(mutable, {type:1}, "editor"), {mode:"plan"});

// A partial compiled object retains its declared surfaces and falls back for omitted fields.
const compiled = {kind:"edit", properties:{size:{type:"integer"}}, required:["size"], contract:{surfaces:["mcp"]}};
assert.deepEqual(outcome(compiled, {size:1}, "mcp"), {mode:"proposal"});
assert.deepEqual(outcome(compiled, {}, "mcp"), {error:"invalid_arguments"});
assert.deepEqual(outcome(compiled, {size:1}, "editor"), {error:"unsupported_surface"});
compiled.contract.schema = {type:"object", additionalProperties:false};
assert.deepEqual(outcome(compiled, {}, "mcp"), {mode:"proposal"});

console.log(commands + " command contracts agree across " + sources.length + " callers.");
