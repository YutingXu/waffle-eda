"use strict";
if (!globalThis.AtriumAltiumRecords) { if (typeof importScripts === "function" && !globalThis.AtriumEmbeddedTranslatorScripts) importScripts("../formats/altium-records.js"); else if (typeof require === "function") require("./altium-records.js"); }

// SchDoc records are length-prefixed. Treat the payload as bytes, including its
// original field casing, repeated separators, encodings and trailing NULs.
globalThis.AtriumSchPatch = (() => {
  const legacy=new TextDecoder("windows-1252"), utf8=new TextDecoder(), encoder=new TextEncoder();
  const bytesOf=string=>Uint8Array.from(string,c=>c.charCodeAt(0));
  function byteString(bytes){
    let raw="";
    for(let n=0;n<bytes.length;n+=8192)raw+=String.fromCharCode(...bytes.subarray(n,n+8192));
    return raw;
  }
  const legacyBytes=new Map();
  for(let b=0;b<256;b++)legacyBytes.set(legacy.decode(Uint8Array.of(b)),b);
  const tick=.00000254;
  const tickOf=mm=>{
    if(!Number.isFinite(mm)||Math.abs(mm)>5e8)throw Error("Coordinate exceeds the supported schematic range.");
    return Math.round(mm/tick);
  };
  function same(a,b){
    if(a===b)return true;
    if(!a||!b||typeof a!=="object"||typeof b!=="object"||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
  }
  class Record {
    constructor(bytes,flags){
      this.bytes=bytes;this.flags=flags;this.dirty=false;
      if(flags)return;
      const raw=byteString(bytes),end=raw.search(/\0*$/);
      this.tail=raw.slice(end);this.fields=raw.slice(0,end).split("|");
      this.reindex();
    }
    reindex(){
      this.index=new Map();
      for(let i=0;i<this.fields.length;i++){
        const part=this.fields[i],s=part.indexOf("=");if(s<=0)continue;
        const key=part.slice(0,s).trim().toUpperCase();
        this.index.set(key,this.index.has(key)?-1:i);
      }
    }
    raw(key){
      const i=this.index?.get(key.toUpperCase());if(i==null)return undefined;
      if(i<0)throw Error("Duplicate schematic field "+key+" is ambiguous.");
      const field=this.fields[i];return field.slice(field.indexOf("=")+1);
    }
    text(key){
      const alias=this.raw("%UTF8%"+key);
      return alias===undefined?legacy.decode(bytesOf(this.raw(key)??"")):utf8.decode(bytesOf(alias));
    }
    set(key,value){
      const upper=key.toUpperCase(),old=this.raw(upper);
      if(old===value)return;
      this.dirty=true;
      if(old===undefined){this.index.set(upper,this.fields.length);this.fields.push(key+"="+value);}
      else {const i=this.index.get(upper),prior=this.fields[i];this.fields[i]=prior.slice(0,prior.indexOf("=")+1)+value;}
    }
    setText(key,text){
      if(typeof text!=="string"||!text.trim()||text.startsWith("=")||/[\u0000-\u001f\u007f|]/.test(text)||utf8.decode(encoder.encode(text))!==text)throw Error("Use nonempty literal text without control characters, an initial equals sign or a pipe for this Altium field.");
      if(this.raw(key)===undefined&&this.raw("%UTF8%"+key)===undefined)throw Error("The original schematic has no source text field for this change.");
      const asciiFallback=byteString(Uint8Array.from(text,c=>legacyBytes.get(c)??63));
      if(this.raw("%UTF8%"+key)!==undefined || /[^\x20-\x7e]/.test(text)){
        if(this.raw("%UTF8%"+key)===undefined){
          // Altium places the UTF-8 spelling ahead of the legacy spelling,
          // separated by three pipes. Keep this layout when introducing one.
          const i=this.index.get(key.toUpperCase());
          const prev=this.fields[i], prefix=prev.slice(0,prev.indexOf("=")+1);
          this.fields.splice(i,1,"%UTF8%"+prefix+byteString(encoder.encode(text)),"","",prefix+asciiFallback);
          this.reindex();this.dirty=true;return;
        }
        this.set("%UTF8%"+key,byteString(encoder.encode(text)));
      }
      if(this.raw(key)!==undefined)this.set(key,asciiFallback);
    }
    integer(key){
      const raw=this.raw(key);if(raw===undefined)return 0;
      if(!/^[+-]?\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw Error("Invalid source coordinate "+key+".");
      return Number(raw);
    }
    ticks(key){return this.integer(key)*100000+this.integer(key+"_Frac");}
    coordinate(key,value){
      if(!Number.isSafeInteger(value)||Math.abs(value)>2147483647*100000)throw Error("Altium coordinate is out of range.");
      const whole=Math.trunc(value/100000),fraction=value-whole*100000;
      if(this.ticks(key)===value)return;
      this.set(key,String(whole));
      if(fraction||this.raw(key+"_Frac")!==undefined)this.set(key+"_Frac",String(fraction));
    }
    resizeWire(count,previous){
      if(previous===count)return;
      for(const key of this.index.keys()){
        const coord=/^[XY](\d+)(?:_FRAC)?$/.exec(key);
        if((coord&&Number(coord[1])>previous)||(!coord&&/\d+(?:_FRAC)?$/.test(key)))throw Error("A wire has extra indexed fields. Its vertex count cannot be changed safely.");
      }
      if(count<previous){
        this.fields=this.fields.filter(field=>{
          const m=/^[XY](\d+)(?:_FRAC)?=/i.exec(field);return !m||Number(m[1])<=count;
        });
        this.reindex();
      }
      this.set("LocationCount",String(count));
    }
    output(){return this.dirty?bytesOf(this.fields.join("|")+this.tail):this.bytes;}
  }
  function split(bytes){
    const records=[];
    let n=0,header;
    while(n<bytes.length){
      const found=AtriumAltiumRecords.frame(bytes,n,4,["Truncated SchDoc record header.","Truncated SchDoc record."]);
      n=found.end;
      const record=new Record(found.payload,found.flag);
      if(!records.length && record.raw("HEADER")){
        if(header)throw Error("Multiple schematic record headers cannot be mapped unambiguously.");
        header=record;
      }else records.push(record);
    }
    if(!header)throw Error("A binary Altium schematic FileHeader is required.");
    return {header,records};
  }
  function join(records,parts){
    const out=new Uint8Array(parts.reduce((size,p)=>size+4+p.length,0)),view=new DataView(out.buffer);
    let offset=0;
    for(let i=0;i<parts.length;i++){
      const p=parts[i];if(p.length>0xffffff)throw Error("Altium schematic record is too large.");
      view.setUint32(offset,records[i].flags*0x1000000+p.length,true);out.set(p,offset+4);offset+=4+p.length;
    }
    return out;
  }
  function setWirePoints(record,points){
    const count=record.integer("LocationCount");
    if(!Array.isArray(points)||points.length<2||points.length>100000)throw Error("Invalid SchDoc wire vertex count.");
    record.resizeWire(points.length,count);
    for(let k=0;k<points.length;k++){
      const p=points[k];if(!Array.isArray(p)||p.length!==2)throw Error("Invalid SchDoc wire coordinate.");
      if(k>=count){record.set("X"+(k+1),"0");record.set("Y"+(k+1),"0");}
      record.coordinate("X"+(k+1),tickOf(p[0]));record.coordinate("Y"+(k+1),tickOf(-p[1]));
    }
  }
  function appendWiring(streams,header,records,context,changes){
    const additions=context.additions||[],appended=new Map();
    if(!additions.length)return appended;
    if(header.raw("HEADER")!=="Protel for Windows - Schematic Capture Binary File Version 5.0" ||
        header.raw("Weight")===undefined || header.integer("Weight")!==records.length || records[0]?.raw("RECORD")!=="31" ||
        records.some(r=>r.flags) || [...streams.keys()].some(path=>!["fileheader","storage","additional"].includes(path)) ||
        (streams.get("additional")?.length && split(streams.get("additional")).records.length))
      throw Error("This sheet layout cannot append new or unlinked wires or junctions. Use a Waffle or KiCad export.");
    const styleByRecord=new Map(context.beforeDoc.items.filter(i=>i.schSource).map(i=>[i.schSource.record,i.schPaint]));
    const templates={wire:[],junction:[]},uids=new Set();
    if(header.raw("UniqueID"))uids.add(header.raw("UniqueID").toUpperCase());
    let highestIndex=-1;
    for(let n=0;n<records.length;n++){
      const r=records[n],uid=r.raw("UniqueID");
      if(uid)uids.add(uid.toUpperCase());
      if(r.raw("OwnerIndex")!==undefined && r.raw("OwnerIndex")!=="-1")continue;
      if(r.raw("IndexInSheet")!==undefined)highestIndex=Math.max(highestIndex,r.integer("IndexInSheet"));
      const t=r.raw("RECORD"),kind=t==="27"?"wire":t==="29"?"junction":null;
      if(!kind || r.raw("OwnerPartId")!=="-1" || r.raw("IndexInSheet")===undefined)continue;
      // Do not inherit locks, harness associations, record extensions or other
      // unmodelled attributes by copying a random wire from a sheet.
      const allowed=kind==="wire"?/^(RECORD|INDEXINSHEET|OWNERINDEX|OWNERPARTID|UNIQUEID|LINEWIDTH|COLOR|AREACOLOR|LOCATIONCOUNT|[XY]\d+(_FRAC)?)$/:
        /^(RECORD|INDEXINSHEET|OWNERINDEX|OWNERPARTID|UNIQUEID|COLOR|LOCATION\.[XY](_FRAC)?)$/;
      if([...r.index.keys()].some(key=>!allowed.test(key)) || uid && !/^[A-Z]{8}$/.test(uid))continue;
      if(kind==="wire" && (!uid || r.integer("IndexInSheet")<0) || kind==="junction" && r.integer("IndexInSheet")!==-1)continue;
      templates[kind].push({r,paint:styleByRecord.get(n)});
    }
    function uniqueID(id){
      for(let n=0;;n++){
        const digest=AtriumSourceFile.sha256(encoder.encode("Waffle/SchDoc/"+id+"/"+n));
        let text="";for(let i=0;i<16;i+=2)text+=String.fromCharCode(65+parseInt(digest.slice(i,i+2),16)%26);
        if(!uids.has(text)){uids.add(text);return text;}
      }
    }
    for(const item of additions){
      const w=item.kind==="wire",allowed=w?["id","kind","points","schPaint"]:["id","kind","x","y","schPaint"];
      if(!templates[item.kind] || Object.keys(item).some(k=>!allowed.includes(k)))throw Error("New "+item.kind+" has a field that cannot be written to this Altium sheet.");
      const template=templates[item.kind].find(t=>!item.schPaint || same(t.paint,item.schPaint));
      if(!template)throw Error("No compatible native "+item.kind+" template exists on this sheet.");
      const r=new Record(template.r.bytes,0);
      if(r.raw("UniqueID")!==undefined)r.set("UniqueID",uniqueID(item.id));
      if(w){
        if(highestIndex>=2147483646)throw Error("The sheet object index exceeds its native range.");
        r.set("IndexInSheet",String(++highestIndex));setWirePoints(r,item.points);
        for(let i=1;i<item.points.length;i++)if(tickOf(item.points[i][0])===tickOf(item.points[i-1][0]) && tickOf(item.points[i][1])===tickOf(item.points[i-1][1]))
          throw Error("A new wire has a zero-length native segment.");
      }else{
        r.coordinate("Location.X",tickOf(item.x));r.coordinate("Location.Y",tickOf(-item.y));
      }
      if(appended.has(item.id))throw Error("Two new schematic objects share an identity.");
      const record=records.length;appended.set(item.id,{record,role:item.kind});records.push(r);
      changes.push({record,field:"Added "+item.kind,before:"—",after:w?item.points:[item.x,item.y]});
    }
    header.set("Weight",String(records.length));
    return appended;
  }
  const ignored=new Set(["id","def","link","schSource"]);
  function plan(streams,edits,context={}){
    const source=streams.get("fileheader");if(!source)throw Error("Missing SchDoc FileHeader stream.");
    const {header,records}=split(source),children=new Map(),changes=[],renamed=new Map();
    for(let i=0;i<records.length;i++){
      const owner=records[i].raw("OWNERINDEX");
      if(owner===undefined)continue;
      if(!/^-?\d+$/.test(owner))throw Error("Invalid schematic owner index.");
      const index=Number(owner);if(index<0)continue;
      if(!children.has(index))children.set(index,[]);children.get(index).push(i);
    }
    function childText(index,type,allow){
      const found=(children.get(index)||[]).filter(i=>records[i].raw("RECORD")===type&&allow(records[i].text("Name").toUpperCase()));
      if(found.length>1)throw Error("Multiple source parameter records match this component. Edit them in Altium.");
      return found[0];
    }
    function moveOwned(index,dx,dy){
      if(records.some(r=>r.flags))throw Error("Component movement requires all pin and child records to use the supported text layout.");
      const additional=streams.get("additional");
      if(additional?.length && split(additional).records.length)throw Error("This sheet has additional object records. Component translation cannot account for their positions.");
      const pending=[index],visited=new Set();
      for(let cursor=0;cursor<pending.length;cursor++){
        const n=pending[cursor],r=records[n],type=Number(r.raw("RECORD"));
        if(visited.has(n))throw Error("Cyclic component ownership in source schematic.");visited.add(n);
        for(const child of children.get(n)||[])pending.push(child);
        function shift(x,y){
          if(r.raw(x)===undefined&&r.raw(y)===undefined&&r.raw(x+"_Frac")===undefined&&r.raw(y+"_Frac")===undefined)throw Error("A component child has no explicit coordinate pair for translation.");
          if(dx)r.coordinate(x,r.ticks(x)+dx);if(dy)r.coordinate(y,r.ticks(y)+dy);
        }
        if([1,2,4,8,11,12,17,25,29,34,41].includes(type))shift("Location.X","Location.Y");
        else if([10,13,14].includes(type)){shift("Location.X","Location.Y");shift("Corner.X","Corner.Y");}
        else if([6,7,27].includes(type)){
          const count=r.integer("LocationCount");if(count<1||count>r.fields.length)throw Error("Invalid component primitive vertex count.");
          for(let k=1;k<=count;k++)shift("X"+k,"Y"+k);
        }else if(![44,45,46,47,48].includes(type))throw Error("Component owns unsupported schematic record "+type+". Its placement cannot be transferred.");
      }
    }
    for(const {before,after} of edits){
      const sourceId=before?.schSource;
      if(!before||!after||!sourceId||!Number.isInteger(sourceId.record)||!same(sourceId,after.schSource))throw Error("A schematic object has no matching original record. New or removed schematic objects cannot be transferred.");
      const index=sourceId.record,record=records[index];if(!record||record.flags)throw Error("The original schematic record is unavailable.");
      const type=Number(record.raw("RECORD")),kind=before.kind,role=sourceId.role;
      const fields=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>!ignored.has(k)&&!same(before[k],after[k]));
      const part=kind==="part"&&role==="part"&&type===1, wire=kind==="wire"&&role==="wire"&&type===27;
      const point=(role==="junction"&&type===29) || (role==="label"&&type===4) || (role==="netlabel"&&[17,25].includes(type));
      const port=role==="portLabel"&&type===18;
      const allow=part?["ref","value","x","y"]:wire?["points"]:point?(kind==="junction"?["x","y"]:["x","y","text"]):port?["text"]:[];
      const bad=fields.find(k=>!allow.includes(k));if(bad)throw Error((before.ref||kind)+" · "+bad+" cannot be transferred to this Altium schematic record.");
      if(part&&(fields.includes("x")||fields.includes("y")))moveOwned(index,tickOf(after.x)-tickOf(before.x),tickOf(-after.y)-tickOf(-before.y));
      for(const field of fields){
        let target=index;
        if(field==="ref"||field==="value"){
          if(field==="ref")target=childText(index,"34",()=>true);
          else{
            const direct=childText(index,"41",s=>s==="VALUE");
            target=direct!==undefined&&records[direct].text("Text")?direct:childText(index,"41",s=>s==="COMMENT");
          }
          if(target===undefined)throw Error("No writable source "+field+" record exists for "+before.ref+".");
          const old=records[target].text("Text");
          if(old.startsWith("=")||old!==before[field])throw Error(before.ref+" uses a computed or inherited "+field+". Its source expression must be edited in Altium.");
          if(field==="ref")renamed.set(target,after.ref);
          records[target].setText("Text",after[field]);
        }else if(field==="text")record.setText(port&&record.text("Name").trim()?"Name":"Text",after.text);
        else if(point&&(field==="x"||field==="y")){
          const key=field==="x"?"Location.X":"Location.Y",value=tickOf(field==="x"?after.x:-after.y),delta=value-record.ticks(key);
          // An off-sheet connector's CrossRef parameters have absolute sheet coordinates.
          if(type===17 && delta)for(const n of children.get(index)||[]){
            const child=records[n];
            if(child.raw("RECORD")==="41" && child.text("Name").toUpperCase()==="CROSSREF")child.coordinate(key,child.ticks(key)+delta);
          }
          record.coordinate(key,value);
        }
        else if(wire&&field==="points"){
          setWirePoints(record,after.points);
        }
        changes.push({record:target,field,before:before[field],after:after[field]});
      }
    }
    if(renamed.size){
      const used=new Map();
      for(let n=0;n<records.length;n++){
        if(records[n].raw("RECORD")!=="34")continue;
        const name=String(renamed.get(n)??records[n].text("Text")).trim().toUpperCase();
        if(used.has(name)&&(renamed.has(n)||renamed.has(used.get(name))))throw Error("The edited schematic designator already exists: "+name);
        used.set(name,n);
      }
    }
    const originalLength=records.length,appended=appendWiring(streams,header,records,context,changes);
    const frames=[header,...records],parts=frames.map(r=>r.output()),touched=appended.size?["FileHeader header"]:[];
    for(let i=0;i<records.length;i++){
      const record=records[i],bytes=parts[i+1];
      if(i>=originalLength||record.dirty&&(bytes.length!==record.bytes.length||bytes.some((value,n)=>value!==record.bytes[n])))touched.push(i);
    }
    return {appended,records:touched,replacements:touched.length?new Map([["fileheader",join(frames,parts)]]):new Map(),changes};
  }
  return {plan};
})();
