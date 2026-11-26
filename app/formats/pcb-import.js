"use strict";

// Altium PCB coordinates increase upward. Waffle uses screen-oriented millimetres.
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("../pcb/resolved-geometry-curves.js");
if (!globalThis.AtriumAltiumRecords) { if (typeof importScripts === "function" && !globalThis.AtriumEmbeddedTranslatorScripts) importScripts("../formats/altium-records.js"); else if (typeof require === "function") require("./altium-records.js"); }
globalThis.AtriumPCB = (() => {
  const A = Atrium;
  const unit = 0.00000254;
  // An integer Altium tick is exactly 127/50 nm. The integer product is exact for int32 input.
  const tickMM = ticks => ticks * 127 / 50000000;
  const decoder = new TextDecoder("windows-1252");
  const noOwner = 0xffff;
  const yes=s=>/^(true|1|t)$/i.test(s||"");
  const numbers = {1:"Top",32:"Bottom",33:"Silk",34:"Bottom silk",35:"Top paste",36:"Bottom paste",
    37:"Top mask",38:"Bottom mask",55:"Drill guide",56:"Keepout",73:"Drill drawing",74:"Multi"};
  function layer(n) {
    if (typeof n === "number" || /^\d+$/.test(n)) {
      n=Number(n);
      return numbers[n] || (n>1 && n<32 ? "Inner "+(n-1) : n>=57 && n<=72 ? "Mechanical "+(n-56) : "Layer "+n);
    }
    const s=String(n||"").trim().toUpperCase().replace(/[ _-]/g,"");
    return ({TOP:"Top",TOPLAYER:"Top",BOTTOM:"Bottom",BOTTOMLAYER:"Bottom",TOPOVERLAY:"Silk",
      BOTTOMOVERLAY:"Bottom silk",MULTILAYER:"Multi",KEEPOUT:"Keepout",KEEPOUTLAYER:"Keepout",
      TOPSOLDER:"Top mask",BOTTOMSOLDER:"Bottom mask",TOPPASTE:"Top paste",BOTTOMPASTE:"Bottom paste",DRILLDRAWING:"Drill drawing"})[s] ||
      (/^MID(?:LAYER)?([1-9]|[1-9]\d|1[01]\d|12[0-6])$/.test(s) ? "Inner "+/\d+/.exec(s)[0] : /^MECHANICAL([1-9]|1[0-6])$/.test(s) ? "Mechanical "+/\d+/.exec(s)[0] : n || "Unknown");
  }
  function copper(l) {return l==="Top" || l==="Bottom" || l==="Multi" || /^Inner \d+$/.test(l);}
  function mm(s) {
    if(s===undefined || s==="")return 0;
    const m=/^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(mil|mm|in|inch|um|µm)?\s*$/i.exec(String(s));
    if(!m)throw Error("Unrecognised PCB dimension "+String(s).slice(0,35));
    const units=(m[2] || "mil").toLowerCase(), value=Number(m[1]);
    if(units==="mil"){
      const ticks=Math.round(value*10000);
      if(Number.isSafeInteger(ticks*127) && ticks/10000===value)return tickMM(ticks);
    }
    const factor=({mm:1,um:.001,"µm":.001,in:25.4,inch:25.4,mil:.0254})[units];
    return value*factor;
  }
  // xSignals: Altium keeps them ("pin pairs") as indexed keys of the first Board6 record: PINPAIRCOUNT,
  // PINPAIRNAMEi, PINPAIRPINSi ("U1-3,C1-1,C1-2,J1-3"), PINPAIRPINUNIQUEIDSi, PINPAIRGUIDi, PINPAIRCOLORi.
  // Kept as RECORD=xSignal text records beside the classes (altium-rules.js classes() reads them).
  function pinPairLines(p) {
    const out=[],n=Math.min(Number(p?.PINPAIRCOUNT)||0,10000),clean=v=>String(v).replace(/[|\r\n]/g," ");
    for(let i=0;i<n;i++){
      const name=p["PINPAIRNAME"+i],pins=p["PINPAIRPINS"+i];if(!name||!pins)continue;
      out.push(["RECORD=xSignal","NAME="+clean(name),"PINS="+clean(pins),...[["GUID","PINPAIRGUID"],["PINUNIQUEIDS","PINPAIRPINUNIQUEIDS"],["COLOR","PINPAIRCOLOR"],["OVERRIDECOLORFORDRAW","PINPAIROVERRIDECOLORFORDRAW"]].filter(([,k])=>p[k+i]!=null).map(([o,k])=>o+"="+clean(p[k+i]))].join("|"));
    }
    return out;
  }
  // The board's class, pair and xSignal records (doc.sourceClasses): the signal model reads its classes, pairs
  // and xSignals from them (signals.js).
  function keepClasses(doc,lines,notes){
    const components=Object.keys(doc.componentClasses||{}).length,automatic=automaticClasses.get(doc)||0;
    if(components)notes.push("Kept "+components+" component class"+(components===1?"":"es")+"."+
      (automatic?" "+automatic+" of them "+(automatic===1?"follows":"follow")+" component placement in Altium; Waffle keeps their members from the import.":""));
    if(!lines.length)return;
    doc.sourceClasses=lines;
    const n={0:0,6:0,10:0,pair:0,xs:0};for(const l of lines){const p=props(l),r=(p.RECORD||"").toLowerCase();if(r==="differentialpair")n.pair++;else if(r==="xsignal")n.xs++;else if(/^(0|6|10)$/.test(p.KIND||"")&&!/^(true|t)$/i.test(p.SUPERCLASS||""))n[p.KIND]++;}
    const kept=[[n[0],"net class","net classes"],[n[6],"differential pair class","differential pair classes"],[n[10],"xSignal class","xSignal classes"],[n.pair,"differential pair","differential pairs"],[n.xs,"xSignal","xSignals"]].filter(([k])=>k).map(([k,one,many])=>k+" "+(k===1?one:many));
    if(kept.length)notes.push("Kept "+kept.join(", ")+" (signals and tags).");
    // Altium measures an xSignal as its routed copper, pad to pad; a series part's own body adds nothing.
    // Waffle adds the part's pad-to-pad span by default (length-tuning.js seriesModel "pads"), so an
    // imported board keeps Altium's measurement and its Matched Lengths results.
    if(n.xs&&!doc.lengthTuning)doc.lengthTuning={version:1,groups:[],targets:{},seriesModel:"none"};
  }
  // Altium class kinds (docs/design/altium-pairs-xsignals-format.md) and the built-in "superclasses"
  // (SUPERCLASS=TRUE): one per kind, it names every object of that kind and stores no members. Waffle's
  // rules and queries know three of them by name (rules.js, design-query-context.js).
  const CLASS_OBJECTS={0:"net",1:"component",2:"from-to",3:"pad",4:"layer",6:"differential pair",7:"polygon",10:"xSignal"};
  const BUILT_IN_CLASSES={0:"All Nets",1:"All Components",6:"All Differential Pairs"};
  const objectsOf=kind=>CLASS_OBJECTS[kind]||"kind "+kind+" object";
  function superclass(p,rules){
    const kind=String(p.KIND??"0"),name=String(p.NAME||""),what="Altium's built-in class of every "+objectsOf(kind)+".";
    if(BUILT_IN_CLASSES[kind]===name)return {status:"kept",reason:what+" Waffle's rules and queries read "+name+" the same way."};
    // A rule that names it is reported with that rule; the class itself is then a loss too.
    const quoted="'"+name.replace(/'/g,"''").toLowerCase()+"'";
    if(name&&(rules||[]).some(line=>String(line).toLowerCase().includes(quoted)))
      return {status:"dropped",reason:what+" Waffle has no class of this name, so a rule that names it matches nothing."};
    return {status:"notApplicable",reason:what+" It stores no members and no rule names it."};
  }
  // Component classes (KIND 1) become the board's stored component classes (component-classes.js
  // doc.componentClasses), which InComponentClass('Name') rule scopes match. Altium's automatic classes
  // (Top Side, Bottom Side, Inside Board and Outside Board Components) follow placement in Altium; Waffle
  // stores their members at import. A class Altium generated per schematic sheet is settled after
  // linking (settleComponentClasses).
  const naturalOrder=typeof Intl==="object"&&Intl.Collator?new Intl.Collator(undefined,{numeric:true}).compare:(a,b)=>String(a).localeCompare(String(b));
  const classMemberName=v=>typeof v==="string"&&!!v.trim()&&v===v.trim()&&v.length<=200&&!/[\u0000-\u001f']/.test(v);
  const sheetClassCandidates=new WeakMap(),automaticClasses=new WeakMap();
  function componentClass(doc,p,decide){
    const field=k=>p["%UTF8%"+k]??p[k],name=field("NAME"),members=[];
    for(let i=0;i<20000&&field("M"+i)!=null;i++){const m=String(field("M"+i));if(classMemberName(m)&&!members.includes(m))members.push(m);}
    const store=doc.componentClasses||{};
    const problem=!classMemberName(name)?"Waffle class names have 1 to 200 characters, without quotes or control characters.":
      Object.hasOwn(store,name)?"An earlier component class has the same name.":Object.keys(store).length>=2048?"A board holds at most 2048 component classes.":null;
    if(problem){decide(()=>({status:"dropped",reason:problem}));return;}
    const stored=members.sort(naturalOrder),automatic=truth(p.AUTOGENERATEDCLASS);
    (doc.componentClasses||=store)[name]=stored;
    if(automatic)automaticClasses.set(doc,(automaticClasses.get(doc)||0)+1);
    else{if(!sheetClassCandidates.has(doc))sheetClassCandidates.set(doc,new Set());sheetClassCandidates.get(doc).add(name);}
    decide(()=>automatic?{status:"approximated",reason:"Altium updates this class from component placement. Waffle stores its members at import and does not update them."}:
      doc.componentClasses?.[name]===stored?{status:"kept",reason:"Stored as a component class of the board."}:
      {status:"kept",reason:"Waffle generates this class, with the same members, from the schematic sheet of the same name."});
  }
  // One Classes6 or SignalClasses record (or ASCII Class line) of a board. kinds: the class kinds the signal
  // model reads from doc.sourceClasses (signals.js). Every record stays in doc.sourceClasses either way.
  function boardClass(doc,p,kinds,evidence,decide){
    const kind=String(p.KIND??"0");
    if(truth(p.SUPERCLASS)){const r=superclass(p,doc.sourceRules);evidence?.(r.status,r.reason);}
    else if(kinds.test(kind))evidence?.("kept");
    else if(kind==="1")componentClass(doc,p,decide);
    else evidence?.("dropped","Waffle has no "+objectsOf(kind)+" classes.");
  }
  // Altium's "Generate Component Classes" (project options) makes one component class per schematic sheet:
  // the same class component-classes.js generates from the linked schematic (list(), source "sheet"). After
  // linking, a stored copy with exactly those members is removed, so the generated class stays current.
  function settleComponentClasses(project){
    for(const board of project?.documents||[]){
      const names=sheetClassCandidates.get(board),store=board.componentClasses;
      sheetClassCandidates.delete(board);
      if(!names||!store)continue;
      const sheetOf=new Map(),bySheet=new Map();
      for(const d of project.documents)if(d.kind==="schematic")for(const p of d.items)
        if(p.kind==="part"&&typeof p.link==="string"&&!sheetOf.has(p.link))sheetOf.set(p.link,d.name);
      for(const p of board.items)if(p.kind==="part"&&typeof p.ref==="string"&&p.ref&&typeof p.link==="string"){
        const sheet=sheetOf.get(p.link.split("@")[0]);
        if(sheet){if(!bySheet.has(sheet))bySheet.set(sheet,new Set());bySheet.get(sheet).add(p.ref);}
      }
      for(const name of names){
        const members=store[name],generated=bySheet.get(name);
        if(members&&generated&&generated.size===members.length&&members.every(r=>generated.has(r)))delete store[name];
      }
      if(!Object.keys(store).length)delete board.componentClasses;
    }
  }
  function props(s) { return AtriumAltiumRecords.properties(s, true, true); }
  // PCB ASCII contains a DXPRule and (in Designer's own Save As) a Protel
  // compatibility Rule with the same index. That copy can be disabled or have
  // a wider scope. Prefer the modern record regardless of their physical order.
  function asciiRuleRecords(text, observe) {
    const records=[], modern=new Set();
    let byteForChar;
    function ruleBody(line) {
      return line.split("|").filter(s=>s&&!/^(?:RECORD|INDEXFORSAVE)=/i.test(s)).map(field=>{
        if (!/^%UTF8%[^=]+=/i.test(field)) return field;
        // io.js decodes the container as Windows-1252; this field alone is UTF-8.
        if (!byteForChar) {
          const table = decoder.decode(Uint8Array.from({length:256}, (_,i)=>i));
          byteForChar = new Map(Array.from(table,(ch,i)=>[ch,i]));
        }
        const at=field.indexOf("=")+1,value=field.slice(at);
        if (Array.from(value).some(ch=>!byteForChar.has(ch))) return field;
        try {return field.slice(0,at)+new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(value,ch=>byteForChar.get(ch)));}
        catch {return field;}
      }).join("|");
    }
    for(const [i,line] of text.split(/\r\n|\r|\n/).entries()){
      if(!/(?:^|\|)RECORD=(?:DXPRule|Rule)(?:\||$)/i.test(line))continue;
      const f=props(line);
      if(!f.RULEKIND){observe?.(i+1,"invalid");continue;}
      const index=/^\d+$/.test(f.INDEXFORSAVE||"")?f.INDEXFORSAVE:"";
      const key=JSON.stringify([f.RULEKIND.toLowerCase(),index||null,index?null:(f.NAME||"").toLowerCase()]);
      const dxp=/^dxprule$/i.test(f.RECORD);
      if(dxp)modern.add(key);
      records.push({key,dxp,line,lineNumber:i+1});
    }
    return records.filter(r=>{
      const selected=r.dxp||!modern.has(r.key);
      observe?.(r.lineNumber,selected?"selected":"mirror");
      return selected;
    }).map(r=>{
      const body=ruleBody(r.line);
      // Preserve the transport of an older rule whose scope fields are missing.
      // Without it a later writer could accidentally promote it to an unrestricted DXPRule.
      return !r.dxp&&!/(?:^|\|)SCOPE1(?:EXPRESSION|COUNT)=/i.test(body)?"RECORD=Rule|"+body:body;
    });
  }
  function view(b) {return new DataView(b.buffer,b.byteOffset,b.byteLength);}
  function block(bytes, cursor) {
    const found=AtriumAltiumRecords.frame(bytes,cursor.i,4,["Truncated PCB record header","Truncated PCB record payload"]);
    cursor.i=found.end;return found.payload;
  }
  function records(bytes) {
    if(!bytes)return [];
    const c={i:0}, result=[];
    while(c.i<bytes.length){
      const b=block(bytes,c);
      if(!b.length)continue;
      result.push(AtriumAltiumRecords.propertyRecord(b,true,true));
    }
    return result;
  }
  // DrillManager/Data stores a property row, followed by two counted lists of
  // Pads and Vias record indices. Either list can be populated for one symbol.
  function drillManager(bytes) {
    if(!bytes || bytes.length<12)return null;
    const v=view(bytes);let pos=0;
    function word(){if(pos+4>bytes.length)throw Error("Truncated drill manager");const n=v.getUint32(pos,true);pos+=4;return n;}
    if(word()!==0xffffffff)return null;
    const count=word(),tools=[],owners={pads:new Map(),vias:new Map()};
    if(!count || count>(bytes.length-12)/12)return null;
    for(let i=0;i<count;i++){
      const rowLength=word();if(!rowLength || rowLength>bytes.length-pos)return null;
      const row=props(decoder.decode(bytes.subarray(pos,pos+rowLength)));pos+=rowLength;
      if(!/^\d+$/.test(row.HOLEMARK) || !/^(Pad|Via)$/i.test(row.OBJECTID) ||
          row.LAYERPAIR!=="0" || row.DRILLTYPE!=="0" || !/^(0|2)$/.test(row.HOLETYPE) ||
          !/^(true|false)$/i.test(row.PLATED) || !row.TOOLSIZE || !row.TOOLLENGTH)return null;
      const size=mm(row.TOOLSIZE),length=mm(row.TOOLLENGTH),mark=Number(row.HOLEMARK),slotted=row.HOLETYPE==="2";
      if(!Number.isSafeInteger(mark) || !Number.isFinite(size) || size<=0 || !Number.isFinite(length) ||
          (slotted ? length<0 : length!==0))return null;
      const diameter=slotted&&length>0?Math.min(size,length):size;
      const slot=slotted&&length>0&&length!==size?Math.max(size,length):0;
      const tool={mark,diameter,slot,...(slotted&&length!==size?{slotted:true}:{}),plated:row.PLATED.toUpperCase()==="TRUE",hits:0};
      tools.push(tool);
      for(const map of [owners.pads,owners.vias]){
        const n=word();if(n>(bytes.length-pos)/4)return null;tool.hits+=n;
        for(let j=0;j<n;j++){const index=word();if(map.has(index))return null;map.set(index,i);}
      }
    }
    return pos+4===bytes.length && word()===0 ? {tools,owners} : null;
  }
  function gerberPlots(projectText) {
    const drill=[],profile=[]; let outputGroup=false;
    for(const line of projectText.split(/\r?\n|\r/)){
      if(line.startsWith("[")){outputGroup=/^\[OutputGroup\d+\]\s*$/i.test(line);continue;}
      if(!outputGroup || !/^Configuration\d+_Item\d+=/i.test(line) || !/[=|]Record=GerberView(?:\||$)/i.test(line))continue;
      const row=props(line.slice(line.indexOf("=")+1));
      if(row.RECORD?.toLowerCase()!=="gerberview")continue;
      const board=plotBoard(row.DOCUMENTPATH),size=Number(row.DRILLDRAWINGSYMBOLSIZE)*unit;
      // A PCB display size is independent of a Gerber output job.
      const checked=Object.keys(row).filter(k=>/^PLOTDRILLDRAWINGLAYERPAIR\d+_CHECKED$/.test(k));
      const pairEnabled=!/^false$/i.test(row.PLOTUSEDDRILLDRAWINGLAYERPAIRS||"") ||
        checked.some(k=>/^true$/i.test(row[k]) && /^(?:top layer)?$/i.test(row[k.replace("_CHECKED","_LOWLAYER")]||"") &&
          /^(?:bottom layer)?$/i.test(row[k.replace("_CHECKED","_HIGHLAYER")]||""));
      const graphics=pairEnabled && row.DRILLDRAWINGSYMBOL==="GraphicsSymbol" && !/^(true|1)$/i.test(row.MIRRORDRILLDRAWINGPLOTS||"") &&
        ![row["ADDTOALLPLOTS.SET"],row["ADDTOALLLAYERCLASSES.SET"]].some(v=>/~1(?:,|$)/.test(v||""));
      drill.push({board,size:graphics && Number.isFinite(size) && size>0 ? size : null});
      profile.push({board,options:profilePlot(row)});
    }
    return {drill,profile};
  }
  const drillPlots = text => gerberPlots(text).drill;
  const plotBoard = value => String(value || "").split(/[\\/]/).pop().toLowerCase();
  const plotDisabled = value => !value || /^(false|0)$/i.test(value);
  const plotLayerIDs = value => Array.from((value || "").matchAll(/(?:^|,)(\d+)~1(?=,|$)/g), m => Number(m[1]));
  const plotUnits = new Map([["Imperial","in"],["Metric","mm"]]);
  const plotOrigins = new Map([["Absolute","absolute"],["Relative","auto"]]);
  const plotFormats = {in:["2:4","2:5","2:6"],mm:["4:3","4:4","4:6"]};
  // V8 GerberView plot IDs. These two layers already have dedicated board
  // profile filenames in Waffle. A generated Board Profile has no stored pen.
  function profilePlot(row) {
    if (![row.PLOTBOARDPROFILE,row.CENTREPLOTS,row.PANELIZE].every(plotDisabled) ||
        [row["ADDTOALLPLOTS.SET"],row["ADDTOALLLAYERCLASSES.SET"]].some(v=>/~1(?:,|$)/.test(v||"")) ||
        (row.OUTPUTFORMAT && row.OUTPUTFORMAT!=="Different")) return null;
    const keepout=0x103000d,mech1=0x1020001;
    const selected=plotLayerIDs(row["PLOT.SET"]).filter(id=>id===keepout || (id>=mech1 && id<mech1+32));
    if(selected.length!==1 || ![keepout,mech1].includes(selected[0]) || plotLayerIDs(row["MIRROR.SET"]).includes(selected[0])) return null;
    const units=plotUnits.get(row.GERBERUNIT),origin=plotOrigins.get(row.ORIGINPOSITION);
    const format=plotFormats[units]?.find(f=>f.endsWith(":"+row.NUMBEROFDECIMALS));
    if(!origin || !format) return null;
    return {units,origin,format,layer:selected[0]===keepout?"Keepout":"Mechanical 1"};
  }
  function profileWidth(doc, layer, defs) {
    const S=globalThis.AtriumBoardShape;
    if(!S || !globalThis.AtriumBoardShapeSources || !(doc.outline?.length>=3)) return null;
    for(const item of doc.items){
      if(item.kind!=="part") continue;
      const fp=defs.get(item.def)?.footprint;
      if(fp?.shapes?.some(s=>s.layer===layer) || fp?.pads?.some(p=>p.layer===layer)) return null;
    }
    const artwork=doc.items.filter(i=>i.layer===layer),width=artwork[0]?.width;
    if(!Number.isFinite(width) || width<=0 || !artwork.every(i=>i.kind==="graphic" && !i.fill && !i.regionShape && !i.dimension && i.width===width && i.points?.length>=2)) return null;
    const shape=doc.boardShape?S.fresh(doc):S.fromPolygon(doc.outline);
    if(!shape) return null;
    const expected=[shape.contour,...shape.cutouts].flat().filter(g=>S.segLength(g)>1e-9);
    const actual=artwork.flatMap(i=>globalThis.AtriumBoardShapeSources.itemSegments(i).map(g=>g.seg));
    if(!expected.length || expected.length!==actual.length) return null;
    // Require a unique match for every segment, allowing four native coordinate
    // units for Board6 rounding. An arc also has to match its center and sweep.
    const tol=4*unit,cell=x=>Math.floor(x/tol),close=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<=tol;
    const identity=g=>({kind:g.kind,ends:S.ends(g),center:g.c,mid:g.kind==="arc"?S.pointAt(g.c,g.r,g.start+S.sweep(g)/2):null});
    const bins=new Map();
    for(const stroke of actual.map(identity)) for(const [x,y] of stroke.ends){
      const key=cell(x)+":"+cell(y);
      if(!bins.has(key)) bins.set(key,new Set());
      bins.get(key).add(stroke);
    }
    const used=new Set();
    for(const target of expected.map(identity)){
      const [a,b]=target.ends, i=cell(a[0]),j=cell(a[1]),matches=new Set();
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(const g of bins.get((i+dx)+":"+(j+dy)) || []){
        const [c,d]=g.ends;
        if(target.kind!==g.kind || !((close(a,c)&&close(b,d)) || (close(a,d)&&close(b,c)))) continue;
        if(target.mid && !(close(target.center,g.center) && close(target.mid,g.mid))) continue;
        matches.add(g);
        if(matches.size>1 || used.has(g)) return null;
      }
      if(!matches.size) return null;
      used.add(matches.values().next().value);
    }
    return width;
  }
  function addProfileJobs(project, manifest) {
    if(!manifest?.profilePlots?.some(row=>row.options)) return;
    const paths=manifest.paths.filter(path=>/\.pcbdoc$/i.test(path)).map(plotBoard);
    const boards=project.documents.filter(d=>d.kind==="pcb" && d.sourceName);
    const defs=new Map(project.library.map(d=>[d.id,d]));
    for(const doc of boards){
      const board=plotBoard(doc.sourceName);
      if(paths.filter(n=>n===board).length!==1 || boards.filter(d=>plotBoard(d.sourceName)===board).length!==1) continue;
      const jobs=manifest.profilePlots.filter(row=>row.board && row.board!=="[pcb document]"?row.board===board:paths.length===1);
      const match=jobs.length===1 ? jobs[0].options : null;
      if(!match || (match.origin==="auto" && !doc.origin)) continue;
      let width;
      try{ width=profileWidth(doc,match.layer,defs); }catch{ continue; }
      if(width==null || width>=1e21 || !(Number((width*(match.units==="in"?1/25.4:1)).toFixed(6))>0)) continue;
      const {layer,...plot}=match, keepout=layer==="Keepout";
      const name=boards.length===1?"Altium board profile":"Altium profile — "+doc.name.slice(0,62);
      const options={...plot,profileWidth:width,profileOnly:true,layers:{GM1:!keepout,GKO:keepout},drill:false,readme:false};
      project.outputJobs ||= [];
      if(project.outputJobs.length<100 && !project.outputJobs.some(j=>j.name===name)){
        project.outputJobs.push({name,version:2,board:doc.id,outputs:[{id:"altium-profile",kind:"gerber",label:"Board profile",options}]});
        (project.importNotes ||= []).push(doc.name+" — Saved an Altium board profile job from the selected "+(keepout?"Keep-Out":layer)+" layer.");
      }
    }
  }
  function shortString(b) {
    if(!b.length)return "";
    if(b[0]>b.length-1)throw Error("Truncated PCB string");
    return decoder.decode(b.subarray(1,b[0]+1)).replace(/\0+$/,"");
  }
  function arcPath(c,r,start,end,l,width,clockwise=false,legacy=false) {
    if(![...c,r,start,end].every(Number.isFinite))throw Error("Invalid PCB arc geometry");
    if(legacy){
      const w=sweep(start,end),n=Math.max(2,Math.ceil(w/6));
      return path(Array.from({length:n+1},(_,i)=>A.arcPoint({c,r},start+w*i/n)),l,width);
    }
    // Some Altium artwork stores a signed radius. Shift both angles by half a turn
    // to preserve its curve and endpoints with the positive radius used by the editor.
    if(r<0){r=-r;start+=180;end+=180;}
    if(r===0)return path([[...c],[...c]],l,width);
    const arc=clockwise?{kind:"arc",c,r,start:end,end:start,ccw:false}:{kind:"arc",c,r,start,end,ccw:true};
    return path(A.arcProjection(arc),l,width,{arc});
  }
  function sweep(from,to) {
    const raw=to-from,angle=(raw%360+360)%360;
    return angle || 360;
  }
  // Board6 perimeter: VX/VY vertices; KIND1 makes the edge to the next vertex
  // an arc about CX/CY, counter-clockwise from SA to EA. Returns the polygon,
  // flattened to 0.005 mm chord error, and the exact shape when arcs are
  // present (doc.boardShape, read by AtriumBoardShape; this module cannot
  // load it in the import worker, so the shape carries no signature).
  function outline(p,legacy=false,explicitClose=false) {
    if(!p)return {points:[],shape:null};
    const vertices=[];
    for(let i=0;p["VX"+i]!=null && p["VY"+i]!=null;i++)vertices.push([mm(p["VX"+i]),-mm(p["VY"+i])]);
    // A native ASCII board ends with a copy of the first vertex. Early Waffle
    // ASCII files omitted it and already use implicit closure.
    if(explicitClose && vertices.length>1 && vertices[0][0]===vertices.at(-1)[0] && vertices[0][1]===vertices.at(-1)[1])vertices.pop();
    const result=[],segs=[],distance=(u,v)=>Math.hypot(u[0]-v[0],u[1]-v[1]);
    let arcs=0;
    for(let i=0;i<vertices.length;i++){
      const a=vertices[i],b=vertices[(i+1)%vertices.length];result.push(a);
      let arc=null;
      if(Number(p["KIND"+i])===1&&p["CX"+i]!=null&&p["CY"+i]!=null){
        const c=[mm(p["CX"+i]),-mm(p["CY"+i])],start=Number(p["SA"+i]),end=Number(p["EA"+i]);
        const fromVertex=distance(a,c);
        let r=fromVertex;
        if(!legacy&&p["R"+i]!=null){
          try{const declared=mm(p["R"+i]);if(declared>0&&Math.abs(declared-fromVertex)<.02)r=declared;}catch{ /* Recover the radius from the stored vertex. */ }
        }
        if(Number.isFinite(start+end)&&r>0){
          const circle={c,r},s=A.arcPoint(circle,start),e=A.arcPoint(circle,end);
          const forward=Math.max(distance(s,a),distance(e,b)),backward=Math.max(distance(e,a),distance(s,b));
          if(Math.min(forward,backward)<.02)arc=(legacy?forward<.02:forward<=backward)?{c,r,start,end,ccw:true}:{c,r,start:end,end:start,ccw:false};
        }
      }
      if(!arc){segs.push({kind:"line",a,b});continue;}
      arcs++;segs.push({kind:"arc",...arc});
      const w=arc.ccw?sweep(arc.start,arc.end):-sweep(arc.end,arc.start);
      const C=AtriumGeometryCurves, points=C.project([C.arcEdge(arc,w)],.005,
        {minSegments:2,maxSegments:3600,maxStep:arc.r>.005?360:90});
      result.push(...points.slice(1,-1));
    }
    return {points:result,shape:arcs&&result.length>=3?{version:1,contour:segs,cutouts:[],source:"altium"}:null};
  }
  const linesOf=ring=>ring.map((a,i)=>({kind:"line",a,b:ring[(i+1)%ring.length]}));
  const truth=s=>/^(true|1|t)$/i.test(s||"");
  // Both Region streams have the same property header. The shape stream's outer contour
  // uses N+1 37-byte vertices; its closing point repeats the first XY, sometimes with a
  // different arc flag. Interior contours in BOTH streams are counted pairs of doubles.
  function regionGeometry(bytes,start,end,holeCount,extended){
    const v=view(bytes),rings=[];let c=start,contour=null;
    function count(stride,closure){
      if(c+4>end)throw Error("Truncated region contour.");
      const n=v.getUint32(c,true);c+=4;
      if(n<1||n+closure>Math.floor((end-c)/stride))throw Error("Invalid region vertex count.");
      return n;
    }
    if(extended){
      const n=count(37,1),points=[],fields={};let arcs=0;
      for(let i=0;i<n;i++,c+=37){
        const x=v.getInt32(c+1,true),y=v.getInt32(c+5,true);
        points.push([x*unit,-y*unit]);
        if(bytes[c]===0)continue;
        if(bytes[c]!==1)throw Error("Unknown shape-based region edge.");
        arcs++;fields["KIND"+i]=1;
        fields["CX"+i]=v.getInt32(c+9,true)/10000;fields["CY"+i]=v.getInt32(c+13,true)/10000;
        fields["SA"+i]=v.getFloat64(c+21,true);fields["EA"+i]=v.getFloat64(c+29,true);
      }
      if(v.getInt32(c+1,true)!==v.getInt32(start+5,true)||v.getInt32(c+5,true)!==v.getInt32(start+9,true))throw Error("Unclosed shape-based region.");
      c+=37;
      if(arcs){
        for(let i=0;i<n;i++){fields["VX"+i]=points[i][0]/.0254;fields["VY"+i]=-points[i][1]/.0254;}
        const o=outline(fields);
        if(!o.shape||o.shape.contour.filter(g=>g.kind==="arc").length!==arcs)throw Error("Inconsistent shape-based arc endpoints.");
        contour=o.shape.contour;rings.push(o.points);
      }else rings.push(points);
    }
    for(let r=extended?1:0;r<=holeCount;r++){
      const n=count(16,0),points=[];
      for(let i=0;i<n;i++,c+=16){
        const x=v.getFloat64(c,true)*unit,y=-v.getFloat64(c+8,true)*unit;
        if(!Number.isFinite(x+y)||Math.max(Math.abs(x),Math.abs(y))>1e6)throw Error("Invalid region coordinate.");
        points.push([x,y]);
      }
      if(points.length>3&&Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<1e-9)points.pop();
      rings.push(points);
    }
    if(c!==end||rings.some(r=>r.length<3))throw Error("Invalid region contour length.");
    return {rings,contour};
  }
  function regionHeader(bytes,base,end){
    if(end-base<22)throw Error("Truncated region header.");
    const v=view(bytes),start=base+22+v.getUint32(base+18,true);
    if(start+4>end)throw Error("Truncated region properties.");
    const p=props(decoder.decode(bytes.subarray(base+22,start)));
    return {p,start,layer:layer(p.V7_LAYER||bytes[base]),keep:!!(bytes[base+2]&2)||truth(p.KEEPOUT),
      net:v.getUint16(base+3,true),poly:v.getUint16(base+5,true),owner:v.getUint16(base+7,true),holes:v.getUint16(base+14,true)};
  }
  function regionRecords(bytes,extended,report,onInvalid){
    const rows=[],result={rows,damaged:false};
    if(!bytes?.length)return result;
    const v=view(bytes),c={i:0};let index=0;
    while(c.i<bytes.length){
      const at=c.i,record=index++;
      try{
        if(bytes[c.i++]!==11)throw Error("Unsupported region frame.");
        block(bytes,c);
        const end=c.i,header=regionHeader(bytes,at+5,end),{p,start}=header;
        // The integer anchor is shared with the flattened contour, to one source tick. It
        // keeps source indexes stable even when an older writer omits or reorders twins.
        const min=extended?13:20;
        if(end-start<min)throw Error("Missing region outline.");
        const x=extended?v.getInt32(start+5,true):Math.round(v.getFloat64(start+4,true));
        const y=extended?v.getInt32(start+9,true):Math.round(v.getFloat64(start+12,true));
        const meta=[header.layer,header.net,header.poly,header.owner,header.holes,header.keep,p.KEEPOUTRESTRICTIONS,
          p.OBJECTKIND,p.LAYERSTACKID,p.KIND,p.SUBPOLYINDEX,truth(p.ISBOARDCUTOUT)].join("|");
        let curved=false;
        if(extended){
          const n=v.getUint32(start,true);
          if(n+1>(end-start-4)/37)throw Error("Truncated shape-based contour.");
          for(let i=0;i<n;i++)if(bytes[start+4+37*i]===1){curved=true;break;}
        }
        rows.push({...header,bytes,v,at,end,extended,index:record,meta,anchor:[x,y],curved});
      }catch(error){result.damaged=true;onInvalid?.(record,error.message);report("Truncated "+(extended?"ShapeBasedRegions6":"Regions6")+" or invalid region record: "+error.message);if(c.i<=at+5)break;}
    }
    return result;
  }
  // Never collapse distinct shapes which merely start at the same vertex. The authored
  // anchors occur in order within the native tessellation and the hole arrays are identical.
  function twins(flat,shape,tolerance=1.01,anchors){
    const a=flat.v,b=shape.v,n=a.getUint32(flat.start,true),m=b.getUint32(shape.start,true);
    const ap=flat.start+4,bp=shape.start+4,ah=ap+16*n,bh=bp+37*(m+1);
    if(flat.meta!==shape.meta||Math.abs(flat.anchor[0]-shape.anchor[0])>tolerance||Math.abs(flat.anchor[1]-shape.anchor[1])>tolerance||!m||n<m||n!==m&&!shape.curved||ah>flat.end||bh>shape.end||flat.end-ah!==shape.end-bh)return false;
    let j=0;
    for(let i=0;i<m;i++){
      const x=b.getInt32(bp+37*i+1,true),y=b.getInt32(bp+37*i+5,true);
      while(j<n&&(Math.abs(a.getFloat64(ap+16*j,true)-x)>tolerance||Math.abs(a.getFloat64(ap+16*j+8,true)-y)>tolerance))j++;
      if(j===n)return false;
      if(anchors)anchors.push(j);
      j++;
    }
    for(let i=0;i<flat.end-ah;i++)if(flat.bytes[ah+i]!==shape.bytes[bh+i])return false;
    return true;
  }
  // Parallel cutout streams can round the same authored anchors by two ticks.
  // Use that extra allowance only for corresponding no-hole records with the
  // same properties and facets that follow each authored segment in order.
  function cutoutTwins(flat,shape){
    const S=globalThis.AtriumBoardShape, anchors=[];
    if(!S||flat.index!==shape.index||flat.holes||!shape.curved||regionKind(flat.p,flat.layer,flat.keep)!=="board cutout")return false;
    const keys=Object.keys(flat.p);
    if(keys.length!==Object.keys(shape.p).length||!keys.every(k=>flat.p[k]===shape.p[k])||
       !twins(flat,shape,2.01,anchors)||anchors[0]!==0)return false;
    let resolution,contour;
    try{
      resolution=mm(flat.p.ARCRESOLUTION);
      contour=regionGeometry(shape.bytes,shape.start,shape.end,0,true).contour;
    }catch{return false;}
    if(!(resolution>0)||!Number.isFinite(resolution)||!contour)return false;
    const count=flat.v.getUint32(flat.start,true), start=flat.start+4, lineTolerance=4*unit;
    for(const [i,g] of contour.entries()){
      const first=anchors[i]+1, end=anchors[i+1]??count;
      const [a,b]=S.ends(g), dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
      const slack=lineTolerance/Math.max(lineTolerance,S.segLength(g));
      let at=0,interior=false;
      for(let j=first;j<end;j++){
        const o=start+16*j, p=[flat.v.getFloat64(o,true)*unit,-flat.v.getFloat64(o+8,true)*unit];
        let progress;
        if(g.kind==="arc"){
          const sweep=S.sweep(g), angle=S.angleOf(g.c,p);
          const arcPosition=((Math.sign(sweep)*(angle-g.start))%360+360)%360;
          if(Math.abs(Math.hypot(p[0]-g.c[0],p[1]-g.c[1])-g.r)>resolution)return false;
          progress=arcPosition/Math.abs(sweep);
          if(progress>1+slack&&Math.hypot(p[0]-a[0],p[1]-a[1])<=lineTolerance)progress=0;
        }else{
          const x=p[0]-a[0],y=p[1]-a[1];
          if(!length){if(Math.hypot(x,y)>lineTolerance)return false;continue;}
          if(Math.abs(x*dy-y*dx)>lineTolerance*length)return false;
          progress=(x*dx+y*dy)/(length*length);
        }
        if(!(progress>=at-slack&&progress<=1+slack))return false;
        if(progress>slack&&progress<1-slack)interior=true;
        at=Math.max(at,progress);
      }
      if(g.kind==="arc"&&!interior)return false;
    }
    return true;
  }
  function pairedRegions(flat,extended){
    const byKey=new Map(),used=new Set(),out=[];
    const key=(s,x,y)=>s.meta+"|"+x+"|"+y;
    for(const s of extended){const k=key(s,...s.anchor);if(!byKey.has(k))byKey.set(k,[]);byKey.get(k).push(s);}
    for(const r of flat){
      let s=extended[r.index];
      if(!s||used.has(s)||!twins(r,s)){
        s=null;
        for(let x=-1;x<=1&&!s;x++)for(let y=-1;y<=1&&!s;y++)
          s=byKey.get(key(r,r.anchor[0]+x,r.anchor[1]+y))?.find(candidate=>!used.has(candidate)&&twins(r,candidate));
      }
      if(s)used.add(s);
      out.push({flat:r,shape:s});
    }
    let byOrdinal;
    for(const pair of out){
      if(pair.shape)continue;
      byOrdinal??=new Map(extended.map(row=>[row.index,row]));
      const s=byOrdinal.get(pair.flat.index);
      if(s&&!used.has(s)&&cutoutTwins(pair.flat,s)){pair.shape=s;used.add(s);}
    }
    for(const s of extended)if(!used.has(s))out.push({shape:s});
    return out;
  }
  function regionKind(p,layer,keep){
    if(p.OBJECTKIND?.toUpperCase()==="BOARDREGION"||p.LAYERSTACKID)return "layer stack region";
    if(truth(p.ISBOARDCUTOUT)||/^board[ _]?cutout$/i.test(p.KIND||""))return "board cutout";
    if(/^(1|cutout|polygon[ _]?cutout)$/i.test(p.KIND||""))return "polygon cutout";
    if(/^(0|copper|solid)$/i.test(p.KIND??"0"))return keep||layer==="Keepout"?"keepout":"region";
    return "unsupported kind "+p.KIND;
  }
  const knownKeepoutMask=mask=>Number.isInteger(mask)&&mask>=0&&mask<=0x1f;
  function regionItem(kind,layer,{rings,contour},p={}){
    const points=bridgeHoles(rings[0],rings.slice(1));
    if(!points)throw Error("Region hole lies outside the outline.");
    const obj=kind==="polygon cutout"?{kind:"polygon",points,layer,closed:true,cutout:true,width:0}
      :{kind:"graphic",points,layer,closed:true,fill:true,width:0};
    if(kind==="keepout"&&layer!=="Keepout")obj.keepout=true;
    if(kind==="keepout"&&p.KEEPOUTRESTRICTIONS!=null){
      const mask=Number(p.KEEPOUTRESTRICTIONS);
      if(!knownKeepoutMask(mask))throw Error("Unrecognised keepout restrictions.");
      obj.keepoutRestrictions=mask;
    }
    if(contour||rings.length>1){
      obj.regionShape={version:1,contour:contour||linesOf(rings[0]),cutouts:rings.slice(1).map(linesOf)};
      if(globalThis.AtriumBoardShape)obj.regionShape.sig=AtriumBoardShape.signature(points);
    }
    return obj;
  }
  // One ring from an outline and its holes: each hole, rightmost first, joins
  // the ring through two coincident horizontal segments from its rightmost
  // vertex to the nearest ring edge to the right (the cut-ins of Gerber
  // regions). Holes are oriented against the outline, so nonzero and even-odd
  // fills agree.
  function bridgeHoles(outer,holes){
    const area=r=>{let s=0;for(let i=0;i<r.length;i++){const a=r[i],b=r[(i+1)%r.length];s+=a[0]*b[1]-b[0]*a[1];}return s;};
    let ring=area(outer)>=0?outer.slice():outer.slice().reverse();
    const list=holes.map(h=>{
      const q=area(h)<=0?h.slice():h.slice().reverse();let m=0;
      for(let i=1;i<q.length;i++)if(q[i][0]>q[m][0]||(q[i][0]===q[m][0]&&q[i][1]<q[m][1]))m=i;
      return {q,m,x:q[m][0]};
    }).sort((a,b)=>b.x-a.x);
    for(const {q,m} of list){
      const M=q[m],n=ring.length;let best=Infinity,edge=-1;
      for(let i=0;i<n;i++){
        const a=ring[i],b=ring[(i+1)%n];
        if((a[1]<=M[1])===(b[1]<=M[1]))continue;
        const x=a[0]+(M[1]-a[1])*(b[0]-a[0])/(b[1]-a[1]);
        if(x>M[0]&&x<best){best=x;edge=i;}
      }
      if(edge<0)return null;
      if(edge===n-1){ring=[ring[n-1],...ring.slice(0,n-1)];edge=0;}
      const a=ring[edge],b=ring[(edge+1)%n],H=[best,M[1]];
      const loop=[];for(let k=0;k<=q.length;k++)loop.push(q[(m+k)%q.length]);
      const same=(u,w)=>u[0]===w[0]&&u[1]===w[1];
      // The hit point is a vertex when the ray ends on one; otherwise it splits the edge.
      ring=same(H,b)?[...ring.slice(0,edge+2),...loop,b,...ring.slice(edge+2)]
        :same(H,a)?[...ring.slice(0,edge+1),...loop,a,...ring.slice(edge+1)]
        :[...ring.slice(0,edge+1),H,...loop,H,...ring.slice(edge+1)];
    }
    return ring;
  }
  function addBoardCutout(doc,g){
    const o=doc.outline;
    if(o.length<3)throw Error("Board cutout needs a board perimeter.");
    const S=globalThis.AtriumBoardShape,outer=g.contour||linesOf(g.rings[0]);
    const shape=doc.boardShape||={version:1,contour:linesOf(o),cutouts:[],source:"altium"};
    if(g.rings.length===1){shape.cutouts.push(S?S.orient(outer,false):outer);return;}
    // A hole in the negative region leaves material inside the cutout. A cut-in makes
    // that area available to existing containment and pour code as one even-odd loop.
    // Keep the disjoint machining contours as well, so the cut-in itself is never milled.
    const item=regionItem("region","Multi",g);
    const path=globalThis.AtriumBoardShapeSources?.cutInContours(outer,g.rings.slice(1).map(linesOf))||linesOf(item.points),ring=S?S.orient(path,false):path,index=shape.cutouts.length;
    shape.cutouts.push(ring);
    (shape.cutoutRegions||={})[index]={...item.regionShape,sig:S?.signature(S.flattenContour(ring))};
  }
  function asciiRegion(p){
    const holes=Number(p.HOLECOUNT||0),native=p.MAINCONTOURVERTEXCOUNT!=null;
    if(!Number.isInteger(holes)||holes<0||holes>65535)throw Error("Invalid ASCII region hole count.");
    function ring(n,xKey,yKey,raw){
      if(!Number.isInteger(n)||n<3||n>1e6)throw Error("Invalid ASCII region vertex count.");
      const points=[];
      for(let i=0;i<n;i++){
        const x=p[xKey+i],y=p[yKey+i];
        if(x==null||y==null||x===""||y==="")throw Error("Truncated ASCII region contour.");
        const q=raw?[Number(x),Number(y)]:[mm(x),-mm(y)];
        if(!q.every(Number.isFinite)||Math.max(Math.abs(q[0]),Math.abs(q[1]))*(raw?unit:1)>1e6)throw Error("Invalid ASCII region coordinate.");
        points.push(q);
      }
      return points;
    }
    // Flat outer rings and every native hole are doubles in 1/10000 mil.
    // An authored outer contour uses typed VX/Y edges in Altium lengths.
    const flat=native&&p.MVX0!=null,raw=[],o=flat?null:outline(p),rings=[];
    if(flat)raw.push(ring(+p.MAINCONTOURVERTEXCOUNT,"MVX","MVY",true));
    else{
      const n=Number(p.MAINCONTOURVERTEXCOUNT);
      if(native&&(!Number.isInteger(n)||n<1||n>1e6||p["VX"+(n-1)]==null||p["VY"+(n-1)]==null))throw Error("Invalid authored ASCII region contour.");
      rings.push(o.points);
    }
    for(let h=0;h<holes;h++){
      const prefix="HOLE"+h;
      if(native)raw.push(ring(+p[prefix+"VERTEXCOUNT"],"H"+h+"VX","H"+h+"VY",true));
      else rings.push(ring(+p[prefix+"COUNT"],prefix+"VX",prefix+"VY",false));
    }
    for(const loop of raw)rings.push(loop.map(([x,y])=>[x*unit,-y*unit]));
    if(rings[0].length<3||rings.some(r=>r.some(([x,y])=>!Number.isFinite(x+y)||Math.max(Math.abs(x),Math.abs(y))>1e6)))throw Error("Invalid ASCII region contour.");
    return {rings,contour:o?.shape?.contour||null,nativeRings:flat?raw:null};
  }

  // Polygons6 record -> polygon item settings, or null when it is no
  // copper pour Waffle models (keep-outs become cutouts). Altium writes NAME
  // as comma-separated character codes. Clearance and connect style come from
  // the rules (Clearance, Polygon Connect Style), so they are left unset.
  /** @param {Record<string,string>} p @param {{toLayer?:(layer:string)=>string, netName?:(id:number)=>string, planes?:Record<string,string>, binary?:boolean}} [options] */
  function polygon(p,{toLayer,netName,planes,binary=false}={}){
    const length=s=>{
      if(s===undefined||s==="")return NaN;
      const m=/^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(mil|mm|in|inch|um)?\s*$/i.exec(String(s));
      return m?+m[1]*({mm:1,um:.001,in:25.4,inch:25.4,mil:.0254})[(m[2]||"mil").toLowerCase()]:NaN;
    };
    const ok=Number.isFinite,type=String(p.POLYGONTYPE||"Polygon").toLowerCase(),pts=[];
    let curved=false;
    const plane=type==="split plane"?planes?.[String(p.LAYER).toUpperCase()]:null;
    if(type!=="polygon"&&!plane)return null;
    for(let i=0;p["VX"+i]!=null&&p["VY"+i]!=null;i++){
      const a=[length(p["VX"+i]),-length(p["VY"+i])];pts.push(a);
      // Arc segment, as pcb-import reads the board outline: Altium sweeps
      // counter-clockwise (y up) from SA to EA; orient it from a to the next vertex.
      if(Number(p["KIND"+i])===1&&p["CX"+i]!=null){
        curved=true;
        const cx=length(p["CX"+i]),cy=-length(p["CY"+i]),r=Math.hypot(a[0]-cx,a[1]-cy),sa=+p["SA"+i],ea=+p["EA"+i];
        if(!ok(sa+ea+r)||!r)continue;
        const edge={kind:"arc",center:[cx,cy],radius:r,start:sa,sweep:sweep(sa,ea)};
        const arc=AtriumGeometryCurves.project([edge],.005,{minSegments:2,maxSegments:360,maxStep:5});
        const u=arc[0],v=arc.at(-1);
        if(Math.hypot(u[0]-a[0],u[1]-a[1])>Math.hypot(v[0]-a[0],v[1]-a[1]))arc.reverse();
        pts.push(...arc.slice(1,-1));
      }
    }
    const points=pts.filter(q=>q.every(ok));
    if(points.length>2&&Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<1e-9)points.pop();
    const layer=plane||(toLayer?toLayer(p.LAYER):p.LAYER);
    if(points.length<3||!/^(?:Top|Bottom|Inner [1-9]\d?)$/.test(layer||""))return null;
    const raw=String(p.NAME||""),coded=/^\d{1,5}(?:,\d{1,5})*$/.test(raw)&&(raw.includes(",")||p.INDEXFORSAVE!=null);
    const name=coded?String.fromCharCode(...raw.split(",",200).map(Number)):raw;
    const fields={layer,net:p.NET!=null&&netName?netName(+p.NET)||"":"",name:name.slice(0,200),
      removeDeadCopper:p.REMOVEDEAD==null?true:yes(p.REMOVEDEAD),pourOverSameNet:p.POUROVER==null?true:yes(p.POUROVER),
      pourIndex:ok(+p.POURINDEX)?+p.POURINDEX:0};
    // POUROVER=FALSE can accompany either native style 0 or 2. Preserve
    // the precise choice while the corresponding editable setting is intact.
    if(p.POUROVER!=null&&/^[012]$/.test(p.POUROVERSTYLE||""))
      fields.sourcePourOver={style:Number(p.POUROVERSTYLE),sameNet:fields.pourOverSameNet};
    if(curved){
      const shape=outline(p).shape;
      if(shape){
        const last=shape.contour.at(-1);
        if(last.kind==="line"&&last.a[0]===last.b[0]&&last.a[1]===last.b[1])shape.contour.pop();
        if(globalThis.AtriumBoardShape)shape.sig=AtriumBoardShape.signature(points);
        fields.regionShape=shape;
      }
    }
    if(plane){
      if(!fields.net||yes(p.KEEPOUT))return null;
      fields.powerPlane={sourceLayer:String(p.LAYER).toUpperCase()};
      fields.removeDeadCopper=false;fields.minPrimLength=0;fields.arcApproximation=.001;
    }
    if(yes(p.SHELVED))fields.shelved=true;
    if(yes(p.KEEPOUT))fields.cutout=true;
    const min=length(p.MINPRIMLENGTH),arc=length(p.ARCRESOLUTION);
    if(min>=0)fields.minPrimLength=min;
    if(arc>0)fields.arcApproximation=Math.max(.0005,arc);
    // Island threshold: internal units squared (1e-4 mil) in binary records, mil² in old ASCII ones.
    const area=+(p.AREATHRESHOLD??p.ISLANDAREATHRESHOLD);
    if(yes(p.REMOVEISLANDSBYAREA)&&area>0)fields.islandAreaThreshold=binary||p.INDEXFORSAVE!=null||area>1e6?area*unit*unit:area*.0254*.0254;
    // Hatched: Altium draws tracks of TRACKWIDTH on a GRIDSIZE pitch.
    const hatch=String(p.HATCHSTYLE||"Solid").toLowerCase(),w=length(p.TRACKWIDTH),g=length(p.GRIDSIZE);
    if(w>0&&w<=100)fields.hatchWidth=w;
    if(g>0&&g<=100)fields.hatchPitch=g;
    // None (Outlines Only): tracks of TRACKWIDTH round the fill's boundary (Atrium's outline fill).
    if(hatch==="none")fields.fillMode="outline";
    else if(hatch!=="solid"){
      fields.fillMode="hatched";
      if(fields.hatchPitch)fields.hatchPitch=Math.max(fields.hatchPitch,(fields.hatchWidth||.15)*1.01);
      fields.hatchAngle=/45/.test(hatch)?45:/horizontal/.test(hatch)?0:90;
    }
    // Remove Necks When Copper Width Less Than: REMOVENECKS with NECKWIDTHTHRESHOLD (Altium's default 5 mil).
    if(yes(p.REMOVENECKS)){const nw=length(p.NECKWIDTHTHRESHOLD);fields.neckWidth=Math.min(5,nw>0?nw:.127);}
    return {kind:"polygon",points,closed:true,...fields};
  }
  function setBoardGeometry(doc,p,legacy=false,explicitClose=false){
    const o=outline(p,legacy,explicitClose);doc.outline=o.points;if(o.shape)doc.boardShape=o.shape;
    // The stored geometry is absolute. ORIGINX/Y are the independent relative
    // origin (Edit > Origin), also available as a fabrication output datum.
    if(!p?.ORIGINX||!p.ORIGINY)return;
    try{
      const [x,y]=unitPoint(p,"ORIGINX","ORIGINY");
      if(Number.isFinite(x)&&Number.isFinite(y))doc.origin=[x||0,y||0];
    }catch{/* Older or malformed Board records can omit the relative origin. */}
  }
  // Board6 LAYER<id>NAME of the mechanical layers (V7 ids 57-72 = Mechanical
  // 1-16): the names the designer gave them ("Board Shape", "Top Courtyard").
  // Waffle keeps the "Mechanical n" keys (layer rules, colours and outputs
  // read them) and shows these names through doc.layerNames.
  function mechanicalNames(p){
    const out={};if(!p)return out;
    for(let id=57;id<=72;id++){
      const key="Mechanical "+(id-56),raw=String(p["LAYER"+id+"NAME"]??"").replace(/[\x00-\x1f\x7f]/g,"").trim().slice(0,64);
      if(raw&&raw!==key&&raw.toLowerCase()!==key.toLowerCase())out[key]=raw;
    }
    return out;
  }
  // Names for the layers this board uses. A name shared by two used layers
  // (Altium allows it) gets its layer number so the layer bar stays unambiguous.
  function layerNames(doc,library,names){
    const used=new Set(),take=o=>{if(o?.layer&&Object.hasOwn(names,o.layer))used.add(o.layer);};
    doc.items.forEach(take);for(const def of library){def.footprint?.pads?.forEach(take);def.footprint?.shapes?.forEach(take);}
    const keys=[...used],out={};
    for(const k of keys)out[k]=keys.some(o=>o!==k&&names[o]===names[k])?names[k]+" ("+k+")":names[k];
    if(keys.length)doc.layerNames=out;
  }
  // The Board6 record keeps the legacy (V7) layer stack as a linked list from
  // the top layer: LAYER<id>NAME/PREV/NEXT/COPTHICK, with the dielectric below
  // each copper layer in LAYER<id>DIELTYPE/DIELCONST/DIELHEIGHT/DIELMATERIAL.
  // Ids 1 and 32 are the outer layers, 2-31 mid layers, 39-54 internal planes.
  // Waffle keys copper by stack position, so `keys` maps each imported mid
  // layer name to the key of its position when they differ.
  function layerStack(p) {
    if(!p || p.LAYER1NAME==null || p.LAYER32NAME==null)return null;
    const chain=[],seen=new Set();
    for(let id=1;id;id=Number(p["LAYER"+id+"NEXT"])||0){
      if(seen.has(id) || !(id>=1&&id<=32 || id>=39&&id<=54) || p["LAYER"+id+"NAME"]==null)return null;
      seen.add(id);chain.push(id);
      if(id===32)break;
    }
    if(chain.at(-1)!==32 || chain.length<2 || chain.length>32)return null;
    const n=chain.length,layers=[],keys={},planes={},ruleLayers={},positive=v=>Number.isFinite(v)&&v>0;
    const key=i=>i===0?"Top":i===n-1?"Bottom":"Inner "+i;
    const number=(v,fallback)=>{const x=Number(v);return Number.isFinite(x)&&x>0?x:fallback;};
    function surface(side){
      const s=side.toUpperCase(),height=p[s+"HEIGHT"]!=null?mm(p[s+"HEIGHT"]):.01016;
      return {type:"Solder Mask",name:side+" Solder",material:p[s+"MATERIAL"]||"Solder Resist",thickness:height>=0&&height<10?height:.01016,dk:number(p[s+"CONST"],3.5)};
    }
    layers.push({type:"Overlay",name:"Top Overlay",material:"",thickness:0},surface("Top"));
    chain.forEach((id,i)=>{
      const f=s=>p["LAYER"+id+s],copper=f("COPTHICK")!=null?mm(f("COPTHICK")):.03556;
      layers.push({type:id>=39?"Plane":"Signal",name:String(f("NAME")).slice(0,80)||key(i),material:"Copper",thickness:positive(copper)&&copper<10?copper:.03556,key:key(i)});
      if(id>=39)planes["PLANE"+(id-38)]=key(i);
      else if(layer(id)!==key(i))keys[layer(id)]=key(i);
      if(id>=39||layer(id)!==key(i))ruleLayers[key(i)]=null;
      if(i===n-1)return;
      const height=f("DIELHEIGHT")!=null?mm(f("DIELHEIGHT")):1.524,material=f("DIELMATERIAL")||"FR-4",type=Number(f("DIELTYPE"));
      // Altium's dielectric type: 1 core, 2 prepreg.
      const prepreg=type===2 || type!==1 && /pre-?preg/i.test(material);
      layers.push({type:"Dielectric",name:"Dielectric "+(i+1),material,thickness:positive(height)&&height<10?height:1.524,
        dielectric:prepreg?"Prepreg":"Core",dk:number(f("DIELCONST"),4.8)});
    });
    layers.push(surface("Bottom"),{type:"Overlay",name:"Bottom Overlay",material:"",thickness:0});
    // A source mid-layer number can now identify a different physical layer or an internal plane.
    Object.assign(ruleLayers,keys);
    return {stackup:{version:1,source:"Altium",layers,drillPairs:[]},keys,planes,ruleLayers};
  }
  function renumber(doc,library,keys,negative){
    if(!Object.keys(keys).length)return;
    const fix=o=>{
      // A track drawn on a negative plane is already a finished void aperture.
      if(negative.has(o?.layer)&&["track","graphic","path","circle"].includes(o.kind)){
        o.planeVoid=true;o.keepout=true;if(o.kind==="track")o.kind="graphic";
      }
      for(const f of ["layer","fromLayer","toLayer"])if(o&&Object.hasOwn(keys,o[f]??""))o[f]=keys[o[f]];
    };
    doc.items.forEach(i=>{if(!i.powerPlane)fix(i);});
    for(const def of library){def.footprint?.pads?.forEach(fix);def.footprint?.shapes?.forEach(fix);}
    doc.pcbDrawing?.pours?.forEach(fix);
  }
  const path=(points,layer,width,extra={})=>({kind:copper(layer)?"track":"graphic",points,layer,width,...extra});
  // Keep-out primitives (binary flags2 == 2, ASCII KEEPOUT=TRUE) are rule areas, not copper: on the
  // Keep-Out layer they apply to every layer, on a single layer they are that layer's keep-out.
  function keepoutObject(o,mask){
    if(!o||(o.kind!=="track"&&o.kind!=="graphic"))return o;
    return {...o,kind:"graphic",...(o.layer!=="Keepout"&&{keepout:true}),
      ...(knownKeepoutMask(mask)&&{keepoutRestrictions:mask})};
  }
  // The extended Arcs6, Tracks6 and Fills6 payloads place the object restriction
  // mask immediately after the optional four-byte V7 layer ID. See the public
  // binary layout at https://github.com/embedded-society/altium-designer-mcp/blob/main/docs/PCBLIB_FORMAT.md
  const keepoutMaskOffset={1:56,4:45,6:46};
  function binaryKeepoutMask(geom,type,layer,report){
    if(layer!=="Keepout"&&(!copper(layer)||layer==="Multi"))return undefined;
    const mask=geom[keepoutMaskOffset[type]];
    if(mask===undefined)return undefined;
    if(!knownKeepoutMask(mask)){
      report("Unrecognised binary keepout restrictions kept as all-object keepouts");
      return undefined;
    }
    // A zero byte on the dedicated Keep-Out layer uses its all-object default.
    return mask===0&&layer==="Keepout"?undefined:mask;
  }
  function rectPoints(x1,y1,x2,y2,angle=0) {
    const mid=[(x1+x2)/2,(y1+y2)/2];
    return [[x1,y1],[x2,y1],[x2,y2],[x1,y2],[x1,y1]].map(p=>A.world([p[0]-mid[0],p[1]-mid[1]],{x:mid[0],y:mid[1],angle}));
  }
  function padShape(value) {
    const s=String(value||"").toUpperCase();
    return /^(1|ROUND|CIRCULAR|CIRCLE|OVAL)$/.test(s)?"round":/^(9|ROUNDEDRECTANGLE|ROUNDRECT)$/.test(s)?"roundrect":"rect";
  }
  // Pads6 and Vias6 record the final mask state on each outside face. Their
  // settings distinguish a manual expansion (2) from a value cached from a rule (1).
  function binaryMask(geom,type,L) {
    const top=!!(geom[1]&32),bottom=!!(geom[1]&64),fields={};
    fields.tent={top,bottom};
    if(type===2 && geom.length>=103){
      if(geom[102]===2)fields.maskExpansion=L(90);
      if(geom[101]===2 && !L(45))fields.pasteExpansion=L(86);
    }else if(type===3 && geom.length>=67 && geom[66]===2)fields.maskExpansion=L(54);
    return fields;
  }
  function padHole(size,length,rotation,type,report) {
    if(!(size>0) || type==="round")return {drill:size};
    const hasLength=Number.isFinite(length)&&length>0&&length<1e5;
    const drill=hasLength?Math.min(size,length):size;
    if(type==="slot" && hasLength && size===length)return {drill};
    if(type==="slot" && hasLength && Number.isFinite(rotation)){
      // At zero hole rotation, the extended dimension is local X and the base
      // dimension is local Y. Waffle stores the major axis, independent of pad rotation.
      const slotAngle=(-rotation%360+(size>length?90:0))%360;
      return {drill,slotLength:Math.max(size,length),...(slotAngle?{slotAngle}:{})};
    }
    report(type==="slot"?"Incomplete slotted pad holes approximated by round drills":
      type==="rectangular"?"Rectangular pad holes approximated by round drills":"Unknown pad hole shapes approximated by round drills");
    return {drill};
  }
  // A MultiLayer pad can be a drill and solder opening with zero copper on
  // every layer. The hole supplies its selectable footprint in the editor.
  function padLand(w,h,drill){
    if(w>0 && h>0)return {w,h,...(drill>0 && drill>=Math.min(w,h)-1e-6?{plotLand:true}:{})};
    return w===0 && h===0 && drill>0?{w:drill,h:drill,holeOnly:true}:null;
  }
  function stackPad(stack,drill){
    // The outer size in the editor is selectable even if this face has no land.
    const rows=[stack.Top,stack.Mid,stack.Bottom];
    if(rows.some(r=>r.w<0 || r.h<0 || Boolean(r.w)!==Boolean(r.h)))return null;
    const nominal=rows.find(r=>r.w>0)||stack.Top,land=padLand(nominal.w,nominal.h,drill);
    return land && {...land,shape:nominal.shape,stackMode:"tmb",padStack:stack,
      ...(rows.some(r=>r.w>0 && drill>0 && drill>=Math.min(r.w,r.h)-1e-6)?{plotLand:true}:{})};
  }
  const textJustifications=["top-left","middle-left","bottom-left","top-center","center","bottom-center","top-right","middle-right","bottom-right"];
  function setWritingOrigin(box, obj, baseline, mirrored) {
    // Store the native pen position relative to the editable text anchor, before rotation and reflection.
    const q=A.rotate([baseline[0]-obj.x,baseline[1]-obj.y],-obj.angle);
    box.writingOffset=[mirrored?-q[0]:q[0],q[1]].map(v=>Number(v.toFixed(9)));
    box.sourceJustify=obj.justify;
  }
  function binaryObject(bytes,c,report,textPlacement,legacyArcPaths=false,nativeText=false,keepoutExtension=true) {
    const type=bytes[c.i++], b=block(bytes,c);
    let geom=b,number="",padDetails;
    if(type===2){
      number=shortString(b);for(let j=0;j<3;j++)block(bytes,c);
      geom=block(bytes,c);padDetails=block(bytes,c);
    }
    if(type===11){
      // Footprint libraries interleave regions and pads in a single framed Data stream.
      // Some libraries keep only the tessellation even for ISSHAPEBASED primitives.
      try{
        const r=regionHeader(b,0,b.length),kind=regionKind(r.p,r.layer,r.keep);
        if(r.poly!==noOwner){report("Omitted polygon-owned footprint region");return null;}
        if(kind==="region"&&(r.layer==="Multi"||/^Layer \d+$/.test(r.layer))){report("Omitted footprint region on "+r.layer);return null;}
        if(!["region","polygon cutout","keepout"].includes(kind)){report("Omitted footprint region ("+kind+")");return null;}
        let g;
        try{g=regionGeometry(b,r.start,b.length,r.holes,false);}
        catch{g=regionGeometry(b,r.start,b.length,r.holes,true);}
        if(truth(r.p.ISSHAPEBASED)&&!g.contour)report("Shape-based footprint regions retained as stored outlines");
        return {obj:regionItem(kind,r.layer,g,r.p),owner:r.owner,net:r.net};
      }catch(error){report("Unreadable footprint region: "+error.message);return null;}
    }
    if(![1,2,3,4,5,6].includes(type)){
      // Component bodies have one length-prefixed block. Other records have
      // no known framing, so continuing could misidentify data.
      if(type!==12)throw Error("Unsupported binary primitive "+type);
      report("3D bodies");return null;
    }
    // The frame is intact, so a payload too short for its kind's fixed fields drops only this record.
    if(geom.length<{1:45,2:60,3:31,4:33,5:21,6:37}[type]){report("Truncated binary "+["","arc","pad","via","track","text","fill"][type]+" records");return null;}
    const v=view(geom),U=i=>v.getUint16(i,true),L=i=>tickMM(v.getInt32(i,true)),D=i=>v.getFloat64(i,true);
    const position=i=>[L(i),-L(i+4)];
    const l=layer(geom[0]),owner=U(7),net=U(3),polygon=U(5);
    const [x,y]=position(13);
    let obj;
    if(type===1){
      obj=arcPath([x,y],L(21),D(25),D(33),l,L(41),false,legacyArcPaths);
    } else if(type===2){
      const w=L(21),h=L(25),size=L(45);
      // The extension stores the hole shape, second dimension and pad-relative rotation.
      const holeType=padDetails?.[262],detail=padDetails?.length>=275?view(padDetails):null;
      const hole=padHole(size,detail?tickMM(detail.getInt32(263,true)):0,detail?.getFloat64(267,true),
        holeType==null||holeType===0?"round":holeType===2?"slot":holeType===1?"rectangular":"unknown",report);
      const {drill}=hole;
      // Rounded rectangles: a compatibility shape here; per layer (0 top, 1-30 mid, 31 bottom) the extended
      // block has alternate shape 9 and the corner in % of half the shorter side.
      const alt=padDetails?.length>=596?k=>padDetails[532+k]===9&&padDetails[564+k]<=100?padDetails[564+k]/200:null:()=>null;
      const shaped=(row,base,k)=>{const r=[1,2,9].includes(base)?alt(k):null;return r==null?row:{...row,shape:"roundrect",roundrectRadiusRatio:r};};
      const stackRow=(offset,shape,k)=>shaped({w:L(offset),h:L(offset+4),shape:padShape(geom[shape])},geom[shape],k);
      const rows=geom[62]===1?{Top:stackRow(21,49,0),Mid:stackRow(29,50,1),Bottom:stackRow(37,51,31)}:null;
      const land=rows?stackPad(rows,drill):padLand(w,h,drill);
      if(!land){report("Pads without top geometry");return null;}
      obj={kind:"pad",number,x,y,shape:padShape(geom[49]),...land,...hole,angle:-D(52),layer:l,...binaryMask(geom,type,L)};
      if(rows){
        const nominal=[rows.Top,rows.Mid,rows.Bottom].find(r=>r.w>0)||rows.Top;
        if(nominal.shape==="roundrect")obj.roundrectRadiusRatio=nominal.roundrectRadiusRatio;
      }else{
        const top=shaped({shape:obj.shape},geom[49],0);
        if(top.shape==="roundrect"){obj.shape="roundrect";if(top.roundrectRadiusRatio!=null)obj.roundrectRadiusRatio=top.roundrectRadiusRatio;}
      }
      if(land.holeOnly)obj.plated=!!geom[60];
      if(geom[62]>1)report("Full pad stacks simplified");
      if(geom[49]===3)report("Octagonal pads simplified");
    } else if(type===3){
      obj={kind:"via",x,y,diameter:L(21),drill:L(25),layer:"Multi",fromLayer:layer(geom[29]),toLayer:layer(geom[30]),...binaryMask(geom,type,L)};
    } else if(type===4){
      obj=path([[x,y],position(21)],l,L(29));
    } else if(type===5){
      if(geom.length<123){report("Legacy text records");return null;}
      const text=shortString(block(bytes,c));
      obj={kind:"label",x,y,text,angle:-D(27),size:L(21),layer:l,...textStyle(geom,L,U,report)};
      // Texts6 stores the unrotated ink dimensions, or the layout rectangle for a text frame.
      // Older records only carry the lower-left writing origin; newer ones also save justification.
      const justify=geom.length>=252 && geom[240] && textJustifications[geom[132]-1];
      if(textPlacement && geom.length>=133 && obj.size>0 && L(124)>0 && L(128)>0 &&
          (textPlacement===1 ? justify && obj.font==="truetype" : geom[43]<2 && (!geom[110] || obj.font==="truetype"))){
        if(justify){[obj.x,obj.y]=position(244);obj.justify=justify;}
        const box={text,width:L(124),height:L(128),size:obj.size};
        if(obj.font==="truetype")Object.assign(box,{family:obj.family||"Arial",bold:!!obj.bold,italic:!!obj.italic});
        else Object.assign(box,{font:"stroke",strokeFont:obj.strokeFont||"default",strokeWidth:obj.width||0});
        if(textPlacement!==1){
          box.mode=geom[230]?"frame":justify?"ink":"baseline";
          // Altium's stroke layout rectangle allows a full pen width on each edge;
          // on the plotted board only half of that pen extends past the centreline.
          if(box.font==="stroke" && box.strokeWidth>0 && box.width>box.strokeWidth && box.height>box.strokeWidth){
            box.width-=box.strokeWidth;box.height-=box.strokeWidth;
          }
          if(geom[230] && geom[231] && L(133)>0)box.margin=L(133);
        }
        if(nativeText && justify)setWritingOrigin(box,obj,[x,y],!!geom[35]);
        obj.sourceTextBox=box;
      }
      if(textPlacement===2 && geom[110] && obj.font==="truetype"){
        obj.inverted=true;
        if(geom.length>=115 && L(111)>=0)obj.margin=L(111);
      }
      if(geom[35])obj.mirrored=true;
      else if(textPlacement===2 && /^Bottom/.test(l))obj.mirrored=false;
      if(geom[40])obj.role="comment";
      if(geom[41])obj.role="designator";

    } else {
      const [x2,y2]=position(21);
      obj={kind:"graphic",points:rectPoints(x,y,x2,y2,-D(29)),layer:l,closed:true,fill:true,width:.05};
    }
    if(type===2||type===3){
      const top=!!(geom[1]&0x80),bottom=!!(geom[2]&1);
      if(top||bottom)obj.fabTestpoint=top&&bottom?"Both":top?"Top":"Bottom";
      if(type===2&&geom[60]===0)obj.plated=false;
    }
    if(geom[2]===2&&Object.hasOwn(keepoutMaskOffset,type))
      obj=keepoutObject(obj,keepoutExtension?binaryKeepoutMask(geom,type,l,report):undefined);
    return {owner,net,obj,mirrored:type===5&&!!geom[35],polygon:type===1||type===4?polygon:noOwner};
  }
  // LettersGeometry is the board's saved tessellation of the characters actually
  // used. A set ends with its Texts6 record indices. Its contours are already
  // at the recorded text size. Keep one copy per board and decode on first use.
  function encodedLetters(data){
    if(typeof data.toBase64==="function")return data.toBase64();
    let raw="";
    for(let k=0;k<data.length;k+=8192)raw+=String.fromCharCode(...data.subarray(k,k+8192));
    return btoa(raw);
  }
  function lettering(bytes){
    const v=view(bytes),sets=[],owners=new Map();
    let pos=0;
    function u32(){
      if(pos+4>bytes.length)throw Error("Truncated lettering table.");
      const value=v.getUint32(pos,true);pos+=4;return value;
    }
    while(pos<bytes.length){
      const count=u32(),glyphs={};
      if(count>65536 || sets.length>=65536)throw Error("Invalid lettering table size.");
      for(let j=0;j<count;j++){
        if(pos+30>bytes.length)throw Error("Truncated lettering record.");
        const ch=v.getUint16(pos,true),advance=v.getInt32(pos+10,true),length=v.getUint32(pos+14,true);
        const end=pos+22+length;
        if(length<8 || end>bytes.length || v.getUint32(pos+22,true)!==length-4)throw Error("Invalid lettering record length.");
        const data=bytes.subarray(pos+26,end);
        glyphs[ch]=[advance,encodedLetters(data)];pos=end;
      }
      const n=u32();
      if(n>(bytes.length-pos)/4)throw Error("Truncated lettering owners.");
      for(let i=0;i<n;i++)owners.set(u32(),sets.length);
      sets.push(glyphs);
    }
    return {sets,owners};
  }
  // Texts6 string style: stroke width (36), stroke font (25: 1 Default, 2 Sans
  // Serif, 3 Serif), font type (43: 0 stroke, 1 TrueType, 2 barcode), bold (44),
  // italic (45), TrueType family (46, UTF-16, 32 characters), inverted (110).
  // Only fields that differ from AtriumPCBText's defaults are set.
  function textStyle(geom,L,U,report){
    const st={},w=L(36);if(w>0&&w<10)st.width=w;
    if(geom[43]===1){
      st.font="truetype";let family="";
      for(let k=46;k<110;k+=2){const ch=U(k);if(!ch)break;family+=String.fromCharCode(ch);}
      family=family.replace(/[\x00-\x1f\x7f]/g,"").trim();
      if(family)st.family=family.slice(0,64);
      if(geom[44])st.bold=true;if(geom[45])st.italic=true;
    }else{
      const f=U(25);if(f===2)st.strokeFont="sans";else if(f===3)st.strokeFont="serif";
      if(geom[43]===2)report("Barcode strings plotted as stroke text");
    }
    if(geom[110] && geom[43]!==1)report("Inverted stroke strings plotted without their knockout");
    return st;
  }
  const TEXT_STYLE=["width","font","family","bold","italic","strokeFont","mirrored","justify","sourceTextBox","inverted","margin"];
  const styleOf=obj=>{const o={};for(const k of TEXT_STYLE)if(obj[k]!==undefined)o[k]=obj[k];return o;};
  // Altium pours keep the Board Outline Clearance rule's gap from the board
  // edge; Waffle's pour reads it from the polygon (boardClearance). The
  // enabled rule of highest priority whose scopes are All sets it on each
  // imported pour that has none.
  function edgeClearance(doc,lines){
    let best=null;
    for(const line of lines||[]){
      const p=props(String(line));
      if(String(p.RULEKIND||"").toLowerCase()!=="boardoutlineclearance"||/^(false|0)$/i.test(p.ENABLED||"")||!/^all$/i.test(p.SCOPE1EXPRESSION||"All")||!/^all$/i.test(p.SCOPE2EXPRESSION||"All"))continue;
      let gap;try{gap=mm(p.GAP);}catch{continue;}
      const priority=Number(p.PRIORITY)||1;
      if(gap>0&&gap<10&&(!best||priority<best.priority))best={gap,priority};
    }
    if(best)for(const i of doc.items)if(i.kind==="polygon"&&!(i.boardClearance>0))i.boardClearance=best.gap;
  }
  // Internal plane antipads and thermal reliefs start at the drilled barrel. Preserve
  // the global source plane settings independently of positive-polygon design rules.
  function planeSettings(doc,notes){
    const planes=doc.items.filter(i=>i.powerPlane);if(!planes.length)return;
    const rules=(doc.sourceRules||[]).map(props).filter(r=>!/^(false|f|0)$/i.test(r.ENABLED||""));
    const global=r=>r&&[r.SCOPE1EXPRESSION,r.SCOPE2EXPRESSION].every(s=>/^all$/i.test((s||"All").trim()));
    let partial=false;
    function firstGlobal(kind){
      const ordered=rules.filter(r=>r.RULEKIND?.toLowerCase()===kind).sort((a,b)=>(+a.PRIORITY||1)-(+b.PRIORITY||1));
      const first=ordered.find(global);
      if(!first||ordered[0]!==first)partial=true;
      return first;
    }
    const clear=firstGlobal("planeclearance"),connect=firstGlobal("planeconnect");
    function dimension(source,fallback){
      if(source!=null&&source!==""){try{const v=mm(source);if(Number.isFinite(v)&&v>=0)return v;}catch{/* retain the raw rule for review */}}
      partial=true;return fallback;
    }
    const style=s=>({direct:"direct",relief:"relief",noconnect:"none","no connect":"none",none:"none"})[String(s||"").toLowerCase()];
    for(const p of planes){
      const g=p.powerPlane;
      if(clear)p.clearance=dimension(clear.CLEARANCE,p.clearance);
      if(connect)for(const name of ["pad","via"]){
        const field=k=>connect[name.toUpperCase()+"."+k]??connect[k];
        const mode=style(field("PLANECONNECTSTYLE"));if(!mode){partial=true;continue;}
        p[name==="pad"?"connectStyle":"viaConnectStyle"]=mode;
        if(mode==="relief"||field("RELIEFEXPANSION")!=null){
          const entries=+field("RELIEFENTRIES");if(entries!==2&&entries!==4)partial=true;
          g[name]={expansion:dimension(field("RELIEFEXPANSION"),0),airGap:dimension(field("RELIEFAIRGAP"),.254),
            width:dimension(field("RELIEFCONDUCTORWIDTH"),.254),entries:entries===2?2:4};
        }
      }
    }
    notes.push(planes.length+" net-assigned split plane(s) imported as editable internal copper. The source outlines include their edge pullback.");
    if(partial)notes.push("Only the supported global internal plane settings were applied. Review the original Plane Clearance and Plane Connect Style rules for scoped overrides or missing values.");
  }
  function unitPoint(p,x="X",y="Y"){return [mm(p[x]),-mm(p[y])];}
  function manualMaskFields(p){
    const fields={};
    for(const [key,field] of [["SOLDERMASK","maskExpansion"],["PASTEMASK","pasteExpansion"]]){
      const mode=p[key+"EXPANSIONMODE"]||p[key+"EXPANSION_MODE"],value=p[key+"EXPANSION_MANUAL"];
      if(/^manual$/i.test(mode||"") && value!=null && value!=="")fields[field]=mm(value);
    }
    return fields;
  }
  function asciiObject(p,report) {
    const type=p.RECORD.toLowerCase(),l=layer(p.LAYER),[x,y]=unitPoint(p);
    let obj;
    if(type==="track")obj=path([unitPoint(p,"X1","Y1"),unitPoint(p,"X2","Y2")],l,mm(p.WIDTH));
    else if(type==="arc"){
      const center=[mm(p["LOCATION.X"]??p.LOCATIONX??p.X),-mm(p["LOCATION.Y"]??p.LOCATIONY??p.Y)];
      obj=arcPath(center,mm(p.RADIUS),Number(p.STARTANGLE||0),Number(p.ENDANGLE||0),
        l,mm(p.WIDTH),p.WAFFLECLOCKWISE==="TRUE");
    } else if(type==="pad"){
      const w=mm(p.XSIZE||p.TOPXSIZE),h=mm(p.YSIZE||p.TOPYSIZE);
      const shape=padShape(p.SHAPE||p.TOPSHAPE),size=mm(p.HOLESIZE);
      const typeName=String(p.HOLETYPE||"").trim().toLowerCase().replace(/\s+hole$/,"");
      const holeType=/^(?:|0|round|circular)$/.test(typeName)?"round":/^(?:2|slot|slotted)$/.test(typeName)?"slot":
        /^(?:1|rect|rectangle|rectangular|square)$/.test(typeName)?"rectangular":"unknown";
      let length=0;
      if(size>0 && holeType!=="round"){
        try{length=mm(p.HOLELENGTH);}catch{ /* A malformed secondary dimension leaves the nominal drill. */ }
      }
      const hole=padHole(size,length,Number(p.HOLEROTATION||0),holeType,report);
      const {drill}=hole;
      const stackRow=k=>({w:mm(p[k+"XSIZE"]),h:mm(p[k+"YSIZE"]),shape:padShape(p[k+"SHAPE"]||p.SHAPE)});
      const land=/^(1|top[-_ ]?middle[-_ ]?bottom)$/i.test(p.PADMODE||"") && ["TOP","MID","BOT"].every(k=>p[k+"XSIZE"]!=null && p[k+"YSIZE"]!=null)?
        stackPad({Top:stackRow("TOP"),Mid:stackRow("MID"),Bottom:stackRow("BOT")},drill):padLand(w,h,drill);
      if(!land){report("Pads without top geometry");return null;}
      obj={kind:"pad",x,y,shape,...land,...hole,number:p.NAME||p.DESIGNATOR||"",angle:-Number(p.ROTATION||0),layer:l};
      if(obj.shape==="roundrect" && p.CRPERCENTAGE!=null && Number.isFinite(+p.CRPERCENTAGE) && +p.CRPERCENTAGE>=0 && +p.CRPERCENTAGE<=100)
        obj.roundrectRadiusRatio=+p.CRPERCENTAGE/200;
      if(land.holeOnly && p.PLATED!=null)obj.plated=yes(p.PLATED);
    } else if(type==="via"){
      const diameter=mm(p.DIAMETER||p.SIZE);if(diameter<=0){report("Vias without diameter");return null;}
      obj={kind:"via",x,y,diameter,drill:mm(p.HOLESIZE),layer:"Multi",fromLayer:layer(p.STARTLAYER),toLayer:layer(p.ENDLAYER)};
    } else if(type==="text"){
      let text=p.TEXT||"";
      if(p.WIDESTRING && /^(?:\d{1,5},)*\d{1,5}$/.test(p.WIDESTRING)){
        const codes=p.WIDESTRING.split(",").map(Number);
        if(codes.every(n=>n<=65535))text=codes.map(n=>String.fromCharCode(n)).join("");
      }
      obj={kind:"label",x,y,text,angle:-Number(p.ROTATION||0),size:mm(p.HEIGHT),layer:l};
      if(p.WIDTH!=null)obj.width=mm(p.WIDTH);
      if(p.MIRROR!=null)obj.mirrored=yes(p.MIRROR);
      const ttf=yes(p.USETTFONTS)||p.TEXTKIND==="1", stroke=String(p.FONT||"").toLowerCase();
      if(ttf){obj.font="truetype";obj.family=p.FONTNAME||"Arial";if(yes(p.BOLD))obj.bold=true;if(yes(p.ITALIC))obj.italic=true;}
      else if(stroke==="sansserif"||stroke==="serif")obj.strokeFont=stroke==="serif"?"serif":"sans";
      const justify=textJustifications[Number(p.TTFINVERTEDTEXTJUSTIFY)-1];
      if(yes(p.ADVANCESNAPPING) && justify && p.JUSTIFICATIONCENETERX!=null && p.JUSTIFICATIONCENETERY!=null){
        [obj.x,obj.y]=unitPoint(p,"JUSTIFICATIONCENETERX","JUSTIFICATIONCENETERY");
        obj.justify=justify;
      }
      if(obj.size>0 && p.INVRECTWIDTH!=null && p.INVRECTHEIGHT!=null){
        let width=mm(p.INVRECTWIDTH),height=mm(p.INVRECTHEIGHT);
        const pen=obj.width||0;
        if(!ttf && pen>0 && width>pen && height>pen){width-=pen;height-=pen;}
        if(width>0 && height>0){
          const box={text,width,height,size:obj.size,mode:yes(p.USEINVERTEDRECTANGLE)?"frame":obj.justify?"ink":"baseline"};
          if(ttf)Object.assign(box,{family:obj.family,bold:!!obj.bold,italic:!!obj.italic});
          else Object.assign(box,{font:"stroke",strokeFont:obj.strokeFont||"default",strokeWidth:pen});
          if(obj.justify)setWritingOrigin(box,obj,[x,y],!!obj.mirrored);
          obj.sourceTextBox=box;
        }
      }
      if(ttf && yes(p.INVERTED)){obj.inverted=true;if(p.INVERTEDTTTEXTBORDER!=null)obj.margin=mm(p.INVERTEDTTTEXTBORDER);}
      if(/^(TRUE|T)$/i.test(p.DESIGNATOR||p.ISDESIGNATOR))obj.role="designator";
      if(/^(TRUE|T)$/i.test(p.COMMENT||p.ISCOMMENT))obj.role="comment";
    } else if(type==="fill"){
      const a=unitPoint(p,"X1","Y1"),b=unitPoint(p,"X2","Y2");
      obj={kind:"graphic",points:rectPoints(...a,...b,-Number(p.ROTATION||0)),layer:l,closed:true,fill:true,width:.05};
    } else return null;
    if(type==="pad"||type==="via"){
      if(p.TENTINGTOP!=null||p.TENTINGBOTTOM!=null){
        obj.tent={};
        if(p.TENTINGTOP!=null)obj.tent.top=yes(p.TENTINGTOP);
        if(p.TENTINGBOTTOM!=null)obj.tent.bottom=yes(p.TENTINGBOTTOM);
      }
      const top=yes(p.TESTPOINTTOP),bottom=yes(p.TESTPOINTBOTTOM);
      if(top||bottom)obj.fabTestpoint=top&&bottom?"Both":top?"Top":"Bottom";
      if(type==="pad"&&/^(?:false|f|0)$/i.test(p.PLATED||""))obj.plated=false;
    }
    if(["pad","via","track","arc"].includes(type))Object.assign(obj,manualMaskFields(p));
    if(/^(true|t)$/i.test(p.KEEPOUT||"")&&["track","arc","fill"].includes(type)){
      const mask=/^\d+$/.test(p.KEEPOUTRESTRICTIONS?.trim())?Number(p.KEEPOUTRESTRICTIONS):undefined;
      obj=keepoutObject(obj,mask);
    }
    return {owner:p.COMPONENT!=null?Number(p.COMPONENT):noOwner,net:p.NET!=null?Number(p.NET):noOwner,obj,mirrored:type==="text"&&!!obj.mirrored};
  }

  function newPart(params,index) {
    const [x,y]=unitPoint(params);
    const ref=params.SOURCEDESIGNATOR||params.DESIGNATOR||params.NAME||"U"+(index+1);
    const name=params.PATTERN||ref;
    const def={id:A.id(),name,category:"PCB footprints",prefix:ref.match(/^[A-Za-z]+/)?.[0]||"U",value:name,
      footprint:{name,pads:[],shapes:[]}};
    const item={id:A.id(),kind:"part",def:def.id,ref,value:params.SOURCECOMMENT||params.COMMENT||name,
      x,y,angle:-Number(params.ROTATION||0),layer:layer(params.LAYER||"TOP"),link:A.id(),pinNets:{}};
    return {def,item};
  }
  function local(point,item) {return A.rotate([point[0]-item.x,point[1]-item.y],-item.angle);}
  function addToFootprint(part,obj) {
    const {item,def}=part,fp=def.footprint;
    if(obj.kind==="label" && obj.role){
      if(obj.role==="designator" && obj.text && !obj.text.startsWith("."))item.ref=obj.text;
      if(obj.role==="comment" && obj.text && !obj.text.startsWith("."))item.value=obj.text;
      return item;
    }
    if(obj.points){
      const points=obj.points.map(p=>local(p,item));
      let regionShape=obj.regionShape;
      if(regionShape){
        const tr=q=>local(q,item),S=globalThis.AtriumBoardShape;
        const map=c=>S?S.placeContour(c,tr,-item.angle):c.map(s=>s.kind==="line"?{kind:"line",a:tr(s.a),b:tr(s.b)}:{...s,c:tr(s.c),start:s.start+item.angle,end:s.end+item.angle});
        regionShape={version:1,contour:map(regionShape.contour),cutouts:regionShape.cutouts.map(map),sig:globalThis.AtriumBoardShape?.signature(points)};
      }
      fp.shapes.push({kind:"path",points,style:obj.layer==="Silk"?"silk":"body",
        width:obj.width,layer:obj.layer,closed:!!obj.closed,fill:!!obj.fill,net:obj.net,...(obj.arc?{arc:A.transformArc(obj.arc,p=>local(p,item),-item.angle)}:{}),...(obj.cutout?{cutout:true}:{}),...(obj.keepoutRestrictions!=null?{keepoutRestrictions:obj.keepoutRestrictions}:{}),...(regionShape?{regionShape}:{}),...(obj.keepout?{keepout:true}:{}),
        ...(Number.isFinite(obj.maskExpansion)?{maskExpansion:obj.maskExpansion}:{}),
        ...(Number.isFinite(obj.pasteExpansion)?{pasteExpansion:obj.pasteExpansion}:{})});
      return fp.shapes.at(-1);
    }
    const [x,y]=local([obj.x,obj.y],item);
    if(obj.kind==="label"){fp.shapes.push({kind:"text",x,y,text:obj.text,size:obj.size,angle:(obj.angle||0)-item.angle,layer:obj.layer,style:"silk",...styleOf(obj)});return fp.shapes.at(-1);}
    const p=obj.kind==="via"?{...obj,number:"",w:obj.diameter,h:obj.diameter,shape:"round"}:obj;
    fp.pads.push({...p,x,y,angle:(p.angle||0)-item.angle});
    if(p.number && p.net)item.pinNets[p.number]=p.net;
    return fp.pads.at(-1);
  }
  // A body record belongs to the placement, not just the package name. Altium stores
  // its outline and STEP origin in absolute board coordinates even when it has an owner.
  function componentBodies(doc, parts, streams, ascii, notes, inline = null, evidence) {
    const models = new Map(), used = new Map(), payloads = new Map(), counts = {extruded: 0, step: 0, missing: 0, unsupported: 0};
    let total = 0, compressed = 0, vertices = 0;
    for (const dir of inline ? ["library/models", "library/modelsnoembed"] : ["models", "modelsnoembed"]) {
      const meta = records(streams?.get(dir + "/data"));
      for (const [n, p] of meta.entries()) if (p.ID && !models.has(p.ID))
        models.set(p.ID, {file: p.NAME || "", checksum: p.CHECKSUM, stream: dir.endsWith("models") ? dir + "/" + n : ""});
    }
    function asset(id, p) {
      if (used.has(id)) return used.get(id);
      const source = models.get(id), file = String(source?.file || p["WAFFLE.MODELPATH"] || p["MODEL.FILENAME"] || p["MODEL.NAME"] || "").slice(0, 1024);
      const result = {id, file}, cap = 32 * 1048576;
      const checksum = p["MODEL.CHECKSUM"] || source?.checksum;
      if (/^-?\d{1,10}$/.test(checksum) && +checksum >= -2147483648 && +checksum <= 4294967295) result.checksum = Number(checksum) >>> 0;
      const bytes = source?.stream && (streams.modelStream ? streams.modelStream(source.stream, cap) : streams.get(source.stream));
      if (bytes?.length && bytes.length <= cap) {
        // Keep just the referenced compressed streams once. Inflation, Part 21 parsing
        // and tessellation happen on a 3D/export request, including after a native save.
        let encoded;
        if (typeof bytes.toBase64 === "function") encoded = bytes.toBase64();
        else {
          const chunks = [];
          for (let at = 0; at < bytes.length; at += 8192) chunks.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
          encoded = btoa(chunks.join(""));
        }
        if (payloads.has(encoded)) result.assetId = payloads.get(encoded);
        else if (compressed + bytes.length <= 64 * 1048576) {
          compressed += bytes.length; payloads.set(encoded, id); result.zlib = encoded;
        }
      }
      used.set(id, result);
      return result;
    }
    function add(p, owner, rings, layerName, sourceRecord, contour, shapeRecord) {
      const item = parts.get(owner)?.item;
      const here = q => item ? local(q, item) : q;
      const num = k => {const n = Number(p[k] || 0); if (!Number.isFinite(n) || Math.abs(n) > 1e6) throw Error("Invalid body rotation."); return n;};
      const dim = k => {const n = mm(p[k]); if (!Number.isFinite(n) || Math.abs(n) > 1e6) throw Error("Invalid body dimension."); return n;};
      const type = p["MODEL.MODELTYPE"] ?? "0", side = p.BODYPROJECTION === "1" ? "Bottom" : "Top";
      const encoded = p.IDENTIFIER || "", characterCodes = !ascii || p.ISSHAPEBASED != null || encoded.includes(",");
      const identifier = characterCodes && /^\d{1,5}(?:,\d{1,5})*$/.test(encoded) ?
        encoded.split(",").slice(0, 256).map(c => String.fromCharCode(+c)).join("") : encoded.slice(0, 256);
      const body = {type: type === "0" ? "extruded" : type === "1" ? "step" : "unsupported", layer: layerName, side,
        sourceRecord, ownerSide: item?.layer === "Bottom" ? "Bottom" : "Top", rings: rings.map(r => r.map(here)), identifier,
        modelId: String(p.MODELID || p["MODEL.FILENAME"] || sourceRecord).slice(0, 1024),
        at: here([dim("MODEL.2D.X"), -dim("MODEL.2D.Y")]), angle: num("MODEL.2D.ROTATION") + (item?.angle || 0),
        rotation: ["ROTX", "ROTY", "ROTZ"].map(k => num("MODEL.3D." + k)), dz: dim("MODEL.3D.DZ"),
        minZ: dim(p["MODEL.EXTRUDED.MINZ"] != null ? "MODEL.EXTRUDED.MINZ" : "STANDOFFHEIGHT"),
        maxZ: dim(p["MODEL.EXTRUDED.MAXZ"] != null ? "MODEL.EXTRUDED.MAXZ" : "OVERALLHEIGHT")};
      if (shapeRecord) body.shapeRecord = shapeRecord;
      if (contour) body.contour = contour.map(g => g.kind === "line" ? {kind: "line", a: here(g.a), b: here(g.b)} :
        {...g, c: here(g.c), start: g.start + (item?.angle || 0), end: g.end + (item?.angle || 0)});
      if (p.BODYCOLOR3D != null && Number.isInteger(Number(p.BODYCOLOR3D))) body.color = Number(p.BODYCOLOR3D) >>> 0 & 0xffffff;
      if (p.BODYOPACITY3D != null) body.opacity = Math.min(1, Math.max(0, num("BODYOPACITY3D")));
      if (body.type === "step") {
        const a = asset(body.modelId, p);
        if (!a.zlib && !a.assetId) counts.missing++;
      } else if (body.type === "unsupported") body.modelType = type;
      ((item || doc).bodies3d ||= []).push(body);
      counts[body.type]++;
      const mapped = body.type !== "unsupported";
      evidence?.("3D body", sourceRecord, mapped ? "kept" : "approximated", body,
        mapped ? undefined : "Placement and outline retained without an editable model of this type.");
      if (shapeRecord) evidence?.("3D body contour", shapeRecord, "kept", body);
    }
    function checkRing(ring) {
      if (++total > 100000 || (vertices += ring.length) > 1000000 || ring.length < 3 || ring.length > 20000 ||
          !ring.every(p => p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6))) throw Error("Invalid 3D body contour.");
      if (ring.length > 3 && Math.hypot(ring[0][0] - ring.at(-1)[0], ring[0][1] - ring.at(-1)[1]) < 1e-8) ring.pop();
      return ring;
    }
    if (ascii) {
      let index = 0;
      for (const p of ascii) if (/^componentbody$/i.test(p.RECORD)) {
        const rings = [], holes = Number(p.HOLECOUNT || 0);
        if (!Number.isInteger(holes) || holes < 0 || holes > 256) throw Error("Invalid 3D body hole count.");
        for (let h = 0; h <= 256; h++) {
          const nativeHole = h > 0 && h <= holes && p["HOLE" + (h - 1) + "VERTEXCOUNT"] != null;
          const expected = nativeHole ? Number(p["HOLE" + (h - 1) + "VERTEXCOUNT"]) : null;
          if (expected != null && (!Number.isInteger(expected) || expected < 3 || expected > 20000)) throw Error("Invalid 3D body hole size.");
          const prefix = h ? nativeHole ? "H" + (h - 1) : "WAFFLE.HOLE" + h + "." : "", ring = [];
          for (let j = 0; p[prefix + "VX" + j] != null && p[prefix + "VY" + j] != null; j++) {
            if (j >= 20000) throw Error("Too many 3D body vertices.");
            const x = p[prefix + "VX" + j], y = p[prefix + "VY" + j];
            ring.push(nativeHole ? [Number(x)*.00000254, -Number(y)*.00000254] : [mm(x), -mm(y)]);
          }
          if (nativeHole && ring.length !== expected) throw Error("Truncated 3D body hole.");
          if (!ring.length) break;
          rings.push(checkRing(ring));
        }
        const {shape, points} = outline(p);
        if (shape && rings.length) rings[0] = points;
        const record = p["WAFFLE.SOURCERECORD"], twin = p["WAFFLE.SHAPERECORD"];
        const sourceRecord = /^(?:(?:shapebased)?componentbodies6|footprint)\/data#\d{1,6}$/.test(record) ? record : "componentbodies6/data#" + index;
        const shapeRecord = /^shapebasedcomponentbodies6\/data#\d{1,6}$/.test(twin) ? twin : null;
        add(p, p.COMPONENT == null ? noOwner : +p.COMPONENT, rings, layer(p.V7_LAYER || p.LAYER), sourceRecord, shape?.contour, shapeRecord);
        index++;
      }
    } else {
      const flat = [], byBody = new Map();
      function frames(key, extended, entry) {
        const b = entry ? entry.bytes : streams.get(key);
        if (!b?.length) return;
        const v = view(b);
        for (let pos = 0, index = entry?.index || 0; pos < b.length; index++) {
          if (index >= 100000 || pos + 5 > b.length || b[pos] !== 12) throw Error("Invalid ComponentBodies6 frame.");
          const start = pos + 5, end = start + (v.getUint32(pos + 1, true) & 0xffffff);
          if (end > b.length || end - start < 22) throw Error("Truncated ComponentBodies6 record.");
          const cursor = start + 22 + v.getUint32(start + 18, true);
          if (cursor > end) throw Error("Truncated ComponentBodies6 properties.");
          const p = props(decoder.decode(b.subarray(start + 22, cursor))), owner = entry ? entry.owner : v.getUint16(start + 7, true);
          const layerName = layer(p.V7_LAYER || b[start]), sourceRecord = key + "#" + index;
          const signature = JSON.stringify([owner, layerName, p.MODELID, p.IDENTIFIER, p.BODYPROJECTION, p["MODEL.2D.X"], p["MODEL.2D.Y"],
            p["MODEL.2D.ROTATION"], p["MODEL.3D.ROTX"], p["MODEL.3D.ROTY"], p["MODEL.3D.ROTZ"], p["MODEL.3D.DZ"], p.STANDOFFHEIGHT, p.OVERALLHEIGHT]);
          const twin = extended && byBody.get(signature)?.shift();
          pos = end;
          if (twin) twin.shapeRecord = sourceRecord;
          // The flat STEP outline is only metadata. The shape twin can supply
          // exact arcs for an extrusion; it does not constitute a second part.
          if (twin && p["MODEL.MODELTYPE"] === "1" && twin.rings.length) continue;
          const frame = twin || {p, owner, layerName, sourceRecord, rings: []};
          if (!twin) {
            flat.push(frame);
            if (!extended) { if (!byBody.has(signature)) byBody.set(signature, []); byBody.get(signature).push(frame); }
          }
          const holes = v.getUint16(start + 14, true);
          try {
            if (holes > 256 || end - cursor > 4 * 1048576) throw Error("3D body contour exceeds its limit.");
            const {rings, contour} = regionGeometry(b, cursor, end, holes, extended);
            for (const ring of rings) checkRing(ring);
            frame.rings = rings;
            frame.contour = contour;
          } catch (error) {
            if (twin) notes.push("The editable 3D body outline could not be read. Its stored contour was used.");
            else notes.push("A 3D body contour could not be read. " + error.message);
          }
        }
      }
      if (inline) for (const entry of inline) {
        try { frames("footprint/data", false, entry); } catch (error) { notes.push("A library 3D body could not be read. " + error.message); }
      }
      else for (const [key, extended] of [["componentbodies6/data", false], ["shapebasedcomponentbodies6/data", true]]) {
        try { frames(key, extended); } catch (error) { notes.push("3D body records could not be read. " + error.message); }
      }
      for (const f of flat) add(f.p, f.owner, f.rings, f.layerName, f.sourceRecord, f.contour, f.shapeRecord);
    }
    if (counts.step || counts.extruded || counts.unsupported) doc.bodyModelVersion = 1;
    if (used.size) doc.bodyModels = [...used.values()];
    if (counts.step || counts.extruded) notes.push("Imported 3D bodies (" + counts.extruded + " extruded, " + counts.step + " STEP references).");
    if (counts.missing) notes.push(counts.missing + " STEP body reference(s) need a matching project model.");
    if (counts.unsupported) notes.push(counts.unsupported + " body record(s) use an unsupported 3D model type.");
  }
  function read(name,streams,ascii,{appearance=true,drillDrawing=true,textPlacement=2,bodyGeometry=true,legacyArcPaths=false,nativeText=true,fidelity=null}={}) {
    if(textPlacement && textPlacement!==1)textPlacement=2;
    const isLib=/\.pcblib$/i.test(name),doc=A.sheet("pcb",name.replace(/\.[^.]+$/,""));
    // Stable ids (altium-ids.js): UNIQUEIDs and primitive GUIDs, else content; libraries keep fresh ids.
    const I=!isLib&&globalThis.AtriumAltiumIds,ids=I?I.scope(name):null,guids=I&&streams?I.primitiveGuids(streams.get("primitiveguids/data")):new Map(),padIds=I&&streams?I.padIds(streams.get("uniqueidprimitiveinformation/data")):new Map();
    if(ids)doc.id=ids.doc();
    const stableId=(obj,src,uid)=>{
      const [section,index]=String(src||"").replace(/6?\/data#/,"#").split("#"),g=src&&guids.get(section+"#"+index);
      return g?ids.durable("primitive",g):section==="pads"&&padIds.has(+index)?ids.durable("pad",padIds.get(+index)):uid?ids.durable(obj.kind,uid):ids.content(obj.kind,obj);
    };
    doc.sourceName=name;
    const preserveText=appearance && nativeText && textPlacement===2;
    const drawing=appearance && !isLib && streams ? {annotations:{}} : null;
    if(drawing){if(textPlacement)drawing.textPlacement=textPlacement;if(preserveText)drawing.nativeText=true;doc.pcbDrawing=drawing;}
    const counts=new Map(),notes=[],library=[],parts=new Map(),nets=new Map(),zoneIds=[];
    let ruleRefs,libraryRules;
    const report=(key,n=1)=>counts.set(key,(counts.get(key)||0)+n);
    const evidence=fidelity && ((kind,ref,status,target,reason)=>{
      const src={file:name,object:ref};
      if(target)fidelity.track(kind,status,src,target,reason);
      else fidelity.add(kind,status,src,reason);
    });
    // A status that depends on the other selected files (translator-adapters.js decide), else settled now.
    const decided=(kind,ref)=>resolve=>{
      if(!fidelity)return;
      const src={file:name,object:ref};
      if(fidelity.decide)fidelity.decide(kind,src,resolve);
      else{const r=resolve(()=>false);fidelity.add(kind,r.status,src,r.reason);}
    };
    function produced(target,ref){
      if(target&&ref)fidelity?.produced?.("pcb",{file:name,object:ref},target);
    }
    // A binary or text primitive decoder emits exact diagnostics while it consumes that record.
    // Its output may belong to a footprint rather than the board's flat item array.
    function primitive(kind, ref, parse, owner, binaryRef) {
      const warnings=[];
      const row=parse(evidence ? why=>{warnings.push(why);report(why);} : report);
      const target=put(row,owner,binaryRef,ref);
      evidence?.(kind,ref,target?(warnings.length?"approximated":"kept"):"dropped",target,warnings.join(". ") || (target?undefined:"No usable native geometry."));
    }
    let stack=null,mechNames={};
    function readStack(p){
      try{stack=layerStack(p);}catch(error){stack=null;notes.push("The layer stack could not be read: "+error.message);}
      if(stack){
        doc.stackup=stack.stackup;
        if(Object.keys(stack.ruleLayers).length)doc.sourceRuleLayers=stack.ruleLayers;
      }
    }
    function component(p,i,sourceRecord,ref=sourceRecord){
      let heightError=false;
      const part=newPart(p,i);part.def.sourceName=name;
      if(p.HEIGHT!=null&&p.HEIGHT!==""){
        try{
          const h=mm(p.HEIGHT);
          if(!Number.isFinite(h)||h<0)throw Error();
          if(isLib)part.def.footprint.height=h;else part.item.height=h;
        }catch{heightError=true;report("Components with an unreadable height");}
      }
      if(ids){
        const g=guids.get("components#"+i);
        part.item.id=p.UNIQUEID?ids.durable("component",p.UNIQUEID):g?ids.durable("primitive",g):ids.content("part",{...part.item,def:part.def.name});
        part.item.def=part.def.id=ids.def("footprint\u0000"+part.def.name+"\u0000"+part.item.id);
        const sourceId=globalThis.AtriumAltiumIds.sourceLink(p.SOURCEUNIQUEID);
        if(sourceId)part.item.link=part.item.altiumSourceId=sourceId;
        else part.item.link=ids.link("part:"+(p.UNIQUEID||part.item.id));
      }
      if(sourceRecord)part.item.sourceRecord=sourceRecord;
      if(drawing && sourceRecord || preserveText && ascii!=null && !isLib){
        part.showDesignator=!/^(false|0)$/i.test(p.NAMEON||"");
        part.showComment=/^(true|1)$/i.test(p.COMMENTON||"");
        if(ascii!=null && (p.NAMEON!=null||p.COMMENTON!=null))part.item.boardLabels=[];
      }
      parts.set(p.ID!=null?Number(p.ID):i,part);library.push(part.def);if(!isLib)doc.items.push(part.item);
      evidence?.(isLib?"Footprint":"Component",ref,heightError?"approximated":"kept",isLib?part.def:part.item,heightError?"Unreadable component height.":undefined);
      if(!isLib)produced(part.item,ref);
      return part;
    }
    let drillMap=null;
    const unlistedDrills=new Map();
    function put(row,partOverride=null,sourceRecord=null,ref=sourceRecord) {
      if(!row)return;
      const {obj,owner,net}=row;
      if(drillMap && obj.drill>0 && (obj.kind==="pad" || obj.kind==="via")){
        const key=/^(pads|vias)6?\/data#(\d+)$/.exec(sourceRecord||"");
        if(key){
          const index=Number(key[2]),owners=drillMap.owners[key[1]],assigned=owners.get(index);
          if(assigned!==undefined){obj.sourceDrillTool=assigned;owners.delete(index);}
          else{
            // Unlisted source holes remain physical NC geometry without a
            // plotted mark. Snapshot their tool to detect later edits.
            const tool={mark:null,diameter:obj.drill,slot:obj.slotLength||0,plated:obj.plated!==false};
            const id=JSON.stringify(tool);
            if(!unlistedDrills.has(id)){unlistedDrills.set(id,drillMap.tools.length);drillMap.tools.push(tool);}
            obj.sourceDrillTool=unlistedDrills.get(id);
            const original=drillMap.tools[obj.sourceDrillTool];original.hits=(original.hits||0)+1;
          }
        }
      }
      if(net!==noOwner && net>=0)obj.net=nets.get(net)||("Net "+net);
      else obj.net=row.pourNet||"";
      // Tracks and arcs of a converted pour (hatched pours, and solid pours of
      // old Altium versions, are drawn with them): a repour replaces them.
      const sourcePour=row.pourId??(row.polygon!=null&&row.polygon!==noOwner?zoneIds[row.polygon]:null);
      if(sourcePour&&obj.kind==="track")obj.sourcePour=sourcePour;
      const part=partOverride||parts.get(owner);
      if(part){
        if(obj.sourceTextBox && /^\.(?:designator|comment)$/i.test(obj.text))
          obj.sourceTextBox.text=/^\.designator$/i.test(obj.text)?part.item.ref:part.item.value;
        if(obj.role && obj.size>0 && (drawing && part.item.sourceRecord || preserveText && ascii!=null && !isLib)){
          const visible=obj.role==="comment"?part.showComment:part.showDesignator;
          if(visible || preserveText){
            const rows=!visible?(part.item.hiddenBoardLabels||=[]):drawing?(drawing.annotations[part.item.sourceRecord]||=[]):(part.item.boardLabels||=[]);
            const at=local([obj.x,obj.y],part.item).map(n=>Number(n.toFixed(8)));
            rows.push({field:obj.role==="comment"?"value":"ref",at,angle:obj.angle-part.item.angle,
              size:obj.size,layer:obj.layer,...styleOf(obj),mirrored:!!row.mirrored});
          }
        }
        return addToFootprint(part,obj);
      }
      if(!isLib){
        const item={id:ids?stableId(obj,sourceRecord,row.uid):A.id(),...obj,...(sourceRecord?{sourceRecord}:{})};
        doc.items.push(item);produced(item,ref);return item;
      }
    }
    if(ascii!=null){
      const data=ascii.split(/\r\n|\r|\n/).filter(s=>/(^|\|)\s*RECORD\s*=/i.test(s)).map(props);
      const indices=fidelity?new Map(data.map((p,i)=>[p,i])):null;
      const at=p=>indices?"ASCII record#"+indices.get(p):null;
      if(!data.some(p=>/^(board|component|library)$/i.test(p.RECORD)))throw Error("Unrecognised ASCII PCB file.");
      if(fidelity)ruleRefs=[];
      const ruleLines=asciiRuleRecords(ascii,fidelity && ((line,status)=>{
        const ref="line "+line;
        if(status==="selected")ruleRefs.push(ref);
        else if(status==="mirror")evidence("Compatibility rule mirror",ref,"dropped",null,"The matching DXPRule supplies this rule’s active scope and settings.");
        else evidence("Design rule",ref,"dropped",null,"The rule record has no RULEKIND.");
      }));
      if(ruleLines.length)doc.sourceRules=ruleLines;
      // Net classes, pair classes and pairs (signals.js reads them as tags and signals; altium-rules.js classes()).
      const classLines=isLib?[]:ascii.split(/\r\n|\r|\n/).filter(s=>/(?:^|\|)RECORD=(?:Class|DifferentialPair)(?:\||$)/i.test(s)).map(s=>s.replace(/^\|/,""));
      // Designer spreads one board's properties across multiple Board records.
      const boardFields=Object.create(null);
      for(const p of data)if(p.RECORD?.toLowerCase()==="board")Object.assign(boardFields,p);
      if(boardFields.RECORD){
        setBoardGeometry(doc,boardFields,false,true);
        if(!isLib){readStack(boardFields);mechNames=mechanicalNames(boardFields);classLines.push(...pinPairLines(boardFields));}
      }
      let compIndex=0,netIndex=0;
      for(const p of data){
        const t=p.RECORD?.toLowerCase();
        if(t==="component")component(p,compIndex++,null,at(p));
        if(t==="board")evidence?.("Board settings",at(p),"approximated",null,"Board outline, origin and supported stack settings translated.");
        if(t==="library")evidence?.("Library metadata",at(p),"approximated",null,"Library entries are imported separately.");
        if(t==="differentialpair")evidence?.("Differential pair",at(p),isLib?"dropped":"kept",null,isLib?"Class has no editable native membership.":undefined);
        if(t==="class"){
          if(isLib)evidence?.("Class",at(p),"dropped",null,"Class has no editable native membership.");
          else boardClass(doc,p,/^(0|6|10)$/,evidence&&((status,reason)=>evidence("Class",at(p),status,null,reason)),decided("Class",at(p)));
        }
        if(t==="net")evidence?.("Net",at(p),"kept");
        if(t==="net"){nets.set(p.ID!=null?Number(p.ID):netIndex,p.NAME||"Net "+netIndex);netIndex++;}
      }
      const asciiZones=new Map(),stored=[],damaged=new Set(),fillSources=fidelity?new Map():null;
      let ordinal=0;
      for(const p of data.filter(p=>p.RECORD?.toLowerCase()==="polygon"&&!isLib)){
        const q=polygon(p,{toLayer:layer,netName:n=>nets.get(n)||"",planes:stack?.planes});
        const id=q?(ids?(p.UNIQUEID?ids.durable("polygon",p.UNIQUEID):ids.content("polygon",q)):A.id()):null;
        const zone=q?{id,...q}:null;
        if(zone){doc.items.push(zone);produced(zone,at(p));evidence?.("Polygon pour",at(p),"kept",zone);}
        else{report("Omitted polygon");evidence?.("Polygon pour",at(p),"dropped",null,"Non-copper or invalid polygon.");}
        const key=p.ID!=null?Number(p.ID):ordinal;
        if(Number.isSafeInteger(key)&&key>=0&&key<noOwner){
          if(asciiZones.has(key)){asciiZones.set(key,null);report("Duplicate polygon index");}
          else asciiZones.set(key,zone);
        }
        ordinal++;
      }
      for(const p of data){
        const t=p.RECORD?.toLowerCase();if(!t||["board","component","net","library","rule","dxprule","class","differentialpair","polygon","componentbody"].includes(t))continue;
        const owned=p.POLYGON!=null&&+p.POLYGON!==noOwner&&+p.POLYGON!==-1;
        const zone=owned?asciiZones.get(+p.POLYGON):null;
        if(["pad","arc","track","fill","text","via"].includes(t)){
          if(owned&&(!zone||zone.shelved||zone.cutout)){
            report("Omitted primitive with unavailable polygon owner");
            evidence?.(t[0].toUpperCase()+t.slice(1),at(p),"dropped",null,"Polygon owner is unavailable, shelved or a cutout.");
            continue;
          }
          primitive(t[0].toUpperCase()+t.slice(1),at(p),warn=>{
            const row=asciiObject(p,warn);
            if(row){row.uid=p.UNIQUEID;if(zone){row.pourId=zone.id;row.pourNet=zone.net;}}
            return row;
          },null,null);
        }
        else if(t==="region"){
          const l=layer(p.V7_LAYER||p.LAYER),kind=regionKind(p,l,truth(p.KEEPOUT));
          if(owned&&(!zone||!appearance||!globalThis.AtriumPCBPours||kind!=="region"||zone.layer!==l||zone.shelved||zone.cutout||
              zone.powerPlane||zone.fillMode==="hatched"||zone.fillMode==="outline"||p.COMPONENT!=null&&![-1,noOwner].includes(+p.COMPONENT))){
            if(zone)damaged.add(zone.id);
            report("Omitted unsupported polygon-owned region");
            evidence?.("Stored fill region",at(p),"dropped",null,"Unsupported region or incompatible polygon owner.");
            continue;
          }
          if(!["board cutout","polygon cutout","keepout","region"].includes(kind)){
            report("Omitted region ("+kind+")");evidence?.("Region",at(p),"dropped",null,"Unsupported region "+kind);continue;
          }
          try{
            const g=asciiRegion(p);
            if(owned){
              const si=Number(p.SUBPOLYINDEX);
              if(!Number.isInteger(si)||si<0)throw Error("Invalid polygon island index.");
              const island=AtriumPCBPours.region(g.nativeRings||g.rings,l,zone.net,{polygon:zone.id,subPolygonIndex:si,source:"altium",links:[]},!!g.nativeRings);
              stored.push(island);
              if(fillSources)fillSources.set(island,at(p));
            }else{
              let target;
              if(kind==="board cutout")addBoardCutout(doc,g);
              else target=put({obj:regionItem(kind,l,g,p),owner:p.COMPONENT!=null?Number(p.COMPONENT):noOwner,net:p.NET!=null?Number(p.NET):noOwner,uid:p.UNIQUEID},null,null,at(p));
              evidence?.("Region",at(p),"kept",target);
            }
          }catch(error){
            if(owned&&zone)damaged.add(zone.id);
            report("Unreadable "+kind+": "+error.message);
            evidence?.(owned?"Stored fill region":"Region",at(p),"dropped",null,error.message);
          }
        }
        else {report("Omitted "+t);evidence?.("Unsupported PCB record",at(p),"dropped",null,"Unsupported PCB record "+String(p.RECORD).slice(0,60)+".");}
      }
      const complete=stored.filter(r=>!damaged.has(r.polygon));
      if(fillSources)for(const [island,ref] of fillSources){
        const missing=damaged.has(island.polygon);
        evidence("Stored fill region",ref,missing?"dropped":"kept",null,missing?"The polygon has incomplete stored copper.":undefined);
      }
      if(complete.length){
        const d=doc.pcbDrawing||={annotations:{}};d.pours=complete;d.sourceFill=true;
        notes.push(complete.length+" stored polygon fill region(s) kept as the pours' current copper.");
      }
      if(bodyGeometry)componentBodies(doc,parts,null,data,notes,null,evidence);
      if(!isLib)keepClasses(doc,classLines,notes);
    }else if(isLib){
      const inline = [];
      const roots=[...streams.keys()].filter(p=>/^[^/]+\/parameters$/.test(p)).map(p=>p.split("/")[0]);
      for(const key of streams.keys()){
        const m=/^([^/]+)\/data$/.exec(key);
        if(m && m[1]!=="library" && !roots.includes(m[1]) && streams.get(key)?.[4]!==124 && streams.has(m[1]+"/header"))roots.push(m[1]);
      }
      const ruleRoot=["rules6","rules"].find(root=>!streams.has(root+"/parameters")&&streams.has(root+"/data"));
      const ruleBytes=ruleRoot&&streams.get(ruleRoot+"/data");
      if(ruleBytes?.length&&globalThis.AtriumAltiumRules){
        try{
          doc.sourceRules=AtriumAltiumRules.binary(ruleBytes);
          if(fidelity)ruleRefs=doc.sourceRules.map((_,i)=>ruleRoot+"/data#"+i);
        }catch(error){
          notes.push("Library design rules could not be read. "+error.message);
          evidence?.("Design rule stream",ruleRoot+"/data","dropped",null,error.message);
        }
      }
      for(const root of roots){
        if(root===ruleRoot)continue;
        const bytes=streams.get(root+"/data");
        if(!bytes?.length)continue;
        const c={i:0},fpName=shortString(block(bytes,c));
        if(!fpName || /[\x00-\x1f]/.test(fpName))continue;
        const parameters=records(streams.get(root+"/parameters"))[0]||{};
        const owner = parameters.ID == null ? parts.size : Number(parameters.ID);
        const part=component({...parameters,PATTERN:parameters.PATTERN||fpName},parts.size,null,root+"/parameters");
        for(let index=0;c.i<bytes.length;index++){
          if(bodyGeometry && bytes[c.i]===12){
            const start=c.i++; block(bytes,c);
            inline.push({owner,index,bytes:bytes.subarray(start,c.i)});
          }else {
            const type=bytes[c.i],name=["","Arc","Pad","Via","Track","Text","Fill"][type] || (type===11?"Region":"3D body");
            primitive(name,root+"/data#"+index,warn=>binaryObject(bytes,c,warn,appearance&&textPlacement,false,preserveText),part,null);
          }
        }
      }
      if(!library.length)throw Error("No supported footprint streams found in "+name);
      if(inline.length)componentBodies(doc,parts,streams,null,notes,inline,evidence);
    }else{
      const get=(dir,leaf="data")=>streams.get(dir+"6/"+leaf)||streams.get(dir+"/"+leaf);
      if(!get("board")?.length)throw Error("The Board6 geometry stream is missing from "+name);
      const board=records(get("board"))[0];setBoardGeometry(doc,board,legacyArcPaths);
      if(doc.boardShape&&!legacyArcPaths)doc.sourceArcVersion=1;
      readStack(board);mechNames=mechanicalNames(board);
      if(!doc.outline.length)notes.push("No editable board perimeter was present in the Board6 record.");
      const dataPath=key=>streams.has(key+"6/data")?key+"6/data":key+"/data";
      evidence?.("Board settings",dataPath("board")+"#0","approximated",null,"Board geometry, layer stack and supported settings translated.");
      netNames(streams).forEach((net,i)=>{nets.set(i,net);evidence?.("Net",dataPath("nets")+"#"+i,"kept");});
      if(drillDrawing && board.DRILLSYMBOLASENUM==="0"){
        try{drillMap=drillManager(get("drillmanager"));}catch{ /* Unknown framing keeps the native drill drawing. */ }
      }
      records(get("components")).forEach((p,i)=>component(p,i,dataPath("components")+"#"+i));
      // Polygons6: each copper pour becomes a Waffle polygon pour (outline,
      // net, pour order, island removal, hatch). Its stored Regions6 islands
      // become that pour's current copper (tagged region.polygon), so the board
      // looks as Altium left it and connectivity counts it; the pour engine
      // links each island to the copper it touches when the board is first
      // inspected (AtriumPolygonPour.adopt). A repour regenerates the fill.
      const zones=get("polygons")?.length?records(get("polygons")):[];
      const artworkZones=new Map();
      let converted=0,hatched=0,necks=0;
      if(!isLib)zones.forEach((p,i)=>{
        const src=dataPath("polygons")+"#"+i, film=layer(p.LAYER);
        // Altium also stores solid silkscreen polygons as generated regions.
        // Their faces are editable artwork rather than electrical pours.
        if(drawing&&["Silk","Bottom silk"].includes(film)&&/^polygon$/i.test(p.POLYGONTYPE||"Polygon")&&
            /^solid$/i.test(p.HATCHSTYLE||"")&&!truth(p.SHELVED)&&!truth(p.KEEPOUT)){
          artworkZones.set(i,{src,film,regions:0});
          return;
        }
        let item=null;
        try{item=polygon(p,{toLayer:layer,netName:n=>nets.get(n)||"",planes:stack?.planes,binary:true});}catch{item=null;}
        if(!item){evidence?.("Polygon pour",src,"dropped",null,"Non-copper or invalid polygon.");return;}
        item={id:ids?stableId(item,src,p.UNIQUEID):A.id(),sourceRecord:src,...item};zoneIds[i]=item.id;doc.items.push(item);converted++;
        produced(item,src);evidence?.("Polygon pour",src,"kept",item);
        if(item.fillMode==="hatched")hatched++;
        if(/^(true|1)$/i.test(p.REMOVENECKS||""))necks++;
      });
      if(converted){
        notes.push(converted+" polygon pour"+(converted===1?"":"s")+" imported as editable Waffle pours (outline, net, pour order, island removal"+(hatched?", hatch":"")+"). Clearance and connect style come from the design rules.");
        if(necks)notes.push(necks+" pour"+(necks===1?"":"s")+" set Altium's Remove Necks option; a repour removes the necks narrower than its width.");
      }
      if(zones.length>converted+artworkZones.size)notes.push((zones.length-converted-artworkZones.size)+" unsupported polygon record(s) omitted.");
      let letters=null,typefaces,missingFontOutlines=0;
      const letterData=streams.get("lettersgeometry/data");
      if(drawing && textPlacement===2 && letterData?.length){
        try{letters=lettering(letterData);drawing.letterSets=letters.sets;}
        catch(error){notes.push("Saved letter outlines unavailable. "+error.message);}
      }
      // Manual openings on a copper track or arc are indexed by its row in
      // Tracks6/Arcs6. Zero opens the exact copper stroke. None leaves it covered.
      const traceMasks={tracks:new Map(),arcs:new Map()};
      try{
        for(const p of records(get("extendedprimitiveinformation"))){
          const key=/^track$/i.test(p.PRIMITIVEOBJECTID)?"tracks":/^arc$/i.test(p.PRIMITIVEOBJECTID)?"arcs":null;
          if(!key || !/^mask$/i.test(p.TYPE) || !/^\d+$/.test(p.PRIMITIVEINDEX))continue;
          const fields=manualMaskFields(p);
          if(Object.keys(fields).length)traceMasks[key].set(+p.PRIMITIVEINDEX,fields);
        }
      }catch(error){notes.push("Extended track mask settings unavailable. "+error.message);}
      const binaryTypes={tracks:4,arcs:1,pads:2,vias:3,fills:6,texts:5};
      for(const [key,type] of Object.entries(binaryTypes)){
        // Only the current text stream uses the Texts6 object layout.
        const bytes=key==="texts"?streams.get("texts6/data"):get(key);
        if(!bytes?.length)continue;
        const keepoutExtension=streams.has(key+"6/data");
        if(type===1&&!legacyArcPaths)doc.sourceArcVersion=1;
        let index=0;
        const c={i:0};while(c.i<bytes.length){
          if(bytes[c.i]!==type)throw Error("Unexpected record in "+key+" at byte "+c.i);
          const src=dataPath(key)+"#"+index;
          const warnings=[];
          const row=binaryObject(bytes,c,evidence?why=>{warnings.push(why);report(why);}:report,appearance&&textPlacement,legacyArcPaths,preserveText,keepoutExtension);
          const missingBefore=missingFontOutlines;
          const mask=traceMasks[key]?.get(index);
          if(mask && row)Object.assign(row.obj,mask);
          const group=key==="texts" && row?.obj.font==="truetype" ? letters?.owners.get(index) : null;
          if(group!=null && row.obj.sourceTextBox)row.obj.sourceTextBox.letterSet=group;
          else if(drawing && textPlacement===2 && row?.obj.font==="truetype" && !row.obj.sourceTextBox){
            try{
              if(typefaces===undefined)typefaces=globalThis.AtriumAltiumTypefaces?.open(streams.get("embeddedfonts6/data"),drawing,encodedLetters)||null;
              const text=row.obj.text,part=parts.get(row.owner)?.item;
              const value=part && /^\.(designator|comment)$/i.test(text)?(/^\.designator$/i.test(text)?part.ref:part.value):text;
              const box=typefaces?.(row.obj,value);
              if(box)row.obj.sourceTextBox=box;else missingFontOutlines++;
            }catch{missingFontOutlines++;}
          }
          const target=put(row,null,src);index++;
          if(missingBefore!==missingFontOutlines)warnings.push("Text uses a substitute font.");
          const label={tracks:"Track",arcs:"Arc",pads:"Pad",vias:"Via",fills:"Fill",texts:"Text"}[key];
          evidence?.(label,src,target?(warnings.length?"approximated":"kept"):"dropped",target,warnings.join(". ")||undefined);
        }
      }
      if(missingFontOutlines)notes.push(missingFontOutlines+" older TrueType string(s) have no usable embedded outlines; these use the available system font.");
      const mapped=new Set(["board","nets","components",...Object.keys(binaryTypes)]);
      if(bodyGeometry && (streams.get("componentbodies6/data")?.length || streams.get("shapebasedcomponentbodies6/data")?.length)){
        componentBodies(doc,parts,streams,null,notes,null,evidence);
        for(const section of ["componentbodies","shapebasedcomponentbodies","models","modelsnoembed"])mapped.add(section);
      }
      if(drillMap && !drillMap.owners.pads.size && !drillMap.owners.vias.size){
        doc.sourceDrillDrawing={tools:drillMap.tools};mapped.add("drillmanager");
      }else if(drillMap){
        // A stale index invalidates the membership table as a whole.
        for(const obj of doc.items)delete obj.sourceDrillTool;
        for(const def of library)for(const obj of def.footprint?.pads||[])delete obj.sourceDrillTool;
      }
      if(converted)mapped.add("polygons");
      const raw=get("regions"),authored=get("shapebasedregions");
      if(raw?.length||authored?.length){
        const damaged=key=>(i,why)=>evidence?.("Region",dataPath(key)+"#"+i,"dropped",null,why);
        const flats=regionRecords(raw,false,report,damaged("regions")),shapes=regionRecords(authored,true,report,damaged("shapebasedregions"));
        const byLayer=new Map(),stored=[],fillSources=[];let free=0,boards=0,cutouts=0,keepouts=0,pairs=0;
        let complete=!!(raw?.length&&!flats.damaged || authored?.length&&!shapes.damaged);
        for(const {flat,shape} of pairedRegions(flats.rows,shapes.rows)){
          const r=flat||shape,{p,net,owner,poly}=r;
          if(flat&&shape)pairs++;
          const kind=regionKind(p,r.layer,r.keep);
          const ref=dataPath(flat?"regions":"shapebasedregions")+"#"+r.index;
          if(flat&&shape)evidence?.("Region contour",dataPath("shapebasedregions")+"#"+shape.index,"kept",null,"Matched to the stored region from this source record.");
          const artwork=artworkZones.get(poly), overlay=artwork&&kind==="region"&&r.layer===artwork.film&&owner===noOwner&&net===noOwner&&
            /^\d+$/.test(p.SUBPOLYINDEX||"");
          if(poly!==noOwner&&!overlay){
            if(kind==="region"&&drawing&&zones.length&&globalThis.AtriumPCBPours){
              try{
                const {regions}=AtriumPCBPours.read(r.bytes.subarray(r.at,r.end),zones,nets,layer,props,zoneIds,r.extended);
                if(regions.length){fillSources.push(ref);for(const island of regions){island.source="altium";stored.push(island);}continue;}
              }catch(error){complete=false;report("Unreadable stored polygon fill: "+error.message);evidence?.("Stored fill region",ref,"dropped",null,error.message);continue;}
            }
            report("Other polygon-owned regions omitted");evidence?.("Stored fill region",ref,"dropped",null,"Unsupported polygon-owned region.");continue;
          }
          if(!["board cutout","polygon cutout","keepout","region"].includes(kind)){report("Omitted region ("+kind+")");evidence?.("Region",ref,"dropped",null,"Unsupported region "+kind);continue;}
          if(kind==="region"&&(r.layer==="Multi"||/^Layer \d+$/.test(r.layer))){report("Omitted region on "+r.layer);evidence?.("Region",ref,"dropped",null,"Unsupported layer "+r.layer);continue;}
          try{
            // Stored fills and other tessellated artwork keep their native double precision.
            // Authored regions prefer actual arcs. An older file may have only one stream.
            const preferred=shape&&(!flat||truth(p.ISSHAPEBASED)||shape.curved||kind==="board cutout")?shape:r;
            let g,warning;
            try{g=regionGeometry(preferred.bytes,preferred.start,preferred.end,preferred.holes,preferred.extended);}
            catch(error){
              if(!flat||preferred===flat)throw error;
              g=regionGeometry(flat.bytes,flat.start,flat.end,flat.holes,false);
              warning="Region used its stored tessellation: "+error.message;report(warning);
            }
            if(kind==="board cutout"){addBoardCutout(doc,g);boards++;evidence?.("Region",ref,warning?"approximated":"kept",null,warning);continue;}
            const obj=regionItem(kind,r.layer,g,p);
            const target=put({obj,owner,net},null,ref);evidence?.(overlay?"Silkscreen polygon region":"Region",ref,warning?"approximated":"kept",target,warning);
            if(kind==="polygon cutout")cutouts++;
            else if(kind==="keepout")keepouts++;
            else if(overlay)artwork.regions++;
            else {free++;byLayer.set(r.layer,(byLayer.get(r.layer)||0)+1);}
          }catch(error){report("Unreadable "+kind+": "+error.message);evidence?.("Region",ref,"dropped",null,error.message);}
        }
        for(const ref of fillSources)evidence?.("Stored fill region",ref,complete?"kept":"dropped",null,complete?undefined:"Incomplete stored copper was discarded.");
        if(stored.length&&complete){
          drawing.pours=stored;mapped.add("polygons");
          const tagged=stored.filter(r=>r.polygon!=null).length;
          if(tagged)drawing.sourceFill=true;
          notes.push(stored.length+" stored polygon fill region(s) kept as the pours' current copper"+(tagged<stored.length?" ("+(stored.length-tagged)+" read-only)":"")+". They count for connectivity until a repour regenerates them.");
        }
        if(free)notes.push(free+" free region(s) imported as filled shapes ("+[...byLayer].map(([l,n])=>l+" "+n).join(", ")+").");
        if(boards)notes.push(boards+" board cutout"+(boards===1?"":"s")+" imported.");
        if(cutouts)notes.push(cutouts+" polygon cutout(s) imported.");
        if(keepouts)notes.push(keepouts+" keepout region(s) imported.");
        if(pairs)notes.push(pairs+" paired region record(s) reconciled with their shape-based contours.");
        if(raw?.length)mapped.add("regions");
        if(authored?.length)mapped.add("shapebasedregions");
      }
      let retainedArtwork=0;
      for(const {src,regions} of artworkZones.values()){
        retainedArtwork+=regions;
        evidence?.("Silkscreen polygon",src,regions?"approximated":"dropped",null,
          regions?"Stored fill imported as editable artwork.":"No compatible stored fill was present.");
      }
      if(retainedArtwork)notes.push(retainedArtwork+" stored silkscreen polygon region(s) imported as artwork.");
      const ruleData=streams.get("rules6/data");
      if(ruleData?.length && globalThis.AtriumAltiumRules){
        try{
          const kinds=[];
          doc.sourceRules=AtriumAltiumRules.binary(ruleData,kinds);mapped.add("rules");
          if(fidelity)ruleRefs=doc.sourceRules.map((_,i)=>"rules6/data#"+i);
          const checkStream="design rule checker options6/data", options=streams.get(checkStream);
          if(options?.length){
            const decoded=AtriumAltiumRules.checkOptions(options,kinds,doc.sourceRules);
            if(decoded){doc.sourceRuleChecks=decoded;mapped.add("design rule checker options");}
            else notes.push("Altium batch and online check selections could not be read. Waffle uses its existing check settings.");
            evidence?.("Rule check settings",checkStream,decoded?"approximated":"dropped",null,decoded
              ?"Batch and online selections are projected for native checks. Additional report settings remain in the original document."
              :"The source check settings do not reliably identify a batch and online selection.");
          }
        }catch(error){
          notes.push("Rule records could not be read: "+error.message);
          evidence?.("Design rule stream","rules6/data","dropped",null,error.message);
        }
      }
      // Net classes (Classes6 KIND 0), pair classes (KIND 6), xSignal classes (SignalClasses KIND 10), pairs
      // (DifferentialPairs6) and xSignals (Board6 PINPAIR*) as text records (doc.sourceClasses);
      // docs/design/altium-pairs-xsignals-format.md. A non-empty PinPairsSection (unseen so far) is reported.
      const classLines=pinPairLines(board);let otherClasses=0;
      for(const {stream,record,kinds} of [{stream:"classes6/data",record:"Class",kinds:/^(0|6)$/},{stream:"signalclasses/data",record:"Class",kinds:/^10$/},{stream:"differentialpairs6/data",record:"DifferentialPair",kinds:null}]){
        const bytes=streams.get(stream);if(!bytes?.length)continue;
        try{
          const c={i:0};let index=0;
          while(c.i<bytes.length){const src=stream+"#"+index++;const b=block(bytes,c);if(!b.length)continue;
            const line=AtriumAltiumRecords.textLine(b,true);
            const p=props(line);
            // Every class record stays as source data, so rule conversion can tell a class that exists (a
            // superclass, or a pad, layer or polygon class with no native model yet) from one that matches nothing.
            if(kinds){
              if(!truth(p.SUPERCLASS)&&!kinds.test(p.KIND||"")&&p.KIND!=="1")otherClasses++;
              if(!isLib)boardClass(doc,p,kinds,evidence&&((status,reason)=>evidence("Class",src,status,null,reason)),decided("Class",src));
            }else evidence?.("Differential pair",src,"kept");
            classLines.push("RECORD="+record+"|"+line.replace(/(?:^|\|)RECORD=[^|]*/i,"").replace(/^\|/,""));
          }
          mapped.add(stream.replace(/6?\/data$/,""));
        }catch(error){notes.push("Class records could not be read: "+error.message);}
      }
      if(!isLib)keepClasses(doc,classLines,notes);
      if(otherClasses)notes.push("Omitted "+otherClasses+" other class(es) (pad, layer, polygon, from-to).");
      if(streams.get("pinpairssection/data")?.length)notes.push("PinPairsSection records were not read (their layout is not known); xSignals come from the board record.");
      mapped.add("pinpairssection");
      for(const [key,bytes] of streams.entries()){
        if(!bytes?.length)continue;
        const m=/^([^/]+)\/data$/.exec(key);if(!m)continue;
        const section=m[1].replace(/6$/,"");
        if(mapped.has(section))continue;
        const header=streams.get(m[1]+"/header");
        const count=header?.length===4?view(header).getUint32(0,true):null;
        if(count!==0){
          notes.push("Omitted "+m[1]+(count!=null?" ("+count+")":"")+".");
          // Unknown framing cannot prove what an untrusted count word claims. Preserve every byte
          // and identify the actual opaque stream instead of manufacturing per-record references.
          const partial=["lettersgeometry","embeddedfonts","extendedprimitiveinformation","primitiveguids","uniqueidprimitiveinformation"].includes(section);
          evidence?.("Compound stream",key,partial?"approximated":"dropped",null,
            partial?"Only supported appearance or identity fields are projected.":"Untranslated stream retained in original input"+(count!=null?" (declared count "+count+")":"")+".");
        }
      }
    }
    if(doc.sourceRules?.length){
      if(isLib){
        for(const [i,line] of doc.sourceRules.entries()){
          const prefix="Library "+name+" · Design rule retained with the library. No board scope is defined.";
          if(fidelity)(libraryRules ||= []).push({note:notes.length,source:ruleRefs[i],prefix,text:line});
          notes.push(prefix+" "+line);
          evidence?.("Design rule",ruleRefs?.[i],"dropped",null,"A standalone footprint library has no board scope. The selected source retains the rule.");
        }
      }else edgeClearance(doc,doc.sourceRules);
    }
    if(!isLib)planeSettings(doc,notes);
    if(stack){
      const keys={...stack.keys,...stack.planes};
      for(const [plane,physical] of Object.entries(stack.planes))keys["Layer "+(38+Number(plane.slice(5)))]=physical;
      renumber(doc,library,keys,new Set(Object.keys(keys).filter(k=>/^PLANE|^Layer /.test(k))));
      if(Object.keys(stack.keys).length)notes.push("Mid layers were renumbered to their stack order: "+Object.entries(stack.keys).map(([a,b])=>a+" → "+b).join(", ")+".");
    }
    if(!isLib)layerNames(doc,library,mechNames);
    // An Altium hatch can be stored entirely as source-owned tracks and arcs.
    if(!isLib&&appearance&&globalThis.AtriumPCBPours&&doc.items.some(i=>i.sourcePour!=null)){
      (doc.pcbDrawing||={annotations:{}}).sourceFill=true;
    }
    if(doc.pcbDrawing?.pours||doc.pcbDrawing?.sourceFill)AtriumPCBPours.storeSignature(doc,new Map(library.map(d=>[d.id,d])));
    if(isLib){
      const assets = new Map((doc.bodyModels || []).map(a => [a.id, a]));
      for(const {item, def} of parts.values()){
        def.prefix="U";
        if(!item.bodies3d?.length)continue;
        const fp=def.footprint;
        fp.bodyModelVersion=1; fp.bodies3d=item.bodies3d;
        // A saved or copied footprint carries just its own usable assets. Repeated
        // placements share the definition; a GUID alias also needs its canonical bytes.
        const used=new Set();
        for(const body of fp.bodies3d){
          const asset=assets.get(body.modelId);
          if(asset){if(asset.assetId)used.add(assets.get(asset.assetId));used.add(asset);}
        }
        if(used.size)fp.bodyModels=[...used];
      }
    }
    for(const [label,n] of counts)notes.push(label+" ("+n+").");
    notes.push((doc.bodyModelVersion ? "PCB import includes 3D bodies. " : "PCB import projects 2D geometry. ") + "Layer-specific pad stacks, pours and manufacturing settings require review in the source design.");
    doc.notes=notes.slice();
    return {documents:isLib?[]:[doc],library,notes,...(ruleRefs ? {ruleRefs} : {}),...(libraryRules ? {libraryRules} : {})};
  }
  function netNames(streams){
    return records(streams.get("nets6/data")||streams.get("nets/data")).map((p,i)=>p.NAME||"Net "+i);
  }
  return {read,asciiRuleRecords,netNames,polygon,outline,regionGeometry,drillPlots,gerberPlots,addProfileJobs,settleComponentClasses};
})();
