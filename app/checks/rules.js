"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("../pcb/land-contours.js");
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("../pcb/resolved-geometry-curves.js");
// Design rules for PCB layouts: the stored rule set, the rule engine shared by
// the Rules and Constraints Editor, the Design Rule Check panel (drc.js) and the
// MCP board runner, a query API for routers and exporters, and the editor dialog.
//
// Rule set format (a board's view of the project rule book, project-rules.js; .waffle-rules files), always in millimetres:
//   version 2  {format:"atrium-rules", version:2, units:"mm",
//               list:[{id,type,name,comment,enabled,priority,scope,scope2?,...constraints}],
//               netClasses?:{Class:[net,...]},
//               diffPairs?:[{name,positive,negative}], diffPairClasses?:{Class:[pairName,...]},
//               netCurrents?:{NET:amps}, classCurrents?:{Class:amps},
//               defaults:{clearance?,trackWidth?,viaDrill?}, nets:{NET:{...}}}
//   Width and Differential Pairs Routing rules may name an impedance profile
//   (impedanceProfile, stored only when set): the stack-up profile then gives
//   the per-layer min/preferred/max width and gap (AtriumStackup.profileValues).
//   version 1  {format:"atrium-rules", version:1, units:"mm", defaults:{clearance,trackWidth,viaDrill}, nets:{...}}
// Version 1 still validates, checks and imports exactly as before. It becomes
// version 2 when the editor applies it. In version 2, `defaults` and `nets` are
// a derived summary of the highest-priority All and InNet minimums, written for
// older readers of the file; `list` is authoritative.
//
// Priority: 1 is highest. For each object the first enabled rule of a type whose
// scope matches applies. Two-object rules (Clearance, Short-Circuit) apply when
// one object matches the first scope and the other matches the second.
globalThis.AtriumRules = (() => {
  // EPS: 10 nm. Altium stores lengths in 1/10000 mil, so an imported 0.3 mm hole is 0.2999994 mm; size limits must not fail on that rounding.
  // Maximum route bounds can span the signed Altium coordinate range (1/10000 mil).
  const A=globalThis.Atrium, EPS=1e-5, MIL=.0254, MAX_LENGTH=1000, MAX_ALTIUM_LENGTH=5454.609, DEFAULT_SOLDER=.1016;
  const plain=o=>o!==null && typeof o==="object" && !Array.isArray(o);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const cmp=(a,b)=>a<b?-1:a>b?1:0;
  const fail=message=>{throw Error(message);};
  const now=()=>globalThis.performance?.now?performance.now():Date.now();
  function setOwn(o,k,v){Object.defineProperty(o,k,{value:v,enumerable:true,writable:true,configurable:true});return v;}
  const newId=()=>globalThis.Atrium.id();

  // ---------------------------------------------------------------- units
  const unitOf=u=>u==="mil"?"mil":"mm";
  const TO_MM={mm:1,mil:MIL,mils:MIL,th:MIL,thou:MIL,in:25.4,inch:25.4,inches:25.4,um:.001,"µm":.001,"μm":.001,cm:10};
  // Bare numbers are read in `unit`; an explicit suffix wins. Returns mm or NaN.
  function parseLength(text,unit="mm"){
    const m=/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(mm|mils?|thou|th|inch(?:es)?|in|um|µm|μm|cm)?$/i.exec(String(text??"").trim());
    if(!m)return NaN;
    const n=Number(m[1])*TO_MM[(m[2]||unitOf(unit)).toLowerCase()];
    return Number.isFinite(n)?Math.round(n*1e6)/1e6+0:NaN;
  }
  function lengthValue(mm,unit){const u=unitOf(unit);return Number((u==="mil"?mm/MIL:mm).toFixed(u==="mil"?3:4))+0;}
  function formatLength(mm,unit,compact){
    if(mm==null||!Number.isFinite(mm))return "—";
    return lengthValue(mm,unit)+(compact?"":" ")+unitOf(unit);
  }

  // ---------------------------------------------------------------- version 1
  const specs=[
    {key:"clearance",title:"Copper clearance",description:"Edge-to-edge gap between different named nets on overlapping copper layers."},
    {key:"trackWidth",title:"Track width",description:"Minimum width of each routed copper track."},
    {key:"viaDrill",title:"Via drill",description:"Minimum drill diameter of each via."}
  ];
  const defaults=()=>({format:"atrium-rules",version:1,units:"mm",defaults:{clearance:.20,trackWidth:.15,viaDrill:.30},nets:{}});
  const permitted=new Set(specs.map(s=>s.key));
  function checkGroup(group,all) {
    if(!plain(group)||Object.keys(group).some(k=>!permitted.has(k)))throw Error("The rules contain an unknown or malformed minimum.");
    for(const {key,title} of specs) {
      if(!own(group,key)&&!all)continue;
      const v=group[key];
      if(typeof v!=="number"||!Number.isFinite(v)||v<=0||v>MAX_LENGTH)throw Error(title+" must be greater than zero and at most 1000 mm.");
    }
  }
  function checkNets(nets){
    if(!plain(nets))throw Error("Net overrides must be a mapping of net names to minimums.");
    for(const [name,group] of Object.entries(nets)) {
      if(!name.trim()||name!==name.trim()||name.length>512)throw Error("Each override needs a valid net name.");
      checkGroup(group,false);
    }
  }
  function validateV1(rules){
    if(Object.keys(rules).some(k=>!["format","version","units","defaults","nets"].includes(k)))throw Error("This file contains unsupported rule settings.");
    checkGroup(rules.defaults,true);checkNets(rules.nets);
    return rules;
  }

  // ---------------------------------------------------------------- rule types
  const L=(key,label,def,extra)=>({key,label,kind:"length",def,...extra});
  const C=(key,label,options,def)=>({key,label,kind:"choice",options,def});
  const TOPOLOGY=[["shortest","Shortest"],["horizontal","Horizontal"],["vertical","Vertical"],["daisyChainSimple","Daisy-Simple"],["daisyChainMidDriven","Daisy-MidDriven"],["daisyChainBalanced","Daisy-Balanced"],["starburst","Starburst"],["flyBy","Fly-by"],["tBranch","T-branch"]];
  // hs-topology: topologies the DRC checks (topology.js); the others steer the ratsnest and routers only.
  const TOPO_CHECKED=new Set(["daisyChainSimple","daisyChainMidDriven","daisyChainBalanced","starburst","flyBy","tBranch"]);
  const CORNERS=[["45","45 degrees"],["90","90 degrees"],["rounded","Rounded"]];
  const PACKAGES=[["default","Default (any component)"],["bga","BGA"],["lcc","LCC"],["soic","SOIC"],["small","Small components"]];
  const FANOUT_STYLE=[["auto","Auto"],["inline","Inline rows"],["staggeredIn","Staggered in"],["staggeredOut","Staggered out"],["underPads","Under pads"]];
  const FANOUT_DIRECTION=[["disable","Disable"],["in","In only"],["out","Out only"],["inThenOut","In then out"],["outThenIn","Out then in"],["alternating","Alternating in and out"]];
  const VIA_PLACEMENT=[["close","Close to pad (follow rules)"],["centered","Centered between pads"]];
  const WIDTH_LAYER_VALUES={widthMin:"min",widthPreferred:"preferred",widthMax:"max"};
  const WIDTH_LAYER_KEYS=Object.keys(WIDTH_LAYER_VALUES);
  const PAIR_KEYS=[...WIDTH_LAYER_KEYS,"gapMin","gapPreferred","gapMax"];
  // Polygon Connect Style. "polygon" defers to each polygon's own Connect Style;
  // "auto" is the smart per-pad choice made by AtriumPolygonPour.
  const CONNECT=[["auto","Auto (smart)"],["relief","Relief Connect"],["direct","Direct Connect"],["none","No Connect"],["polygon","As set on the polygon"]];
  const CONNECT_KINDS=[["th","Through-hole pads"],["smd","SMD pads"],["via","Vias"]];
  const CONNECT_KEYS=["style","conductorWidth","entries","angle","airGap"];
  // Clearance object-kind matrix, as Altium's Clearance rule: an optional sparse map of
  // "kindA-kindB" (kinds in this order, A not after B) to a gap in mm. A missing cell, or
  // no matrix at all (the default "single value for all" mode), uses the rule's gap.
  // Hole cells are checked only where set: a plated hole lies inside its own pad copper.
  const CLEAR_KINDS=[["track","Track"],["arc","Arc"],["smd","SMD Pad"],["th","TH Pad"],["via","Via"],["fill","Fill"],["poly","Polygon"],["region","Region"],["text","Text"],["hole","Hole"]];
  const CK_INDEX=new Map(CLEAR_KINDS.map(([k],i)=>[k,i]));
  const clearKey=(a,b)=>CK_INDEX.get(a)<=CK_INDEX.get(b)?a+"-"+b:b+"-"+a;
  const CLEAR_PAIRS=[];for(let i=0;i<CLEAR_KINDS.length;i++)for(let j=i;j<CLEAR_KINDS.length;j++)if(!(CLEAR_KINDS[i][0]==="hole"&&CLEAR_KINDS[j][0]==="hole"))CLEAR_PAIRS.push(CLEAR_KINDS[i][0]+"-"+CLEAR_KINDS[j][0]);
  const CLEAR_PAIR_SET=new Set(CLEAR_PAIRS);
  // Gap between two object kinds under a clearance rule.
  const clearanceGap=(r,a,b)=>{const m=r.objects;if(m&&a&&b){const k=clearKey(a,b);if(own(m,k))return m[k];}return r.gap;};
  // A drilled hole has a design clearance only when the winning rule names its matrix cell.
  function clearanceLimit(r,a,b){
    if(!r)return null;
    if(a==="hole"||b==="hole"){
      const k=clearKey(a,b);
      return r.objects&&own(r.objects,k)?r.objects[k]:null;
    }
    return clearanceGap(r,a,b);
  }
  // Largest gap a rule can ask for (broad-phase reach).
  const clearanceMax=r=>{let g=r.gap;if(r.objects)for(const k in r.objects)if(r.objects[k]>g)g=r.objects[k];return g;};
  // Gap for copper that routing tools place (tracks, arcs and vias) against any copper
  // except polygons (repoured around new copper) and holes: the largest such cell.
  const ROUTED=new Set(["track","arc","via"]);
  function clearanceRoute(r){
    if(!r.objects)return r.gap;let g=-Infinity;
    for(const k of CLEAR_PAIRS){const [a,b]=k.split("-");if(!(ROUTED.has(a)||ROUTED.has(b))||a==="poly"||b==="poly"||a==="hole"||b==="hole")continue;const v=own(r.objects,k)?r.objects[k]:r.gap;if(v>g)g=v;}
    return g;
  }
  // Impedance profile link: omitted from the stored rule when not set.
  const PROFILE=(types)=>({key:"impedanceProfile",label:"Impedance profile",kind:"profile",def:null,optional:true,omitNull:true,profileTypes:types});
  // One neck-down concept: how far a track may run narrower than its rule (or profile window) at each end, into a pad.
  // Blank: the impedance profile's neck.maxLength, else NECK_DEFAULT (neckLength()). Read by routers and the checks.
  const NECK_DEFAULT=2.5,NECK=L("neckLength","Neck-down length per end",null,{optional:true,omitNull:true});
  const I=(key,label,def,min=1,max=500)=>({key,label,kind:"integer",min,max,def});
  const B=(key,label,def)=>({key,label,kind:"bool",def});
  const TYPES={
    clearance:{category:"Electrical",title:"Clearance",altium:"Clearance",two:true,
      help:"Minimum edge-to-edge gap between copper objects of different nets on a shared copper layer. The object-kind matrix sets a different gap for each pair of object kinds (track, SMD pad, via, hole and so on); cells left empty use the minimum clearance.",
      fields:[L("gap","Minimum clearance",.2),{...B("ignoreFootprintPadPairs","Ignore pad-to-pad clearance within a footprint",false),optional:true,omitNull:true,def:null},{key:"objects",label:"Object clearances",kind:"clearanceMatrix",def:null,optional:true,omitNull:true}]},
    // Z-axis clearance (z-clearance.js): rigid-flex and HDI copper across the dielectric.
    zClearance:{category:"Electrical",title:"Z-Axis Clearance",altium:"ZAxisClearance",
      help:"Minimum 3D distance between copper of different nets on two copper layers, through the dielectric of the layer stack: hypot(lateral gap, dielectric thickness). For rigid-flex and HDI stacks with thin dielectrics. Checks tracks, SMD pads and copper regions (vias and through-hole pads span their layers and are covered by Clearance); with Include polygon pours, also poured copper against other nets' copper on the other layer. View → Z-Axis Clearance Overlay shows the violations.",
      fields:[L("gap","Minimum Z-axis clearance",.1),B("adjacentOnly","Adjacent copper layers only",true),{...B("pours","Include polygon pours",false),optional:true,omitNull:true}]},
    short:{category:"Electrical",title:"Short-Circuit",altium:"ShortCircuit",two:true,
      help:"Reports copper that joins different nets. Uses the board connectivity graph.",fields:[{key:"allowed",label:"Allow short circuit",kind:"bool",def:false}]},
    // Current capacity (ipc2152.js): IPC-2152 current of tracks, pads (necks) and via barrels against an allowed temperature rise.
    currentCapacity:{category:"Electrical",title:"Current Capacity",altium:"CurrentCapacity",help:"Each track segment, pad and via barrel of the nets in scope must carry the net's current within the allowed temperature rise: IPC-2152 (universal chart with copper-weight, board-thickness, plane and conductivity modifiers from the stack-up), the Brooks & Adam fit, or IPC-2221 for comparison. The current is the rule's own, else Net currents or Class currents; or the PDN Analyzer's analysed current per object (Tools › PDN Analyzer). Vias use the plated barrel cross-section. Each conductor is treated as isolated: Tools › Thermal › Temperature Rise Map shows the board as a whole.",
      fields:[{key:"current",label:"Required current (A, 0 = Net or Class currents)",kind:"amps",def:0},I("maxRise","Allowed temperature rise (°C)",10,1,100),C("method","Method",[["ipc2152","IPC-2152 chart + modifiers"],["brooksAdam","IPC-2152 (Brooks & Adam fit)"],["ipc2221","IPC-2221 (legacy)"]],"ipc2152"),
        C("source","Current",[["rule","Required current"],["pdn","PDN Analyzer currents"],["both","Larger of the two"]],"rule"),B("checkVias","Check via barrels",true),B("checkPads","Check pads (necks)",true),I("plating","Via plating (µm)",25,5,100)]},
    // Creepage and clearance by working voltage (creepage.js): IEC 62368-1, IEC 60664-1 or IPC-2221B tables.
    creepage:{category:"Electrical",title:"Creepage Distance",altium:"CreepageByVoltage",two:true,
      help:"Copper of nets at different working voltages keeps the clearance and creepage the standard asks for them. Voltages are the ones you confirmed: a tag with a Voltage parameter or a voltage name (400V, Mains), or a signal confirmed as a rail; grounds count as 0 V, and nets without a confirmed voltage as 0 V unless set otherwise. Mains is reinforced from other circuits, basic to mains and to earth; other circuits from the check voltage are functional, at basic values. Creepage is the surface path: the straight gap unless a board cutout at least the groove width wide lies in the way. Inner layers have no clearance requirement and use pollution degree 1. Voltages known only from names, power ports and connectors are Design Insights instead.",
      fields:[C("standard","Standard",[["iec62368","IEC 62368-1"],["iec60664","IEC 60664-1"],["ipc2221b","IPC-2221B"]],"iec62368"),C("pollution","Pollution degree",[[1,"1"],[2,"2"],[3,"3"]],2),
        C("material","Material group",[["I","I (CTI 600 and above)"],["II","II (CTI 400 to 600)"],["IIIa","IIIa (CTI 175 to 400)"],["IIIb","IIIb (CTI 100 to 175)"]],"IIIb"),
        C("overvoltage","Overvoltage category",[["I","I"],["II","II"],["III","III"],["IV","IV"]],"II"),C("mainsInsulation","Mains to other circuits",[["reinforced","Reinforced"],["basic","Basic"]],"reinforced"),
        C("functional","Other circuits",[["basic","Basic insulation values"],["off","Not checked"]],"basic"),B("detectMains","Detect mains nets",true),
        I("mainsVoltage","Mains voltage when not named (V RMS)",250,1,1000),I("threshold","Check from (V)",30,1,1000),
        C("ipcClass","IPC-2221B external conductors",[["B2","B2 uncoated, up to 3050 m"],["B3","B3 uncoated, over 3050 m"],["B4","B4 permanent polymer coating"],["A5","A5 conformal coating"]],"B2"),
        C("unknown","Nets without a confirmed voltage",[["zero","Checked at 0 V"],["skip","Not checked"]],"zero")]},
    supplyNets:{category:"Signal Integrity",title:"Supply Nets",altium:"SupplyNets",help:"Supply voltage used by Signal Integrity for the nets in scope.",
      fields:[{key:"voltage",label:"Supply voltage (V)",kind:"volts",def:0}]},
    modifiedPolygon:{category:"Electrical",title:"Modified Polygon",altium:"UnpouredPolygon",help:"Checks whether polygons are shelved or require a repour. The batch check uses each polygon's stored fill and dependencies.",
      fields:[B("allowModified","Allow modified polygons",false),B("allowShelved","Allow shelved polygons",false)]},
    fabricationTestpoint:{category:"Manufacturing",title:"Fabrication Testpoint Style",altium:"FabricationTestpoint",help:"Checks assigned fabrication probes on the selected board sides. Circular land diameters and drill sizes use the board geometry. Preferred sizes describe the intended probe geometry.",
      fields:[L("minSize","Minimum diameter",0),L("preferredSize","Preferred diameter",null,{optional:true,info:true}),L("maxSize","Maximum diameter",null,{optional:true}),
        L("minHole","Minimum drill",0),L("preferredHole","Preferred drill",null,{optional:true,info:true}),L("maxHole","Maximum drill",null,{optional:true}),
        B("allowTop","Allow top-side probes",true),B("allowBottom","Allow bottom-side probes",true)],ranges:[["minSize","maxSize"],["minHole","maxHole"]]},
    componentHeight:{category:"Placement",title:"Height",altium:"Height",help:"Checks a component's authored 3D body or component height from the board surface. Preferred height is the display fallback for components without an authored height.",
      fields:[L("min","Minimum height",0),L("preferred","Preferred height",null,{optional:true,info:true}),L("max","Maximum height",null,{optional:true,upper:MAX_ALTIUM_LENGTH})],ranges:[["min","preferred","max"]]},
    unrouted:{category:"Electrical",title:"Un-Routed Net",altium:"UnRoutedNet",
      help:"Reports connections of a net that copper does not join yet.",fields:[]},
    width:{category:"Routing",title:"Width",altium:"Width",help:"Track width limits. The preferred width is used by routing tools and is not checked. With an impedance profile, each layer's min, preferred and max width come from the profile and its tolerance.",
      fields:[PROFILE(["single","cpw"]),L("min","Min width",.15),L("preferred","Preferred width",null,{optional:true,info:true}),L("max","Max width",null,{optional:true,upper:MAX_ALTIUM_LENGTH}),NECK,{key:"layers",label:"Per-layer values",kind:"layerTable",keys:WIDTH_LAYER_KEYS,def:null,optional:true,omitNull:true}],ranges:[["min","preferred","max"]]},
    routingTopology:{category:"Routing",title:"Routing Topology",altium:"RoutingTopology",help:"Connection pattern of the net. Shortest, Horizontal and Vertical steer the ratsnest and routers only. Daisy chains, Fly-by, T-branch and Starburst are checked on the routed copper (topology.js): stubs off the trunk up to the max stub length, the load order (Design › Constraint Manager › Topology sets a custom order and the source), and T-branch / Starburst arms balanced within the branch tolerance.",
      fields:[C("topology","Topology",TOPOLOGY,"shortest"),L("maxStub","Max stub length",null,{optional:true,omitNull:true}),L("branchTolerance","Branch length tolerance",null,{optional:true,omitNull:true})]},
    routingPriority:{category:"Routing",title:"Routing Priority",altium:"RoutingPriority",help:"Order in which automatic routing handles nets. 100 is routed first.",
      fields:[{key:"value",label:"Routing priority",kind:"integer",min:0,max:100,def:0}]},
    routingLayers:{category:"Routing",title:"Routing Layers",altium:"RoutingLayers",help:"Copper layers that tracks of matching nets may use.",
      fields:[{key:"excluded",label:"Allowed layers",kind:"layers",def:[]}]},
    routingCorners:{category:"Routing",title:"Routing Corners",altium:"RoutingCorners",help:"Corner style and setback used by routing tools. Stored only.",
      fields:[C("style","Style",CORNERS,"45"),L("setbackMin","Min setback",2.54),L("setbackMax","Max setback",2.54)],ranges:[["setbackMin","setbackMax"]]},
    viaStyle:{category:"Routing",title:"Routing Via Style",altium:"RoutingVias",help:"Via diameter and hole limits. Preferred values are used when placing vias.",
      fields:[L("diameterMin","Min via diameter",null,{optional:true}),L("diameterPreferred","Preferred via diameter",null,{optional:true,info:true}),L("diameterMax","Max via diameter",null,{optional:true}),
        L("holeMin","Min via hole",.3,{optional:true}),L("holePreferred","Preferred via hole",null,{optional:true,info:true}),L("holeMax","Max via hole",null,{optional:true})],
      ranges:[["diameterMin","diameterPreferred","diameterMax"],["holeMin","holePreferred","holeMax"]]},
    fanoutControl:{category:"Routing",title:"Fanout Control",altium:"FanoutControl",help:"Fanout style for surface-mount pads, chosen by component package. Stored for fanout tools.",
      fields:[C("package","Package",PACKAGES,"default"),C("style","Fanout style",FANOUT_STYLE,"auto"),C("direction","Fanout direction",FANOUT_DIRECTION,"alternating"),C("viaPlacement","Via placement (BGA)",VIA_PLACEMENT,"close")]},
    diffPairsRouting:{category:"Routing",title:"Differential Pairs Routing",altium:"DiffPairsRouting",help:"Width and gap of differential pair tracks and the longest uncoupled run. Layer rows override the rule values. With an impedance profile, width and gap per layer come from the profile and its tolerance.",
      fields:[PROFILE(["diff","cpw-diff"]),L("widthMin","Min width",.1),L("widthPreferred","Preferred width",.15,{optional:true,info:true}),L("widthMax","Max width",.3,{optional:true,upper:MAX_ALTIUM_LENGTH}),
        L("gapMin","Min gap",.1),L("gapPreferred","Preferred gap",.15,{optional:true,info:true}),L("gapMax","Max gap",.3),
        L("maxUncoupled","Max uncoupled length",6.35,{optional:true}),NECK,{key:"layers",label:"Per-layer values",kind:"layerTable",keys:PAIR_KEYS,def:{}}],
      ranges:[["widthMin","widthPreferred","widthMax"],["gapMin","gapPreferred","gapMax"]]},
    solderMask:{category:"Mask",title:"Solder Mask Expansion",altium:"SolderMaskExpansion",help:"Mask opening growth beyond each pad edge. Negative values shrink the opening.",
      fields:[L("expansion","Expansion",DEFAULT_SOLDER,{signed:true}),{...B("tentTop","Tent top",false),optional:true,omitNull:true,def:null},{...B("tentBottom","Tent bottom",false),optional:true,omitNull:true,def:null}]},
    pasteMask:{category:"Mask",title:"Paste Mask Expansion",altium:"PasteMaskExpansion",help:"Paste stencil opening growth beyond each pad edge. Negative values shrink the opening.",
      fields:[L("expansion","Expansion",0,{signed:true})]},
    polygonConnect:{category:"Plane",title:"Polygon Connect Style",altium:"PolygonConnect",
      help:"How a polygon pour joins pads and vias of its own net. Relief adds thermal spokes across an air gap; Direct pours over the pad; No Connect clears it. Auto (smart) decides per pad: vias, exposed pads and power or high-current pads connect directly; small passives (0201–0805) and through-hole pads get reliefs whose spokes are sized for the net current. As set on the polygon uses each polygon's Connect Style. Rows for through-hole pads, SMD pads and vias override the rule values.",
      fields:[C("style","Connect style",CONNECT,"polygon"),L("conductorWidth","Conductor width",.254),C("entries","Conductors",[[2,"2"],[4,"4"]],4),C("angle","Angle",[[90,"90°"],[45,"45°"]],90),
        L("airGap","Air gap",.254),{key:"minEntries",label:"Minimum connected spokes",kind:"integer",min:0,max:4,def:2},
        L("powerWidth","Auto: power net at preferred width",.5),{key:"tempRise",label:"Auto: temperature rise (°C)",kind:"integer",min:1,max:100,def:10},
        {key:"kinds",label:"Per object kind",kind:"connectTable",def:{}}]},
    annularRing:{category:"Manufacturing",title:"Minimum Annular Ring",altium:"MinimumAnnularRing",help:"Copper remaining around plated holes in vias and pads.",fields:[L("min","Minimum annular ring",.1)]},
    holeSize:{category:"Manufacturing",title:"Hole Size",altium:"HoleSize",help:"Drill diameter limits for vias and pads.",
      fields:[L("min","Min hole size",.025),L("max","Max hole size",6.35,{optional:true})],ranges:[["min","max"]]},
    holeToHole:{category:"Manufacturing",title:"Hole To Hole Clearance",altium:"HoleToHoleClearance",help:"Edge-to-edge gap between drilled holes, whatever their nets.",fields:[L("gap","Hole to hole clearance",.254),{...B("allowStackedMicrovias","Allow stacked microvias",true),optional:true,omitNull:true,def:null}]},
    // hdi-rules: drill pairs and HDI vias (viastack.js AtriumViaStack.hdi.drc; Design › HDI Via Setup…).
    layerPairs:{category:"Manufacturing",title:"Layer Pairs",altium:"LayerPairs",help:"Via spans must be drill pairs of the layer stack (Layer Stack Manager › Via Types) and, with an HDI build-up, spans its lamination sequence can drill.",fields:[B("enforce","Enforce layer pairs settings",true)]},
    hdiVias:{category:"Manufacturing",title:"HDI Vias",altium:"HDIVias",help:"Aspect ratio of mechanical and laser vias from the layer stack, stacked microvia count, staggered microvia pitch, skip and controlled-depth vias, and via-in-pad filling (IPC-4761 Type V–VII).",
      fields:[C("maxAspect","Max aspect ratio",[[6,"6:1"],[8,"8:1"],[10,"10:1"],[12,"12:1"],[15,"15:1"],[20,"20:1"]],10),C("microviaAspect","Max microvia aspect ratio",[[.5,"0.5:1"],[.6,"0.6:1"],[.75,"0.75:1"],[.8,"0.8:1"],[1,"1:1"],[1.2,"1.2:1"]],1),
        I("maxStacked","Max stacked microvias",2,1,12),L("minStagger","Min staggered microvia pitch",.25),B("requireFill","Via-in-pad must be filled (IPC-4761 V–VII)",true),B("allowSkip","Allow skip vias",true),B("allowDepth","Allow controlled-depth blind vias",false)]},
    boardOutlineClearance:{category:"Manufacturing",title:"Board Outline Clearance",altium:"BoardOutlineClearance",
      help:"Gap to the board edge, including cutouts. Objects outside the board or inside a cutout measure 0. Checks copper by default. Altium board outline rules can also include overlay ink.",
      fields:[L("gap","Board outline clearance",.25),{...B("includeOverlay","Include overlay ink",false),optional:true,omitNull:true,def:null}]},
    silkToMask:{category:"Manufacturing",title:"Silk To Solder Mask Clearance",altium:"SilkToSolderMaskClearance",help:"Gap from printed overlay artwork to either the pad mask opening or the exposed pad copper on the same side.",fields:[L("gap","Silk to mask clearance",.1),{...B("exposedCopper","Measure to exposed copper",false),optional:true,omitNull:true,def:null}]},
    silkToSilk:{category:"Manufacturing",title:"Silk To Silk Clearance",altium:"SilkToSilkClearance",help:"Gap between overlay lines of different components. Overlay text is not checked.",fields:[L("gap","Silk to silk clearance",.1)]},
    length:{category:"High Speed",title:"Length",altium:"Length",help:"Routed length of each net: track lengths plus via heights when the board thickness is known.",
      fields:[L("min","Min length",0),L("max","Max length",100,{optional:true,upper:MAX_ALTIUM_LENGTH})],ranges:[["min","max"]]},
    matchedLengths:{category:"High Speed",title:"Matched Lengths",altium:"MatchedLengths",help:"Nets in scope must be within the tolerance of the longest net in the group. Scope it to a net class or differential pair class.",
      fields:[L("tolerance","Tolerance",.254),{key:"withinPair",label:"Check pairs within the pair (intra-pair skew)",kind:"bool",def:false},L("pairTolerance","Intra-pair tolerance",.127)]},
    returnPathVia:{category:"High Speed",title:"Return Path Vias",altium:"ReturnPathVias",two:true,
      help:"Signal vias (first scope) that change reference planes need a via of a reference net (second scope; All means the ground nets) within the distance. Tools → Stitching → Return Path Vias adds the missing ones.",
      fields:[L("distance","Max distance to a return via",1)]},
    delay:{category:"High Speed",title:"Propagation Delay",altium:"PropagationDelay",help:"Propagation delay of each net in picoseconds, from the layer stack: per-layer effective dielectric constant for tracks, vias as barrel plus pad capacitance (timing-vision.js). Allegro Propagation Delay.",
      fields:[{key:"min",label:"Min delay (ps)",kind:"ps",def:0},{key:"max",label:"Max delay (ps)",kind:"ps",def:null,optional:true}],ranges:[["min","max"]]},
    matchedDelays:{category:"High Speed",title:"Matched Delays",altium:"MatchedDelays",help:"Nets in scope must arrive within the tolerance (ps) of the slowest net in the group; pairs within the pair tolerance of each other (phase). Allegro Relative Propagation Delay.",
      fields:[{key:"tolerance",label:"Tolerance (ps)",kind:"ps",def:5},{key:"withinPair",label:"Check pairs within the pair (phase skew)",kind:"bool",def:false},{key:"pairTolerance",label:"Intra-pair tolerance (ps)",kind:"ps",def:1}]},
    // hs-rules: Parallel Segment (parallel-segment.js) and Return Path (return-path.js).
    parallelSegment:{category:"High Speed",title:"Parallel Segment",altium:"ParallelSegment",two:true,help:"Crosstalk screening: track segments of different nets (first and second scope) that run parallel closer than the parallel gap may do so for at most the parallel limit. Same layer, or broadside on adjacent copper layers. Per segment pair, or summed per net pair. Not a simulation: Tools › Signal Integrity estimates the coupled noise.",
      fields:[L("gap","Parallel gap",.25),L("limit","Parallel limit",5),C("layers","Layer checking",[["same","Same layer"],["adjacent","Adjacent layers"],["both","Same and adjacent layers"]],"same"),B("accumulate","Sum per net pair",false)]},
    returnPath:{category:"High Speed",title:"Return Path",altium:"ReturnPath",help:"Reference plane continuity under high-speed tracks, from the layer stack and the copper on the reference layers (si.js): voids and gaps under the track, crossings of a plane split, and layer changes whose references differ without a stitching via (same reference net) or stitching capacitor (different nets) nearby. Each violation suggests a fix.",
      fields:[B("voids","Voids under the track",true),B("splits","Plane split crossings",true),B("layerChange","Layer changes need stitching",true),L("distance","Max distance to a stitching via",1),L("capDistance","Max distance to a stitching capacitor",5),L("minVoid","Ignore voids shorter than",.1)]},
    viaStub:{category:"High Speed",title:"Max Via Stub Length",altium:"MaxViaStubLength",help:"Unused via barrel beyond the first or last copper layer the via connects to, from the layer stack (Tools → Via Stub Report). Back-drilled vias count their remaining stub.",fields:[L("max","Max stub length",.25)]},
    dfaSpacing:{category:"Placement",title:"DFA Spacing",altium:"DFASpacing",help:"Design for assembly: the gap between two components by package type pair (0402–0402, BGA–any …), body to body or courtyard to courtyard. Parts on opposite sides are not checked unless one is through-hole or Sides is Both. Edit the matrix in Design → Constraint Manager → DFA (dfa.js).",
      fields:[{key:"matrix",label:"Package spacing matrix",kind:"dfaMatrix",types:["0201","0402","0603","0805","1206","melf","sod","sot","soic","qfp","qfn","bga","tht","connector","other"],def:[{a:"0201",b:"0201",gap:.15},{a:"0402",b:"0402",gap:.2},{a:"0603",b:"0603",gap:.25},{a:"0805",b:"0805",gap:.3},{a:"0402",b:"0603",gap:.25},{a:"soic",b:"any",gap:.4},{a:"qfp",b:"any",gap:.5},{a:"qfn",b:"any",gap:.5},{a:"bga",b:"any",gap:1},{a:"tht",b:"any",gap:.8},{a:"connector",b:"any",gap:1}]},L("defaultGap","Default gap",.25),C("measure","Measure",[["body","Body to body"],["courtyard","Courtyard to courtyard"]],"body"),C("sides","Sides",[["same","Same side (through-hole: both)"],["both","Both sides"]],"same")]},
    // Component clearance (collision-3d.js): 3D bodies, flat and in the rigid-flex fold.
    componentClearance:{category:"Placement",title:"Component Clearance",altium:"ComponentClearance",two:true,help:"Gap between component 3D bodies: generated bodies (body or courtyard outline at the part height) and embedded STEP models (their bounding box). Two bodies violate when they are closer than the horizontal clearance and closer than the vertical clearance. On rigid-flex boards the check also runs fully folded, including bodies against the folded board. The 3D view shows collisions (View › Collisions).",
      fields:[L("gap","Minimum horizontal clearance",.254),L("vertical","Vertical clearance",.254,{upper:MAX_ALTIUM_LENGTH}),C("mode","Check mode",[["bodies","3D bodies"],["boxes","Bounding boxes"],["authored","Authored Altium body geometry"]],"bodies"),{...B("skipMissingBody","Exclude components without a 3D body",false),optional:true,omitNull:true,def:null},C("fold","Rigid-flex fold state",[["both","Flat and folded"],["flat","Flat"],["folded","Folded"]],"both"),B("board","Bodies against the folded board",true)]},
    // Rigid-flex (rigid-flex.js). Checked only on boards with regions or substacks.
    flexLayers:{category:"Rigid-Flex",title:"Region Layer Availability",altium:"RegionLayers",help:"Copper, vias and pads on a copper layer that the board region's substack does not have.",fields:[]},
    flexVias:{category:"Rigid-Flex",title:"Flex Via Keepout",altium:"FlexViaKeepout",help:"Vias and plated holes inside flex regions, and closer than the keepout to a bend zone.",
      fields:[B("allowInFlex","Allow vias in flex regions",false),L("bendKeepout","Keepout from bend zones",1)]},
    bendKeepout:{category:"Rigid-Flex",title:"Bend Zone Components",altium:"BendZoneKeepout",help:"Pads and components inside a bend zone or within the keepout of it.",fields:[L("keepout","Keepout",.5)]},
    bendCrossing:{category:"Rigid-Flex",title:"Bend Line Crossing",altium:"BendLineCrossing",help:"Tracks must cross bend lines perpendicular within the tolerance. Corners at or above the corner angle in flex regions are reported as warnings: prefer curved routing.",
      fields:[I("tolerance","Perpendicular tolerance (°)",10,0,89),I("cornerAngle","Warn on corners from (°, 0 = off)",30,0,180)]},
    bendRadius:{category:"Rigid-Flex",title:"Minimum Bend Radius",altium:"MinimumBendRadius",help:"IPC-2223 (Rev. C/D guideline table) bend ratio: bend radius at least N times the finished flex thickness, by copper layer count and static or dynamic flexing. Dynamic defaults 100x/150x/200x; dynamic multilayer flex is not recommended.",
      fields:[I("static1","Static, 1 layer (×)",6),I("static2","Static, 2 layers (×)",10),I("staticMulti","Static, 3+ layers (×)",15),I("dynamic1","Dynamic, 1 layer (×)",100),I("dynamic2","Dynamic, 2 layers (×)",150),I("dynamicMulti","Dynamic, 3+ layers (×)",200)]},
    flexCopper:{category:"Rigid-Flex",title:"Flex Copper Hatching",altium:"FlexCopperHatching",help:"Warns about solid polygon pours and plane layers in flex regions. Use the Hatched pour style there.",fields:[B("requireHatch","Require hatched copper in flex",true)]},
    stiffener:{category:"Rigid-Flex",title:"Stiffener Placement",altium:"StiffenerPlacement",help:"Components on the same side as a stiffener, straddling a stiffener edge, or connectors and larger parts in flex without a stiffener behind them.",
      fields:[B("requireBacking","Require a stiffener behind connectors",true),I("minPads","…and parts with at least this many pads",6,1,10000)]},
    // Flex routing and construction (flex-drc.js).
    flexRouting:{category:"Rigid-Flex",title:"Flex Routing",altium:"FlexRouting",help:"Teardrops where tracks meet pads and vias in flex regions; tracks on different flex copper layers staggered rather than stacked (I-beam); no track ends or width changes inside bend zones.",
      fields:[B("requireTeardrops","Require teardrops in flex",true),B("staggerLayers","Warn on stacked traces (I-beam)",true),L("minStackRun","Stacked length allowed",.5),B("bendTermination","Warn on track ends in bend zones",true)]},
    flexBuild:{category:"Rigid-Flex",title:"Flex Construction",altium:"FlexConstruction",help:"Bend zones keep the transition distance from rigid regions and the gap from stiffeners, do not overlap, and cut across their flex region; coverlay webs between pad openings (pads grown by the coverlay expansion) are at least the minimum web.",
      fields:[L("transition","Bend zone to rigid region",1.5),L("stiffenerGap","Bend zone to stiffener",1),L("coverlayExpansion","Coverlay opening expansion",.1),L("minWeb","Minimum coverlay web",.25)]}
  };
  const RIGID_FLEX=new Set(["flexLayers","flexVias","bendKeepout","bendCrossing","bendRadius","flexCopper","stiffener","flexRouting","flexBuild"]);
  const ORDER=Object.keys(TYPES);
  // Rule types the design rule check enforces. The others are stored for routing, fanout and fabrication tools.
  const CHECKED=new Set(ORDER.filter(t=>!["routingTopology","routingPriority","routingCorners","fanoutControl","solderMask","pasteMask","supplyNets"].includes(t)));
  const CATEGORIES=["Electrical","Routing","Mask","Plane","Manufacturing","High Speed","Signal Integrity","Rigid-Flex","Placement"];
  const LEGACY=[["clearance","clearance","gap"],["width","trackWidth","min"],["viaStyle","viaDrill","holeMin"]];
  const SCOPE_KINDS=[["all","All"],["net","Net"],["netclass","Net class"],["diffpair","Differential pair"],["diffpairclass","Differential pair class"],["layer","Layer"],["component","Component"],["componentclass","Component class"],["signal","Signal"],["tag","Tag"]];
  const FANOUT_DEFAULTS=[["Fanout_BGA","bga","auto","alternating","centered"],["Fanout_LCC","lcc","staggeredOut","alternating","close"],
    ["Fanout_SOIC","soic","inline","alternating","close"],["Fanout_Small","small","auto","outThenIn","close"],["Fanout_Default","default","auto","alternating","close"]];

  function make(type,name,props={}){
    const t=TYPES[type],r={id:props.id??newId(),type,name:name||t.altium,comment:"",enabled:true,priority:1,scope:globalThis.AtriumDesignQueryRecord.selector("all")};
    if(t.two)r.scope2=globalThis.AtriumDesignQueryRecord.selector("all");
    for(const f of t.fields)r[f.key]=Array.isArray(f.def)?[...f.def]:plain(f.def)?{...f.def}:f.def;
    return Object.assign(r,props);
  }
  // Rule types without rules here start empty, as in Altium.
  function standard(type){
    if(type==="fanoutControl")return FANOUT_DEFAULTS.map(([name,pkg,style,direction,via],i)=>make(type,name,{id:type+"-"+(i+1),priority:i+1,package:pkg,style,direction,viaPlacement:via}));
    if(type==="fabricationTestpoint"||type==="componentHeight"||type==="modifiedPolygon"||type==="supplyNets"||type==="parallelSegment"||type==="returnPath"||type==="length"||type==="matchedLengths"||type==="delay"||type==="matchedDelays"||type==="returnPathVia"||type==="boardOutlineClearance"||type==="viaStub"||type==="layerPairs"||type==="hdiVias"||type==="dfaSpacing"||type==="zClearance"||type==="componentClearance"||type==="currentCapacity"||type==="creepage")return [];
    return [make(type,null,{id:type+"-1"})];
  }

  // ---------------------------------------------------------------- version 2 validation
  const validName=(s,max=512)=>typeof s==="string" && !!s.trim() && s===s.trim() && s.length<=max;
  function validScope(s,options){
    const records=globalThis.AtriumDesignQueryRecord;
    return records.valid(s,options)||(options?.allowFuture&&records.isFuture(s));
  }
  function checkLength(f,v,where){
    if(v===null||v===undefined){if(f.optional)return;fail(where+" requires a value.");}
    if(typeof v!=="number"||!Number.isFinite(v))fail(where+" must be a number.");
    const upper=f.upper??MAX_LENGTH;
    if(f.signed?Math.abs(v)>100:(v<0||v>upper))fail(where+(f.signed?" must be between -100 and 100 mm.":" must be between 0 and "+upper+" mm."));
  }
  const layerValueKey=(type,key)=>type==="width"?WIDTH_LAYER_VALUES[key]:key;
  function checkRanges(r){
    const t=TYPES[r.type],label=k=>t.fields.find(f=>f.key===k)?.label||k;
    const check=(values,where)=>{for(const group of t.ranges||[]){let prev=null,prevKey=null;
      for(const k of group){const v=values[k];if(v==null)continue;
        if(prev!=null&&v+EPS<prev)fail(where+": "+label(k)+" must not be less than "+label(prevKey)+".");prev=v;prevKey=k;}}};
    check(r,r.name);
    // Layer rows are checked with inherited limits; an inherited preferred value is advisory only.
    if(r.type==="width"||r.type==="diffPairsRouting")for(const [layer,row] of Object.entries(r.layers||{})){
      const values={...r,preferred:null,widthPreferred:null,gapPreferred:null};
      for(const [key,value] of Object.entries(row))values[layerValueKey(r.type,key)]=value;
      check(values,r.name+" · "+layer);
    }
  }
  function checkField(f,v,where,type){
    if(f.kind==="ps"){if(v===null||v===undefined){if(f.optional)return;fail(where+" requires a value.");}if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>1e6)fail(where+" must be a delay from 0 to 1000000 ps.");return;}
    if(f.kind==="volts"){if(!Number.isFinite(v))fail(where+" requires a finite voltage.");return;}
    if(f.kind==="amps"){if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>1000)fail(where+" must be a current from 0 to 1000 A.");return;}
    if(f.kind==="length")return checkLength(f,v,where);
    if(f.kind==="bool"){if(v==null&&f.optional)return;if(typeof v!=="boolean")fail(where+" must be on or off.");return;}
    if(f.kind==="choice"){if(!f.options.some(([k])=>k===v))fail(where+" has an unknown value.");return;}
    if(f.kind==="integer"){if(!Number.isInteger(v)||v<f.min||v>f.max)fail(where+" must be a whole number from "+f.min+" to "+f.max+".");return;}
    if(f.kind==="profile"){if(v!=null&&!validName(v,128))fail(where+" must name an impedance profile.");return;}
    if(f.kind==="layers"){if(!Array.isArray(v)||v.length>64||v.some(x=>!validName(x,64))||new Set(v).size!==v.length)fail(where+" must list layer names.");return;}
    if(f.kind==="clearanceMatrix"){
      if(v==null)return;
      if(!plain(v)||Object.keys(v).length>CLEAR_PAIRS.length)fail(where+" must map object kind pairs to gaps.");
      for(const [k,g] of Object.entries(v)){
        if(!CLEAR_PAIR_SET.has(k))fail(where+" has an unknown object kind pair "+k+".");
        if(typeof g!=="number"||!Number.isFinite(g)||g<0||g>MAX_LENGTH)fail(where+" · "+k+" must be between 0 and 1000 mm.");
      }
      return;
    }
    if(f.kind==="dfaMatrix"){if(!Array.isArray(v)||v.length>400||v.some(e=>!plain(e)||Object.keys(e).some(k=>!["a","b","gap"].includes(k))||![e.a,e.b].every(t=>t==="any"||f.types.includes(t))||typeof e.gap!=="number"||!(e.gap>=0)||e.gap>100))fail(where+" must list package type pairs with a gap from 0 to 100 mm.");return;}
    if(f.kind==="connectTable"){
      if(!plain(v))fail(where+" must map object kinds to values.");
      const fields=TYPES.polygonConnect.fields;
      for(const [kind,row] of Object.entries(v)){
        if(!CONNECT_KINDS.some(([k])=>k===kind)||!plain(row)||Object.keys(row).some(k=>!CONNECT_KEYS.includes(k)))fail(where+" has an invalid row.");
        for(const k of Object.keys(row))checkField(fields.find(x=>x.key===k),row[k],where+" · "+kind);
      }
      return;
    }
    if(v==null&&f.optional)return;
    if(!plain(v)||Object.keys(v).length>64)fail(where+" must map layer names to values.");
    for(const [layer,row] of Object.entries(v)){
      if(!validName(layer,64)||!plain(row)||Object.keys(row).some(k=>!f.keys.includes(k)))fail(where+" has an invalid layer row.");
      for(const k of Object.keys(row))checkLength(TYPES[type].fields.find(f=>f.key===layerValueKey(type,k)),row[k],where+" · "+layer);
    }
  }
  function checkRule(r,ids,names,scopeOptions){
    if(!plain(r)||typeof r.type!=="string"||!own(TYPES,r.type))fail("A rule has an unknown type.");
    const t=TYPES[r.type],allowed=new Set(["id","type","name","comment","enabled","priority","scope","set","presetKey",...(t.two?["scope2"]:[]),...t.fields.map(f=>f.key)]);
    for(const k of Object.keys(r))if(!allowed.has(k))fail("A "+t.title+" rule contains the unsupported setting "+k+".");
    if(typeof r.id!=="string"||!r.id||r.id.length>128||ids.has(r.id))fail("Each rule needs a unique identifier.");ids.add(r.id);
    if(!validName(r.name,128))fail("Each rule needs a name of up to 128 characters without leading or trailing spaces.");
    const lower=r.name.toLowerCase();if(names.has(lower))fail("Rule names must be unique. "+r.name+" is used twice.");names.add(lower);
    if(r.comment!==undefined&&(typeof r.comment!=="string"||r.comment.length>4000))fail(r.name+" has an invalid comment.");
    if(r.presetKey!==undefined&&!validName(r.presetKey,256))fail(r.name+" has an invalid preset key.");
    if(typeof r.enabled!=="boolean")fail(r.name+" must be enabled or disabled.");
    if(!Number.isInteger(r.priority)||r.priority<1||r.priority>100000)fail(r.name+" needs a whole-number priority.");
    if(!validScope(r.scope,scopeOptions)||t.two&&!validScope(r.scope2,scopeOptions))fail(r.name+" has an invalid scope.");
    for(const f of t.fields)checkField(f,r[f.key],r.name+" · "+f.label,r.type);
    checkRanges(r);
  }
  function checkClasses(classes,what){
    if(!plain(classes)||Object.keys(classes).length>2000)fail(what+" must map class names to members.");
    for(const [name,members] of Object.entries(classes)){
      if(!validName(name,128))fail("Each "+what.toLowerCase().replace(/es$/,"")+" needs a name.");
      if(!Array.isArray(members)||members.length>100000||members.some(n=>!validName(n))||new Set(members).size!==members.length)fail(name+" must list distinct names.");
    }
  }
  // Board rule sets (rule-groups.js, format 1.3): rules.ruleSets=[{name,enabled,description?}], rule.set names one;
  // rules without a set are in the Default set. Disabled sets are skipped by compile() and DRC.
  const DEFAULT_RULE_SET="Default",ruleSetOf=r=>r?.set||DEFAULT_RULE_SET;
  function disabledRuleSets(set){const off=new Set();for(const s of set?.ruleSets||[])if(s.enabled===false)off.add(String(s.name).toLowerCase());return off;}
  function ruleActive(set,r,off=disabledRuleSets(set)){return !!r.enabled&&!off.has(ruleSetOf(r).toLowerCase());}
  function checkRuleSets(rules){
    const sets=rules.ruleSets??[];if(!Array.isArray(sets)||sets.length>200)fail("Rule sets must be a list of up to 200.");
    const names=new Set();
    for(const s of sets){
      if(!plain(s)||Object.keys(s).some(k=>!["name","enabled","description"].includes(k))||!validName(s.name,128)||typeof s.enabled!=="boolean"||s.description!==undefined&&(typeof s.description!=="string"||s.description.length>4000))fail("Each rule set needs a name and an enabled state.");
      const k=s.name.toLowerCase();if(names.has(k))fail("Rule set names must be unique. "+s.name+" is used twice.");names.add(k);
    }
    for(const r of rules.list)if(r.set!==undefined&&(!validName(r.set,128)||!names.has(r.set.toLowerCase())&&r.set.toLowerCase()!=="default"))fail(r.name+" names the rule set "+r.set+", which the rules do not define.");
  }
  const V2_KEYS=["format","version","units","list","netClasses","diffPairs","diffPairClasses","netCurrents","classCurrents","defaults","nets","ruleSets"];
  function validateV2(rules,scopeOptions){
    if(Object.keys(rules).some(k=>!V2_KEYS.includes(k)))fail("This file contains unsupported rule settings.");
    if(!Array.isArray(rules.list)||rules.list.length>5000)fail("The rules file needs a list of rules.");
    const ids=new Set(),names=new Set();
    for(const r of rules.list)checkRule(r,ids,names,scopeOptions);
    if(rules.netClasses!==undefined)checkClasses(rules.netClasses,"Net classes");
    if(rules.diffPairs!==undefined){
      if(!Array.isArray(rules.diffPairs)||rules.diffPairs.length>20000)fail("Differential pairs must be a list.");
      const pairNames=new Set(),used=new Set();
      for(const p of rules.diffPairs){
        if(!plain(p)||Object.keys(p).some(k=>!["name","positive","negative"].includes(k))||!validName(p.name,128)||!validName(p.positive)||!validName(p.negative)||p.positive===p.negative)
          fail("Each differential pair needs a name and two different nets.");
        if(pairNames.has(p.name))fail("Differential pair names must be unique. "+p.name+" is used twice.");
        for(const n of [p.positive,p.negative]){if(used.has(n))fail("Net "+n+" belongs to more than one differential pair.");used.add(n);}
        pairNames.add(p.name);
      }
    }
    if(rules.diffPairClasses!==undefined)checkClasses(rules.diffPairClasses,"Differential pair classes");
    for(const key of ["netCurrents","classCurrents"])if(rules[key]!==undefined){
      if(!plain(rules[key])||Object.keys(rules[key]).length>100000)fail("Currents must map names to amperes.");
      for(const [name,a] of Object.entries(rules[key]))if(!validName(name)||typeof a!=="number"||!(a>0)||a>10000)fail("The current for "+name+" must be between 0 and 10000 A.");
    }
    if(rules.defaults!==undefined)checkGroup(rules.defaults,false);
    if(rules.nets!==undefined)checkNets(rules.nets);
    if(rules.ruleSets!==undefined||rules.list.some(r=>r.set!==undefined))checkRuleSets(rules);
    return rules;
  }
  // Forward compatibility (app/compat.js, docs/format-versioning.md). Only for rules in a file that claims a
  // newer minor format: AtriumCompat.upgrade calls this before validation. In place, it takes out what this
  // build can't read, so validation, the editor and DRC never see it, and returns what it took (or null) for
  // AtriumCompat.forSave to put back unchanged: unknown top-level settings {keys, order}; whole rules of an
  // unknown type, or that don't validate here once their unknown settings are taken out, as [index, rule];
  // unknown settings of the rules kept, by rule id {keys, order}; unknown keys of rule sets and differential
  // pairs, by name. In a file of this format or older, nothing is set aside: unknown data is still invalid.
  function setAside(rules){
    if(!plain(rules)||rules.format!=="atrium-rules"||rules.version!==2)return null;
    const rec=/** @type {any} */({}),split=(o,allowed)=>{const keys={};let n=0;for(const k of Object.keys(o))if(!allowed.has(k)){keys[k]=o[k];n++;}
      if(!n)return null;const order=Object.keys(o);for(const k in keys)delete o[k];return {keys,order};};
    const top=split(rules,new Set(V2_KEYS));if(top)Object.assign(rec,top);
    const entries=(/** @type {string} */key,/** @type {string[]} */allowed,/** @type {(e:any)=>string} */id)=>{
      if(!Array.isArray(rules[key]))return;const set=new Set(allowed);
      for(const e of rules[key]){if(!plain(e))continue;const x=split(e,set);if(x)((rec.entries||={})[key]||={})[id(e)]=x;}
    };
    entries("ruleSets",["name","enabled","description"],s=>String(s.name).toLowerCase());entries("diffPairs",["name","positive","negative"],p=>String(p.name));
    if(Array.isArray(rules.list)){
      const ids=new Set(),names=new Set(),kept=[];
      rules.list.forEach((r,i)=>{
        if(plain(r)&&typeof r.type==="string"&&own(TYPES,r.type)){
          const t=TYPES[r.type],copy={...r},x=split(copy,new Set(["id","type","name","comment","enabled","priority","scope","set","presetKey",...(t.two?["scope2"]:[]),...t.fields.map(f=>f.key)]));
          const i2=new Set(ids),n2=new Set(names);
          try{checkRule(copy,i2,n2);}catch{(rec.rules||=[]).push([i,r]);return;}
          i2.forEach(v=>ids.add(v));n2.forEach(v=>names.add(v));
          if(x){(rec.fields||={})[r.id]=x;for(const k in x.keys)delete r[k];}
          kept.push(r);
        }else (rec.rules||=[]).push([i,r]);
      });
      if(rec.rules)rules.list=kept;
    }
    return Object.keys(rec).length?rec:null;
  }
  function validate(rules,scopeOptions) {
    if(!plain(rules)||rules.format!=="atrium-rules"||rules.units!=="mm"||(rules.version!==1&&rules.version!==2))throw Error("Choose a Waffle rules file, version 1 or 2, in millimetres.");
    return rules.version===1?validateV1(rules):validateV2(rules,scopeOptions);
  }

  // ---------------------------------------------------------------- normalise and migrate
  function scopeCopy(scope){
    const records=globalThis.AtriumDesignQueryRecord;
    if(!plain(scope))fail("A design rule requires a native query scope.");
    // Temporary simple pickers supply structured selectors. The stored rule always owns a v1 source.
    if(own(scope,"languageVersion"))return records.copy(scope);
    if(scope.kind!=="query")return records.fromSelector(scope);
    // @ts-ignore: CommonJS loads the Filter adapter only for a transient Filter input.
    if(!globalThis.AtriumQueryExchange&&typeof require==="function")require("./query-exchange.js");
    const lowered=globalThis.AtriumQueryExchange?.fromClassic(scope.value);
    if(lowered?.ok)return lowered.scope;
    const diagnostic=lowered?.diagnostics?.[0];
    const error=Error(diagnostic?.message||"This filter expression could not be translated into a native rule scope.");
    if(diagnostic)Object.assign(error,{code:diagnostic.code,span:diagnostic.span});
    throw error;
  }
  function canonical(r){
    const t=TYPES[r.type],out={id:r.id,type:r.type,name:r.name,comment:r.comment||"",enabled:r.enabled,priority:r.priority,scope:scopeCopy(r.scope)};
    if(t.two)out.scope2=scopeCopy(r.scope2);
    if(r.set&&String(r.set).toLowerCase()!=="default")out.set=r.set;
    if(r.presetKey!==undefined)out.presetKey=r.presetKey;
    for(const f of t.fields){
      const v=r[f.key];
      if(f.omitNull&&v==null)continue;
      out[f.key]=v===undefined?(f.optional?null:Array.isArray(f.def)?[...f.def]:plain(f.def)?{...f.def}:f.def):Array.isArray(v)?[...v]:plain(v)?JSON.parse(JSON.stringify(v)):v;
    }
    if(r.label)Object.defineProperty(out,"label",{value:r.label,enumerable:false});
    return out;
  }
  function mirror(list){
    const summary={},nets={};
    for(const [type,key,field] of LEGACY){
      for(const r of list.filter(r=>r.type===type&&r.enabled).sort((a,b)=>a.priority-b.priority)){
        const v=r[field];
        const records=globalThis.AtriumDesignQueryRecord;
        if(typeof v!=="number"||!(v>0)||v>MAX_LENGTH||r.scope2&&!records.isAll(r.scope2))continue;
        const scope=records.toSelector(r.scope);
        if(scope?.kind==="all"){if(!own(summary,key))summary[key]=v;}
        else if(scope?.kind==="net"){const g=own(nets,scope.value)?nets[scope.value]:setOwn(nets,scope.value,{});if(!own(g,key))g[key]=v;}
      }
    }
    return {defaults:summary,nets};
  }
  const copyClasses=c=>{const out={};for(const [k,v] of Object.entries(c||{}))setOwn(out,k,[...v]);return out;};
  function normalize(set){
    const list=set.list.map((r,i)=>({r,i})).sort((a,b)=>ORDER.indexOf(a.r.type)-ORDER.indexOf(b.r.type)||a.r.priority-b.r.priority||a.i-b.i).map(x=>canonical(x.r));
    const counts={};for(const r of list)r.priority=counts[r.type]=(counts[r.type]||0)+1;
    const out={format:"atrium-rules",version:2,units:"mm",list};
    if(set.netClasses&&Object.keys(set.netClasses).length)out.netClasses=copyClasses(set.netClasses);
    if(set.diffPairs?.length)out.diffPairs=set.diffPairs.map(p=>({name:p.name,positive:p.positive,negative:p.negative}));
    if(set.diffPairClasses&&Object.keys(set.diffPairClasses).length)out.diffPairClasses=copyClasses(set.diffPairClasses);
    for(const key of ["netCurrents","classCurrents"])if(set[key]&&Object.keys(set[key]).length){out[key]={};for(const [k,v] of Object.entries(set[key]))setOwn(out[key],k,v);}
    if(set.ruleSets?.length||list.some(r=>r.set)){const rs=[],seen=new Map(),push=s=>{const k=String(s.name).toLowerCase();if(seen.has(k))return;const e={name:s.name,enabled:s.enabled!==false};if(s.description)e.description=s.description;seen.set(k,e);rs.push(e);};
      if(!(set.ruleSets||[]).some(s=>String(s.name).toLowerCase()==="default"))push({name:DEFAULT_RULE_SET,enabled:true});
      for(const s of set.ruleSets||[])push(s);for(const r of list)if(r.set){if(!seen.has(r.set.toLowerCase()))push({name:r.set,enabled:true});r.set=seen.get(r.set.toLowerCase()).name;}
      out.ruleSets=rs;}
    Object.assign(out,mirror(list));
    return out;
  }
  // Any valid rule set (or null) as a normalised version 2 set. Version 1 maps
  // exactly: clearance overrides are ordered by value so the larger of two
  // applicable minimums wins, as before; width and drill overrides precede
  // the board default.
  function migrate(input,labels){
    if(input==null)input=defaults();
    if(input.version!==1)return normalize(input);
    const d=input.defaults,nets=input.nets,list=[];
    const name=(net,base)=>labels?(net?net+" override":"Board default"):(net?base+"_"+net:base);
    const scope=net=>globalThis.AtriumDesignQueryRecord.selector(net?"net":"all",net);
    const overrides=key=>Object.keys(nets).filter(n=>own(nets[n],key)).sort(cmp).map(net=>({net,v:nets[net][key]}));
    const label=(r,net)=>{if(labels)r.label=name(net);return r;};
    [{net:"",v:d.clearance},...overrides("clearance")].sort((a,b)=>b.v-a.v||(a.net?0:1)-(b.net?0:1)||cmp(a.net,b.net))
      .forEach((e,i)=>list.push(label(make("clearance",name(e.net,"Clearance"),{id:"clearance-"+(i+1),priority:i+1,scope:scope(e.net),gap:e.v}),e.net)));
    [...overrides("trackWidth"),{net:"",v:d.trackWidth}].forEach((e,i)=>list.push(label(make("width",name(e.net,"Width"),{id:"width-"+(i+1),priority:i+1,scope:scope(e.net),min:e.v}),e.net)));
    [...overrides("viaDrill"),{net:"",v:d.viaDrill}].forEach((e,i)=>list.push(label(make("viaStyle",name(e.net,"RoutingVias"),{id:"viaStyle-"+(i+1),priority:i+1,scope:scope(e.net),holeMin:e.v}),e.net)));
    for(const type of ORDER)if(!LEGACY.some(([t])=>t===type))list.push(...standard(type));
    return normalize({list});
  }
  const create=()=>migrate(defaults());
  // Older presets used their template key as the saved ID.
  const presetRuleKey=r=>r.presetKey??(/^(?:fab|fp)-/.test(r.id)?r.id:undefined);
  // Plans may carry template keys as temporary IDs. Give new preset rules real
  // identities only when accepted, retaining IDs already used by this rule list.
  function materializePresetRules(set,previous){
    const known=new Set(previous?.list.map(r=>r.id));
    return {...set,list:set.list.map(r=>r.presetKey&&!known.has(r.id)?{...r,id:newId()}:r)};
  }
  // The neck-down length per end (mm) for a resolved Width or Differential Pairs Routing rule: its own, else its
  // impedance profile's neck.maxLength (stackup.js), else NECK_DEFAULT.
  function neckLength(board,rule){
    if(rule?.neckLength>0)return rule.neckLength;
    if(rule?.impedanceProfile&&board){try{const p=(globalThis.AtriumStackup?.impedanceProfiles?.(board)||[]).find(x=>x.id===rule.impedanceProfile||x.name===rule.impedanceProfile);if(p?.neck?.maxLength>=0)return p.neck.maxLength;}catch{/* no stack-up */}}
    return NECK_DEFAULT;
  }
  // A board's rules: its view of the project rule book (project-rules.js; memoised, never edit it in place).
  // A board outside any project (a scratch copy, a panel's flattened board) reads the rules it carries.
  const stored=(board,project)=>{const p=project??globalThis.AtriumSignals?.projectOf?.(board),P=globalThis.AtriumProjectRules;
    // A copy that carries rules of its own (a preview, a flattened panel board) reads them.
    if(board?.rules!=null&&!p?.documents?.includes(board))return board.rules;
    if(board?.kind==="pcb"&&P&&p?.documents?.some(d=>d===board||d.id===board.id))return P.forBoard(p,board);
    return board?.rules??null;};
  // A board's rules become `set` (one edit of the project rule book; class and pair keys go to the signal model).
  function store(board,project,set,extras){const P=globalThis.AtriumProjectRules,p=project??globalThis.AtriumSignals?.projectOf?.(board);
    if(!P||!p)throw Error("Open the board in a project to change its rules.");
    // normalize() drops empty class maps; a set that emptied them (the last class removed) still says so.
    const next=validate(normalize(migrate(set)));for(const k of P.CLASS_KEYS)if(set[k]!==undefined)next[k]=set[k];P.store(p,board,next,extras);}
  // The board's rules with the class and pair keys of the signal model (signals.js; its current view: spans can
  // move between saves), so readers of effective() see what DRC sees and editors of classes edit the model's.
  function effective(board,project){
    const set=migrate(stored(board,project)),S=globalThis.AtriumSignals,p=project??S?.projectOf?.(board);
    if(!board||board.kind&&board.kind!=="pcb"||!S?.model||!p?.documents?.includes(board))return set;
    const L=S.model(p,board).legacy();
    for(const k of ["netClasses","diffPairs","diffPairClasses"]){const v=L[k];if(Array.isArray(v)?v.length:Object.keys(v).length)set[k]=JSON.parse(JSON.stringify(v));else delete set[k];}
    return set;
  }

  // ---------------------------------------------------------------- layers, scopes and compiled rules
  const copperIndex=name=>{
    const i=globalThis.AtriumPCBAppearance.index(name);return i<0?null:i;
  };
  const layerLabel=l=>globalThis.AtriumPCBAppearance?.name?.(l)||l;
  function sideSpan(layer,physicalOnly=false){
    if(layer==null||layer==="Multi")return [0,127];
    const n=copperIndex(layer);if(n!=null)return [n,n];
    if(physicalOnly)return null;
    if(/^top|^silk$/i.test(layer))return [0,0];if(/^bottom/i.test(layer))return [127,127];
    return null;
  }
  const quote=v=>"'"+String(v).replace(/'/g,"''")+"'";
  function scopeQuery(s){
    if(typeof s?.source==="string")return s.source;
    if(s.kind==="query")return s.value;
    return {all:()=>"All",net:()=>"InNet("+quote(s.value)+")",netclass:()=>"InNetClass("+quote(s.value)+")",diffpair:()=>"InDifferentialPair("+quote(s.value)+")",signal:()=>"InSignal("+quote(s.value)+")",tag:()=>"HasTag("+quote(s.value)+")",
      xsignal:()=>"InxSignal("+quote(s.value)+")",xsignalclass:()=>"InxSignalClass("+quote(s.value)+")",diffpairclass:()=>"InDifferentialPairClass("+quote(s.value)+")",layer:()=>"OnLayer("+quote(layerLabel(s.value))+")",component:()=>"InComponent("+quote(s.value)+")",componentclass:()=>"InComponentClass("+quote(s.value)+")"}[s.kind]();
  }
  // Objects passed to matchers: {net, pair?, span?:[lo,hi], layer?}.
  // Signals (signals.js, format 1.4): with a signals store, net classes, pairs and pair classes come from
  // the signal model (spans, stages, tags) when the rules being compiled carry the board's current mirror;
  // a rules copy with other class keys (an editor's working copy) keeps its own.
  function signalEnv(set,cx){
    const S=globalThis.AtriumSignals,doc=cx?.doc;
    if(!S?.scopeEnv||!doc||doc.kind&&doc.kind!=="pcb")return null;
    let env=null;try{env=S.scopeEnv(doc,cx.project);}catch{env=null;}
    if(!env)return null;
    // The board's own stored rules: the model. Rules handed in (an editor's working copy, a rule set) use the
    // model when they carry the board's stored mirror or the model's current view (effective()).
    if(!cx.explicit)return env;
    const proj=cx.project||S.projectOf(doc),strip=x=>JSON.stringify(S.canonicalLegacy({netClasses:x.netClasses||{},diffPairs:x.diffPairs||[],diffPairClasses:x.diffPairClasses||{}}));
    const mine=strip(set);
    return mine===strip(S.legacyOf(doc,proj))||mine===strip(env.model.legacy())?env:null;
  }
  const netSubject = net => ({kind:"net",name:net,net});
  const NET_TIMING_RULES = new Set(["length","delay","matchedLengths","matchedDelays"]);
  const allScope = s => !s || s.kind === "all" || globalThis.AtriumDesignQueryRecord?.isAll(s) === true;
  // A board run or a sheet run owns one context. Both sides, coverage and every
  // candidate reuse its compiled closures; a Working Copy never shares its class
  // membership with another board or revision.
  function scopePlans(makeContext) {
    const plans = new Map(), all = {matches:() => true,test:() => true, dependencies:[]};
    let context;
    return scope => {
      if (allScope(scope)) return {plan:all, diagnostics:[]};
      const key = JSON.stringify(scope);
      if (plans.has(key)) return plans.get(key);
      // @ts-ignore CommonJS entry point. Browser and worker loaders declare the compiler.
      if (!globalThis.AtriumDesignQuery && typeof module !== "undefined" && typeof require === "function") require("./design-query.js");
      const Q = globalThis.AtriumDesignQuery;
      let result, unavailable=false;
      if (scope.kind === "query") {
        // @ts-ignore CommonJS entry point. Browser and worker loaders declare the translator.
        if (!globalThis.AtriumQueryExchange && typeof module !== "undefined" && typeof require === "function") require("./query-exchange.js");
        const exchange = globalThis.AtriumQueryExchange;
        const translated = exchange?.fromClassic(scope.value);
        unavailable = !exchange || (!!translated?.ok && !Q);
        result = translated?.ok && Q ? Q.compile(translated.scope, context ??= makeContext(Q)) : translated;
      } else {
        const record = scope.languageVersion !== undefined ? scope : globalThis.AtriumDesignQueryRecord?.fromSelector(scope);
        unavailable = !Q;
        if (Q && record) result = Q.compile(record, context ??= makeContext(Q));
      }
      const entry = result?.ok && result.plan ? {plan:result.plan, diagnostics:[]} : {plan:null,
        unavailable,
        diagnostics:result?.diagnostics?.length ? result.diagnostics : [{message:"The rule scope could not be compiled.", span:[0,(scope.source || "").length]}]};
      plans.set(key, entry);
      return entry;
    };
  }
  const needsMeasurement = plan => plan?.dependencies?.some(k=>k.startsWith("geometry:")||k.startsWith("rule:")||k==="field:length");
  // Ordinary optional fields may be absent. Only a measurement the evaluated
  // condition actually needed makes a check incomplete.
  function scopeTest(plan,subject) {
    const answer=plan.test(subject);
    if(answer!=null)return answer;
    return plan.requiredMissing?.(subject) ? null : false;
  }
  function scopeDiagnostic(rule, side, diagnostic) {
    return {...diagnostic, ruleId:rule.id, ruleName:rule.name, type:rule.type, side,
      message:rule.name + " (" + (side === "scope2" ? "second scope" : "scope") + "): " + diagnostic.message};
  }
  function compile(set,cx){const CC=globalThis.AtriumComponentClasses,ccMap=()=>cx?.doc&&CC?(cx.cc??=CC.map(cx.doc,cx.project)):new Map();
    set=designKeys(set,cx?.doc);
    const env=signalEnv(set,cx);
    const classes=env?env.classes:new Map(Object.entries(set.netClasses||{}).map(([k,v])=>[k,new Set(v)]));
    const pairs=env?env.pairs:new Map((set.diffPairs||[]).map(p=>[p.name,p])),pairOfNet=env?env.pairOfNet:new Map();
    if(!env)for(const p of pairs.values()){pairOfNet.set(p.positive,p);pairOfNet.set(p.negative,p);}
    const pairClasses=env?env.pairClasses:new Map(Object.entries(set.diffPairClasses||{}).map(([k,v])=>[k,new Set(v)]));
    const pairName=o=>o.pair||pairOfNet.get(o.net)?.name;
    // A diff signal's name covers all its stages (signals.js); a stage name only that stage.
    const pairOrSignal=(o,name)=>pairName(o)===name||!!env&&!!o.net&&env.signalOf(o.net)?.kind==="diff"&&env.signalOf(o.net).name===name;
    const project = cx?.project ?? globalThis.AtriumSignals?.projectOf?.(cx?.doc);
    const profiles = new Map(), byType = {}, diagnostics = [], dependencies = new Set();
    let clearanceReady=true;
    for (const type of ORDER) byType[type] = [];
    let lengths;
    const plans = scopePlans(Q => Q.context(project, cx?.doc, {domain:"pcb", defs:cx?.defs,allowUnknown:true,
      // The public board-only rule API already has its document and library.
      // A project context supplies its own authority-partitioned geometry.
      geometry:!project && cx?.doc ? globalThis.AtriumDesignQueryGeometry?.create({doc:cx.doc,defs:cx.defs,journal:globalThis.AtriumUndoStore}) : undefined,
      resolveRef({family,name,binding}) {
        // A saved binding follows its stable ID, including through rename and
        // deletion. Only an ephemeral name may come from an unsaved rule set.
        if (binding?.target) return undefined;
        if (family === "netclass" && (classes.has(name) || name === "All Nets") ||
            family === "componentclass" && (ccMap().has(name) || name === "All Components") ||
            family === "diffpair" && pairs.has(name) ||
            family === "diffpairclass" && (pairClasses.has(name) || name === "All Differential Pairs") ||
            family === "tag" && (classes.has(name) || pairClasses.has(name))) return {target:{name}};
        return undefined;
      },
      relation(o,family,target) {
        const name = target.name;
        if (family === "netclass") return !!o.net && (classes.get(name)?.has(o.net) ?? name === "All Nets");
        if (family === "componentclass") return !!o.component && (ccMap().get(name)?.has(o.component) ?? name === "All Components");
        if (family === "diffpair") return pairOrSignal(o,name);
        if (family === "diffpairclass") return !!pairName(o) && (pairClasses.get(name)?.has(pairName(o)) ?? name === "All Differential Pairs");
        if (family === "signal" && !env && pairs.has(name)) return pairName(o) === name;
        if (family === "tag" && !env && (classes.has(name) || pairClasses.has(name))) return !!o.net && (!!classes.get(name)?.has(o.net) || !!pairClasses.get(name)?.has(pairName(o)));
        if (family === "layer" && o.span) {const n=copperIndex(name); if (n != null) return o.span[0] <= n && n <= o.span[1];}
        return undefined;
      },
      fieldValue(o,key) {
        const field=key.toLowerCase();
        // An edited rule book can have different pairs from the project's saved signal model.
        if (["signal","signal.name","polarity","paired"].includes(field)) {
          const signal=env?.signalOf(o.net),pair=pairOfNet.get(o.net);
          if (field==="paired") return !!(o.pair || pair || signal?.kind==="diff");
          if (field!=="polarity") return signal?.name ?? pair?.name ?? o.pair ?? null;
          const sign=signal?.polarity ?? (pair && pair.positive===o.net ? 1 : pair && pair.negative===o.net ? -1 : null);
          return sign===1 ? "+" : sign===-1 ? "-" : signal ? "" : null;
        }
        if (field !== "length" || o.kind !== "net") return undefined;
        if (Number.isFinite(o.length)) return o.length;
        // @ts-ignore CommonJS entry point. Browser and worker loaders declare the length engine.
        if (!globalThis.AtriumLength && typeof module !== "undefined" && typeof require === "function") require("../pcb/length-tuning.js");
        const L = globalThis.AtriumLength;
        if (!L?.netLengths || !cx?.doc) return null;
        lengths ??= L.netLengths(cx.doc,cx.defs ?? new Map((project?.library||[]).map(d=>[d.id,d])));
        return lengths.get(o.net)?.length ?? null;
      },
      ruleValue(o,key) {
        if(key !== "MinWidth") return undefined;
        const r = first("width",o);
        if (!r) return null;
        const stack = o.stack ?? (o.at && globalThis.AtriumStackup?.stackAt?.(cx?.doc,o.at));
        return profileAt(r,o.layer,cx?.doc,profiles,stack)?.minWidth ?? widthAt(r,o.layer).min;
      }
    }));
    const never = () => false, matcher = s => plans(s).plan?.matches ?? never;
    const measurementIssues=new Map();
    function missing(rule,side,plan,o){
      const d=plan.requiredMissing?.(o);
      if(!d)return;
      const key=JSON.stringify([rule.id,side,d.code,d.span]);
      if(!measurementIssues.has(key))measurementIssues.set(key,{...scopeDiagnostic(rule,side,d),objectId:o.id});
    }
    function single(rule,side,p){
      if(!needsMeasurement(p))return p.matches;
      return o=>{const v=scopeTest(p,o);if(v===null)missing(rule,side,p,o);return v===true;};
    }
    const off=disabledRuleSets(set);
    for (const r of set.list) if (ruleActive(set,r,off)) {
      const a = plans(r.scope), b = r.scope2 && plans(r.scope2);
      if (r.type==="clearance" && (a.unavailable || b?.unavailable)) clearanceReady=false;
      const issues = [];
      for (const [side, entry] of [["scope",a],["scope2",b]]) if (entry) {
        for (const d of entry.diagnostics) issues.push(scopeDiagnostic(r,side,d));
        for (const k of entry.plan?.dependencies || []) {
          dependencies.add(k);
          if (r.type === "width" && k === "rule:MinWidth") issues.push(scopeDiagnostic(r,side,{code:"rule-cycle", message:"Dependency cycle: width scope → rule(MinWidth) → width scope."}));
        }
      }
      if (issues.length) {diagnostics.push(...issues); continue;}
      byType[r.type].push({...r,m1:single(r,"scope",a.plan),m2:b?single(r,"scope2",b.plan):null,scopePlan:a.plan,scope2Plan:b?.plan,measured:needsMeasurement(a.plan)||needsMeasurement(b?.plan)});
    }
    for(const t of ORDER)byType[t].sort((a,b)=>a.priority-b.priority);
    const extra=(r,o)=>r.type!=="fanoutControl"||r.package==="default"||r.package===(o.package||"default");
    function first(type,o){for(const r of byType[type])if(extra(r,o)&&r.m1(o))return r;return null;}
    // Preferences, land limits and hole limits each take the first matching
    // rule that supplies them. Keep the limit's own rule for DRC attribution.
    function viaStyle(o){
      let first,land,hole,diameter,drill;
      for(const r of byType.viaStyle)if(r.m1(o)){
        first??=r;
        if(r.diameterMin!=null||r.diameterMax!=null)land??=r;
        if(r.holeMin!=null||r.holeMax!=null)hole??=r;
        diameter??=r.diameterPreferred;
        drill??=r.holePreferred;
        if(land&&hole&&diameter!=null&&drill!=null)break;
      }
      return {first,land,hole,diameter,drill};
    }
    function either(type,a,b){
      for(const r of byType[type]){
        if(!r.measured){if(r.m1(a)||r.m1(b))return r;continue;}
        const p=r.scopePlan, av=scopeTest(p,a),bv=scopeTest(p,b);
        if(av===true||bv===true)return r;
        if(av===null)missing(r,"scope",p,a);
        if(bv===null)missing(r,"scope",p,b);
      }
      return null;
    }
    function pairMatches(r,a,b){
      if(!r.measured)return r.m1(a)&&r.m2(b)||r.m1(b)&&r.m2(a);
      const p=r.scopePlan,q=r.scope2Plan, x=scopeTest(p,a), y=scopeTest(q,b);
      if(x===true&&y===true)return true;
      const u=scopeTest(p,b),v=scopeTest(q,a);
      if(u===true&&v===true)return true;
      if(x!==false&&y!==false){if(x===null)missing(r,"scope",p,a);if(y===null)missing(r,"scope2",q,b);}
      if(u!==false&&v!==false){if(u===null)missing(r,"scope",p,b);if(v===null)missing(r,"scope2",q,a);}
      return false;
    }
    function pair(type,a,b){
      for(const r of byType[type])if(pairMatches(r,a,b)){
        if(r.ignoreFootprintPadPairs&&a.kind==="pad"&&b.kind==="pad"&&a.ck!=="hole"&&b.ck!=="hole"&&a.id!=null&&a.id===b.id&&a.component&&a.component===b.component)return null;
        return r;
      }
      return null;
    }
    const clearanceRule=(a,b)=>pair("clearance",a,b);
    const anchors=new Set(),names=new Set();
    const usesParts=[...dependencies].some(k=>["relation:componentclass","relation:xsignal","relation:xsignalclass","relation:signal","relation:tag"].includes(k));
    let bound=false;
    for(const rows of Object.values(byType))for(const r of rows)for(const [scope,plan] of [[r.scope,r.scopePlan],[r.scope2,r.scope2Plan]]){
      for(const ref of plan?.references || []){
        const id=ref.target?.itemId ?? ref.target?.id;
        if(!id || ref.family!=="anchor"&&!scope?.bindings?.length)continue;
        anchors.add(id);bound=true;
        if(!scope.bindings?.some(b=>b.span[0]===ref.span[0]&&b.span[1]===ref.span[1]))names.add(ref.name);
      }
    }
    const recheckBoardItems = {anchors,names,usesParts,bound,length:dependencies.has("field:length")};

    return {set,byType,first,viaStyle,either,pair,clearanceRule,clearanceReady,classes,pairs,pairOfNet,pairClasses,matcher,profiles,signals:env,dependencies,diagnostics,measurementIssues,recheckBoardItems};
  }

  // ---------------------------------------------------------------- query API
  // Constraint values of the highest-priority enabled rule of `type` matching the
  // object, or null. Width and differential-pair values can vary by layer.
  // Profile values for a rule on a layer: {min, preferred, max, ...} or null.
  // cache: a Map owned by one compiled rule set (resolver or DRC run), so the
  // stack is read once per profile and layer.
  function profileAt(r,layer,board,cache,stack){
    if(!r?.impedanceProfile||!board||copperIndex(layer)==null)return null;
    const k=r.impedanceProfile+"\u0001"+layer+"\u0001"+(stack||"");
    if(cache?.has(k))return cache.get(k);
    let v=null;try{v=globalThis.AtriumStackup?.profileValues?.(board,r.impedanceProfile,layer,undefined,stack||undefined)||null;}catch{v=null;}
    v=v&&!v.error&&v.width>0?v:null;cache?.set(k,v);
    return v;
  }
  function widthAt(r,layer){
    const row=layer&&r.layers&&own(r.layers,layer)?r.layers[layer]:null;
    if(!row)return r;
    const min=row.widthMin??r.min,max=row.widthMax??r.max;
    const preferred=row.widthPreferred??(r.preferred==null?null:Math.min(max??Infinity,Math.max(min,r.preferred)));
    return {min,max,preferred};
  }
  function constraint(r,layer,kind,board,cache,stack){
    if(!r)return null;
    const out={type:r.type,ruleId:r.id,ruleName:r.name,priority:r.priority};
    for(const f of TYPES[r.type].fields){
      const value=r[f.key];
      if(f.kind==="layerTable"&&f.optional&&value==null)continue;
      out[f.key]=Array.isArray(value)?[...value]:plain(value)?JSON.parse(JSON.stringify(value)):value;
    }
    if(r.type==="width"&&layer&&r.layers&&own(r.layers,layer))Object.assign(out,widthAt(r,layer));
    if(r.type==="diffPairsRouting"&&layer&&r.layers&&own(r.layers,layer))Object.assign(out,r.layers[layer]);
    if(r.type==="polygonConnect"&&kind&&r.kinds&&own(r.kinds,kind))Object.assign(out,r.kinds[kind]);
    // Clearance: routeGap is the gap routing tools keep from new copper; maxGap the largest cell.
    if(r.type==="clearance"){out.routeGap=clearanceRoute(r);out.maxGap=clearanceMax(r);}
    const p=profileAt(r,layer,board,cache,stack);
    if(p){
      out.impedance={profile:r.impedanceProfile,target:p.target,tolerance:p.tolerance,z:p.z,width:p.width,gap:p.gap,ground:p.ground,delay:p.result.delay,eeff:p.result.eeff};
      if(r.type==="width")Object.assign(out,{min:p.minWidth,preferred:p.width,max:p.maxWidth});
      else Object.assign(out,{widthMin:p.minWidth,widthPreferred:p.width,widthMax:p.maxWidth,gapMin:p.minGap,gapPreferred:p.gap,gapMax:p.maxGap});
    }
    return out;
  }
  function objectFor(R,o){
    let net=o.net||"",pair=o.pairName||o.pair||undefined;
    if(pair&&!net)net=R.pairs.get(pair)?.positive||"";
    return {...o,net,pair,span:o.span ?? (o.layer!=null?sideSpan(o.layer):undefined)};
  }
  function compiledRules(board,options={}){
    const source=stored(board,options.project),rules=options.rules??source;
    return compile(migrate(rules),{doc:board,defs:options.defs,project:options.project,explicit:rules!==source});
  }
  // One raw physical DRC for the release gate and the Output Jobs report.
  // The gate counts active findings and the report retains the waived findings separately.
  function reportInput(doc,options={}){
    const project=options.project,defs=new Map(project.library.map(d=>[d.id,d]));
    const rules=stored(doc,project)||defaults();
    const host=options.cache;let cached,conn=null;
    if(globalThis.AtriumConnectivity)conn=()=>host?(host.connections||=AtriumConnectivity.inspect(doc,defs,undefined,{project})):(cached||=AtriumConnectivity.inspect(doc,defs,undefined,{project}));
    const all=(globalThis.AtriumDRC?.run||drc)(doc,defs,rules,{connections:conn,project,limit:options.limit,checkMode:"all"});
    const W=globalThis.AtriumDRCWaivers,hasWaivers=Array.isArray(doc.drcWaivers)&&doc.drcWaivers.length>0;
    const split=hasWaivers&&W?.apply?W.apply(doc,all):null;
    const warnings=hasWaivers&&!W?.apply?["DRC waivers are not loaded: waived violations are counted."]:[];
    return {all,result:split?split.result:all,waived:split?.waived||[],warnings};
  }
  function resolver(board,options={}){
    const R=options.compiled||compiledRules(board,options);
    const resolve=(type,o={})=>{
      if(!own(TYPES,type))fail("Unknown rule type "+type+".");
      const a=objectFor(R,o),st=o.stack??(o.at?globalThis.AtriumStackup?.stackAt?.(board,o.at):null)??null;
      // The tuner and Constraint Manager address a timing subject by its net name.
      if(a.net&&!a.kind&&!a.item&&NET_TIMING_RULES.has(type))Object.assign(a,netSubject(a.net));
      // A long-lived resolver drops cached profile values when the stack-up changes (edits mutate it in place).
      if(globalThis.AtriumStackup?.signature){const sg=AtriumStackup.signature(board);if(R.profiles.sig!==sg){R.profiles.clear();R.profiles.sig=sg;}}
      if(TYPES[type].two)return constraint(R.pair(type,a,objectFor(R,{...o,net:o.net2??"",pairName:undefined,pair:undefined})),o.layer,null,board,R.profiles,st);
      if(type==="viaStyle"){
        const {first,land,hole,diameter,drill}=R.viaStyle(a);
        return first?constraint({...first,diameterPreferred:diameter??null,holePreferred:drill??null,
          diameterMin:land?.diameterMin??null,diameterMax:land?.diameterMax??null,
          holeMin:hole?.holeMin??null,holeMax:hole?.holeMax??null},o.layer,o.padKind,board,R.profiles,st):null;
      }
      return constraint(R.first(type,a),o.layer,o.padKind,board,R.profiles,st);
    };
    // Match the same via-land and plated-hole subjects as the batch manufacturing checks.
    resolve.viaLimits = (net, style = {}, at, span = [0,127]) => {
      const item = {...style,kind:"via",layer:"Multi",net,x:at?.[0],y:at?.[1]};
      const via = {...copperSubject(item,null,"via",at),span};
      const radius=(style?.drill||0)/2;
      const hole={...via,ck:"hole",box:at&&[at[0]-radius,at[1]-radius,at[0]+radius,at[1]+radius]};
      return A.viaLimits(R.viaStyle(via),R.first("holeSize",hole),R.first("annularRing",hole));
    };
    const clearance=R.byType.clearance;
    resolve.clearanceReady=R.clearanceReady;
    resolve.clearanceMax=clearance.reduce((v,r)=>Math.max(v,clearanceMax(r)),0);
    const clearanceDeps = new Set(clearance.flatMap(r=>[...(r.scopePlan.dependencies || []),...(r.scope2Plan?.dependencies || [])]));
    resolve.typedClearance=clearance.some(r=>r.objects)||[...clearanceDeps].some(k=>!k.startsWith("reference:")&&!["field:net.name","field:net","relation:net","relation:netclass","relation:diffpair","relation:diffpairclass","relation:signal","relation:tag","kind:object"].includes(k));
    resolve.spatialClearance=[...clearanceDeps].some(k=>k.startsWith("geometry:")||k==="relation:room");
    resolve.holeClearance=clearance.some(r=>Object.keys(r.objects||{}).some(k=>k.endsWith("-hole")));
    // A numeric limit includes zero. Null means the available compiler found no applicable rule.
    // Undefined means the scope compiler needed by an enabled Clearance rule is unavailable.
    resolve.routingClearance=(a,b,layer)=>{
      if(!R.clearanceReady)return undefined;
      const span=layer!=null?sideSpan(layer):undefined;
      const r=R.clearanceRule({net:a||"",layer,span},{net:b||"",layer,span});
      return r?clearanceRoute(r):null;
    };
    resolve.clearanceBetween=(a,b)=>R.clearanceReady?clearanceLimit(R.clearanceRule(a,b),a.ck,b.ck):undefined;
    return resolve;
  }
  const query=(board,type,o={},options={})=>resolver(board,{...options,project:options.project??o.project,rules:options.rules??o.rules})(type,o);
  // The class and pair keys of a rule set, else (none stored) those of the board's imported class records
  // (doc.sourceClasses: Altium Classes6 / DifferentialPairs6, KiCad net classes; altium-rules.js classes()).
  function designKeys(set,board){
    if(set.netClasses!==undefined||set.diffPairs!==undefined||set.diffPairClasses!==undefined||!Array.isArray(board?.sourceClasses)||!globalThis.AtriumAltiumRules?.classes)return set;
    let c=null;try{c=AtriumAltiumRules.classes(board.sourceClasses);}catch{c=null;}
    if(!c)return set;
    const out={...set};
    if(Object.keys(c.netClasses).length)out.netClasses=c.netClasses;if(c.diffPairs.length)out.diffPairs=c.diffPairs;if(Object.keys(c.diffPairClasses).length)out.diffPairClasses=c.diffPairClasses;
    return out;
  }
  // Net classes and differential pairs a board's rules see: the signal model's view with a signals store
  // (tags, stages), else the rules' own keys.
  function netClasses(board,options={}){const set=designKeys(migrate(options.rules??stored(board,options.project)),board),env=signalEnv(set,{doc:board,project:options.project,explicit:options.rules!=null});
    if(env){const out={};for(const [k,v] of env.classes)setOwn(out,k,[...v]);return out;}
    return copyClasses(set.netClasses);}
  function diffPairs(board,options={}){
    const set=designKeys(migrate(options.rules??stored(board,options.project)),board),env=signalEnv(set,{doc:board,project:options.project,explicit:options.rules!=null});
    if(env){const classes=[...env.pairClasses];return [...env.pairs.values()].map(p=>({name:p.name,positive:p.positive,negative:p.negative,signal:p.signal,classes:classes.filter(([,m])=>m.has(p.name)).map(([k])=>k)}));}
    const classes=Object.entries(set.diffPairClasses||{});
    return (set.diffPairs||[]).map(p=>({...p,classes:classes.filter(([,m])=>m.includes(p.name)).map(([k])=>k)}));
  }
  // Net groups for Matched Lengths rules. Each net belongs to the first
  // (highest-priority) rule that scopes it.
  const XS_SCOPE=r=>!!r?.scopePlan?.dependencies?.some(k=>k==="relation:xsignal"||k==="relation:xsignalclass");
  function matchedGroups(board,options={}){
    const R=compile(migrate(options.rules??stored(board,options.project)),{doc:board,project:options.project,explicit:options.rules!=null});
    if(!R.byType.matchedLengths.length)return [];
    const nets=options.nets?[...options.nets]:boardNets(board,R.set,options.boardNames);
    const groups=R.byType.matchedLengths.map(r=>({ruleId:r.id,ruleName:r.name,priority:r.priority,tolerance:r.tolerance,withinPair:r.withinPair,pairTolerance:r.pairTolerance,nets:[],pairs:[]}));
    for(const net of nets){
      const o={...netSubject(net),pair:R.pairOfNet.get(net)?.name},i=R.byType.matchedLengths.findIndex(r=>!XS_SCOPE(r)&&r.m1(o));/* hs-xsignals: xSignal-scoped rules match xSignals (xsignals.js) */
      if(i>=0)groups[i].nets.push(net);
    }
    for(const g of groups){
      g.nets.sort(cmp);const inGroup=new Set(g.nets);
      g.pairs=[...R.pairs.values()].filter(p=>inGroup.has(p.positive)&&inGroup.has(p.negative)).map(p=>({...p}));
    }
    return groups.filter(g=>g.nets.length);
  }
  function boardNets(board,set,indexed){
    const names=new Set(indexed);
    if(!indexed)for(const i of board?.items||[]){if(i.net)names.add(i.net);for(const n of Object.values(i.pinNets||{}))if(n)names.add(n);}
    for(const p of set?.diffPairs||[]){names.add(p.positive);names.add(p.negative);}
    for(const m of Object.values(set?.netClasses||{}))for(const n of m)names.add(n);
    return [...names].sort(cmp);
  }
  // Candidate pairs from net names, as Altium's "Create from nets": net-intent.js (AtriumNetIntent.pairs)
  // when it is loaded, else the suffix table below (one release, for worker bundles and old runners).
  // Only {name, positive, negative} leaves here, so nothing else is written into rules.diffPairs.
  const SUFFIXES=[["_DP","_DN"],["_dp","_dn"],["_P","_N"],["_p","_n"],["+","-"],["P","N"],["p","n"]];
  function detectDiffPairs(nets,existing=[]){
    const N=globalThis.AtriumNetIntent;
    if(N?.pairs){try{return N.pairs(nets,existing).map(({name,positive,negative})=>({name,positive,negative}));}catch{/* the suffix table */}}
    return legacyDetect(nets,existing);
  }
  function legacyDetect(nets,existing=[]){
    const all=new Set(nets),used=new Set(existing.flatMap(p=>[p.positive,p.negative])),names=new Set(existing.map(p=>p.name)),out=[];
    for(const net of [...all].sort(cmp)){
      if(used.has(net))continue;
      for(const [pos,neg] of SUFFIXES){
        if(!net.endsWith(pos)||net.length<=pos.length)continue;
        const base=net.slice(0,-pos.length),other=base+neg;
        if(!all.has(other)||used.has(other))continue;
        let name=base.replace(/[_\-.]+$/,"")||base,n=1;
        while(names.has(name))name=base+"_"+(n++);
        names.add(name);used.add(net);used.add(other);out.push({name,positive:net,negative:other});break;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- mask and paste expansion
  // AtriumRules.expansion(board,"solder"|"paste",item,{parent,layer,project,rules}) -> mm.
  // item is a board pad or via, or a footprint pad with `parent` set to its part.
  // A numeric item.maskExpansion / item.pasteExpansion overrides the rules. With no
  // matching rule, solder mask is 0.1016 mm (4 mil) and paste is 0.
  function maskRuleResolver(board,kind,options={}){
    const type=kind==="paste"?"pasteMask":kind==="solder"||kind==="mask"?"solderMask":fail("Choose solder or paste expansion.");
    const R=compile(migrate(options.rules??stored(board,options.project)),{doc:board,project:options.project,explicit:options.rules!=null});
    return (item,parent=null,layer)=>{
      const net=parent&&item.kind!=="via"&&parent.pinNets&&own(parent.pinNets,item.number)?parent.pinNets[item.number]:item?.net||"";
      const l=layer||item?.layer||(item?.drill>0||item?.kind==="via"?"Multi":parent?.layer||"Top");
      // Footprint pads have no kind property. A missing kind would match both IsVia and IsPad.
      const at=Number.isFinite(item.x)&&Number.isFinite(item.y)?(parent?A.world([item.x,item.y],parent):[item.x,item.y]):null;
      return R.first(type,{id:parent?.id||item.id,item,parent,net,at,kind:item.kind||"pad",drill:item.drill||0,plated:item.plated!==false,diameter:item.diameter,
        component:parent?.ref,pin:item.number,layer:l,span:sideSpan(l)});
    };
  }
  function expansionResolver(board,kind,options={}){
    const resolve=maskRuleResolver(board,kind,options),paste=kind==="paste",field=paste?"pasteExpansion":"maskExpansion";
    return (item,parent=null,layer)=>{
      if(Number.isFinite(item?.[field]))return item[field];
      return resolve(item,parent,layer)?.expansion??(paste?0:DEFAULT_SOLDER);
    };
  }
  const expansion=(board,kind,item,options={})=>expansionResolver(board,kind,options)(item,options.parent||null,options.layer);

  // ---------------------------------------------------------------- geometry
  const {closestSegments,inRing,orient,projectPointOnSegment:project}=globalThis.AtriumGeometry;
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  function containsConvex(p,poly) {
    if(poly.length<3)return false;
    let pos=false,neg=false;
    for(let n=0;n<poly.length;n++) {
      const side=orient(poly[n],poly[(n+1)%poly.length],p);
      if(side>EPS)pos=true;if(side< -EPS)neg=true;
      if(pos&&neg)return false;
    }
    return pos||neg;
  }
  function edges(core) {
    if(core.length<=2)return [[core[0],core[core.length-1]]];
    return core.map((p,n)=>[p,core[(n+1)%core.length]]);
  }
  const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
  // Copper wholly inside a drill is measured to the hole wall: bore is the drill radius around
  // boreAxis (the drill centre, or a slot's two centres as A.drillCore gives them; connectivity.js inBore).
  function boreGap(owner,other){
    if(!owner.bore)return null;
    const axis=owner.boreAxis||[owner.at],a=axis[0],b=axis.at(-1);
    let far=null,foot=a,distance=-Infinity;
    for(const p of other.core){
      const q=project(p,a,b),d=dist(q,p);
      if(d>distance){distance=d;far=p;foot=q;}
    }
    const extent=distance+other.radius,d=owner.bore-extent;
    if(d<=0)return null;
    const c=foot, direction=distance>EPS?[ (far[0]-c[0])/distance, (far[1]-c[1])/distance ]:[1,0];
    const offset=(owner.bore+extent)/2;
    return {d,at:[c[0]+offset*direction[0],c[1]+offset*direction[1]]};
  }
  // Features are convex cores grown by a radius: track capsules, via and round
  // pad discs, obround pads, rotated (rounded) rectangles and octagons.
  function gap(a,b){
    const bore=boreGap(a,b)||boreGap(b,a);
    if(bore)return bore;
    if(containsConvex(a.core[0],b.core))return {d:0,at:a.core[0]};
    if(containsConvex(b.core[0],a.core))return {d:0,at:b.core[0]};
    let best=null;const touch=a.radius+b.radius;
    outer:for(const [p,q] of a.edges)for(const [r,s] of b.edges){
      const c=closestSegments(p,q,r,s);if(!best||c.d<best.d){best=c;if(c.d<=touch)break outer;}
    }
    return {d:Math.max(0,best.d-touch),at:mid(best.pa,best.pb)};
  }
  function compound(base,parts){
    if(parts.length===1)return parts[0];
    const box=[Infinity,Infinity,-Infinity,-Infinity];
    for(const f of parts){box[0]=Math.min(box[0],f.box[0]);box[1]=Math.min(box[1],f.box[1]);box[2]=Math.max(box[2],f.box[2]);box[3]=Math.max(box[3],f.box[3]);}
    return {...parts[0],box,pieces:parts};
  }
  // Gap between features, either of which may be a compound of convex pieces.
  function pieceGap(a,b,limit){
    if(!a.pieces&&!b.pieces)return gap(a,b);
    for(const [ink,other] of [[a,b],[b,a]]){
      if(!ink.regions)continue;
      for(const {core:[at]} of other.pieces||[other]){
        if(ink.regions.some(({outer,holes})=>inRing(at,outer)&&!holes.some(h=>inRing(at,h))))return {d:0,at};
      }
    }
    let best={d:Infinity,at:null};
    for(const p of a.pieces||[a])for(const q of b.pieces||[b]){
      const reach=Math.min(best.d,limit);
      if(p.box[0]-q.box[2]>=reach||q.box[0]-p.box[2]>=reach||p.box[1]-q.box[3]>=reach||q.box[1]-p.box[3]>=reach)continue;
      const g=gap(p,q);if(g.d<best.d){best=g;if(!g.d)return best;}
    }
    return best;
  }
  function feature(base,core,radius){
    const b=A.bounds(core);
    return {...base,core,edges:edges(core),radius,box:[b[0]-radius,b[1]-radius,b[2]+radius,b[3]+radius]};
  }
  function padCore(p,center,angle,expansion=0,mirror=false){
    const L=AtriumResolvedLand, nominal=L.geometry(p);
    const land=expansion&&nominal?AtriumLandContours.expand(nominal,expansion):nominal;
    if(!land)return null;
    const {core,r:radius}=L.core(land,center,angle,mirror);
    return {core,radius};
  }
  function slotRing(axis,drillRadius,lands,parent){
    let ring=Infinity;
    for(const land of lands){
      if(land.holeOnly || !(land.w>0&&land.h>0))continue;
      const {at,angle,mirror}=AtriumResolvedLand.place(land,parent);
      const shape=padCore(land,at,angle,0,mirror);
      if(!shape)continue;
      const {core,radius}=shape;
      if(core.length<3){
        const depth=Math.max(...axis.map(p=>A.nearSegment(p,core[0],core.at(-1))));
        ring=Math.min(ring,radius-depth-drillRadius);
      }else if(radius>0){
        const sides=edges(core);
        for(const p of axis){
          let distance=Infinity;
          for(const [a,b] of sides)distance=Math.min(distance,A.nearSegment(p,a,b));
          ring=Math.min(ring,radius+(inRing(p,core)?distance:-distance)-drillRadius);
        }
      }else{
        // A concave custom pad can contain both ends while its perimeter crosses the slot.
        if(!axis.every(p=>inRing(p,core)))return 0;
        for(const [a,b] of edges(core))ring=Math.min(ring,closestSegments(axis[0],axis[1],a,b).d-drillRadius);
      }
    }
    return Number.isFinite(ring)?ring:null;
  }
  function convex(points){
    if(points.length<3)return false;let sign=0;
    for(let i=0;i<points.length;i++){const o=orient(points[i],points[(i+1)%points.length],points[(i+2)%points.length]);
      if(Math.abs(o)<=EPS)continue;if(sign&&Math.sign(o)!==sign)return false;sign=Math.sign(o);}
    return sign!==0;
  }
  // Convex pieces covering a simple polygon (filled copper regions such as teardrops):
  // the polygon itself when convex, else ear-clipped triangles. null when the outline
  // is not a simple polygon (the pieces would not cover its area).
  function fillPieces(points){
    let pts=points.filter((p,n)=>!n||!A.same(p,points[n-1]));
    if(pts.length>3&&A.same(pts[0],pts.at(-1)))pts=pts.slice(0,-1);
    if(pts.length<3)return null;
    if(convex(pts))return [pts];
    let area=0;for(let n=0;n<pts.length;n++){const a=pts[n],b=pts[(n+1)%pts.length];area+=a[0]*b[1]-b[0]*a[1];}
    if(!(Math.abs(area)>1e-12))return null;
    const triangles=A.triangulateRing(pts,area,"complete");
    return triangles && A.mergeConvex(triangles,convex);
  }
  // Distance from segment p-q to a filled polygon (0 when they overlap).
  function polygonDistance(p,q,poly){
    if(inRing(p,poly)||inRing(q,poly))return 0;
    let d=Infinity;
    for(let i=0;i<poly.length;i++){d=Math.min(d,closestSegments(p,q,poly[i],poly[(i+1)%poly.length]).d);if(!d)break;}
    return d;
  }
  // Teardrops (teardrops.js) that no longer belong to the track and the pad or via
  // they were made for: either is gone, changed net or layer, or moved away.
  // Returns [{id, reason, at, layer, net, locked}].
  function staleTeardrops(doc,defs){
    const drops=(doc.items||[]).filter(i=>i.kind==="graphic"&&i.teardrop===true);
    if(!drops.length)return [];
    const byId=new Map(doc.items.map(i=>[i.id,i])),out=[];
    for(const t of drops){
      const reason=teardropFault(t,byId,defs);
      if(reason)out.push({id:t.id,reason,at:Array.isArray(t.points?.[0])?t.points[0].slice():null,layer:t.layer,net:t.net||"",locked:t.locked===true});
    }
    return out;
  }
  function teardropFault(t,byId,defs){
    const poly=t.points,net=t.net||"";
    if(!Array.isArray(poly)||poly.length<3)return "its outline is invalid";
    const tr=byId.get(t.teardropTrack);
    if(!tr||tr.kind!=="track"||!Array.isArray(tr.points)||tr.points.length<2)return "its track was removed";
    if((tr.net||"")!==net)return "its track changed net";
    if(tr.layer!==t.layer)return "its track changed layer";
    // teardrops.js outlines run flank, tail (two points on the track edges), flank: the tail's
    // midpoint lies on the track centreline and both flanks start inside the land.
    const n=poly.length,tail=n%2===0&&n>=4?mid(poly[n/2-1],poly[n/2]):null,TOL=2e-3;
    const near=(p,line,tol)=>{for(let k=1;k<line.length;k++)if(dist(p,project(p,line[k-1],line[k]))<=tol)return true;return false;};
    if(tail?!near(tail,tr.points,TOL):![[tr.points[0],tr.points[1]],[tr.points.at(-1),tr.points.at(-2)]].some(([p,q])=>polygonDistance(p,q,poly)<=(tr.width||0)/2+1e-3))return "its track moved";
    const anchor=String(t.teardropAnchor??"");
    if(anchor.includes("@")){
      const s=byId.get(anchor.slice(0,anchor.indexOf("@")));
      if(!s||s.kind!=="track"||!Array.isArray(s.points))return "its junction track was removed";
      if((s.net||"")!==net||s.layer!==t.layer)return "its junction track changed net or layer";
      return [poly[0],poly.at(-1)].every(p=>near(p,s.points,(s.width||0)*.7+TOL))?null:"its junction track moved";
    }
    let at,r,padNet,span;
    const k=anchor.indexOf(":"),it=k<0?byId.get(anchor):byId.get(anchor.slice(0,k));
    if(!it)return "its pad or via was removed";
    if(k<0){
      if(it.kind!=="via"&&it.kind!=="pad")return "its pad or via was removed";
      at=[it.x,it.y];r=it.kind==="via"?(it.diameter||0)/2:Math.min(it.w||0,it.h||0)/2;padNet=it.net||"";span=layerSpan(it,null);
    }else{
      const number=anchor.slice(k+1),pad=it.kind==="part"&&defs?.get(it.def)?.footprint?.pads?.find(p=>String(p.number)===number);
      if(!pad)return "its pad was removed";
      at=A.world([pad.x,pad.y],it);r=Math.min(pad.w||0,pad.h||0)/2;
      padNet=(it.pinNets&&own(it.pinNets,pad.number)?it.pinNets[pad.number]:pad.net)||"";span=layerSpan({...pad,kind:"pad"},it);
    }
    if(padNet!==net)return "its pad or via changed net";
    const li=copperIndex(t.layer);
    if(!span||li==null||li<span[0]||li>span[1])return "its pad or via is no longer on "+layerLabel(t.layer);
    if(dist(poly[0],at)>r+TOL||dist(poly.at(-1),at)>r+TOL)return "its pad or via moved";
    return null;
  }
  function layerSpan(i,parent) {
    const PCB=globalThis.AtriumPCBAppearance;
    return i.kind==="via" ? PCB.copperSpan(i) || [0,127] : sideSpan(PCB.padLayer(parent,i),true);
  }
  const copperNet=(i,parent)=>parent&&i.kind==="pad"&&parent.pinNets&&own(parent.pinNets,i.number)?parent.pinNets[i.number]:i.net||"";
  // Common rule-query subject for a physical copper feature, independent of the checker or pour solver.
  function copperSubject(i,parent,kind,at){
    const net=copperNet(i,parent);
    kind=kind||(i.kind==="polygon"?"polygon":i.kind==="pad"||i.kind==="via"?i.kind:i.fill?i.fillRect?"fill":"region":i.arc?"arc":"track");
    const ck=kind==="pad"?i.drill>0?"th":"smd":kind==="polygon"?"poly":kind;
    const o={id:parent?.id||i.id,item:i,parent,net,layer:i.layer||null,span:layerSpan(i,parent),component:parent?.ref,kind,ck};
    if(parent)o.part=parent;
    if(kind==="pad")Object.assign(o,{pin:i.number!=null?String(i.number):undefined,drill:i.drill||0,plated:i.plated!==false,padKind:ck});
    else if(kind==="via")Object.assign(o,{drill:i.drill||0,diameter:i.diameter});
    else if(kind==="polygon"){
      o.polygon=i.name||"";
      const points=i.points||i.outline;if(points?.length){o.box=A.bounds(points);o.at=points[0];}
      else if(i.bounds)o.box=i.bounds;
    }
    else if(kind==="track"||kind==="arc")o.width=i.width;
    else if(i.teardrop)o.teardrop=true;
    if(at)o.at=at;
    return o;
  }
  const SILK=new Set(["Silk","Bottom silk"]);

  // One pass over the board: copper features for clearance, tracks, vias,
  // holes, pad mask openings and overlay features. Pour clearance only needs netted copper.
  function extract(doc,defs,options={}){
    const geo={copper:[],tracks:[],vias:[],holes:[],pads:[],testpoints:[],silk:[],unassigned:0,excluded:0,silkText:0,objects:0};
    const physical=options.physical===true, nettedCopperOnly=options.nettedCopperOnly===true, holesOnly=options.holesOnly===true;
    const VS=globalThis.AtriumViaStack;let viaKeys=null;
    function stackLayers(kind){
      const read=()=>kind==="via"?VS.keysOf(doc,null,defs):boardLayers(doc);
      return options.stackKeys?(options.stackKeys[kind]??=read()):(viaKeys??=read());
    }
    const spanName=sp=>sp[0]===sp[1]?layerLabel(sp[0]===0?"Top":sp[0]===127?"Bottom":"Inner "+sp[0]):sp[0]===0&&sp[1]===127?layerLabel("Multi"):layerLabel(sp[0]===0?"Top":"Inner "+sp[0])+"–"+layerLabel(sp[1]===127?"Bottom":"Inner "+sp[1]);
    const stackedPad=i=>i.padStack&&(i.stackMode==="tmb"||i.stackMode==="full");
    function copper(i,parent,slot,padCount){
      if(holesOnly&&!(i.drill>0))return;
      const sp=layerSpan(i,parent);if(!sp)return;
      const obj=geo.objects++;
      if(nettedCopperOnly&&!copperNet(i,parent)){
        // Keep the shared layer lookup in the same first-use order as a full extraction.
        if(i.kind==="via"&&i.stackMode&&VS)stackLayers("via");
        else if(i.kind==="pad"&&stackedPad(i)&&sp[0]!==sp[1])stackLayers("pad");
        return;
      }
      const subject=copperSubject(i,parent),{id,net}=subject;
      const what=i.kind==="track"?"Track":i.kind==="via"?"Via":"Pad "+(parent?parent.ref+"-":"")+(i.number||"?");
      const label=what+" ("+spanName(sp)+")"+(net?" "+net:"");
      const base={...subject,obj,label};
      if((physical||options.padSlots)&&i.kind==="pad"&&Number.isSafeInteger(slot))base.padIndex=slot;
      if(i.kind==="track"){
        const points=AtriumGeometryCurves.pathPoints(i,.001),pts=parent?points.map(p=>A.world(p,parent)):points;
        if(!nettedCopperOnly&&!parent&&!slot)geo.tracks.push({...base,item:i,points:pts,width:i.width,at:pts.length>1?mid(pts[0],pts[1]):pts[0]});
        if(!net){geo.unassigned++;if(!physical)return;}
        if(!(i.width>0)||pts.length<2){geo.excluded++;return;}
        for(let n=1;n<pts.length;n++)geo.copper.push(feature(base,[pts[n-1],pts[n]],i.width/2));
        if(i.closed&&!A.same(pts[0],pts.at(-1)))geo.copper.push(feature(base,[pts.at(-1),pts[0]],i.width/2));
        return;
      }
      const PCB=globalThis.AtriumPCBAppearance;
      const center=PCB.padCenter(i,parent);base.at=center;
      if(!holesOnly&&options.planeHoles&&i.drill>0){
        base.planeHole=feature({},PCB.padDrillCore(i,parent,center),i.drill/2);
      }
      if(!holesOnly&&!nettedCopperOnly&&i.fabTestpoint)geo.testpoints.push({...base,item:i});
      if(i.kind==="via"){
        const viaStack=i.stackMode&&VS?stackLayers("via"):null;
        if(!nettedCopperOnly){
          if(!parent&&!holesOnly)geo.vias.push({...base,item:i});
          // Via stacks (viastack.js): the ring is checked on the smallest land of the span.
          const land=i.stackMode&&VS?VS.minDiameter(i,viaStack):i.diameter;
          if(i.drill>0)geo.holes.push(feature({...base,ck:"hole",item:i,ring:land>0?(land-i.drill)/2:null,what:"Via"},[center],i.drill/2));
        }
        if(holesOnly)return;
        if(!net){geo.unassigned++;if(!physical)return;}
        const copperVia=i.drill>0?{...base,bore:i.drill/2}:base;
        if(VS&&(i.stackMode&&i.stackMode!=="simple"||i.backdrill||i.shape&&i.shape!=="round")){
          for(const layer of stackLayers("via")){
            const land=VS.padOn(i,layer);if(!(land.diameter>0))continue;
            const idx=copperIndex(layer),g=padCore({w:land.diameter,h:land.diameter,shape:land.shape},center,0);
            if(g)geo.copper.push(feature({...copperVia,span:[idx,idx]},g.core,g.radius));
          }
        }else geo.copper.push(feature(copperVia,[center],i.diameter/2));
        return;
      }
      // The pad's physical drill spans the stack. Each authored land belongs only to its copper layer.
      let lands=[i];
      if(stackedPad(i)){
        const layers=sp[0]===sp[1]?[i.layer]:stackLayers("pad");
        lands=layers.map(layer=>{
          return {...AtriumResolvedLand.effective(i,layer),layer};
        });
      }
      if(!nettedCopperOnly){
        const widths=lands.filter(p=>!p.holeOnly&&p.w>0&&p.h>0).map(p=>Math.min(p.w,p.h));
        const size=widths.length?Math.min(...widths):0;
        if(i.drill>0){
          const axis=PCB.padDrillCore(i,parent,center);
          const ring=base.plated&&i.drill<size-EPS
            ?axis.length===2?slotRing(axis,i.drill/2,lands,parent):(size-i.drill)/2
            :null;
          geo.holes.push(feature({...base,ck:"hole",item:i,ring,
            what:"Pad",...(parent?{padIndex:slot,padCount}:null)},axis,i.drill/2));
        }
        if(!net&&widths.some(w=>!i.drill||i.drill<w-EPS))geo.unassigned++;
      }
      if(holesOnly)return;
      // The drill (round or slotted) is void in every land, as for a via's bore. An unplated land is
      // copper of the pad's net (none when the pad has none), as connectivity.js sees it, so a track of
      // another net is a clearance hit and a short; its lands are not joined by a barrel there.
      const bored=i.drill>0?{bore:i.drill/2,boreAxis:PCB.padDrillCore(i,parent,center)}:null;
      for(const land of lands){
        const face=land===i?base:{...base,layer:land.layer,span:sideSpan(land.layer)};
        if(land.holeOnly||!(land.w>0&&land.h>0)){
          if(!nettedCopperOnly&&i.drill>0)geo.pads.push(feature({...face,parent,item:land,maskOnly:true},[center],0));
          continue;
        }
        if(i.drill>=Math.min(land.w,land.h)-EPS)continue;
        const {at,angle:turn,mirror}=AtriumResolvedLand.place(land,parent);
        const shape=padCore(land,at,turn,0,mirror);
        const pad={...face,at,parent,item:land};
        let f=shape&&feature(pad,shape.core,shape.radius);
        if(f&&AtriumResolvedLand.shape(land.shape,land.w,land.h)==="custom"){
          const pieces=fillPieces(shape.core);
          f=pieces?compound(pad,pieces.map(core=>feature(pad,core,0))):null;
        }
        if(!f){geo.excluded++;continue;}
        if(!nettedCopperOnly)geo.pads.push(f);
        if(net||physical)geo.copper.push(f.pieces?bored?compound(f,f.pieces.map(q=>({...q,...bored}))):f:feature({...face,at,...bored},shape.core,shape.radius));
      }
    }
    function silk(item,layer,owner,parent,label){
      const C=AtriumGeometryCurves, width=Math.max(0,item.width||0), r=width/2;
      const source=item.regionShape&&!globalThis.AtriumBoardShape?{...item,regionShape:null}:item;
      C.artworkInk(source,width,(ink,kind)=>{
        if(kind==="outline")return;
        const obj=geo.objects++;
        if(nettedCopperOnly)return;
        const circle=kind==="disk"||kind==="ring";
        let points=item.points;
        // The old clearance checks use authored path vertices and a 24-facet circle.
        if(circle){
          const edge=kind==="disk"?ink.islands[0].outer[0]:ink.centerline[0];
          points=C.project([{...edge,radius:item.r,sweep:-360}],item.r,{minSegments:24,maxSegments:24}).slice(0,-1);
        }
        if(parent)points=points.map(p=>A.world(p,parent));
        const side=layer==="Silk"?0:127,base={obj,id:owner,group:owner,free:!parent,layer,side,net:"",span:[side,side],label};
        if(item.fill&&convex(points)){geo.silk.push(feature(base,points,r));return;}
        for(let n=1;n<points.length;n++)geo.silk.push(feature(base,[points[n-1],points[n]],r));
        if((circle||item.closed||item.fill)&&points.length>2&&!A.same(points[0],points.at(-1)))geo.silk.push(feature(base,[points.at(-1),points[0]],r));
      });
    }
    function shape(s,parent,index){
      if(s.keepout||s.cutout)return;
      const layer=AtriumPCBAppearance.shapeLayer(parent,s);
      if(SILK.has(layer)){
        if(s.kind==="text"){geo.silkText++;return;}
        silk(s,layer,parent.id,parent,"Overlay "+parent.ref+" ("+layerLabel(layer)+")");
        return;
      }
      if(!s.layer||copperIndex(s.layer)==null&&s.layer!=="Multi")return;
      if(s.points&&!s.fill&&s.width>0)copper({...s,kind:"track"},parent,"shape"+index);
      else if(s.fill&&(s.net||physical)&&s.points?.length>2)region(s,parent);else geo.excluded++;
    }
    // Filled copper (teardrops, copper graphics): the real filled area, as convex pieces
    // of one object, so clearance sees copper anywhere inside the outline.
    function region(i,parent){
      const sp=layerSpan({...i,kind:"region"},parent);if(!sp)return;
      const net=i.net||"",obj=geo.objects++;
      if(nettedCopperOnly&&!net)return;
      const pts=parent?i.points.map(p=>A.world(p,parent)):i.points;
      const subject=copperSubject(i,parent,i.fillRect?"fill":"region",pts[0]),kind=subject.kind;
      const base={...subject,obj,label:(i.teardrop?"Teardrop":kind==="fill"?"Copper fill":"Copper region")+" ("+spanName(sp)+")"+(net?" "+net:""),region:true};
      if(!net){geo.unassigned++;if(!physical)return;}
      const r=Math.max(0,(i.width||0)/2);
      if(i.regionShape&&!globalThis.AtriumBoardShape&&typeof require==="function")require("../pcb/board-shape-core.js");
      const S=globalThis.AtriumBoardShape,exact=i.regionShape&&S?.regionOf(i);
      if(exact?.cutouts?.length){
        const project=loop=>{
          const points=S.flattenContour(loop,.001);
          return parent?points.map(p=>A.world(p,parent)):points;
        };
        const outer=project(exact.contour),holes=exact.cutouts.map(project);
        const pieces=[...edges(outer).map(core=>feature(base,core,i.strokeOutline?r:0)),
          ...holes.flatMap(loop=>edges(loop).map(core=>feature(base,core,0)))];
        geo.copper.push({...compound(base,pieces),regions:[{outer,holes}]});
        return;
      }
      const pieces=fillPieces(pts);
      // One broad-phase feature per region; gap() measures to its convex pieces.
      if(pieces){geo.copper.push(compound(base,pieces.map(piece=>feature(base,piece,r))));return;}
      // Not a simple polygon: check its outline and report it as unchecked fill.
      geo.excluded++;
      if(physical)return;
      for(let n=0;n<pts.length;n++)geo.copper.push(feature(base,[pts[n],pts[(n+1)%pts.length]],r));
    }
    for(const item of options.items??doc.items) {
      if(holesOnly&&!["via","pad","part"].includes(item.kind))continue;
      if(["track","via","pad"].includes(item.kind))copper(item,null,null);
      else if(item.kind==="graphic"&&item.keepout!==true){
        if(SILK.has(item.layer))silk(item,item.layer,item.id,null,"Overlay line ("+layerLabel(item.layer)+")");
        else if(copperIndex(item.layer)!=null||item.layer==="Multi"){if(item.points&&!item.fill&&item.width>0)copper({...item,kind:"track"},null,"graphic");else if(item.fill&&item.points?.length>2)region(item,null);else geo.excluded++;}
      }
      else if(item.kind==="label"&&SILK.has(item.layer))geo.silkText++;
      else if(item.kind==="part") {
        const view=globalThis.AtriumPCBAppearance;
        const fp=(view?.readDefinition?.(defs,item.def,doc)??defs.get(item.def))?.footprint;
        (fp?.pads||[]).forEach((p,n,pads)=>{if(!holesOnly||p.drill>0)copper({...p,kind:"pad"},item,n,pads.length);});
        if(holesOnly)continue;
        // Net-tie bridge copper (net-ties.js) carries the tie's first net, so other nets keep their clearance from it.
        const tie=globalThis.AtriumNetTies?.bridgeNet(item,defs);
        (fp?.shapes||[]).forEach((s,j)=>shape(tie&&!s.net&&s.layer?{...s,net:tie}:s,item,j));
      }
    }
    return geo;
  }
  // Build physical legend ink per board primitive, keeping strokes and contours
  // together under one owner/slot. Layer and kind describe the ink, not the part.
  function legendInk(doc,defs,project,start=0,textOnly=false){
    const PCB=globalThis.AtriumPCBAppearance,T=globalThis.AtriumPCBText,S=globalThis.AtriumBoardShape;
    const {flatten,artworkInk,artworkFrame,placeEdge}=AtriumGeometryCurves;
    const features=[];
    let unavailable=0;
    function collect(item,layer,owner,frame,slot){
      if(!SILK.has(layer)||item.keepout||item.cutout)return;
      const text=item.kind==="text"||item.kind==="label";
      if(textOnly&&!text)return;
      const place=p=>frame?A.world(p,frame):p;
      const pieces=[],regions=[];
      const add=(core,radius)=>pieces.push(feature({},core,radius));
      function stroke(points,width,closed=false){
        const r=width/2;
        if(points.length===1)add(points,r);
        for(let n=1;n<points.length;n++)add([points[n-1],points[n]],r);
        if(closed&&points.length>1&&!A.same(points[0],points.at(-1)))add([points.at(-1),points[0]],r);
      }
      function fill(outer,holes=[]){
        if(outer.length<3)return;
        regions.push({outer,holes});
        for(const ring of [outer,...holes])stroke(ring,0,true);
      }
      const width=item.width>0?item.width:frame ? .15 : .18;
      let kind;
      if(text){
        kind="text";
        if(!item.text)return;
        if(!T){unavailable++;return;}
        const ink=T.physicalInk(item,doc,project,{frame,layer});
        if(ink.unsupported||ink.fallback)unavailable++;
        for(const path of ink.strokes)stroke(path.points,path.width);
        for(const shape of ink.polygons)fill(shape.outer,shape.holes);
      }else if(item.dimension){
        // Dimensions aren't independent tracks or text. Retain their scope as dimensions.
        if(item.dimension.export!==false)unavailable++;
        return;
      }else if(item.kind==="pad"||slot?.startsWith("pad:")){
        kind="pad";
        if(item.drill>0)return;
        const pad=padCore(item,[item.x,item.y],item.angle||0);
        if(!pad){unavailable++;return;}
        add(pad.core.map(place),pad.radius);
      }else{
        const source=item.regionShape&&!S?{...item,regionShape:null}:item;
        const transform=frame&&artworkFrame(frame);
        // Source contours can have rounded joints. Project their edges separately.
        const contour=(edges,closed)=>edges.flatMap((edge,n)=>{
          const points=edge.kind==="line"?[place(edge.a),place(edge.b)]:flatten([placeEdge(edge,transform)],EPS);
          return closed||n<edges.length-1?points.slice(0,-1):points;
        });
        if(!artworkInk(source,width,(ink,variant,analytic)=>{
          if(variant==="disk"){
            const [edge]=ink.islands[0].outer;
            kind="fill";add([place(edge.center)],edge.radius);
          }else{
            if(variant!=="outline")kind=analytic?(ink.kind==="stroke"?"arc":"region"):
              item.fill?(item.regionShape?"region":"fill"):"track";
            const closed=variant==="outline";
            if(ink.kind==="stroke")stroke(contour(ink.centerline,closed),ink.width,closed);
            else for(const {outer,holes} of ink.islands)fill(contour(outer,true),holes.map(ring=>contour(ring,true)));
          }
        },shape=>!shape.fill||shape.points.length>=3||shape.strokeOutline&&shape.width>0?shape:null))unavailable++;
      }
      if(!pieces.length)return;
      const side=layer==="Silk"?0:127,group=owner.id;
      const label=(kind==="text"?"Overlay text "+JSON.stringify(item.text):"Overlay "+kind)+(owner.kind==="part"?" "+owner.ref:"")+" ("+layerLabel(layer)+")";
      const base={id:group,obj:start+features.length,group,free:owner.kind!=="part",item,parent:owner.kind==="part"?owner:null,
        kind,layer,side,net:"",component:owner.ref,label,slot,at:pieces[0].core[0]};
      features.push({...compound(base,pieces),...base,...(regions.length?{regions}:null)});
    }
    for(const item of doc.items){
      if(item.kind!=="part"){
        if(["label","graphic","track","pad"].includes(item.kind))
          collect(item,item.layer||(item.kind==="label"?"Silk":null),item,null,null);
        continue;
      }
      const def=defs.get(item.def),fp=def?.footprint;
      if(!fp)continue;
      (fp.shapes||[]).forEach((s,n)=>{
        const layer=PCB?.shapeLayer(item,s)??s.layer??(s.style==="silk"?(item.layer==="Bottom"?"Bottom silk":"Silk"):null);
        collect(s,layer,item,item,"shape:"+n);
      });
      if(!textOnly)(fp.pads||[]).forEach((pad,n)=>collect(pad,PCB?.padLayer(item,pad)??pad.layer,item,item,"pad:"+n));
      if(!PCB)continue;
      for(const row of PCB.partText(doc,item,def))
        collect(row.text,row.text.layer,item,null,row.kind==="annotation"?"label:"+row.index:"reference");
    }
    return {features,unavailable};
  }
  // Authoring checks use the rules' mask expansion rather than output-job defaults.
  function legendMaskCheck(doc,defs,R,ink,flag,notes){
    if(!ink.length)return 0;
    const M=globalThis.AtriumMaskOpenings,PCB=globalThis.AtriumPCBAppearance;
    if(!M||!PCB){notes.push("Legend-to-mask clearance needs the solder mask openings module.");return 0;}
    const policy={maskExpansion:DEFAULT_SOLDER},openings=[];
    let maxExpansion=0;
    function padFeature(subject,profile){
      if(!(profile?.w>0&&profile.h>0))return null;
      const {core,r}=M.openingShape(profile,subject.at);
      if(profile.shape!=="custom")return feature(subject,core,r);
      const parts=fillPieces(core);
      return parts?compound(subject,parts.map(part=>feature(subject,part,0))):null;
    }
    function collect(pad,parent,padIndex){
      if(!(pad.w>0&&pad.h>0))return;
      const layer=PCB.padLayer(parent,pad),drill=pad.drill||0;
      for(const face of M.padFaces(layer,drill,PCB.index(layer)>=0)){
        const side=face==="Top"?0:127;
        const effective=M.padLand(pad,face), land=M.placedProfile(effective,parent), place=AtriumResolvedLand.place(effective,parent);
        const subject={...copperSubject(pad,parent,"pad",place.at),item:pad,part:parent,
          net:PCB.padNet(pad,parent)||"",layer,side,padIndex,
          label:"Pad "+(parent?parent.ref+"-":"")+(pad.number||"?")+" ("+layerLabel(face)+")"};
        const rule=R.first("solderMask",{...subject,layer:face,span:[side,side]});
        const mask=M.pad(pad,parent,face,{find:()=>rule});
        if(!mask)continue;
        const expansion=mask.ownExpansion??mask.ruleExpansion??policy.maskExpansion;
        const opening=padFeature(subject,M.aperture(mask,land,policy));
        const copper=drill<Math.min(land.w,land.h)-EPS||pad.plotLand===true?padFeature(subject,land):null;
        // Native rules offset the copper outline by the authored expansion.
        // Explicit mask rules measure to the opening's actual flashed shape.
        const legacy=(mask.open||mask.ownExpansion!=null||!mask.ruleTent)&&M.expandPad(land,expansion)?copper:null;
        if(!opening&&!legacy)continue;
        const box=opening&&legacy?opening.box.map((x,i)=>i<2?Math.min(x,legacy.box[i]):Math.max(x,legacy.box[i])):(opening||legacy).box;
        openings.push({subject,box,side,legacy,expansion,opening,exposed:opening&&copper?(expansion<0?opening:copper):null});
        if(legacy)maxExpansion=Math.max(maxExpansion,expansion);
      }
    }
    for(const item of doc.items){
      if(item.kind==="pad")collect(item,null);
      if(item.kind==="part")PCB.readDefinition(defs,item.def,doc)?.footprint?.pads?.forEach((pad,n)=>collect(pad,item,n));
    }
    const reach=Math.max(...R.byType.silkToMask.map(rule=>rule.gap))+maxExpansion;
    return pairs(ink.concat(openings),reach,(a,b)=>{
      if(!!a.subject===!!b.subject||a.side!==b.side)return;
      const [text,pad]=a.subject?[b,a]:[a,b];
      const rule=R.either("silkToMask",pad.subject,text);
      if(!rule||!(rule.gap>0))return;
      const offset=rule.exposedCopper==null?pad.expansion:0;
      const surface=rule.exposedCopper==null?pad.legacy:rule.exposedCopper?pad.exposed:pad.opening;
      if(!surface||rule.gap+offset<=0)return;
      const separation=pieceGap(text,surface,rule.gap+offset),actual=Math.max(0,separation.d-offset);
      if(actual+EPS>=rule.gap)return;
      const anchor=[text.item.x,text.item.y];
      const textAt=text.parent&&text.slot!=="reference"?A.world(anchor,text.parent):anchor;
      const legendPrimitive=surface.padIndex==null?text.slot:(text.slot||"label")+"/pad:"+surface.padIndex;
      flag(rule,{id:text.id,otherId:surface.id,at:separation.at,otherAt:surface.at,actual,required:rule.gap,limit:"min",
        title:text.label+" ↔ "+(rule.exposedCopper?"exposed copper of ":"mask opening of ")+surface.label,
        text:text.item.text,textAt,layer:text.layer,padNumber:surface.pin,padIndex:surface.padIndex,
        ...(legendPrimitive?{subject:{legendPrimitive}}:null)});
    });
  }

  const noLegend=()=>({features:[],unavailable:0});

  // Uniform-grid broad phase. Calls visit(a,b) once for each pair whose boxes are
  // within `reach`. Very large features are compared with every other feature.
  function pairs(F,reach,visit){
    const n=F.length;if(n<2)return 0;
    const sample=[],stride=Math.max(1,Math.floor(n/1024));
    for(let i=0;i<n;i+=stride){const b=F[i].box;sample.push(Math.max(b[2]-b[0],b[3]-b[1]));}
    sample.sort((a,b)=>a-b);
    const size=Math.max(sample[Math.floor(sample.length*.75)]||0,reach,.05),OFF=1048576,SPAN=2097152;
    // The Rust/WebAssembly broad phase (engine-core.js) visits the same pairs in the same order.
    const E=globalThis.AtriumEngine;
    if(n>=512&&E?.gridPairs){
      const boxes=new Float64Array(4*n);
      for(let i=0;i<n;i++){const b=F[i].box;boxes[4*i]=b[0];boxes[4*i+1]=b[1];boxes[4*i+2]=b[2];boxes[4*i+3]=b[3];}
      const p=E.gridPairs(boxes,size,reach);
      if(p){for(let k=0;k<p.length;k+=2)visit(F[p[k]],F[p[k+1]]);return p.length/2;}
    }
    const cells=new Map(),big=[],isBig=new Uint8Array(n),cell=v=>Math.floor(v/size);
    for(let i=0;i<n;i++){
      const b=F[i].box,x0=cell(b[0]),y0=cell(b[1]),x1=cell(b[2]),y1=cell(b[3]);
      if((x1-x0+1)*(y1-y0+1)>4096){big.push(i);isBig[i]=1;continue;}
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const k=(x+OFF)*SPAN+(y+OFF);let c=cells.get(k);if(!c)cells.set(k,c=[]);c.push(i);}
    }
    const stamp=new Int32Array(n).fill(-1);let candidates=0;
    const near=(a,o)=>!(o[0]-a[2]>reach||a[0]-o[2]>reach||o[1]-a[3]>reach||a[1]-o[3]>reach);
    for(let i=0;i<n;i++){
      if(isBig[i])continue;
      const b=F[i].box,x0=cell(b[0]-reach),y0=cell(b[1]-reach),x1=cell(b[2]+reach),y1=cell(b[3]+reach);
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const c=cells.get((x+OFF)*SPAN+(y+OFF));if(!c)continue;
        for(const j of c){if(j<=i||stamp[j]===i)continue;stamp[j]=i;if(!near(b,F[j].box))continue;candidates++;visit(F[i],F[j]);}
      }
    }
    for(const i of big)for(let j=0;j<n;j++){if(j===i||isBig[j]&&j<i||!near(F[i].box,F[j].box))continue;candidates++;visit(F[i],F[j]);}
    return candidates;
  }

  // ---------------------------------------------------------------- lengths
  function boardThickness(doc){
    try{const t=globalThis.AtriumStackup?.thickness?.(doc);if(Number.isFinite(t)&&t>0)return t;}catch{/* fall back to the board record */}
    return Number.isFinite(doc.thickness)&&doc.thickness>0?doc.thickness:null;
  }
  // Routed length per net: AtriumLength.netLengths (length-tuning.js), the one length engine, so Length
  // DRC reads the numbers the Length Manager, Delay DRC, the Constraint Manager and MCP show: pad to pad
  // for two-pad nets, else the total copper; via barrels between the copper layers they connect; die length.
  function netLengths(doc,defs,options={}){
    const L=globalThis.AtriumLength;if(!L?.netLengths)throw new Error("Net lengths need the length module (length-tuning.js).");
    return L.netLengths(doc,defs,options);
  }

  // ---------------------------------------------------------------- scope coverage
  // Rule scopes that match no object on the board: such a rule silently checks nothing.
  // Objects tried: copper, tracks, vias, holes, pads and overlay features, every net, every
  // component and every polygon. Returns [{id, name, type, which:"scope"|"scope2", query, enabled}].
  function scopeObjects(doc,defs,set,geo,legend=noLegend()){
    const extra=[];
    for(const net of boardNets(doc,set))extra.push(netSubject(net));
    for(const i of doc.items){
      if(i.kind==="part"&&i.ref)extra.push({id:i.id,item:i,component:i.ref,kind:"part",layer:i.layer==="Bottom"?"Bottom":"Top",span:sideSpan(i.layer==="Bottom"?"Bottom":"Top"),at:[i.x,i.y],box:[i.x,i.y,i.x,i.y]});
      else if(i.kind==="polygon"&&Array.isArray(i.points)&&i.points.length>2){const b=A.bounds(i.points);extra.push({kind:"polygon",net:i.net||"",layer:i.layer||null,span:sideSpan(i.layer),polygon:i.name||"",id:i.id,at:i.points[0],box:b});}
    }
    return [geo.copper,geo.tracks,geo.vias,geo.holes,geo.pads,geo.silk,legend.features,extra];
  }
  /** @param {(rule: any) => boolean} [keep] the rules to look at (default all) */
  function emptyScopes(doc,defs,R,geo,keep=()=>true,legend=noLegend()){
    const lists=scopeObjects(doc,defs,R.set,geo,legend),seen=new Map(),out=[];
    const matches=s=>{
      const k=JSON.stringify(s);if(seen.has(k))return seen.get(k);
      const m=R.matcher(s);let hit=false;
      outer:for(const L of lists)for(const o of L)if(m(o)){hit=true;break outer;}
      seen.set(k,hit);return hit;
    };
    for(const r of R.set.list){
      if(!keep(r))continue;
      for(const which of ["scope","scope2"]){const s=r[which];if(allScope(s)||R.diagnostics.some(d=>d.ruleId===r.id&&d.side===which))continue;
        if(!matches(s))out.push({id:r.id,name:r.name,type:r.type,which,query:scopeQuery(s),enabled:r.enabled});}
    }
    return out;
  }
  function scopeCoverage(board,defs,options={}){
    if(board?.kind!=="pcb")return [];
    const R=compile(migrate(options.rules??stored(board,options.project)),{doc:board,project:options.project,explicit:options.rules!=null});
    defs??=new Map();
    const geo=options.geo||extract(board,defs);
    const outlineInk=R.byType.boardOutlineClearance.some(r=>r.includeOverlay);
    const legend=outlineInk||R.byType.silkToMask.length?legendInk(board,defs,options.project,geo.objects,!outlineInk):noLegend();
    return emptyScopes(board,defs,R,geo,undefined,legend);
  }
  const coverageNote=e=>TYPES[e.type].title+" rule "+e.name+": the "+(e.which==="scope2"?"second":"first")+" scope "+e.query+" matches no objects on this board, so the rule checks nothing.";

  // These settings select checks only. The same enabled rules still govern routing and pours.
  function checkMode(options={}){return options.checkMode ?? (options.types!=null ? "all" : "batch");}
  // Checks that run only when asked for, by type (options.types: MCP, tests) or by the user's
  // preference (Preferences › Design Checks). Altium has no missing-courtyard check and many imported
  // footprints have no courtyard, so Missing Courtyard is off by default. A board's exclusions still apply.
  const OPT_IN=Object.freeze({courtyard:"checks.courtyard"});
  function optedIn(type,options){
    const key=OPT_IN[type];
    if(!key||options.types?.includes(type))return true;
    try{return globalThis.AtriumPref?.get?.(key,false)===true;}catch{return false;}
  }
  function checkSelected(doc,type,options={}){
    const mode=checkMode(options);
    return (!options.types||options.types.includes(type))&&optedIn(type,options)&&!doc?.ruleCheckSelection?.[mode]?.includes(type);
  }

  // ---------------------------------------------------------------- design rule check
  // AtriumRules.drc(board, defs, rules?, {types, limit, connections, legacyLabels})
  // types: rule types to run (default all). limit: violations kept per rule.
  // connections: an AtriumConnectivity.inspect result, or a function returning one.
  function drc(doc,defs,rules,options={}){
    if(doc?.kind!=="pcb")throw Error("Open a PCB layout to check board rules.");
    const scopeDoc=options.scopeDoc??doc,source=options.compiled?null:stored(scopeDoc,options.project);
    validate(rules??=options.compiled?.set??source??defaults(),{allowFuture:true,allowUnknown:true});
    const started=now(),set=options.compiled?.set??migrate(rules,options.legacyLabels),
      compiled=options.compiled??compile(set,{doc:scopeDoc,defs,project:options.project,explicit:rules!==source});
    let R=compiled;
    const mode=checkMode(options),excluded=scopeDoc.ruleCheckSelection?.[mode],
      only=options.types||excluded?new Set((options.types??ORDER).filter(t=>!excluded?.includes(t))):null;
    const active=t=>(!only||only.has(t))&&R.byType[t].length>0;
    const cap=options.limit??2000,tallies=new Map(),violations=[],notes=[],stats={candidates:0};
    if(excluded&&mode==="batch")notes.push("Using the imported Altium batch check selection.");
    function flag(r,v){
      let t=tallies.get(r.id);if(!t)tallies.set(r.id,t={count:0});
      if(++t.count<=cap)violations.push({type:r.type,ruleId:r.id,ruleName:r.name,source:r.label||r.name,...(set.ruleSets?{ruleSet:ruleSetOf(r)}:null),...v});
    }
    R.measurementIssues.clear();
    const geo=options.geo??extract(doc,defs,options.padSlots ? {padSlots:true} : undefined);
    // hs-xsignals: Length, Propagation Delay and Matched Lengths/Delays rules scoped to xSignals
    // (InxSignal / InxSignalClass) are checked per xSignal by xsignals.js, not per net.
    const xsBy={};
    for(const t of NET_TIMING_RULES)xsBy[t]=compiled.byType[t].filter(XS_SCOPE);
    if(Object.values(xsBy).some(l=>l.length)){
      const byType={...compiled.byType};
      for(const t of Object.keys(xsBy))byType[t]=byType[t].filter(r=>!XS_SCOPE(r));
      R={...compiled,byType,first:(type,o)=>xsBy[type]?.length?byType[type].find(r=>r.m1(o))??null:compiled.first(type,o)};
    }
    const ties=globalThis.AtriumNetTies?.drcTies(doc,defs)||null;
    const outlineInk=active("boardOutlineClearance")&&R.byType.boardOutlineClearance.some(r=>r.includeOverlay);
    const legend=outlineInk||active("silkToMask") ? legendInk(doc,defs,options.project,geo.objects,!outlineInk) : noLegend();
    // Scopes that match nothing (full runs only: online DRC checks a part of the board).
    const empty=options.scopes===false||options.types&&options.scopes!==true?[]:emptyScopes(doc,defs,R,geo,r=>ruleActive(set,r)&&CHECKED.has(r.type)&&!RIGID_FLEX.has(r.type),legend);
    for(const e of empty)notes.push(coverageNote(e));
    const best=(map,key,v)=>{const p=map.get(key);if(!p||v.actual<p.actual)map.set(key,v);};
    const pairKey=(a,b)=>Math.min(a,b)*67108864+Math.max(a,b);
    if(active("clearance")){
      const F=geo.copper.filter(f=>f.net),found=new Map(),CR=R.byType.clearance;
      const reach=Math.max(...CR.map(clearanceMax));
      stats.candidates+=pairs(F,reach,(a,b)=>{
        if(a.net===b.net||a.span[1]<b.span[0]||b.span[1]<a.span[0]||ties&&ties.skip(a,b))return;
        const r=R.clearanceRule(a,b);if(!r)return;
        const need=clearanceGap(r,a.ck,b.ck);
        if(a.box[0]-b.box[2]>=need||b.box[0]-a.box[2]>=need||a.box[1]-b.box[3]>=need||b.box[1]-a.box[3]>=need)return;
        const g=pieceGap(a,b,need);if(g.d+EPS>=need)return;
        best(found,pairKey(a.obj,b.obj),{r,id:a.id,otherId:b.id,title:a.label+" ↔ "+b.label,actual:g.d,required:need,limit:"min",at:g.at,otherAt:g.at,...(r.objects?{kinds:[a.ck,b.ck]}:null)});
      });
      // Hole cells of the matrix: drilled holes against copper of other nets (the hole's
      // own pad or via is skipped). Only rules that set a hole cell check holes.
      if(geo.holes.length&&CR.some(r=>r.objects&&Object.keys(r.objects).some(k=>k.endsWith("-hole")))){
        const H=F.concat(geo.holes),hreach=Math.max(0,...CR.map(r=>Math.max(0,...Object.keys(r.objects||{}).filter(k=>k.endsWith("-hole")).map(k=>r.objects[k]))));
        stats.candidates+=pairs(H,hreach,(a,b)=>{
          if((a.ck==="hole")===(b.ck==="hole"))return;
          const h=a.ck==="hole"?a:b,c=h===a?b:a;
          if(h.obj===c.obj||h.net&&h.net===c.net||h.span[1]<c.span[0]||c.span[1]<h.span[0]||ties&&h.net&&ties.skip(h,c))return;
          const r=R.clearanceRule(h,c),need=clearanceLimit(r,h.ck,c.ck);if(need==null)return;
          const g=pieceGap(h,c,need);if(g.d+EPS>=need)return;
          best(found,pairKey(h.obj,c.obj)+.5,{r,id:h.id,otherId:c.id,title:"Hole of "+h.label+" ↔ "+c.label,what:"Hole clearance",actual:g.d,required:need,limit:"min",at:g.at,otherAt:c.at||g.at,kinds:["hole",c.ck]});
        });
      }
      for(const {r,...v} of found.values())flag(r,v);
      if(CR.some(r=>r.objects&&Object.keys(r.objects).some(k=>/(^|-)(poly|text)(-|$)/.test(k))))notes.push("Clearance matrix cells for polygons and text are kept for Altium round trips; polygon pours use their own clearance and copper text is not checked.");
      // Keep-outs (pcb-draw.js): copper touching a keep-out on a shared layer.
      if(globalThis.AtriumPCBDraw?.keepoutViolations)for(const v of AtriumPCBDraw.keepoutViolations(doc,defs,{limit:cap}))flag(R.byType.clearance[0],{...v,limit:"min"});
      // Teardrops left behind by an edit to their track, pad or via.
      if(!options.legacyLabels)for(const t of staleTeardrops(doc,defs)){
        const r=R.clearanceRule({net:t.net,layer:t.layer,span:sideSpan(t.layer)},{net:"",layer:t.layer,span:sideSpan(t.layer)})||R.byType.clearance[0];
        flag(r,{id:t.id,title:"Stale teardrop ("+layerLabel(t.layer)+")"+(t.net?" "+t.net:""),what:"Stale teardrop",detail:"Stale teardrop: "+t.reason+". Add teardrops again (Tools → Teardrops) or delete it.",at:t.at,stale:true});
      }
    }
    const IMP=globalThis.AtriumImpedance;
    const zText=(p,v)=>{const z=IMP?.solve?.({...p.geom,...v});return z?.ok?" · Z "+(v.s!=null?z.zdiff:z.z).toFixed(1)+" Ω (profile "+p.target+" Ω ±"+p.tolerance+" %)":"";};
    if(active("width"))for(const t of geo.tracks){
      const r=R.first("width",t);if(!r||!Number.isFinite(t.width))continue;
      // Rigid-flex: each substack the track runs through has its own profile values.
      const parts=r.impedanceProfile&&globalThis.AtriumRigidFlex?.stacksAlong?.(doc,t.points)||[{stack:null}];
      let profiled=false;
      for(const part of parts){
        const p=profileAt(r,t.item.layer||"Top",doc,R.profiles,part.stack);
        if(!p)continue;profiled=true;
        const low=t.width+EPS<p.minWidth,high=t.width-EPS>p.maxWidth;
        if(low||high){flag(r,{id:t.id,title:t.label+(parts.length>1||part.stack&&part.stack!=="main"?" in "+part.regionName:"")+zText(p,{w:t.width}),what:"Impedance width",actual:t.width,required:low?p.minWidth:p.maxWidth,limit:low?"min":"max",at:part.at||t.at,profile:r.impedanceProfile});break;}
      }
      if(profiled)continue;
      const {min,max}=widthAt(r,t.layer);
      if(min!=null&&t.width+EPS<min)flag(r,{id:t.id,title:t.label,actual:t.width,required:min,limit:"min",at:t.at});
      else if(max!=null&&t.width-EPS>max)flag(r,{id:t.id,title:t.label,actual:t.width,required:max,limit:"max",at:t.at});
    }
    if(active("routingLayers"))for(const t of geo.tracks){
      const r=R.first("routingLayers",t);
      if(r&&r.excluded.includes(t.item.layer||"Top"))flag(r,{id:t.id,title:t.label,detail:"Layer "+layerLabel(t.item.layer||"Top")+" is not allowed for routing",at:t.at});
    }
    if(active("viaStyle"))for(const v of geo.vias){
      const {land,hole}=R.viaStyle(v),i=v.item;
      const test=(r,actual,min,max,what,field)=>{
        if(!r||!Number.isFinite(actual))return;
        if(min!=null&&actual+EPS<min)flag(r,{id:v.id,title:v.label,what,field,actual,required:min,limit:"min",at:v.at});
        else if(max!=null&&actual-EPS>max)flag(r,{id:v.id,title:v.label,what,field,actual,required:max,limit:"max",at:v.at});
      };
      test(hole,i.drill,hole?.holeMin,hole?.holeMax,"Via hole","hole");
      test(land,i.diameter,land?.diameterMin,land?.diameterMax,"Via diameter","diameter");
    }
    if(active("holeSize"))for(const h of geo.holes){
      const r=R.first("holeSize",h);if(!r)continue;const d=h.radius*2;
      if(r.min!=null&&d+EPS<r.min)flag(r,{id:h.id,title:h.label,what:"Hole",actual:d,required:r.min,limit:"min",at:h.at});
      else if(r.max!=null&&d-EPS>r.max)flag(r,{id:h.id,title:h.label,what:"Hole",actual:d,required:r.max,limit:"max",at:h.at});
    }
    if(active("annularRing"))for(const h of geo.holes){
      if(h.ring==null)continue;const r=R.first("annularRing",h);
      if(r&&h.ring+EPS<r.min){
        const actual=Math.max(0,h.ring),subject={ring:actual};
        if(h.padIndex!=null)Object.assign(subject,{padIndex:h.padIndex},A.footprintPadKeys(h.parent.def,h.item,h.padIndex,h.padCount));
        flag(r,{id:h.id,title:h.label,what:"Annular ring",actual,required:r.min,limit:"min",at:h.at,subject});
      }
    }
    if(active("holeToHole")){
      const reach=Math.max(...R.byType.holeToHole.map(r=>r.gap)),found=new Map(),stack=globalThis.AtriumViaStack;
      let keys;const micro=h=>h.kind==="via"&&(stack?stack.isMicrovia(h.item,keys??=stack.keysOf(doc,null,defs)):h.item.microvia===true);
      stats.candidates+=pairs(geo.holes,reach,(a,b)=>{
        if(a.span[1]<b.span[0]||b.span[1]<a.span[0])return;
        const r=R.either("holeToHole",a,b);if(!r)return;
        const touches=a.span[1]===b.span[0]||b.span[1]===a.span[0];
        if(touches&&dist(a.at,b.at)<=EPS){
          if(r.allowStackedMicrovias===false&&micro(a)&&micro(b))
            flag(r,{id:a.id,otherId:b.id,title:a.label+" ↔ "+b.label,detail:"Stacked microvias are disallowed",at:a.at});
          return;
        }
        const {d,at}=gap(a,b);if(d+EPS>=r.gap)return;
        best(found,pairKey(a.obj,b.obj),{r,id:a.id,otherId:b.id,title:a.what+" hole "+a.label+" ↔ "+b.what+" hole "+b.label,actual:d,required:r.gap,limit:"min",at,otherAt:b.at});
      });
      for(const {r,...v} of found.values())flag(r,v);
    }
    if(active("fabricationTestpoint")){
      for(const o of geo.testpoints){
        const i=o.item;
        for(const side of ["Top","Bottom"]){
          if(i.fabTestpoint!==side&&i.fabTestpoint!=="Both")continue;
          const idx=copperIndex(side),r=R.first("fabricationTestpoint",{...o,layer:side,span:[idx,idx]});if(!r)continue;
          const location={id:o.id,title:o.label+" · "+side+" fabrication testpoint",at:o.at};
          if(!r[side==="Top"?"allowTop":"allowBottom"])flag(r,{...location,detail:"Fabrication testpoint side is disallowed"});
          const land=i.kind==="via"?globalThis.AtriumViaStack?.padOn(i,side)??{diameter:i.diameter,shape:i.shape||"round"}:null;
          const size=land?(land.shape==="round"?land.diameter:null):i.shape==="round"&&Math.abs(i.w-i.h)<EPS?i.w:null;
          for(const [what,actual,min,max] of [["Land diameter",size,r.minSize,r.maxSize],["Drill",i.drill||0,r.minHole,r.maxHole]]){
            if(!Number.isFinite(actual))continue;
            if(actual+EPS<min)flag(r,{...location,what,actual,required:min,limit:"min"});
            else if(max!=null&&actual-EPS>max)flag(r,{...location,what,actual,required:max,limit:"max"});
          }
        }
      }
    }
    if(active("componentHeight")){
      let unknown=0;
      for(const part of doc.items)if(part.kind==="part"){
        const at=[part.x,part.y],o={id:part.id,item:part,kind:"part",component:part.ref,at,layer:part.layer||"Top",box:[...at,...at]};
        const r=R.first("componentHeight",o);if(!r)continue;
        const bodies=part.bodies3d,height=bodies?.length?bodies.every(b=>Number.isFinite(b.maxZ))?Math.max(...bodies.map(b=>b.maxZ)):null:part.height??defs.get(part.def)?.footprint?.height;
        if(!Number.isFinite(height)){unknown++;continue;}
        if(height+EPS<r.min||r.max!=null&&height-EPS>r.max){const low=height+EPS<r.min;flag(r,{id:part.id,title:part.ref||"Component",what:"Component height",at,actual:height,required:low?r.min:r.max,limit:low?"min":"max"});}
      }
      if(unknown)notes.push(unknown+" components have no authored height for the Height rule.");
    }
    let copperReport;
    if(active("modifiedPolygon")&&doc.items.some(i=>i.kind==="polygon"&&!i.cutout)){
      const P=globalThis.AtriumPolygonPour;
      if(!P)notes.push("Modified Polygon checks need the polygon pour module.");
      else{
        copperReport=P.inspectCopper(doc,defs,{project:options.project});
        if(copperReport.state==="pending"||copperReport.state==="unknown")
          notes.push("Modified Polygon checks are waiting for copper verification.");
        const changed=new Set(copperReport.stale);
        for(const i of doc.items)if(i.kind==="polygon"&&!i.cutout&&i.points?.length){
          const r=R.first("modifiedPolygon",{id:i.id,item:i,kind:"polygon",polygon:i.name||"",net:i.net||"",layer:i.layer,at:i.points[0],box:A.bounds(i.points)});
          if(r&&(i.shelved?!r.allowShelved:changed.has(i.id)&&!r.allowModified))flag(r,{id:i.id,title:i.name||"Polygon",detail:i.shelved?"Polygon is shelved":"Polygon needs to be repoured",at:i.points[0]});
        }
      }
    }
    if(active("boardOutlineClearance"))edgeCheck(doc,geo,outlineInk?legend:null,R,flag,notes,stats);
    if(active("silkToMask")&&geo.silk.length&&geo.pads.length){
      const openings=[];
      for(const p of geo.pads){
        const sides=[p.span[0]===0?0:null,p.span[1]===127?127:null].filter(x=>x!=null);
        for(const side of sides){
          const layer=side===0?"Top":"Bottom",mask=R.first("solderMask",{...p,layer,span:[side,side]}),top=side===0;
          const tent=p.item.tent?.[top?"top":"bottom"]??(Number.isFinite(p.item.maskExpansion)?false:mask?.[top?"tentTop":"tentBottom"]);
          const expansion=p.item.maskExpansion??mask?.expansion??DEFAULT_SOLDER;
          if(tent)continue;
          const shape=p.maskOnly?(expansion>0?{core:[p.at],radius:expansion}:null):padCore(p.item,p.at,(p.item.angle||0)+(p.parent?.angle||0),expansion);
          if(!shape)continue;
          const aperture=feature(p,shape.core,shape.radius);
          const box=p.box.map((v,k)=>k<2?Math.min(v,aperture.box[k]):Math.max(v,aperture.box[k]));
          openings.push({...aperture,box,land:p,expansion,exposed:p.maskOnly?null:expansion<0?aperture:p,side,role:1});
        }
      }
      const F=[...geo.silk.map(s=>({...s,role:0})),...openings];
      const reach=Math.max(...R.byType.silkToMask.map(r=>r.gap))+Math.max(0,...openings.map(o=>o.expansion)),found=new Map();
      stats.candidates+=pairs(F,reach,(a,b)=>{
        if(a.role===b.role)return;const s=a.role?b:a,p=a.role?a:b;
        if(p.side!==s.side)return;
        const r=R.either("silkToMask",p,s);if(!r)return;
        // Existing native rules keep their documented outline-offset measurement and marker.
        const legacy=r.exposedCopper==null,surface=legacy?p.land:r.exposedCopper?p.exposed:p;
        if(!surface||legacy&&p.land.maskOnly)return;
        const g=gap(s,surface),d=legacy?Math.max(0,g.d-p.expansion):g.d;if(d+EPS>=r.gap)return;
        best(found,pairKey(s.obj,p.obj),{r,id:s.id,otherId:p.id,title:s.label+" ↔ "+(r.exposedCopper?"exposed copper of ":"mask opening of ")+p.label,actual:d,required:r.gap,limit:"min",at:g.at,otherAt:p.at});
      });
      for(const {r,...v} of found.values())flag(r,v);
    }
    if(active("silkToMask")){
      if(!outlineInk&&legend.unavailable)notes.push(legend.unavailable+" overlay text objects had missing or substituted glyph geometry.");
      // The earlier mask pass owns linework even when outline clearance needs all overlay ink.
      const text=outlineInk?legend.features.filter(f=>f.kind==="text"):legend.features;
      stats.candidates+=legendMaskCheck(doc,defs,R,text,flag,notes);
    }
    if(active("silkToSilk")&&geo.silk.length){
      const reach=Math.max(...R.byType.silkToSilk.map(r=>r.gap)),found=new Map();
      stats.candidates+=pairs(geo.silk,reach,(a,b)=>{
        if(a.side!==b.side||a.group===b.group||a.free&&b.free)return;
        const r=R.either("silkToSilk",a,b);if(!r)return;
        const g=gap(a,b);if(g.d+EPS>=r.gap)return;
        best(found,pairKey(a.obj,b.obj),{r,id:a.id,otherId:b.id,title:a.label+" ↔ "+b.label,actual:g.d,required:r.gap,limit:"min",at:g.at,otherAt:g.at});
      });
      for(const {r,...v} of found.values())flag(r,v);
    }
    if(active("short")||active("unrouted")){
      let conn=null;
      // Without the un-routed check only shorts are read: no airwires (connectivity.js).
      try{conn=typeof options.connections==="function"?options.connections():options.connections||globalThis.AtriumConnectivity?.inspect(doc,defs,undefined,{airwires:active("unrouted"),project:options.project})||null;}
      catch(e){notes.push("Connectivity was unavailable: "+e.message);}
      if(!conn)notes.push("Short-circuit and un-routed net checks need the board connectivity module.");
      else{
        if(active("short"))for(const s of conn.shorts){
          let rule=null;
          for(const r of R.byType.short){if(s.nets.some(a=>s.nets.some(b=>a!==b&&r.m1(netSubject(a))&&r.m2(netSubject(b))))){rule=r;break;}}
          if(rule&&!rule.allowed)flag(rule,{id:s.fromId,otherId:s.toId,title:s.fromLabel+" ↔ "+s.toLabel,detail:"Short circuit between nets "+s.nets.join(", "),at:s.from,otherAt:s.to});
        }
        for(const t of conn.ties||[])notes.push("Net tie "+(t.ref||t.id)+" joins "+t.nets.join(" and ")+" (allowed short).");
        if(active("unrouted"))for(const a of conn.airwires){
          const r=R.first("unrouted",netSubject(a.net));
          if(r)flag(r,{id:a.fromId,otherId:a.toId,title:"Net "+a.net+" between "+a.fromLabel+" and "+a.toLabel,detail:"Un-routed connection",actual:a.distance,at:a.from,otherAt:a.to});
        }
      }
    }
    // Return path vias (via-fence.js): layer-changing signal vias need a reference via nearby.
    if(active("returnPathVia")){
      const F=globalThis.AtriumViaFence;
      if(!F)notes.push("Return path via checks need the via fencing module.");
      else{const nets=F.boardNets(doc,defs),seen=new Set();
        for(const r of R.byType.returnPathVia){
          const refs=nets.filter(n=>allScope(r.scope2)?F.isGround(n):r.m2(netSubject(n)));if(!refs.length)continue;
          const signal=(_net,via)=>r.m1(copperSubject(via,null,"via",[via.x,via.y]));
          for(const v of F.returnPathCheck(doc,defs,{signal,referenceNets:refs,distance:r.distance})){
            if(seen.has(v.id))continue;seen.add(v.id);flag(r,v);}
        }}
    }
    if(active("layerPairs")||active("hdiVias")){const VS=globalThis.AtriumViaStack;if(VS?.hdi)VS.hdi.drc(doc,defs,{first:(t,o)=>R.first(t,o),flag,notes,active});else notes.push("Layer pair and HDI via checks need the via stack module.");}/* hdi-drc */
    if(active("viaStub")){const VS=globalThis.AtriumViaStubs;if(VS)VS.drc(doc,defs,{first:(t,o)=>R.first(t,o),flag,notes,project:options.project});else notes.push("Via stub checks need the via stub module.");}
    if(active("zClearance")){const Z=globalThis.AtriumZClearance;if(Z)stats.candidates+=Z.drc(doc,defs,{geo,rules:R.byType.zClearance,first:(t,o)=>R.first(t,o),pairs,pieceGap,flag,notes,candidate:options.onRulePair})||0;else notes.push("Z-axis clearance checks need the Z-axis module (z-clearance.js).");}
    if(active("currentCapacity")){const CC=globalThis.AtriumIPC2152;if(CC)stats.candidates+=CC.drc(doc,defs,{rules:R.byType.currentCapacity,first:(t,o)=>R.first(t,o),flag,notes,geo,set,project:options.project})||0;else notes.push("Current capacity checks need the IPC-2152 module (ipc2152.js).");}
    if(active("creepage")){const K=globalThis.AtriumCreepage;if(K)stats.candidates+=K.drc(doc,defs,{geo,R,flag,notes,project:options.project})||0;else notes.push("Creepage checks need the creepage module (creepage.js).");}
    if(active("dfaSpacing")){const D=globalThis.AtriumDFA;if(D)D.drc(doc,defs,{rules:R.byType.dfaSpacing,flag,notes,stats});else notes.push("DFA spacing checks need the DFA module (dfa.js).");}
    if(active("componentClearance")){const C3=globalThis.AtriumCollision3D;if(C3)C3.drc(doc,defs,{rules:R.byType.componentClearance,flag,notes,stats,project:options.project});else notes.push("Component clearance checks need the 3D collision module (collision-3d.js).");}
    if(active("diffPairsRouting")&&R.pairs.size)diffPairCheck(geo,R,flag,doc,zText);
    if(active("width")||active("diffPairsRouting")){const IC=globalThis.AtriumImpedanceChecks;if(IC)IC.drc(doc,defs,{geo,R,flag,notes,sideSpan,project:options.project});}/* impedance checks: window, neck-down, reference (impedance-checks.js) */
    // Rigid-flex: regions, bends, stiffeners (rigid-flex.js).
    let flexBoard=false;
    try{flexBoard=!!globalThis.AtriumRigidFlex?.regionsResolved(doc,defs).split;}catch(e){notes.push("Rigid-flex checks skipped: "+e.message);}
    if(flexBoard&&[...RIGID_FLEX].some(active))AtriumRigidFlex.check(doc,defs,{geo,active:t=>active(t)&&RIGID_FLEX.has(t),first:(t,o)=>R.first(t,o),flag,notes});
    if(flexBoard&&(active("flexRouting")||active("flexBuild"))){const FD=globalThis.AtriumFlexDRC;if(FD)FD.drc(doc,defs,{geo,active,first:(t,o)=>R.first(t,o),flag,notes});else notes.push("Flex routing and construction checks need the flex DRC module (flex-drc.js).");}
    // Starved thermals: obstacles that cut relief spokes below the rule minimum.
    if(active("polygonConnect")&&R.byType.polygonConnect.some(r=>r.minEntries>0)&&(doc.pcbDrawing?.pours||[]).some(r=>r.polygon!=null)){
      const P=globalThis.AtriumPolygonPour;
      if(!P)notes.push("Polygon connect checks need the polygon pour module.");
      else{
        // A caller's intervening callbacks can change the board or project.
        const canReuse=copperReport&&typeof options.connections!=="function"&&!options.onRulePair;
        const checked=canReuse?copperReport:P.inspectCopper(doc,defs,{project:options.project});
        if(checked.state==="stale")notes.push("Polygon pours are out of date. Repour them to check thermal relief connections.");
        else if(checked.state!=="current")notes.push("Thermal relief checks are waiting for copper verification.");
        else for(const t of P.thermals(doc,defs,{rules:set})){
          const r=R.first("polygonConnect",{net:t.net,layer:t.layer,span:sideSpan(t.layer),component:t.component});if(!r)continue;
          if(t.connected<r.minEntries)flag(r,{id:t.id,title:t.label+" ("+layerLabel(t.layer)+") "+t.net,
            detail:"Starved thermal: "+t.connected+" of "+t.entries+" relief spokes connected, minimum "+r.minEntries,at:t.at,connected:t.connected,entries:t.entries,required:r.minEntries});
        }
      }
    }
    if(active("length")||active("matchedLengths")){
      const lengths=globalThis.AtriumLength?.netLengths?netLengths(doc,defs,{viaHeights:options.viaHeights}):null;
      if(!lengths)notes.push("Length checks need the length module (length-tuning.js).");
      else if(!boardThickness(doc))notes.push("Board thickness is unknown, so via heights use a 1.6 mm board.");
      if(lengths&&active("length"))for(const e of lengths.values()){
        const r=R.first("length",{...netSubject(e.net),length:e.length});if(!r)continue;
        if(e.length+EPS<r.min)flag(r,{id:e.id,title:"Net "+e.net,what:"Length",actual:e.length,required:r.min,limit:"min",at:e.first});
        else if(r.max!=null&&e.length-EPS>r.max)flag(r,{id:e.id,title:"Net "+e.net,what:"Length",actual:e.length,required:r.max,limit:"max",at:e.first});
      }
      if(lengths&&active("matchedLengths"))for(const g of matchedGroups(doc,{rules:set,nets:[...lengths.keys()]})){
        // hs-series: a net through a series part (or in a stored xSignal) is matched source pin → part → load pin (AtriumLength.matchLength).
        const ML=globalThis.AtriumLength?.matchLength,xl=new Map(),mx=n=>{if(!ML)return null;if(!xl.has(n)){let x=null;try{x=ML(doc,defs,n);}catch{x=null;}xl.set(n,x&&x.xSignal&&!x.unrouted?x:null);}return xl.get(n);};
        const r=R.byType.matchedLengths.find(x=>x.id===g.ruleId),len=n=>(mx(n)?.length??lengths.get(n)?.length)||0,seenXs=new Set();
        const target=Math.max(...g.nets.map(len));
        for(const n of g.nets){const e=lengths.get(n),xs=mx(n);if(xs){if(seenXs.has(xs.xSignal))continue;seenXs.add(xs.xSignal);}if(target-len(n)>r.tolerance+EPS)
          flag(r,{id:e?.id,title:"Net "+n+" against longest "+formatLength(target,"mm"),what:"Length",actual:len(n),required:target-r.tolerance,target,limit:"min",at:e?.first});}
        if(r.withinPair)for(const p of g.pairs){const skew=Math.abs(len(p.positive)-len(p.negative));
          if(skew>r.pairTolerance+EPS){const e=lengths.get(p.positive)||lengths.get(p.negative);
            flag(r,{id:e?.id,title:"Differential pair "+p.name+" ("+p.positive+" / "+p.negative+")",what:"Intra-pair skew",actual:skew,required:r.pairTolerance,limit:"max",at:e?.first});}}
      }
    }
    // Propagation Delay and Matched Delays (timing-vision.js): delays from the layer stack.
    if(active("delay")||active("matchedDelays")){const T=globalThis.AtriumTiming;if(T)T.drc(doc,defs,{R,active,flag,notes});else notes.push("Delay checks need the timing module (timing-vision.js).");}
    if(Object.values(xsBy).some(l=>l.length)){const X=globalThis.AtriumXSignals;if(X)X.drc(doc,defs,{R:{...R,byType:{...R.byType,...xsBy}},active:t=>(!only||only.has(t))&&xsBy[t]?.length>0,flag,notes});else notes.push("xSignal rules need the xSignals module (xsignals.js).");}
    // hs-rules: routing topology (topology.js), parallel segments (parallel-segment.js), return path (return-path.js).
    if((!only||only.has("routingTopology"))&&R.byType.routingTopology.some(r=>TOPO_CHECKED.has(r.topology))){const T=globalThis.AtriumTopology;if(T)T.drc(doc,defs,{R,flag,notes,project:options.project});else notes.push("Routing topology checks need the topology module (topology.js).");}
    if(active("parallelSegment")){const P=globalThis.AtriumParallelSegment;if(P)stats.candidates+=P.drc(doc,defs,{R,rules:R.byType.parallelSegment,flag,notes})||0;else notes.push("Parallel segment checks need the parallel segment module (parallel-segment.js).");}
    if(active("returnPath")){const RP=globalThis.AtriumReturnPath;if(RP)RP.drc(doc,defs,{R,rules:R.byType.returnPath,flag,notes,project:options.project});else notes.push("Return path checks need the return path module (return-path.js).");}
    if(geo.unassigned&&active("clearance"))notes.push(geo.unassigned+" copper objects without a net were not checked for clearance.");
    if(geo.excluded)notes.push(geo.excluded+" copper objects with unsupported shapes were not checked.");
    if((doc.pcbDrawing?.pours||[]).some(p=>!p.polygon)||(doc.notes||[]).some(n=>/polygon|pour|region/i.test(n)))notes.push("Imported copper pours and regions are not checked; Waffle polygon pours are checked for clearance and starved thermals.");
    const diagnostics=R.diagnostics.concat([...R.measurementIssues.values()]).filter(d=>!only||only.has(d.type));
    for(const d of diagnostics)flag(set.list.find(r=>r.id===d.ruleId),{id:d.objectId,what:"Rule scope",title:d.message,detail:d.message,scopeDiagnostic:d});
    const summary=set.list.filter(r=>ruleActive(set,r)&&(tallies.has(r.id)||CHECKED.has(r.type)||r.type==="routingTopology"&&TOPO_CHECKED.has(r.topology)/* hs-topology */)&&(!only||only.has(r.type))&&(flexBoard||!RIGID_FLEX.has(r.type))).map(r=>({id:r.id,name:r.name,type:r.type,priority:r.priority,count:tallies.get(r.id)?.count||0,description:describe(r,"mm"),...(set.ruleSets?{ruleSet:ruleSetOf(r)}:null)}));
    if(globalThis.AtriumRooms&&(!only||only.has("roomDefinition"))){const room=AtriumRooms.drc(doc,defs,flag,tallies);if(room)summary.push(room);}
    const total=summary.reduce((n,r)=>n+r.count,0);
    return {violations,rules:summary,total,complete:!diagnostics.length,diagnostics,unassigned:geo.unassigned,excluded:geo.excluded,notes,emptyScopes:empty,
      stats:{...stats,objects:geo.objects,copper:geo.copper.length,silk:geo.silk.length,holes:geo.holes.length,ms:Math.round(now()-started)}};
  }
  // Board Outline Clearance: copper and opted-in overlay ink against the outer
  // outline and cutouts. Ink entirely outside the board is also a violation.
  function edgeCheck(doc,geo,legend,R,flag,notes,stats){
    const ol=Array.isArray(doc.outline)&&doc.outline.length>=3?doc.outline:null;
    if(!ol){notes.push("Board outline clearance needs a board outline.");return;}
    let holes=[];try{holes=(globalThis.AtriumBoardShape?.holes?.(doc)||[]).filter(h=>h.length>=3);}catch{holes=[];}
    const E=[];
    [ol,...holes].forEach((ring,k)=>{for(let n=0;n<ring.length;n++)E.push(feature({obj:-1,id:null,net:"",span:[0,127],label:k?"Board cutout":"Board edge",role:1},[ring[n],ring[(n+1)%ring.length]],0));});
    const C=[...geo.copper,...geo.pads.filter(p=>!p.net)].map(f=>({...f,role:0}));
    const reach=Math.max(...R.byType.boardOutlineClearance.map(r=>r.gap)),found=new Map(),off=new Map();
    for(const c of C){
      if(off.has(c.obj))continue;const at=c.at||c.core[0],cutout=holes.some(h=>inRing(at,h)),out=cutout||!inRing(at,ol);off.set(c.obj,out);
      const r=out&&R.first("boardOutlineClearance",c);
      if(r?.gap>0)found.set(c.obj,{r,id:c.id,title:c.label+(cutout?" inside a board cutout":" outside the board outline"),what:"Board edge",actual:0,required:r.gap,limit:"min",at});
    }
    stats.candidates+=pairs([...C,...E],reach,(a,b)=>{
      if(a.role===b.role)return;const c=a.role?b:a,e=a.role?a:b;if(off.get(c.obj))return;
      const r=R.first("boardOutlineClearance",c);if(!r)return;
      const g=pieceGap(c,e,r.gap);if(g.d+EPS>=r.gap)return;
      const p=found.get(c.obj);if(!p||g.d<p.actual)found.set(c.obj,{r,id:c.id,title:c.label+" ↔ "+e.label,what:"Board edge",actual:g.d,required:r.gap,limit:"min",at:g.at});
    });
    for(const {r,...v} of found.values())flag(r,v);
    if(!legend)return;
    if(legend.unavailable)notes.push(legend.unavailable+" overlay objects have unavailable or substituted artwork for board outline clearance.");
    const S=globalThis.AtriumBoardShape,shape=S?.fresh(doc);
    const rings=shape?[shape.contour,...(shape.cutouts||[])].map(c=>S.flattenContour(c,EPS)):[ol,...holes];
    const [outline,...cutouts]=rings;
    const boundaries=rings.flatMap((ring,k)=>ring.map((pt,n)=>feature({label:k?"Board cutout":"Board edge"},[pt,ring[(n+1)%ring.length]],0)));
    const rules=R.byType.boardOutlineClearance.filter(r=>r.includeOverlay),ink=[];
    for(const f of legend.features){
      const rule=rules.find(r=>r.m1(f));if(!rule||rule.gap<=EPS)continue;
      const base={id:f.id,what:"Board edge",required:rule.gap,limit:"min",
        subject:{kind:f.kind,layer:f.layer,...(f.slot?{legendPrimitive:f.slot}:null)}};
      let hit;
      for(const {core:[at]} of f.pieces||[f]){
        const cutout=cutouts.some(ring=>inRing(at,ring));
        if(cutout||!inRing(at,outline)){
          hit={...base,title:f.label+(cutout?" inside a board cutout":" outside the board outline"),actual:0,at};break;
        }
      }
      if(hit)flag(rule,hit);
      else ink.push({...f,rule,base});
    }
    const worst=new Map();
    stats.candidates+=pairs([...ink,...boundaries],Math.max(...rules.map(r=>r.gap)),(a,b)=>{
      if(!!a.rule===!!b.rule)return;const f=a.rule?a:b,e=a.rule?b:a;
      const prior=worst.get(f.obj),g=pieceGap(f,e,Math.min(prior?.actual??Infinity,f.rule.gap));
      if(g.d+EPS>=f.rule.gap||prior&&g.d>=prior.actual)return;
      worst.set(f.obj,{...f.base,title:f.label+" ↔ "+e.label,actual:g.d,at:g.at,rule:f.rule});
    });
    for(const {rule,...v} of worst.values())flag(rule,v);
  }
  function diffPairCheck(geo,R,flag,board,zText){
    const byNet=new Map();
    for(const t of geo.tracks){if(!R.pairOfNet.has(t.net)||!(t.width>0)||t.points.length<2)continue;
      const list=byNet.get(t.net)||byNet.set(t.net,[]).get(t.net),cut=globalThis.AtriumRigidFlex?.piecesAlong;
      for(let n=1;n<t.points.length;n++){const a=t.points[n-1],b=t.points[n],pieces=cut?cut(board,[a,b]):null;
        if(pieces)for(const q of pieces)list.push({t,a:q.a,b:q.b,w:t.width,layer:t.item.layer||"Top",stack:q.stack});
        else list.push({t,a,b,w:t.width,layer:t.item.layer||"Top",stack:null});}}
    for(const p of R.pairs.values()){
      const P=byNet.get(p.positive)||[],N=byNet.get(p.negative)||[];if(!P.length&&!N.length)continue;
      const ruleAt=(layer,stack)=>{const r=R.first("diffPairsRouting",{net:p.positive,pair:p.name,layer,span:sideSpan(layer)});return r?{r,c:constraint(r,layer,null,board,R.profiles,stack),pf:profileAt(r,layer,board,R.profiles,stack)}:null;};
      const widthSeen=new Set();
      for(const s of [...P,...N]){
        const m=ruleAt(s.layer,s.stack);if(!m||widthSeen.has(s.t.obj))continue;
        if(s.w+EPS<m.c.widthMin){widthSeen.add(s.t.obj);flag(m.r,{id:s.t.id,title:"Pair "+p.name+" · "+s.t.label,what:"Pair width",actual:s.w,required:m.c.widthMin,limit:"min",at:s.t.at});}
        else if(m.c.widthMax!=null&&s.w-EPS>m.c.widthMax){widthSeen.add(s.t.obj);flag(m.r,{id:s.t.id,title:"Pair "+p.name+" · "+s.t.label,what:"Pair width",actual:s.w,required:m.c.widthMax,limit:"max",at:s.t.at});}
      }
      const gaps=new Map();
      for(const a of P)for(const b of N){
        if(a.layer!==b.layer)continue;const m=ruleAt(a.layer,a.stack);if(!m)continue;
        const c=closestSegments(a.a,a.b,b.a,b.b),g=Math.max(0,c.d-a.w/2-b.w/2);
        if(g+EPS<m.c.gapMin){const key=a.t.obj+"/"+b.t.obj,prev=gaps.get(key);
          if(!prev||g<prev.actual)gaps.set(key,{r:m.r,id:a.t.id,otherId:b.t.id,title:"Pair "+p.name+" · "+a.t.label+" ↔ "+b.t.label+(m.pf?zText(m.pf,{w:a.w,s:g}):""),what:"Pair gap",actual:g,required:m.c.gapMin,limit:"min",at:mid(c.pa,c.pb)});}
        // Impedance profile: coupled (parallel, near) segments wider apart than the profile allows.
        else if(m.pf&&m.c.gapMax!=null&&g-EPS>m.c.gapMax&&g<2*m.c.gapMax){
          const ux=a.b[0]-a.a[0],uy=a.b[1]-a.a[1],vx=b.b[0]-b.a[0],vy=b.b[1]-b.a[1],lu=Math.hypot(ux,uy),lv=Math.hypot(vx,vy);
          if(lu>EPS&&lv>EPS&&Math.abs(ux*vy-uy*vx)/(lu*lv)<.05){const key=a.t.obj+"/"+b.t.obj;
            if(!gaps.has(key))gaps.set(key,{r:m.r,id:a.t.id,otherId:b.t.id,title:"Pair "+p.name+" · "+a.t.label+" ↔ "+b.t.label+zText(m.pf,{w:a.w,s:g}),what:"Impedance gap",actual:g,required:m.c.gapMax,limit:"max",at:mid(c.pa,c.pb)});}
        }
      }
      for(const {r,...v} of gaps.values())flag(r,v);
      // Uncoupled length: sampled track length farther than the max gap from the other net.
      let worst=null;
      for(const [own,other] of [[P,N],[N,P]]){
        let uncoupled=0,at=null,id=null,rule=null;
        for(const s of own){
          const m=ruleAt(s.layer,s.stack);if(!m||m.c.maxUncoupled==null)continue;rule=m;
          const len=dist(s.a,s.b),steps=Math.max(1,Math.min(200,Math.ceil(len/.1)));
          const mates=other.filter(o=>o.layer===s.layer);
          for(let k=0;k<steps;k++){
            const q=[s.a[0]+(s.b[0]-s.a[0])*(k+.5)/steps,s.a[1]+(s.b[1]-s.a[1])*(k+.5)/steps];
            const coupled=mates.some(o=>dist(q,project(q,o.a,o.b))-o.w/2-s.w/2<=m.c.gapMax+EPS);
            if(!coupled){uncoupled+=len/steps;if(!at){at=q;id=s.t.id;}}
          }
        }
        if(rule&&uncoupled-EPS>rule.c.maxUncoupled&&(!worst||uncoupled>worst.actual))worst={r:rule.r,id,title:"Differential pair "+p.name,what:"Uncoupled length",actual:uncoupled,required:rule.c.maxUncoupled,limit:"max",at};
      }
      if(worst){const {r,...v}=worst;flag(r,v);}
    }
  }
  // Legacy check: clearance, width and via rules only. Issue records keep the
  // version 1 keys: rule is "clearance", "trackWidth", "viaDrill" or "viaDiameter".
  function check(doc,defs,rules=defaults()) {
    validate(rules,{allowFuture:true,allowUnknown:true});
    if(doc.kind!=="pcb")throw Error("Open a PCB layout to check board rules.");
    const out=drc(doc,defs,rules,{types:["clearance","width","viaStyle"],legacyLabels:true,limit:Infinity});
    const key=v=>v.type==="clearance"?"clearance":v.type==="width"?"trackWidth":v.field==="diameter"?"viaDiameter":"viaDrill";
    const issues=out.violations.map(v=>{
      const issue={rule:key(v),id:v.id,title:v.title,actual:v.actual,required:v.required,source:v.source};
      if(v.otherId)issue.otherId=v.otherId;if(v.limit==="max")issue.limit="max";
      return issue;
    });
    issues.sort((a,b)=>(a.actual-a.required)-(b.actual-b.required));
    return {issues,unassigned:out.unassigned,excluded:out.excluded,...(!out.complete?{complete:false,diagnostics:out.diagnostics}:null)};
  }

  // ---------------------------------------------------------------- descriptions
  function constraintText(r,unit="mm"){
    const t=TYPES[r.type],len=v=>formatLength(v,unit,true),parts=[];
    for(const f of t.fields){
      const v=r[f.key];
      if(f.kind==="length"){if(v!=null&&!(r.type==="matchedLengths"&&f.key==="pairTolerance"&&!r.withinPair))parts.push(f.label.replace(/^(Min|Max|Preferred) /,"$1 ")+"="+len(v));}
      else if(f.kind==="ps"){if(v!=null&&!(r.type==="matchedDelays"&&f.key==="pairTolerance"&&!r.withinPair))parts.push(f.label.replace(/ \(ps\)$/,"").replace(/^(Min|Max) /,"$1 ")+"="+v+"ps");}
      else if(f.kind==="volts")parts.push("Supply voltage="+v+"V");
      else if(f.kind==="amps")parts.push(v>0?"Current="+v+"A":"Current=Net or Class currents");
      else if(f.kind==="bool"){if(v!=null)parts.push(f.label.replace(/ \(.*\)$/,"")+"="+(v?"Yes":"No"));}
      else if(f.kind==="choice"){if(!(r.type==="polygonConnect"&&r.style==="polygon"&&f.key!=="style"))parts.push(f.label+"="+(f.options.find(([k])=>k===v)?.[1]||v));}
      else if(f.kind==="integer")parts.push(f.label+"="+v);
      else if(f.kind==="profile"){if(v)parts.push("Impedance profile="+v);}
      else if(f.kind==="layers")parts.push(v.length?"Not on "+v.map(layerLabel).join(", "):"All layers");
      else if(f.kind==="dfaMatrix")parts.push("Matrix="+v.length+" package pairs");
      else if(f.kind==="clearanceMatrix"){if(v)for(const k of CLEAR_PAIRS)if(own(v,k)){const [a,b]=k.split("-");parts.push(clearLabel(a)+"–"+clearLabel(b)+"="+len(v[k]));}}
      else if(f.kind==="connectTable"){for(const [k,row] of Object.entries(v))parts.push(CONNECT_KINDS.find(([x])=>x===k)[1]+"{"+Object.entries(row).map(([a,b])=>a+"="+(typeof b==="number"&&a!=="entries"&&a!=="angle"?len(b):b)).join(",")+"}");}
      else if(v&&Object.keys(v).length)parts.push(Object.keys(v).length+" layer overrides");
    }
    return parts.join(" ")||"No attributes";
  }
  const clearLabel=k=>CLEAR_KINDS[CK_INDEX.get(k)][1].replace(/ /g,"");
  // Altium style: "Clearance Constraint (Min clearance=0.2mm) (All),(All)".
  function describe(r,unit="mm"){
    const t=TYPES[r.type];
    const displayScope=s=>scopeQuery(globalThis.AtriumDesignQueryRecord?.toSelector(s)||s);
    return t.title+" Constraint ("+constraintText(r,unit)+") ("+displayScope(r.scope)+")"+(t.two?",("+displayScope(r.scope2)+")":"");
  }

  // ---------------------------------------------------------------- Altium source records
  function altiumLength(text,signed,upper=MAX_LENGTH){
    const m=/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|mil|inch|in|um|µm)\s*$/i.exec(text||"");
    if(!m)return null;
    const n=Math.round(Number(m[1])*TO_MM[m[2].toLowerCase()]*1e6)/1e6;
    return signed?(Math.abs(n)<=100?n:null):(n>=0&&n<=upper?n:null);
  }
  function altiumLayer(text){
    const s=String(text).toUpperCase().replace(/[\s_-]/g,"");
    const m=/^(?:MIDLAYER|MID|INNER)(\d+)$/.exec(s);if(m&&+m[1]>=1&&+m[1]<=30)return "Inner "+(+m[1]);
    return {TOP:"Top",TOPLAYER:"Top",BOTTOM:"Bottom",BOTTOMLAYER:"Bottom",TOPOVERLAY:"Silk",BOTTOMOVERLAY:"Bottom silk",TOPSOLDER:"Top mask",
      BOTTOMSOLDER:"Bottom mask",TOPPASTE:"Top paste",BOTTOMPASTE:"Bottom paste",MULTILAYER:"Multi"}[s]||null;
  }
  function sourceLayerMap(board){
    if(board?.stackup?.source!=="Altium")return board?.sourceRuleLayers ?? null;
    const layers=board.stackup.layers||[],signalKeys=new Set(layers.filter(l=>l.type==="Signal").map(l=>l.key));
    const map={};
    for(const l of layers)if(l.type==="Plane"&&l.key)map[l.key]=null;
    if(signalKeys.has("Top")&&signalKeys.has("Bottom"))for(let i=1;i<=30;i++){
      const key="Inner "+i;
      if(!signalKeys.has(key))map[key]=null;
    }
    if(board.sourceRuleLayers)return {...map,...board.sourceRuleLayers};
    // Earlier imports retained reordered signal IDs in this diagnostic and the actual layer stack.
    const prefix="Mid layers were renumbered to their stack order: ";
    const note=board.notes?.find(n=>typeof n==="string"&&n.startsWith(prefix));
    if(note){
      const moves=note.slice(prefix.length).replace(/\.$/,"").split(", ").map(s=>/^(Inner [1-9]\d?) → (Inner [1-9]\d?)$/.exec(s));
      if(moves.every(Boolean)){
        for(const [,from,to] of moves)map[to]=null;
        for(const [,from,to] of moves)map[from]=to;
      }
    }
    return map;
  }
  function sourceLayer(text,map){
    const key=altiumLayer(text);
    return key&&map&&own(map,key)?map[key]:key;
  }
  function altiumScope(expr,layerMap){
    // @ts-ignore CommonJS entry point. Browser and worker loaders declare the translator.
    if (!globalThis.AtriumQueryExchange && typeof module!=="undefined" && typeof require==="function") require("./query-exchange.js");
    return globalThis.AtriumQueryExchange?.fromAltium(expr,{layer:name=>sourceLayer(name,layerMap)}) ||
      {ok:false,diagnostics:[{code:"query-reader-unavailable",message:"The Altium scope translator is unavailable.",span:[0,String(expr).length]}]};
  }
  const sourceSelector=scope=>globalThis.AtriumDesignQueryRecord?.toSelector(scope);
  const FROM_ALTIUM={
    clearance:{gap:"GAP"},width:{min:"MINLIMIT",preferred:["PREFEREDWIDTH","PREFERREDWIDTH"],max:"MAXLIMIT"},
    viaStyle:{diameterMin:"MINWIDTH",diameterPreferred:"WIDTH",diameterMax:"MAXWIDTH",holeMin:"MINHOLEWIDTH",holePreferred:"HOLEWIDTH",holeMax:"MAXHOLEWIDTH"},
    // Designer 26 writes the gap as MINLIMIT / MOSTFREQGAP / MAXLIMIT and the width per layer (TOPLAYER_MINWIDTH,
    // ...; docs/design/altium-pairs-xsignals-format.md); older records MINWIDTH / MINGAP.
    diffPairsRouting:{widthMin:["MINWIDTH","TOPLAYER_MINWIDTH"],widthPreferred:["PREFEREDWIDTH","PREFERREDWIDTH","TOPLAYER_PREFWIDTH"],widthMax:["MAXWIDTH","TOPLAYER_MAXWIDTH"],gapMin:["MINGAP","MINLIMIT"],gapPreferred:["PREFEREDGAP","PREFERREDGAP","MOSTFREQGAP"],gapMax:["MAXGAP","MAXLIMIT"],maxUncoupled:"MAXUNCOUPLEDLENGTH"},
    routingCorners:{setbackMin:"MINSETBACK",setbackMax:"MAXSETBACK"},
    solderMask:{expansion:"EXPANSION"},pasteMask:{expansion:"EXPANSION"},annularRing:{min:"MINIMUMRING"},holeSize:{min:"MINLIMIT",max:"MAXLIMIT"},
    fabricationTestpoint:{minSize:"MINSIZE",preferredSize:"PREFEREDSIZE",maxSize:"MAXSIZE",minHole:"MINHOLESIZE",preferredHole:"PREFEREDHOLESIZE",maxHole:"MAXHOLESIZE"},
    polygonConnect:{},boardOutlineClearance:{gap:["GENERICCLEARANCE","GAP"]},componentHeight:{min:"MINHEIGHT",preferred:"PREFHEIGHT",max:"MAXHEIGHT"},
    componentClearance:{gap:"GAP",vertical:"VERTICALGAP"},holeToHole:{gap:"GAP"},silkToMask:{gap:["MINSILKSCREENTOMASKGAP","GAP"]},silkToSilk:{gap:["SILKTOSILKCLEARANCE","GAP"]},length:{min:"MINLIMIT",max:"MAXLIMIT"},matchedLengths:{tolerance:"TOLERANCE"}
  };
  const sourceOnly={
    assemblytestpoint:"Assembly probe size, grid and access require an assembly testpoint rule.",
    assemblytestpointusage:"Assembly probe assignments require a testpoint usage rule.",
    fabricationtestpointusage:"Fabrication probe assignments require a testpoint usage rule.",
    planeconnect:"This governs connections on internal power planes. Supported global styles can be applied to the imported plane geometry. Other scope or connection settings remain in this record.",
    planeclearance:"This is an internal power-plane gap. A supported global gap can be applied to the imported plane geometry. It is not a positive-copper clearance rule.",
    minimumsoldermasksliver:"The fabrication preset checks mask webs. It cannot enforce this board rule on every mask opening.",
    netantennae:"The Altium rule is retained for reference. PCB editor DRC shows a separate warning for open track ends. Run the rule in Altium to check its source scope, stub-length tolerance, and via-terminated stubs.",
    silktoboardregionclearance:"The native outline check covers copper. This rule checks legends against board regions.",
    roomdefinition:"Altium room membership and placement constraints have no equivalent rule-book entry.",
    fanoutcontrol:"Altium package predicates, BGA direction and via-grid settings cannot be enforced together by the native fanout tool."
  };
  const notMapped=reason=>({rule:null,reason});
  const altiumBool=v=>/^(?:true|t|1)$/i.test(v)?true:/^(?:false|f|0)$/i.test(v)?false:null;
  function connectFields(p,prefix){
    const style={direct:"direct",relief:"relief",noconnect:"none",none:"none"}[String(p[prefix+"CONNECTSTYLE"]||"").toLowerCase()];
    const angle=/^(45|90)(?:\s*(?:angle|deg(?:rees?)?|°))?$/i.exec(p[prefix+"POLYGONRELIEFANGLE"]||p[prefix+"RELIEFANGLE"]||"");
    const entries=Number(p[prefix+"RELIEFENTRIES"]),conductorWidth=altiumLength(p[prefix+"RELIEFCONDUCTORWIDTH"]),airGap=altiumLength(p[prefix+"AIRGAPWIDTH"]);
    if(!style||!angle||![2,4].includes(entries)||conductorWidth==null||airGap==null)return null;
    return {style,angle:Number(angle[1]),entries,conductorWidth,airGap};
  }
  function altiumRuleScope(row,side){
    const value=side===1?row.first:row.second,key="SCOPE"+side+"EXPRESSION";
    // Modern records can omit an irrelevant side. An explicitly empty expression is not All.
    return value || (own(row.fields,key)||own(row.fields,"%UTF8%"+key) ? "" : "All");
  }
  function convertAltium(row,board,layerMap=sourceLayerMap(board),translated){
    const p=Object.assign(Object.create(null),row.fields);
    for(const [k,v] of Object.entries(row.fields))if(k.startsWith("%UTF8%"))p[k.slice(6)]=v;
    const kind=String(row.kind).toLowerCase(),type=ORDER.find(t=>TYPES[t].altium.toLowerCase()===kind);
    if(own(sourceOnly,kind))return notMapped(sourceOnly[kind]);
    if(!type||!own(FROM_ALTIUM,type)&&!["short","unrouted","routingPriority","routingLayers","routingTopology","layerPairs","supplyNets","modifiedPolygon"].includes(type))return notMapped("Waffle has no "+(row.kind||"unnamed")+" source rule conversion.");
    const t=TYPES[type],first=translated?.[0] || altiumScope(altiumRuleScope(row,1),layerMap);
    if(!first.ok)return notMapped("Scope 1: "+first.diagnostics[0].message);
    const scope=first.scope;
    if(p.LAYERKIND&&!/^SameLayer$/i.test(p.LAYERKIND))return notMapped("Layer relationship "+p.LAYERKIND+" has no equivalent for this rule.");
    if(p.ENABLED!=null&&altiumBool(p.ENABLED)==null)return notMapped("The source enable setting is unrecognised.");
    if(row.priority&&!/^\d+$/.test(row.priority))return notMapped("The source priority is unrecognised.");
    const props={enabled:row.enabled,comment:(p.COMMENT||p.DESCRIPTION||"").slice(0,4000),scope},warnings=[];
    if(t.two){
      const second=translated?.[1] || altiumScope(altiumRuleScope(row,2),layerMap);
      if(!second.ok)return notMapped("Scope 2: "+second.diagnostics[0].message);
      props.scope2=second.scope;
    } else if(!/^all$/i.test(altiumRuleScope(row,2))){
      // Pours connect to pads/vias on their own net. This secondary membership can be projected onto the polygon.
      const second=translated?.[1] || altiumScope(altiumRuleScope(row,2),layerMap);
      if(!second.ok)return notMapped("Scope 2: "+second.diagnostics[0].message);
      const other=second.scope;
      if(type==="polygonConnect"&&sourceSelector(scope)?.kind==="all"&&["net","netclass"].includes(sourceSelector(other)?.kind))props.scope=other;
      else return notMapped("The native rule has one scope. Source scope 2 is "+row.second+".");
    }
    if(type==="clearance"&&p.NETSCOPE&&!/^DifferentNets$/i.test(p.NETSCOPE))return notMapped("The source net relationship is "+p.NETSCOPE+". Native clearance checks different nets.");
    if(p.NETSCOPE&&!/^(?:DifferentNets|AnyNet)$/i.test(p.NETSCOPE))return notMapped("The source net relationship "+p.NETSCOPE+" has no equivalent for this rule.");
    if(type==="holeToHole"&&p.ALLOWSTACKEDMICROVIAS!=null){
      props.allowStackedMicrovias=altiumBool(p.ALLOWSTACKEDMICROVIAS);
      if(props.allowStackedMicrovias==null)return notMapped("The source stacked-microvia permission is unrecognised.");
    }
    if(type==="holeSize"&&p.ABSOLUTEVALUES!=null&&altiumBool(p.ABSOLUTEVALUES)!==true)return notMapped("The source hole limits are not absolute diameters.");
    if(type==="componentClearance"){
      if(p.COLLISIONCHECKMODE!=="3"||[p.CHECKBYCOMPONENTBOUNDARY,p.CHECKCLEARANCEBYCOMPONENTBOUNDARY].some(v=>v!=null&&altiumBool(v)!==false))
        return notMapped("This component collision mode or boundary setting needs evaluation in Altium.");
      const skip=altiumBool(p.DONOTCHECKWITHOUT3DBODY??"FALSE");
      if(skip==null)return notMapped("The source option for components without a 3D body is unrecognised.");
      props.mode="authored";props.fold="flat";props.board=false;props.skipMissingBody=skip;
      warnings.push("Checks placed polygonal extrusions with one straight-sided outline. STEP models, curves and perforated bodies need their exact solids. "+
        (skip?"The source excludes components without a 3D body.":"Components without a 3D body need their source selection boundary and component height."));
    }
    if(type==="silkToMask"){
      const exposed=altiumBool(p.CLEARANCETOEXPOSEDCOPPER??"FALSE");
      if(exposed==null)return notMapped("The source silk reference surface is unrecognised.");
      props.exposedCopper=exposed;
      warnings.push("Checks overlay lines and plotted legend text against pad "+(exposed?"exposed copper":"mask openings")+". Foreign font geometry can differ from Altium; vias and independent mask primitives are not checked.");
    }
    if(type==="fabricationTestpoint"){
      const top=altiumBool(p.ALLOWSIDETOP),bottom=altiumBool(p.ALLOWSIDEBOTTOM);
      if(top==null||bottom==null)return notMapped("The record has no explicit allowed testpoint sides.");
      props.allowTop=top;props.allowBottom=bottom;
      warnings.push("The native check verifies assigned fabrication probes' side, drill and circular land diameter. Grid, body and other clearances, non-circular lands and automatic probe placement require Altium.");
    }
    if(type==="boardOutlineClearance"){
      // Only split and cavity cells are independent of the board edges we check.
      const cells=(p.OBJECTCLEARANCES||"").split(";").map(c=>c.trim()).filter(Boolean);
      if(cells.some(c=>!/^ClearanceObj_(?:Arc|Track|SMDPad|THPad|Via|Fill|Poly|Polygon|Region|Text)-ClearanceObj_(?:SplitBarrior|SplitBarrier|SplitContinuation|CavityEdge):\d+$/i.test(c)))
        return notMapped("The source has individual object-to-edge distances that the native outline rule cannot express.");
      if(p.GAP&&p.GENERICCLEARANCE&&altiumLength(p.GAP)!==altiumLength(p.GENERICCLEARANCE))
        return notMapped("The source default outline gaps differ.");
      props.includeOverlay=true;
      warnings.push("Checks copper and available overlay primitives at the outline and cutouts. Cavity and split edges and unimported artwork require Altium.");
    }
    if(type==="unrouted"&&altiumBool(p.CHECKBADCONNECTIONS))warnings.push("Disconnected nets are checked. Altium's additional incomplete-connection test is unavailable.");
    if(type==="matchedLengths"&&[p.CHECKDIFFPAIRVSDIFFPAIR,p.CHECKXSIGNALS,p.CHECKOTHERS].some(v=>v!=null)){
      // A scope selecting only xSignals has no standalone nets or differential pairs to compare.
      const xs=["xsignal","xsignalclass"].includes(sourceSelector(scope)?.kind);
      if(!xs||altiumBool(p.CHECKXSIGNALS)!==true||altiumBool(p.CHECKNETSINDIFFPAIR)!==false)
        return notMapped("Altium selects separate comparison groups for pair members, other pairs, xSignals and other nets. The native rule cannot express this combination.");
    }
    for(const [key,names] of Object.entries(FROM_ALTIUM[type]||{})){
      const f=t.fields.find(x=>x.key===key),raw=[].concat(names).map(n=>p[n]).find(v=>v!=null&&v!=="");
      const v=raw==null?null:altiumLength(raw,f.signed,f.upper);
      if(raw!=null&&v==null)return notMapped(f.label+" "+raw+" is not a length Waffle can read.");
      if(v!=null)props[key]=v;else if(!f.optional)return notMapped("The record has no "+f.label.toLowerCase()+".");
      else props[key]=null;
    }
    if(type==="silkToSilk"&&props.gap>0)warnings.push("Checks overlay lines between different owners. Text and additional legend geometry are retained in the source rule.");
    if(type==="componentClearance"&&!(props.gap>0&&props.vertical>0))return notMapped("A zero-gap or zero-height contact requires an exact face intersection test.");
    if(type==="width"||type==="diffPairsRouting"){
      const impedance=altiumBool(p.IMPEDANCEPROFILEDRIVEN);
      if(p.IMPEDANCEPROFILEDRIVEN!=null&&impedance==null)return notMapped("The impedance-profile setting is unrecognised.");
      if(impedance)warnings.push("Uses the saved dimensions. The linked Altium impedance profile and target constraints are retained in the source rule.");
      const noSignalLayer="Per-layer constraints for signal layers absent from the board stack are retained in the source record.";
      const fields={MINWIDTH:"widthMin",PREFWIDTH:"widthPreferred",MAXWIDTH:"widthMax",MINGAP:"gapMin",PREFGAP:"gapPreferred",MAXGAP:"gapMax"},layers={};
      for(const [field,raw] of Object.entries(p)){
        const m=/^(TOPLAYER|BOTTOMLAYER|MIDLAYER\d+)_(MINWIDTH|PREFWIDTH|MAXWIDTH|MINGAP|PREFGAP|MAXGAP)$/.exec(field);
        if(!m)continue;
        const key=fields[m[2]],base=layerValueKey(type,key),spec=t.fields.find(f=>f.key===base);
        if(!spec)continue;
        const l=sourceLayer(m[1],layerMap),value=altiumLength(raw,false,spec.upper);
        if(value==null)return notMapped("The layer constraint "+field+" cannot be represented.");
        if(!l){
          if(!altiumLayer(m[1]))return notMapped("The source layer "+m[1]+" is unrecognised.");
          if(value!==props[base]&&!warnings.includes(noSignalLayer))warnings.push(noSignalLayer);
          continue;
        }
        if(type==="width"||value!==props[base])(layers[l]||(layers[l]={}))[key]=value;
      }
      if(Object.keys(layers).length)props.layers=layers;
    }
    if(type==="clearance"){
      if(p.IGNOREPADTOPADCLEARANCEINFOOTPRINT!=null){
        const ignore=altiumBool(p.IGNOREPADTOPADCLEARANCEINFOOTPRINT);if(ignore==null)return notMapped("The footprint pad-pair setting is unrecognised.");
        if(ignore)props.ignoreFootprintPadPairs=true;
      }
      const map={track:"track",arc:"arc",smdpad:"smd",thpad:"th",via:"via",fill:"fill",poly:"poly",polygon:"poly",region:"region",text:"text",hole:"hole"},cells={},unknown=[];
      for(const part of (p.OBJECTCLEARANCES||"").split(";").map(x=>x.trim()).filter(Boolean)){
        const m=/^ClearanceObj_(\w+)-ClearanceObj_(\w+):\s*(\S+)$/i.exec(part),a=m&&map[m[1].toLowerCase()],b=m&&map[m[2].toLowerCase()];
        if(!a||!b||a==="hole"&&b==="hole"){unknown.push(part);continue;}
        const v=/^\d+(\.\d+)?$/.test(m[3])?Math.round(Number(m[3])*MIL/10000*1e6)/1e6:altiumLength(m[3]);
        if(v==null||!(v>=0)||v>MAX_LENGTH)return notMapped("Invalid distance for clearance cell "+part+".");
        if(a==="hole"||b==="hole"||Math.abs(v-props.gap)>1e-6)cells[clearKey(a,b)]=v;
      }
      if(Object.keys(cells).length)props.objects=cells;
      if(unknown.length)warnings.push("Clearance matrix cells not read: "+unknown.join("; ")+".");
    }
    if(type==="polygonConnect"){
      // RELIEFENTRIES describes the geometry to build, not a separate DRC minimum.
      props.minEntries=0;
      const prefixes=[["th","THPAD."],["smd","SMDPAD."],["via","VIA."]],perKind=prefixes.some(([,s])=>Object.keys(p).some(k=>k.startsWith(s)));
      const base=p.CONNECTSTYLE!=null?connectFields(p,""):null;
      if(p.CONNECTSTYLE!=null&&!base)return notMapped("The polygon connection style, thermal width, air gap, entry count or angle is unsupported.");
      if(perKind){
        const kinds={};
        for(const [kind,prefix] of prefixes){
          kinds[kind]=connectFields(p,prefix);
          if(!kinds[kind])return notMapped("The polygon connection settings for "+prefix.slice(0,-1)+" are incomplete or unsupported.");
        }
        // The table covers all three native connection subjects. The TH row supplies the editor's base display.
        Object.assign(props,base||kinds.th,{kinds});
      }else if(base)Object.assign(props,base);else return notMapped("The record has no polygon connection settings.");
    }
    if(type==="routingLayers"){
      props.excluded=(board?.stackup?.layers||[]).filter(l=>l.type==="Plane"&&l.key).map(l=>l.key);
      let found=false;
      for(const [key,value] of Object.entries(p)){
        if(!key.endsWith("_V5"))continue;
        const name=key.slice(0,-3),layer=sourceLayer(name,layerMap),allowed=altiumBool(value);
        if(!altiumLayer(name)||allowed==null)return notMapped("Routing-layer setting "+key+" cannot be represented.");
        if(layer&&!allowed&&!props.excluded.includes(layer))props.excluded.push(layer);
        found=true;
      }
      if(!found)return notMapped("The source record does not specify allowed routing layers.");
    }
    if(type==="solderMask"){
      for(const [field,key] of [["ISTENTINGTOP","tentTop"],["ISTENTINGBOTTOM","tentBottom"]]){
        if(p[field]==null)continue;props[key]=altiumBool(p[field]);
        if(props[key]==null)return notMapped("The solder-mask setting "+field+" is unrecognised.");
      }
    }
    if(type==="modifiedPolygon"){
      // Omitted flags mean No, confirmed by the shipped PiDP-11 Altium DRC report.
      props.allowModified=altiumBool(p.ALLOWMODIFIED??p.ALLOWUNPOURED??"FALSE");props.allowShelved=altiumBool(p.ALLOWSHELVED??"FALSE");
      if(props.allowModified==null||props.allowShelved==null)return notMapped("The polygon-state permissions are unrecognised.");
    }
    if(type==="layerPairs"){props.enforce=altiumBool(p.ENFORCE);if(props.enforce==null)return notMapped("The layer-pair enforcement setting is missing or unrecognised.");}
    if(type==="short"){props.allowed=altiumBool(p.ALLOWED);if(props.allowed==null)return notMapped("The source short-circuit permission is missing or unrecognised.");}
    if(type==="routingPriority"){const n=Number(p.ROUTINGPRIORITY);if(!/^\d+$/.test(p.ROUTINGPRIORITY||"")||n>100)return notMapped("The routing priority is outside the native 0–100 range.");props.value=n;}
    if(type==="routingCorners"){const s=String(p.CORNERSTYLE||"").toLowerCase();props.style=/^90(?:[ -]?deg(?:ree)?s?)?$/.test(s)?"90":/^(round(?:ed)?|arc)$/.test(s)?"rounded":/^45(?:[ -]?deg(?:ree)?s?)?$/.test(s)?"45":null;if(!props.style)return notMapped("The source corner style "+s+" is unsupported.");}
    if(type==="routingTopology"){const s=String(p.TOPOLOGY||"").toLowerCase().replace(/[^a-z]/g,"");props.topology=TOPOLOGY.find(([k])=>k.toLowerCase()===s||k.toLowerCase().replace("daisychain","daisy")===s)?.[0];if(!props.topology)return notMapped("The source routing topology is unrecognised.");}
    if(type==="matchedLengths"){props.withinPair=altiumBool(p.CHECKNETSINDIFFPAIR||p.CHECKDIFFPAIRS)===true;props.pairTolerance=props.tolerance;}
    if(type==="supplyNets"){
      if(!["net","netclass","all"].includes(sourceSelector(scope)?.kind))return notMapped("The supply expression needs information beyond net membership.");
      if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(p.VOLTAGE||"")||!Number.isFinite(Number(p.VOLTAGE)))return notMapped("The record has no finite supply voltage.");
      props.voltage=Number(p.VOLTAGE);
    }
    const name=String(row.name||t.altium).trim().slice(0,128)||t.altium,r=make(type,name,props);
    try{checkRule(r,new Set(),new Set());}catch(e){return notMapped(e.message);}
    return {rule:r,reason:null,priority:Number(row.priority)||0,...(warnings.length?{warning:warnings.join(" ")}:null)};
  }
  function fromAltium(line,board){
    if(!globalThis.AtriumAltiumRules)return notMapped("Altium rule support is unavailable.");
    return convertAltium(AtriumAltiumRules.describe(line),board);
  }
  // The vendor uses one bitset entry per kind, independently of each rule's Enabled flag.
  function sourceCheckSelection(board){
    const source=board?.sourceRuleChecks,lines=board?.sourceRules;
    if(board?.sourceRulesReplaced||!lines?.length||source?.kinds?.length!==lines.length||!Array.isArray(source.batch)||!Array.isArray(source.online))return null;
    const types=new Map(ORDER.map(t=>[TYPES[t].altium.toLowerCase(),t]));
    types.set("netantennae","netAntennae");
    const byType=new Map();
    for(const [index,line] of lines.entries()){
      const type=types.get(AtriumAltiumRules.describe(line).kind.toLowerCase());
      if(type)byType.set(type,source.kinds[index]);
    }
    const omitted=mode=>[...byType].filter(([,id])=>!source[mode].includes(id)).map(([type])=>type).sort();
    return {batch:omitted("batch"),online:omitted("online")};
  }
  // Keep the original record order for display and for ties. A lower-priority fallback must not
  // acquire a higher-priority source-only rule's domain when converting the rule book.
  function sourceConversions(sources,board){
    const layers=sourceLayerMap(board),selection=sources===board?.sourceRules&&!board?.sourceRulesReplaced?board?.sourceRuleChecks:null;
    const rows=(sources||[]).map((line,index)=>{
      const row=AtriumAltiumRules.describe(line);
      const translated=[1,2].map(side=>altiumScope(altiumRuleScope(row,side),layers));
      const scopeDiagnostics=translated.flatMap((result,i)=>result.diagnostics.map(d=>({...d,side:i+1})));
      const id=selection?.kinds[index],checks=id!=null?{kindId:id,batch:selection.batch.includes(id),online:selection.online.includes(id)}:null;
      return {index,line,name:row.name,kind:row.kind,first:row.first,second:row.second,enabled:row.enabled,netScope:row.fields.NETSCOPE,
        checks,scopeDiagnostics,...convertAltium(row,board,layers,translated),priority:Number(row.priority)||0};
    });
    // A source rule on a known-absent class or physical layer cannot shadow the fallback.
    const classNames=new Set((board?.sourceClasses||[]).map(l=>/(?:^|\|)NAME=([^|]*)/i.exec(String(l))?.[1]?.trim().toLowerCase()).filter(Boolean));
    function inertReason(r){
      for(const scope of [r.first,r.second]){
        const m=/^\s*\(?\s*(In(?:Pad|Component|Net|Polygon|Layer|DifferentialPair|xSignal)Class|OnLayer)\s*\(\s*'((?:[^']|'')+)'\s*\)\s*\)?\s*$/i.exec(scope);
        if(!m)continue;
        const name=m[2].replace(/''/g,"'").trim();
        if(/^OnLayer$/i.test(m[1])){
          const key=altiumLayer(name);
          if(key&&layers&&own(layers,key)&&layers[key]===null)return "Its scope names a layer this board does not have, so it applies to nothing.";
        }else if(Array.isArray(board?.sourceClasses)&&!/^all\b/i.test(name)&&!classNames.has(name.toLowerCase())){
          return "Its scope names a class this board does not have, so it applies to nothing.";
        }
      }
      return null;
    }
    const blockers=new Map();
    for(const r of [...rows].sort((a,b)=>a.priority-b.priority)){
      if(!r.enabled)continue;
      const inactive=!r.rule&&inertReason(r);
      if(inactive){r.reason=(r.reason?r.reason+" ":"")+inactive;continue;}
      const key=r.kind.toLowerCase(),group=blockers.get(key);
      if(r.rule&&group){
        const selector=sourceSelector(r.rule.scope),net=!r.rule.scope2&&selector?.kind==="net"?selector.value.toLowerCase():null;
        const conflict=group.general||(net==null?group.first:group.nets.get(net));
        if(conflict){r.rule=null;r.reason="Higher-priority source rule "+conflict.name+" can apply to the same objects.";continue;}
      }
      if(!r.rule&&!(key==="clearance"&&/^(?:SameNet|SameNetOnly)$/i.test(r.netScope||""))){
        const g=group||{general:null,nets:new Map(),first:r};
        const net=/^InNet\s*\(\s*'((?:[^']|'')+)'\s*\)$/i.exec(r.first);
        if(net&&!g.general&&/^all$/i.test(r.second||"All")&&key!=="clearance"&&key!=="shortcircuit")g.nets.set(net[1].replace(/''/g,"'").toLowerCase(),r);
        else g.general??=r;
        blockers.set(key,g);
      }
    }
    return rows;
  }
  function reportRows(rows){
    return rows.map(({index,name,kind,first,second,enabled,priority,line,rule,reason,warning,scopeDiagnostics,checks})=>({
      record:index+1,name,kind,scope:first,scope2:second,enabled,priority,status:rule?(warning?"partial":"supported"):"source-only",
      ...(reason||warning?{reason:reason||warning,text:line}:{}),...(scopeDiagnostics.length?{scopeDiagnostics}:{}),...(checks?{checks}:{})
    }));
  }
  const sourceReport=(sources,board)=>reportRows(sourceConversions(sources,board));
  function replaceWithSource(set,sources,board){
    const rows=sourceConversions(sources,board),converted=rows.filter(x=>x.rule),types=new Set(converted.map(x=>x.rule.type)),origins=new Map(),priorities=new Map();
    set.list=set.list.filter(r=>!types.has(r.type));
    const taken=new Set(set.list.map(r=>r.name.toLowerCase()));
    converted.sort((a,b)=>a.priority-b.priority).forEach(x=>{
      const base=x.rule.name.trim().slice(0,120)||"Rule";let name=base,n=1;while(taken.has(name.toLowerCase()))name=base+"_"+(n++);
      x.rule.name=name;taken.add(name.toLowerCase());x.rule.priority=(priorities.get(x.rule.type)||0)+1;priorities.set(x.rule.type,x.rule.priority);
      set.list.push(x.rule);origins.set(x.rule.id,x.index+1);
    });
    return {set,origins,report:reportRows(rows),converted:converted.length,total:rows.length,types:types.size};
  }
  // Accepting the complete original rule set preserves previously unedited source copper.
  // Both Messages and the Rules editor perform this within the same native undo step.
  function adoptSourcePours(doc,project,defs,commit){
    globalThis.AtriumSignals?.attach?.(project);
    const P=globalThis.AtriumPolygonPour;
    if(defs&&P)return P.adoptRuleTransition(doc,defs,{project},commit);
    commit();
    return {kept:0,repoured:0};
  }
  const legacyCandidate={trackWidth:["width","min"],viaDrill:["viaStyle","holeMin"],clearance:["clearance","gap"]};

  // ---------------------------------------------------------------- editor dialog
  function el(tag,text,cls){ return AtriumNavCommon.el(tag, text, cls); }
  function button(text,click,cls){const b=el("button",text,cls);if(cls!=="ui-segment")b.classList.add("ui-button");b.type="button";b.onclick=click;return b;}
  function initialUnit(ctx){
    const u=typeof ctx?.units==="function"?ctx.units():ctx?.units??ctx?.project?.units;
    if(u==="mil"||u==="mm")return u;
    try{const s=localStorage.getItem("atrium.rules.units");if(s==="mil"||s==="mm")return s;}catch{/* storage unavailable */}
    return "mm";
  }
  function rememberUnit(u){try{localStorage.setItem("atrium.rules.units",u);}catch{/* storage unavailable */}}
  function unitToggle(get,set){
    const box=el("div",null,"rules-units ui-segmented");box.setAttribute("role","group");box.setAttribute("aria-label","Display units");
    const buttons=["mm","mil"].map(u=>button(u,()=>{set(u);paint();},"ui-segment"));
    function paint(){buttons.forEach(b=>b.setAttribute("aria-pressed",String(b.textContent===get())));}
    box.append(...buttons);paint();return {node:box,paint};
  }
  function field(label,control,note){
    const l=el("label",null,"rules-field");control.classList.add(control.type==="checkbox"?"ui-checkbox":"ui-field");l.append(el("span",label,"rules-field-label"),control);
    if(note)l.append(el("small",note,"rules-note"));return l;
  }
  function boardLayers(doc){
    const s=new Set(["Top","Bottom"]);
    try{
      const st=globalThis.AtriumStackup,list=st?.copperLayers?.(doc)||st?.layers?.(doc);
      if(Array.isArray(list))for(const x of list){const n=typeof x==="string"?x:x?.name||x?.layer;if(copperIndex(n)!=null)s.add(n);}
    }catch{/* the stackup module is optional */}
    for(const i of doc.items){for(const l of [i.layer,i.fromLayer,i.toLayer])if(copperIndex(l)!=null)s.add(l);}
    return [...s].sort((a,b)=>copperIndex(a)-copperIndex(b));
  }
  const keyOf=s=>s.kind+":"+(s.category||s.type||s.id||s.what||"");

  // "Rules for This…" (context-menu.js): the next open() shows the rules that apply to this object first.
  let nextSubject=null,openEditor=null;
  function rulesFor(subject){nextSubject=subject&&typeof subject==="object"?subject:null;}
  // The Rules and Constraints Editor: non-modal, from the schematic or the layout (the project's board), one
  // at a time. With project rules (project-rules.js) it edits the project's rule book: this board's rules,
  // their severity and boards, and the schematic (ERC) rules; Signals and Tags are the signal model's.
  function open(ctx) {
    const lazy=globalThis.AtriumLazy;
    if(!globalThis.AtriumQuery && lazy?.modules?.().includes("AtriumQuery"))return lazy.need("AtriumQuery").then(()=>open(ctx),e=>ctx.info?.(e.message));
    const {project}=ctx,D=globalThis.AtriumAltiumRules,emptySources=[],P=globalThis.AtriumProjectRules,E=globalThis.AtriumERC;
    const subject=nextSubject;nextSubject=null;
    const doc=ctx.doc?.kind==="pcb"?ctx.doc:project?.documents?.find(x=>x.kind==="pcb");
    if(!doc){if(E?.options)return E.options(ctx);ctx.info?.("Rules apply to a board layout; this project has none yet.");return null;}
    const V=globalThis.AtriumDocViews;
    if(openEditor){
      if(openEditor.open)openEditor.close();
      // The native close event is queued. Release the old view before mounting its replacement.
      V?.close("rules");
    }
    const allBoards=project.documents.filter(x=>x.kind==="pcb");
    const book=P?P.book(project):null,extras=new Map();
    if(book)for(const r of book.list)if(!P.isErc(r.type)&&r.where!=="schematic"&&P.appliesToBoard(r,doc.id)){const x={};for(const k of ["severity","where","boards","exceptBoards","origin"])if(r[k]!==undefined)x[k]=JSON.parse(JSON.stringify(r[k]));extras.set(r.id,x);}
    const copyRules=rules=>JSON.parse(JSON.stringify(rules));
    let ercWork=book?copyRules(book.list.filter(r=>P.isErc(r.type)&&r.type!==P.CALCULATION)):[];
    const calcRules=book?copyRules(book.list.filter(r=>r.type===P.CALCULATION)):[],calcDefaults={...book?.calculationTolerances};
    let calcBase=copyRules(calcRules),calcDefaultsBase={...calcDefaults},calcLoading=null;
    let extrasBase=JSON.stringify([...extras]),ercBase=JSON.stringify(ercWork),sourceAdoption=null;
    let working=migrate(stored(doc,project)),baseline=JSON.stringify(working);
    const fieldDrafts=new Map();
    // Rules a newer Waffle wrote (setAside): shown read-only, written back unchanged on save (compat.js).
    const newer=(project?.atriumCompat?.rules?.[""]?.rules||[]).map(([,r])=>r).filter(r=>plain(r)&&!P?.isErc(r.type)&&(!P||P.appliesToBoard(r,doc.id)));
    const sourceView=()=>P?.sourceDocument(doc)||doc;
    const editorProject=globalThis.AtriumNavHost?.project?.()===project?()=>globalThis.AtriumNavHost.project():null;
    let openedSources=sourceView().sourceRules||emptySources, sources=openedSources, pickedRuleFile;
    let unit=initialUnit(ctx),sel=subject?{kind:"for"}:{kind:"root"},sourceQuery="",classChoice={net:null,pair:null},candidates=null;
    const components=[...new Set(doc.items.filter(i=>i.kind==="part"&&i.ref).map(i=>i.ref))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    const componentClassNames=globalThis.AtriumComponentClasses?[...AtriumComponentClasses.map(doc,project).keys()].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})):[];
    // Signal and tag names for the Signal and Tag scopes (signals.js; the legacy model without a store).
    const signalNames=(()=>{try{const M=globalThis.AtriumSignals?.model(project,doc);if(!M)return {signals:[],tags:[]};const tags=new Set([...(M.store.tags||[]).map(t=>t.name)]);for(const s of M.signals)for(const t of s.tags)tags.add(t);
      return {signals:M.signals.map(s=>s.name).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})),tags:[...tags].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))};}catch{return {signals:[],tags:[]};}})();
    const collapsed=new Set(),baseNets=boardNets(doc,null),copperLayers=boardLayers(doc),otherLayers=["Silk","Bottom silk","Top mask","Bottom mask","Top paste","Bottom paste"];
    const d=el("dialog",null,"ui-dialog work-dialog rules-editor rules-window");d.setAttribute("aria-label","Rules and Constraints Editor");openEditor=d;
    const head=el("div",null,"rules-head"),sub=el("span",null,"rules-sub");
    const units=unitToggle(()=>unit,u=>{unit=u;rememberUnit(u);paintPane();});
    const act=a=>globalThis.AtriumNavHost?.act?.(a);
    const views=el("div",null,"rules-views");
    views.append(button("Constraint Manager…",()=>act("constraints"),"rules-view-link"),button("Rule Sets…",()=>act("rule-sets"),"rules-view-link"),button("Signals…",()=>act("signals-panel"),"rules-view-link"));
    const close=el("button","×","ui-close rules-close");close.type="button";close.onclick=()=>d.close();close.title="Close";close.setAttribute("aria-label","Close");
    close.setAttribute("aria-label","Close Rules and Constraints Editor");
    head.append(el("h2","Rules and Constraints Editor","ui-dialog-title"),sub,views,units.node,close);
    const body=el("div",null,"rules-body ui-dialog-body"),tree=el("div",null,"rules-tree"),pane=el("section",null,"rules-pane");
    tree.setAttribute("role","tree");tree.setAttribute("aria-label","Design rules");body.append(tree,pane);
    const feedback=el("p",null,"rules-feedback"),status=el("p",null,"rules-status"),footer=el("div",null,"work-actions ui-dialog-actions rules-footer");
    feedback.setAttribute("role","alert");status.setAttribute("role","status");
    const report=e=>{feedback.textContent=e?.message||String(e||"");};
    const safe=fn=>async(...a)=>{try{feedback.textContent="";await fn(...a);}catch(e){report(e);}};
    const rulesOf=type=>working.list.filter(r=>r.type===type).sort((a,b)=>a.priority-b.priority);
    const byId=id=>working.list.find(r=>r.id===id);
    // Scopes that match no object on this board (rule id -> ["scope" | "scope2"]), recomputed
    // when a scope or class changes. The board geometry is read once, on first need.
    let coverageGeo=null,coverageKey=null,coverageMap=new Map(),coverageRevision=ctx.revision?.();
    function invalidateCoverage(){
      const rev=ctx.revision?.();
      if(rev!==coverageRevision){coverageGeo=null;coverageKey=null;coverageRevision=rev;}
    }
    function coverage(){
      invalidateCoverage();
      const scopes=globalThis.AtriumDesignQueryRecord;
      if(!working.list.some(r=>!scopes.isAll(r.scope)||r.scope2&&!scopes.isAll(r.scope2)))return coverageMap=new Map();
      const key=JSON.stringify([working.list.map(r=>[r.id,r.scope,r.scope2]),working.netClasses,working.diffPairs,working.diffPairClasses]);
      if(key===coverageKey)return coverageMap;
      const m=new Map();
      try{
        const defs=ctx.defs||new Map();coverageGeo??=extract(doc,defs);
        for(const e of emptyScopes(doc,defs,compile(working,{doc,project,explicit:true}),coverageGeo)){if(!m.has(e.id))m.set(e.id,[]);m.get(e.id).push(e.which);}
      }catch{/* a scope still being typed: report nothing until it is valid */}
      coverageKey=key;return coverageMap=m;
    }
    const emptyText=(r,which)=>{
      const q=w=>scopeQuery(r[w]),both=which.length>1;
      return (both?"Neither scope ("+q("scope")+", "+q("scope2")+") matches":"The "+(TYPES[r.type].two?(which[0]==="scope2"?"second ":"first "):"")+"scope "+q(which[0])+" matches")+" no objects on "+(doc.name||"this board")+", so this rule checks nothing.";
    };
    const netList=()=>{const s=new Set(baseNets);for(const p of working.diffPairs||[]){s.add(p.positive);s.add(p.negative);}for(const m of Object.values(working.netClasses||{}))m.forEach(n=>s.add(n));return [...s].sort(cmp);};
    function uniqueName(base,taken=[...working.list,...newer].map(r=>String(r.name))){
      const names=new Set(taken.map(n=>n.toLowerCase()));base=base.trim().slice(0,120)||"Rule";let name=base,n=1;
      while(names.has(name.toLowerCase()))name=base+"_"+(n++);return name;
    }
    function place(r,position){
      const list=rulesOf(r.type).filter(x=>x!==r);list.splice(Math.max(0,Math.min(list.length,position-1)),0,r);
      if(!working.list.includes(r))working.list.push(r);list.forEach((x,i)=>x.priority=i+1);
    }
    function select(s,focus){
      sel=s;feedback.textContent="";paintTree();paintPane();
      if(focus)[...tree.children].find(row=>row.dataset.key===keyOf(s))?.focus();
    }

    // Tree of categories, rule types and rules, then definitions and source rules.
    function paintTree(){
      tree.replaceChildren();
      const add=(label,s,level,opts={})=>{
        const row=el("div",null,"rules-node"+(opts.muted?" is-muted":"")),key=keyOf(s),selected=key===keyOf(sel);
        row.setAttribute("role","treeitem");row.setAttribute("aria-level",String(level));row.setAttribute("aria-selected",String(selected));
        row.dataset.key=key;row.dataset.level=String(level);row.style.setProperty("--level",String(level-1));row.tabIndex=selected?0:-1;
        const twisty=el("span",opts.expandable?(collapsed.has(key)?"▸":"▾"):"","rules-twisty");twisty.setAttribute("aria-hidden","true");
        if(opts.expandable){row.setAttribute("aria-expanded",String(!collapsed.has(key)));twisty.onclick=e=>{e.stopPropagation();toggle(key);};}
        row.append(twisty,el("span",label,"rules-node-label"));
        if(opts.warn){const w=el("span","!","rules-node-warn");w.title=opts.warn;w.setAttribute("aria-label","Warning: "+opts.warn);row.append(w);}
        if(opts.count!=null)row.append(el("span",String(opts.count),"rules-count"));
        row._sel=s;row.onclick=()=>select(s,true);tree.append(row);
      };
      if(subject)add("Rules for This…",{kind:"for"},1);
      add("Design Rules",{kind:"root"},1,{count:working.list.length});
      add("Rule Hints",{kind:"hints"},2);
      for(const category of CATEGORIES){
        const s={kind:"category",category};add(category,s,2,{expandable:true});if(collapsed.has(keyOf(s)))continue;
        for(const type of ORDER.filter(t=>TYPES[t].category===category)){
          const rs=rulesOf(type),ts={kind:"type",type};add(TYPES[type].title,ts,3,{expandable:rs.length>0,count:rs.length});
          if(!collapsed.has(keyOf(ts))){const cov=coverage();for(const r of rs)add(r.name+(working.ruleSets&&r.set?" · "+r.set:""),{kind:"rule",id:r.id},4,{muted:!ruleActive(working,r),warn:cov.has(r.id)?emptyText(r,cov.get(r.id)):null});}
        }
      }
      // Net classes, differential pairs and their classes are signals and tags (signals.js), edited there.
      add("Signals and Tags",{kind:"signals"},1);
      if(E)add("Schematic",{kind:"schematic"},1,{count:ercWork.length});
      if(project.documents.some(d=>d.kind==="schematic")){
        const calc={kind:"calculations"};
        add("Calculations",calc,1,{expandable:calcRules.length>0,count:calcRules.length});
        if(!collapsed.has(keyOf(calc)))for(const sheet of project.documents){
          const count=calcRules.filter(r=>r.origin.sheet===sheet.id).length;
          if(count)add(sheet.name,{kind:"calculation-sheet",id:sheet.id},2,{count});
        }
      }
      add("Altium Source Rules",{kind:"sources"},1,{count:sources.length});
      if(newer.length)add("From a Newer Version",{kind:"newer"},1,{count:newer.length,muted:true});
    }
    function toggle(key){if(collapsed.has(key))collapsed.delete(key);else collapsed.add(key);paintTree();[...tree.children].find(r=>r.dataset.key===key)?.focus();}
    tree.onkeydown=e=>{
      const rows=[...tree.children],i=rows.indexOf(document.activeElement);if(i<0)return;
      const row=rows[i],go=n=>{if(rows[n]){e.preventDefault();select(rows[n]._sel,true);}};
      if(e.key==="ArrowDown")go(i+1);else if(e.key==="ArrowUp")go(i-1);else if(e.key==="Home")go(0);else if(e.key==="End")go(rows.length-1);
      else if(e.key==="ArrowRight"&&row.hasAttribute("aria-expanded")){
        if(row.getAttribute("aria-expanded")==="false"){e.preventDefault();toggle(row.dataset.key);}
        else if(Number(rows[i+1]?.dataset.level)>Number(row.dataset.level))go(i+1);
      }
      else if(e.key==="ArrowLeft"){
        e.preventDefault();
        if(row.getAttribute("aria-expanded")==="true")toggle(row.dataset.key);
        else{const level=Number(row.dataset.level);for(let n=i-1;n>=0;n--)if(Number(rows[n].dataset.level)<level){select(rows[n]._sel,true);break;}}
      }
      else if(e.key==="Enter"||e.key===" "){e.preventDefault();select(row._sel,true);}
    };

    function paintPane(){
      pane.replaceChildren();units.paint();
      sub.textContent=doc.name+" · "+working.list.length+" rules";
      if(sel.kind==="rule"&&!byId(sel.id))sel={kind:"root"};
      if(sel.kind==="root")return summaryView(working.list,"Design Rules","Every rule on this board by category and priority. Select a rule to edit it.");
      if(sel.kind==="hints")return hintView();
      if(sel.kind==="category")return summaryView(working.list.filter(r=>TYPES[r.type].category===sel.category),sel.category);
      if(sel.kind==="type")return typeView(sel.type);
      if(sel.kind==="rule")return ruleView(byId(sel.id));
      if(sel.kind==="signals")return signalsView();
      if(sel.kind==="schematic")return schematicView();
      if(sel.kind==="calculations"||sel.kind==="calculation-sheet")return calculationView();
      if(sel.kind==="for")return forView();
      if(sel.kind==="newer")return newerView();
      sourcesView();
    }
    function ruleTable(rules,{type,order}={}){
      const table=el("table",null,"rules-table"),thead=el("thead"),hr=el("tr"),tbody=el("tbody");
      for(const h of ["Name","Priority","Enabled",...(type?["Type"]:[]),"Scope","Attributes",...(order?["Order"]:[])])hr.append(el("th",h));
      thead.append(hr);table.append(thead,tbody);
      for(const r of rules.slice().sort((a,b)=>ORDER.indexOf(a.type)-ORDER.indexOf(b.type)||a.priority-b.priority)){
        const tr=el("tr",null,r.enabled?"":"is-muted"),cell=(...n)=>{const td=el("td");td.append(...n);tr.append(td);return td;};
        cell(button(r.name,()=>select({kind:"rule",id:r.id}),"rules-link"));cell(String(r.priority));
        const on=el("input");on.type="checkbox";on.checked=r.enabled;on.setAttribute("aria-label","Enable "+r.name);
        on.onchange=()=>{r.enabled=on.checked;tr.classList.toggle("is-muted",!r.enabled);paintTree();};cell(on);
        if(type)cell(TYPES[r.type].title);
        const scopeCell=cell(el("code",scopeQuery(r.scope)+(r.scope2?" , "+scopeQuery(r.scope2):""),"rules-query"));
        const cov=coverage().get(r.id);if(cov){const w=el("span","Matches nothing","rules-scope-flag");w.title=emptyText(r,cov);scopeCell.append(" ",w);}
        cell(constraintText(r,unit));
        if(order){
          const up=button("▲",()=>move(r,-1),"rules-icon"),down=button("▼",()=>move(r,1),"rules-icon");
          up.setAttribute("aria-label","Increase priority of "+r.name);down.setAttribute("aria-label","Decrease priority of "+r.name);
          up.disabled=r.priority===1;down.disabled=r.priority===rulesOf(r.type).length;cell(up,down);
        }
        tbody.append(tr);
      }
      const wrap=el("div",null,"rules-table-wrap");wrap.append(table);return wrap;
    }
    function hintView(){
      pane.append(el("h3","Rule Hints"),el("p","Scope, priority and limit checks for the enabled rules on "+doc.name+". Select a rule to inspect its settings.","rules-help"));
      const L=globalThis.AtriumRuleLint;
      if(!L){
        const loading=el("p","Checking rules…","rules-help");pane.append(loading);
        globalThis.AtriumLazy.need("AtriumRuleLint").then(()=>{if(loading.isConnected)paintPane();},report);return;
      }
      invalidateCoverage();
      const set={...working,list:working.list.filter(r=>extras.get(r.id)?.severity!=="off")};
      const {hints,limited}=L.analyze(set,{board:doc,project,defs:ctx.defs,geometry:coverageGeo});
      if(!hints.length)pane.append(el("p","No rule hints found.","rules-help"));
      const list=el("ul",null,"rules-hints");
      for(const hint of hints){
        const li=el("li"),title=el("strong",hint.title);
        li.append(title,button(byId(hint.rule).name,()=>select({kind:"rule",id:hint.rule},true),"rules-link"),el("p",hint.explanation));
        list.append(li);
      }
      if(hints.length)pane.append(list);
      if(limited)pane.append(el("p","Some scope checks reached the analysis limit. Their coverage is undetermined.","rules-help"));
    }
    function newerView(){
      pane.append(el("h3","From a Newer Version"),el("p","A newer Waffle wrote these rules. This version doesn't check them and can't edit them; they are kept unchanged when you save.","rules-help"));
      const table=el("table",null,"rules-table"),hr=el("tr"),tbody=el("tbody"),head=el("thead");
      for(const h of ["Name","Type","Enabled","Priority"])hr.append(el("th",h));head.append(hr);table.append(head,tbody);
      for(const r of newer){const tr=el("tr",null,"is-muted");for(const v of [r.name,r.type,r.enabled===false?"No":"Yes",r.priority])tr.append(el("td",v==null?"":String(v)));tbody.append(tr);}
      const wrap=el("div",null,"rules-table-wrap");wrap.append(table);pane.append(wrap);
    }
    function summaryView(rules,heading,help){
      pane.append(el("h3",heading));if(help)pane.append(el("p",help,"rules-help"));
      pane.append(rules.length?ruleTable(rules,{type:true}):el("p","No rules in this category.","rules-help"));
    }
    function typeView(type){
      const t=TYPES[type],rs=rulesOf(type),tools=el("div",null,"rules-toolbar");
      tools.append(button("New rule",()=>newRule(type)));
      pane.append(el("h3",t.title),el("p",t.help,"rules-help"),tools);
      pane.append(rs.length?ruleTable(rs,{order:true}):el("p","No "+t.title+" rules. Nothing is checked for this rule type.","rules-help"));
    }
    function newRule(type){
      const r=make(type,uniqueName(TYPES[type].altium));place(r,1);
      select({kind:"rule",id:r.id});status.textContent=r.name+" added with the highest priority.";
    }
    function move(r,delta){
      const rs=rulesOf(r.type),i=rs.indexOf(r),j=i+delta;if(j<0||j>=rs.length)return;
      [rs[i].priority,rs[j].priority]=[rs[j].priority,rs[i].priority];paintTree();paintPane();
    }
    function ruleView(r){
      const t=TYPES[r.type],count=rulesOf(r.type).length,heading=el("h3",r.name),tools=el("div",null,"rules-toolbar");
      const dup=button("Duplicate",()=>{
        const copy=canonical(r);copy.id=newId();copy.name=uniqueName(r.name);place(copy,r.priority);
        select({kind:"rule",id:copy.id});status.textContent=copy.name+" added above "+r.name+".";
      });
      const del=button("Delete",()=>{
        working.list=working.list.filter(x=>x!==r);rulesOf(r.type).forEach((x,i)=>x.priority=i+1);
        select({kind:"type",type:r.type});status.textContent=r.name+" deleted. Close without applying to keep it.";
      });
      const up=button("Increase priority",()=>move(r,-1)),down=button("Decrease priority",()=>move(r,1));
      up.disabled=r.priority===1;down.disabled=r.priority===count;tools.append(dup,del,up,down);
      pane.append(heading,el("p",t.category+" › "+t.title+". "+t.help,"rules-help"),tools);
      const form=el("div",null,"rules-form"),name=el("input"),comment=el("input"),enabled=el("input");
      name.value=r.name;name.maxLength=128;name.setAttribute("aria-label","Rule name");
      name.onchange=()=>{
        const v=name.value.trim();
        if(!v){name.value=r.name;return report(Error("A rule needs a name."));}
        if(working.list.some(x=>x!==r&&x.name.toLowerCase()===v.toLowerCase())){name.value=r.name;return report(Error("Another rule is already named "+v+"."));}
        r.name=v;name.value=v;heading.textContent=v;feedback.textContent="";paintTree();
      };
      comment.value=r.comment||"";comment.maxLength=4000;comment.setAttribute("aria-label","Rule comment");comment.onchange=()=>{r.comment=comment.value;};
      enabled.type="checkbox";enabled.checked=r.enabled;enabled.setAttribute("aria-label","Rule enabled");enabled.onchange=()=>{r.enabled=enabled.checked;paintTree();};
      form.append(field("Name",name),field("Comment",comment),field("Enabled",enabled),
        ...(working.ruleSets?.length?[field("Rule set",(()=>{const s=el("select");s.setAttribute("aria-label","Rule set");for(const g of working.ruleSets)s.add(new Option(g.name+(g.enabled===false?" (disabled)":""),g.name));
          s.value=working.ruleSets.find(g=>g.name.toLowerCase()===ruleSetOf(r).toLowerCase())?.name||DEFAULT_RULE_SET;s.onchange=()=>{if(s.value.toLowerCase()==="default")delete r.set;else r.set=s.value;paintTree();};return s;})())]:[]),
        field("Priority",el("span",r.priority+" of "+count,"rules-value")),...v3Fields(r));
      pane.append(form);
      const scopes=t.two?[scopeEditor(r,"scope","Where the first object matches"),scopeEditor(r,"scope2","Where the second object matches")]:[scopeEditor(r,"scope","Where the object matches")];
      const warn=el("p",null,"rules-scope-warning");warn.setAttribute("role","status");warn.setAttribute("aria-live","polite");
      let soon=0;
      const refresh=()=>{const w=coverage().get(r.id);warn.hidden=!w;warn.textContent=w?emptyText(r,w):"";
        const node=[...tree.children].find(n=>n.dataset.key===keyOf({kind:"rule",id:r.id}));if(node&&!!node.querySelector(".rules-node-warn")!==!!w)paintTree();};
      for(const fs of scopes){fs.addEventListener("change",()=>{clearTimeout(soon);soon=setTimeout(refresh,60);});fs.addEventListener("input",()=>{clearTimeout(soon);soon=setTimeout(refresh,250);});}
      pane.append(...scopes,warn);refresh();
      pane.append(constraintsEditor(r));
      if(r.type==="polygonConnect")pane.append(connectHelp(),currentsEditor());
    }
    function scopeEditor(r,key,legend){
      const fs=el("fieldset",null,"rules-scope"),kind=el("select"),value=el("select"),preview=el("code",scopeQuery(r[key]),"rules-query");
      fs.append(el("legend",legend));kind.setAttribute("aria-label",legend+": object kind");value.setAttribute("aria-label",legend+": value");
      const records=globalThis.AtriumDesignQueryRecord, selected=()=>records.toSelector(r[key]);
      for(const [k,label] of SCOPE_KINDS)kind.add(new Option(label,k));kind.value=selected()?.kind||"query";
      // "All Nets" and "All Components" are built-in classes, as in Altium.
      const builtin=(name,list)=>[name,...list.filter(n=>n.toLowerCase()!==name.toLowerCase())];
      const choices=k=>k==="net"?netList():k==="netclass"?builtin("All Nets",Object.keys(working.netClasses||{})):k==="diffpair"?(working.diffPairs||[]).map(p=>p.name):
        k==="diffpairclass"?builtin("All Differential Pairs",Object.keys(working.diffPairClasses||{})):k==="layer"?[...copperLayers,...otherLayers]:k==="component"?components:k==="componentclass"?builtin("All Components",componentClassNames):k==="signal"?signalNames.signals:k==="tag"?signalNames.tags:[];
      const empty={signal:"Declare a signal in the Signals panel first.",tag:"Tag a signal or net first.",componentclass:"Create a component class first (Design → Classes…).",component:"This board has no components.",net:"This board has no named nets.",netclass:"Create a net class under Net Classes first.",diffpair:"Define a differential pair under Differential Pairs first.",diffpairclass:"Create a differential pair class first."};
      function fill(){
        value.replaceChildren();const k=kind.value,list=choices(k),choice=selected(),current=choice?.kind===k?choice.value:undefined;value.hidden=k==="all"||!choice;
        if(current!=null&&!list.includes(current))value.add(new Option(current+" (not on this board)",current));
        for(const v of list)value.add(new Option(k==="layer"?layerLabel(v):v,v));
        if(current!=null)value.value=current;
      }
      kind.onchange=()=>{
        const k=kind.value;
        if(k==="all")r[key]=records.selector("all");
        else{const list=choices(k);if(!list.length){kind.value=selected()?.kind||"query";return report(Error(empty[k]));}r[key]=records.selector(k,list[0]);}
        feedback.textContent="";fill();preview.textContent=scopeQuery(r[key]);
      };
      value.onchange=()=>{r[key]=records.selector(kind.value,value.value);preview.textContent=scopeQuery(r[key]);};
      fill();const row=el("div",null,"rules-scope-row");row.append(kind,value);globalThis.AtriumQuery?.scopeField?.({row,kind,value,preview,rule:r,key,scopeQuery,project,doc,defs:ctx.defs});fs.append(row,el("span","Query","rules-field-label"),preview);return fs;
    }
    function numberField(input, r, path, options) {
      const target={scope:"rule",documentId:doc.id,ruleId:r.id,path};
      globalThis.AtriumLazy?.numericField?.(input,{...options,target,project,
        prior:()=>{const ui=globalThis.AtriumNumericFields, k=ui.key(target);return fieldDrafts.has(k)?fieldDrafts.get(k).entry:ui.stored(project,target);},
        stage:entry=>{const ui=globalThis.AtriumNumericFields,k=ui.key(target);
          if(entry || ui.stored(project,target))fieldDrafts.set(k,{target,entry});else fieldDrafts.delete(k);}
      });
    }
    function lengthInput(r,f,target,key,label,inherit,path=[key]){
      const input=el("input"),optional=f.optional||inherit!==undefined;
      input.type="text";input.inputMode="decimal";input.autocomplete="off";input.setAttribute("aria-label",label+" ("+unit+")");
      input.placeholder=inherit!==undefined?(inherit==null?"—":String(lengthValue(inherit,unit))):optional?"No limit":"";
      numberField(input,r,path,{unit,storageUnit:"mm",nanometres:true,optional,max:f.signed?100:f.upper ?? MAX_LENGTH,min:f.signed?-100:0});
      const show=()=>{input.value=target()?.[key]==null?"":String(lengthValue(target()[key],unit));};show();
      const bad=m=>{input.setAttribute("aria-invalid","true");report(Error(m));};
      input.onchange=()=>{
        const text=input.value.trim();let v=null;
        if(text){v=parseLength(text,unit);if(!Number.isFinite(v))return bad("Enter a length such as 0.2, 0.2mm or 8mil.");}
        else if(!optional)return bad(label+" requires a value.");
        const obj=target(true),had=own(obj,key),before=obj[key];
        if(v==null&&inherit!==undefined)delete obj[key];else obj[key]=v;
        try{if(v!=null)checkLength(f,v,label);checkRanges(r);}
        catch(e){if(had)obj[key]=before;else delete obj[key];target(false);return bad(e.message);}
        target(false);input.removeAttribute("aria-invalid");feedback.textContent="";show();
      };
      const wrap=el("span",null,"rules-length");wrap.append(input,el("span",unit,"rules-unit"));return wrap;
    }
    function constraintsEditor(r){
      const t=TYPES[r.type],fs=el("fieldset",null,"rules-constraints"),grid=el("div",null,"rules-form"),extras=[];
      fs.append(el("legend","Constraints"));
      if(!t.fields.length){fs.append(el("p","This rule has no values. Every net in scope is checked.","rules-help"));return fs;}
      for(const f of t.fields){
        if(f.kind==="length")grid.append(field(f.label,lengthInput(r,f,()=>r,f.key,f.label),f.info?"Used by routing tools. Not checked.":null));
        else if(f.kind==="ps"){const n=el("input");n.type="number";n.min="0";n.step="0.1";n.value=r[f.key]==null?"":String(r[f.key]);n.placeholder=f.optional?"none":"";n.setAttribute("aria-label",f.label);
          numberField(n,r,[f.key],{unit:"ps",min:0,max:1e6,optional:!!f.optional});
          n.onchange=()=>{const t=n.value.trim();if(!t&&f.optional){r[f.key]=null;feedback.textContent="";return;}const v=Number(t);if(!Number.isFinite(v)||v<0||v>1e6){n.value=r[f.key]==null?"":String(r[f.key]);return report(Error(f.label+" must be a delay from 0 to 1000000 ps."));}r[f.key]=v;feedback.textContent="";};
          grid.append(field(f.label,n));}
        else if(f.kind==="volts"){const n=el("input");n.type="number";n.step="any";n.value=String(r[f.key]);n.setAttribute("aria-label",f.label);
          numberField(n,r,[f.key],{unit:"V"});
          n.onchange=()=>{const v=n.valueAsNumber;if(!Number.isFinite(v)){n.value=String(r[f.key]);return report(Error("Enter a finite supply voltage."));}r[f.key]=v;};grid.append(field(f.label,n));}
        else if(f.kind==="amps"){const n=el("input");n.type="number";n.min="0";n.max="1000";n.step="0.1";n.value=String(r[f.key]??0);n.setAttribute("aria-label",f.label);
          numberField(n,r,[f.key],{unit:"A",min:0,max:1000});
          n.onchange=()=>{const v=Number(n.value.trim()||0);if(!Number.isFinite(v)||v<0||v>1000){n.value=String(r[f.key]??0);return report(Error(f.label+" must be a current from 0 to 1000 A."));}r[f.key]=v;feedback.textContent="";};
          grid.append(field(f.label,n,"0 uses the Net currents or Class currents in the rule file, if any."));}
        else if(f.kind==="bool"&&f.optional){
          const c=el("select");for(const [label,value] of [["Unspecified",""],["Yes","true"],["No","false"]])c.add(new Option(label,value));
          c.value=r[f.key]==null?"":String(r[f.key]);c.setAttribute("aria-label",f.label);
          c.onchange=()=>{if(c.value==="")delete r[f.key];else r[f.key]=c.value==="true";};grid.append(field(f.label,c));
        }
        else if(f.kind==="bool"){const c=el("input");c.type="checkbox";c.checked=r[f.key];c.setAttribute("aria-label",f.label);c.onchange=()=>{r[f.key]=c.checked;};grid.append(field(f.label,c));}
        else if(f.kind==="choice"){const s=el("select");s.setAttribute("aria-label",f.label);for(const [k,label] of f.options)s.add(new Option(label,k));s.value=String(r[f.key]);
          s.onchange=()=>{r[f.key]=f.options.find(([k])=>String(k)===s.value)[0];};grid.append(field(f.label,s));}
        else if(f.kind==="integer"){
          const n=el("input");n.type="number";n.min=String(f.min);n.max=String(f.max);n.step="1";n.value=String(r[f.key]);n.setAttribute("aria-label",f.label);
          numberField(n,r,[f.key],{unit:"",min:f.min,max:f.max,integer:true});
          n.onchange=()=>{const v=Number(n.value);if(!Number.isInteger(v)||v<f.min||v>f.max){n.value=String(r[f.key]);return report(Error(f.label+" must be a whole number from "+f.min+" to "+f.max+"."));}r[f.key]=v;feedback.textContent="";};
          grid.append(field(f.label,n));
        }
        else if(f.kind==="profile")grid.append(field(f.label,profileSelect(r,f),"Min, preferred and max come from the stack-up profile on each layer."));
        else if(f.kind==="layers")extras.push(layersEditor(r,f));
        else if(f.kind==="connectTable")extras.push(connectTable(r,f));
        else if(f.kind==="dfaMatrix")extras.push(el("p",(r[f.key]||[]).length+" package pairs. Edit the matrix in Design → Constraint Manager → DFA.","rules-help"));
        else if(f.kind==="clearanceMatrix")extras.push(clearanceMatrix(r,f));
        else if(f.kind==="layerTable"&&(!f.optional||r[f.key]&&Object.keys(r[f.key]).length))extras.push(layerTable(r,f));
      }
      fs.append(grid,...extras);
      // A new minimum clearance shows at once in the matrix's empty cells.
      const mx=extras.find(x=>x.refresh);if(mx)fs.addEventListener("change",e=>{if(!mx.contains(e.target))mx.refresh();});
      return fs;
    }
    // Clearance object-kind matrix: "Single value for all" (the default, no matrix stored)
    // or a lower-triangular grid of gaps; an empty cell uses the minimum clearance.
    const SHORT={track:"Track",arc:"Arc",smd:"SMD",th:"TH",via:"Via",fill:"Fill",poly:"Poly",region:"Region",text:"Text",hole:"Hole"};
    function clearanceMatrix(r,f){
      const box=el("div",null,"rules-matrix-box"),mode=el("div",null,"rules-units rules-matrix-mode"),note=el("small",null,"rules-note");
      const wrap=el("div",null,"rules-table-wrap rules-matrix-wrap"),table=el("table",null,"rules-matrix ui-matrix");
      mode.setAttribute("role","group");mode.setAttribute("aria-label",f.label);wrap.append(table);
      let stash=r.objects?{...r.objects}:{};
      const single=button("Single value for all",()=>use(false)),perKind=button("Per object kind",()=>use(true));
      mode.append(single,perKind);
      function use(on){
        if(on===!!r.objects)return;
        if(on)r.objects={...stash};else{stash={...r.objects};r.objects=null;}
        status.textContent=on?"Per object kind: set a cell to override the minimum clearance for that pair.":"Single value: the minimum clearance applies to every pair."+(Object.keys(stash).length?" Switch back before closing to keep the "+Object.keys(stash).length+" cell values.":"");
        paint();(on?perKind:single).focus();
      }
      function cellInput(a,b){
        const k=clearKey(a,b),input=el("input",null,"ui-field-number"),label="Clearance "+CLEAR_KINDS[CK_INDEX.get(a)][1]+" to "+CLEAR_KINDS[CK_INDEX.get(b)][1];
        input.type="text";input.inputMode="decimal";input.autocomplete="off";input.setAttribute("aria-label",label+" ("+unit+")");
        numberField(input,r,["objects",k],{unit,storageUnit:"mm",nanometres:true,optional:true,min:0,max:MAX_LENGTH});
        // An empty hole cell is not checked (a plated hole lies inside its pad); others inherit the gap.
        const hole=a==="hole"||b==="hole";
        input.placeholder=hole?"—":String(lengthValue(r.gap,unit));input.value=own(r.objects,k)?String(lengthValue(r.objects[k],unit)):"";
        input.dataset.valueSource=own(r.objects,k)?"override":"inherited";input.title=label+(hole?": empty = not checked":": empty = minimum clearance");
        input.onchange=()=>{
          const text=input.value.trim();
          if(!text){delete r.objects[k];input.dataset.valueSource="inherited";input.removeAttribute("aria-invalid");feedback.textContent="";return;}
          const v=parseLength(text,unit);
          if(!Number.isFinite(v)||v<0||v>MAX_LENGTH){input.setAttribute("aria-invalid","true");return report(Error(label+": enter a length from 0 to 1000 mm, such as 0.2, 0.2mm or 8mil."));}
          r.objects[k]=v;input.value=String(lengthValue(v,unit));input.dataset.valueSource="override";input.removeAttribute("aria-invalid");feedback.textContent="";
        };
        return input;
      }
      function paint(){
        const on=!!r.objects;
        single.setAttribute("aria-pressed",String(!on));perKind.setAttribute("aria-pressed",String(on));wrap.hidden=!on;
        note.textContent=on?"Gap between two kinds of object, in "+unit+". Empty cells use the minimum clearance ("+formatLength(r.gap,unit)+"), except Hole cells (—), which are checked only where set. Poly and Text cells are kept for Altium: pours use their own clearance and copper text is not checked."
          :"The minimum clearance applies to every pair of objects. Choose Per object kind for a different gap between, for example, SMD pads and vias.";
        table.replaceChildren();if(!on)return;
        const thead=el("thead"),hr=el("tr"),tbody=el("tbody");
        hr.append(el("th",""));for(const [k,label] of CLEAR_KINDS){const th=el("th",SHORT[k]);th.title=label;th.scope="col";hr.append(th);}
        thead.append(hr);
        CLEAR_KINDS.forEach(([a,label],i)=>{
          const tr=el("tr"),th=el("th",label);th.scope="row";tr.append(th);
          CLEAR_KINDS.forEach(([b],j)=>{const td=el("td");if(j<=i&&!(a==="hole"&&b==="hole"))td.append(cellInput(a,b));else td.className="is-blank";tr.append(td);});
          tbody.append(tr);
        });
        table.append(thead,tbody);
      }
      box.refresh=paint;
      box.append(el("span",f.label,"rules-field-label"),mode,note,wrap);paint();
      return box;
    }
    function profileSelect(r,f){
      const s=el("select");s.setAttribute("aria-label",f.label);s.add(new Option("None (use the values below)",""));
      let list=[];try{list=globalThis.AtriumStackup?.impedanceProfiles?.(doc,ctx.defs)||[];}catch{list=[];}
      for(const p of list.filter(p=>f.profileTypes.includes(p.type)))s.add(new Option(p.name+" · "+p.target+" Ω "+(p.type.includes("diff")?"differential":"single-ended"),p.id));
      if(r.impedanceProfile&&!list.some(p=>p.id===r.impedanceProfile))s.add(new Option(r.impedanceProfile+" (not in the stack-up)",r.impedanceProfile));
      s.value=r.impedanceProfile||"";
      if(!list.length)s.title="Define profiles in the Layer Stack Manager, Impedance tab.";
      s.onchange=()=>{r.impedanceProfile=s.value||null;};
      return s;
    }
    function layersEditor(r,f){
      const box=el("div",null,"rules-checks");box.setAttribute("role","group");box.setAttribute("aria-label",f.label);
      box.append(el("span",f.label,"rules-field-label"));
      for(const layer of [...new Set([...copperLayers,...r.excluded])]){
        const c=el("input"),l=el("label",null,"rules-check");c.type="checkbox";c.checked=!r.excluded.includes(layer);
        c.onchange=()=>{r.excluded=c.checked?r.excluded.filter(x=>x!==layer):[...r.excluded,layer];};
        l.append(c,el("span",layerLabel(layer)));box.append(l);
      }
      return box;
    }
    // Polygon Connect Style rows for through-hole pads, SMD pads and vias. An
    // empty cell inherits the rule value.
    function connectTable(r,f){
      const wrap=el("div",null,"rules-table-wrap"),table=el("table",null,"rules-table rules-layer-table"),hr=el("tr"),tbody=el("tbody");
      const fields=CONNECT_KEYS.map(k=>TYPES.polygonConnect.fields.find(x=>x.key===k));
      for(const h of ["Object",...fields.map(x=>x.label)])hr.append(el("th",h));
      const thead=el("thead");thead.append(hr);table.append(thead,tbody);
      for(const [kind,title] of CONNECT_KINDS){
        const tr=el("tr");tr.append(el("td",title));
        let row=r.kinds[kind]?{...r.kinds[kind]}:{};
        const target=write=>{
          if(write===true)return row;
          if(write===false){if(Object.keys(row).length)setOwn(r.kinds,kind,row);else delete r.kinds[kind];}
          return row;
        };
        for(const x of fields){
          const td=el("td");
          if(x.kind==="length")td.append(lengthInput(r,{...x,optional:true},target,x.key,title+" "+x.label,r[x.key],["kinds",kind,x.key]));
          else{
            const sel=el("select");sel.setAttribute("aria-label",title+" "+x.label);
            const inherited=x.options.find(([k])=>k===r[x.key])?.[1]??"";
            sel.add(new Option("Rule ("+inherited+")",""));for(const [k,label] of x.options)sel.add(new Option(label,k));
            sel.value=row[x.key]==null?"":String(row[x.key]);
            sel.onfocus=()=>{sel.options[0].text="Rule ("+(x.options.find(([k])=>k===r[x.key])?.[1]??"")+")";};
            sel.onchange=()=>{const opt=x.options.find(([k])=>String(k)===sel.value);if(opt)target(true)[x.key]=opt[0];else delete target(true)[x.key];target(false);};
            td.append(sel);
          }
          tr.append(td);
        }
        tbody.append(tr);
      }
      wrap.append(table);
      const box=el("div",null,"rules-layer-box");box.append(el("span",f.label,"rules-field-label"),el("small","Leave a cell empty to use the rule value. Rows apply to through-hole pads, surface-mount pads and vias respectively.","rules-note"),wrap);
      return box;
    }
    function connectHelp(){
      const box=el("details",null,"rules-auto-help");box.open=true;
      box.append(el("summary","How Auto (smart) decides"));
      const list=el("ol");
      for(const line of [
        "Per-pad overrides stored on the polygon win, then the highest-priority matching rule, then the polygon's Connect Style.",
        "Vias connect directly: they are not soldered, and a direct joint has the lowest impedance.",
        "Exposed and thermal pads (EP, PAD, or the largest pad of a QFN or DPAK) connect directly for heat transfer, with a via-array hint.",
        "Small SMD passives (0201 to 0805) get reliefs on every net, so both ends heat evenly and do not tombstone.",
        "Through-hole pads get reliefs for hand soldering.",
        "Other SMD pads connect directly on power and high-current nets: a Power net class, a current of 0.5 A or more, names such as VCC, VDD, VIN, VBUS, VBAT, PWR, +5V or 3V3, a Width rule preferring at least the power width above, or nets of inductors, fuses, transistors, regulators, shunts and paralleled connector pins. Ground counts only when a class, current or width flags it as a current return.",
        "Relief spokes are widened so their total cross-section carries the net current (Net currents or Class currents, IPC-2221/2152 approximation with the stackup copper thickness and the temperature rise above), clamped to the pad width."
      ])list.append(el("li",line));
      box.append(list);return box;
    }
    // Net currents (A) used by Auto spoke sizing. Class currents are set under Net Classes.
    function currentsEditor(){
      const fs=el("fieldset",null,"rules-scope rules-currents"),list=el("div",null,"rules-form");
      fs.append(el("legend","Net currents"),el("small","Amperes each net carries. Auto widens relief spokes to carry it and treats 0.5 A or more as a power net.","rules-note"));
      const currents=working.netCurrents||(working.netCurrents={});
      function paint(){
        list.replaceChildren();
        for(const net of Object.keys(currents).sort(cmp)){
          const amps=el("input");amps.type="number";amps.min="0.001";amps.step="any";amps.dataset.numericUnit="A";amps.value=String(currents[net]);amps.setAttribute("aria-label","Current of "+net+" in amperes");
          amps.onchange=()=>{const v=Number(amps.value);if(!(v>0)||v>10000){amps.value=String(currents[net]);return report(Error("Enter a current between 0 and 10000 A."));}currents[net]=v;feedback.textContent="";};
          const remove=button("Remove",()=>{delete currents[net];paint();});remove.setAttribute("aria-label","Remove current of "+net);
          const row=el("span",null,"rules-length");row.append(amps,el("span","A","rules-unit"),remove);list.append(field(net,row));
        }
        const pick=el("select"),amps=el("input");pick.setAttribute("aria-label","Net");amps.type="number";amps.min="0.001";amps.step="any";amps.dataset.numericUnit="A";amps.placeholder="A";amps.setAttribute("aria-label","Current in amperes");
        for(const n of netList().filter(n=>!own(currents,n)))pick.add(new Option(n,n));
        const add=button("Add",()=>{const v=Number(amps.value);if(!pick.value)return report(Error("This board has no other named nets."));
          if(!(v>0)||v>10000)return report(Error("Enter a current between 0 and 10000 A."));setOwn(currents,pick.value,v);feedback.textContent="";paint();});
        const row=el("span",null,"rules-length");row.append(pick,amps,add);list.append(field("Add net",row));
      }
      paint();fs.append(list);return fs;
    }
    function layerTable(r,f){
      const wrap=el("div",null,"rules-table-wrap"),table=el("table",null,"rules-table rules-layer-table"),hr=el("tr"),tbody=el("tbody");
      const keys=f.keys,labels=keys.map(k=>TYPES[r.type].fields.find(x=>x.key===layerValueKey(r.type,k)));
      for(const h of ["Layer",...labels.map(x=>x.label)])hr.append(el("th",h));
      const thead=el("thead");thead.append(hr);table.append(thead,tbody);
      for(const layer of [...new Set([...copperLayers,...Object.keys(r.layers)])]){
        const tr=el("tr"),name=el("td",layerLabel(layer));tr.append(name);
        let row=r.layers[layer]?{...r.layers[layer]}:{};
        // Edits go to a row object that is attached only while it has values.
        const target=write=>{
          if(write===true)return row;
          if(write===false){if(Object.keys(row).length)setOwn(r.layers,layer,row);else delete r.layers[layer];}
          return row;
        };
        labels.forEach((x,i)=>{const td=el("td");td.append(lengthInput(r,{...x,optional:true},target,keys[i],layerLabel(layer)+" "+x.label,r[layerValueKey(r.type,keys[i])],["layers",layer,keys[i]]));tr.append(td);});
        tbody.append(tr);
      }
      wrap.append(table);
      const box=el("div",null,"rules-layer-box");box.append(el("span",f.label,"rules-field-label"),el("small","Leave a cell empty to use the rule value shown in grey.","rules-note"),wrap);
      return box;
    }

    function usesPickerName(scope,kind,name){
      const simple=globalThis.AtriumDesignQueryRecord.toSelector(scope);
      return simple?.kind===kind&&simple.value===name;
    }
    function renamePickerScope(kind,from,to){
      for(const rule of working.list)for(const key of ["scope","scope2"])
        if(usesPickerName(rule[key],kind,from))rule[key]=globalThis.AtriumDesignQueryRecord.selector(kind,to);
    }
    // Net classes and differential pair classes share one editor.
    function classesView(what){
      const key=what==="net"?"netClasses":"diffPairClasses",scopeKind=what==="net"?"netclass":"diffpairclass";
      const classes=working[key]||(working[key]={}),names=Object.keys(classes);
      const members=what==="net"?netList():(working.diffPairs||[]).map(p=>p.name);
      let chosen=classChoice[what];if(!own(classes,chosen||""))chosen=classChoice[what]=names[0]||null;
      pane.append(el("h3",what==="net"?"Net Classes":"Differential Pair Classes"),
        el("p",what==="net"?"Named groups of nets. Rules use them with the Net class scope (InNetClass).":"Named groups of differential pairs. Rules use them with the Differential pair class scope.","rules-help"));
      const tools=el("div",null,"rules-toolbar");
      tools.append(button("New class",()=>{
        const name=uniqueName(what==="net"?"NetClass":"PairClass",names);setOwn(classes,name,[]);classChoice[what]=name;paintTree();paintPane();
      }));
      if(chosen)tools.append(button("Delete class",()=>{
        const users=working.list.filter(r=>[r.scope,r.scope2].some(s=>usesPickerName(s,scopeKind,chosen)));
        if(users.length)return report(Error("Rules use "+chosen+": "+users.map(r=>r.name).join(", ")+". Change their scope first."));
        delete classes[chosen];if(what==="net"&&working.classCurrents)delete working.classCurrents[chosen];classChoice[what]=null;paintTree();paintPane();
      }));
      pane.append(tools);
      if(!chosen){pane.append(el("p","No classes yet.","rules-help"));return;}
      const split=el("div",null,"rules-split"),list=el("div",null,"ui-list rules-list"),editor=el("div",null,"rules-class");
      list.setAttribute("role","listbox");list.setAttribute("aria-label","Classes");
      for(const name of names){
        // A library list row: the class and its member count as the meta.
        const b=el("button",null,"ui-row rules-list-item"),text=el("span",null,"ui-row-text");b.type="button";b.onclick=()=>{classChoice[what]=name;paintPane();};
        text.append(el("span",name,"ui-row-title"));b.append(text,el("span",String(classes[name].length),"ui-row-meta"));
        b.setAttribute("role","option");b.setAttribute("aria-selected",String(name===chosen));list.append(b);
      }
      const rename=el("input");rename.value=chosen;rename.maxLength=128;rename.setAttribute("aria-label","Class name");
      rename.onchange=()=>{
        const v=rename.value.trim();
        if(!v||v!==chosen&&own(classes,v)){rename.value=chosen;return report(Error(v?"A class named "+v+" already exists.":"A class needs a name."));}
        const renamed={};for(const [k,m] of Object.entries(classes))setOwn(renamed,k===chosen?v:k,m);working[key]=renamed;
        if(what==="net"&&working.classCurrents&&own(working.classCurrents,chosen)){setOwn(working.classCurrents,v,working.classCurrents[chosen]);delete working.classCurrents[chosen];}
        renamePickerScope(scopeKind,chosen,v);
        classChoice[what]=v;feedback.textContent="";paintTree();paintPane();
      };
      const search=el("input"),count=el("p",null,"rules-help"),checks=el("div",null,"rules-checks rules-members");
      search.type="search";search.placeholder=what==="net"?"Find nets":"Find pairs";search.setAttribute("aria-label",search.placeholder);
      function paintMembers(){
        const set=new Set(classes[chosen]),q=search.value.trim().toLowerCase(),shown=members.filter(n=>n.toLowerCase().includes(q));
        count.textContent=set.size+" of "+members.length+(what==="net"?" nets":" pairs")+" in "+chosen+(shown.length>500?". Showing 500 matches.":"");
        checks.replaceChildren();
        for(const name of shown.slice(0,500)){
          const c=el("input"),l=el("label",null,"rules-check");c.type="checkbox";c.checked=set.has(name);
          c.onchange=()=>{const m=classes[chosen];if(c.checked){if(!m.includes(name))m.push(name);}else m.splice(m.indexOf(name),1);
            count.textContent=m.length+" of "+members.length+(what==="net"?" nets":" pairs")+" in "+chosen;list.querySelector('[aria-selected="true"]').textContent=chosen+" ("+m.length+")";};
          l.append(c,el("span",name));checks.append(l);
        }
        if(!members.length)checks.append(el("p",what==="net"?"This board has no named nets.":"Define differential pairs first.","rules-help"));
      }
      search.oninput=paintMembers;editor.append(field("Class name",rename));
      if(what==="net"){
        const amps=el("input"),cc=working.classCurrents||(working.classCurrents={});amps.type="number";amps.min="0.001";amps.step="any";amps.dataset.numericUnit="A";amps.placeholder="Not set";
        amps.value=own(cc,chosen)?String(cc[chosen]):"";amps.setAttribute("aria-label","Current of "+chosen+" in amperes");
        amps.onchange=()=>{const t=amps.value.trim(),v=Number(t);if(!t){delete cc[chosen];return;}
          if(!(v>0)||v>10000){amps.value=own(cc,chosen)?String(cc[chosen]):"";return report(Error("Enter a current between 0 and 10000 A."));}setOwn(cc,chosen,v);feedback.textContent="";};
        const row=el("span",null,"rules-length");row.append(amps,el("span","A","rules-unit"));
        editor.append(field("Current per net",row,"Used by Polygon Connect Style Auto. A class named Power marks power nets."));
      }
      editor.append(AtriumUI.searchField(search,{cls:"rules-find",type:true}),count,checks);paintMembers();
      split.append(list,editor);pane.append(split);
    }
    function pairsView(){
      const pairs=working.diffPairs||(working.diffPairs=[]);
      pane.append(el("h3","Differential Pairs"),el("p","Each pair joins a positive and a negative net. Rules scope them with Differential pair or Differential pair class.","rules-help"));
      const tools=el("div",null,"rules-toolbar");
      tools.append(button("Create from nets…",()=>{candidates=detectDiffPairs(netList(),pairs);paintPane();
        if(!candidates.length)status.textContent="No unpaired nets end in _P/_N, _DP/_DN, +/- or P/N.";}));
      pane.append(tools);
      if(candidates?.length){
        const box=el("fieldset",null,"rules-candidates"),checks=[];box.append(el("legend","Candidate pairs from net names"));
        for(const c of candidates){const cb=el("input"),l=el("label",null,"rules-check");cb.type="checkbox";cb.checked=true;checks.push([cb,c]);
          l.append(cb,el("span",c.name+": "+c.positive+" / "+c.negative));box.append(l);}
        const row=el("div",null,"rules-toolbar");
        row.append(button("Create selected pairs",()=>{
          const chosen=checks.filter(([cb])=>cb.checked).map(([,c])=>c);pairs.push(...chosen);candidates=null;
          status.textContent=chosen.length+" differential pair"+(chosen.length===1?"":"s")+" created.";paintTree();paintPane();
        }),button("Cancel",()=>{candidates=null;paintPane();}));
        box.append(row);pane.append(box);
      }
      const wrap=el("div",null,"rules-table-wrap"),table=el("table",null,"rules-table"),thead=el("thead"),hr=el("tr"),tbody=el("tbody");
      for(const h of ["Name","Positive net","Negative net","Classes",""])hr.append(el("th",h));thead.append(hr);table.append(thead,tbody);
      const classOf=name=>Object.entries(working.diffPairClasses||{}).filter(([,m])=>m.includes(name)).map(([k])=>k).join(", ");
      for(const p of pairs){
        const tr=el("tr"),name=el("input");name.value=p.name;name.maxLength=128;name.setAttribute("aria-label","Name of pair "+p.name);
        name.onchange=()=>{
          const v=name.value.trim();
          if(!v||v!==p.name&&pairs.some(x=>x.name===v)){name.value=p.name;return report(Error(v?"A pair named "+v+" already exists.":"A pair needs a name."));}
          for(const m of Object.values(working.diffPairClasses||{})){const i=m.indexOf(p.name);if(i>=0)m[i]=v;}
          renamePickerScope("diffpair",p.name,v);
          p.name=v;feedback.textContent="";
        };
        const td=n=>{const c=el("td");c.append(n);tr.append(c);};
        td(name);td(p.positive);td(p.negative);td(classOf(p.name));
        const remove=button("Delete",()=>{
          const users=working.list.filter(r=>[r.scope,r.scope2].some(s=>usesPickerName(s,"diffpair",p.name)));
          if(users.length)return report(Error("Rules use "+p.name+": "+users.map(r=>r.name).join(", ")+". Change their scope first."));
          pairs.splice(pairs.indexOf(p),1);for(const m of Object.values(working.diffPairClasses||{})){const i=m.indexOf(p.name);if(i>=0)m.splice(i,1);}
          paintTree();paintPane();
        });remove.setAttribute("aria-label","Delete pair "+p.name);td(remove);tbody.append(tr);
      }
      wrap.append(table);pane.append(pairs.length?wrap:el("p","No differential pairs yet.","rules-help"));
      const add=el("fieldset",null,"rules-scope"),pname=el("input"),pos=el("select"),neg=el("select");
      add.append(el("legend","Add a pair"));pname.setAttribute("aria-label","New pair name");pos.setAttribute("aria-label","Positive net");neg.setAttribute("aria-label","Negative net");
      const free=netList().filter(n=>!pairs.some(p=>p.positive===n||p.negative===n));
      for(const s of [pos,neg])for(const n of free)s.add(new Option(n,n));if(free.length>1)neg.value=free[1];
      const row=el("div",null,"rules-form");
      row.append(field("Name",pname),field("Positive net",pos),field("Negative net",neg));
      add.append(row,button("Add pair",()=>{
        const name=pname.value.trim();
        if(!name)return report(Error("Name the pair."));if(pairs.some(p=>p.name===name))return report(Error("A pair named "+name+" already exists."));
        if(!pos.value||pos.value===neg.value)return report(Error("Choose two different nets."));
        pairs.push({name,positive:pos.value,negative:neg.value});feedback.textContent="";paintTree();paintPane();
      }));
      pane.append(add);
    }

    // Altium source rules: browse, copy a minimum, or convert whole records.
    function useCandidate(c){
      const records=globalThis.AtriumDesignQueryRecord, [type,key]=legacyCandidate[c.key];
      const scope=records.selector(c.net?"net":"all",c.net);
      let r=rulesOf(type).find(x=>{const s=records.toSelector(x.scope);return (c.net?s?.kind==="net"&&s.value===c.net:s?.kind==="all")&&(!x.scope2||records.isAll(x.scope2));});
      if(!r){r=make(type,uniqueName(TYPES[type].altium+(c.net?"_"+c.net:"")),{scope});place(r,c.net?1:rulesOf(type).length+1);}
      r[key]=c.value;
      for(const group of TYPES[type].ranges||[])if(group.includes(key)){const i=group.indexOf(key);
        group.forEach((k,j)=>{if(r[k]!=null&&(j<i&&r[k]>c.value+EPS||j>i&&r[k]<c.value-EPS))r[k]=null;});}
      return r;
    }
    function sourcesView(){
      pane.append(el("h3","Altium Source Rules"));
      if(!sources.length){pane.append(el("p","Import an Altium .RUL file with Import rules, or open an Altium PCB, to browse its rules here.","rules-help"));return;}
      pane.append(el("p","Use copies a supported minimum into the matching Waffle rule. Add as rule converts the whole record with its scope. Apply to keep the changes and the source records.","rules-help"));
      const tools=el("div",null,"rules-toolbar");
      tools.append(button("Replace with supported rules",()=>{
        const originalSet=sources===openedSources&&JSON.stringify(normalize(working))===baseline&&JSON.stringify([...extras])===extrasBase;
        const r=replaceWithSource(working,sources,sourceView());
        for(const [id,record] of r.origins)extras.set(id,{boards:[doc.id],origin:{kind:"import",tool:"Altium",board:doc.id,record}});
        sourceAdoption=originalSet&&r.converted?{rules:JSON.stringify(normalize(working)),extras:JSON.stringify([...extras])}:null;
        status.textContent=r.converted+" of "+r.total+" source rules converted. "+r.types+" rule types replaced.";paintTree();paintPane();
      }),button("Export source .RUL",safe(async()=>{await ctx.exportFile((doc.name||"Board").replace(/[\\/:*?"<>|]/g,"-")+".RUL",D.write(sources));})));
      const conversions=sourceConversions(sources,sourceView()),search=el("input"),list=el("div",null,"work-list rules-sources");
      search.type="search";search.placeholder="Find by name, kind or scope";search.setAttribute("aria-label","Find Altium rules");search.value=sourceQuery;
      search.oninput=()=>{sourceQuery=search.value;paintSources();};
      pane.append(tools,AtriumUI.searchField(search,{cls:"rules-find",type:true}),list);
      function paintSources(){
        list.replaceChildren();const needle=sourceQuery.trim().toLowerCase();
        const rows=sources.map((line,i)=>({line,i,r:D.describe(line)})).filter(({r})=>[r.name,r.kind,r.first,r.second].join(" ").toLowerCase().includes(needle));
        for(const {i,r} of rows.slice(0,100)){
          const card=el("details",null,"source-rule"),scopeText=r.first+(r.second&&r.second!=="All"?" ↔ "+r.second:"");
          card.append(el("summary",r.name+(r.enabled?"":" · Disabled")),el("p",r.kind+" · "+(scopeText||"Unspecified scope")+(r.priority?" · Priority "+r.priority:"")));
          const actions=el("div",null,"rules-toolbar"),converted=conversions[i];
          if(r.candidate&&converted.rule&&!converted.warning){const c=r.candidate;
            actions.append(button("Use "+formatLength(c.value,unit)+" for "+c.label.toLowerCase(),safe(()=>{
              const rule=useCandidate(c);paintTree();
              status.textContent=c.label+" set for "+(c.net||doc.name)+" in "+rule.name+". Apply to save this minimum.";
            })));}
          if(converted.rule){
            const records=rulesOf(converted.rule.type).map(rule=>extras.get(rule.id)?.origin).map(origin=>origin?.board===doc.id?origin.record:null);
            if(!records.includes(i+1))actions.append(button("Add as rule",()=>{
              const rule={...converted.rule,id:newId(),name:uniqueName(converted.rule.name)};
              let position=1;
              for(const [j,record] of records.entries()){
                const prior=record&&conversions[record-1];if(!prior)continue;
                if(prior.priority>converted.priority||prior.priority===converted.priority&&prior.index>i){position=j+1;break;}
                position=j+2;
              }
              extras.set(rule.id,{boards:[doc.id],origin:{kind:"import",tool:"Altium",board:doc.id,record:i+1}});place(rule,position);
              status.textContent=rule.name+" added at priority "+rule.priority+".";paintTree();paintSources();
            }));
          }else card.append(el("small","Not converted: "+converted.reason,"rules-note"));
          if(converted.warning)card.append(el("small",converted.warning,"rules-note"));
          if(actions.childElementCount)card.append(actions);
          const raw=el("details"),pairsList=el("dl",null,"rule-properties");raw.append(el("summary","Source fields"),pairsList);
          raw.ontoggle=()=>{if(!raw.open||pairsList.childElementCount)return;for(const [key,value] of Object.entries(r.fields))pairsList.append(el("dt",key),el("dd",value||"—"));};
          card.append(raw);list.append(card);
        }
        if(rows.length>100)list.append(el("p","Showing 100 of "+rows.length+" matches. Refine the search to see more.","rules-help"));
        if(!rows.length)list.append(el("p","No matching rules.","rules-help"));
      }
      paintSources();
    }

    // Replacing a .RUL file can reorder records or remove them. Index only
    // unambiguous originals, so a previous native edit never attaches to an unrelated rule.
    function sourcePositions(next){
      const positions=new Map();
      next.forEach((line,i)=>positions.set(line,positions.has(line)?null:i+1));
      return positions;
    }
    async function store(){
      const ui=globalThis.AtriumNumericFields;
      if(ui?.pending(d) && !await ui.flush(d))return false;
      // Accepting the source rules re-signs the stored copper under them: their scopes need the compiler.
      if(sourceAdoption&&!globalThis.AtriumDesignQuery&&globalThis.AtriumLazy?.need)await AtriumLazy.need("AtriumDesignQuery");
      const invalidScope=d.querySelector(".rules-query-input:not([hidden]):invalid");
      if(invalidScope){invalidScope.focus();throw Error(invalidScope.validationMessage);}
      const data=normalize(working);validate(data);
      const json=JSON.stringify(data),extrasNow=JSON.stringify([...extras]),ercNow=JSON.stringify(ercWork);
      const limitsChanged=json!==baseline||extrasNow!==extrasBase||ercNow!==ercBase,sourcesChanged=sources!==openedSources;
      if((editorProject&&editorProject()!==project)||(sourceView().sourceRules||emptySources)!==openedSources)
        throw Error("The board or its original rules have changed. Reopen the Rules editor to use the current source.");
      if(sourcesChanged&&doc.sourceRules===undefined&&!globalThis.AtriumImportReports?.setSourceRules)
        throw Error("The import report is unavailable. Reopen the Rules editor to import this rule file.");
      const calculationChanged=JSON.stringify([calcRules,calcDefaults])!==JSON.stringify([calcBase,calcDefaultsBase]);
      if(limitsChanged||sourcesChanged||calculationChanged||fieldDrafts.size)ctx.edit(()=>{
        let adopted;
        if(sourcesChanged){
          const positions=sourcePositions(sources);
          adopted=new Set((doc.appliedSourceRuleRecords||[]).map(n=>positions.get(openedSources[n-1])).filter(Boolean));
        }
        if(limitsChanged || fieldDrafts.size){
          // The project rule book: this board's rules and the schematic rules.
          const commit=()=>P.edit(project,b=>{P.setBoard(b,project,doc,JSON.parse(json),extras);P.setErc(b,[...ercWork,...b.list.filter(r=>r.type===P.CALCULATION)]);});
          if(!sourcesChanged&&sourceAdoption?.rules===json&&sourceAdoption.extras===extrasNow)adoptSourcePours(doc,project,ctx.defs,()=>{
            commit();const selection=sourceCheckSelection(sourceView());if(selection)doc.ruleCheckSelection=selection;
          });
          else commit();
        }
        for(const {target,entry} of fieldDrafts.values())globalThis.AtriumNumericFields.remember(project,target,entry);
        if(calculationChanged)P.edit(project,b=>P.setCalculationOptions(b,calcRules,calcBase,calcDefaults,calcDefaultsBase));
        if(adopted){
          if(sources.length!==openedSources.length||sources.some((line,i)=>line!==openedSources[i]))doc.sourceRulesReplaced=true;
          if(doc.sourceRules!==undefined)doc.sourceRules=sources.slice();
          else globalThis.AtriumImportReports.setSourceRules(doc,sources,pickedRuleFile);
          pickedRuleFile=undefined;
          openedSources=sources=sourceView().sourceRules||emptySources;
          for(const r of project.rules?.list||[]){
            const o=r.origin;
            if(o?.kind==="import"&&o.tool==="Altium"&&o.board===doc.id&&Number.isInteger(o.record)&&o.record>=1&&o.record<=sources.length)adopted.add(o.record);
          }
          if(adopted.size)doc.appliedSourceRuleRecords=[...adopted].sort((a,b)=>a-b);
          else delete doc.appliedSourceRuleRecords;
        }
      });
      if(fieldDrafts.size){fieldDrafts.clear();globalThis.AtriumNumericFields.attachHost(globalThis.AtriumNavHost);}
      calcBase=copyRules(calcRules);calcDefaultsBase={...calcDefaults};
      baseline=json;extrasBase=extrasNow;ercBase=ercNow;sourceAdoption=null;return true;
    }
    // ---- project rule fields: severity, and (with several boards) the boards a rule applies to
    function v3Fields(r){
      if(!P)return [];
      const x=extras.get(r.id)||{},out=[],sev=el("select");sev.setAttribute("aria-label","Severity");
      for(const [v,label] of [["","Error (default)"],["fatal","Fatal"],["error","Error"],["warning","Warning"],["hint","Hint"],["off","Off"]])sev.add(new Option(label,v));
      sev.value=x.severity||"";sev.onchange=()=>{const y={...(extras.get(r.id)||{})};if(sev.value)y.severity=sev.value;else delete y.severity;extras.set(r.id,y);};
      out.push(field("Severity",sev,"Off turns the rule off; Warning and Hint report without failing the check."));
      if(allBoards.length>1){
        const box=el("div",null,"rules-boards"),now=allBoards.filter(b=>P.appliesToBoard(x,b.id)).map(b=>b.id);
        for(const b of allBoards){const l=el("label"),c=el("input");c.type="checkbox";c.checked=now.includes(b.id);c.disabled=b===doc;
          c.onchange=()=>{const y={...(extras.get(r.id)||{})},set=new Set(allBoards.filter(b=>P.appliesToBoard(y,b.id)).map(b=>b.id));y.exceptBoards=null;if(c.checked)set.add(b.id);else set.delete(b.id);set.add(doc.id);
            y.boards=allBoards.map(q=>q.id).filter(id=>set.has(id));if(y.boards.length===allBoards.length)delete y.boards;extras.set(r.id,y);};
          l.append(c," "+b.name);box.append(l);}
        out.push(field("Boards",box,"The boards this rule applies to."));
      }
      return out;
    }
    // ---- Rules for This…: the rules that apply to the object, the winner of each type first
    function forView(){
      pane.append(el("h3","Rules for This…"),el("p","The rules that apply to "+subjectText()+", by rule type in priority order. The first of each type applies; the others are shadowed.","rules-help"));
      const R2=compile(working,{doc,project,explicit:true}),o={net:subject.net||"",component:subject.component,layer:subject.layer,span:subject.layer?sideSpan(subject.layer):undefined,pair:R2.pairOfNet.get(subject.net)?.name};
      const table=el("table",null,"rules-table"),hr=el("tr"),tbody=el("tbody"),thead=el("thead");
      for(const h of ["Type","Rule","Scope","Status"])hr.append(el("th",h));thead.append(hr);table.append(thead,tbody);
      let n=0;
      for(const type of ORDER){
        const hits=R2.byType[type].filter(r=>r.m1(o)||(r.m2&&r.m2(o)));
        hits.forEach((r,i)=>{n++;const tr=el("tr",null,i?"is-muted":"");tr.append(el("td",TYPES[type].title));const td=el("td");td.append(button(r.name,()=>select({kind:"rule",id:r.id}),"rules-link"));tr.append(td,el("td",scopeQuery(r.scope)+(r.scope2?" , "+scopeQuery(r.scope2):"")),el("td",i?"Shadowed by "+hits[0].name:"Applies"));tbody.append(tr);});
      }
      const wrap=el("div",null,"rules-table-wrap");wrap.append(table);pane.append(n?wrap:el("p","No rule applies to this object.","rules-help"));
    }
    const subjectText=()=>[subject.component&&"component "+subject.component,subject.net&&"net "+subject.net,subject.layer&&"layer "+subject.layer].filter(Boolean).join(", ")||"the selection";
    // ---- Signals and Tags: the signal model's view (signals.js); edits in the Signals panel
    function signalsView(){
      pane.append(el("h3","Signals and Tags"),el("p","Net classes, differential pairs, their classes and xSignals are signals and tags. Rules scope to them with Signal and Tag (InSignal, HasTag); Net class, Differential pair and xSignal scopes read the same model. Edit them in the Signals panel.","rules-help"));
      pane.append(button("Open the Signals panel",()=>act("signals-panel")));
      const S=globalThis.AtriumSignals;if(!S)return;
      let M=null;try{M=S.model(project,doc);}catch(e){pane.append(el("p",e.message,"rules-help"));return;}
      const table=el("table",null,"rules-table"),hr=el("tr"),tbody=el("tbody"),thead=el("thead");
      for(const h of ["Signal","Kind","Tags","Nets"])hr.append(el("th",h));thead.append(hr);table.append(thead,tbody);
      for(const s of M.signals.slice(0,500)){const tr=el("tr");for(const v of [s.name,s.kind,s.tags.join(", "),[...M.netsOfSignal(s.name)].join(", ")])tr.append(el("td",v));tbody.append(tr);}
      const L=M.legacy(),tags=el("table",null,"rules-table"),th=el("tr"),tb=el("tbody"),tt=el("thead");
      for(const h of ["Net class (tag)","Nets"])th.append(el("th",h));tt.append(th);tags.append(tt,tb);
      for(const [c,nets] of Object.entries(L.netClasses)){const tr=el("tr");tr.append(el("td",c),el("td",nets.join(", ")));tb.append(tr);}
      const w1=el("div",null,"rules-table-wrap"),w2=el("div",null,"rules-table-wrap");w1.append(table);w2.append(tags);
      pane.append(el("h4","Signals"),M.signals.length?w1:el("p","No signals declared.","rules-help"),el("h4","Tags as net classes"),Object.keys(L.netClasses).length?w2:el("p","No tags.","rules-help"));
    }
    // ---- Schematic: ERC checks as rules (severity per check), the connection matrix and net scope
    function schematicView(){
      pane.append(el("h3","Schematic"),el("p","Electrical rule checks as rules. Each check's severity applies to the whole schematic; a check can also be scoped (for example off for InComponentClass('TestPoints')). Off turns the check off.","rules-help"));
      const levels=E.fromStored(P.erc(project,{format:"atrium-rules",version:3,units:"mm",list:ercWork})).checks;
      const table=el("table",null,"rules-table"),hr=el("tr"),tbody=el("tbody"),thead=el("thead");
      for(const h of ["Group","Check","Severity","Scoped rules"])hr.append(el("th",h));thead.append(hr);table.append(thead,tbody);
      for(const c of E.CHECKS.filter(c=>!c.authored)){
        const type=P.ercType(c.id),sev=el("select");sev.setAttribute("aria-label",c.name+" severity");
        for(const [v,label] of [["off","Off"],["warning","Warning"],["error","Error"],["fatal","Fatal"]])sev.add(new Option(label,v));
        sev.value=P.LEVEL_SEVERITY[levels[c.id]]||"warning";
        const records=globalThis.AtriumDesignQueryRecord;
        sev.onchange=()=>{ercWork=ercWork.filter(r=>!(r.type===type&&records.isAll(r.scope)));if(sev.value!==P.LEVEL_SEVERITY[c.level])ercWork.push({id:"erc-"+c.id,type,name:type.slice(3),enabled:true,priority:1,scope:records.selector("all"),severity:sev.value,where:"schematic"});paintTree();};
        const scoped=ercWork.filter(r=>r.type===type&&r.scope&&!records.isAll(r.scope)).map(r=>scopeQuery(r.scope)+" → "+(r.severity||"error")).join("; ");
        const tr=el("tr"),td=el("td");td.append(sev);tr.append(el("td",c.group),el("td",c.name),td,el("td",scoped||"—"));tbody.append(tr);
      }
      const wrap=el("div",null,"rules-table-wrap");wrap.append(table);
      pane.append(wrap,button("Connection Matrix and Options…",()=>E.options(ctx),"rules-view-link"));
    }
    function calculationView(){
      const C=globalThis.AtriumCalculationChecks,L=globalThis.AtriumLazy;
      if(!C){
        if(!calcLoading&&L?.modules?.().includes("AtriumCalculationChecks"))calcLoading=L.need("AtriumCalculationChecks").then(()=>{
          if(sel.kind==="calculations"||sel.kind==="calculation-sheet")paintPane();
        },report).finally(()=>{calcLoading=null;});
        return;
      }
      const documentId=sel.kind==="calculation-sheet"?sel.id:null;
      if(!documentId)pane.append(el("h2",C.t("calculations.rules.title")));
      C.render(pane,{project,rules:calcRules,defaults:calcDefaults,documentId,showDefaults:!documentId,
        onEdit:safe(target=>C.focus(globalThis.AtriumNavHost,target))});
    }
    footer.append(button("Import rules",safe(async()=>{
      const f=await ctx.pickFile([".waffle-rules",".rul"]);if(!f)return;
      if(/\.rul$/i.test(f.name)){
        if(doc.sourceRules===undefined&&!globalThis.AtriumImportReports?.setSourceRules&&globalThis.AtriumLazy)
          await globalThis.AtriumLazy.need("AtriumImportReports");
        const bytes=new Uint8Array(await f.arrayBuffer()),imported=D.read(bytes),positions=sourcePositions(imported);
        if(doc.sourceRules===undefined){
          const sidecars=globalThis.AtriumImportSidecars || await globalThis.AtriumLazy?.need("AtriumImportSidecars");
          if(!sidecars)throw Error("The original rule file could not be verified.");
          pickedRuleFile={file:f,bytes,sha256:await sidecars.sha(bytes)};
        }
        const linked=P.originRecords({...doc,sourceRules:sources},working.list.map(r=>({...r,origin:extras.get(r.id)?.origin})));
        for(const [id,x] of extras){
          const o=x.origin;
          if(o?.kind!=="import"||o.tool!=="Altium"||o.board!==doc.id)continue;
          const n=positions.get(sources[(o.record||linked.get(id))-1]);
          if(n)x.origin={...o,record:n};else x.origin=null;
        }
        sources=imported;sourceQuery="";select({kind:"sources"});
        status.textContent=imported.length+" source rules loaded. Use a minimum or add rules, then Apply to keep the source rules for this board.";return;
      }
      const content=f.text?await f.text():new TextDecoder().decode(await f.arrayBuffer());
      const data=validate(JSON.parse(content));working=migrate(data);select({kind:"root"});
      status.textContent="Imported "+f.name+(data.version===1?" (version 1, converted to rule records)":"")+". Apply to store these rules in the project.";
    })),button("Export rules",safe(async()=>{
      const data=normalize(working);validate(data);
      await ctx.exportFile((project.name||"Board").replace(/[\\/:*?"<>|]/g,"-")+".waffle-rules",JSON.stringify(data,null,2));
    })),button("Apply & run DRC",safe(async()=>{
      if(doc.kind!=="pcb")throw Error("Open a PCB layout to run checks on that board.");
      if(!await store())return;d.close();
      if(globalThis.AtriumNavHost)await AtriumNavHost.act("drc");
      else if(globalThis.AtriumEditorWorkflows)await AtriumEditorWorkflows.checkDRC(ctx);
      else ctx.info("Open a board in the editor to run Design Rule Check.");
    })),button("Apply",safe(async()=>{if(!await store())return;status.textContent="Rules applied.";ctx.info("Rules updated");})));
    const ok=button("OK",safe(async()=>{if(!await store())return;ctx.info("Rules updated");d.close();}));
    ok.dataset.variant="primary";
    footer.append(ok,button("Close",()=>d.close()));
    // A document tab in the active pane (doc-views.js), as the user chose: Escape shows the canvas again, Close closes the tab.
    const tabbed=!!(V&&globalThis.document&&ctx.tab!==false);
    d.addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();if(tabbed)V.hide("rules");else d.close();}});
    d.append(head,body,feedback,status,footer);
    d.addEventListener("close",()=>{
      d.remove();
      if(openEditor!==d)return;
      openEditor=null;
      if(tabbed)V.close("rules");
    },{once:true});
    if(tabbed)V.open("rules",{title:"Rules and Constraints",icon:"book",mount:box=>box.append(d),onClose:()=>{if(d.open)d.close();}});else document.body.append(d);
    if(ctx.section==="sources"&&sources.length)sel={kind:"sources"};/* import-rules.js: Review… */
    globalThis.AtriumShell?.adoptDialog?.(d,{defaultAction:false});
    paintTree();paintPane();if(typeof d.show==="function")d.show();else d.setAttribute("open","");
    (tree.querySelector('[tabindex="0"]')||[...tree.children][0])?.focus();
    return d;
  }

  // The DRC feature kit (as AtriumConnectivity.kit): feature extraction, the broad phase, exact gaps and
  // rule resolution, for checks outside drc() (drc-pours.js, the certificate store) without source patches.
  const kit=Object.freeze({allScope,scopePlans,scopeDiagnostic,extract,copperSubject,padCore,scopeObjects,pairs,gap,pieceGap,feature,slotRing,compile,migrate,clearanceGap,clearanceMax,clearKey,copperIndex,layerSpan,closestSegments,containsConvex,EPS});
  return {kit,defaults,validate,setAside,check,open,rulesFor,scopeCopy,presetRuleKey,materializePresetRules,
    create,migrate,normalize,effective,drc,netLengths,staleTeardrops,fillPieces,
    query,resolver,sizeVia:A.preferredViaSize,netClasses,diffPairs,matchedGroups,detectDiffPairs,stored,store,neckLength,NECK_DEFAULT,
    compiled:compiledRules,reportInput,/* hs-xsignals */isXsScope:XS_SCOPE,topologyChecked:[...TOPO_CHECKED],
    expansion,expansionResolver,maskRuleResolver,fromAltium,sourceReport,replaceWithSource,adoptSourcePours,sourceCheckSelection,checkSelected,checkMode,OPT_IN,describe,constraintText,scopeQuery,layerLabel,scopeCoverage,
    clearanceKinds:CLEAR_KINDS.map(([k,label])=>({key:k,label})),clearanceKey:clearKey,clearanceGap,clearanceMax,clearanceRoute,
    types:TYPES,categories:CATEGORIES,scopeKinds:SCOPE_KINDS,checkedTypes:[...CHECKED],DEFAULT_RULE_SET,ruleSetOf,ruleActive,
    units:{parse:parseLength,format:formatLength,value:lengthValue,initial:initialUnit,remember:rememberUnit}};
})();
// The project rule book (project-rules.js) is the store a board's rules come from, and the signal model
// (signals.js) holds its classes and pairs; the browser loads them with this (lazy.js AtriumRules), CommonJS
// loaders (tests, tools) load them here.
// @ts-ignore: CommonJS only
if(typeof module!=="undefined"&&typeof require==="function")for(const [g,f] of [["AtriumDesignQueryRecord","./design-query-record.js"],["AtriumNetIntent","./net-intent.js"],["AtriumSignals","../core/signals.js"],["AtriumProjectRules","./project-rules.js"]])if(!globalThis[g])require(f);
