"use strict";
const assert = require("node:assert/strict");
for (const f of ["model","parts","sch-objects","hierarchy","multichannel","query","rules","erc","netlist","netlist-text"]) require(require("../support/app-source-paths.cjs").appFile(f+".js"));
const A=Atrium,T=AtriumNetlistText, p=AtriumParts.example(), board=p.documents[1],sheet=p.documents[0];
p.signals={version:1,signals:[{id:"src",name:"Filter path",kind:"single",legs:[{nets:["VIN"]}],span:false,tags:["Input"]},
  {id:"bank",name:"Inputs",kind:"bus",members:["src"]}],tags:[{name:"Input"},{name:"Spare tag"}],nets:{GND:{tags:["Power"]}}};
const original=T.compile(p),result=T.validate(original.text),clone=x=>JSON.parse(JSON.stringify(x));
assert.deepEqual(result.diagnostics,[]);assert.ok(original.text.endsWith("\n"));
assert.match(original.text,/signal "Filter path" single = \[VIN\]/);assert.match(original.text,/signal Inputs bus = \["Filter path"\]/);
assert.match(original.text,/tag Power nets \[GND\] signals \[\]/);assert.match(original.text,/tag "Spare tag" nets \[\] signals \[\]/);
const reversed=clone(p);reversed.library.reverse();reversed.documents.reverse();reversed.signals.signals.reverse();reversed.signals.tags.reverse();
for(const d of reversed.documents)d.items.reverse();
assert.equal(T.compile(reversed).text,original.text,"source order does not affect the text");
const special=clone(p);special.documents[0].items.find(i=>i.kind==="part").value='"</script>\n\\→' ;
assert.ok(T.validate(T.compile(special).text).valid,"escaped strings are data");
for(const kind of ["part","net","signal","tag"]){
  const row=original.text.split("\n").find(s=>s.startsWith(kind+" "));const parsed=T.readLine(row);
  assert.equal(parsed.kind,kind);for(const t of parsed.tokens)assert.equal(row.slice(t.start,t.end),t.raw);
}
const empty=A.project("Empty",[]);empty.documents=[A.sheet("schematic","Empty")];assert.equal(T.compile(empty).text,"netlist 1\n");
const schOnly=clone(p);schOnly.documents=[schOnly.documents.find(d=>d.kind==="schematic")];assert.match(T.compile(schOnly).text,/tag Input nets \[\] signals \["Filter path"\]/);
const pcbOnly=clone(p);pcbOnly.documents=pcbOnly.documents.filter(d=>d.kind==="pcb");pcbOnly.documents[0].items.push({id:"spur",kind:"track",width:.2,points:[[0,0],[2,2]],layer:"Top",net:"NO_PINS"});
assert.match(T.compile(pcbOnly).text,/net NO_PINS = \[\]/);assert.equal(T.compile(pcbOnly).source,"pcb");
const b2={...clone(board),name:"A board",id:"first",items:[]};pcbOnly.documents.push(b2);
assert.equal(T.compile(pcbOnly).board,b2.id);assert.equal(T.compile(pcbOnly,{board:board.id}).board,board.id);
const scoped=clone(p);scoped.documents.push(b2);scoped.signals.signals[0].boards=[board.id];
const otherBoard=T.compile(scoped,{board:b2.id});assert.match(otherBoard.text,/signal Inputs bus = \[\]/);
assert.ok(!T.validate(otherBoard.text).diagnostics.some(d=>d.code==="unknown-signal"));
assert.throws(()=>T.compile(pcbOnly,{board:"absent"}));
const repeated=clone(p),top=A.sheet("schematic","Top");repeated.documents.unshift(top);
top.items.push(AtriumSchObjects.make("sheetsymbol",[40,0],{name:"Repeat(CH,1,4)",sheet:sheet.id}));
const compiled=T.compile(repeated,{navigation:true});assert.equal(compiled.counts.parts,original.counts.parts*4);
assert.match(compiled.text,/part R1_CH4 /);assert.equal(compiled.origins.get("R1_CH4")[0].part.ref,"R1");
assert.ok(!T.validate(compiled.text).diagnostics.some(d=>d.code==="unknown-pin"||d.code==="unknown-part"));
const diagnostics=body=>T.validate("netlist 1\n"+body).diagnostics;
for(const [body,code] of [
  ['part U1 value "" footprint SO pins [1:passive,]','syntax'], ['net "bad = [R1.1]','syntax'],
  ['net M = [MISSING.1]','unknown-part'], ['part U1 value "" footprint "" pins [1:passive]\nnet M = [U1.2]','unknown-pin'],
  ['net M = []\nnet M = []','duplicate'], ['part U1 value x footprint y pins [1:bad]','pin-type'],
  ['part U1 value x footprint y pins [1:passive]\nnet A = [U1.1]\nnet B = [U1.1]','pin-assignment'],
  ['signal A single = [X]','unknown-net'], ['signal A bus = [X]','unknown-signal'], ['signal A bus = [B]\nsignal B bus = [A]','bus-cycle'],
  ['signal A diff = [] | []','empty-leg'], ['net N = []\nsignal A diff = [N] | [N]','signal-membership'],
  ['tag X nets [] signals [Z]','unknown-signal'], ['net N = []\ntag Z nets [N,N] signals []','duplicate'],
  ['part X value a footprint b pins [1:output, 2:output]\nnet N = [X.1, X.2]','pin-matrix']]){
    assert.ok(diagnostics(body).some(d=>d.code===code),code);
}
assert.equal(T.validate('net N = []').diagnostics[0].code,'header');
assert.ok(diagnostics("part r1 value x footprint y pins [1:passive]\nnet N = [R1.1]").length===0);
assert.equal(diagnostics("tag Analog nets [] signals []\ntag analog nets [] signals []")[0].code,"duplicate");
assert.equal(diagnostics("part X value x footprint y pins [1:output, 2:output, 3:output]\nnet N = [X.1, X.2, X.3]").filter(d=>d.code==="pin-matrix").length,1);
assert.throws(()=>T.readLine("net N = []",2),/limit/);
assert.equal(T.readLine("net N = []  ",5).tokens.length,5);
assert.deepEqual(diagnostics('net M = [MISSING.1]').map(d=>[d.line,d.column,d.endColumn]),[[2,10,17]]);
assert.equal(T.validate("netlist 1\r\n\r\nnet N = []\r\n").valid,true);
assert.equal(T.validate("netlist 1\n"+"net A = [BAD.1]\n".repeat(110)).diagnostics.length,100);
console.log("netlist-text ok");
