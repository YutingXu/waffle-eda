"use strict";
// Shared electrical bench for the journal and browser paths. The public import is separate.
module.exports = function calculatorDesign() {
  function def(id,category,names) {
    return {id,name:category,category,prefix:category[0],symbol:{shapes:[{kind:"path",points:[[-2,-2],[2,-2],[2,2],[-2,2],[-2,-2]]}],
      pins:names.map((name,i)=>({number:String(i+1),name,x:i*5-5,y:0}))}};
  }
  const library = [def("reg","Voltage regulator",["VIN","VOUT","FB","GND"]),def("res","Resistor",["1","2"]),def("cap","Capacitor",["1","2"])];
  const p = Atrium.project("Calculator bench",library), [s,b] = p.documents;
  s.id = "sheet"; b.id = "board"; p.units = "mil";
  const fixtures = [
    ["U9","reg","",["IN","OUT_LOCAL","SENSE_X","RETURN_LOCAL"]],
    ["R90","res","30k",["SENSE_X","OUT_LOCAL"]], ["R3","res","10K",["RETURN_LOCAL","SENSE_X"]],
    ["R5","res","2k2",["IN","FILTER_X"]], ["C7","cap","22nF",["FILTER_X","GND"]],
    ["R75","res","33k",["INPUT_2","FALSE_FB"]], ["R76","res","2k",["FALSE_FB","RETURN_LOCAL"]]
  ];
  fixtures.forEach(([ref,kind,value,nets],i) => {
    const d = library.find(d=>d.id===kind), part = {id:ref,kind:"part",ref,def:kind,value,x:20+i%4*30,y:20+Math.floor(i/4)*30,angle:0,pinNets:{}};
    if (ref === "U9") part.parameters = {Vref:"800 mV"};
    s.items.push(part);
    Atrium.pins(part,d,"schematic").forEach((pin,n)=>s.items.push({id:ref+"-pin-"+n,kind:"netlabel",text:nets[n],x:pin.at[0],y:pin.at[1]}));
  });
  s.items.push({id:"clk-label",kind:"netlabel",text:"CLOCK",x:140,y:45});
  s.items.push({id:"profile-label",kind:"netlabel",text:"FROM_DIRECTIVE",x:160,y:45,impedance:{profile:"clock50"}});
  b.stackup = AtriumStackup.preset(4);
  b.stackup.impedanceProfiles = [
    {id:"clock50",name:"Clock 50",type:"single",target:50,tolerance:10,layers:{Top:{enabled:true,width:.22}}},
    {id:"data90",name:"Data 90",type:"diff",target:90,tolerance:10,layers:{Top:{enabled:true,gap:.18,width:.24}}}
  ];
  const rules = AtriumRules.create();
  const width = rules.list.find(r=>r.type==="width");
  Object.assign(width,{scope:{kind:"net",value:"CLOCK"},impedanceProfile:"clock50"});
  Object.assign(rules.list.find(r=>r.type==="diffPairsRouting"),{id:"pair-rule",type:"diffPairsRouting",name:"Data routing",comment:"",enabled:true,priority:1,scope:{kind:"diffpair",value:"DATA"},
    widthMin:.1,widthPreferred:.2,widthMax:.8,gapMin:.12,gapPreferred:.18,gapMax:.3,maxUncoupled:3,layers:{},impedanceProfile:"data90"});
  AtriumRules.store(b,p,rules);
  p.signals = {version:1,signals:[{id:"data",name:"DATA",kind:"diff",legs:[{polarity:1,nets:["D_P"]},{polarity:-1,nets:["D_N"]}]}],tags:[{name:"Fast",impedance:{profile:"clock50"}}],nets:{FROM_TAG:{tags:["Fast"]}}};
  b.outline = [[0,0],[100,0],[100,65],[0,65]];
  for (const [id,net,y,width] of [["clock","CLOCK",10,.11],["positive","D_P",18,.17],["negative","D_N",18.35,.17],["spare","SPARE",30,.32]]) {
    b.items.push({id,kind:"track",net,layer:"Top",width,points:[[10,y],[75,y]]});
  }
  b.items.push({id:"via",kind:"via",net:"SPARE",x:75,y:30,diameter:.6,drill:.27,fromLayer:"Top",toLayer:"Inner 1"});
  return p;
};
