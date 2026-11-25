"use strict";
// Check the VS Code extension’s native record positions, schema, diagnostics and Git
// change reports under Node and JSC. Node also exercises the physical folder boundary.
const assert = require("node:assert/strict");
const fs = require("node:fs");
require("../../app/core/model.js"); require("../../app/library/parts.js"); require("../../app/schematic/sch-objects.js");
const J = require("../../integrations/vscode/lib/jsonpos.js");
const V = require("../../integrations/vscode/lib/validate.js");
const P = require("../../integrations/vscode/lib/problems.js");
const D = require("../../integrations/vscode/lib/diff.js");
const root = __dirname + "/../../";
const F = require("../../integrations/vscode/lib/folder.js");
const schema = JSON.parse(String(fs.readFileSync(root + "integrations/vscode/schema/waffle-folder-record.schema.json", "utf8")));
const folder = root + "tests/fixtures/cad-native/sample-sensor/";
const manifestText = String(fs.readFileSync(folder + "Project.waffle", "utf8"));
const index = F.manifest(manifestText, "Project.waffle");
const memberText = ref => String(fs.readFileSync(folder + ref, "utf8"));
const board = () => F.snapshot(index, memberText);
const pcbRef = index.members.find(r => r.kind === "pcb"), sheetRef = index.members.find(r => r.kind === "schematic");
const boardText = memberText(pcbRef.path), sheetText = memberText(sheetRef.path);
const obsoleteText = '{"format":"atrium","version":1,"documents":[]}';

assert.equal(F.core().codec.sha256(Uint8Array.of(97,98,99)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

// Public extension identity, with the file types and settings used by existing workspaces.
{
  const metadata = JSON.parse(fs.readFileSync(root + "integrations/vscode/package.json", "utf8"));
  assert.equal(metadata.name, "waffle-eda");
  assert.equal(metadata.publisher, "waffle-eda");
  assert.equal(metadata.displayName, "Waffle EDA");
  const contributes = metadata.contributes;
  assert.ok(contributes.configuration.properties["waffle.serverPath"]);
  const [preview] = contributes.customEditors;
  assert.equal(preview.viewType, "waffle.preview");
  assert.deepEqual(preview.selector.map(s => s.filenamePattern), ["*.waffle"]);
  assert.ok(!JSON.stringify(metadata).includes(".atrium"));
  assert.equal(contributes.languages[0].id,"waffle-native");
  assert.ok(contributes.languages[0].extensions.includes(".wpcb"));
}

// ------------------------------------------------------------------ JSON positions
{
  const text = '{\n  "a": [1, {"id": "x", "b": true}],\n  "c": "s\\"q"\n}';
  const {root: tree, error} = J.parse(text);
  assert.equal(error, null);
  assert.equal(J.at(tree, ["a", 1, "b"]).value, true);
  assert.equal(J.at(tree, ["c"]).value, "s\"q");
  const found = J.findId(tree, "x");
  assert.deepEqual(found.path, ["a", 1]);
  const [s, e] = J.keyRange(tree, ["c"]);
  assert.equal(text.slice(s, e), '"c"');
  assert.deepEqual(J.lines(text).position(s), {line: 2, character: 2});
  assert.equal(J.at(tree, ["a", 5, "zzz"]), J.at(tree, ["a"]), "a missing path resolves to its deepest ancestor");
  for (const bad of ['{"a": }', '{"a": 1,}', "[1 2]", '{"a": "unterminated', "{} x", "tru"]) {
    const r = J.parse(bad);
    assert.equal(r.root, null, bad);
    assert.ok(r.error.offset >= 0 && r.error.offset <= bad.length, bad);
  }
  const nativeRow = boardText.split("\n").find(row=>row.includes('"id":"b-U1"'));
  assert.equal(J.parse(nativeRow).root.type, "object");
  assert.equal(J.idIndex(J.parse(nativeRow).root).get("b-U1").value, "b-U1");
}

// Validate native records rather than passing newline-delimited files to a whole-document JSON schema.
{
  const header = JSON.parse(manifestText.split("\n")[0]);
  assert.deepEqual(V.checkSchema(header, schema), []);
  assert.ok(V.checkSchema({kind:"part"},schema).length > 0);
  assert.equal(F.manifest(manifestText,"Project.waffle").project.name,index.project.name);
  for (const name of ["early.waffle", "early.atrium"]) {
    assert.throws(() => F.manifest(obsoleteText,name), /This file is from a pre-release Waffle build; re-import the design from its source EDA/);
  }
  assert.throws(() => F.parse('ATRIUM-JOURNAL 1\n{}', "Old.waffle"), /pre-release Waffle/);
  assert.throws(() => F.manifest(manifestText + manifestText.split("\n")[1]+"\n", "duplicate.waffle"));
  assert.throws(() => F.snapshot(index, name=>name === pcbRef.path ? boardText.replace(pcbRef.id,"other") : memberText(name)));
  assert.deepEqual(board().documents.map(d=>d.id),[sheetRef.id,pcbRef.id]);
}

// --------------------------------------------------------------- DRC / ERC into Problems
{
  const drc = {document_id: pcbRef.id, items: [
    {type: "width", rule: "Width", id: "thin", title: "Track (Top Layer) GND", actual: 0.05, required: 0.15, limit: "min", at: [7, 18]},
    {type: "unrouted", rule: "UnRoutedNet", id: "b-C1", other_id: "b-R1", title: "Net FILTER between C1.1 and R1.2", detail: "Un-routed connection", actual: 3.6, at: [13.3, 13.5]},
    {type: "clearance", rule: "Clearance", id: "gone", title: "Line\u2028break\nhere", at: [1, 2]}]};
  const out = P.fromDrc(drc, boardText);
  assert.equal(out.length, 3);
  assert.equal(boardText.slice(out[1].start, out[1].end), '"b-C1"', "placed on the object's id");
  assert.equal(out[1].severity, "warning"); assert.equal(out[0].severity, "error");
  assert.match(out[0].message, /actual 0\.05 mm, required ≥ 0\.15 mm\) at \(7, 18\) mm/);
  assert.ok(!/[\n\u2028]/.test(out[2].message), "design text stays on one line");
  assert.equal(boardText.slice(out[0].start,out[0].end), JSON.stringify(pcbRef.id));
  const erc = {classes: {Error: {items: [{check: "unannotated", text: "Component R? has not been annotated", document_id: "amwmqqymcvjqh0taq6if", object_id: "s-R1", at: [104.14, 78.74]}]},
    Warning: {items: [{check: "singlePinNets", text: "Net X", object_id: "s-J1"}]}, Info: {items: [{check: "x", text: "i"}]}}};
  const e = P.fromErc(erc, sheetText);
  assert.deepEqual(e.map(x => x.severity), ["error", "warning", "information"]);
  assert.equal(sheetText.slice(e[0].start, e[0].end), '"s-R1"');
  assert.deepEqual([e[2].start, e[2].end], [0, 1], "unknown objects go to the top of the file");
}

if (process.versions.node) {
  const path = require("node:path"), os = require("node:os");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-vscode-native-"));
  try {
    const copy = path.join(scratch,"project"), original = path.join(copy,pcbRef.path);
    fs.cpSync(folder,copy,{recursive:true});
    assert.equal(F.fromDisk(copy).project.documents.length,2);
    const note = path.join(copy,"Notes.waffle"), second = path.join(copy,"Second.waffle");
    fs.writeFileSync(note,"Ordinary notes outside the project.\n");
    assert.equal(F.fromDisk(copy).project.documents.length,2);
    fs.writeFileSync(second,manifestText);
    assert.throws(()=>F.fromDisk(copy),/Choose the \.waffle manifest/);
    fs.unlinkSync(second);
    fs.unlinkSync(note);
    const retired = path.join(copy,"Retired.waffle");
    fs.writeFileSync(retired,obsoleteText);
    assert.throws(()=>F.fromDisk(retired),/pre-release Waffle/);
    assert.equal(F.fromDisk(copy).project.documents.length,2);
    fs.unlinkSync(retired);
    const outside = path.join(scratch,"outside.wpcb");
    fs.renameSync(original,outside);
    fs.symlinkSync(outside,original);
    assert.throws(()=>F.fromDisk(copy),/ordinary file inside/);
    fs.unlinkSync(original);
    fs.linkSync(outside,original);
    assert.throws(()=>F.fromDisk(copy),/ordinary native project member/);
    fs.unlinkSync(original); fs.renameSync(outside,original);
    let changed=false;
    assert.throws(()=>F.fromDisk(copy,null,name=>{
      if (!changed && name === original) {
        changed=true; fs.appendFileSync(original,"\n");
      }
    }),/saved project changed/);
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
}

if (process.versions.node) {
  const path = require("node:path"), os = require("node:os"), {execFileSync} = require("node:child_process");
  const python = process.env.WAFFLE_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-vscode-bundle-"));
  try {
    for (const name of ["app","integrations/vscode"]) fs.cpSync(path.join(root,name),path.join(scratch,name),{
      recursive:true,filter(filename) {
        const rel = path.relative(root,filename).split(path.sep).join("/");
        return rel !== "integrations/vscode/dist" && rel !== "integrations/vscode/media/app" &&
          !/^app\/(?:worker-source|folder-.*-worker-source|calculation-worker-source|datasheet-worker-source)\.js$/.test(rel);
      }
    });
    fs.mkdirSync(path.join(scratch,"mcp"));
    fs.copyFileSync(path.join(root,"mcp/board_runner.py"),path.join(scratch,"mcp/board_runner.py"));
    fs.mkdirSync(path.join(scratch,"scripts"));
    fs.copyFileSync(path.join(root,"scripts/gen-shortcuts.py"),path.join(scratch,"scripts/gen-shortcuts.py"));
    fs.copyFileSync(path.join(root,"LICENSE"),path.join(scratch,"LICENSE"));

    // A future decoder dependency reaches another local module and data file.
    // The production packaging path must pick up every edge and archive subdirectories.
    const dependency = path.join(scratch,"app","formats","preview-test-dependency");
    fs.mkdirSync(dependency);
    const modelSource = path.join(scratch,"app","formats","format-2-model.js"), entry = "function queryRecords() {";
    const model = fs.readFileSync(modelSource,"utf8");
    assert.ok(model.includes(entry));
    fs.writeFileSync(modelSource,model.replace(entry,entry+'\n    if(typeof require === "function") require("./preview-test-dependency/check.js");'));
    fs.writeFileSync(path.join(dependency,"check.js"),'require("./validate.cjs");\n');
    fs.writeFileSync(path.join(dependency,"validate.cjs"),'if(require("./value.json").token !== "preview-test") throw Error("Missing packaged format dependency");\n');
    const data = path.join(dependency,"value.json");
    fs.writeFileSync(data,JSON.stringify({token:"preview-test"}));

    const extension = path.join(scratch,"integrations","vscode");
    const script = (name,...args) => execFileSync(python,["-B",path.join(extension,"scripts",name),...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
    script("package-vsix.py");
    const directory = path.join(extension,"dist"), vsix = fs.readdirSync(directory).find(name=>name.endsWith(".vsix"));
    const extracted = path.join(scratch,"installed");
    execFileSync(python,["-m","zipfile","-e",path.join(directory,vsix),extracted]);
    const installed = path.join(extracted,"extension"), query = path.join(root,"tests","fixtures","design-query","query-proof","Query proof.waffle");
    const probe = 'const result=require(process.argv[1]).fromDisk(process.argv[2]);console.log(JSON.stringify(result.project.documents.map(doc=>doc.id)));';
    const ids = JSON.parse(execFileSync(process.execPath,["-e",probe,path.join(installed,"lib","folder.js"),query],{encoding:"utf8"}));
    assert.deepEqual(ids,["analog","control","power","monitor"],"the installed package opens Query proof with all documents in project order");
    const scripts = JSON.parse(fs.readFileSync(path.join(installed,"media","app","viewer-scripts.json"),"utf8"));
    assert.ok(scripts.indexOf("canvas/stroke-font.js") >= 0 && scripts.indexOf("canvas/stroke-font.js") < scripts.indexOf("pcb/pcb-text.js"));
    assert.ok(scripts.indexOf("canvas/pcb-net-labels.js") >= 0 && scripts.indexOf("canvas/pcb-net-labels.js") < scripts.indexOf("canvas/canvas.js"));
    script("bundle-viewer.py","--check");
    fs.writeFileSync(data,JSON.stringify({token:"changed"}));
    assert.throws(()=>script("bundle-viewer.py","--check"),error=>/preview-test-dependency[/\\]value\.json/.test(error.stderr));
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
}

// ----------------------------------------------------------------- change summary
{
  const before = board(), after = board();
  assert.equal(D.summarize(before, after).identical, true);
  assert.match(D.format(D.summarize(before, after)), /No design changes/);
  const sch = after.documents.find(d => d.kind === "schematic"), pcb = after.documents.find(d => d.kind === "pcb");
  const r2 = sch.items.find(i => i.ref === "R2");
  r2.value = "220 Ω"; r2.x += 2.54;
  sch.items = sch.items.filter(i => i.ref !== "C2");
  sch.items.push({kind: "part", ref: "R9", def: "std-r", value: "1k", id: "s-R9", x: 10, y: 10, angle: 0, pinNets: {"1": "VOUT", "2": "NEWNET"}});
  const j1 = sch.items.find(i => i.ref === "J1"); j1.pinNets = {...j1.pinNets, "2": "VIN2"};
  pcb.items.find(i => i.kind === "track").width = 0.5;
  after.library.push({id: "lib-new", name: "New part", symbol: {pins: [], shapes: []}});
  const s = D.summarize(before, after), d = s.documents.find(x => x.kind === "schematic");
  assert.deepEqual(d.parts.added.map(p => p.ref), ["R9"]);
  assert.deepEqual(d.parts.removed.map(p => p.ref), ["C2"]);
  assert.deepEqual(d.parts.changed.map(p => [p.ref, p.fields.map(f => f.field)]), [["J1", ["pinNets"]], ["R2", ["value", "x"]]]);
  assert.deepEqual(d.nets.added.map(n => n.name).sort(), ["NEWNET", "VIN2"]);
  const vout = d.nets.changed.find(n => n.name === "VOUT");
  assert.deepEqual(vout.gained, ["R9.1"]);
  const vin = d.nets.changed.find(n => n.name === "VIN");
  assert.deepEqual(vin.lost, ["J1.2"]);
  assert.deepEqual(s.documents.find(x => x.kind === "pcb").objects, {track: {added: 0, removed: 0, changed: 1}});
  assert.deepEqual(s.totals.library, {added: 1, removed: 0, changed: 0});
  const md = D.format(s, {title: "Board.waffle"});
  for (const want of ["Added **R9**", "Removed **C2**", "Changed **R2**: value 100 Ω → 220 Ω; moved", "Changed **J1**: pin 2 VIN → VIN2", "Added net **NEWNET**", "Changed net **VOUT**: +R9.1", "track: +0 −0 ~1", "Added New part (lib-new)"])
    assert.ok(md.includes(want), want + "\n" + md);
  // Design text cannot inject Markdown links or HTML into the summary.
  const evil = board(); evil.documents[0].items.push({kind: "part", ref: "[x](https://evil.example)<img src=x>", def: "std-r", value: "*v*", id: "e1", x: 0, y: 0});
  const emd = D.format(D.summarize(board(), evil));
  assert.ok(emd.includes("\\[x\\](https://evil.example)\\<img src=x\\>") && emd.includes("\\*v\\*"), emd);
  // A whole document added or removed.
  const removed = board(); removed.documents = removed.documents.filter(x => x.kind !== "pcb");
  const rs = D.summarize(board(), removed);
  assert.equal(rs.documents.find(x => x.status === "removed").parts.removed.length, 7);
  // Waivers (waivers.js loads with the engine): their own section, not a raw "drcWaivers" field.
  const wa = board(), wb = board(), wpcb = wb.documents.find(x => x.kind === "pcb"), track = wpcb.items.find(i => i.kind === "track");
  wpcb.drcWaivers = [{id: "w1", type: "width", rule: "Width", objects: [track.id], geometry: {[track.id]: globalThis.AtriumWaivers.signature(track)}, note: "fab ok", created: "2026-11-20T00:00:00Z",
    title: "Track", key: "layout.width:x", check: "layout.width", holds: "while-not-worse"}];
  const ws = D.summarize(wa, wb);
  assert.equal(ws.identical, false); assert.deepEqual(ws.totals.waivers, {added: 1, removed: 0, changed: 0, stale: 0}); assert.deepEqual(ws.projectFields, []);
  const wmd = D.format(ws);
  assert.ok(wmd.includes("## Waivers") && wmd.includes("Waiver added: Track · fab ok"), wmd);
}

// --------------------------------------------- extension.js against a stub of the VS Code API
// Activation, live validation, workspace-trust gating and the preview webview's CSP and
// message protocol. The stub stands in for the "vscode" module (Node: a resolver hook; JSC
// shim: its require cache).
const shown = [], commands = {}, collections = {}, providers = {};
const ev = () => () => ({dispose() {}});
const vscodeStub = {
  RelativePattern: class { constructor(base, glob) { Object.assign(this,{base,glob}); } },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, {range, message, severity}); } },
  Uri: {joinPath: (u, ...p) => ({path: [u.path, ...p].join("/").replace(/\/+/g, "/"), fsPath: [u.fsPath, ...p].join("/").replace(/\/+/g, "/")}), file: p => ({path: p, fsPath: p})},
  DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2}, ViewColumn: {Beside: -2}, ProgressLocation: {Notification: 15},
  window: {createOutputChannel: () => ({appendLine() {}, show() {}, dispose() {}}), activeTextEditor: null,
    showInformationMessage: async m => { shown.push(m); }, showWarningMessage: async m => { shown.push(m); }, showErrorMessage: async m => { shown.push(m); },
    registerCustomEditorProvider: (id, p) => { providers[id] = p; return {dispose() {}}; }},
  languages: {createDiagnosticCollection: name => { const m = new Map(); collections[name] = m;
    return {set: (u, d) => m.set(String(u), d), delete: u => m.delete(String(u)), clear: () => m.clear(), get: u => m.get(String(u)), dispose() {}}; }},
  commands: {registerCommand: (id, fn) => { commands[id] = fn; return {dispose() {}}; }, executeCommand: async () => {}},
  workspace: {isTrusted: false, textDocuments: [], workspaceFolders: [], getConfiguration: () => ({get: (k, d) => d}),
    createFileSystemWatcher: () => ({onDidCreate:ev(),onDidChange:ev(),onDidDelete:ev(),dispose(){}}),
    onDidOpenTextDocument: ev(), onDidChangeTextDocument: ev(), onDidCloseTextDocument: ev(), onDidChangeConfiguration: ev()}
};
const extDir = root + "integrations/vscode/";
if (typeof globalThis.$262 === "object" || !require("node:module")) require.cache[require("node:path").join(extDir, "vscode.js")] = {exports: vscodeStub};
else {
  const M = require("node:module"), orig = M._resolveFilename;
  M._resolveFilename = function (req, ...a) { return req === "vscode" ? "vscode" : orig.call(this, req, ...a); };
  require.cache.vscode = {id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub};
}
const doc = (text, name) => {
  const starts = [0]; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return {uri: {path: folder + name, fsPath: folder + name, scheme: "file", toString: () => "file:///w/" + name}, isClosed: false, isDirty: false, getText: () => text,
    positionAt: o => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= o) l++; return {line: l, character: o - starts[l]}; }};
};
const docs = [doc(manifestText, "Project.waffle"), doc(obsoleteText, "Early.waffle"), doc('{"kind": ', "Broken.waffle"), doc("{}", "other.json"),
  doc(manifestText + manifestText.split("\n")[1]+"\n", "Duplicate.waffle")];
vscodeStub.workspace.textDocuments = docs;
const ext = require("../../integrations/vscode/extension.js");
ext.activate({extensionPath: extDir, extensionUri: {path: extDir, fsPath: extDir}, subscriptions: []});
globalThis.__testDone = (async () => {
  assert.deepEqual(Object.keys(commands).sort(), ["waffle.clearProblems", "waffle.compareWithHead", "waffle.generateOutputs", "waffle.openPreview", "waffle.runDrc", "waffle.runErc"]);
  for (let i = 0; i < 100 && collections.waffle.size < 4; i++) await new Promise(r => setTimeout(r, 20));
  const diag = d => collections.waffle.get(String(d.uri));
  assert.deepEqual(diag(docs[0]), [], "the sample board validates clean");
  assert.match(diag(docs[1])[0].message, /pre-release Waffle/);
  assert.equal(diag(docs[2]).length, 1, "invalid JSON is one problem");
  assert.equal(diag(docs[3]), undefined, "other JSON files are left alone");
  assert.match(diag(docs[4])[0].message,/unique and sorted/);
  assert.equal(diag(docs[4])[0].range.start.line, manifestText.split("\n").length-1);
  // Untrusted workspace: nothing that starts a process runs.
  for (const c of ["waffle.runDrc", "waffle.runErc", "waffle.generateOutputs", "waffle.compareWithHead"]) await commands[c]();
  assert.equal(shown.filter(m => /Trust this workspace/.test(m)).length, 4);
  // The preview: strict CSP, local scripts only, and a one-way message protocol.
  let onMessage = null; const posted = [];
  const panel = {webview: {cspSource: "vscode-webview://x", asWebviewUri: u => ({toString: () => "vscode-webview://x" + u.path}), postMessage: m => posted.push(m),
    onDidReceiveMessage: f => { onMessage = f; return {dispose() {}}; }}, onDidChangeViewState: () => ({dispose() {}}), onDidDispose() {}, active: true};
  providers["waffle.preview"].resolveCustomTextEditor(docs[0], panel);
  const html = panel.webview.html;
  assert.deepEqual([panel.webview.options.enableScripts, panel.webview.options.enableCommandUris, panel.webview.options.enableForms], [true, false, false]);
  assert.match(html, /content="default-src 'none'; img-src vscode-webview:\/\/x data: blob:; style-src vscode-webview:\/\/x; script-src vscode-webview:\/\/x;/);
  assert.ok(!/unsafe-|https?:\/\/|<script>|\son[a-z]+=/i.test(html), "no inline script, no event handlers, no remote content");
  assert.ok([...html.matchAll(/<script src="([^"]+)"/g)].every(m => m[1].startsWith("vscode-webview://x" + extDir.replace(/\/+/g, "/") + "media/")), "scripts only from media/");
  if (fs.existsSync(extDir + "media/app/viewer-scripts.json")) {
    const files = [...html.matchAll(/<script src="[^"]*\/([^/\"]+)"/g)].map(match => match[1]);
    const lettering = ["stroke-font.js", "vectorize.js", "pcb-text-rich.js", "pcb-text.js", "designator-place.js", "canvas.js"];
    assert.deepEqual(files.filter(name => lettering.includes(name)), lettering, "the packaged viewer loads the editor’s PCB lettering before drawing");
  }
  if (!process.versions.node) F.fromDisk = () => ({project: F.snapshot(index,memberText)});
  onMessage({type:"ready"});
  assert.deepEqual(posted.map(m => [m.type, m.project?.documents.map(d=>d.id)]), [["project",[sheetRef.id,pcbRef.id]]]);
  onMessage({type: "edit", text: "{}"}); onMessage({type: "save"});
  assert.equal(posted.length, 1, "the webview cannot ask for anything else");
  ext.deactivate();
  console.log("vscode-extension: ok");
})();
