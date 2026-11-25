"use strict";
const assert=require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/checks/design-query-record.js");
require("../../app/checks/rules.js");
const R=AtriumRules, rules=R.defaults(), defs=new Map();
const scope=AtriumDesignQueryRecord.selector;
const track=(id,net,points,width=.2,layer="Top")=>({kind:"track",id,net,points,width,layer});
const via=(id,net,x,y)=>({kind:"via",id,net,x,y,diameter:.6,drill:.29,layer:"Multi"});
const run=(objects,r=rules,lib=defs)=>R.check({kind:"pcb",items:objects},lib,r);
const clearance=out=>out.issues.filter(i=>i.rule==="clearance");
assert.deepEqual(R.validate(JSON.parse(JSON.stringify(rules))),rules);
for(const bad of [{...rules,units:"mil"},{...rules,version:99},{...rules,nets:{VDD:{spacing:2}}},{...rules,defaults:{viaDrill:.3,trackWidth:.1,clearance:-1}}])assert.throws(()=>R.validate(bad));
// Altium rounding: an 11.811 mil hole (0.2999994 mm) meets a 0.3 mm minimum; 0.299 mm still fails.
{const at=d=>run([{kind:"via",id:"V",net:"N",x:0,y:0,diameter:.6,drill:d,layer:"Multi"}]).issues.filter(i=>i.rule==="viaDrill").length;
 assert.equal(at(11.811*.0254),0,"Altium-rounded 0.3 mm hole passes");assert.equal(at(.299),1,"a real undersize hole still fails");}
const a=track("A","SIG",[[0,0],[3,0],[6,0]]);
const b=track("B","GND",[[1,.35],[5,.35]]);
let issues=clearance(run([a,b]));
assert.equal(issues.length,1,"one report per pair of tracks");
assert.ok(Math.abs(issues[0].actual-.15)<1e-9);
assert.equal(clearance(run([a,{...b,layer:"Bottom"}])).length,0);
assert.equal(clearance(run([a,{...b,net:"SIG"}])).length,0);
assert.equal(run([a,{...b,net:""}]).unassigned,1);
assert.equal(clearance(run([a,track("cross","GND",[[4,-3],[1,2]])]))[0].actual,0);
assert.equal(clearance(run([a,track("far","GND",[[0,.4],[4,.4]])])).length,0,"equality passes");
const overrides={...rules,nets:{GND:{clearance:.4,trackWidth:.27}}};
issues=run([a,b],overrides).issues;
assert.equal(issues.find(i=>i.rule==="trackWidth").source,"GND override");
assert.equal(issues.find(i=>i.rule==="clearance").required,.4);
assert.equal(issues.find(i=>i.rule==="clearance").source,"GND override");
const hole=via("V","VDD",2,.52);
issues=run([a,hole]).issues;
assert.equal(issues.filter(i=>i.rule==="viaDrill").length,1);
assert.ok(Math.abs(issues.find(i=>i.rule==="clearance").actual-.12)<1e-9);
assert.equal(clearance(run([a,{...hole,fromLayer:"Inner 1",toLayer:"Bottom"}])).length,0);
const f={id:"F",footprint:{shapes:[],pads:[{kind:"pad",x:1,y:0,w:1,h:.5,angle:90,number:"1",shape:"rect"}]}};
const component={kind:"part",ref:"Q1",def:"F",id:"P",angle:90,x:5,y:6,pinNets:{"1":"GND"}};
const library=new Map([["F",f]]);
issues=clearance(run([component,track("T","VDD",[[4,7.5],[6,7.5]])],rules,library));
assert.equal(issues.length,1,"rotated footprint/pad positions honored");
assert.ok(Math.abs(issues[0].actual-.15)<1e-9);
assert.ok([issues[0].id,issues[0].otherId].includes("P"),"issue locates parent footprint");
assert.equal(clearance(run([{...component,layer:"Bottom"},a],rules,library)).length,0);

// ---- Version 2 rule records, migration, scopes and the query API
require("../../app/checks/altium-rules.js");
const v2=R.migrate(rules);
assert.equal(v2.version,2);assert.deepEqual(R.validate(JSON.parse(JSON.stringify(v2))),v2);
assert.deepEqual(v2.defaults,rules.defaults,"version 2 keeps a version 1 summary");
assert.deepEqual(R.migrate(v2),v2,"migration is idempotent");
assert.deepEqual(R.create(),v2);
assert.ok(R.categories.every(c=>Object.values(R.types).some(t=>t.category===c)));
const legacy=R.migrate(overrides);
assert.deepEqual(legacy.list.filter(r=>r.type==="clearance").map(r=>[r.name,r.gap]),[["Clearance_GND",.4],["Clearance",.2]]);
assert.deepEqual(legacy.list.filter(r=>r.type==="width").map(r=>[r.name,r.scope.source,r.min]),[["Width_GND",'object where net.name = "GND"',.27],["Width","object",.15]]);
const strip=out=>out.issues.map(i=>[i.rule,i.id,i.otherId,i.actual,i.required]);
assert.deepEqual(strip(run([a,b,hole],legacy)),strip(run([a,b,hole],overrides)),"version 2 checks match version 1");
assert.equal(run([a,b],legacy).issues.find(i=>i.rule==="trackWidth").source,"Width_GND");
const lower=R.migrate({...rules,nets:{GND:{clearance:.1}}});
assert.equal(clearance(run([a,b],lower))[0].required,.2,"a smaller net clearance never undercuts the board default, as in version 1");
// Invalid version 2 data is rejected with a reason.
const edited=f=>{const c=JSON.parse(JSON.stringify(v2));f(c);return c;};
for(const bad of [
  edited(c=>c.list[0].type="spacing"), edited(c=>c.list[1].name=c.list[0].name), edited(c=>c.list.find(r=>r.type==="width").max=.01),
  edited(c=>c.list[0].scope={kind:"net"}), edited(c=>c.list[0].gap=-1), edited(c=>c.list[0].extra=1), edited(c=>c.version=3),
  edited(c=>c.diffPairs=[{name:"A",positive:"X",negative:"Y"},{name:"B",positive:"X",negative:"Z"}]), edited(c=>c.netClasses={Power:"VDD"}),
  edited(c=>c.list.find(r=>r.type==="routingCorners").style="30"), edited(c=>c.list.find(r=>r.type==="routingPriority").value=101),
  edited(c=>c.list.find(r=>r.type==="diffPairsRouting").layers={Top:{gapMin:.5}})
])assert.throws(()=>R.validate(bad));
// Priority, two-object clearance scopes and net classes.
const set=edited(c=>{
  c.netClasses={Power:["VDD","GND"]};
  c.list.unshift({id:"x1",type:"clearance",name:"PowerToSig",comment:"",enabled:true,priority:1,scope:scope("netclass","Power"),scope2:scope("net","SIG"),gap:.5});
  c.list.unshift({id:"x2",type:"width",name:"PowerWidth",comment:"",enabled:true,priority:1,scope:scope("netclass","Power"),min:.3,preferred:.4,max:.5});
});
R.validate(set);
issues=run([a,b,track("C","CLK",[[0,-.35],[6,-.35]])],set).issues;
assert.equal(issues.find(i=>i.rule==="clearance"&&i.id==="A"&&[i.id,i.otherId].includes("B")).required,.5,"InNetClass(Power) to InNet(SIG)");
assert.equal(issues.find(i=>i.rule==="clearance"&&[i.id,i.otherId].includes("C")).required,.2,"other pairs keep the default");
assert.equal(issues.find(i=>i.rule==="trackWidth"&&i.id==="B").required,.3);
assert.equal(R.query({rules:set},"width",{net:"GND"}).ruleName,"PowerWidth");
assert.equal(R.query({rules:set},"width",{net:"SIG"}).ruleName,"Width");
assert.equal(R.query({rules:set},"clearance",{net:"SIG",net2:"VDD"}).gap,.5);
assert.equal(R.query({rules:set},"clearance",{net:"SIG",net2:"CLK"}).gap,.2);
assert.equal(R.query({},"fanoutControl",{package:"bga"}).ruleName,"Fanout_BGA");
assert.equal(R.query({},"fanoutControl",{}).ruleName,"Fanout_Default");
assert.equal(R.query({},"length",{net:"SIG"}),null,"no length rules by default");
assert.deepEqual(R.netClasses({rules:set}),{Power:["VDD","GND"]});
// Differential pairs: detection, per-layer constraints, classes and matched groups.
const nets=["USB_DP","USB_DN","CLK+","CLK-","LVDS_P","LVDS_N","RXP","RXN","VDD","SDA_P"];
assert.deepEqual(R.detectDiffPairs(nets).map(p=>[p.name,p.positive,p.negative]),[["CLK","CLK+","CLK-"],["LVDS","LVDS_P","LVDS_N"],["RX","RXP","RXN"],["USB","USB_DP","USB_DN"]]);
assert.deepEqual(R.detectDiffPairs(nets,[{name:"USB",positive:"USB_DP",negative:"USB_DN"}]).map(p=>p.name),["CLK","LVDS","RX"]);
const hs=edited(c=>{
  c.diffPairs=[{name:"USB",positive:"USB_DP",negative:"USB_DN"},{name:"CLK",positive:"CLK+",negative:"CLK-"}];
  c.diffPairClasses={Fast:["USB"]};c.netClasses={Bus:["D0","D1","D2"]};
  const dp=c.list.find(r=>r.type==="diffPairsRouting");dp.layers={Bottom:{widthMin:.12,gapMin:.2,gapMax:.4}};
  c.list.push({id:"m1",type:"matchedLengths",name:"BusMatch",comment:"",enabled:true,priority:1,scope:scope("netclass","Bus"),tolerance:.5,withinPair:false,pairTolerance:.1});
  c.list.push({id:"m2",type:"matchedLengths",name:"FastMatch",comment:"",enabled:true,priority:2,scope:scope("diffpairclass","Fast"),tolerance:1,withinPair:true,pairTolerance:.1});
});
R.validate(hs);
assert.equal(R.query({rules:hs},"diffPairsRouting",{pairName:"USB",layer:"Top"}).gapMin,.1);
const bottom=R.query({rules:hs},"diffPairsRouting",{pairName:"USB",layer:"Bottom"});
assert.deepEqual([bottom.widthMin,bottom.gapMin,bottom.gapMax,bottom.widthMax],[.12,.2,.4,.3],"layer rows override the rule values");
assert.deepEqual(R.diffPairs({rules:hs}).map(p=>[p.name,p.classes]),[["USB",["Fast"]],["CLK",[]]]);
const groups=R.matchedGroups({items:[],rules:hs});
assert.deepEqual(groups.map(g=>[g.ruleName,g.nets,g.pairs.map(p=>p.name)]),[["BusMatch",["D0","D1","D2"],[]],["FastMatch",["USB_DN","USB_DP"],["USB"]]]);
// Units: mm and mil display and entry.
const U=R.units;
assert.equal(U.parse("10mil"),.254);assert.equal(U.parse("10","mil"),.254);assert.equal(U.parse("0.2"),.2);assert.equal(U.parse("0.2mm","mil"),.2);assert.ok(Number.isNaN(U.parse("ten")));
assert.equal(U.format(.254,"mil"),"10 mil");assert.equal(U.format(.2,"mm",true),"0.2mm");
// Mask and paste expansion for fabrication outputs.
const maskBoard={rules:edited(c=>{c.list.unshift({id:"s2",type:"solderMask",name:"TightGND",comment:"",enabled:true,priority:1,scope:scope("net","GND"),expansion:.05});
  c.list.unshift({id:"p2",type:"pasteMask",name:"BottomPaste",comment:"",enabled:true,priority:1,scope:scope("layer","Bottom"),expansion:-.02});})};
assert.equal(R.expansion({},"solder",{kind:"pad",net:"X",layer:"Top"}),.1016);
assert.equal(R.expansion({},"paste",{kind:"pad",layer:"Top"}),0);
assert.equal(R.expansion(maskBoard,"solder",{kind:"pad",net:"GND",layer:"Top"}),.05);
assert.equal(R.expansion(maskBoard,"solder",{kind:"pad",number:"1",layer:"Top"},{parent:{pinNets:{"1":"GND"}}}),.05,"footprint pads take the part's pin net");
assert.equal(R.expansion(maskBoard,"paste",{kind:"pad",layer:"Bottom"}),-.02);
assert.equal(R.expansion(maskBoard,"paste",{kind:"pad"},{parent:{layer:"Bottom"}}),-.02,"pads inherit the component side");
assert.equal(R.expansion(maskBoard,"paste",{kind:"pad",layer:"Top"}),0);
assert.equal(R.expansion(maskBoard,"solder",{kind:"pad",net:"GND",maskExpansion:.2}),.2,"per-pad overrides win");
assert.equal(R.expansion({},"solder",{kind:"pad"},{project:{rules:maskBoard.rules},parent:{pinNets:{}}}),.1016);
assert.throws(()=>R.expansion({},"silk",{}));
// Altium source records convert to rule records.
const width=R.fromAltium("RULEKIND=Width|NAME=Power|ENABLED=TRUE|SCOPE1EXPRESSION=InNetClass('Power')|SCOPE2EXPRESSION=All|MINLIMIT=10mil|MAXLIMIT=40mil|PREFEREDWIDTH=20mil|PRIORITY=2");
assert.deepEqual([width.rule.type,width.rule.scope,width.rule.min,width.rule.preferred,width.rule.max,width.priority],["width",scope("netclass","Power"),.254,.508,1.016,2]);
const gapRule=R.fromAltium("RULEKIND=Clearance|NAME=HV|ENABLED=FALSE|NETSCOPE=DifferentNets|SCOPE1EXPRESSION=InNet('HV')|SCOPE2EXPRESSION=OnLayer('Bottom Layer')|GAP=1mm").rule;
assert.deepEqual([gapRule.enabled,gapRule.scope2,gapRule.gap],[false,scope("layer","Bottom"),1]);
assert.equal(R.fromAltium("RULEKIND=SolderMaskExpansion|NAME=M|ENABLED=TRUE|SCOPE1EXPRESSION=All|EXPANSION=-2mil").rule.expansion,-.0508);
assert.equal(R.fromAltium("RULEKIND=Width|NAME=Q|ENABLED=TRUE|SCOPE1EXPRESSION=IsPad and InNet('A')|MINLIMIT=10mil").rule.scope.source,
  'object where (kind = "pad" and net.name = "A")');
assert.match(R.fromAltium("RULEKIND=Testpoint|NAME=T|ENABLED=TRUE|SCOPE1EXPRESSION=All").reason,/no Testpoint/);
assert.equal(R.describe(v2.list[0],"mil"),"Clearance Constraint (Minimum clearance=7.874mil) (All),(All)");
console.log("PASS rule format, limits, net precedence, routing intersections, precise gaps, layer span, via drill, grouped segments and rotated pads");
console.log("PASS version 2 rule records, migration, scopes, priorities, net classes, differential pairs, query API, units, mask expansion and Altium conversion");
// Impedance profile link and rigid-flex rule types.
{
  const set=R.create(),w=set.list.find(r=>r.type==="width");
  assert.ok(!("impedanceProfile" in w),"unset profile links are not stored");
  assert.ok(R.categories.includes("Rigid-Flex"));
  w.impedanceProfile="USB 90";R.validate(JSON.parse(JSON.stringify(R.normalize(set))));
  w.impedanceProfile=" bad";assert.throws(()=>R.validate(set),/impedance profile/);
  w.impedanceProfile=null;
  const bend=set.list.find(r=>r.type==="bendRadius");bend.static2=0;assert.throws(()=>R.validate(set),/whole number/);bend.static2=10;
  assert.match(R.describe(set.list.find(r=>r.type==="flexVias")),/^Flex Via Keepout Constraint \(Allow vias in flex regions=No Keepout from bend zones=1mm\) \(All\)$/);
  // Without the stack-up module a profile link falls back to the rule's own values.
  w.impedanceProfile="se50";assert.equal(R.resolver({kind:"pcb",items:[]},{rules:set})("width",{net:"A",layer:"Top"}).min,.15);
  console.log("PASS impedance profile links and rigid-flex rule types");
}
