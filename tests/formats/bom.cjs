"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/core/zip.js");require("../../app/formats/bom.js");
const A=Atrium,B=AtriumBOM;

// Designator compression and natural order.
assert.equal(B.compress(["C5","C1","C4","C3"]),"C1, C3-C5");
assert.equal(B.compress(["R10","R9","R2","R1"]),"R1, R2, R9, R10");
assert.equal(B.compress(["R1","R2","R3","R3","R10","R11","R12","R13"]),"R1-R3, R10-R13");
assert.equal(B.compress(["U1A","U1B","TP","J?"]),"J?, TP, U1A, U1B");
assert.equal(B.compress(["C1","C2"],2),"C1-C2");
assert.equal(B.compress(["LED1","LED2","LED3","D1"]),"D1, LED1-LED3");
assert.deepEqual(["R10","r2","R1","C100","C20"].sort(B.naturalCompare),["C20","C100","R1","r2","R10"]);

// The sample project lists every component once with matching board parts.
const p=AtriumParts.example(),[sch,brd]=p.documents;
let c=B.collect(p);
assert.equal(c.source,"schematic");assert.equal(c.parts.length,7);assert.equal(c.excluded.length,0);assert.deepEqual(c.mismatches,[]);
let rows=B.build(c);
assert.deepEqual(rows.map(r=>r.values.designator),["C1","C2","J1","J2","R1","R2","U1"]);
assert.deepEqual(rows.map(r=>r.line),[1,2,3,4,5,6,7]);
assert.equal(rows.find(r=>r.values.designator==="R1").values.footprint,"R_0603");

// Grouping by Comment + Footprint.
function addPair(ref,base){
  const s={...A.clone(sch.items.find(i=>i.ref===base)),id:"s-"+ref,ref,link:"link-"+ref};
  const b={...A.clone(brd.items.find(i=>i.ref===base)),id:"b-"+ref,ref,link:"link-"+ref};
  sch.items.push(s);brd.items.push(b);
}
for(const r of ["C3","C4","C5","C7"])addPair(r,"C2");
addPair("R3","R1");
c=B.collect(p);rows=B.build(c);
const caps=rows.find(r=>r.values.comment==="100 nF");
assert.equal(caps.values.designator,"C2-C5, C7");assert.equal(caps.values.quantity,5);
assert.equal(rows.find(r=>r.values.comment==="10 kΩ").values.designator,"R1, R3");
assert.equal(rows.length,7);assert.equal(c.parts.length,12);
rows=B.build(c,{groupBy:["footprint"]});
const c0603=rows.find(r=>r.values.footprint==="C_0603");
assert.equal(c0603.values.designator,"C1-C5, C7");assert.equal(c0603.values.comment,"10 nF, 100 nF");
assert.equal(B.build(c,{groupBy:[]}).length,12);
rows=B.build(c,{sort:{key:"quantity",dir:-1}});
assert.equal(rows[0].values.designator,"C2-C5, C7");assert.equal(rows[0].line,1);
assert.deepEqual(B.build(c,{sort:{key:"comment",dir:1}}).map(r=>r.values.comment),["10 kΩ","10 nF","100 nF","100 Ω","Buffer","Input","Output"]);

// Exclusions: power and graphic symbols, missing footprints and DNP markers.
const resistor=p.library.find(d=>d.id==="std-r");
p.library.push(
  {id:"pwr-gnd",name:"GND",category:"Power",prefix:"#PWR",value:"GND",symbol:{pins:[{number:"1",name:"GND",x:0,y:0,electrical:7}],shapes:[]}},
  {id:"logo",name:"Logo",category:"Graphics",prefix:"LOGO",value:"Logo",symbol:{pins:[],shapes:[]}},
  {id:"nofp",name:"Mystery",category:"Imported symbols",prefix:"U",value:"Mystery",footprintName:"",symbol:{pins:[{number:"1",x:0,y:0},{number:"2",x:1,y:0}],shapes:[]}},
  {...A.clone(resistor),id:"std-r-dnp",parameters:{DNP:"Yes"}},
  {...A.clone(resistor),id:"std-r-mfr",description:"Thick film resistor",parameters:{Manufacturer:"Yageo","Manufacturer Part Number":"RC0603FR-0710KL",Comment:"=Value",Value:"10k"}});
const put=(ref,def,value,extra={})=>sch.items.push({id:"x-"+ref,kind:"part",def,ref,value,x:0,y:0,angle:0,pinNets:{},link:"lx-"+ref,...extra});
put("#PWR01","pwr-gnd","GND");put("PWR2","pwr-gnd","GND");put("LOGO1","logo","Logo");put("U9","nofp","Mystery");
put("R20","std-r-dnp","100 kΩ");put("R21","std-r","DNP");put("R22","std-r","4.7 kΩ",{dnp:true});
put("R23","std-r-mfr","10k");put("R24","std-r-mfr","10k");
c=B.collect(p);
assert.deepEqual(Object.fromEntries(c.excluded.map(x=>[x.ref,x.reason])),{"#PWR01":"Power or virtual symbol",PWR2:"Power or virtual symbol",
  LOGO1:"Power or virtual symbol",U9:"No footprint",R20:"Do not populate",R21:"Do not populate",R22:"Do not populate"});
assert.equal(c.parts.length,14);
assert.ok(c.params.includes("MANUFACTURER PART NUMBER")&&!c.params.includes("COMMENT"));
assert.equal(B.columns(c).find(x=>x.key==="p:MANUFACTURER PART NUMBER").label,"Manufacturer Part Number");
const mfr=B.build(c).find(r=>r.values.comment==="10k");
assert.deepEqual([mfr.values.designator,mfr.values.description,mfr.values["p:MANUFACTURER"],mfr.values.libref],["R23, R24","Thick film resistor","Yageo","Resistor"]);
assert.ok(c.mismatches.some(m=>m.ref==="R23"&&m.kind==="schematic-only"));
assert.ok(!c.mismatches.some(m=>["#PWR01","U9","LOGO1"].includes(m.ref)));

// Schematic and board differences, and a board-sourced BOM.
const p2=AtriumParts.example();
p2.documents[0].items.find(i=>i.ref==="R2").value="220 Ω";
const alt={...A.clone(p2.library.find(d=>d.id==="std-j3")),id:"fp-alt"};alt.footprint.name="Conn_Alt";p2.library.push(alt);
p2.documents[1].items.find(i=>i.ref==="J1").def="fp-alt";
p2.documents[1].items.push({...A.clone(p2.documents[1].items.find(i=>i.ref==="C1")),id:"b-C9",ref:"C9",link:"link-C9"});
assert.deepEqual(B.collect(p2).mismatches.map(m=>[m.ref,m.kind,m.schematic,m.board]),
  [["C9","board-only","","10 nF"],["J1","footprint","PinHeader_1×03_2.54mm","Conn_Alt"],["R2","comment","220 Ω","100 Ω"]]);
p2.library.find(d=>d.id==="std-r").description="Chip resistor";
c=B.collect(p2,{source:"pcb"});rows=B.build(c);
assert.equal(c.source,"pcb");
const lineFor=ref=>rows.find(r=>r.refs.includes(ref)).values;
assert.equal(lineFor("R2").comment,"100 Ω");assert.equal(lineFor("R2").description,"Chip resistor");
assert.equal(lineFor("J1").footprint,"Conn_Alt");assert.equal(lineFor("C1").designator,"C1, C9");

// Multi-part components spread across sheets count once.
const p3=AtriumParts.example(),power=A.sheet("schematic","Power");
p3.documents.splice(1,0,power);
power.items.push({...A.clone(p3.documents[0].items.find(i=>i.ref==="U1")),id:"s-U1b"});
c=B.collect(p3);
assert.equal(c.parts.length,7);assert.deepEqual(c.notes,[]);
assert.equal(B.build(c).find(r=>r.refs.includes("U1")).values.document,"Analog front end, Power");
power.items[0].value="Other";assert.equal(B.collect(p3).notes.length,1);

// CSV: UTF-8 byte order mark, RFC 4180 quoting, CRLF and formula guard.
const r0={title:"Bill of Materials",project:"Demo",source:"Schematic · 1 sheet",date:"2026-11-18",created:"2026-11-18T10:00:00Z",
  totalParts:3,lineCount:2,excluded:1,titleBlock:true,
  columns:[{key:"line",label:"Line #",numeric:true},{key:"comment",label:"Comment"},{key:"designator",label:"Designator"},{key:"quantity",label:"Quantity",numeric:true}],
  rows:[[1,'Cap "X7R", 50V',"C1, C3-C5",4],[2,"=SUM(A1)\nline2","R1",1],[3,"-5V rail","R2",1],[4,"-12"," pad ",1]]};
const text=B.csv(r0),lines=text.slice(1).split("\r\n");
assert.equal(text.charCodeAt(0),0xfeff);assert.ok(text.endsWith("\r\n"));
assert.deepEqual(lines.slice(0,8),["Bill of Materials","Project,Demo","Source,Schematic · 1 sheet","Date,2026-11-18","Total parts,3","Excluded,1","","Line #,Comment,Designator,Quantity"]);
assert.equal(lines[8],'1,"Cap ""X7R"", 50V","C1, C3-C5",4');
assert.ok(text.includes('2,"\'=SUM(A1)\nline2",R1,1'));
assert.ok(lines.includes("3,'-5V rail,R2,1"));assert.ok(lines.includes('4,-12," pad ",1'));
assert.equal(B.csv({...r0,titleBlock:false},{bom:false}).split("\r\n")[0],"Line #,Comment,Designator,Quantity");

// A minimal XML well-formedness check and an independent stored-ZIP reader.
function wellFormed(src){
  let i=0,roots=0;const stack=[],name=/[A-Za-z_:][\w.:-]*/y;
  const fail=m=>{throw Error(m+" at "+i);};
  const read=()=>{name.lastIndex=i;const m=name.exec(src);if(!m)fail("name");i=name.lastIndex;return m[0];};
  const ws=()=>{while(/\s/.test(src[i]||""))i++;};
  const text=t=>{if(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(t)||t.includes("<")||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t))fail("text");};
  if(src.startsWith("<?xml"))i=src.indexOf("?>")+2;
  while(i<src.length){
    const lt=src.indexOf("<",i),chunk=lt<0?src.slice(i):src.slice(i,lt);
    if(!stack.length&&chunk.trim())fail("text outside root");
    text(chunk);if(lt<0)break;i=lt+1;
    if(src[i]==="/"){i++;const n=read();ws();if(src[i++]!==">"||stack.pop()!==n)fail("close "+n);continue;}
    const n=read(),attrs=new Set();
    for(;;){
      ws();
      if(src.startsWith("/>",i)){i+=2;if(!stack.length)roots++;break;}
      if(src[i]===">"){i++;if(!stack.length)roots++;stack.push(n);break;}
      const a=read();if(attrs.has(a))fail("duplicate "+a);attrs.add(a);ws();if(src[i++]!=="=")fail("=");ws();
      const q=src[i];if(q!=='"'&&q!=="'")fail("quote");const e=src.indexOf(q,i+1);if(e<0)fail("attr");text(src.slice(i+1,e));i=e+1;
    }
  }
  if(stack.length||roots!==1)fail("structure");
  return true;
}
const table=[];for(let n=0;n<256;n++){let x=n;for(let k=0;k<8;k++)x=x&1?0xedb88320^(x>>>1):x>>>1;table[n]=x>>>0;}
const crc=b=>{let x=0xffffffff;for(const v of b)x=table[(x^v)&255]^(x>>>8);return (x^0xffffffff)>>>0;};
function unzip(bytes){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),utf8=new TextDecoder("utf-8",{fatal:true});
  let e=bytes.length-22;while(e>=0&&v.getUint32(e,true)!==0x06054b50)e--;
  assert.ok(e>=0,"end of central directory");
  const count=v.getUint16(e+10,true),size=v.getUint32(e+12,true),start=v.getUint32(e+16,true);
  assert.equal(start+size,e);
  const out=new Map();let at=start;
  for(let k=0;k<count;k++){
    assert.equal(v.getUint32(at,true),0x02014b50);
    const method=v.getUint16(at+10,true),sum=v.getUint32(at+16,true),packed=v.getUint32(at+20,true),plain=v.getUint32(at+24,true);
    const nl=v.getUint16(at+28,true),xl=v.getUint16(at+30,true),cl=v.getUint16(at+32,true),off=v.getUint32(at+42,true);
    const name=utf8.decode(bytes.subarray(at+46,at+46+nl));
    assert.equal(v.getUint32(off,true),0x04034b50);assert.equal(method,0);assert.equal(packed,plain);
    const lnl=v.getUint16(off+26,true),lxl=v.getUint16(off+28,true);
    assert.equal(utf8.decode(bytes.subarray(off+30,off+30+lnl)),name);
    const data=bytes.subarray(off+30+lnl+lxl,off+30+lnl+lxl+packed);
    assert.equal(crc(data),sum,"CRC of "+name);
    out.set(name,utf8.decode(data));at+=46+nl+xl+cl;
  }
  return out;
}

// XLSX: every part is well formed, Quantity is numeric and the header is bold.
const files=B.xlsxFiles(r0);
assert.deepEqual(files.map(f=>f.name),["[Content_Types].xml","_rels/.rels","docProps/core.xml","xl/workbook.xml","xl/_rels/workbook.xml.rels","xl/styles.xml","xl/worksheets/sheet1.xml"]);
for(const f of files)assert.ok(wellFormed(f.data),f.name);
const parts=unzip(B.xlsx(r0)),sheet=parts.get("xl/worksheets/sheet1.xml");
assert.deepEqual([...parts.keys()],files.map(f=>f.name));
assert.ok(sheet.includes('<c r="D9"><v>4</v></c>'));
assert.ok(sheet.includes('<c r="A8" s="1" t="inlineStr"><is><t xml:space="preserve">Line #</t></is></c>'));
assert.ok(sheet.includes("Cap &quot;X7R&quot;, 50V"));
assert.ok(sheet.includes("=SUM(A1)\nline2")&&!sheet.includes("'=SUM"));
assert.ok(sheet.includes('<pane ySplit="8" topLeftCell="A9" activePane="bottomLeft" state="frozen"/>'));
assert.ok(sheet.includes('<autoFilter ref="A8:D12"/>'));
assert.ok(parts.get("xl/workbook.xml").includes("'Bill of Materials'!$A$8:$D$12"));
assert.ok(parts.get("xl/styles.xml").includes('<font><b/><sz val="11"/>'));
const nasty={...r0,project:"A&B <x>",rows:[[1,"bad\u0001char \ud800 lone & <tag> 😀 Ω","R1",1]]};
for(const f of B.xlsxFiles(nasty))assert.ok(wellFormed(f.data),f.name);
assert.ok(unzip(B.xlsx(nasty)).get("xl/worksheets/sheet1.xml").includes("badchar  lone &amp; &lt;tag&gt; 😀 Ω"));
const plain=B.xlsxFiles({...r0,titleBlock:false}).find(f=>f.name.endsWith("sheet1.xml")).data;
assert.ok(plain.includes('<row r="1"><c r="A1" s="1"')&&plain.includes('<autoFilter ref="A1:D5"/>'));

// Reports from the project.
const rep=B.report(p,{date:"2026-11-18",created:"2026-11-18T00:00:00Z"});
assert.deepEqual(rep.columns.map(x=>x.label),["Line #","Comment","Description","Designator","Footprint","LibRef","Quantity"]);
assert.equal(rep.totalParts,14);assert.equal(rep.excluded,7);
assert.ok(rep.rows.every(r=>typeof r[0]==="number"&&typeof r[6]==="number"));
for(const [name,xml] of unzip(B.xlsx(rep)))assert.ok(wellFormed(xml),name);
const custom=B.report(p,{columns:["designator","p:MANUFACTURER PART NUMBER","quantity","bogus"],groupBy:["comment","footprint","p:MANUFACTURER PART NUMBER"]});
assert.deepEqual(custom.columns.map(x=>x.key),["designator","p:MANUFACTURER PART NUMBER","quantity"]);
assert.ok(custom.rows.some(r=>r[0]==="R23, R24"&&r[1]==="RC0603FR-0710KL"&&r[2]===2));

// HTML and file names.
const page=B.html(nasty);
assert.ok(page.startsWith("<!doctype html>")&&page.includes("A&amp;B &lt;x&gt;")&&page.includes('<td class="num">1</td>')&&!page.includes("<tag>"));
assert.equal(B.fileName("My: Project?","csv"),"My- Project--BOM.csv");

// An empty project.
const empty=B.collect(A.project("Empty",[]));
assert.deepEqual([empty.parts.length,empty.excluded.length,B.build(empty).length],[0,0,0]);
for(const f of B.xlsxFiles(B.report(A.project("Empty",[]))))assert.ok(wellFormed(f.data),f.name);

// ------------------------------------------------------------ BOM editor data layer
{
  const q=AtriumParts.example(),[qs,qb]=q.documents;
  const pair=(ref,base,value,params,extra={})=>{
    const s={...A.clone(qs.items.find(i=>i.ref===base)),id:"s-"+ref,ref,link:"link-"+ref,value,...extra};if(params)s.parameters=params;
    qs.items.push(s);qb.items.push({...A.clone(qb.items.find(i=>i.ref===base)),id:"b-"+ref,ref,link:"link-"+ref,value});return s;};
  pair("R3","R1","10 kΩ",{"Manufacturer Part Number":"RC0603FR-0710KL",Manufacturer:"Yageo"});
  pair("R4","R1","10 kΩ",{"Manufacturer Part Number":"ERJ-3EKF1002V",Manufacturer:"Panasonic"});
  pair("R5","R1","10 kΩ",null,{dnp:true});
  let c=B.collect(q);
  assert.equal(c.dnp.length,1);assert.equal(c.parts.find(e=>e.ref==="R3").mpn,"RC0603FR-0710KL");
  // Default grouping is value + footprint + MPN: three 10 kΩ lines.
  let rows=B.build(c);
  assert.deepEqual(B.defaults.groupBy,["comment","footprint","mpn"]);
  assert.equal(rows.filter(r=>r.values.comment==="10 kΩ").length,3);
  assert.ok(rows.find(r=>r.refs.includes("R1")).status.includes("missing-mpn"));
  assert.ok(!rows.find(r=>r.refs.includes("R3")).status.includes("missing-mpn"));
  // Grouping by comment only flags the mixed-MPN line as unbalanced.
  const merged=B.build(c,{groupBy:["comment","footprint"]}).find(r=>r.values.comment==="10 kΩ");
  assert.ok(merged.status.includes("unbalanced"));assert.equal(merged.values.status.includes("Unbalanced"),true);
  // DNP visibility: DNP parts get their own line, never merged with fitted parts.
  rows=B.build(c,{showDnp:true});
  const dl=rows.find(r=>r.refs.includes("R5"));assert.ok(dl.dnp&&dl.refs.length===1&&dl.values.dnp==="DNP");
  // Duplicate designators.
  pair("R1","R1","22 kΩ");
  assert.ok(B.build(B.collect(q)).some(r=>r.status.includes("duplicate")));
  qs.items.pop();qb.items.pop();c=B.collect(q);
  // Multi-key sort: quantity descending, then comment.
  rows=B.build(c,{groupBy:["comment"],sort:[{key:"quantity",dir:-1},{key:"comment",dir:1}]});
  assert.equal(rows[0].values.comment,"10 kΩ");assert.deepEqual(rows.slice(1,3).map(r=>r.values.comment),["10 nF","100 nF"]);
  // Search and per-column filters ("=" exact, "!" excludes).
  rows=B.build(c);
  assert.equal(B.filterRows(rows,{filters:{comment:"10 k"}}).length,3);
  assert.equal(B.filterRows(rows,{filters:{comment:"=10 nF"}}).length,1);
  assert.ok(B.filterRows(rows,{filters:{comment:"!10"}}).every(r=>!r.values.comment.includes("10")));
  assert.equal(B.filterRows(rows,{query:"panasonic"},["mpn","manufacturer"]).length,1);
  assert.equal(B.filterRows(rows,{filters:{designator:"R3"}}).length,1);
  // Supplier solutions feed stock, price, lifecycle and status.
  const solutions=new Map([["RC0603FR-0710KL",{supplier:"Mouser",stock:3,unit:0.01,lifecycle:"nrnd"}]]);
  const sr=B.build(c,{solutions,boards:10}).find(r=>r.refs.includes("R3"));
  assert.deepEqual([sr.values.stock,sr.values.price,sr.values.lifecycle,sr.values.supplier],[3,0.01,"nrnd","Mouser"]);
  assert.ok(sr.status.includes("out-of-stock")&&sr.status.includes("nrnd"));
  // Inline edits: one plan, schematic and board copies, original key spelling.
  const r3=c.parts.find(e=>e.ref==="R3"),r1=c.parts.find(e=>e.ref==="R1");
  let ch=B.planEdit([r3],"mpn","RC0603FR-0710KL-X");
  assert.deepEqual(ch.map(x=>x.path),[["parameters","Manufacturer Part Number"]]);
  ch=B.planEdit([r1,r3],"comment","10k");assert.equal(ch.length,4);
  assert.equal(B.applyChanges(q,ch),4);
  assert.equal(qb.items.find(i=>i.ref==="R1").value,"10k");
  assert.throws(()=>B.applyChanges(q,ch),"stale plans refuse");
  ch=B.planEdit([B.collect(q).parts.find(e=>e.ref==="R1")],"mpn","CRCW060310K0FKEA");
  assert.deepEqual(ch[0].path,["parameters","Manufacturer Part Number"]);assert.equal(ch[0].before,undefined);
  B.applyChanges(q,ch);assert.equal(B.collect(q).parts.find(e=>e.ref==="R1").mpn,"CRCW060310K0FKEA");
  ch=B.planEdit([B.collect(q).parts.find(e=>e.ref==="R1")],"description","Pull-up");B.applyChanges(q,ch);
  assert.equal(B.collect(q).parts.find(e=>e.ref==="R1").description,"Pull-up");
  ch=B.planEdit([B.collect(q).parts.find(e=>e.ref==="R1")],"dnp","DNP");B.applyChanges(q,ch);
  assert.ok(B.collect(q).dnp.some(e=>e.ref==="R1"));
  ch=B.planEdit(B.collect(q).dnp.filter(e=>e.ref==="R1"),"dnp","");B.applyChanges(q,ch);
  assert.ok(B.collect(q).parts.some(e=>e.ref==="R1"));
  assert.throws(()=>B.planEdit([r1],"quantity","3"));
  assert.ok(B.editable("p:MANUFACTURER")&&!B.editable("designator"));
  A.validate(q);
  // Named views are stored in the project and drive reports.
  assert.throws(()=>B.saveView(q,{name:" "}));
  B.saveView(q,{name:"Purchasing",columns:["designator","mpn","quantity","bogus"],sort:[{key:"quantity",dir:-1}],filters:{mpn:"!"},widths:{mpn:999999},pinned:1,groupBy:["mpn"]});
  assert.equal(q.bomViews.length,1);assert.equal(q.bomViews[0].widths.mpn,1200);
  B.saveView(q,{name:"purchasing",columns:["designator","mpn","quantity"],filters:{mpn:"!"},groupBy:["mpn"],sort:[{key:"quantity",dir:-1}]});
  assert.equal(q.bomViews.length,1,"names are case-insensitive");
  const vr=B.report(q,{view:"Purchasing"});
  assert.deepEqual(vr.columns.map(x=>x.key),["designator","mpn","quantity"]);
  assert.ok(vr.rows.every(r=>r[1]));assert.equal(vr.view,"purchasing");
  assert.deepEqual(B.report(q,{view:"Purchasing",columns:["designator"]}).columns.map(x=>x.key),["designator"],"explicit settings win");
  assert.throws(()=>B.report(q,{view:"Nope"}));
  A.validate(JSON.parse(JSON.stringify(q)));
  assert.ok(B.deleteView(q,"PURCHASING")&&!("bomViews" in q));
  // Clipboard text.
  assert.equal(B.tsv([["a","b\tc"],[1,'q"x']]),'a\t"b\tc"\n1\t"q""x"');
  // 2,000-line grid data: build + filter + sort stay interactive.
  const big=AtriumParts.example(),[gs,gb]=big.documents;
  for(let i=0;i<4000;i++){const k=i>>1,ref="R"+(100+i);
    const s={...A.clone(gs.items.find(x=>x.ref==="R1")),id:"s"+i,ref,value:(k%997+1)+"."+(k%10)+"k",link:"L"+i,parameters:{"Manufacturer Part Number":"MPN"+k}};
    gs.items.push(s);gb.items.push({...A.clone(gb.items.find(x=>x.ref==="R1")),id:"b"+i,ref,value:s.value,link:"L"+i});}
  let t=performance.now();const gc=B.collect(big);const tc=performance.now()-t;
  t=performance.now();const grows=B.build(gc,{sort:[{key:"comment",dir:-1},{key:"quantity",dir:1}]});const tb=performance.now()-t;
  t=performance.now();const gf=B.filterRows(grows,{filters:{comment:"5."}});const tf=performance.now()-t;
  assert.ok(grows.length>=2000&&gf.length>0);
  console.log("bench: "+grows.length+" lines · collect "+tc.toFixed(1)+" ms · build+sort "+tb.toFixed(1)+" ms · filter "+tf.toFixed(1)+" ms");
  // A cell edit in the grid re-collects and regroups the whole BOM (one undo step, then this): about
  // 20 ms here for 4,000 parts; the bound only catches an order-of-magnitude regression.
  assert.ok(tc+tb<150,"collect + build of 4,000 parts took "+(tc+tb).toFixed(0)+" ms");
}
console.log("bom tests passed");
