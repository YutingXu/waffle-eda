"use strict";
if (!globalThis.AtriumAltiumRecords) { if (typeof importScripts === "function" && !globalThis.AtriumEmbeddedTranslatorScripts) importScripts("../formats/altium-records.js"); else if (typeof require === "function") require("./altium-records.js"); }
globalThis.AtriumSCH = (() => {
  const A = Atrium;
  const legacy = new TextDecoder("windows-1252");
  const numeric = (v, fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const isTrue = v => /^(T|true|1)$/i.test(v || "");
  function mm(r, key) {
    const whole = numeric(r[key]), frac = numeric(r[key + "_FRAC"]);
    // Native ticks are 127/50 nm. Combine the signed fields before conversion so
    // the 2.0 import binding records the source decimal, including at midpoint ties.
    const ticks = whole * 100000 + frac;
    if (Number.isInteger(whole) && Number.isInteger(frac) && Number.isSafeInteger(ticks * 127)) return ticks * 127 / 50000000;
    return whole * .254 + frac * .00000254;
  }
  const at = (r,stem="LOCATION") => [mm(r,stem+".X"),-mm(r,stem+".Y")];
  const xy = ([x,y]) => ({x,y});
  const delta = (a,b) => [a[0]-b[0],a[1]-b[1]];
  const path = (points,closed=false,fill=false) => ({kind:"path",style:"body",points,closed,fill});
  const KINDS=[null,"mechanical","graphical","netTie","netTieNoBom","standardNoBom","jumper"];
  const KIND_NAMES={mechanical:"mechanical",graphical:"graphical",netTie:"net tie",netTieNoBom:"net tie (no BOM)",standardNoBom:"standard (no BOM)",jumper:"jumper"};
  const recordNames={3:"IEEE symbols",5:"Bézier curves",7:"polygons",9:"pie charts",10:"rounded rectangles",11:"elliptical arcs",15:"hierarchical sheet symbols",16:"sheet entries",18:"ports",22:"No ERC markers",26:"buses",28:"text frames",30:"embedded images",32:"sheet names",33:"sheet filenames",37:"bus entries",39:"sheet templates",43:"parameter sets",45:"models",209:"notes",211:"compile masks",215:"harness connectors",216:"harness entries",217:"harness types",218:"signal harnesses",225:"blankets"};
  function properties(text) { return AtriumAltiumRecords.properties(text, true, false); }
  function binaryPin(bytes) {
    const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const fail=()=>{throw Error("Invalid binary pin record.");};
    if(bytes.length<26 || d.getInt32(0,true)!==2)fail();
    let p=12;
    function string(){
      if(p>=bytes.length)fail();
      const end=p+1+bytes[p];if(end>bytes.length)fail();
      const value=legacy.decode(bytes.subarray(p+1,end));p=end;return value;
    }
    string(); // Optional description precedes all pin geometry.
    if(p+13>bytes.length)fail();
    const r={RECORD:"2",OWNERPARTID:d.getInt16(5,true),OWNERPARTDISPLAYMODE:bytes[7],
      ELECTRICAL:bytes[p+1],PINCONGLOMERATE:bytes[p+2],PINLENGTH:d.getInt16(p+3,true),
      "LOCATION.X":d.getInt16(p+5,true),"LOCATION.Y":d.getInt16(p+7,true),COLOR:d.getUint32(p+9,true)};
    p+=13;r.NAME=string();r.DESIGNATOR=string();return r;
  }
  function decodeBinary(bytes) {
    const records=[];
    for(let off=0;off<bytes.length;){
      const found=AtriumAltiumRecords.frame(bytes,off,4,["Incomplete schematic record header.","Schematic record extends beyond the input stream."]);
      off=found.end;
      let record;
      if(found.flag!==0){
        record=found.payload.length>=4 && found.payload[0]===2 ? binaryPin(found.payload) : {RECORD:"binary"};
      }else record=AtriumAltiumRecords.propertyRecord(found.payload,true,false);
      if(record.HEADER && !records.length)continue;
      records.push(record);
    }
    return records;
  }
  // An ASCII file is read as Windows-1252, so a %UTF8% value arrives as its UTF-8 bytes, one
  // character per byte: map the characters back to those bytes and decode them as UTF-8.
  const CP1252_BYTE={0x20ac:0x80,0x201a:0x82,0x192:0x83,0x201e:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x2c6:0x88,0x2030:0x89,0x160:0x8a,0x2039:0x8b,
    0x152:0x8c,0x17d:0x8e,0x2018:0x91,0x2019:0x92,0x201c:0x93,0x201d:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x2dc:0x98,0x2122:0x99,0x161:0x9a,
    0x203a:0x9b,0x153:0x9c,0x17e:0x9e,0x178:0x9f};
  function utf8Field(v){
    if(typeof v!=="string"||!/[^\x00-\x7f]/.test(v))return v;
    const b=new Uint8Array(v.length);
    for(let i=0;i<v.length;i++){const c=v.charCodeAt(i),x=c<0x100?c:CP1252_BYTE[c];if(x==null)return v;b[i]=x;}
    try{return new TextDecoder("utf-8",{fatal:true}).decode(b);}catch{return v;}
  }
  function decodeAscii(text) {
    const records=[];
    for(const line of text.replace(/^\uFEFF/,"").split(/\r\n|\r|\n/)){
      if(!line.trim())continue;
      const r=properties(line);
      for(const k of Object.keys(r))if(k.startsWith("%UTF8%"))r[k.slice(6)]=utf8Field(r[k]);
      if(r.RECORD!==undefined)records.push(r);
    }
    if(!records.length)throw Error("This file contains no schematic records.");
    return records;
  }
  function vertices(r) {
    const count=numeric(r.LOCATIONCOUNT);
    if(count>1000000 || count>Object.keys(r).length)throw Error("Invalid schematic point count.");
    const pts=[];
    // Altium omits zero-valued whole and fractional ordinates.
    const coordinate=key=>{
      const whole=r[key], frac=r[key+"_FRAC"];
      const invalid=value=>value!=null&&(String(value).trim()===""||!Number.isFinite(Number(value)));
      if(invalid(whole)||invalid(frac))throw Error("Invalid schematic point coordinate "+key+".");
      return mm(r,key);
    };
    for(let i=1;i<=count;i++)pts.push([coordinate("X"+i),-coordinate("Y"+i)]);
    return pts;
  }
  function rectangle(r) {
    const a=at(r),b=at(r,"CORNER");
    return [a,[b[0],a[1]],b,[a[0],b[1]]];
  }
  function ellipse(r,t) {
    const [x,y]=at(r),rx=mm(r,"RADIUS"), ry=t===8||t===11?mm(r,"SECONDARYRADIUS")||rx:rx;
    if(rx<=0||ry<=0)return [];
    const full=t===8,start=full?0:numeric(r.STARTANGLE),end=full?360:numeric(r.ENDANGLE);
    const span=((end-start)%360+360)%360 || 360;
    const n=Math.max(4,Math.ceil(span/8));
    return Array.from({length:n+1},(_,i)=>{
      const a=A.rad(start+span*i/n);return [x+rx*Math.cos(a),y-ry*Math.sin(a)];
    });
  }
  const sheetSizes=[[1150,760],[1550,1110],[2230,1570],[3150,2230],[4460,3150],[950,750],[1500,950],[2000,1500],[3200,2000],[4200,3200],[1100,850],[1400,850],[1700,1100],[990,790],[1540,990],[2060,1560],[3260,2060],[4280,3280]];
  function ink(raw,fallback){
    if(raw==null||raw==="")return fallback;
    const n=Number(raw);
    if(!Number.isInteger(n)||n<0||n>0xffffff)return fallback;
    const hex=v=>v.toString(16).padStart(2,"0");
    return "#"+hex(n&255)+hex(n>>>8&255)+hex(n>>>16&255);
  }
  // Altium's line widths by LINEWIDTH: Smallest (the default when absent), Small (10 mil), Medium, Large.
  const pens=[.10,.254,.508,.762],smallPen=pens[1];
  function stroke(r,fallback="#800000"){
    return {ink:ink(r.COLOR,fallback),width:pens[numeric(r.LINEWIDTH)]||smallPen,fill:ink(r.AREACOLOR,"#ffffb0")};
  }
  function sheetSettings(r) {
    const standard=sheetSizes[numeric(r.SHEETSTYLE)]||sheetSizes[0];
    let [w,h]=standard.map(v=>v*.254);
    if(isTrue(r.USECUSTOMSHEET)&&mm(r,"CUSTOMX")>0&&mm(r,"CUSTOMY")>0){w=mm(r,"CUSTOMX");h=mm(r,"CUSTOMY");}
    if(numeric(r.WORKSPACEORIENTATION)===1 && w>h)[w,h]=[h,w];
    const fonts=[];
    for(let i=1;i<=Math.min(256,numeric(r.FONTIDCOUNT));i++)fonts[i-1]={
      family:(r["FONTNAME"+i]||"Arial").slice(0,100),size:Math.max(.4,Math.min(50,numeric(r["SIZE"+i],10)*.2032)),
      bold:isTrue(r["BOLD"+i]),italic:isTrue(r["ITALIC"+i]),underline:isTrue(r["UNDERLINE"+i])
    };
    return {width:w,height:h,paper:ink(r.AREACOLOR,"#fffff8"),border:r.BORDERON===undefined||isTrue(r.BORDERON),
      grid:mm(r,"VISIBLEGRIDSIZE")||2.54,showGrid:r.VISIBLEGRIDON===undefined||isTrue(r.VISIBLEGRIDON),
      zonesX:Math.max(1,Math.min(32,numeric(r.CUSTOMXZONES,6))),zonesY:Math.max(1,Math.min(26,numeric(r.CUSTOMYZONES,4))),
      zones:r.SHEETNUMBERSPACESIZE!==undefined?numeric(r.SHEETNUMBERSPACESIZE)>0:!isTrue(r.HIDEZONES),
      font:fonts,frame:[]};
  }
  function textPaint(r,fonts,fallback="#000080",relativeAngle=0){
    const font=fonts[Math.max(0,numeric(r.FONTID,1)-1)]||{family:"Arial",size:2.032};
    const just=numeric(r.JUSTIFICATION);
    return {...font,ink:ink(r.COLOR,fallback),align:["left","center","right"][just%3]||"left",
      baseline:["bottom","middle","top"][Math.floor(just/3)]||"bottom",angle:((-numeric(r.ORIENTATION)*90-relativeAngle)%360+360)%360};
  }
  const objectNames = {1:"Component", 2:"Pin", 3:"IEEE symbol", 4:"Text", 5:"Bézier curve", 6:"Polyline", 7:"Polygon", 8:"Ellipse",
    9:"Pie chart", 10:"Rounded rectangle", 11:"Elliptical arc", 12:"Arc", 13:"Line", 14:"Rectangle", 15:"Sheet symbol", 16:"Sheet entry",
    17:"Power port", 18:"Port", 22:"No ERC marker", 25:"Net label", 26:"Bus", 27:"Wire", 28:"Text frame", 29:"Junction",
    30:"Image", 31:"Sheet settings", 32:"Sheet name", 33:"Sheet filename", 34:"Designator", 37:"Bus entry", 39:"Sheet template", 41:"Parameter",
    43:"Parameter set", 44:"Implementation list", 45:"Implementation", 46:"Implementation map", 47:"Map definition", 48:"Parameter map"};
  function read(name,streams,ascii,{appearance=true,textPlacement=2,fidelity=null,selectedImage=null}={}) {
    if(textPlacement && textPlacement!==1)textPlacement=2;
    const library=[],documents=[],notes=[], skipped=new Map(), simplified=new Set();
    const count=key=>skipped.set(key,(skipped.get(key)||0)+1);
    const lib=/\.schlib$/i.test(name);
    const doc=lib?null:A.sheet("schematic",name.replace(/\.schdoc$/i,""));
    // Stable ids (altium-ids.js): record UniqueIDs, else content; libraries keep fresh ids.
    const ids=doc&&globalThis.AtriumAltiumIds?AtriumAltiumIds.scope(name):null;let recs=[];
    if(ids)doc.id=ids.doc();
    if(doc){doc.sourceName=name;if(appearance)doc.schDrawing=sheetSettings({});documents.push(doc);}
    function liveString(text) {
      const name=/^\s*=(Title|CurrentDate|Revision|ProjectName)\s*$/i.exec(text)?.[1].toLowerCase();
      const expression=({title:"sheet.Title",currentdate:"sheet.CurrentDate",revision:"project.Revision",projectname:"project.Name"})[name];
      if(!expression)return null;
      const [scope,field]=expression.split(".");
      return {font:"sans",blocks:[{style:"paragraph",runs:[{type:"field",expression,binding:{scope,...(scope==="sheet"?{docId:doc.id}:{}),field:field.toLowerCase()}}]}]};
    }
    let evidence, section;
    function mark(i,status,object,reason) {
      if (!evidence) return;
      const old = evidence[i];
      evidence[i] = {status:old?.status === "approximated" && status === "kept" ? old.status : status,
        object:object || old?.object, reason:reason || old?.reason};
    }
    function addItem(item,record,role=item.kind) {
      if(ids)item.id=ids.record(recs[record],role,item);
      if(streams&&!lib)item.schSource={record,role};
      doc.items.push(item);
      mark(record, "kept", item);
      fidelity?.produced?.("schematic", {file:name,object:section+"#"+record}, item);
    }
    function parse(records,libraryStream,sourceSection) {
      section = sourceSection;
      evidence = fidelity ? new Array(records.length) : null;
      recs=records;
      const components=new Map(),ports=[],sheetSymbols=new Map(),harness=[],crossRefs=new Map(),connectorLabels=new Map();
      const sheet=records.find(r=>Number(r.RECORD)===31)||{};
      const settings=appearance?sheetSettings(sheet):null;
      if(settings && textPlacement && streams && doc)settings.textPlacement=textPlacement;
      if(doc&&settings){doc.schDrawing=settings;if(mm(sheet,"SNAPGRIDSIZE")>0)doc.grid=mm(sheet,"SNAPGRIDSIZE");}
      const fonts=settings?.font||[], sheetParams=new Map();
      const pinFont=textPlacement===2 && doc && fonts[numeric(sheet.SYSTEMFONT,1)-1];
      let activeLibraryRoot=-1,recognized=0;
      const ancestors=new Array(records.length),template=new Set();
      // Library symbols with several parts (a dual op-amp): every part is read as a gate. What a record
      // adds to its component is tagged with the record's part (0, shared on every gate, stays untagged).
      let tagging=null;
      const tag=()=>{
        if(!tagging?.part)return;
        const {c,part,s,p,x}=tagging;
        for(const list of [[c.symbol.shapes,s],[c.symbol.pins,p],[c.pinText,x]])for(let k=list[1];k<list[0].length;k++)list[0][k].part=part;
      };
      for(let idx=0;idx<records.length;idx++){
        tag();tagging=null;
        const r=records[idx],t=Number(r.RECORD);
        const kept = obj => mark(idx, "kept", obj);
        const approximated = reason => mark(idx,"approximated",null,reason);
        const dropped = reason => mark(idx,"dropped",null,reason);
        const owner=r.OWNERINDEX===undefined?(libraryStream?activeLibraryRoot:-1):numeric(r.OWNERINDEX,-1);
        const ancestor=owner>=0 && owner<idx ? ancestors[owner] : undefined;
        if(t===39 || template.has(owner)){
          template.add(idx);
          if(!appearance){if(t===39)count("sheet templates");continue;}
          if(!doc || t===39 || (sheet.SHOWTEMPLATEGRAPHICS!==undefined&&!isTrue(sheet.SHOWTEMPLATEGRAPHICS)))continue;
          const picture=settings.frame, before=picture.length;
          if(t===4 && !isTrue(r.ISHIDDEN))picture.push({kind:"text",...xy(at(r)),text:r.TEXT||"",...textPaint(r,fonts,"#000000")});
          else if([6,7,13,14].includes(t)){
            const points=t===13?[at(r),at(r,"CORNER")]:t===14?rectangle(r):vertices(r);
            if(points.length>1)picture.push({kind:"path",points,closed:t===7||t===14,solid:isTrue(r.ISSOLID),...stroke(r,"#000000")});
          }else if(t===30)count("template images");
          else count("template "+(recordNames[t]||"record type "+t));
          if(picture.length>before)kept(picture.at(-1));
          continue;
        }
        if(t===1){
          const defName=r.LIBREFERENCE||r.DESIGNITEMID||"Symbol";
          const c={origin:at(r),activePart:numeric(r.CURRENTPARTID,1)||1,partCount:numeric(r.PARTCOUNT),mode:numeric(r.DISPLAYMODE),
            angle:libraryStream?0:((4-numeric(r.ORIENTATION,0)%4)%4)*90,
            symbol:{shapes:[],pins:[]},params:Object.create(null),prefix:"U",ref:"",value:"",name:defName,
            footprintName:"",desc:r.COMPONENTDESCRIPTION||"",index:idx,pinText:[],captions:[],kind:numeric(r.COMPONENTKIND,0)};
          kept();ancestors[idx]=c;components.set(idx,c);activeLibraryRoot=idx;recognized++;continue;
        }
        ancestors[idx]=ancestor;
        const c=ancestor || (libraryStream ? components.get(activeLibraryRoot) : null);
        const ownerPart=numeric(r.OWNERPARTID,-1),gates=libraryStream && c && c.partCount>2;
        if(c && ((!gates && ownerPart>0 && ownerPart!==c.activePart) || numeric(r.OWNERPARTDISPLAYMODE)!==c.mode)){
          dropped("Inactive component part or alternate display mode.");
          if(libraryStream)simplified.add(gates?"Only the normal display mode of library symbols is imported (alternate De Morgan views are left out).":"Only the active part and display mode of multi-part symbols are available.");
          continue;
        }
        if(gates && ownerPart>0)tagging={c,part:ownerPart,s:c.symbol.shapes.length,p:c.symbol.pins.length,x:c.pinText.length};
        if(t===31){if(doc&&settings)kept(settings);recognized++;continue;}
        if([44,46,47,48].includes(t))continue;
        if(t===45){
          if(c && (!r.MODELTYPE || r.MODELTYPE.toUpperCase()==="PCBLIB") && (!c.footprintName || isTrue(r.ISCURRENT))){c.footprintName=r.MODELNAME||"";if(c.footprintName)approximated("Footprint name retained as a component association.");}
          continue;
        }
        const position=at(r),local=p=>c?delta(p,c.origin):p;
        if(t===34 || t===41){
          if(t===41 && doc && appearance && textPlacement===2 && r.NAME?.toUpperCase()==="CROSSREF" && [17,18].includes(Number(records[owner]?.RECORD))){
            if(!isTrue(r.ISHIDDEN) && r.TEXT){
              if(!crossRefs.has(owner))crossRefs.set(owner,[]);
              crossRefs.get(owner).push({...textPaint(r,fonts),at:position,text:r.TEXT});kept();
            }
            continue;
          }
          if(!c&&t===41&&r.NAME&&doc){sheetParams.set(r.NAME.toUpperCase(),r.TEXT||"");approximated("Sheet parameter used for resolving template text.");}
          if(c && (libraryStream || owner===c.index)){
            kept();
            const field=(r.NAME||"").toUpperCase();
            if(t===34){c.ref=r.TEXT||"";c.prefix=c.ref.match(/^[^0-9?]+/)?.[0]||"U";c.refAt=local(position);c.showRef=!isTrue(r.ISHIDDEN);if(appearance)c.refPaint=textPaint(r,fonts,"#000080",c.angle);}
            else {
              c.params[field]=r.TEXT||"";
              if(appearance && textPlacement && doc && !isTrue(r.ISHIDDEN) && r.NAME && r.TEXT)
                c.captions.push({name:r.NAME,field,text:r.TEXT,at:local(position),paint:textPaint(r,fonts,"#000080",c.angle),showName:isTrue(r.SHOWNAME)});
              if(field==="VALUE"||field==="COMMENT"){
                const visible=!isTrue(r.ISHIDDEN);
                if(visible || !c.valueAt){c.valueAt=local(position);if(appearance)c.valuePaint=textPaint(r,fonts,"#000080",c.angle);}
                c.showValue=Boolean(c.showValue)||visible;
              }
            }
          }
          continue;
        }
        function graphic(points,closed=false,fill=false){
          if(points.length<2)return;
          const paint=appearance?{schPaint:stroke(r)}:{};
          if(c){c.symbol.shapes.push({...path(points.map(local),closed,fill),...paint});kept(c.symbol.shapes.at(-1));}
          else if(doc)addItem({id:A.id(),kind:"graphic",points:closed?[...points,points[0]]:points,...paint,...(appearance?{closed,fill}:{})},idx);
          recognized++;
        }
        if(t===2 && c){
          const flags=numeric(r.PINCONGLOMERATE), rotation=flags&3, len=mm(r,"PINLENGTH");
          const direction=[[1,0],[0,-1],[-1,0],[0,1]][rotation];
          const start=local(position),end=[start[0]+len*direction[0],start[1]+len*direction[1]];
          const number=String(r.DESIGNATOR??""),pinName=r.NAME||"";
          const hidden=Boolean(flags&4);
          if(hidden)simplified.add("Hidden pins retain their locations. Implicit hidden-pin net assignments require review.");
          c.symbol.pins.push({...xy(end),number,name:pinName,hidden,electrical:numeric(r.ELECTRICAL,4)});
          kept(c.symbol.pins.at(-1));if(hidden)approximated("Implicit hidden-pin net assignment requires review.");
          if(!hidden){
            // A pin record has no width. Altium draws the pin line with the Small pen, the same as a Small wire.
            c.symbol.shapes.push({...path([start,end]),...(appearance?{schPaint:{...stroke(r,"#000000"),width:smallPen}}:{})});
            if(appearance && (flags&24)){
              const pin={start,end,name:flags&8?pinName:"",number:flags&16?number:"",direction};
              if(pinFont){
                const nameFont=fonts[numeric(r.NAME_CUSTOMFONTID)-1],numberFont=fonts[numeric(r.DESIGNATOR_CUSTOMFONTID)-1];
                if((numeric(r.PINNAME_POSITIONCONGLOMERATE)&16) && nameFont)pin.nameFont=nameFont;
                if((numeric(r.PINDESIGNATOR_POSITIONCONGLOMERATE)&16) && numberFont)pin.numberFont=numberFont;
              }
              // A custom position moves the text along the pin from the body end (Altium's defaults:
              // name 70 mil inside, number 80 mil outside; sch-appearance.js pinText).
              if(r.NAME_CUSTOMPOSITION_MARGIN!=null)pin.nameMargin=-mm(r,"NAME_CUSTOMPOSITION_MARGIN");
              if(r.DESIGNATOR_CUSTOMPOSITION_MARGIN!=null)pin.numberMargin=mm(r,"DESIGNATOR_CUSTOMPOSITION_MARGIN");
              c.pinText.push(pin);
            }
            // Horizontal pin labels stay inside the body with their source pin.
            if((flags&8) && pinName && direction[0]){
              const w=pinName.length*0.73;
              const x=start[0]-(direction[0]>0?w+0.55:-0.55);
              c.symbol.shapes.push({kind:"text",x,y:start[1]+0.4,text:pinName,size:1.35,style:"body",...(appearance?{schPaint:{pinNameFallback:true}}:{})});
            }
          }
          recognized++;continue;
        }
        if(t===6||t===7){graphic(vertices(r),t===7,isTrue(r.ISSOLID));continue;}
        if(t===13){graphic([position,at(r,"CORNER")]);continue;}
        if(t===10||t===14){graphic(rectangle(r),true,isTrue(r.ISSOLID));if(t===10){simplified.add("Rounded rectangles use square corners.");approximated("Rounded rectangles use square corners.");}continue;}
        if([8,11,12].includes(t)){graphic(ellipse(r,t),t===8,isTrue(r.ISSOLID));simplified.add("Curves use line segments.");approximated("Curve tessellated to line segments.");continue;}
        if(t===27 && doc && !c){
          const points=vertices(r);if(points.length>=2)addItem({id:A.id(),kind:"wire",points,...(appearance?{schPaint:stroke(r,"#000080")}:{})},idx);
          recognized++;continue;
        }
        if(t===29 && doc && !c){addItem({id:A.id(),kind:"junction",...xy(position),...(appearance?{schPaint:{ink:ink(r.COLOR,"#800000")}}:{})},idx);recognized++;continue;}
        if(t===18 && doc && !c){
          const text=[r.NAME,r.TEXT].find(value=>value?.trim());
          if(text){ports.push({record:r,index:idx,text});approximated(r.HARNESSTYPE?"Harness name retained without harness member connections.":"Port represented by a net label.");}else count("unnamed ports");
          if(r.HARNESSTYPE)harness.push(r.HARNESSTYPE);
          recognized++;continue;
        }
        if(t===30 && doc && !c && selectedImage && /^notebook-[0-9a-f]{64}\.png$/.test(r.FILENAME||"")){
          const bytes=selectedImage(r.FILENAME);
          const corner=at(r,"CORNER"),w=Math.abs(corner[0]-position[0]),h=Math.abs(corner[1]-position[1]);
          if(w>0&&h>0){
            const origin={x:Math.min(position[0],corner[0]),y:Math.min(position[1],corner[1])};
            if(bytes)addItem({id:A.id(),kind:"image",...origin,w,h,name:"Altium image.png",src:bytes.src,extent:bytes.extent},idx);
            else{
              const fallback={id:A.id(),kind:"textframe",...origin,w,h,text:"Schematic image unavailable"};
              addItem(fallback,idx);
              mark(idx,"approximated",fallback,"The selected project files do not include the referenced image.");
            }
            recognized++;continue;
          }
        }
        if([4,17,25].includes(t)){
          if(!isTrue(r.ISHIDDEN) && r.TEXT){
            const paint=appearance?textPaint(r,fonts,"#000080",c?.angle||0):null;
            if(c){c.symbol.shapes.push({kind:"text",...xy(local(position)),text:r.TEXT,size:1.8,style:"body",...(paint?{schPaint:paint}:{})});kept(c.symbol.shapes.at(-1));}
            else if(doc){
              if(paint&&t===17)Object.assign(paint,{type:"power",style:numeric(r.STYLE),direction:numeric(r.ORIENTATION),showName:isTrue(r.SHOWNETNAME)});
              const item={id:A.id(),kind:t===4?"label":"netlabel",...xy(position),text:r.TEXT,...(paint?{schPaint:paint}:{})};
              const rich=t===4 && liveString(r.TEXT);
              if(rich) {item.kind="textframe";Object.assign(item,{w:Math.max(22,String(r.TEXT).length*2),h:5,border:false,richText:rich});}
              addItem(item,idx);
              if(t===17 && paint && textPlacement===2 && isTrue(r.ISCROSSSHEETCONNECTOR)){
                Object.assign(paint,pinFont||{},{offSheet:true});connectorLabels.set(idx,item);
              }
            }
          }
          if(t===17&&!appearance)simplified.add("Power ports use net labels.");
          recognized++;continue;
        }
        if((t===28 || t===209) && doc && !c) {
          const end=at(r,"CORNER"),x=Math.min(position[0],end[0]),y=Math.min(position[1],end[1]),
            value=String(r.TEXT || "").replace(/~1/g,"\n"),richText=liveString(value);
          addItem({id:A.id(),kind:"textframe",x,y,w:Math.max(.1,Math.abs(end[0]-position[0])),h:Math.max(.1,Math.abs(end[1]-position[1])),
            text:value,border:isTrue(r.SHOWBORDER),...(t===209?{note:true}:{}),...(richText?{richText}:{})},idx);
          recognized++;continue;
        }
        if(t===26 && doc && !c){
          const points=vertices(r);if(points.length>=2)addItem({id:A.id(),kind:"bus",points},idx);
          recognized++;continue;
        }
        if(t===37 && doc && !c){
          // A bus entry runs from LOCATION (the wire end) to CORNER (on the bus).
          const end=at(r,"CORNER"),d=delta(end,position),size=Math.hypot(...d)/Math.SQRT2;
          if(size>0)addItem({id:A.id(),kind:"busentry",...xy(position),size:Math.round(size*1e6)/1e6,angle:Math.round(Math.atan2(d[1],d[0])*180/Math.PI+45)},idx);
          recognized++;continue;
        }
        if(t===22 && doc && !c){addItem({id:A.id(),kind:"noerc",...xy(position)},idx);recognized++;continue;}
        if(t===15 && doc && !c){
          const item={id:A.id(),kind:"sheetsymbol",...xy(position),w:mm(r,"XSIZE")||10.16,h:mm(r,"YSIZE")||10.16,name:"",sheet:"",entries:[]};
          sheetSymbols.set(idx,item);addItem(item,idx);recognized++;continue;
        }
        if((t===16||t===32||t===33) && doc && sheetSymbols.has(owner)){
          kept();if(r.HARNESSTYPE)approximated("Harness member connections omitted.");
          const s=sheetSymbols.get(owner);
          if(t===32)s.name=r.TEXT||s.name;
          else if(t===33)s.file=r.TEXT||"";
          else{if(r.HARNESSTYPE)harness.push(r.HARNESSTYPE);s.entries.push({id:ids?ids.record(r,"entry",{owner:s.id,name:r.NAME||"",side:r.SIDE}):A.id(),name:r.NAME||"",side:["left","right","top","bottom"][numeric(r.SIDE)]||"left",
            offset:numeric(r.DISTANCEFROMTOP)*2.54+numeric(r.DISTANCEFROMTOP_FRAC1)*.0000254,io:["unspecified","output","input","bidirectional"][numeric(r.IOTYPE)]||"unspecified"});}
          recognized++;continue;
        }
        count(recordNames[t] || "record type "+(r.RECORD??"unknown"));
      }
      tag();tagging=null;
      const symbolDefs=new Map(),footprints=new Map(),kinds=new Map();
      for(const c of components.values()){
        const params=c.params;
        // Gates of a multi-part library symbol: Altium counts part 0 (shared) in PARTCOUNT.
        if(libraryStream && c.partCount>2){const top=Math.max(c.partCount-1,...c.symbol.pins.map(p=>p.part||0),...c.symbol.shapes.map(s=>s.part||0));if(top>1)c.symbol.parts=top;}
        let value=params.VALUE||params.COMMENT||params["PART NUMBER"]||c.name;
        if(value.startsWith("="))value=params[value.slice(1).toUpperCase()]||params["PART NUMBER"]||c.name;
        // Undo the placed instance rotation before sharing its library geometry.
        // Rounding removes harmless binary float differences after translation.
        const normalize=p=>A.rotate(p,-c.angle).map(v=>Math.round(v*1e8)/1e8);
        for(const s of c.symbol.shapes){
          if(s.points)s.points=s.points.map(normalize);
          else Object.assign(s,xy(normalize([s.x,s.y])));
        }
        for(const p of c.symbol.pins)Object.assign(p,xy(normalize([p.x,p.y])));
        const def={id:A.id(),name:c.name,description:c.desc,category:"Imported symbols",prefix:c.prefix,value,
          symbol:c.symbol,footprintName:c.footprintName,parameters:params,sourceName:name};
        // Component Type: 1 mechanical, 2 graphical, 3/4 net tie (in BOM / no BOM), 5 standard (no BOM), 6 jumper.
        const kind=KINDS[c.kind];
        if(kind){def.componentKind=kind;if(c.kind===3||c.kind===4)c.symbol.netTie=true;kinds.set(kind,(kinds.get(kind)||0)+1);}
        if(appearance&&c.pinText.length)def.schDrawing={...(pinFont?{pinFont}:{}),pins:c.pinText.map(pin=>({...pin,start:normalize(pin.start),
          end:normalize(pin.end),direction:normalize(pin.direction)}))};
        const key=JSON.stringify([def.name,def.value,def.symbol,def.footprintName,params,def.schDrawing,kind]);
        const existing=symbolDefs.get(key);
        if(!existing){if(ids)def.id=ids.def(key);library.push(def);symbolDefs.set(key,def);}
        const matched=existing||def;
        if(doc){
          /** @type {PartItem} */
          const item={id:A.id(),kind:"part",def:matched.id,ref:c.ref||c.prefix+"?",value,link:ids&&records[c.index]?.UNIQUEID?ids.link("part:"+records[c.index].UNIQUEID):A.id(),pinNets:{},...xy(c.origin),angle:c.angle};
          const sourceId=ids&&globalThis.AtriumAltiumIds.sourceLink(records[c.index]?.UNIQUEID);
          if(sourceId)item.link=item.altiumSourceId=sourceId;
          if(appearance && (c.refPaint||c.valuePaint))item.schPaint={...(c.refPaint?{ref:c.refPaint}:{}),...(c.valuePaint?{value:c.valuePaint}:{})};
          // Altium reserves part zero for common graphics. Its designator stores the base
          // reference, while the printed sheet adds the active part letter (U1A, U1B…).
          if(textPlacement===2 && c.refPaint && c.partCount>2 && Number.isInteger(c.activePart) && c.activePart>0 && c.activePart<c.partCount)
            item.schPaint.designatorUnit=c.activePart;
          if(c.refAt)item.refAt=normalize(c.refAt);if(c.valueAt)item.valueAt=normalize(c.valueAt);
          if(c.showRef!==undefined)item.showRef=c.showRef;if(c.showValue!==undefined)item.showValue=c.showValue;
          if(c.captions.length){
            const resolved=caption=>caption.text.startsWith("=")?params[caption.text.slice(1).toUpperCase()]||caption.text:caption.text;
            const valueFields=c.captions.filter(p=>p.field==="VALUE"||p.field==="COMMENT");
            const primary=valueFields.find(p=>!p.showName && resolved(p)===value);
            if(primary){
              item.valueAt=normalize(primary.at);item.schPaint.value=primary.paint;
            }else if(valueFields.length)item.showValue=false;
            const custom=c.captions.filter(p=>p!==primary);
            if(custom.length){
              item.paramShow=Object.fromEntries(custom.map(p=>[p.field,true]));
              (item.schPaint||={}).parameters=Object.fromEntries(custom.map(p=>[p.field,{...p.paint,at:normalize(p.at),text:resolved(p),...(p.showName?{caption:p.name}:{})}]));
            }
          }
          addItem(item,c.index);
        }
        footprints.set(matched.id,matched);
      }
      if(kinds.size)simplified.add("Component types kept for ERC and BOM: "+[...kinds].map(([k,n])=>n+" × "+KIND_NAMES[k]).join(", ")+".");
      if(harness.length)simplified.add("Harnesses are not imported: "+harness.length+" × harness ports and sheet entries ("+[...new Set(harness)].slice(0,4).join(", ")+") keep their names, but harness members do not connect.");
      if(doc && ports.length){
        const terminals=new Set();
        for(const item of doc.items){
          if(item.kind==="wire")for(const p of item.points)terminals.add(A.pointKey(p));
          if(item.kind==="part")for(const pin of A.pins(item,footprints.get(item.def),"schematic"))terminals.add(A.pointKey(pin.at));
        }
        for(const {record:r,index,text} of ports){
          const start=at(r),width=mm(r,"WIDTH"),end=start.slice();
          if(numeric(r.STYLE)<4)end[0]+=width;else end[1]-=width;
          const startWired=terminals.has(A.pointKey(start)),endWired=terminals.has(A.pointKey(end));
          const p=endWired&&!startWired?end:start;
          if(startWired&&endWired&&!A.same(start,end))addItem({id:A.id(),kind:"wire",points:[start,end]},index,"portBridge");
          const paint=appearance?{...textPaint(r,fonts),type:"port",style:numeric(r.STYLE),width,height:mm(r,"HEIGHT")||2.54,
            offset:delta(start,p),ink:ink(r.COLOR,"#800000"),paper:ink(r.AREACOLOR,"#ffff80"),textInk:ink(r.TEXTCOLOR,"#800000"),
            align:["center","right","left"][numeric(r.ALIGNMENT)]||"center"}:null;
          const item={id:A.id(),kind:"netlabel",...xy(p),text,...(paint?{schPaint:paint}:{})};
          addItem(item,index,"portLabel");if(crossRefs.has(index))connectorLabels.set(index,item);
        }
        simplified.add(appearance?"Ports connect across sheets as Project Options → Net identifier scope sets.":"Ports use net labels.");
      }
      for(const [owner,captions] of crossRefs){
        const item=connectorLabels.get(owner);
        if(item?.schPaint)item.schPaint.crossReferences=captions.map(caption=>({...caption,at:delta(caption.at,[item.x,item.y])}));
      }
      if(doc&&settings){
        sheetParams.set("DOCUMENTNAME",name);
        sheetParams.set("DOCUMENTFULLPATHANDNAME",name);
        for(const caption of settings.frame)if(caption.kind==="text"&&caption.text.startsWith("=")){
          const value=sheetParams.get(caption.text.slice(1).toUpperCase());
          caption.text=value&&value!=="*"?value:"";
        }
      }
      if(!recognized)throw Error("No supported schematic records were found.");
      if (evidence) records.forEach((r,i) => {
        const kind = Object.hasOwn(objectNames,r.RECORD) ? objectNames[r.RECORD] : "Unsupported schematic record";
        const src = {file:name,object:section+"#"+i};
        const e = evidence[i];
        if (e?.object) fidelity.track(kind,e.status,src,e.object,e.reason);
        else fidelity.add(kind,e?.status || "dropped",src,e?.reason || "Schematic record "+String(r.RECORD||"unknown").slice(0,60)+" has no editable representation.");
      });
    }
    if(ascii!=null)parse(decodeAscii(ascii),lib,"ASCII record");
    else if(!lib){
      const header=streams?.get("fileheader");if(!header)throw Error("Missing SchDoc FileHeader stream.");
      parse(decodeBinary(header),false,"FileHeader");
    }else{
      if(!streams?.has("fileheader"))throw Error("Missing SchLib FileHeader stream.");
      for(const [key,bytes] of streams){
        if(!/^[^/]+\/data$/i.test(key))continue;
        const records=decodeBinary(bytes);
        if(records.some(r=>Number(r.RECORD)===1))parse(records,true,key);
      }
      if(!library.length)throw Error("No supported library symbols were found.");
      if([...streams.keys()].some(k=>/\/(pinfrac|pinsymbollinewidth|pintextdata|pinwide-text|pinwidetext|pinpackagelength)$/i.test(k)))simplified.add("Extended pin metadata and fractional library pin positions are omitted.");
    }
    if(skipped.size)notes.push("Omitted "+[...skipped].map(([k,n])=>n+" × "+k).join(", ")+".");
    notes.push(...simplified);
    if(doc)doc.notes=[...notes];
    return {documents,library,notes};
  }
  return {read};
})();
