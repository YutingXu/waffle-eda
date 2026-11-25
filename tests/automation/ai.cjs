"use strict";
// Exercise the same proposal file emitted by the MCP subprocess and reviewed by Waffle.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
require("../../app/core/model.js");
for (const name of ["source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model", "import-sidecars",
  "format-2-closure", "project-archive", "browser-project", "folder-project-engine", "folder-project"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
require("../../app/library/parts.js");
require("../../app/automation/proposal.js");
require("../../app/core/atrium-api.js");
require("../../app/automation/ai.js");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waffle-ai-"));
let session;
async function run() {
  const name = "Board.waffle", source = path.join(directory, name);
  fs.cpSync(path.join(__dirname, "../../mcp/examples/sensor-interface"), directory, {recursive: true});
  const read = file => new Uint8Array(fs.readFileSync(path.join(directory, file)));
  const manifest = AtriumFormat2Model.parse(read(name), {kind: "project"});
  const receipt = await AtriumFormat2Closure.verify(manifest, read);
  const files = new Map([name, ...receipt.members.map(m => m.path)].map(file => [file, read(file)]));
  const assertSavedBytes = () => {
    for (const [file, bytes] of files) assert.deepEqual(read(file), bytes, file);
  };
  const folder = AtriumBrowserProject.create(name, files);
  session = await AtriumFolderProject.open(folder, {host: folder.host, workerFactory() {
    const engine = AtriumFolderProjectEngine.create();
    return {run: (op, message, read, readBatch) => engine.run({op, ...message, read, readBatch}), close() {}};
  }});
  let project = await session.requireClosure({purpose: "proposal", assets: false});
  const undo = [];
  const schematic = project.documents.find(d => d.kind === "schematic");
  const resistor = schematic.items.find(i => i.id === "s-R1");
  const originalValue = resistor.value;
  const changes = [
    {component_id: resistor.id, field: "value", value: "47 kΩ"},
    {component_id: resistor.id, field: "y", value: resistor.y + schematic.grid}
  ];
  const requests = [
    {id: 1, method: "initialize", params: {protocolVersion: "2025-11-25", capabilities: {}, clientInfo: {name: "Waffle UI test", version: "1"}}},
    {method: "notifications/initialized"},
    {id: 2, method: "tools/call", params: {name: "propose_component_edits", arguments: {changes}}}
  ];
  // The same native read host used by MCP tests runs both real server connections.
  const runner = [
    "from native_sample import ensure_native_host, ROOT",
    "import subprocess, sys",
    "from pathlib import Path",
    "ensure_native_host()",
    "messages = sys.stdin.buffer.read()",
    "for access in (['--read-only'], []):",
    "    server = [sys.executable, str(ROOT / 'mcp/server.py'), '--project', sys.argv[1], *access]",
    "    reply = subprocess.run(server, input=messages, stdout=subprocess.PIPE, check=True)",
    "    sys.stdout.buffer.write(reply.stdout)",
    "    if access and list(Path(sys.argv[1]).parent.glob('*.waffle-ai')):",
    "        raise AssertionError('The read-only connection created a proposal file.')"
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", runner, source], {
    cwd: path.join(__dirname, "../support"), encoding: "utf8", timeout: 60000,
    input: requests.map(r => JSON.stringify({jsonrpc: "2.0", ...r})).join("\n") + "\n"
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const [denied, reply] = result.stdout.trim().split("\n").map(line => JSON.parse(line)).filter(r => r.id === 2);
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.error.code, "read_only");
  assert.equal(reply.result.isError, false, JSON.stringify(reply.result));
  const proposalPath = JSON.parse(reply.result.content[0].text).proposal_file;
  assert.equal(path.extname(proposalPath), ".waffle-ai");
  const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
  assert.equal(proposal.source_sha256, receipt.sha256);
  assert.deepEqual(proposal.format2_base, {
    project_id: manifest.header.id, manifest_sha256: AtriumFormat2.sha256(AtriumFormat2.serialize(manifest)),
    members: receipt.members.map(({path, sha256}) => [path, sha256])
  });
  assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith(".waffle-ai")), [path.basename(proposalPath)]);
  assertSavedBytes();

  const context = () => ({
    project, currentProject: () => project, folderProject: session, defs: new Map(project.library.map(d => [d.id, d])),
    edit(fn) {undo.push(structuredClone(project)); fn();}
  });
  await AtriumAI.prepareFolderProposal(context(), proposal);
  await assert.rejects(AtriumAI.prepareFolderProposal(context(), {...proposal, source_sha256: "0".repeat(64)}), /saved project changed/);
  const otherFolder = {...proposal.format2_base, project_id: "another-folder"};
  await assert.rejects(AtriumAI.prepareFolderProposal(context(), {...proposal, format2_base: otherFolder}), /saved project folder/);
  const currentResistor = () => project.documents[0].items.find(i => i.id === resistor.id);
  assert.equal(AtriumAI.inspect(proposal, project).length, 2);
  // Unrelated edits survive targeted optimistic concurrency checks.
  project.documents[0].name = "Updated sheet name";
  const before = structuredClone(project);
  AtriumAI.apply(context(), proposal);
  assert.equal(undo.length, 1, "all selected edits make one undo transaction");
  assert.equal(currentResistor().value, "47 kΩ");
  assert.equal(currentResistor().y, changes[1].value);
  assert.deepEqual(project.documents[1], before.documents[1], "physical changes require a separate ECO review");
  assertSavedBytes();
  // The assistant's host plan and a third-party transaction produce the same sheet,
  // connected wires, unchanged board and single checkpoint as the MCP file just applied.
  const ops=[{op:"update",id:resistor.id,set:{value:changes[0].value}},{op:"transform",id:resistor.id,set:{y:changes[1].value}}];
  const results=[];
  for(const queued of [false,true]){
    const host=AtriumAPI.headless(structuredClone(before),{extension:{id:queued?"assistant":"extension",permissions:{"read:project":true,"propose:edits":true}},
      approve:view=>{results.push(structuredClone(view.proposal.ops));return view.rows.map(r=>r.index);}});
    if(queued){const d=host.api.proposals.draft("transaction",{ops});assert.equal(host.steps.length,0);host.api.proposals.review(d.handle);}
    else host.api.transaction("Change component",tx=>{tx.update(resistor.id,ops[0].set);tx.transform(resistor.id,ops[1].set);});
    assert.deepEqual(host.project,project);assert.equal(host.steps.length,1);
  }
  assert.deepEqual(results[0],results[1],"extension and assistant present the same guarded operations");
  const afterApply = structuredClone(project);
  assert.throws(() => AtriumAI.apply(context(), proposal), /changed|stale|fresh/i);
  assert.deepEqual(project, afterApply);
  project = undo.pop();
  assert.deepEqual(project, before);
  const bad = (overrides) => ({...proposal, changes: [{...proposal.changes[0], ...overrides}]});
  for (const p of [bad({id: "unknown"}), bad({field: "unexpected"}), bad({before: "stale"}), bad({after: 99}),
    {...proposal, changes: [proposal.changes[0], proposal.changes[0]]}, {...proposal, project: "A different design"}]) {
    assert.throws(() => AtriumAI.apply(context(), p));
    assert.deepEqual(project, before, "rejection must leave the whole project alone");
    assert.equal(undo.length, 0);
  }
  // A stale second edit rejects the entire proposal, including an otherwise valid first change.
  const v2 = AtriumProposal.build(before, afterApply, {allowV1: false}).proposal;
  const valueIndex = v2.ops.findIndex(op => op.id === resistor.id && op.path?.[0] === "value");
  assert.notEqual(valueIndex, -1);
  assert.equal(AtriumAI.inspect(v2, project).length, v2.ops.length);
  currentResistor().y += 1;
  const liveY = currentResistor().y;
  assert.throws(() => AtriumAI.inspect(v2, project), /changed since/);
  assert.throws(() => AtriumAI.apply(context(), proposal));
  assert.throws(() => AtriumAI.apply(context(), v2), /changed since/);
  assert.equal(currentResistor().value, originalValue, "the preceding edit is still unapplied");
  assert.equal(undo.length, 0);
  const selectedV1 = {...proposal, changes: proposal.changes.filter(row => row.field === "value")};
  assert.equal(AtriumAI.apply(context(), selectedV1), 1);
  const appliedV1 = structuredClone(project);
  project = undo.pop();
  assert.equal(AtriumAI.apply(context(), v2, [valueIndex]), 1);
  assert.deepEqual(project, appliedV1);
  assert.equal(undo.length, 1);
  project = undo.pop();
  assert.equal(currentResistor().value, originalValue);
  assert.equal(currentResistor().y, liveY);
  assertSavedBytes();
  console.log("PASS MCP-produced proposals: precise field receipts, stale rejection, reviewed geometry, one-step undo, project binding, and unchanged saved bytes");
}
run().finally(async () => {
  try {await session?.close();}
  finally {fs.rmSync(directory, {recursive: true, force: true});}
}).catch(error => {console.error(error); process.exitCode = 1;});
