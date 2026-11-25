"use strict";
const assert = require("node:assert/strict");
const {nativeCAD,nativeRecords,nativeRoundTrip} = require("../support/native-cad.cjs");
for (const file of ["sch-objects","sch-appearance","hierarchy","multichannel","netlist","messages","erc","output-jobs"])
  require(require("../support/app-source-paths.cjs").appFile(file+".js"));
const A=Atrium, S=AtriumSchObjects, F=AtriumFormat2, M=AtriumFormat2Model;
const known=()=>nativeCAD("infinite-canvas");
const findGenerated=p=>p.documents.flatMap(d=>d.items).find(i=>i.autoName);
const compiled=p=>AtriumNetlist.extract(p,{source:"schematic"}).nets.map(n=>({
  name:n.name,nodes:n.nodes.map(pin=>pin.ref+"."+pin.pin).sort()
})).sort((a,b)=>a.nodes[0].localeCompare(b.nodes[0]));
function nextVersion(file, mutate) {
  const rows=Array.from(file.records(),r=>A.clone(r));
  mutate(rows);
  const text=[F.canonical({...file.header,formatVersion:"2.1"}),...rows.sort((a,b)=>F.compare(a.id,b.id)).map(row=>F.canonical(row))].join("\n")+"\n";
  return M.parse(text);
}

{
  const p=A.validate(nativeCAD("imported-captions"));
  const flags=AtriumERC.run(p).messages.filter(m=>m.check==="floatingPower").map(m=>m.objectId).sort();
  assert.deepEqual(flags,["item-2"],"the isolated VOUT is flagged, and the cross-sheet SDA connector is valid");
}
for (const explicit of [false,true]) {
  const p=known();
  if(explicit) {
    p.documents[1].sheet.infinite=false;
    Object.assign(p.outputJobs[0].outputs[0].options,{infiniteLayout:"fit",infiniteScale:1});
  }
  const initial=known(),[first,second]=p.documents;
  assert.deepEqual(nativeRoundTrip(p),initial,"explicit fixed paper, fit and 1:1 scale share the canonical defaults");
  const rectangle=first.items.find(i=>i.id==="frame-a");
  assert.deepEqual(S.box(rectangle),[-75,-40,15,25]);
  assert.deepEqual(S.netSources(rectangle),[]);
  assert.deepEqual(S.hotspots(rectangle),[]);
  first.sheet.params.Title="Revised title";
  second.items.find(i=>i.id==="ordinary-note").x+=1.27;
  AtriumOutputJobs.save(p,{...p.outputJobs[0],description:"Review copy"});
  initial.documents[0].sheet.params.Title="Revised title";
  initial.documents[1].items.find(i=>i.id==="ordinary-note").x+=1.27;
  initial.outputJobs[0].description="Review copy";
  const reopened=nativeRoundTrip(p);
  assert.deepEqual(reopened,initial,"saving the paper title, a distant move and the output job changes only the edits");
  assert.deepEqual(nativeRoundTrip(reopened),reopened);
}

{
  const {manifest,read}=nativeRecords("infinite-canvas"),member=M.manifest(manifest).members[0];
  const extra={id:"opaque-item",kind:"futureFrameGuide",order:"s",projection:{fold:"y"}};
  const input=nextVersion(M.parse(read(member.path)),rows=>rows.push(extra)), doc=M.document(input,{name:member.name});
  assert.ok(!doc.items.some(item=>item.id===extra.id));
  const moved=doc.items.find(i=>i.id==="frame-a");
  moved.x+=1;
  const output=M.parse(F.serialize(F.edit(input,M.documentEdits(input,doc,{put:[moved]}))));
  assert.deepEqual(output.get(extra.id),extra);
  assert.equal(output.get(moved.id).at[0],-74000000);
  const future=nextVersion(manifest,rows=>{
    const options=rows.find(r=>r.kind==="outputJob").value.outputs[0].options;
    Object.assign(options,{infiniteLayout:"foldout",fold:{axis:"y"}});
  });
  const p=M.manifest(future).project, job=p.outputJobs[0],source=Array.from(future.records()).find(r=>r.kind==="outputJob");
  const edited=AtriumOutputJobs.save(p,{...job,description:"Keep future options"});
  const updated=F.edit(future,{put:[{...source,value:AtriumFormat2Values.encode(edited)}]});
  const saved=M.manifest(M.parse(F.serialize(updated))).project.outputJobs[0];
  assert.deepEqual(saved.outputs[0].options,{infiniteLayout:"foldout",fold:{axis:"y"}});
  assert.equal(saved.description,"Keep future options");
}

for(const style of ["hyphen","underscore","future"]) {
  const p=nativeCAD("frame-channel-"+(style==="future"?"hyphen":style)), generated=findGenerated(p);
  if(style==="future") Object.assign(generated.autoName,{style:"future-channel",qualifier:{scope:"bank",format:2}});
  const signature=compiled(p);
  assert.deepEqual(signature.map(n=>n.nodes),[["R1_CH1.2","R2_CH1.1"],["R1_CH2.2","R2_CH2.1"]]);
  const names=[1,2].map(ch=>style==="future"?generated.text+"_CH"+ch:style==="hyphen"?"Net-R1_CH"+ch+"-2":"NetR1_CH"+ch+"_2");
  assert.deepEqual(signature.map(n=>n.name),names);
  if(style==="future") {
    const {manifest,read}=nativeRecords("frame-channel-hyphen");
    const member=M.manifest(manifest).members.find(m=>m.id===p.documents.find(d=>d.items.includes(generated)).id);
    const next=nextVersion(M.parse(read(member.path)),rows=>{rows.find(r=>r.id===generated.id).autoName=generated.autoName;});
    const changed=F.edit(next,{header:{...next.header,review:"Revised channel"}});
    assert.deepEqual(M.parse(F.serialize(changed)).get(generated.id).autoName,generated.autoName);
  } else {
    p.name+=" edit";
    assert.deepEqual(compiled(nativeRoundTrip(p)),signature);
  }
}
{
  const invalid = edit => {
    const p = known();
    edit(p, p.documents[0], p.documents[0].items[0], p.outputJobs[0].outputs[2].options);
    assert.throws(() => A.validate(p), /Invalid Waffle editor model/);
  };
  for (const io of [null, 4, "clocked"]) invalid((p, d) => { d.items[1].io = io; });
  for (const infinite of [null, 1, "true"]) invalid((p, d) => { d.sheet.infinite = infinite; });
  for (const text of ["   ", "x".repeat(301)]) invalid((p, d, f) => { f.text = text; });
  for (const role of [null, "reservation"]) invalid((p, d, f) => { f.role = role; });
  invalid((p, d, f) => { f.w = 0; });
  invalid((p, d, f) => { f.h = -1; });
  invalid((p, d, f) => { p.documents.push({...A.sheet("pcb", "Layout"), items: [{...f, id:"pcb-frame"}]}); });
  for (const scale of [null, 0, -1, "1", Infinity]) invalid((p, d, f, o) => { o.infiniteScale = scale; });
  for (const layout of [null, 1, "foldout"]) invalid((p, d, f, o) => { o.infiniteLayout = layout; });

  const generated = overrides => {
    const p = nativeCAD("frame-channel-hyphen"), item = findGenerated(p);
    overrides(item,p);
    return p;
  };
  for (const bad of [null, [], "pin", {}, {part:"",pin:"2",style:"hyphen"}, {part:"ok",pin:2,style:"hyphen"},
                     {part:"ok",pin:" ",style:"underscore"}, {part:"ok",pin:"1",style:"alien"}])
    assert.throws(() => A.validate(generated(i => { i.autoName=bad; })), /Invalid Waffle editor model/);
  assert.throws(() => A.validate(generated((i,p) => { p.documents[0].items[0].autoName=i.autoName; })), /Invalid Waffle editor model/);
  const detached = generated(i => { i.autoName.part="deleted-part"; });
  assert.deepEqual(compiled(A.validate(detached)).map(n => n.name), ["Net-R1_CH1-2_CH1","Net-R1_CH1-2_CH2"]);

  const p = known(), d = p.documents[1], frame = p.documents[0].items[0];
  delete p.documents[0].sheet.titleBlock;
  assert.equal(AtriumSchAppearance.sheetOf(p.documents[0]).titleBlock, "none");
  assert.equal(AtriumSchAppearance.sheetOf(d).titleBlock, "standard");
  assert.ok(S.isFrame(frame));
  assert.ok(!S.isFrame(d.items.find(i => i.id === "ordinary-note")));
  const absent = S.make("offsheet", [0, 0]);
  assert.ok(!Object.hasOwn(absent, "io"), "creating an unspecified connector uses its implicit default");
}
console.log("Native schematic pages, output layouts and repeated-channel connectivity passed.");
