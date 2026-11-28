"use strict";

// Run in the combined Butter checkout, or pass the pinned table branch's app directory.
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");
const {chromium}=require("../support/playwright.cjs");
const app=path.resolve(__dirname,"../../app"),tables=path.resolve(process.argv[2] || app);
// Find each table module wherever that app directory keeps it (app/notebook/ in this checkout).
const tableFile=file=>path.join(tables,require("../support/app-source-paths.cjs").inventoryFrom(tables).get(file) || file);
// table-formulas.js reads AtriumCalculationIntent when it loads, as the lazy registry in app/lazy.js declares.
for(const name of ["source-file","calculation-intent"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const T=require(tableFile("table-data.js")),F=require(tableFile("table-formulas.js"));
let id=0,state=T.create(3,4,()=>"axis"+(++id));
const [row,otherRow]=state.rows.map(r=>r.id),columns=state.columns.map(c=>c.id);
state={...state,columns:state.columns.map((c,i)=>i<2?{...c,unit:"Ω"}:c)};
state=T.change(state,row,columns[1],{content:{kind:"literal",text:"4"},style:{bold:true}});
state=T.change(state,row,columns[2],{content:F.scan(state,"=SUM(A1:B1)")});
state=T.change(state,otherRow,columns[1],{style:{italic:true}});
state=T.change(state,otherRow,columns[0],{content:{kind:"math",tex:"x^2"}});
const url=file=>pathToFileURL(tableFile(file)).href;

async function run() {
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try {
    const page=await browser.newPage(), errors=[],tableRequests=[];
    page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(8000);
    page.on("request",r=>{if(r.url()===url("table-data.js"))tableRequests.push(r.url());});
    await page.goto(pathToFileURL(path.join(app,"index.html")).href);
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumTableData || !!globalThis.AtriumNumericFields),false);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(()=>!!globalThis.AtriumNavHost?.doc());
    await page.evaluate(async({state,row,otherRow,columns,model,formulas})=>{
      const H=AtriumNavHost;
      AtriumPref.set("labs.notebook",true);
      // These are the real table modules. The paths can come from either feature branch.
      AtriumLazy.register("AtriumTableData",{scripts:[model],deps:["AtriumSourceFile"]});
      AtriumLazy.register("AtriumTableFormulas",{scripts:[formulas],deps:["AtriumCalculationIntent","AtriumCalculationDesign","AtriumTableData"]});
      await AtriumLazy.need(["AtriumNumericFields","AtriumUndoStore"]);
      const resistor={id:"rdef",name:"Resistor",prefix:"R",symbol:{shapes:[],pins:[]}};
      const p=Atrium.project("Sparse table numeric targets",[resistor]),d=Atrium.sheet("schematic","Values");
      p.documents.push(d);
      await H.replaceProject(p,{force:true,dirty:false});
      H.selectDocument(p.documents[0].id);
      const table={kind:"textframe",id:"tab",x:0,y:0,w:40,h:20,widget:{type:"table",state}};
      const source={id:"r5",kind:"part",ref:"R5",def:"rdef",value:"1 kΩ",x:10,y:10};
      H.edit(()=>{d.items.push(source,table);},"Insert test values",[{doc:d,items:[source,table]}],{documents:[d.id],items:[]});
      const doc=()=>H.project().documents.find(doc=>doc.id===d.id),item=()=>doc().items.find(i=>i.id==="tab");
      const target=(r,c)=>({scope:"item",documentId:d.id,itemId:"tab",path:["cells",r,c,"value"]});
      const container=document.createElement("section");container.style.cssText="position:fixed;left:0;bottom:0;z-index:99999;background:white";
      document.body.append(container);
      const fixture=globalThis.tableFieldFixture={H,doc,item,row,otherRow,columns,target,
        address:(r,c)=>target(r,columns[c]),
        read:(r,c)=>AtriumTableData.readTarget(H.project(),target(r,columns[c])),
        field(r,c,label,unit="Ω"){
          const input=document.createElement("input");input.type="text";input.setAttribute("aria-label",label);container.append(input);
          AtriumNumericFields.attach(input,{target:target(r,columns[c]),unit:unit || "",optional:true,host:H});
          return input;
        },
        authored(label,change){
          const owner=item(),document=doc();
          H.edit(()=>{const before=owner.widget.state,next=change(before);
            AtriumTableData.clearReplacedNumericTargets(H.project(),document.id,owner,before,next);
            owner.widget={...owner.widget,state:next};
          },label,[{doc:document,items:[owner]}],{documents:[document.id],items:[owner.id]});
        }};
      fixture.field(row,0,"Blank cell");fixture.field(row,1,"Populated cell");fixture.field(row,2,"Spreadsheet formula");
      fixture.field(otherRow,0,"Math content");fixture.field(otherRow,1,"Styled blank");
      const saved=target(otherRow,columns[3]);
      H.edit(()=>AtriumNumericFields.remember(H.project(),saved,{version:1,target:saved,source:"0",unit:"",storageUnit:"",bindings:[],watches:[]}),"Restore saved expression");
      AtriumNumericFields.attachHost(H);
    },{state,row,otherRow,columns,model:url("table-data.js"),formulas:url("table-formulas.js")});
    assert.equal(tableRequests.length,0);
    await page.evaluate(async()=>{const r=await AtriumNumericFields.evaluate("1+1");if(r.value!==2)throw Error("Scalar control failed");});
    assert.equal(tableRequests.length,0);
    assert.equal(await page.evaluate(()=>AtriumNumericFields.stats(tableFieldFixture.H).evaluations),0);
    await page.evaluate(()=>{const f=tableFieldFixture;AtriumNumericFields.attachHost(f.H).inspect(f.address(f.otherRow,3));});
    await page.waitForFunction(()=>globalThis.AtriumTableData && tableFieldFixture.read(tableFieldFixture.otherRow,3)?.value==="0");
    assert.equal(tableRequests.length,1);
    assert.equal(await page.evaluate(()=>{const f=tableFieldFixture;return AtriumNumericFields.locate(null,f.address(f.row,0));}),null);
    assert.equal(await page.evaluate(()=>tableFieldFixture.read(tableFieldFixture.row,0).cell),null);
    const type=async(label,text)=>{const input=page.getByRole("textbox",{name:label,exact:true});await input.fill(text);await input.press("Enter");return input;};
    const expectCell=async(column,text,source)=>page.waitForFunction(({column,text,source})=>{
      const f=tableFieldFixture;if(!globalThis.AtriumTableData)return false;
      const e=AtriumNumericFields.stored(f.H.project(),f.address(f.row,column));
      return f.read(f.row,column)?.value===text && (e?.source?.trim() || null)===source;
    },{column,text,source});
    await type("Blank cell","= 0");await expectCell(0,"0","0");assert.equal(tableRequests.length,1);
    await page.evaluate(()=>tableFieldFixture.H.act("undo"));await expectCell(0,null,null);
    assert.equal(await page.evaluate(()=>tableFieldFixture.read(tableFieldFixture.row,0).cell),null);
    await page.evaluate(()=>tableFieldFixture.H.act("redo"));await expectCell(0,"0","0");

    await type("Styled blank","= 0");
    await page.waitForFunction(()=>tableFieldFixture.read(tableFieldFixture.otherRow,1).value==="0");
    await type("Styled blank","");
    await page.waitForFunction(()=>{const f=tableFieldFixture,c=f.read(f.otherRow,1);
      return c.value===null && c.cell.style.italic && !AtriumNumericFields.stored(f.H.project(),f.address(f.otherRow,1));});

    await type("Populated cell","= R5.Value");await expectCell(1,"1000","R5.Value");
    assert.deepEqual(await page.evaluate(()=>tableFieldFixture.read(tableFieldFixture.row,1).cell.style),{bold:true});
    await page.evaluate(async()=>{
      await AtriumLazy.need("AtriumTableFormulas");
      const f=tableFieldFixture;
      f.graph=AtriumTableFormulas.engine({project:f.H.project(),doc:f.doc(),item:f.item()});
      f.result=()=>f.graph.compute(f.item().widget.state).value(f.row,f.columns[2]).value;
      const source=f.doc().items.find(i=>i.id==="r5");
      f.H.edit(()=>{source.value="2 kΩ";},"Change source",[{doc:f.doc(),items:[source]}],{documents:[f.doc().id],items:[source.id]});
    });
    await expectCell(1,"2000","R5.Value");
    assert.equal(await page.evaluate(()=>tableFieldFixture.result()),2000);
    await page.evaluate(()=>{const f=tableFieldFixture;f.authored("Insert row",s=>AtriumTableData.axis(s,"rows",0,1,true,()=>"inserted"));});
    assert.deepEqual(await page.evaluate(()=>{const f=tableFieldFixture,s=f.item().widget.state;
      return [AtriumTableFormulas.spelling(s,f.read(f.row,2).content),f.result(),f.read(f.row,1).cell.style];
    }),["=SUM(A2:B2)",2000,{bold:true}]);

    for(const label of ["Spreadsheet formula","Math content"]){
      const field=await type(label,"= 9");await page.waitForFunction(el=>el.getAttribute("aria-invalid")==="true",await field.elementHandle());
    }
    const guarded=await page.evaluate(()=>{const f=tableFieldFixture;
      return {formula:f.read(f.row,2).content.kind,math:f.read(f.otherRow,0).content.kind,result:f.result(),populated:f.read(f.row,1).value,
        binding:AtriumNumericFields.stored(f.H.project(),f.address(f.row,1))?.source.trim()};});
    assert.deepEqual(guarded,{formula:"formula",math:"math",result:2000,populated:"2000",binding:"R5.Value"});
    assert.equal(await page.getByRole("textbox",{name:"Populated cell",exact:true}).inputValue(),"2000");
    await page.evaluate(()=>{const f=tableFieldFixture,owner=f.item();f.H.edit(()=>{owner.locked=true;},"Lock table",[{doc:f.doc(),items:[owner]}]);});
    const locked=await type("Blank cell","= 8");
    await page.waitForFunction(el=>el.getAttribute("aria-invalid")==="true",await locked.elementHandle());await expectCell(0,"0","0");
    await page.evaluate(()=>{const f=tableFieldFixture,owner=f.item();f.H.edit(()=>{delete owner.locked;},"Unlock table",[{doc:f.doc(),items:[owner]}]);});
    await page.evaluate(()=>{const f=tableFieldFixture;
      f.authored("Replace engineering source",s=>AtriumTableData.change(s,f.row,f.columns[1],{content:AtriumTableFormulas.scan(s,"=IF(1=1,A2+5 Ω,1/0)")}));
    });
    const formulaValue=await page.evaluate(()=>{const f=tableFieldFixture;
      return [f.result(),f.read(f.row,1).content.kind,!!AtriumNumericFields.stored(f.H.project(),f.address(f.row,1))];
    });
    assert.deepEqual(formulaValue,[5,"formula",false]);
    await page.evaluate(()=>tableFieldFixture.H.act("undo"));await expectCell(1,"2000","R5.Value");
    await page.evaluate(()=>{const f=tableFieldFixture;
      f.authored("Declare voltage",s=>({...s,columns:s.columns.map(c=>c.id===f.columns[1]?{...c,unit:"V"}:c)}));
    });
    await expectCell(1,"2000",null);
    const oldUnit=await type("Populated cell","= 3");
    await page.waitForFunction(el=>el.getAttribute("aria-invalid")==="true",await oldUnit.elementHandle());
    await expectCell(1,"2000",null);
    await page.evaluate(()=>{const f=tableFieldFixture;f.field(f.row,1,"Voltage cell",null);});
    await type("Voltage cell","= 500 mV");await expectCell(1,"0.5","500 mV");
    assert.deepEqual(await page.evaluate(()=>{const f=tableFieldFixture,b=AtriumNumericFields.stored(f.H.project(),f.address(f.row,1));
      return [b.unit,b.storageUnit,b.tableUnit,f.graph.compute(f.item().widget.state).value(f.row,f.columns[2]).diagnostic.code];
    }),["V","V","V","dimension"]);
    await page.evaluate(()=>{const f=tableFieldFixture;
      f.stale=AtriumNumericFields.locate(f.H.project(),f.address(f.row,1));
      f.authored("Remove addressed row",s=>AtriumTableData.axis(s,"rows",1,1,false));
    });
    assert.deepEqual(await page.evaluate(()=>{const f=tableFieldFixture;
      return [AtriumNumericFields.locate(f.H.project(),f.address(f.row,1)),f.stale.write(9),f.item().widget.state.cells.some(c=>c.rowId===f.row)];
    }),[null,false,false]);
    assert.deepEqual(errors,[]);await page.close();
    console.log("PASS actual table and numeric-field owners: sparse zero, one-step undo/redo, styled live value, stable reordered addresses, Excel formulas, protected content and removed rows.");
  } finally {await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
