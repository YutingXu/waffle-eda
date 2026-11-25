const assert=require('node:assert/strict');
const fs=require('node:fs');
require('../../app/core/model.js');require('../../app/checks/altium-rules.js');require('../../app/formats/pcb-import.js');require('../../app/formats/io.js');
globalThis.CFB=require('../../app/vendor/cfb.min.js');
const source=AtriumAltiumRules;
const base="RULEKIND=Width|NAME=Via input|ENABLED=TRUE|NETSCOPE=AnyNet|LAYERKIND=SameLayer|SCOPE1EXPRESSION=InNet('VDD')|SCOPE2EXPRESSION=All|PRIORITY=2|MINLIMIT=10mil|MAXLIMIT=17mil";
const detail=source.describe(base);assert.equal(detail.priority,'2');assert.equal(detail.candidate.net,'VDD');assert.equal(detail.candidate.value,.254);
// Designer ASCII contains a modern rule and a Protel companion. The latter
// can be deliberately disabled with the original query copied to a comment.
const modern="|RECORD=DXPRule|INDEXFORSAVE=4|"+base;
const companion="|RECORD=Rule|INDEXFORSAVE=4|RULEKIND=Width|NAME=Via input|ENABLED=FALSE|SCOPE1COUNT=1|SCOPE1_0_KIND=Board|COMMENT=Protel DXP Scope";
const unpaired="|RECORD=Rule|INDEXFORSAVE=9|RULEKIND=Width|NAME=Power|ENABLED=TRUE|SCOPE1COUNT=1|SCOPE1_0_KIND=NetClass|SCOPE1_0_VALUE=Power|SCOPE2COUNT=1|SCOPE2_0_KIND=Board";
for(const lines of [[companion,modern,unpaired],[modern,companion,unpaired]]){
  const records=AtriumPCB.asciiRuleRecords(lines.join("\r\n"));assert.equal(records.length,2);assert.equal(records[0],base);
  const old=source.describe(records[1]);assert.equal(old.first,"InNetClass('Power')");assert.equal(old.second,"All");
}
assert.equal(AtriumPCB.asciiRuleRecords("|RECORD=Rule|"+base)[0],base,"older Waffle exports with modern fields on a Rule remain readable");
for(const condition of ["SCOPE1COUNT=bad","SCOPE1_0_KIND=Excluded","SCOPE1COUNT=1|SCOPE1_0_KIND=Board|SCOPE1_0_NEGATED=TRUE"])
  assert.match(source.describe("RULEKIND=Width|"+condition).first,/Legacy scope/);
const noScopes=AtriumPCB.asciiRuleRecords("|RECORD=Rule|RULEKIND=Width|NAME=Unknown");
assert.match(noScopes[0],/^RECORD=Rule\|/);assert.match(source.describe(noScopes[0]).first,/unspecified/);
const encoded=Buffer.concat([Buffer.from("|RECORD=DXPRule|RULEKIND=Width|NAME=?|%UTF8%NAME="),Buffer.from("電源")]);
assert.equal(source.describe(AtriumPCB.asciiRuleRecords(new TextDecoder("windows-1252").decode(encoded))[0]).name,"電源");
for(const [a,b] of [['InNet(\'VDD\')',"InNetClass('Power')"],['ENABLED=TRUE','ENABLED=FALSE'],['MINLIMIT=10mil','MINLIMIT=10'],['SCOPE2EXPRESSION=All','SCOPE2EXPRESSION=IsPad']])assert.equal(source.describe(base.replace(a,b)).candidate,null);
const other='RULEKIND=RoutingTopology|NAME=Star|ENABLED=FALSE|SCOPE1EXPRESSION=IsPad|VENDORFUTURE=Retain me';
assert.deepEqual(source.read(Buffer.from(source.write([base,other]))),[base,other]);
for(const coding of ['utf16le','latin1']){const text=source.write([base,other]);const bytes=coding==='utf16le'?Buffer.concat([Buffer.from([255,254]),Buffer.from(text,coding)]):Buffer.from(text,coding);assert.deepEqual(source.read(bytes),[base,other]);}
const clear='RULEKIND=Clearance|ENABLED=TRUE|NETSCOPE=DifferentNets|LAYERKIND=SameLayer|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|GAP=0.15mm';
assert.equal(source.describe(clear).candidate.value,.15);assert.equal(source.describe(clear+'|OBJECTCLEARANCES=ClearanceObj_Track-ClearanceObj_Pad:1000').candidate,null);
function binary(line,kind=14){const data=Buffer.from('|'+line+'\0','latin1'),head=Buffer.alloc(6);head.writeUInt16LE(kind);head.writeUInt32LE(data.length,2);return Buffer.concat([head,data]);}
assert.deepEqual(source.binary(Buffer.concat([binary(base),binary(other)])),[base,other]);assert.throws(()=>source.binary(binary(base).subarray(0,12)));assert.throws(()=>source.read(Buffer.from('Some other file')));
const kinds=[],lines=source.binary(Buffer.concat([binary(base,2),binary(other,7)]),kinds);
assert.deepEqual(kinds,[2,7]);
function checkOptions(batch,online){
  const body=Buffer.from("|RECORD=DesignRuleCheckerOptions|RULESETTOCHECK="+batch+"|ONLINERULESETTOCHECK="+online+"\0"),head=Buffer.alloc(4);
  head.writeUInt32LE(body.length);return Buffer.concat([head,body]);
}
assert.deepEqual(source.checkOptions(checkOptions("2,56","7"),kinds,lines),{kinds,batch:[2,56],online:[7]});
assert.deepEqual(source.checkOptions(checkOptions("",""),kinds,lines),{kinds,batch:[],online:[]});
assert.equal(source.checkOptions(checkOptions("2,2","7"),kinds,lines),null);
assert.equal(source.checkOptions(checkOptions("2","n/a"),kinds,lines),null);
assert.equal(source.checkOptions(checkOptions("2","7").subarray(0,-1),kinds,lines),null);
assert.equal(source.checkOptions(checkOptions("2","7"),[2,2],lines),null);
const legacy=Buffer.from('|'+base+'|NAME=Cafe|%UTF8%NAME=','latin1'),payload=Buffer.concat([legacy,Buffer.from('名称','utf8'),Buffer.from([0])]),header=Buffer.alloc(6);header.writeUInt32LE(payload.length,2);
assert.equal(source.describe(source.binary(Buffer.concat([header,payload]))[0]).name,'名称');
const ascii=Buffer.from('RECORD=Board|VX0=0mil|VY0=0mil\r\nRECORD=Rule|'+base);assert.deepEqual(AtriumIO.read('Tiny.PcbDoc',ascii).documents[0].sourceRules,[base]);
if(process.argv[2]){const bytes=fs.readFileSync(process.argv[2]);const records=source.read(bytes);assert.equal(records.length,38);assert.deepEqual(Buffer.from(source.write(records)),bytes);assert.equal(records.map(source.describe).filter(r=>r.candidate).length,3);}
if(process.argv[3]){const board=AtriumIO.read('PDP_V3.PcbDoc',fs.readFileSync(process.argv[3])).documents[0];assert.equal(board.sourceRules.length,35);const rows=board.sourceRules.map(source.describe);assert.equal(rows.find(r=>r.kind==='Clearance').candidate.value,.1778);assert.equal(rows.find(r=>r.kind==='RoutingVias').candidate.value,.7112);assert.deepEqual(source.read(Buffer.from(source.write(board.sourceRules))),board.sourceRules);}
console.log('PASS Altium RUL and Rules6 framing, units, scopes, source preservation and unsupported rule handling');
