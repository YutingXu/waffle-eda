"use strict";

const assert = require("node:assert/strict");
for (const name of ["model","parts","sch-objects","hierarchy","design-query-record","calculation-intent",
  "calculation-core","query-fields","design-query-parser","design-query-context","design-query-index",
  "design-query","altium-rules","rules","project-rules","erc","rule-lint"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const R = AtriumRules, L = AtriumRuleLint, S = AtriumDesignQueryRecord;
const all = S.selector("all"), net = name => S.selector("net",name), scope = source => S.create(source);
const width = (id, scope, priority, extra = {}) => ({id,type:"width",name:id,scope,priority,enabled:true,...extra});
const rules = (list, extra = {}) => ({...R.create(),list,...extra});
const lint = (list, options, extra) => L.analyze(rules(list,extra),options).hints;
const kinds = (hints, id) => hints.filter(hint => hint.rule === id).map(hint => hint.kind);
const proof = source => kinds(lint([width("A",scope(source),1)]),"A");

assert.deepEqual(proof('object where net.name = "VDD" and net.name = "GND"'),["impossible"]);
const exactText = 'object where comment = "0" and comment = "00"';
const exactPlan = R.kit.compile(rules([width("text",scope(exactText),1)]),{doc:null,explicit:true}).byType.width[0].scopePlan;
assert.equal(exactPlan.test({kind:"track",comment:0}),null,"a number cannot satisfy two different declared text comparisons");
assert.deepEqual(proof(exactText),["impossible"]);
assert.deepEqual(proof("track where width < 1 cm and width >= 10 mm"),["impossible"]);
assert.deepEqual(proof("track where width = 0.2 mm and width > 0.4 mm"),["impossible"]);
assert.deepEqual(proof("track where width <= 1 mm and width > 1 mm"),["impossible"]);
assert.deepEqual(proof("track where width <= 1 mm and width >= 1 mm"),[]);
assert.deepEqual(proof("track where width <= 1 mm and width >= 1.0000000000005 mm"),[],
  "the native quantity tolerance can overlap two inclusive bounds");
assert.deepEqual(proof("track where width = 1 mm and width != 1 mm"),["impossible"]);
assert.deepEqual(proof("object where false"),["impossible"]);
assert.deepEqual(proof('object on layer "Top" on layer "Bottom"'),[],"spanning copper can match both layers");
assert.deepEqual(lint([width("A",net("vdd"),1),width("B",net("VDD"),2)]),[],
  "different native scopes must not collapse into the same legacy kind");
assert.deepEqual(kinds(lint([width("A",net("VDD"),1),width("B",net("VDD"),2)]),"B"),["shadow"]);
assert.deepEqual(lint([width("A",all,1,{enabled:false}),width("B",all,2)]),[]);
assert.deepEqual(lint([width("A",all,1,{set:"X"}),width("B",all,2)],{}, {ruleSets:[{name:"X",enabled:false}]}),[]);
const incompleteNegation = scope('object where not (net.name = "A" and net.name = "B")');
assert.deepEqual(lint([width("A",incompleteNegation,1),width("B",all,2)]),[],
  "a negated predicate can remain unknown on a subject with no net");
const cover = lint([width("A",net("A"),1),width("B",net("B"),2),
  width("AB",scope('object where net.name = "A" or net.name = "B"'),3)]);
assert.deepEqual(cover.map(h => [h.kind,h.rule,h.related]),[["shadow","AB",["A","B"]]]);
assert.deepEqual(lint([width("Narrow",net("VIN"),1),width("Broad",all,2),width("Later",all,3)])
  .map(h => [h.rule,h.related]),[["Later",["Broad"]]]);
const pair = (id, a, b, p) => ({...width(id,a,p),type:"clearance",scope2:b});
assert.deepEqual(kinds(lint([pair("AB",net("A"),net("B"),1),pair("BA",net("B"),net("A"),2)]),"BA"),["shadow"]);
assert.deepEqual(lint([pair("AB",net("A"),net("B"),1),pair("AC",net("A"),net("C"),2)]),[]);
assert.deepEqual(lint([pair("AB",net("A"),{languageVersion:2,source:"object"},1),pair("BA",net("B"),net("A"),2)]),[],
  "an unsupported second side cannot prove a symmetric shadow");
const fan = (id, pack, p) => ({...width(id,all,p),type:"fanoutControl",package:pack});
assert.deepEqual(lint([fan("A","bga",1),fan("B","default",2)]),[]);
assert.deepEqual(kinds(lint([fan("A","default",1),fan("B","bga",2)]),"B"),["shadow"]);
assert.deepEqual(lint([width("A",all,1,{boards:["one"]}),width("B",all,2,{boards:["two"]})]),[],
  "a proof without a board cannot union different owners");

const project = AtriumParts.example(), template = project.documents.find(doc => doc.kind === "pcb");
const defs = new Map(project.library.map(def => [def.id,def]));
const track = {id:"trace-lint",kind:"track",layer:"Top",width:.3,points:[[0,0],[1,0]],net:"VIN"};
const via = {id:"via-lint",kind:"via",x:6,y:6,diameter:.6,drill:.3,net:"VIN"};
const board = {...template,items:[track,via]};
const options = {board,project,defs};
const widthScope = source => width("x",scope(source),1);
const spanning = rules([widthScope('object on layer "Top" on layer "Bottom"')]);
const [spanningRule] = R.kit.compile(spanning,{doc:board,project,defs,explicit:true}).byType.width;
assert.equal(spanningRule.scopePlan.test({...via,layer:"Multi",span:[0,127]}),true);
assert.ok(!kinds(L.analyze(spanning,options).hints,"x").includes("impossible"));
assert.deepEqual(kinds(lint([widthScope('track where net.name = "MISSING"')],options,
  {netClasses:{Spare:["MISSING"]}}),"x"),["empty"],"a class member with no actual instance is not a match");
assert.deepEqual(lint([widthScope('track where comment = "Missing"')],options),[],
  "unknown optional data does not prove exact emptiness");
assert.deepEqual(lint([widthScope('track where not (comment = "Missing")')],options),[]);
assert.deepEqual(kinds(lint([widthScope('track where comment = "Missing" and net.name = "MISSING"')],options),"x"),
  ["empty"],"the effective plan's determinate false can dominate an unknown");
assert.deepEqual(lint([widthScope('track where unknown_field = "VIN"')],options),[],
  "a diagnostic is not an empty set");
assert.deepEqual(lint([widthScope("track where width < rule(MinWidth)")],options),[],
  "a cyclic rule has no effective scope");
assert.deepEqual(lint([widthScope('pad near origin of "Missing component" within 2 mm')],options),[],
  "an unresolved geometry anchor cannot certify emptiness");
assert.deepEqual(lint([width("later",{languageVersion:2,source:"track"},1)],options),[]);
const scopedClass = S.selector("netclass","Power");
assert.deepEqual(lint([width("C",scopedClass,1),width("V",net("VIN"),2)],options,{netClasses:{Power:["VIN"]}}),[],
  "opaque membership alone is not a universal priority proof");

assert.deepEqual(kinds(lint([width("x",all,1,{min:.4,max:.2})]),"x"),["limits"]);
const vr = (id, min, priority, selector = net("VIN")) => ({...width(id,selector,priority),type:"viaStyle",holeMin:min});
const hole = {...width("Hole",net("VIN"),1),type:"holeSize",max:.25};
assert.deepEqual(kinds(lint([vr("Via",.4,1),hole],options),"Via"),["limits"]);
assert.deepEqual(kinds(lint([vr("Via",.4,2),vr("First",.15,1),hole],options),"Via"),["shadow"],
  "only the winner's limits apply");
assert.deepEqual(kinds(lint([vr("Via",.4,2),vr("Unknown",.15,1,scope('object where comment = "Override"')),hole],options),"Via"),[],
  "an earlier unknown applicability cannot certify the joint limit");
assert.deepEqual(kinds(lint([vr("Via",.4,2),vr("Invalid",.15,1,scope('object where unmapped_field = "Override"')),hole],options),"Via"),[],
  "an earlier compile diagnostic cannot certify a fallback winner");
const pairBoard = {...board,items:[{...track,net:"D+"}]};
const dp = {...width("pair-width",all,1),type:"diffPairsRouting",widthMin:.1,widthMax:.4,layers:{Top:{widthMax:.2}}};
const narrow = lint([width("Trace",all,1,{min:.3}),dp],{board:pairBoard,defs},{diffPairs:[{name:"D",positive:"D+",negative:"D-"}]});
assert.deepEqual(narrow.map(h => [h.kind,h.rule,h.related]),[["limits","Trace",["pair-width"]]]);

const erc = (id, source, sheets) => ({id,type:"ercFloatingInputs",name:id,scope:source,sheets,priority:1,enabled:true,severity:"error"});
const schematic = project.documents.find(doc => doc.kind === "schematic");
const schematicRules = [
  erc("impossible-erc",scope('object where net.name = "VDD" and net.name = "VIN"'),[schematic.id]),
  erc("unknown-erc",scope('object where unknown_field = "VIN"'),[schematic.id]),
  erc("ineligible-erc",scope("object where false"),["not-a-sheet"])
];
assert.deepEqual(lint(schematicRules,options).map(h => [h.kind,h.rule]),[["impossible","impossible-erc"]],
  "ERC proofs use the applicable sheet plans and never enumerate generic board features");

const alternatives = key => "(" + Array.from({length:11},(_,n) => key + ' = "' + n + '"').join(" or ") + ")";
const branching = rules([widthScope("object where " + alternatives("net.name") + " and " + alternatives("component.designator"))]);
assert.equal(R.kit.compile(branching,{doc:null,explicit:true}).byType.width.length,1);
assert.deepEqual(L.analyze(branching),{hints:[],limited:true},"an exhausted proof search is unknown");

// Check universal hints against the effective typed point matcher, including
// unknown fields, case, kind narrowing and native tolerance-adjacent values.
const terms = ['net.name = "VIN"','net.name = "GND"',"width < 1 mm","width <= 1 mm","width > 1 mm",
  "width >= 1 mm","width = 1 mm","width != 1 mm","width <= 1.0000000000005 mm"];
const probes = [];
for (const name of [undefined,"VIN","vin","GND","OTHER"]) {
  for (const value of [undefined,.5,1-1e-12,1-5e-13,1,1+5e-13,1+1e-12,1.01]) {
    for (const kind of ["track","via"]) probes.push({net:name,width:value,kind});
  }
}
for (let i = 0; i < terms.length; i++) for (let j = 0; j < terms.length; j++) {
  const a = scope("track where " + terms[i] + " and not (" + terms[j] + ")");
  const b = scope("track where " + terms[j] + " or " + terms[(i+j)%terms.length]);
  const set = rules([width("a",a,1),width("b",b,2)]);
  const [ma,mb] = R.kit.compile(set,{doc:null,explicit:true}).byType.width.map(r => r.scopePlan.test);
  for (const hint of L.analyze(set).hints) {
    if (hint.kind === "impossible") assert.ok(!probes.some(o => (hint.rule === "a" ? ma : mb)(o) === true),hint.explanation);
    if (hint.kind === "shadow") assert.ok(!probes.some(o => mb(o) === true && ma(o) !== true),hint.explanation);
  }
}
console.log("rule-lint ok");
