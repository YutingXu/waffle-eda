"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
for (const name of ["model", "source-file", "format-2-codec", "format-2-upgrades", "format-2-units", "format-2-values",
  "format-2-model", "format-2-closure", "import-sidecars", "folder-project-engine", "proposal", "atrium-api",
  "extensions", "sexpr", "zip", "format-2-models", "folder-project"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
require("../../mcp/folder-project.js");
const F = AtriumFormat2, M = AtriumFormat2Model, C = AtriumFormat2Closure, E = AtriumFolderProjectEngine, H = AtriumMCPFolder;
const base = path.join(__dirname, "../fixtures/format-2");
const load = (dir, file) => fs.readFileSync(path.join(base, dir, file), "utf8");
const utf8 = s => new TextEncoder().encode(s), decode = b => new TextDecoder().decode(b);
const payload = s => E.dataOf(utf8(s));
const record = (path, text) => ({path, bytes:utf8(text), sha256:F.sha256(utf8(text))});
const rows = text => text.trimEnd().split("\n").map(line => JSON.parse(line));
const matches = code => error => error?.code === code;

async function corpus({directory, manifest, sha256}) {
  const contents = member => load(directory, member);
  const bytes = member => new Uint8Array(fs.readFileSync(path.join(base, directory, member)));
  const rootText = contents(manifest), root = M.parse(utf8(rootText));
  const editor = E.create(), desktop = await editor.run({op:"manifest", record:record(manifest, rootText)});
  const headless = H.run({action:"start"}, payload(rootText));
  assert.equal(headless.format, root.header.formatVersion);
  assert.deepEqual(headless.documents.map(d => d.id), desktop.members.filter(d => d.kind === "opaque" || F.documentSuffix[d.kind]).map(d => d.id));
  const owners = new Map();
  for (const ref of desktop.members) {
    // The closure verifies the binding and its retained payloads outside owner projection.
    if (ref.kind === "import-index") continue;
    const raw = contents(ref.path);
    const file = M.parse(utf8(raw), ref.kind === "opaque" ? {opaque:true} : {});
    assert.equal(decode(F.serializePhysical(file)), raw);
    if (ref.kind === "opaque") continue;
    const result = await editor.run({op:"owner", ref, record:record(ref.path, raw)});
    owners.set(ref.id, result.owner);
    H.run({action:"owner", path:ref.path}, payload(raw));
  }
  const [, json] = H.run({action:"project"}), project = JSON.parse(json);
  for (const owner of [...project.documents, ...project.library]) {
    // Compare what the headless JSON transport can represent. The earlier byte
    // round-trip checks authored spellings such as -0 independently.
    assert.deepEqual(owner, JSON.parse(JSON.stringify(owners.get(owner.id))));
  }
  assert.deepEqual((await editor.run({op:"plan",changes:[],attachments:[]})).plan, []);
  assert.equal((await C.verify(root, bytes)).sha256, sha256);
  let step = H.run({action:"start", full:true}, payload(rootText));
  while (step.request) {
    const ref = step.request, raw = bytes(ref.path);
    step = step.verify_model ?
      H.run({action:"feed",path:ref.path,model:await AtriumFormat2Models.verify(raw, ref)}) :
      H.run({action:"feed",path:ref.path}, E.dataOf(raw));
  }
  assert.equal(step.source_sha256, sha256);

  if (directory === "workshop") {
    assert.deepEqual(project.documents.map(d => d.kind), ["schematic","schematic","pcb","drawing","panel"]);
    assert.equal(owners.get("top").items.find(i => i.id === "to-sensor").sheet, "sub");
    assert.deepEqual(owners.get("board").items.map(i => i.id), ["probe","run"]);
    assert.deepEqual(owners.get("board").items[1].points, [[2.54,4],[5.08,4],[6,5]]);
    assert.deepEqual(owners.get("board").stackup.layers.map(l => l.type), ["Overlay","Solder Mask","Signal","Dielectric","Signal","Solder Mask","Overlay"]);
    assert.equal(owners.get("draw").drawing.views[0].type, "board");
    assert.equal(owners.get("panel").panel.cells["0,1"].rotation, 180);
    assert.equal(owners.get("sense-pad").footprint.pads[0].number, "1");
    assert.equal(project.layoutBlocks[0].items[0].id, "stub-track");
  }
  if (directory === "extension") {
    const [{manifest, files}] = project.extensions;
    const commands = manifest.contributes.commands;
    assert.deepEqual(commands[0].calibration, {modes:[{range:[2,7],unit:"μV"}]});
    assert.equal(files["main.js"], 'exports.activate = api => api.commands.register("example.hello.say", () => "μV");\r\n');
    assert.equal(files["calibration.json"], '{"units":["μV","mV"],"range":[2,7]}\n');
    AtriumExtensions.validateManifest(manifest, files);
    assert.equal(AtriumExtensions._digest(manifest,files), "sha256:545da37e2666c09f6c9ec9e9017d56a183c57ba41b647f7592b345c38480f203");
    const label = owners.get("es").items[0];
    const {plan} = await editor.run({op:"plan", changes:[{id:"es",kind:"schematic",put:[{...label,text:"CAL"}],remove:[]}],attachments:[]});
    assert.deepEqual(plan.map(t => t.path), ["Input.wsch"]);
    return;
  }
  if (directory === "butter-query") {
    const [group] = project.savedQueries;
    assert.equal(root.header.formatVersion,"2.1");
    assert.equal(root.header.requires,undefined);
    assert.deepEqual(project.atriumCompat,{newer:"2.1"});
    assert.equal(group.query.languageVersion,1);
    assert.equal(group.scope.documentId,project.documents[0].id);
    assert.equal(group.id,root.get(group.id).value.id);
    assert.equal(M.parse(bytes("Power.wpcb")).header.formatVersion,"2.0");
    const legacyKinds = new Set([...root.records()].filter(row => row.kind !== "savedQuery").map(row => row.kind));
    const legacy = F.parse(utf8(rootText),{knownKinds:legacyKinds});
    assert.equal(legacy.isOpaque(group.id),true);
    assert.equal(legacy.rawRecord(group.id),root.rawRecord(group.id));
    return;
  }
  if (directory === "butter-project-metadata") {
    assert.equal(root.header.formatVersion,"2.1");
    assert.equal(root.header.requires,undefined);
    assert.deepEqual(project.atriumCompat,{newer:"2.1"});
    const [[query],[view],[slide],[datasheet],[annotation]] = [
      project.savedQueries,project.savedViews,project.slides,project.datasheets,project.datasheetAnnotations,
    ];
    const [anchor] = Object.values(project.linkAnchors);
    const part = project.documents[0].items.find(row=>row.kind==="part");
    const pin = project.library[0].symbol.pins[0];
    assert.equal(query.query.bindings[0].target.itemId,part.id);
    assert.deepEqual(view.camera,{center:[1,2.5],scale:1.5,referenceScale:2,flipped:false,rotationRadians:0});
    assert.equal(view.filter.scope.savedQueryId,query.id);
    assert.equal(slide.source.frameId,"input-frame");
    assert.equal(anchor.terminalId,pin.nativeId);
    assert.equal(annotation.datasheetId,datasheet.id);
    for (const {path} of desktop.members) assert.equal(M.parse(bytes(path)).header.formatVersion,"2.0");
    const old = F.parse(utf8(rootText),{knownKinds:new Set(["document","library"])});
    const newName = "Preserved details";
    const oldEdit = F.edit(old,{header:{...old.header,name:newName}});
    const modernEdit = F.applyDelta(root,M.manifestEdits(root,{...project,name:newName})).file;
    for (const item of root.records()) {
      if (F.isOptionalManifestKind(item.kind)) assert.equal(old.isOpaque(item.id),true);
      assert.equal(oldEdit.rawRecord(item.id),root.rawRecord(item.id));
      assert.equal(modernEdit.rawRecord(item.id),root.rawRecord(item.id));
    }
    assert.match(root.rawRecord(Object.keys(project.links)[0]),/Re\\u0076iew/);
    return;
  }
  if (directory !== "future") {
    assert.equal(Object.hasOwn(project,"atriumCompat"), false);
    return;
  }
  assert.deepEqual(project.atriumCompat, {newer:"2.2"});
  assert.equal(project.formatVersion, Atrium.project("Live stamp").formatVersion);
  const projected = M.createManifest(project, {previous:root});
  assert.equal(projected.header.formatVersion, F.FORMAT);
  assert.equal(Array.from(projected.records()).some(row => row.key === "atriumCompat"), false);

  const expected = (amount,unit) => ({limits:[0,null,{exact:[amount,unit]}],mode:"μ"});
  assert.deepEqual(project.rules.list[0].scope.future, expected(11,"nm"));
  assert.deepEqual(project.signals.signals[0].legs[0].future, expected(13,"ohm"));
  assert.deepEqual(project.projectExtensions["org.example.calibration"].future, expected(17,"pF"));
  assert.deepEqual(owners.get("fd").drawing.views[0].options.future, expected(29,"nm"));
  assert.deepEqual(owners.get("fl").footprint.future, expected(31,"μm"));
  const ref = desktop.members.find(r => r.id === "fs"), raw = contents(ref.path);
  const label = owners.get("fs").items.find(i => i.id === "fa");
  const {plan} = await editor.run({op:"plan", changes:[{id:ref.id,kind:ref.kind,put:[{...label,text:"SENSE2"}],remove:[]}],attachments:[]});
  assert.deepEqual(plan.map(t => t.path), [ref.path]);
  const [splice] = plan[0].splice.edits, original = utf8(raw);
  assert.equal(plan[0].splice.edits.length, 1);
  const rewritten = decode(original.slice(0,splice.offset)) + splice.insert + decode(original.slice(splice.offset+splice.remove));
  assert.equal(rewritten, raw.replace('"text":"SENSE"', '"text":"SENSE2"'));
  const updated = M.parse(utf8(rewritten));
  assert.deepEqual(updated.get("fa").future, expected(19,"nm"));
  assert.deepEqual(updated.get("fz").future, expected(23,"nA"));
  assert.throws(() => F.applyDelta(updated,{remove:["fz"]}), matches("read-only-format"));
  assert.equal(H.saved().members.find(m => m.path === "Wave.wwave").sha256, F.sha256(utf8(contents("Wave.wwave"))));
}

async function policy(test) {
  const changed = (file, header, unknown) => {
    const [head, ...body] = rows(load("golden",file));
    return [F.canonical({...head,...header}), ...body.map(row => F.canonical(row)),
      ...(unknown ? [F.canonical({kind:unknown === "order" ? "netlabel" : "futureTerminal",id:"z", ...(unknown === "order" && {order:"?",text:"SENSE"})})] : [])].join("\n") + "\n";
  };
  const name = "Sensor Board.waffle", rootText = changed(name,test.root), rootRecord = record(name,rootText);
  const editor = E.create();
  const deskRoot = () => editor.run({op:"manifest",record:rootRecord});
  const headRoot = () => H.run({action:"start"},payload(rootText));
  if (test.rootError && test.rootError !== "unsupported-feature" || test.continuation) {
    await assert.rejects(deskRoot, matches(test.rootError), test.name);
    assert.throws(headRoot, matches(test.rootError), test.name);
    return;
  }
  const desktop = await deskRoot(); headRoot();
  assert.equal(desktop.readOnly, !!(test.rootReadOnly || test.rootError), test.name);
  assert.equal(H.saved().root.readOnly, desktop.readOnly, test.name);
  if (test.root.requires) {
    assert.equal(desktop.formatDiagnostic, F.unsupportedMessage(H.saved().root));
    for (const required of test.root.requires) assert.match(desktop.formatDiagnostic, new RegExp(required));
    assert.ok(desktop.formatDiagnostic.includes(test.minimum ?? test.root.formatVersion));
  }
  const ref = desktop.members[0], raw = changed(ref.path,test.owner,test.unknownRecord), rec = record(ref.path,raw);
  const deskOwner = () => editor.run({op:"owner",record:rec,ref});
  const headOwner = () => H.run({action:"owner",path:ref.path},payload(raw));
  const closure = () => C.verify(M.parse(rootRecord.bytes), () => rec.bytes);
  // The pinned version matrix describes the prefreeze policy. Unknown required
  // tokens are now readable with a diagnostic, and unknown optional rows stay opaque.
  if (test.memberError && test.memberError !== "unsupported-feature" && test.unknownRecord !== true) {
    await assert.rejects(deskOwner, matches(test.memberError), test.name);
    assert.throws(headOwner, matches(test.memberError), test.name);
    await assert.rejects(closure, matches(test.memberError), test.name);
    await assert.rejects(editor.run({op:"restoreMember",id:ref.id,bytes:rec.bytes}), matches(test.memberError), test.name);
    assert.equal(await editor.run({op:"savedOwner",id:ref.id}), null);
    assert.equal(H.saved().files.size, 0);
    return;
  }
  const owner = await deskOwner(); headOwner(); await closure();
  assert.equal(owner.readOnly, !!(test.ownerReadOnly || test.memberError === "unsupported-feature"), test.name);
  const saved = H.saved().files.get(ref.path);
  assert.equal(saved.readOnly, owner.readOnly, test.name);
  if (test.owner?.requires) {
    assert.equal(owner.formatDiagnostic, F.unsupportedMessage(saved));
    for (const required of test.owner.requires) assert.match(owner.formatDiagnostic, new RegExp(required));
  }
  if (test.unknownRecord === true) {
    assert.equal(saved.isOpaque("z"), true, test.name);
    assert.equal(decode(F.serialize(saved)), raw, test.name);
    assert.throws(() => F.edit(saved, {remove:["z"]}), matches("read-only-format"), test.name);
  }
  if (desktop.readOnly || owner.readOnly) {
    const change = {id:ref.id,kind:ref.kind,deleted:true,put:[],remove:[]};
    await assert.rejects(editor.run({op:"plan",changes:[change],attachments:[]}),matches("read-only-format"),test.name);
  }
}

async function successiveUpgrade() {
  const upgrade = globalThis.AtriumFormat2Upgrades.create("2.2", [
    ["2.0", value => ({...value, records:value.records.map(row => ({...row, text:row.text + " one"}))})],
    ["2.1", value => {
      assert.equal(value.header.formatVersion, "2.1");
      value.records[0].text += " two";
      return value;
    }],
  ]);
  const source = F.create({kind:"schematic",id:"01991c5b-a000-7000-8000-000000000101",formatVersion:"2.0"},
    [{kind:"netlabel",id:"01991c5b-a000-7000-8000-000000000102",at:[0,0],text:"Rail"}]);
  const next = upgrade.project(source.header,source.records());
  assert.equal(next.header.formatVersion,"2.2");
  assert.equal(next.records[0].text,"Rail one two");
  assert.equal(source.get(next.records[0].id).text,"Rail");
  assert.equal(upgrade.project(next.header,next.records),null);
  const missing = globalThis.AtriumFormat2Upgrades.create("2.2", [["2.1", value => value]]);
  assert.throws(() => missing.project(source.header,source.records()), matches("unsupported-version"));

  const activeId = source.header.id, otherId = "01991c5b-a000-7000-8000-000000000103";
  const manifest = "Upgrade.waffle";
  const ownerRows = [
    {kind:"document",id:activeId,docKind:"schematic",name:"Active",path:"Active.wsch"},
    {kind:"document",id:otherId,docKind:"schematic",name:"Other",path:"Other.wsch"},
  ];
  for (const rootVersion of ["2.0","2.2"]) {
    const root = F.create({kind:"project",id:"upgrade",formatVersion:rootVersion,name:"Upgrade",entryDocument:activeId}, ownerRows);
    const another = F.create({...source.header,id:otherId}, [{...source.get(next.records[0].id),id:"01991c5b-a000-7000-8000-000000000104"}]);
    const disk = new Map([[manifest,F.serialize(root)],["Active.wsch",F.serialize(source)],["Other.wsch",F.serialize(another)]]);
    const original = new Map(disk), commits = [];
    const editor = E.create(F,M,upgrade);
    const host = {
      async folderReadLease() { return {lease:"open"}; },
      async folderRelease() {},
      async folderRead({paths}) {
        return {files:paths.map(path => ({path,bytes:disk.get(path),length:disk.get(path).length,sha256:F.sha256(disk.get(path))}))};
      },
      async folderCommit({plan}) {
        commits.push(plan.map(row => row.path));
        const hashes = {};
        for (const row of plan) {
          assert.equal(row.expected,F.sha256(disk.get(row.path)));
          assert.ok(row.data,"a version rewrite uses the original physical digest and complete new owner bytes");
          const data = E.bytesOf(row);
          disk.set(row.path,data); hashes[row.path] = F.sha256(data);
        }
        return {saved:true,hashes};
      },
    };
    let planObserved;
    const session = await globalThis.AtriumFolderProject.open({grant:"upgrade",manifest},{host,
      workerFactory:() => ({run(op,message,read,readBatch) {
        if (op === "plan") planObserved?.();
        return editor.run({op,...message,read,readBatch});
      },close(){}})});
    try {
      assert.equal(session.project.documents[0].items[0].text,"Rail one two");
      assert.deepEqual(disk,original,"Open projects upgrades without writes");
      assert.equal((await session.save({all:true})).clean,true);
      assert.equal((await session.save({documentId:otherId})).clean,true);
      assert.deepEqual(commits,[]);
      if (rootVersion === "2.0") {
        await assert.rejects(session.save(),matches("invalid-member"));
        assert.deepEqual(disk,original,"this manifest does not cover the upgrade");
        continue;
      }
      const priorLock = globalThis.AtriumCollabLock;
      let finishOwnership, resolvePlan;
      const ownership = new Promise((_,reject) => { finishOwnership = reject; });
      const planned = new Promise(resolve => { resolvePlan = resolve; });
      planObserved = resolvePlan;
      globalThis.AtriumCollabLock = {active:() => true,beforeSave:() => ownership};
      const saving = session.save();
      const denied = assert.rejects(saving,/Someone else holds the editing lock/);
      let stopWaiting;
      try {
        const winner = await Promise.race([planned.then(() => "plan"),new Promise(resolve => { stopWaiting = setTimeout(resolve,1000,"timeout"); })]);
        assert.equal(winner,"plan","prepare while ownership is being checked");
        assert.deepEqual(commits,[],"never write while ownership is unresolved");
      } finally {
        clearTimeout(stopWaiting);
        finishOwnership(Error("Someone else holds the editing lock"));
        await denied;
        globalThis.AtriumCollabLock = priorLock;
        planObserved = null;
      }
      assert.deepEqual(disk,original,"a refused plan cannot change the saved folder");
      assert.equal((await session.save()).saved,true);
      assert.equal((await session.save()).clean,true);
      assert.deepEqual(commits,[["Active.wsch"]]);
      const published = M.parse(disk.get("Active.wsch"));
      assert.equal(published.header.formatVersion,"2.2");
      assert.equal(published.get(next.records[0].id).text,"Rail one two");
      for (const path of [manifest,"Other.wsch"]) assert.deepEqual(disk.get(path),original.get(path));
    } finally { await session.close(); }
  }
}

async function main() {
  const firstNative = M.parse(utf8(load("golden","Sensor Board.waffle")));
  assert.equal(firstNative.header.formatVersion,F.FORMAT);
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname,"../../integrations/vscode/schema/waffle-folder-record.schema.json"),"utf8"));
  assert.equal(AtriumImportSidecars.FORMAT, F.FORMAT);
  assert.deepEqual(schema.$defs.header.properties.kind.enum, [...F.headerKinds, AtriumImportSidecars.HEADER_KIND].sort());
  const fixtures = JSON.parse(load("","projects.json"));
  for (const fixture of fixtures) await corpus(fixture);
  // A project setting cannot supply the read mode or relax same-version validation.
  const fake = F.create({kind:"project",id:"p",name:"Test",formatVersion:F.FORMAT},[
    {kind:"projectSetting",id:"forged",key:"atriumCompat",value:{newer:"99.0",readOnly:"99.0"}}]);
  const projected = M.manifest(fake).project;
  assert.equal(Object.hasOwn(projected,"atriumCompat"),false);
  assert.deepEqual(AtriumProposal.diff(projected, {...projected,atriumCompat:{newer:"99.0"}}), []);
  const forged = {format:"atrium-ai",version:2,project:projected.name,ops:[
    {op:"set",target:"project",path:["atriumCompat"],after:{newer:"99.0"}}]};
  assert.throws(() => AtriumProposal.apply(projected,forged), /protected field/);
  assert.equal(Object.hasOwn(projected,"atriumCompat"),false);
  const cases = JSON.parse(load("","version-cases.json"));
  cases.push({name:"declared minimum reader", minimum:"2.4", rootReadOnly:true,
    root:{formatVersion:"2.0",requires:["future-constraint"],readerRequires:{"future-constraint":"2.4"}}, owner:{}});
  cases.push({name:"reserved continuation", continuation:true, rootError:"unsupported-feature",
    root:{formatVersion:"2.0",requires:["continuation-parts-v1"]}});
  for (const test of cases) await policy(test);
  await successiveUpgrade();
  console.log("format-2-versioning: " + fixtures.length + " immutable folder digests, bundled extension identity, 4 document kinds and " + cases.length + " version/feature cases passed");
}
globalThis.__testDone = main().catch(error => {console.error(error); process.exitCode = 1;});
