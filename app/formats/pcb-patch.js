"use strict";
if (!globalThis.AtriumAltiumRecords) { if (typeof importScripts === "function" && !globalThis.AtriumEmbeddedTranslatorScripts) importScripts("../formats/altium-records.js"); else if (typeof require === "function") require("./altium-records.js"); }

// The importer records the original Altium stream and ordinal on each item. Only
// supported coordinates, dimensions and net/layer fields are rewritten. Unknown
// bytes, including version-specific trailing properties, are copied verbatim.
globalThis.AtriumPCBPatch = (() => {
  const UNIT = 0.00000254; // mm per Altium internal coordinate unit
  const NONE = 0xffff;
  const knownTop = 0x01000001, knownBottom = 0x0100ffff;
  function same(a,b) {
    if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));
    if(a&&b&&typeof a==="object"&&typeof b==="object")return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
    return a===b;
  }
  function fail(record,message){throw Error(record+" — "+message);}
  function units(value,record,positive=false){
    const n=Math.round(value/UNIT);
    if(!Number.isFinite(value)||n< -2147483648||n>2147483647||(positive&&n<=0))fail(record,"Value is outside the representable PCB range.");
    return n;
  }
  function code(layer){
    if(layer==="Top")return 1;
    if(layer==="Bottom")return 32;
    const m=/^Inner ([1-9]|[12]\d|30)$/.exec(layer);return m?Number(m[1])+1:null;
  }
  function frames(source,type,path){
    const data=new DataView(source.buffer,source.byteOffset,source.byteLength),result=[];
    for(let start=0;start<source.length;){
      if(start+5>source.length||source[start]!==type)fail(path,"Unexpected record framing.");
      const length=data.getUint32(start+1,true)&0xffffff, pos=start+5;
      if(pos+length>source.length||length<(type===1?45:type===4?36:31))fail(path,"Truncated or unrecognised PCB record.");
      result.push({pos,length});start=pos+length;
    }
    return result;
  }
  function indexes(names){
    const result=new Map();
    names.forEach((name,i)=>result.set(name,result.has(name)?null:i));
    return result;
  }
  function layerIds(data,rows){
    const byLayer=new Map([[1,knownTop],[32,knownBottom]]);
    for(const {pos,length} of rows){
      const old=data.getUint8(pos);
      if(old<1||old>32)continue;
      if(!byLayer.has(old))byLayer.set(old,0);
      const v7=length>=45?data.getUint32(pos+41,true):0;
      if(!v7)continue;
      const previous=byLayer.get(old);
      if(Math.floor(v7/65536)!==0x100||(previous!==0&&previous!==v7))byLayer.set(old,null);
      else byLayer.set(old,v7);
    }
    return byLayer;
  }
  function standalone(streams,edits){
    const replacements=new Map(),changes=[],groups=new Map(),seen=new Set();
    const names=AtriumPCB.netNames(streams),nets=indexes(names);
    for(const {before,after} of edits){
      const record=before?.sourceRecord;
      if(!record||after?.sourceRecord!==record||seen.has(record))fail(record||"PCB","Missing, repeated or changed source identity.");
      seen.add(record);
      const fields=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>k!=="id"&&k!=="sourceRecord"&&!same(before[k],after[k]));
      if(!fields.length)continue;
      const match=/^((tracks6|vias6|arcs6)\/data)#(0|[1-9]\d*)$/.exec(record);
      if(!match)fail(record,"Only existing standalone copper tracks and vias, and standalone arcs, support native changes.");
      const track=match[2]==="tracks6",arc=match[2]==="arcs6";
      const supported=arc?["arc","points","width","net"]:track?["width","net","points","layer"]:["x","y","net","diameter","drill"];
      if((arc?!["graphic","track"].includes(before.kind):before.kind!==(track?"track":"via"))||fields.some(k=>!supported.includes(k)))fail(record,"Unsupported source edit ("+fields.join(", ")+").");
      const path=match[1],index=Number(match[3]);
      if(!groups.has(path)){
        const source=streams.get(path);if(!source)fail(path,"Source stream is missing.");
        const rows=frames(source,arc?1:track?4:3,path),bytes=new Uint8Array(source),data=new DataView(bytes.buffer);
        groups.set(path,{source,bytes,data,rows,touched:[],layerIds:track?layerIds(data,rows):null});
      }
      const g=groups.get(path),frame=g.rows[index];
      if(!frame)fail(record,"Source record is missing.");
      const {pos,length}=frame, d=g.data;
      const byte=k=>d.getUint8(pos+k),short=k=>d.getUint16(pos+k,true),int=k=>d.getInt32(pos+k,true),u32=k=>d.getUint32(pos+k,true);
      const setInt=(offset,n)=>d.setInt32(pos+offset,n,true);
      const requireSame=(ok)=>{if(!ok)fail(record,"Record fields differ from the source import.");};
      if(short(7)!==NONE||short(5)!==NONE||AtriumPCB.primitiveLocked(g.bytes,pos))fail(record,"Owned, polygon-generated or locked copper requires editing in Altium.");
      if(track&&((byte(1)&2)!==0||(byte(2)&2)!==0||(length>=40&&u32(36)!==0)))fail(record,"Polygon, keepout and union tracks require editing in Altium.");
      const oldNet=short(3);requireSame(before.net===(oldNet===NONE?"":names[oldNet]||"Net "+oldNet));
      if(arc){
        const s=Atrium.pathArc(before),g=Atrium.pathArc(after);
        if(!s||!g||!g.ccw)fail(record,"A native Altium arc needs one counter-clockwise circular path.");
        if(![56,60].includes(length)||(byte(1)&2)||u32(45)!==0)fail(record,"This arc has an unsupported layout or belongs to a polygon or union.");
        const signedRadius=int(21),shift=signedRadius<0?180:0;
        const angle=k=>d.getFloat64(pos+k,true)+shift;
        requireSame(s.ccw && units(s.c[0],record)===int(13) && units(-s.c[1],record)===int(17) &&
          units(s.r,record,true)===Math.abs(signedRadius) && units(before.width,record)===int(41) &&
          (s.start===angle(25)||s.start===Atrium.projectNumber(angle(25))) && (s.end===angle(33)||s.end===Atrium.projectNumber(angle(33))));
        if(fields.includes("arc")){
          setInt(13,units(g.c[0],record));setInt(17,units(-g.c[1],record));
          setInt(21,(signedRadius<0?-1:1)*units(g.r,record,true));
          d.setFloat64(pos+25,g.start-shift,true);d.setFloat64(pos+33,g.end-shift,true);
        }
        if(fields.includes("width"))setInt(41,units(after.width,record,true));
      }else if(track){
        if(!Array.isArray(after.points)||after.points.length!==2||after.points.some(p=>!Array.isArray(p)||p.length!==2))fail(record,"A native track must have exactly two endpoints.");
        requireSame(Array.isArray(before.points)&&before.points.length===2&&code(before.layer)===byte(0)&&units(before.width,record,true)===int(29));
        let points=[];
        for(let i=0;i<2;i++){
          const x=13+8*i,y=x+4;
          requireSame(units(before.points[i][0],record)===int(x)&&units(-before.points[i][1],record)===int(y));
          if(!after.points[i].every(Number.isFinite))fail(record,"Endpoint coordinates must be finite numbers.");
          points.push([units(after.points[i][0],record),units(-after.points[i][1],record)]);
        }
        if(fields.includes("points")){
          if(same(points[0],points[1]))fail(record,"A native track needs distinct endpoints.");
          for(let i=0;i<2;i++){setInt(13+8*i,points[i][0]);setInt(17+8*i,points[i][1]);}
        }
        if(fields.includes("width"))setInt(29,units(after.width,record,true));
        if(fields.includes("layer")){
          const next=code(after.layer),old=byte(0),extended=length>=45&&u32(41);
          if(!next||(!g.layerIds.has(next)&&![1,32].includes(next)))fail(record,"The target copper layer has no source mapping.");
          if(length>36&&length<45)fail(record,"This track uses an unfamiliar extended layer record.");
          if(extended){
            if(g.layerIds.get(old)!==extended||!g.layerIds.get(next))fail(record,"The extended copper layer mapping is ambiguous.");
            d.setUint32(pos+41,g.layerIds.get(next),true);
          }
          d.setUint8(pos,next);
        }
      }else{
        requireSame(units(before.x,record)===int(13)&&units(-before.y,record)===int(17)&&units(before.diameter,record,true)===int(21)&&units(before.drill,record,true)===int(25));
        const diameter=units(after.diameter,record,true),drill=units(after.drill,record,true);
        if(diameter<=drill)fail(record,"Via copper diameter must exceed the finished drill diameter.");
        if(fields.includes("x"))setInt(13,units(after.x,record));
        if(fields.includes("y")){
          if(!Number.isFinite(after.y))fail(record,"Via coordinates must be finite numbers.");
          setInt(17,units(-after.y,record));
        }
        if(fields.includes("drill")||fields.includes("diameter")){
          const old=int(21);
          if(length>74){
            if(length<203||byte(74)!==0)fail(record,"This via has an unsupported per-layer pad stack.");
            for(let i=0;i<32;i++){
              const k=75+i*4,value=int(k);
              if(value!==0&&value!==old)fail(record,"This via has different per-layer copper diameters.");
              if(value===old&&fields.includes("diameter"))setInt(k,diameter);
            }
          }
          if(fields.includes("diameter"))setInt(21,diameter);
          if(fields.includes("drill"))setInt(25,drill);
        }
      }
      if(fields.includes("net")){
        const net=after.net===""?NONE:nets.get(after.net);
        if(!Number.isInteger(net)||(net>=NONE&&after.net!==""))fail(record,"Choose one existing unambiguous net or clear the net.");
        d.setUint16(pos+3,net,true);
      }
      if(g.bytes.subarray(pos,pos+length).some((value,n)=>value!==g.source[pos+n]))g.touched.push(index);
      for(const field of fields)changes.push({record,field,before:before[field],after:after[field]});
    }
    const records=[];
    for(const path of [...groups.keys()].sort()){
      const group=groups.get(path);
      if(!group.touched.length)continue;
      replacements.set(path,group.bytes);
      for(const index of group.touched.sort((a,b)=>a-b))records.push(path+"#"+index);
    }
    return {records,replacements,changes};
  }
  // A placement consists of an ASCII property record and separate primitives in
  // absolute board coordinates. The binary owner is a component index, never a
  // designator. Refuse an unfamiliar primitive layout before emitting a copy.
  /** @type {Map<string, [number, number[], number[]]>} */
  const sections=new Map([
    ["arcs6",[1,[56,60],[13]]],["pads6",[2,[180,185,202],[13]]],
    ["vias6",[3,[316],[13]]],["tracks6",[4,[49],[13,21]]],
    ["texts6",[5,[240,252],[13]]],["fills6",[6,[50],[13,21]]],
    ["texts",[5,[],[]]],["regions6",[11,[],[]]],["shapebasedregions6",[11,[],[]]],
    ["boardregions",[11,[],[]]],["componentbodies6",[12,[],[]]],["shapebasedcomponentbodies6",[12,[],[]]]
  ]);
  const ancillary=new Set(("board6|components6|nets6|rules6|classes6|signalclasses|boardoutline|" +
    "connections6|fileversioninfo|layerkindmapping|models|modelsembedded|widestrings6|" +
    "advanced placer options6|constraintmanager|design rule checker options6|pin swap options6|" +
    "primitiveparameters|primitiveguids|uniqueidprimitiveinformation|extendedprimitiveinformation|" +
    "padvialibrary|padvialibrarycache|unionnames|simbeorcachesection|drillmanager|" +
    "embeddedfonts6|lettersgeometry").split("|"));
  function blockAt(bytes,pos,path){
    try{
      const found=AtriumAltiumRecords.frame(bytes,pos,4,["Truncated PCB subrecord length.","Truncated PCB subrecord."]);
      return {start:found.start,end:found.end,size:found.size};
    }catch(error){fail(path,error.message);}
  }
  function rawString(bytes){
    let value="";for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return value;
  }
  function propBlocks(bytes,path){
    const records=[];
    for(let pos=0;pos<bytes.length;){
      const block=blockAt(bytes,pos,path);
      if(!block.size)fail(path,"An empty property record makes the component order ambiguous.");
      const raw=rawString(bytes.subarray(block.start,block.end));
      records.push({pos,block,raw});pos=block.end;
    }
    return records;
  }
  function prop(raw,key,path){
    const matches=[...raw.matchAll(new RegExp("(?:^|\\|)"+key+"=([^|\\x00]*)","gi"))];
    if(matches.length>1 || new RegExp("(?:^|\\|)%UTF8%"+key+"=","i").test(raw))fail(path,"Ambiguous "+key+" in the source component.");
    return matches[0]?.[1];
  }
  function ticks(raw,path){
    const match=/^\s*([-+]?(?:\d+\.?\d*|\.\d+))mil\s*$/i.exec(raw||"");
    if(!match)fail(path,"The source placement requires explicit X and Y in mil.");
    return units(Number(match[1])*.0254,path);
  }
  function writeProps(source,records){
    const length=records.reduce((n,r)=>n+4+(r.output??r.raw).length,0);
    const out=new Uint8Array(length),view=new DataView(out.buffer);let pos=0;
    for(const r of records){
      if(r.output===undefined){
        const original=source.subarray(r.pos,r.block.end);out.set(original,pos);pos+=original.length;continue;
      }
      if(r.output.length>0xffffff)fail("Components6","Component property record is too large.");
      view.setUint32(pos,r.output.length,true);out[pos+3]=source[r.pos+3];pos+=4;
      for(let i=0;i<r.output.length;i++)out[pos++]=r.output.charCodeAt(i);
    }
    return out;
  }
  function placements(streams,edits){
    const path="components6/data",source=streams.get(path);
    if(!source)fail(path,"The supported Components6 placement stream is missing.");
    const components=propBlocks(source,path),byOwner=new Set(),moves=new Map(),changes=[],records=[],replacements=new Map();
    const ownerAt=components.map(({raw},index)=>{
      const id=prop(raw,"ID",path),owner=id===undefined?index:Number(id);
      if(id!==undefined && !/^\d+$/.test(id) || !Number.isInteger(owner)||owner<0||owner>=NONE||byOwner.has(owner))fail(path,"Component ownership is ambiguous.");
      byOwner.add(owner);return owner;
    });
    for(const {before,after} of edits){
      const id=before.sourceRecord,m=/^components6\/data#(0|[1-9]\d*)$/.exec(id);
      if(!m || after.sourceRecord!==id || !components[+m[1]])fail(id,"Source component is missing.");
      const index=Number(m[1]),owner=ownerAt[index],r=components[index];
      const fields=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>k!=="id"&&!same(before[k],after[k]));
      if(before.kind!=="part" || fields.some(f=>f!=="x"&&f!=="y"))fail(id,"Only X/Y translation of an existing footprint is supported.");
      if(!fields.length)continue;
      if(/^true$|^t$|^1$/i.test(prop(r.raw,"LOCKED",id)||"") || Number(prop(r.raw,"UNIONINDEX",id)||0)!==0 || Number(prop(r.raw,"GROUPNUM",id)||0)!==0)
        fail(id,"Locked or grouped footprints require editing in Altium.");
      const oldX=ticks(prop(r.raw,"X",id),id),oldY=ticks(prop(r.raw,"Y",id),id);
      if(units(before.x,id)!==oldX || units(-before.y,id)!==oldY)fail(id,"Component coordinates differ from the source.");
      const x=units(after.x,id),y=units(-after.y,id);
      for(const field of fields)changes.push({record:id,field,before:before[field],after:after[field]});
      if(oldX===x && oldY===y)continue;
      const coords={X:x,Y:y};let output=r.raw;
      for(const key of ["X","Y"]){
        if(coords[key]===(key==="X"?oldX:oldY))continue;
        output=output.replace(new RegExp("(^|\\|)("+key+"=)[^|\\x00]*","i"),(_,p,k)=>p+k+(coords[key]/10000)+"mil");
      }
      r.output=output;moves.set(owner,{dx:x-oldX,dy:y-oldY,id});records.push(id);
    }
    if(!moves.size)return {replacements,records,changes};
    for(const [stream,bytes] of streams){
      if(!bytes.length || !/^[^/]+\/data$/.test(stream))continue;
      const section=stream.split("/")[0],layout=sections.get(section);
      // Cached DRC and ratsnest results are retained, like standalone copper edits.
      if(ancillary.has(section) || /^t.+viola(?:tion)?/.test(section))continue;
      if(section==="polygons6" || section==="embeddedboards6"){
        for(const r of propBlocks(bytes,stream)){
          const owned=prop(r.raw,"COMPONENT",stream);
          if(owned!==undefined && moves.has(Number(owned)))fail(moves.get(Number(owned)).id,"A footprint owns an unsupported "+section+" record.");
        }
        continue;
      }
      if(!layout)fail(stream,"This PCB section has no known placement ownership layout.");
      const [type,sizes,coordinateOffsets]=layout,data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      let written=null,output=null,entry=0;
      for(let pos=0;pos<bytes.length;entry++){
        if(bytes[pos++]!==type)fail(stream,"Unexpected footprint primitive record.");
        let geom=blockAt(bytes,pos,stream);pos=geom.end;
        if(type===2){
          // Name plus three auxiliary subrecords precede pad geometry, followed by the pad stack.
          for(let n=0;n<4;n++){geom=blockAt(bytes,pos,stream);pos=geom.end;}
          pos=blockAt(bytes,pos,stream).end;
        }else if(type===5){pos=blockAt(bytes,pos,stream).end;}
        if(geom.size<9)fail(stream,"Missing footprint owner in primitive record.");
        const owner=data.getUint16(geom.start+7,true),move=moves.get(owner);if(!move)continue;
        const key=stream+"#"+entry;
        if(!coordinateOffsets.length || !sizes.includes(geom.size))fail(move.id,"The footprint owns an unsupported "+key+" record. Move this placement in Altium.");
        if(data.getUint16(geom.start+5,true)!==NONE)fail(key,"Polygon-owned footprint geometry cannot be translated.");
        if(!written){written=new Uint8Array(bytes);output=new DataView(written.buffer);}
        const offsets=type===5 && geom.size>=252 && bytes[geom.start+240] ? [...coordinateOffsets,244] : coordinateOffsets;
        for(const offset of offsets){
          for(const [axis,delta] of [[0,move.dx],[4,move.dy]]){
            const at=geom.start+offset+axis,v=data.getInt32(at,true)+delta;
            if(v < -2147483648 || v > 2147483647)fail(key,"Moving this footprint would exceed PCB coordinate limits.");
            output.setInt32(at,v,true);
          }
        }
        records.push(key);
      }
      if(written)replacements.set(stream,written);
    }
    replacements.set(path,writeProps(source,components));
    return {replacements,records,changes};
  }
  function plan(streams,edits){
    const partEdits=[],copperEdits=[],seen=new Set();
    for(const edit of edits){
      const key=edit.before?.sourceRecord;
      if(!key || seen.has(key))fail(key||"PCB","Missing or repeated source identity.");
      seen.add(key);
      if(edit.before.kind==="part")partEdits.push(edit);else copperEdits.push(edit);
    }
    const copper=standalone(streams,copperEdits);
    if(!partEdits.length)return copper;
    // A stream can contain both owned artwork and an independently edited track.
    const combined=new Map(streams);for(const [path,bytes] of copper.replacements)combined.set(path,bytes);
    const parts=placements(combined,partEdits);
    for(const [path,bytes] of parts.replacements)copper.replacements.set(path,bytes);
    return {replacements:copper.replacements,records:[...copper.records,...parts.records],changes:[...copper.changes,...parts.changes]};
  }
  return {plan};
})();
