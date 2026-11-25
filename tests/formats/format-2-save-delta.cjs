"use strict";

// Exercise the production canonical writer and save planner after opening all five regular owner kinds.
// Count encoded native rows independently of the planner's reported metrics.
const assert = require("node:assert/strict");
for (const name of ["model", "source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model", "folder-project-engine"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const F = AtriumFormat2, M = AtriumFormat2Model, E = AtriumFolderProjectEngine;
const utf8 = new TextEncoder(), decoder = new TextDecoder();
const fileBytes = file => F.serialize(file);
const asText = file => decoder.decode(fileBytes(file));
const published = (path, file) => {
  const bytes = fileBytes(file);
  return {path, bytes, sha256: F.sha256(bytes), length: bytes.length};
};
function splice(bytes, edits) {
  const portions = [];
  let offset = 0;
  for (const edit of edits) {
    portions.push(decoder.decode(bytes.subarray(offset, edit.offset)), edit.insert);
    offset = edit.offset + edit.remove;
  }
  portions.push(decoder.decode(bytes.subarray(offset)));
  return portions.join("");
}

function owner(kind, name, count) {
  const doc = {...Atrium.sheet(kind, name), id: "owner-" + kind};
  if (kind === "drawing") doc.drawing = {views:[{id:"drawing-view", at:[3.81,5.08]}]};
  if (kind === "panel") doc.panel = {cells:[{id:"panel-cell", x:3.81, y:5.08}]};
  doc.items = Array.from({length:count}, (_, i) => kind === "pcb"
    ? {kind:"part", id:"part-" + i, ref:"R" + i, def:"definition", x:i / 10, y:3.81}
    : {kind:"label", id:kind + "-label-" + i, x:i / 10, y:3.81, text:"Étude"});
  return doc;
}

async function sharedDocumentSettings() {
  for (const name of ["proposal","collab-crdt","widget-fallback","widget-catalogue","sheet-widgets","table-data","table-format"])
    require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
  require("../../mcp/folder-save.js");
  const T = AtriumTableData, P = AtriumProposal, S = AtriumMCPFolderSave;
  const design = Atrium.project("Shared settings");
  const sheet = owner("schematic","Shared sheet",1), sibling = owner("pcb","Untouched board",0);
  const table = T.upgrade(AtriumSheetWidgets.make("table",[1,2])), state = table.widget.state;
  const {id:row} = state.rows[0], {id:column} = state.columns[0];
  table.widget.state = T.change(state,row,column,{content:{kind:"literal",text:"Before cell"}});
  sheet.sheet = {size:"A4",titleBlock:"ansi"};
  sheet.items.push(table);
  design.documents = [sheet,sibling];
  const {manifest,manifestPath,files}=M.fromEditor(design);
  const {path,file}=files.find(entry=>entry.file.header.id===sheet.id);
  const manifestModel=M.manifest(manifest), ref=manifestModel.members.find(row=>row.id===sheet.id);
  const settings=[...file.records()].find(row=>row.kind==="documentSettings");
  const rawSettings='{"kind":"documentSettings","id":'+JSON.stringify(settings.id)+
    ',"value":{"memo":"Before metadata","x-settings":[3.40e-6]}}\n';
  const opaque='{"kind":"futureOwnerRecord","id":"zz-future-owner","unrecognized":[1.2300e-4,"\\u0061"]}\n';
  const raw=asText(file).replace(file.rawRecord(settings.id),rawSettings)
    .replace('"sheet":{"size":"A4","titleBlock":"ansi"}',
      '"sheet":{"infinite":false,"size":"A4","titleBlock":"ansi","x-print":[1.20e-4]}')+opaque;
  const physical=(path,text)=>{const bytes=utf8.encode(text);return {path,bytes,sha256:F.sha256(bytes)};};
  const board=files.find(entry=>entry.file.header.id===sibling.id);

  for (const useCRLF of [false,true]) {
    const eol=useCRLF?"\r\n":"\n", original=raw.replaceAll("\n",eol), originalEntry=physical(path,original);
    const parsed=M.parse(originalEntry.bytes), engine=E.create(), savedFiles=new Map(files.map(entry=>[entry.path,entry.file]));
    savedFiles.set(path,parsed);
    const saved={root:manifest,manifest:manifestModel,version:"2.1",files:savedFiles};
    await engine.run({op:"manifest",record:published(manifestPath,manifest)});
    const {owner:desktop}=await engine.run({op:"owner",record:originalEntry,ref});
    const project=doc=>({...manifestModel.project,documents:[doc,M.document(board.file)],library:[]});
    const edit=(before,after,stored,put=[])=>{
      const {items,...settings}=after; void items;
      const headlessBefore=project({...before,headlessDefault:false}), headlessAfter=project({...after,headlessDefault:false});
      const cli=()=>S.plan(saved,headlessBefore,headlessAfter,manifestPath,P.diff(headlessBefore,headlessAfter));
      const plan=()=>engine.run({op:"plan",changes:[{id:after.id,kind:after.kind,put,remove:[],settings}],attachments:[]});
      return {cli,plan,stored};
    };
    async function compare(request,wanted) {
      const {cli,plan,stored}=request;
      const fromMCP=cli(), fromDesktop=await plan();
      assert.deepEqual(fromMCP.map(entry=>entry.path),[path]);
      assert.deepEqual(fromDesktop.plan.map(entry=>entry.path),[path]);
      const [mcp]=fromMCP, [editor]=fromDesktop.plan;
      if(useCRLF){
        assert.equal(mcp.text,wanted,"MCP uses the physical rewrite fallback");
        const bytes=Uint8Array.from(atob(editor.data),char=>char.charCodeAt(0));
        assert.equal(decoder.decode(bytes),wanted,"desktop fallback preserves CRLF");
      } else {
        assert.equal(splice(stored.bytes,mcp.edits),wanted);
        assert.deepEqual(editor.splice,{base:stored.sha256,edits:mcp.edits});
      }
      const committed=physical(path,wanted);
      await engine.run({op:"accepted",token:fromDesktop.token,hashes:{[path]:committed.sha256}});
      const reopened=M.parse(committed.bytes);
      savedFiles.set(path,reopened);
      assert.equal(reopened.rawRecord("zz-future-owner"),opaque.replaceAll("\n",eol));
      assert.equal(reopened.get(settings.id).value.grid,undefined,"projection defaults remain implicit");
      assert.equal(reopened.get(settings.id).value.headlessDefault,undefined);
      return {record:committed,doc:M.document(reopened)};
    }
    const paper={...desktop,sheet:{...desktop.sheet,size:"A3"}};
    const paperText=original.replace('"size":"A4"','"size":"A3"');
    const updated=await compare(edit(desktop,paper,originalEntry),paperText);
    const moved=structuredClone(updated.doc), item=moved.items.find(item=>item.id===table.id);
    item.widget.state=T.change(item.widget.state,row,column,{content:{kind:"literal",text:"After cell"}});
    moved.memo="After metadata";
    const mixed=await compare(edit(updated.doc,moved,updated.record,[JSON.stringify(item)]),
      paperText.replace('"Before cell"','"After cell"').replace('"Before metadata"','"After metadata"'));
    assert.equal(mixed.doc.sheet.size,"A3");
    const rollback=await compare(edit(mixed.doc,desktop,mixed.record,[table]),original);
    const corrupt={...rollback.doc,sheet:{...rollback.doc.sheet,"x-print":[2]}};
    const malformed=edit(rollback.doc,corrupt,rollback.record);
    assert.throws(malformed.cli,/extension value requires/);
    await assert.rejects(malformed.plan(),/extension value requires/);
    assert.equal(savedFiles.get(path).header.sheet.size,"A4","a refused edit keeps the owned bytes");
  }
  console.log("desktop and MCP share sheet/header/metadata and table writes, with exact LF/CRLF recovery");
}

globalThis.__testDone = (async () => {
  const definition = {id:"definition", name:"Library",
    footprint:{name:"Fixture", pads:[{id:"pad-a", number:"1", x:1.2, y:0, w:1, h:1, shape:"rect"},
      {id:"pad-b", number:"2", x:2.4, y:0, w:1, h:1, shape:"rect"}]}};
  const design = Atrium.project("Deltas", [definition]);
  const counts = [512, 2048, 12, 12];
  design.documents = ["schematic", "pcb", "drawing", "panel"].map((kind, i) => owner(kind, kind[0].toUpperCase() + kind.slice(1), counts[i]));
  const {manifest, files} = M.fromEditor(design);
  const engine = E.create();
  const root = await engine.run({op:"manifest", record:published("Deltas.waffle", manifest)});
  const baseline = new Map();
  for (const ref of root.members) {
    const file = files.find(row => row.path === ref.path).file;
    const physical = published(ref.path, file);
    const projected = await engine.run({op:"owner", record:physical, ref});
    baseline.set(ref.kind, {projected, physical, file});
  }
  for (const [kind, {projected, physical, file}] of baseline) {
    const existingLines = new Set(Array.from(F.lines(file), text => text.trimEnd()));
    const moved = Atrium.clone(projected.owner), change = {id:moved.id, kind, put:[], remove:[]};
    const oldPhysicalText = decoder.decode(physical.bytes);
    let full;
    if (kind === "library") {
      moved.footprint.pads[1].x += 0.127;
      change.owner = moved;
      full = asText(M.createLibrary(moved, {previous:file, allocate:id => id}));
    } else {
      const middle = Math.floor(moved.items.length / 2);
      moved.items[middle].x += 0.127;
      change.put.push(JSON.stringify(moved.items[middle]));
      // Full recomputation must use the persisted IDs, including generated settings
      // and nested drawing/panel records, rather than creating a second owner.
      const settings = [...file.records()].find(row => row.kind === "documentSettings");
      const nestedIds = [...file.records()].filter(row => ["drawingView","panelCell"].includes(row.kind)).map(row => row.id);
      nestedIds.push(settings.id);
      full = asText(M.createDocument(moved, {allocate:() => nestedIds.shift()}));
    }
    const parse = JSON.parse, decoded = [], encoded = [];
    let planned;
    JSON.parse = (text, ...args) => {
      const value = parse(text, ...args);
      if (typeof text === "string" && existingLines.has(text)) decoded.push(value.id);
      if (typeof text === "string" && text.endsWith("\n") && value?.kind && value?.id) encoded.push(value.id);
      return value;
    };
    try {
      planned = await engine.run({op:"plan", changes:[change], attachments:[]});
    } finally {
      JSON.parse = parse;
    }
    assert.equal(planned.plan.length, 1, kind + " writes only its owner");
    const [entry] = planned.plan;
    assert.equal(entry.path, physical.path);
    assert.equal(entry.splice.base, physical.sha256);
    assert.equal(entry.splice.edits.length, 1);
    assert.equal(planned.metrics.rowsEncoded, 1);
    assert.equal(planned.metrics.unrelatedVisits, 0);
    assert.deepEqual(decoded, [], kind + " uses the persisted index without decoding native rows");
    assert.equal(encoded.length, 1, kind + " constructs one canonical native row");
    assert.ok(splice(physical.bytes, entry.splice.edits) === full, kind + " matches full recalculation byte for byte");
    const priorLines = oldPhysicalText.trimEnd().split("\n"), nextLines = full.trimEnd().split("\n");
    assert.equal(priorLines.length, nextLines.length);
    assert.equal(priorLines.filter((line, i) => line !== nextLines[i]).length, 1);
    await engine.run({op:"accepted", token:planned.token, hashes:{[entry.path]:F.sha256(utf8.encode(full))}});
    console.log(kind + ": 1 encoded row, 0 decoded saved rows, " + planned.metrics.transferBytes + " bytes of splice text for " + file.byteLength + " authored bytes");
  }
  await sharedDocumentSettings();
})().catch(error => { console.error(error); process.exitCode = 1; throw error; });
