"use strict";
const assert = require("node:assert/strict");
for (const name of ["source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model", "folder-project-engine"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, E = AtriumFolderProjectEngine;
const board = {id:"board",kind:"pcb",name:"Signal board",path:"Signal board.wpcb"};
const docIds = ["sheet-a", "sheet-b", "sheet-c", "sheet-d"];
const library = {kind:"library",id:"device",path:"libraries/device.wlib"};
const makeManifest = formatVersion => F.create({kind:"project",formatVersion,id:"project",name:"Links"}, [
  {...board,kind:"document",docKind:"pcb"}, library,
  ...docIds.map(id=>({kind:"document",docKind:"schematic",id,name:id,path:id+".wsch"})),
]);
const manifest = makeManifest("2.0");
const record = (path, bytes) => ({path,bytes,length:bytes.length});
const asset = {sha256:"a".repeat(64),byteLength:20,mediaType:"font/otf"};
const make = (rows,formatVersion="2.0") => F.create({kind:"pcb",id:board.id,formatVersion},rows);
const placement = {kind:"part",id:"placement",def:library.id,at:[0,0]};
const item = {kind:"label",id:"label",at:[0,0],text:'héllo "docId": in a label'};

globalThis.__testDone = (async () => {
  const engine=E.create();
  await engine.run({op:"manifest",record:record("project.waffle",F.serialize(manifest))});
  const read = (file,install=true) => engine.run({op:"owner",record:record(board.path,F.serialize(file)),ref:board,install});
  const basic = make([placement,item]);
  assert.deepEqual((await read(basic)).deps,{definitions:[library.id],documents:[],assets:[]});
  const linkKeys = ["board","sheet","docId","documentId"];
  const links = docIds.map((id,index)=>({[linkKeys[index]]:id}));
  const nested = {...item,metadata:{notes:[links,{asset},{}],ownerOnly:board.id}};
  const deps = (await read(make([placement,nested]))).deps;
  assert.deepEqual(deps,{definitions:[library.id],documents:docIds,assets:[asset]});

  const future = make([placement,item,{kind:"future-only",id:"opaque",documentId:docIds[0],asset}],"2.1");
  await assert.rejects(read(future), error => error.code === "invalid-member");
  await engine.run({op:"manifest",record:record("project.waffle",F.serialize(makeManifest("2.1")))});
  const futureView = await read(future);
  assert.deepEqual(futureView.deps.definitions,[library.id]);
  assert.deepEqual(futureView.deps.documents,[]);
  assert.deepEqual(futureView.deps.assets,[]);
  assert.equal(futureView.owner.items.length,2);
  await engine.run({op:"manifest",record:record("project.waffle",F.serialize(manifest))});

  // Neither on-disk version contains an owner link. The local unapplied edit introduces one.
  await read(basic);await read(make([placement,{...item,text:"external"}]),false);
  const merged = await engine.run({op:"resolveExternal",id:board.id,choice:"merge",change:{
    id:board.id,kind:board.kind,remove:[],put:[{kind:"part",id:placement.id,x:0,y:0,def:library.id,local:{documentId:docIds[2],asset}}],
  }});
  assert.deepEqual(merged.deps,{definitions:[library.id],documents:[docIds[2]],assets:[asset]});

  const text = F.decodeText(F.serialize(basic)), encode = string => new TextEncoder().encode(string);
  const inputs = [new Uint8Array([255,10]), encode("\uFEFF"+text), encode(text.replace('"kind"','"\\u006bind"'))];
  for(const bytes of inputs){
    let original;
    try { M.parse(bytes,{kind:board.kind,id:board.id}); } catch(error) { original=error; }
    assert.ok(original);
    await assert.rejects(engine.run({op:"owner",record:record(board.path,bytes),ref:board}),error=>
      error.code===original.code&&error.message===original.message);
  }
  // An injected projection can derive a link independently of the disk keys.
  const custom = E.create(F,{...M,documentWithDependencies(file,options) {
    const view=M.documentWithDependencies(file,options);
    view.owner.selection={documentId:docIds[1]};
    return view;
  }});
  await custom.run({op:"manifest",record:record("project.waffle",F.serialize(manifest))});
  assert.deepEqual((await custom.run({op:"owner",record:record(board.path,F.serialize(basic)),ref:board})).deps.documents,[docIds[1]]);
  const crlf = encode(text.replace(/\n/g,"\r\n"));
  assert.deepEqual((await engine.run({op:"owner",record:record(board.path,crlf),ref:board})).deps,
    {definitions:[library.id],documents:[],assets:[]});
  console.log("PASS verified document links, typed library dependencies, external merges and unchanged UTF-8 checks");
})().catch(error=>{console.error(error);process.exitCode=1;});
