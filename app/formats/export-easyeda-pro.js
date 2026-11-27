"use strict";
globalThis.AtriumEasyEDAProWriter = (() => {
  const basic={Top:1,Bottom:2,Silk:3,"Bottom silk":4,"Top mask":5,"Bottom mask":6,"Top paste":7,"Bottom paste":8,"Mechanical 13":9,"Mechanical 14":10,Outline:11,Multi:12,Mechanical:13};
  const titles={1:"TOP",2:"BOTTOM",3:"TOP_SILK",4:"BOTTOM_SILK",5:"TOP_SOLDER_MASK",6:"BOTTOM_SOLDER_MASK",7:"TOP_PASTE_MASK",8:"BOTTOM_PASTE_MASK",9:"TOP_ASSEMBLY",10:"BOTTOM_ASSEMBLY",11:"OUTLINE",12:"MULTI",13:"DOCUMENT"};
  const palette={1:"#ff0000",2:"#0000ff",3:"#ffcc00",4:"#33cc66",11:"#cc00cc"};
  const types={0:1,1:3,2:2,7:0}, loc=i=>[i.x,i.y];
  const encode=rows=>rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
  const uuid=key=>AtriumSourceFile.sha256(AtriumZip.utf8(key)).slice(0,32);
  const font=["FONTSTYLE","st2",null,null,null,7,null,null,null,null,0,0];
  const lineStyle=["LINESTYLE","st1",null,0,"",1];
  const attr=(id,parent,name,value,p=null,show=false)=>["ATTR",id,parent,name,String(value ?? ""),0,+show,p?.[0]??null,p?.[1]??null,0,"st2",0];
  function packageFiles(c,docs,stem) {
    const files=[], meta={schematics:{},pcbs:{},panels:{},symbols:{},footprints:{},devices:{},boards:{},config:{title:stem,cbbProject:false}};
    const fpIds=new Map(),symbolIds=new Map(),schematicParents=new Map(),pcbKeys=[];
    // A Pro Device and Unique ID bind a schematic placement to its board
    // footprint. A repeated R1 on a different source board has its own identity.
    const projects=new Map(), links=new Map();
    for(const d of docs){
      const src=c.source(d), projectKey=src?.manifest || c.project;
      if(!projects.has(projectKey))projects.set(projectKey,new Map());
      const manifest=src?.manifest, member=src?.path || "", pcb=/(?:^|\/)PCB\/([^/]+)\.epcb$/i.exec(member);
      const associations=Object.values(manifest?.boards || {}), sheet=/(?:^|\/)SHEET\/([^/]+)\//i.exec(member)?.[1];
      const group=sheet && associations.some(b=>b?.schematic===sheet)?sheet:(pcb && associations.find(b=>b?.pcb===pcb[1])?.schematic) || "";
      const groups=projects.get(projectKey);
      for(const i of d.items)if(i.kind==="part" && i.link){
        const key=JSON.stringify([group,i.link,i.ref]), def=c.defs.get(i.def);
        if(!groups.has(key))groups.set(key,{key:uuid("instance/"+d.id+"/"+i.id)});
        const pair=groups.get(key);links.set(i.id,pair);
        if(d.kind==="schematic"){if(pair.sym && pair.sym!==def)pair.ambiguous=true;pair.sym=def;}
        else{if(pair.pcb)pair.ambiguous=true;pair.pcb=i;pair.fp=def;}
      }
    }
    let seq=0,owner=null,doc;
    const allIds=new Set();
    for(const d of docs)for(const line of c.source(d)?.lines || []) {
      const m=/^\s*\[\s*"(?:LINE|ARC|VIA|PAD|POLY|FILL|POUR)"\s*,\s*"([^"]+)"/.exec(line);if(m)allIds.add(m[1]);
    }
    const id=()=>{let k;do{k="e"+(++seq);}while(allIds.has(k));return k;};
    const add=(kind,status,why,count)=>c.add(kind,status,doc,owner,why,count);
    const sp=p=>[c.round(p[0]/.254),c.round(-p[1]/.254)], bp=p=>[c.round(p[0]/.0254),c.round(-p[1]/.0254)];
    const mil=n=>c.round(n/.0254);
    const layerNumber=name=>{const m=/^Inner (\d+)$/.exec(name || "");return basic[name] || (m && +m[1]>=1 && +m[1]<=32?14 + +m[1]:0);};
    const pack=(name,rows)=>files.push({name,data:encode(rows)});
    const header=(type,format,info)=>[["DOCTYPE",type,format],["HEAD",info]];
    function outlinePoints(sh) {
      if(sh.points?.length>=2)return sh.points;
      return null;
    }
    function symbol(def,flag=false) {
      const geo=flag?null:def?.symbol;if(!geo && !flag)return null;
      const name=flag ? "Net flag" : def.name || def.id, key=flag?"easyeda-netflag":def.id;
      if(symbolIds.has(key))return symbolIds.get(key);
      const sid=uuid("symbol/"+key),kind=flag?18:2;
      symbolIds.set(key,sid);meta.symbols[sid]={title:name,type:kind,desc:""};
      const rows=[...header("SYMBOL","1.1",{symbolType:kind,originX:0,originY:0,version:"2"}),lineStyle,font];
      const total=geo?.parts || 1;
      for(let unit=1;unit<=total;unit++){
        rows.push(["PART",flag?"":name+"."+unit,{}]);
        if(flag){
          const k=id();
          rows.push(["PIN",k,1,1,0,0,5,90,null,0,0],attr(id(),k,"NUMBER","1"),attr(id(),k,"NAME","NET"),["POLY",id(),[-3,5,3,5],0,"st1",0]);
          continue;
        }
        const part=Atrium.gate(geo,{unit});
        for(const sh of part.shapes || []){
          const k=id();let rec;
          if(sh.kind==="path" && sh.points?.length>=2)rec=["POLY",k,sh.points.flatMap(sp),+!!sh.closed,"st1",0];
          else if(sh.kind==="circle")rec=["CIRCLE",k,...sp(loc(sh)),c.round(sh.r/.254),"st1",0];
          else if(sh.kind==="text")rec=["TEXT",k,...sp(loc(sh)),-(sh.angle || 0),String(sh.text || ""),"st2",0];
          if(rec)rows.push(rec);add("Symbol artwork",rec?"approximated":"dropped",rec?"Geometry retained using Pro schematic artwork styles.":"Unsupported symbol geometry.");
        }
        for(const pin of part.pins || []){
          const k=id(),xy=sp(loc(pin)),v=types[pin.electrical]??0;
          rows.push(["PIN",k,pin.hidden?0:1,v,...xy,0,-(pin.angle || 0),null,0,0],attr(id(),k,"NUMBER",pin.number),attr(id(),k,"NAME",pin.name));
          add("Symbol pin",pin.electrical!=null && types[pin.electrical]==null?"approximated":"kept",pin.electrical!=null && types[pin.electrical]==null?"Electrical type mapped to unspecified.":undefined);
        }
      }
      pack("SYMBOL/"+sid+".esym",rows);return sid;
    }
    function boardPad(p,point,angle,l,net) {
      const w=mil(p.w),h=mil(p.h),drill=p.drill?mil(p.drill):0;
      const custom=Array.isArray(p.poly) && p.poly.length>=3;
      const shape=custom?["POLY",[["L",...p.poly.flatMap(bp)]]] : p.shape==="round" || p.shape==="oval" ? ["ROUND",w,h] :
        ["RECT",w,h,p.shape==="roundrect"?c.round(Math.min(w,h)*Atrium.padCornerRatio(p)):0];
      if(!custom && !["round","oval","rect","roundrect"].includes(p.shape))add("Pad outline","approximated","Exported using the pad width and height.");
      const mask=Number.isFinite(p.maskExpansion)?mil(p.maskExpansion):null,paste=Number.isFinite(p.pasteExpansion)?mil(p.pasteExpansion):null;
      return ["PAD",id(),0,String(net || ""),l,String(p.number ?? ""),...bp(point),c.round(-angle),drill?["ROUND",p.slotLength>p.drill?mil(p.slotLength):drill,drill]:null,shape,[],0,0,-(p.slotAngle || 0),p.plated===false?0:1,0,mask,mask,paste,paste,0,null,null,null,null,[]];
    }
    function drawing(rows,sh,point,layer,angle=0) {
      if(!layer)return false;
      if(sh.kind==="text" || sh.kind==="label"){
        rows.push(["STRING",id(),0,layer,...bp(point(loc(sh))),String(sh.text || ""),"default",mil(sh.size || 1),mil(sh.width || .13),0,0,3,c.round(-angle-(sh.angle || 0)),0,0,0,0]);return true;
      }
      if(sh.kind==="circle") {
        const p=bp(point(loc(sh)));rows.push(["POLY",id(),0,"",layer,mil(sh.width || .15),["CIRCLE",...p,mil(sh.r)],0]);return true;
      }
      const ps=outlinePoints(sh);if(!ps)return false;
      const p=ps.map(v=>bp(point(v)));
      if(sh.closed && !Atrium.same(p[0],p.at(-1)))p.push(p[0]);
      if(sh.fill)rows.push(["FILL",id(),0,String(sh.net || ""),layer,mil(sh.width || 0),0,[[...p[0],"L",...p.slice(1).flat()]],0]);
      else if(sh.kind==="track" || sh.kind==="path")for(let j=1;j<p.length;j++)rows.push(["LINE",id(),0,String(sh.net || ""),layer,...p[j-1],...p[j],mil(sh.width || .15),0]);
      else rows.push(["POLY",id(),0,String(sh.net || ""),layer,mil(sh.width || .15),[...p[0],"L",...p.slice(1).flat()],0]);
      return true;
    }
    function footprint(def,bottom=false,mirror=false) {
      // Pro board components have no mirror flag: a mirrored part uses its reflected footprint.
      const fp=Atrium.pcbMirror.placed({mirror},def?.footprint).footprint;if(!fp)return null;
      const name=(fp.name || def.name || def.id)+(mirror?" (mirrored)":""), key=def.id+"/"+bottom+(mirror?"/mirror":"");
      if(fpIds.has(key))return fpIds.get(key);
      const fid=uuid("footprint/"+key), pads=new Map(), defaultNets=new Map();
      const rows=header("FOOTPRINT","1.8",{editorVersion:"2.2",title:name});
      const pt=p=>bottom?[p[0],-p[1]]:p, lay=name=>layerNumber(bottom?({"Bottom":"Top","Bottom silk":"Silk","Bottom mask":"Top mask","Bottom paste":"Top paste"})[name] || name:name);
      for(const p of fp.pads || []){
        const l=lay(p.drill?"Multi":p.layer || "Top");if(!l){add("Footprint pad","dropped","Unmapped physical pad layer.");continue;}
        const native=bottom && (p.poly || p.slotAngle) ? {...p,slotAngle:-(p.slotAngle || 0),...(p.poly?{poly:p.poly.map(pt)}:{})}:p;
        const rec=boardPad(native,pt(loc(p)),bottom?-(p.angle||0):p.angle||0,l,"");rows.push(rec);
        const number=String(p.number??"");if(!pads.has(number))pads.set(number,[]);pads.get(number).push(rec[1]);if(p.net)defaultNets.set(number,p.net);add("Footprint pad","kept");
      }
      for(const sh of fp.shapes || []){
        const ok=drawing(rows,sh,pt,lay(sh.layer || (sh.style==="package"?"Mechanical 13":"Silk")));add("Footprint artwork",ok?"kept":"dropped",ok?undefined:"Unsupported footprint artwork or layer.");
      }
      const value={fid,pads,defaultNets};fpIds.set(key,value);meta.footprints[fid]={title:name,type:4,desc:""};pack("FOOTPRINT/"+fid+".efoo",rows);return value;
    }
    function device(def,sid,fp) {
      const did=uuid("device/"+def.id+"/"+(sid || "")+"/"+(fp?.fid || ""));
      if(!meta.devices[did])meta.devices[did]={title:def.name || def.id,attributes:{...def.parameters,...(sid?{Symbol:sid}:{}),...(fp?{Footprint:fp.fid}:{}),Value:String(def.value || "")},description:""};
      return did;
    }
    function placement(i,def,side,mirror=false) {
      const p=links.get(i.id), matched=p && !p.ambiguous && p.sym?.symbol && p.fp?.footprint;
      const symbolDef=matched?p.sym:def, footprintDef=matched?p.fp:def;
      const sid=symbolDef?.symbol?symbol(symbolDef):null, fp=footprint(footprintDef,matched?p.pcb.layer==="Bottom":side==="Bottom",matched?p.pcb.mirror===true:mirror);
      const key=matched?p.key:uuid("instance/"+i.id);
      return {sid,fp,key,did:device(symbolDef,sid,fp),part:(symbolDef.name || symbolDef.id)+"."+(i.unit || 1)};
    }
    function schematic(d) {
      const rows=[...header("SCH","1.1",{originX:0,originY:0,version:"2"}),lineStyle,font];
      const wires=d.items.filter(i=>i.kind==="wire" || i.kind==="bus"), wireIds=new Map(wires.map(w=>[w.id,id()]));
      const on=(p,a,b)=>Math.abs((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]))<=1e-7 && (p[0]-a[0])*(p[0]-b[0])+(p[1]-a[1])*(p[1]-b[1])<=1e-7;
      const at=(p,kind="wire")=>wires.find(w=>w.kind===kind && w.points.some((b,n)=>n && on(p,w.points[n-1],b)));
      const joints=d.items.filter(i=>i.kind==="junction").map(loc), jointKeys=new Set(joints.map(Atrium.pointKey));
      const labelWires=new Map(),named=new Map(), circuit=Atrium.connectivity(d,c.defs);
      for(const i of d.items)if(i.kind==="netlabel"){
        const w=at(loc(i)) || at(loc(i),"bus");if(!w)continue;
        labelWires.set(i.id,w);if(!named.has(w.id))named.set(w.id,new Set());named.get(w.id).add(i.text);
      }
      for(const i of d.items){
        c.check();owner=i;let ok=true,why;
        if(i.kind==="wire" || i.kind==="bus"){
          const k=wireIds.get(i.id), segs=[];
          let current=[];
          for(let j=1;j<i.points.length;j++) {
            const a=i.points[j-1],b=i.points[j],inner=joints.filter(p=>!Atrium.same(p,a)&&!Atrium.same(p,b)&&on(p,a,b)).sort((x,y)=>Math.hypot(x[0]-a[0],x[1]-a[1])-Math.hypot(y[0]-a[0],y[1]-a[1]));
            if(!current.length)current.push(...sp(a));
            for(const p of inner){current.push(...sp(p));segs.push(current);current=sp(p);}
            current.push(...sp(b));
            if(j<i.points.length-1 && jointKeys.has(Atrium.pointKey(b))){segs.push(current);current=sp(b);}
          }
          if(current.length>=4)segs.push(current);
          if(!segs.length)ok=false;else rows.push([i.kind==="wire"?"WIRE":"BUS",k,segs,"st1",0]);
          const net=i.net || circuit.byWire.get(i.id) || "";
          if(ok && !named.get(i.id)?.size)rows.push(attr(id(),k,"NET",net));
        } else if(i.kind==="junction"){
          ok=!!at(loc(i));why=ok?"Expressed through connected wire vertices.":undefined;
        } else if(i.kind==="netlabel"){
          const w=labelWires.get(i.id);
          if(w)rows.push(attr(id(),wireIds.get(w.id),"NET",i.text,sp(loc(i)),true));
          else {rows.push(["TEXT",id(),...sp(loc(i)),-(i.angle || 0),String(i.text),"st2",0]);why="Unattached net label preserved as visible text.";}
        } else if(i.kind==="label" || i.kind==="text")rows.push(["TEXT",id(),...sp(loc(i)),-(i.angle || 0),String(i.text || ""),"st2",0]);
        else if(i.kind==="graphic" && i.points?.length>=2)rows.push(["POLY",id(),i.points.flatMap(sp),+!!i.closed,"st1",0]);
        else if(i.kind==="part"){
          const def=c.defs.get(i.def);if(!def?.symbol)ok=false;
          else {
            const placed=placement(i,def),k=id(),xy=sp(loc(i));
            const angle=i.mirror?(i.angle || 0):-(i.angle || 0);
            rows.push(["COMPONENT",k,placed.part,...xy,angle,+!!i.mirror,{},0],attr(id(),k,"Device",placed.did),attr(id(),k,"Symbol",placed.sid),attr(id(),k,"Unique ID",placed.key),
              attr(id(),k,"Designator",i.ref,sp(Atrium.world(i.refAt || [-2.54,-2.54],i)),i.showRef!==false),attr(id(),k,"Value",i.value ?? def.value ?? "",sp(Atrium.world(i.valueAt || [-2.54,2.54],i)),i.showValue!==false));
            for(const [key,v] of Object.entries(i.parameters || {}))if(!["Unique ID","Device","Symbol","Designator","Value"].includes(key))rows.push(attr(id(),k,key,v));
          }
        }else if(["power","port","offsheet","offsheetconnector"].includes(i.kind)){
          const sid=symbol(null,true),k=id(),xy=sp(loc(i));rows.push(["COMPONENT",k,"",...xy,-(i.angle || 0),0,{},0],attr(id(),k,"Symbol",sid),attr(id(),k,"Global Net Name",i.text,xy,true));
          why="Named connection exported as a Pro net flag; native port appearance and direction differ.";
        } else ok=false;
        add(i.kind,ok?(why?"approximated":"kept"):"dropped",why || (ok?undefined:"No equivalent editable Pro schematic primitive was emitted."));
      }
      const source=c.source(d),legacy=/(?:^|\/)SHEET\/([^/]+)\//i.exec(source?.path || "");
      const identity=uuid("schematic/"+(legacy?legacy[1]:c.project.id || c.project.name));
      let group=meta.schematics[identity];if(!group)group=meta.schematics[identity]={name:legacy && source.manifest?.schematics?.[legacy[1]]?.name || d.name,sheets:[]};
      if(legacy)schematicParents.set(source.manifest, new Map([...(schematicParents.get(source.manifest) || []),[legacy[1],identity]]));
      const sheet=group.sheets.length+1;group.sheets.push({id:sheet,name:d.name,uuid:uuid("sheet/"+d.id)});
      pack("SHEET/"+identity+"/"+sheet+".esch",rows);
    }
    function pcb(d) {
      const out=[],nets=new Set(), usedLayers=new Set([1,2,3,4,11,12]);
      const layer=name=>{const l=layerNumber(name);if(l)usedLayers.add(l);return l;};
      const pcbAttr=(parent,key,val,l=3,x=null,y=null,show=false)=>["ATTR",id(),0,parent,l,x,y,key,String(val??""),0,+show,"default",45,6,0,0,3,0,0,0,0,0];
      for(const i of d.items){
        c.check();owner=i;let ok=true,why;const net=String(i.net || "");if(net)nets.add(net);
        const raw=c.source(d)?.record(i);
        if(raw){const r=JSON.parse(raw);if(!r[2] && (r[0]!=="VIA" || !r[4]) && ["LINE","ARC","PAD","VIA","POLY","FILL","POUR"].includes(r[0])){out.push(r);if(i.layer)layer(i.layer);add(i.kind,"kept","Verified unchanged original Pro record retained.");continue;}}
        const l=layer(i.layer || "Top");
        if(i.kind==="part"){
          const def=c.defs.get(i.def);if(!def?.footprint)ok=false;
          else{
            const placed=placement(i,def,i.layer,i.mirror===true),fp=placed.fp,k=id(),silk=i.layer==="Bottom"?4:3;
            out.push(["COMPONENT",k,0,l,...bp(loc(i)),-(i.angle||0),{"Unique ID":placed.key},0,null],pcbAttr(k,"Device",placed.did),pcbAttr(k,"Footprint",fp.fid),
              pcbAttr(k,"Designator",i.ref,silk,...bp(Atrium.world(i.refAt || [-2,-2],i)),i.showRef!==false),pcbAttr(k,"Value",i.value ?? def.value ?? "",silk,...bp(Atrium.world(i.valueAt || [-2,2],i)),i.showValue!==false));
            for(const [number,pids] of fp.pads){const value=i.pinNets?.[number] || fp.defaultNets.get(number);if(value){nets.add(value);for(const pid of pids)out.push(["PAD_NET",k,number,String(value),pid]);}}
          }
        }else if(i.kind==="via")out.push(["VIA",id(),0,net,"",...bp(loc(i)),mil(i.drill),mil(i.diameter),0,Number.isFinite(i.maskExpansion)?mil(i.maskExpansion):null,Number.isFinite(i.maskExpansion)?mil(i.maskExpansion):null,0,[]]);
        else if(i.kind==="pad" && l)out.push(boardPad(i,loc(i),i.angle || 0,l,net));
        else if(i.kind==="polygon" && l && i.points?.length>=3){
          const ps=i.points.map(bp);
          out.push(["POUR",id(),0,net,l,.2,String(i.name || ""),i.pourIndex || 0,[[...ps[0],"L",...ps.slice(1).flat()]],["SOLID",0],0,0]);
          why="Pour outline, layer and net retained; fill must be regenerated under the target rules.";
        }else if(["track","graphic","label","text","circle"].includes(i.kind)) {ok=drawing(out,i,p=>p,l);if(i.arc)why="Curved artwork emitted from its editable point projection.";}
        else ok=false;
        add(i.kind,ok?(why?"approximated":"kept"):"dropped",why || (ok?undefined:"No corresponding Pro board primitive or physical layer."));
      }
      owner=null;
      const shape=globalThis.AtriumBoardShape?.current(d);
      if(shape)for(const loop of [shape.contour,...shape.cutouts || []]){
        const ps=AtriumBoardShape.flattenContour(loop).map(bp);if(ps.length<3)continue;
        out.push(["POLY",id(),0,"",11,0,[...ps[0],"L",...ps.slice(1).flat(),...ps[0]],0]);add("Board outline",loop.some(s=>s.kind==="arc")?"approximated":"kept",loop.some(s=>s.kind==="arc")?"Curved segments exported as a closed polyline.":undefined);
      }
      const rows=[...header("PCB","1.8",{editorVersion:"2.2",importFlag:0}),["CANVAS",0,0,"mil",5,5,5,5,1,1,2,0,5]];
      for(const l of [...usedLayers].sort((a,b)=>a-b)){const title=titles[l] || "INNER_"+(l-14);rows.push(["LAYER",l,title,title,3,palette[l] || "#bbbbbb",1,palette[l] || "#777777",.5]);}
      for(const name of nets)rows.push(["NET",name,null,null,1,null,0,null]);
      const idPCB=uuid("pcb/"+d.id);meta.pcbs[idPCB]=d.name;const source=c.source(d),legacy=/(?:^|\/)PCB\/([^/]+)\.epcb$/i.exec(source?.path || "");pcbKeys.push({id:idPCB,source:source?.manifest,key:legacy?.[1]});pack("PCB/"+idPCB+".epcb",[...rows,...out]);
      const rules=c.rules(d);
      if(rules)add("Board design rules","dropped","Pro rule definitions are not written; configure the destination board rules before fabrication.",rules.list?.length || 1);
    }
    for(const d of docs){doc=d;owner=null;c.check();if(d.kind==="pcb")pcb(d);else schematic(d);owner=null;add(d.kind==="pcb"?"PCB document":"Schematic document","kept");}
    const groups=Object.keys(meta.schematics);
    const claimedGroups=new Set(),boards=new Map();
    function board(name,value){const base=name;let n=2;while(boards.has(name))name=base+" "+n++;boards.set(name,value);}
    for(const p of pcbKeys) {
      const pair=Object.entries(p.source?.boards || {}).find(([,v])=>v?.pcb===p.key);
      const schematic=(pair && schematicParents.get(p.source)?.get(pair[1].schematic)) || (groups.length===1?groups[0]:null);
      if(schematic)claimedGroups.add(schematic);
      board(pair?.[0] || "Board"+(boards.size+1),{pcb:p.id,...(schematic?{schematic}:{})});
    }
    for(const schematic of groups)if(!claimedGroups.has(schematic))board("Board"+(boards.size+1),{schematic});
    meta.boards=Object.fromEntries(boards);
    files.unshift({name:"project.json",data:JSON.stringify(meta,null,2)});
    return {name:stem+".epro",bytes:AtriumZip.create(files,{date:c.options.date})};
  }
  function write(c) {
    return c.scope==="documents" ? c.docs.map(d=>packageFiles(c,[d],c.stems.get(d.id))) :
      [packageFiles(c,c.docs,c.scope==="document"?c.stems.get(c.docs[0].id):c.safe(c.project.name))];
  }
  return Object.freeze({write});
})();
