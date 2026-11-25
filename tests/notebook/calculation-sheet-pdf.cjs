"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {nativeCAD} = require("../support/native-cad.cjs");
for (const name of ["model","parts","spatial","connectivity","pcb-appearance","pcb-pours","stackup","sch-appearance","sch-objects",
  "hierarchy","multichannel","rules","erc","netlist","netlist-text","vectorize","pcb-text-rich","pcb-text","canvas","zip","bom",
  "fab-outputs","path-record","pdf","vendor/dejavu-sans","pdf-fonts","print","vendor/stix-two-math","math-font","math-tex",
  "math","math-pdf","note-fields","calculation-helpers","calculation-intent","calculation-core","calculation-records",
  "calculation-design","calculation-graph","calculation-checks","calculations","calculation-display","widget-catalogue",
  "sheet-widgets","notebook-output"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));

async function run() {
  const project = nativeCAD("calculation"), doc = project.documents[0], item = doc.items.find(i=>i.calculation);
  const clause = {id:"minimum",source:"assert f_c > 10 kHz",bindings:[]};
  clause.bindings = (await AtriumCalculations.bindSource(project,{documentId:doc.id,source:clause.source})).bindings;
  item.calculation.assertions.push(clause); item.h=25;
  const opts = {documents:[doc.id],date:new Date("2026-01-05T00:00:00Z"),revision:"frozen-A",attachments:false,paper:"A4"};
  const snapshot = JSON.stringify(project), jobs=AtriumCalculations.stats().jobs;
  const tokens = page=>page.list.filter(op=>op.k==="t").map(op=>op.u || op.s).join(" ");
  const result = AtriumPrint.build(project,opts), page = result.pages[0];
  const math = page.list.find(op=>op.k==="math");
  assert.ok(math?.layout.commands.some(o=>o.kind==="rule"),"fraction rule in real sheet output");
  assert.equal(math.layout.plain,item.text);
  assert.match(tokens(page),/15\.92 kHz/); assert.match(tokens(page),/Pass/);
  assert.ok(!tokens(page).includes("Loading input"));
  const bytes=await AtriumPrint.preparePDF(project,opts);
  const raw=Buffer.from(bytes).toString("latin1");
  assert.match(raw,/\/Type0\b/);assert.match(raw,/\/CIDFontType2\b/);
  assert.equal(JSON.stringify(project),snapshot);
  assert.equal(AtriumCalculations.stats().jobs,jobs,"printing started a live worker");
  const duplicate=await AtriumPrint.preparePDF(project,opts);assert.deepEqual(duplicate,bytes);
  const dest=process.env.WAFFLE_CALC_ASSETS;
  if(dest) {fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,"timing-calculation.pdf"),bytes);}
  doc.items.find(i=>i.id==="r5").value="20k";
  const next=AtriumPrint.build(project,{...opts,revision:"frozen-B"});
  assert.match(tokens(next.pages[0]),/7\.958 kHz/);assert.match(tokens(next.pages[0]),/Fail/);
  assert.match(tokens(page),/15\.92 kHz/);

  // A selected page can contain a calculation-backed widget whose authored block
  // is on a different sheet. Export resolves the binding without rendering that sheet.
  const status=Atrium.sheet("schematic","Checks at release"), W=AtriumSheetWidgets;
  const table=W.make("table",[20,25]), checklist=W.make("todo",[20,50],{argument:"Check the clock"});
  const [label,value]=table.widget.state.columns.map(c=>W.keyFor(c.id));
  Object.assign(table.widget.state.rows[0],{[label]:{kind:"literal",text:"Cutoff frequency"},
    [value]:{kind:"calculation",documentId:doc.id,blockId:item.id}});
  status.items.push(table,checklist,{id:"proof-math",kind:"textframe",x:20,y:75,w:50,h:14,math:true,text:"\\frac{a}{b}"});
  project.documents.push(status);
  const saved=Atrium.clone(project);
  saved.documents[0].items.find(i=>i.id==="r5").value="10k";
  saved.documents[1].items[1].widget.state.rows[0].done=true;
  const onlyStatus={...opts,documents:[status.id],compress:false};
  const currentPage=AtriumPrint.build(project,onlyStatus).pages[0];
  assert.match(tokens(currentPage),/7\.958 kHz/);
  assert.match(tokens(currentPage),/☐ Check the clock/);
  assert.ok(currentPage.list.some(op=>op.k==="math"),"real standalone equation appears on the selected page");

  let acquired=0, released=0, outputRows=[];
  const folder=AtriumFormat2Model.fromEditor(saved,{manifestPath:"Notebook.waffle"});
  const archive=AtriumZip.create(folder.files.map(row=>({name:row.path,data:AtriumFormat2.serialize(row.file)})),{date:opts.date});
  const exportBytes=await AtriumPrint.preparePDF(project,{...onlyStatus,includeProject:true},{
    acquireSavedExportSnapshot:async()=>{acquired++;return {project:saved,snapshotId:"revision-A",
      projectArchive:async()=>({name:"Notebook.zip",snapshotId:"revision-A",bytes:archive}),release:()=>released++};},
    widgetView:(source,pageDoc,widget,context)=>{
      assert.strictEqual(source,saved);
      assert.equal(pageDoc.id,status.id);
      assert.equal(context.revision,"revision-A");
      const view=W.view(source,pageDoc,widget,context);
      outputRows.push(...view.rows);
      return view;
    }
  });
  assert.equal(acquired,1);assert.equal(released,1);
  assert.equal(outputRows[1].cells[1].text,"15.92 kHz");
  assert.equal(outputRows[2].checked,true);
  assert.match(Buffer.from(exportBytes).toString("latin1"),/\/Count 1\b/);
  assert.equal(AtriumCalculations.stats().jobs,jobs,"snapshot widgets started a live worker");
  console.log("Public Print and prepared PDF preserve the frozen formula, selectable glyphs, current value, uncertainty and changing assertion state.");
}
globalThis.__testDone=run();
globalThis.__testDone.catch(e=>{console.error(e);process.exitCode=1;});
