"use strict";

const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
require("../../mcp/headless.js");
for (const name of ["model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model",
  "design-query-record","design-query-parser","design-query-geometry","design-query-context","design-query-index","design-query",
  "preferred-values","note-fields","calculation-intent","calculation-core","calculation-helpers","calculation-records",
  "query-fields","calculation-design","calculation-graph","notebook","widget-fallback","widget-catalogue","sheet-widgets",
  "table-data","table-format","table-exchange","table-formulas","table-query","table-visual","proposal","butter","butter-tables"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const descriptor = require("../../app/automation/descriptors/tables.json");
const commands = new Map(descriptor.commands.map(spec => [spec.id,spec]));
const T = AtriumTableData, F = AtriumFormat2, M = AtriumFormat2Model;
const project = Atrium.project("Table command fixtures"), doc = Atrium.sheet("schematic","Table sheet");
const definition = {id:Atrium.id(),name:"Resistor",symbol:{shapes:[],pins:[{x:0,y:0,number:"1",name:"Pin",electrical:0}]}};
const old = AtriumSheetWidgets.make("table",[0,0]), part = {kind:"part",id:Atrium.id(),def:definition.id,ref:"R5",value:"2",x:0,y:10};
project.documents = [doc];
project.library = [definition];
doc.items = [old,part];
const target = {documentId:doc.id,itemId:old.id};

if (["--fixture","--storage-fixture"].includes(process.argv[2])) {
  const dir = process.argv[3];
  const member = "Table sheet.wsch", library = "libraries/Resistor.wlib", root = M.createManifest(project,
    {references:[{kind:"document",id:doc.id,docKind:"schematic",name:doc.name,path:member},
      {kind:"library",id:definition.id,path:library}]});
  const sheet = M.createDocument(doc);
  function save(at, manifest, owner) {
    fs.mkdirSync(path.join(at,"libraries"),{recursive:true});
    fs.writeFileSync(path.join(at,"Tables.waffle"),F.serialize(manifest));
    fs.writeFileSync(path.join(at,member),F.serialize(owner));
    fs.writeFileSync(path.join(at,library),F.serialize(M.createLibrary(definition)));
  }
  if (process.argv[2] === "--storage-fixture") {
    const upgraded = T.upgrade(old), state = upgraded.widget.state;
    const withValue = {...upgraded,widget:{...upgraded.widget,state:T.change(state,state.rows[0].id,
      state.columns[0].id,{content:{kind:"literal",text:"32"}})}};
    const edit = (prev,item) => F.applyDelta(prev,M.documentEdits(prev,doc,{put:[item]})).file;
    const nextSheet = edit(sheet,upgraded), valueSheet = edit(nextSheet,withValue);
    const nextHead = F.withTable(root.header,true), ref = root.get(doc.id);
    const backed = F.applyDelta(root,{header:nextHead,put:[F.tableReference(ref,nextSheet)],featureChange:F.tableFeature}).file;
    save(path.join(dir,"baseline"),root,sheet);
    save(path.join(dir,"upgrade"),backed,nextSheet);
    save(path.join(dir,"edit"),backed,valueSheet);
    save(path.join(dir,"undo"),
      F.applyDelta(backed,{header:F.withTable(nextHead,false),put:[ref],featureChange:F.tableFeature}).file,
      edit(valueSheet,old));
  } else save(dir,root,sheet);
  process.stdout.write(JSON.stringify({...target,partId:part.id,member,projectId:root.header.id}));
} else main().catch(error => {console.error(error); process.exitCode = 1;});

function request(op,args,body) {
  return JSON.parse(AtriumHeadless(JSON.stringify({op,args}),body).split("\n")[0]);
}

async function main() {
  request("load",{digest:"tables"},JSON.stringify(project));
  const seen = new Set();
  async function run(id,args = {}, mode = commands.get(id).kind === "read" ? "read" : "write", native) {
    seen.add(id);
    let result = request("butter_command",{feature:"tables",spec:commands.get(id),args,mode,allowWrite:true,native});
    if (result.pendingButter) {
      const deadline = Date.now()+2500, job = result.pendingButter;
      do {
        await new Promise(resolve => setTimeout(resolve, 0));
        result = request("butter_result",{id:job});
      } while (result.pendingButter && Date.now()<deadline);
    }
    assert.equal(result.error,undefined,JSON.stringify(result));
    assert.equal(result.pendingButter,undefined,JSON.stringify(result));
    return result;
  }
  assert.equal((await run("list",{documentId:doc.id})).result.tables[0].full,false);
  assert.equal((await run("upgrade",target,"plan")).changes,1);
  assert.equal((await run("list",{documentId:doc.id})).result.tables[0].full,false);
  await run("upgrade",target);
  const creation = (await run("create",{documentId:doc.id,x:3,y:10,rows:2,columns:3})).result.itemId;
  const full = {...target,itemId:creation};
  let state = (await run("describe",full)).result;
  const [row1,row2] = state.rows.map(r => r.id);
  const [a,b,c] = state.columns.map(col => col.id);
  const cell = (rowId,columnId,content,style) => ({rowId,columnId,content,...(style?{style}:{})});
  await run("edit-cells",{...full,cells:[
    cell(row1,a,{kind:"literal",text:"2"}), cell(row1,b,{kind:"literal",text:"3"}),
    cell(row2,a,{kind:"literal",text:"5"}), cell(row2,b,{kind:"literal",text:"7"}),
    cell(row1,c,{kind:"formula",source:"=A1*B1"},{bold:true,fill:"#aaa"})]});
  await run("fill",{...full,rowId:row1,columnId:c,endRowId:row2});
  const results = (await run("evaluate",{...full,rowId:row1,columnId:c,endRowId:row2})).result;
  assert.deepEqual(results.cells.map(row => row.value.value),[6,35]);
  const repeated = (await run("evaluate",{...full,rowId:row1,columnId:c})).result;
  assert.equal(repeated.stats.evaluated,0);
  await run("edit-axis",{...full,axis:"columns",action:"configure",axisId:a,attributes:{widthNm:10000000,sortDirection:"asc"}});
  await run("edit-axis",{...full,axis:"rows",action:"insert",beforeId:row2});
  state = (await run("describe",full)).result;
  const added = state.rows[1].id;
  await run("edit-axis",{...full,axis:"rows",action:"move",axisId:added});
  await run("edit-axis",{...full,axis:"rows",action:"remove",axisId:added});
  await run("configure",{...full,headerRows:1,banded:true});
  await run("merge",{...full,rowId:row1,columnId:a,endColumnId:b,action:"merge"});
  state = (await run("describe",full)).result;
  assert.equal(state.merges[0].columns.length,2);
  assert.equal(state.banded,true);
  await run("merge",{...full,rowId:row1,columnId:a,action:"split"});
  await run("import",{...full,rowId:row2,columnId:a,format:"csv",data:'"left,right","line ""two"""'});
  await run("import",{...full,rowId:row1,columnId:a,format:"tsv",data:'"a\tb"\t6'});
  for (const format of ["csv","tsv","html"]) {
    const result = (await run("export",{...full,format})).result;
    assert.match(result.data,format === "html" ? /<table>.*left,right/s : /left,right/);
  }
  assert.ok((await run("compare",{...target,otherDocumentId:doc.id,otherItemId:creation})).result.total);
  const query = {queryDocumentId:doc.id,source:'part where designator like "R*"',fields:[{field:"designator",columnId:a}]};
  assert.equal((await run("bind-query",{...full,...query})).result.count,1);
  assert.equal((await run("refresh-query",full)).result.count,1);
  await run("clear-removed",full);
  await run("unbind-query",full);
  assert.equal((await run("describe",full)).result.query,null);
  assert.deepEqual([...seen].sort(),[...commands.keys()].sort());

  const item = T.upgrade(old), s = item.widget.state;
  const [row,col] = [s.rows[0].id,s.columns[0].id], owner = {...project,documents:[{...doc,items:[item]}]};
  let resolver;
  T.registerNumericFields({registerTargetResolver(_,r) {resolver=r;}});
  const numeric = resolver.resolve(owner,T.target(doc.id,item.id,row,col));
  const ops = numeric.plan(0);
  assert.equal(ops.length,1);
  assert.deepEqual(ops[0].path,["widget","state","cells"]);
  assert.equal(ops[0].after[0].content.text,"0");
  assert.deepEqual(item.widget.state.cells,[]);
  assert.equal(numeric.write(0),true);
  assert.deepEqual(item.widget.state.cells,ops[0].after);
  assert.deepEqual(numeric.plan(0),[]);
  console.log(seen.size + " table commands passed the actual headless dispatcher, including guarded edits and numeric planning.");
}
