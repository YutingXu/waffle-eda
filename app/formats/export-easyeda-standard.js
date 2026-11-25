"use strict";
globalThis.AtriumEasyEDAStandardWriter = (() => {
  const layers={"Top":1,"Bottom":2,"Silk":3,"Bottom silk":4,"Top paste":5,"Bottom paste":6,"Top mask":7,"Bottom mask":8,"Outline":10,"Multi":11,"Mechanical":12,"Mechanical 13":13,"Mechanical 14":14};
  const layerNames={1:"TopLayer",2:"BottomLayer",3:"TopSilkLayer",4:"BottomSilkLayer",5:"TopPasteMaskLayer",6:"BottomPasteMaskLayer",7:"TopSolderMaskLayer",8:"BottomSolderMaskLayer",10:"BoardOutLine",11:"Multi-Layer",12:"Document",13:"Mechanical 13",14:"Mechanical 14"};
  const colors={1:"#FF0000",2:"#0000FF",3:"#FFCC00",4:"#66CC33",10:"#CC00CC"};
  const U=.254, electric={0:1,1:3,2:2,7:0};
  const loc=o=>[o.x,o.y];
  function documentFile(c,d) {
    const pcb=d.kind==="pcb", source=c.source(d), old=source?.data;
    const canvas=old?.canvas || (pcb ? "CA~1000~1000~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mil~1~45~visible~0.5~0~0~0~yes" : "CA~1000~1000~#FFFFFF~yes~#CCCCCC~10~1000~1000~line~10~pixel~5~0~0");
    const fields=canvas.split("~"),ox=pcb ? Number(fields[16])||0 : 0,oy=pcb ? Number(fields[17])||0 : 0;
    const n=x=>c.round(x/U), pt=p=>[c.round(p[0]/U+ox),c.round(p[1]/U+oy)];
    const points=ps=>ps.map(p=>pt(p).join(" ")).join(" "), path=ps=>ps.map((p,i)=>(i?"L ":"M ")+pt(p).join(" ")).join(" ");
    const out=[], usedLayers=new Set(), ids=new Set();
    for (const value of old?.shape || []) if (typeof value==="string") for (const m of value.matchAll(/(?:^|[~^])(gge[\w-]+)/g)) ids.add(m[1]);
    let seq=0, owner=null;
    const id=()=>{let v;do {v="gge"+(++seq);} while(ids.has(v));ids.add(v);return v;};
    const add=(kind,status,reason,count)=>c.add(kind,status,d,owner,reason,count);
    const clean=value=>{
      const v=String(value??""),s=v.replace(/#@\$|\^\^|[~`\r\n]/g," ");
      if(v!==s)add("Text delimiter","approximated","EasyEDA Standard reserves the original delimiter inside primitive fields.");
      return s;
    };
    const row=(...args)=>args.join("~");
    function layer(name) {
      const m=/^Inner (\d+)$/.exec(name || ""), l=layers[name] || (m && +m[1]>=1 && +m[1]<=32 ? 20 + +m[1] : 0);
      if(l)usedLayers.add(l);
      return l;
    }
    const sheetText=(role,at,angle,value,size=1.27,show=true)=>row("T",role,...pt(at),angle,"#000080","Arial",c.round(size/.35)+"pt","","","","comment",clean(value),show?1:0,"start",id(),0);
    const poly=(ps,closed,fill,width)=>row(closed?"PG":"PL",points(ps),"#880000",n(width ?? .254),0,fill?"#FFFFFF":"none",id(),0);
    function symbol(item,def) {
      const geo=Atrium.gate(def?.symbol,item); if(!geo)return null;
      const abs=p=>Atrium.world(p,item), unit=geo!==def.symbol && (item.unit || 1);
      const refs=item.ref+(unit?"."+unit:""), prefix=(def.prefix || "U")+"?"+(unit?"."+unit:"");
      const params=["package",def.footprint?.name || def.footprintName || "","pre",prefix,"spiceSymbolName",def.name,"value",item.value ?? def.value ?? ""];
      for(const [k,v] of Object.entries({...def.parameters,...item.parameters}))if(typeof v==="string" || typeof v==="number")params.push(k,v);
      const sub=[row("LIB",...pt(loc(item)),params.map(clean).join("`")+"`",item.angle || 0,0,id(),0),
        sheetText("P",abs(item.refAt || [-2.54,-2.54]),item.angle || 0,refs,1.27,item.showRef!==false),
        sheetText("N",abs(item.valueAt || [-2.54,2.54]),item.angle || 0,item.value ?? def.value ?? "",1.27,item.showValue!==false)];
      for(const sh of geo.shapes || []) {
        if(sh.kind==="path" && sh.points?.length>1)sub.push(poly(sh.points.map(abs),sh.closed,sh.fill,sh.width));
        else if(sh.kind==="circle")sub.push(row("E",...pt(abs(loc(sh))),n(sh.r),n(sh.r),"#880000",n(sh.width || .254),0,sh.fill?"#FFFFFF":"none",id(),0));
        else if(sh.kind==="text")sub.push(sheetText("L",abs(loc(sh)),(sh.angle||0)+(item.angle||0),sh.text,sh.size));
        else {add("Symbol "+sh.kind,"dropped","Unsupported symbol artwork.");continue;}
        add("Symbol artwork","approximated","Geometry retained with EasyEDA schematic artwork styling.");
      }
      for(const pin of geo.pins || []) {
        const hot=pt(abs(loc(pin))),number=clean(pin.number),name=clean(pin.name);
        const type=electric[pin.electrical] ?? 0;
        const angle=c.round((item.angle || 0)+(pin.angle || 0));
        sub.push([row("P",pin.hidden?"0":"show",type,number,...hot,angle,id(),0),row(...hot),row("M "+hot.join(" ")+" h 0","#880000"),
          row(0,...hot,angle,name,"start","","7pt"),row(0,...hot,angle,number,"end","","7pt"),row(0,...hot),row(0,"")].join("^^"));
        add("Symbol pin",pin.electrical!=null && electric[pin.electrical]==null?"approximated":"kept",pin.electrical!=null && electric[pin.electrical]==null?"Electrical type mapped to unspecified.":undefined);
      }
      if(item.mirror)add("Symbol mirror","approximated","The displayed mirror is baked into the editable symbol geometry.");
      return sub.join("#@$");
    }
    function sheetItem(i,def) {
      if(i.kind==="part")return symbol(i,def);
      if(i.kind==="wire" || i.kind==="bus")return row(i.kind==="wire"?"W":"B",points(i.points),i.kind==="wire"?"#008800":"#000080",i.kind==="wire"?1:2,0,"none",id(),0);
      if(i.kind==="junction")return row("J",...pt(loc(i)),2.5,"#CC0000",id(),0);
      if(i.kind==="noerc")return row("O",...pt(loc(i)),id(),"","#33CC33",0);
      if(i.kind==="netlabel")return row("N",...pt(loc(i)),i.angle || 0,"#0000FF",clean(i.text),id(),"start",...pt(loc(i)),"Arial","7pt",0);
      if(i.kind==="busentry") {
        const v=Atrium.rotate([i.size || 2.54,-(i.size || 2.54)],i.angle || 0);
        return row("BE",0,...pt(loc(i)),...pt([i.x+v[0],i.y+v[1]]),id(),0);
      }
      if(i.kind==="label" || i.kind==="text")return sheetText("L",loc(i),i.angle || 0,i.text,i.size);
      if(i.kind==="graphic" && i.points?.length>1)return poly(i.points,i.closed,i.fill,i.width);
      if(["power","offsheet","offsheetconnector","port"].includes(i.kind)) {
        const isPower=i.kind==="power", gnd=/gnd|earth/.test(i.style || ""), kind=isPower?(gnd?"part_netLabel_gnD":"part_netLabel_vcc"):"part_netLabel_netPort";
        const angle=isPower?((gnd?3:1)-(i.direction ?? (gnd?3:1)))*90:i.angle || 0;
        const hot=pt(loc(i)),base=Atrium.world([0,-2.54],{...i,angle});
        return [row("F",kind,...hot,angle,id(),0),row(...hot),row(clean(i.text),"#000080",...pt(base),0,"start","Arial","7pt","flag",id()),
          poly([loc(i),base],false,false,.254)].join("^^");
      }
      return null;
    }
    function boardText(role,at,v,angle,l,size,visible=true) {
      return row("TEXT",role,...pt(at),n(Math.max(.1,(size || 1)*.14)),angle || 0,l===4?1:0,l,"",n(size || 1),clean(v),"",visible?"":"none",id(),0);
    }
    function pad(p,at,angle,l,net) {
      const r=p.drill || 0, polyPad=p.poly?.length>=3, shape=polyPad?"POLYGON":({rect:"RECT",round:"ELLIPSE",oval:"OVAL",roundrect:"RECT"})[p.shape] || "RECT";
      const sourceAngle=polyPad?angle:-angle;
      const pts=polyPad ? points(p.poly.map(v=>{const q=Atrium.rotate(v,sourceAngle);return [at[0]+q[0],at[1]+q[1]];})) : "";
      if(p.shape==="roundrect" || !polyPad && !["rect","round","oval"].includes(p.shape))add("Pad shape","approximated","Basic pad dimensions retained without a corner-radius control.");
      const half=Math.max(0,((p.slotLength || 0)-r)/2),v=Atrium.rotate([half,0],angle+(p.slotAngle || 0));
      const slot=half?points([[at[0]-v[0],at[1]-v[1]],[at[0]+v[0],at[1]+v[1]]]):"";
      return row("PAD",shape,...pt(at),n(p.w),n(p.h),l,clean(net),clean(p.number),n(r/2),pts,c.round(sourceAngle),id(),half?n(p.slotLength):0,slot,p.plated===false?"N":"Y",0,Number.isFinite(p.pasteExpansion)?n(p.pasteExpansion):"",Number.isFinite(p.maskExpansion)?n(p.maskExpansion):"");
    }
    function boardGraphic(i,abs,inside) {
      const l=layer(i.layer || (i.style==="package"?"Mechanical 13":"Silk"));if(!l)return null;
      if(i.kind==="circle")return row("CIRCLE",...pt(abs(loc(i))),n(i.r),n(i.width || .15),l,id(),0);
      if(i.kind==="label" || i.kind==="text")return boardText("L",abs(loc(i)),i.text,(i.angle||0)+(inside?.angle||0),l,i.size);
      if(!i.points?.length)return null;
      let ps=i.points.map(abs);
      if(i.closed && !Atrium.same(ps[0],ps.at(-1)))ps=[...ps,ps[0]];
      if(i.fill)return row("SOLIDREGION",l,clean(i.net),path(ps)+" Z","solid",id(),"",0);
      return row("TRACK",n(i.width || .15),l,clean(i.net),points(ps),id(),0);
    }
    function footprint(i,def) {
      const fp=def?.footprint;if(!fp)return null;
      const abs=p=>Atrium.world(p,i),angle=i.angle || 0, silk=layer(i.layer==="Bottom"?"Bottom silk":"Silk");
      const sub=[row("LIB",...pt(loc(i)),["package",fp.name || def.name,"pre",(def.prefix || "U")+"?","value",i.value || ""].map(clean).join("`")+"`",-angle,"",id(),0,"",0),
        boardText("P",abs(i.refAt || [-2,-2]),i.ref,angle,silk,1,i.showRef!==false),boardText("N",abs(i.valueAt || [-2,2]),i.value ?? def.value ?? "",angle,silk,1,i.showValue!==false)];
      for(const p of fp.pads || []) {
        const l=layer(p.drill?"Multi":p.layer || i.layer || "Top");
        if(l){sub.push(pad(p,abs(loc(p)),(p.angle || 0)+angle,l,i.pinNets?.[p.number] || p.net));add("Footprint pad","kept");}
        else add("Footprint pad","dropped","Unmapped pad layer.");
      }
      for(const sh of fp.shapes || []) {const val=boardGraphic(sh,abs,i);if(val)sub.push(val);add("Footprint artwork",val?"kept":"dropped",val?undefined:"Unsupported artwork or layer.");}
      return sub.join("#@$");
    }
    function boardItem(i,def) {
      if(i.kind==="part")return footprint(i,def);
      if(i.kind==="via")return row("VIA",...pt(loc(i)),n(i.diameter),clean(i.net),n(i.drill/2),id(),0);
      if(i.kind==="pad"){const l=layer(i.layer || (i.drill?"Multi":"Top"));return l?pad(i,loc(i),i.angle || 0,l,i.net):null;}
      if(i.kind==="polygon") {const l=layer(i.layer);return l && i.points?.length>=3 ? row("COPPERAREA",1,l,clean(i.net),path(i.points)+" Z",n(i.clearance || 0),"solid",id(),i.connectStyle==="direct"?"direct":"spoke",i.removeDeadCopper===false?"yes":"none","",0,"",0,1,1,0,"yes"):null;}
      if(i.kind==="keepout" && i.points?.length>=3) return row("SOLIDREGION",layer(i.layer || "Multi") || 11,"",path(i.points)+" Z","cutout",id(),"",0);
      if(["track","graphic","circle","label","text"].includes(i.kind))return boardGraphic(i,p=>p,null);
      return null;
    }
    for(const item of d.items) {
      c.check(); owner=item;
      const raw=source?.record(item);
      if (raw) {
        out.push(raw);add(item.kind,"kept","Verified unchanged native object. Original EasyEDA primitive retained.");
        if(item.layer)layer(item.layer);
      } else {
        const value=pcb?boardItem(item,c.defs.get(item.def)):sheetItem(item,c.defs.get(item.def));
        if(!value){add(item.kind,"dropped","No corresponding editable Standard primitive for this geometry or layer.");continue;}
        out.push(value);
        const approx=["polygon","keepout","port"].includes(item.kind) || item.arc;
        add(item.kind,approx?"approximated":"kept",approx?"Boundary or connection retained with the available Standard representation.":undefined);
        if(!pcb && item.kind==="wire" && item.net && item.points?.length) {
          const at=item.points[0];
          out.push(sheetItem({kind:"netlabel",x:at[0],y:at[1],text:item.net},null));add("Wire net name","kept","Named using an attached editable net label.");
        }
      }
    }
    owner=null;
    if(pcb){
      const shape=globalThis.AtriumBoardShape?.current(d), paths=shape ? AtriumBoardShape.flatten(shape) : {outline:d.outline || [],cutouts:[]};
      for(const ps of [paths.outline,...paths.cutouts])if(ps.length>=3){
        out.push(row("TRACK",1,layer("Outline"),"",points([...ps,ps[0]]),id(),0));
        const curved=shape && [shape.contour,...shape.cutouts || []].some(loop=>loop.some(s=>s.kind==="arc"));
        add("Board outline",curved?"approximated":"kept",curved?"Curved outline exported as a closed polyline.":undefined);
      }
    }
    const data={head:{...old?.head,docType:pcb?"3":"1",editorVersion:old?.head?.editorVersion || "6.5.22",newgId:true},canvas,shape:out,title:d.name};
    if(pcb){
      const oldLayers=new Map((old?.layers || []).map(v=>[Number(String(v).split("~")[0]),v]));
      for(const l of [1,2,3,4,10,11])usedLayers.add(l);
      data.layers=[...usedLayers].sort((a,b)=>a-b).map(l=>oldLayers.get(l) || row(l,layerNames[l] || "Inner"+(l-20),colors[l] || "#BBBBBB","true","true","true",""));
      const set=c.rules(d);
      if(set) {
        const rule={},fields={clearance:["clearance","gap"],width:["trackWidth","min"],viaStyle:["viaHoleD","holeMin"]};
        const allScope=r=>AtriumRules.kit.allScope(r.scope) && AtriumRules.kit.allScope(r.scope2);
        const winners=new Map(), base=new Map((globalThis.AtriumRules?.migrate(null).list || []).filter(r=>fields[r.type]).map(r=>[r.type,r]));
        for(const r of set.all || set.list || []){
          const f=fields[r.type];
          if(f && r.enabled && allScope(r) && Number.isFinite(r[f[1]]) && !winners.has(r.type))winners.set(r.type,r);
        }
        for(const r of set.list || []){
          const f=fields[r.type];
          if(winners.get(r.type)!==r){
            c.add("Board rule "+r.type,"dropped",d,r,"This rule, priority or scope cannot be expressed by a Standard default dimension.");continue;
          }
          rule[f[0]]=n(r[f[1]]);
          const template=base.get(r.type);
          const sourceIdentity=c.defaultRuleKeys?.get(r.id) ?? r.id;
          const exact=template && template.id===sourceIdentity && Object.keys(r).every(k=>
            k==="id" || k===f[1] || k==="scope" || k==="scope2" || r[k]===template[k]);
          c.add("Board rule "+r.type,exact?"kept":"approximated",d,r,exact?undefined:"The all-object minimum is written; the additional native rule settings or identity are omitted.");
        }
        // Version-one standalone board data can be read without the rule-book module.
        if(!set.list)for(const [from,to] of [["clearance","clearance"],["trackWidth","trackWidth"],["viaDrill","viaHoleD"]])if(Number.isFinite(set.defaults?.[from]))rule[to]=n(set.defaults[from]);
        if(Object.keys(rule).length)data.DRCRULE={Default:rule};
        if(Object.keys(set.nets || {}).length)add("Net-specific board rules","dropped","Only defaults are supported.",Object.keys(set.nets).length);
      }
    }
    c.add(pcb?"PCB document":"Schematic document","kept",d);
    return {name:c.stems.get(d.id)+".json",text:JSON.stringify(data,null,2)+"\n"};
  }
  return Object.freeze({write:c=>c.docs.map(d=>documentFile(c,d))});
})();
