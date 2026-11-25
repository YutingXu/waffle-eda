"use strict";

// ODB++ 8.1 product model stackup, EDA, CAD netlist and assembly metadata.
globalThis.AtriumODBData = (() => {
  const G=globalThis;
  const text=rows=>rows.join("\n")+"\n";
  const ascii=value=>String(value??"").replace(/[^\x20-\x7e]/g,"?");
  const netNamePattern=/^[!-:<-~]+$/;
  function field(value,fallback) {
    const s=String(value??"");
    return s ? encodeURIComponent(s.replace(/[\uD800-\uDFFF]/gu,"\uFFFD")).replace(/[!'()*]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase()) : fallback;
  }
  const prop=value=>ascii(value).replace(/'/g,"\u0022");
  const xml=value=>ascii(value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"})[c]);
  const pos=point=>point.map(n=>String(n/1e6)).join(" ");
  const angle=n=>String(Math.round(((n||0)%360+360)%360*1e6)/1e6);
  const sorted=(a,b)=>a<b?-1:a>b?1:0;
  function unique(names,name) {
    let value=name,n=1;
    while (names.has(value)) value=name+"_"+ ++n;
    names.add(value);
    return value;
  }
  function netNames(nets) {
    const names=new Set(["$NONE$"]);
    for (const net of nets) {
      if (net.key!=="$NONE$" && netNamePattern.test(net.key)) names.add(net.name=net.key);
    }
    for (const net of nets) {
      if (net.name) continue;
      // Keep every legal native name, even when another name escapes to the same token.
      const escaped=net.key.replace(/[^!-:<-~]/gu,char=>field(char,"%EF%BF%BD"));
      net.name=unique(names,escaped);
    }
  }

  function stackup(schema) {
    const total=schema.materials.reduce((sum,{row})=>sum+(row.thickness||0),0);
    const material=[], layers=[];
    for (const {layer,row} of schema.materials) {
      const name=xml(row.material||row.name||layer.name)+" ("+layer.name+")";
      const thickness=String(Math.round((row.thickness||0)*1e6)/1e6);
      const copper=layer.type==="SIGNAL"||layer.type==="POWER_GROUND";
      const dielectric=row.type==="Solder Mask"?' DielectricType="OTHER" OtherSubType="SOLDER_MASK"':
        row.type==="Coverlay"?' DielectricType="OTHER" OtherSubType="COVERLAY"':
          ' DielectricType="'+(row.dielectric?.toUpperCase()||"UNDEFINED")+'"';
      const spec=copper?'<Conductor ConductorType="COPPER"/>' :
        row.type==="Surface Finish"?'<Conductor ConductorType="OTHER"/>' : '<Dielectric'+dielectric+'/>';
      material.push('<Material MaterialName="'+name+'">'+spec+
        '<Default_Thickness Thickness="'+thickness+'" Units="MM"/></Material>');
      const subtype=layer.subtype?' LayerSubType="'+layer.subtype+'"':"";
      layers.push('<Layer LayerName="'+layer.name+'" LayerType="'+layer.type+'" Side="'+layer.side+'"'+subtype+
        '><SpecRef MaterialSpecName="Waffle"><Material MaterialName="'+name+'"/></SpecRef></Layer>');
    }
    return text(['<?xml version="1.0" encoding="ASCII"?>','<StackupFile Version="8.1" DefaultUnits="MM">',
      '<EdaData CompanyName="Waffle"><Specs><Spec SpecName="Waffle">',...material,
      '</Spec></Specs><Stackup StackupName="PCB" StackupThickness="'+Number(total.toFixed(6))+'" Units="MM"><Group GroupName="Design">',
      ...layers,'</Group></Stackup></EdaData></StackupFile>']);
  }

  function variants(project, requested) {
    const V=G.AtriumVariants;
    if (!V || !project.variants?.length) return {project,rows:[],active:""};
    const applied=project.variantApplied;
    if (applied===null) {
      // A resolved base design still has its original part parameters.
      project={...project};
      delete project.variantApplied;
    }
    const active=applied===undefined ? V.current(project,requested)?.id : applied?.id;
    const rows=project.variants.flatMap((variant,index)=>{
      // A pre-resolved design only retains the part data of the selected variant.
      if (applied && variant.id!==applied.id) return [];
      const token="v"+(index+1)+"_"+variant.name.toLowerCase().replace(/[^a-z0-9_]+/g,"_").slice(0,12);
      return [{variant,token,fits:V.resolve(project,variant.id)}];
    });
    return {project,rows,active:rows.find(row=>row.variant.id===active)?.token||""};
  }
  function assembly(assemblyModel, components, files, root, board) {
    if (!components.length) return;
    const B=G.AtriumBOM, {paramKey}=G.Atrium.partParameters;
    for (const {variant,token} of assemblyModel.rows) {
      const bom=B.collect(assemblyModel.project,{source:"pcb",board:board.id,variant:variant.id});
      const included=new Map();
      for (const entry of bom.parts) for (const instance of entry.instances||[entry]) included.set(instance.id,entry);
      const grouped=new Map(), refs=[], numbers=new Set();
      for (const c of components) {
        const entry=included.get(c.item.id);
        if (!entry) continue;
        const {mpn,manufacturer,comment,params}=entry;
        const cpn=params.CPN||params["CUSTOMER PART NUMBER"]||mpn||comment||c.partNumber;
        const ratings=entry.def?.generic?.fields?.map(key=>params[paramKey(key)]??"")||[];
        const key=JSON.stringify([c.pkg.number,cpn,mpn,manufacturer,comment,ratings]);
        if (!grouped.has(key)) grouped.set(key,{number:unique(numbers,field(cpn,"unassigned")),qty:0,package:c.pkg.name,
          mpn,manufacturer,description:entry.description||comment});
        const group=grouped.get(key);
        group.qty++;
        refs.push("REF "+c.ref,"CPN "+group.number);
      }
      const parts=[], manufacturer=[];
      for (const v of grouped.values()) {
        parts.push("CPN "+v.number,"IPN","DSC "+ascii(v.description),"PKG "+v.package,"QNT "+v.qty);
        if (v.mpn) manufacturer.push("CPN "+v.number,"MPN "+ascii(v.mpn),v.manufacturer?"VND "+ascii(v.manufacturer):"VND","QLF 0","CHS 1");
      }
      const bomPath=root+"boms/"+token+"/";
      files.set(bomPath+"files",null);
      files.set(bomPath+"bom",text(["HEADER","BRD "+ascii(board.name),"REV "+ascii(variant.name),
        "HEADER_END","RD_CPN",...refs,"RD_CPN_END","CPN_MPN",...manufacturer,"CPN_MN_END","CP",...parts,"CP_END","FILE_END"]));
    }
  }

  function electrical(model,schema,xy,assemblyModel,featureIds) {
    const {Atrium:A,AtriumFabOutputs:F}=G;
    const {parameters,fieldOf}=A.partParameters;
    const readParams=G.AtriumVariants?.appliedParameters(model.project,model.defs)||parameters;
    const cmps={T:[],B:[]}, packages=new Map(), packageNames=new Set(), toes=new Map(), nets=new Map();
    const surfacePads=new Map(), drilledPads=new Set(), holePoints=[];
    const openings=new Map(), maskFilms={T:[],D:[]};
    for (const layer of schema.layers) {
      if (layer.type!=="SOLDER_MASK") continue;
      const points=new Set();
      openings.set(layer.key,points);
      maskFilms[layer.side==="TOP"?"T":"D"].push(points);
    }
    const pointKey=at=>pos(xy.raw(at));
    const padKey=(feature,at)=>JSON.stringify([feature.ref??"",feature.pin??"",at]);
    const backdrills=new Map(model.drills.filter(h=>h.backdrill).map(h=>[pointKey(h.at),h.backdrill]));
    function netOf(name) {
      const key=name==null||name===""?"":String(name);
      if (!nets.has(key)) nets.set(key,{key,number:nets.size,name:key?"":"$NONE$",subnets:[],trace:null,plane:null,vias:new Map()});
      return nets.get(key);
    }
    netOf("");
    function surface(points) {
      const ring=points.map(xy.local);
      if (!ring.length) throw Error("An ODB++ package pin is missing geometry.");
      return text(["CT","OB "+pos(ring[0])+" I",...ring.slice(1).map(q=>"OS "+pos(q)),"OS "+pos(ring[0]),"OE","CE"]).trimEnd();
    }
    function parcel(part) {
      const {def}=part, original=def.mirrorOf&&model.defs.get(def.mirrorOf);
      const base=original?.footprint ? original : def;
      if (packages.has(base.id)) return packages.get(base.id);
      const points=[], pins=[], pinNames=new Set();
      const name=unique(packageNames,field(base.footprint.name||base.name,"package_"+(packages.size+1)));
      for (const pad of base.footprint.pads||[]) {
        if (pad.number==null||pad.number==="") continue;
        const w=pad.w||pad.diameter||pad.drill, h=pad.h||pad.diameter||pad.drill;
        if (!(w>0&&h>0)) continue;
        const shape=F.padShape(pad.shape,w,h)||"rect", g=F.padGeom(shape,w,h,pad.angle||0,pad);
        const rotated=F.padOutline(g).map(q=>A.rotate(q,g.angle)).map(q=>[q[0]+pad.x,q[1]+pad.y]);
        points.push(...rotated);
        const outline=shape==="circle" ? "CR "+pos(xy.local([pad.x,pad.y]))+" "+xy.dimension(w/2) : surface(rotated);
        pins.push({pin:pad, number:unique(pinNames,field(pad.number,"pin")),outline});
      }
      for (const shape of base.footprint.shapes||[]) {
        if (shape.kind==="circle" && shape.r>0) points.push([shape.x-shape.r,shape.y-shape.r],[shape.x+shape.r,shape.y+shape.r]);
        else for (const q of shape.points||[]) points.push(q);
      }
      const [minX,minY,maxX,maxY]=points.length?A.bounds(points):[-.5,-.5,.5,.5];
      const box=[minX,-maxY,maxX,-minY].map(xy.dimension);
      // Non-essential pitch may be zero for packages with no stated pitch.
      const record=["PKG "+name+" 0 "+box.join(" "),
        "RC "+[minX,-maxY,Math.max(1e-6,maxX-minX),Math.max(1e-6,maxY-minY)].map(xy.dimension).join(" ")];
      for (const row of pins) {
        const p=row.pin, drilled=p.drill>0, blind=drilled&&p.fromLayer&&p.toLayer&&(p.fromLayer!=="Top"||p.toLayer!=="Bottom");
        record.push("PIN "+row.number+" "+(blind?"B":drilled?"T":"S")+" "+pos(xy.local([p.x,p.y]))+" 0 E "+(drilled?"T":"S"),row.outline);
      }
      const pkg={number:packages.size,name,pins,record};
      packages.set(base.id,pkg);
      return pkg;
    }
    const names=new Set(), variantLists=new Map();
    function subnet(net,label) {
      const sub={index:net.subnets.length,label,refs:[]};
      net.subnets.push(sub);
      return sub;
    }
    for (const part of model.parts) {
      const {item,def,side}=part, pkg=parcel(part), mirrored=Boolean(def.mirrorOf&&model.defs.get(def.mirrorOf))||Boolean(item.mirror);
      const ref=unique(names,field(item.ref,"component_"+(names.size+1))), boardSide=side==="Bottom"?"B":"T";
      const items=cmps[boardSide], number=items.length, dnp=Boolean(model.dnp?.has(item));
      const {mpn}=fieldOf(readParams(item,def)), partNumber=field(mpn||item.value||def.name,"unassigned");
      const rotation=angle((item.angle||0)*(mirrored?-1:1)), orientation=mirrored?"M":"N";
      const members=assemblyModel.rows.filter(({fits})=>fits[G.AtriumVariants.keyOf(item)]?.fitted).map(row=>row.token).join(":");
      if (assemblyModel.rows.length&&!variantLists.has(members)) variantLists.set(members,variantLists.size);
      const attributes=[...(dnp?["0"]:[]),...(variantLists.has(members)?["1="+variantLists.get(members)]:[])];
      const component={item, pkg, ref, partNumber,dnp,
        row:["CMP "+[pkg.number,pos(xy.raw([item.x,item.y])),rotation,orientation,ref,partNumber].join(" ")+
          (attributes.length?" ;"+attributes.join(","):""),
          "PRP VALUE '"+prop(item.value)+"'"]};
      for (const [key,value] of Object.entries({...def.parameters,...item.parameters}).sort(([a],[b])=>sorted(a,b))) {
        if (key.toUpperCase()==="VALUE" || value==null || typeof value==="object") continue;
        component.row.push("PRP "+field(key,"property")+" '"+prop(value)+"'");
      }
      const byNumber=new Map();
      for (const pad of part.fp.pads||[]) {
        const id=String(pad.number??"");
        if (!byNumber.has(id)) byNumber.set(id,[]);
        byNumber.get(id).push(pad);
      }
      for (const [i,{pin,number:pinName}] of pkg.pins.entries()) {
        const available=byNumber.get(String(pin.number));
        const p=available?.length?available.shift():pin;
        const at=A.world([p.x,p.y],item);
        const net=netOf(item.pinNets?.[p.number]??p.net);
        const sub=subnet(net,"TOP "+[boardSide,number,i].join(" "));
        toes.set(padKey({ref:item.ref,pin:String(p.number)},pointKey(at)),sub);
        component.row.push("TOP "+[i,pos(xy.raw(at)),rotation,orientation,net.number,sub.index,field(p.number,pinName)].join(" "));
      }
      items.push(component);
    }
    function appendRefs(sub,kind,layer,first,end) {
      for (let i=first;i<end;i++) sub.refs.push("FID "+kind+" "+layer.number+" "+i);
    }
    function viaSubnet(net,at) {
      if (!net.vias.has(at)) net.vias.set(at,subnet(net,"VIA"));
      return net.vias.get(at);
    }
    function graphic(f,layer,first,end) {
      if (end===first) return;
      if (f.t==="flash") openings.get(layer.key)?.add(pointKey(f.at));
      if (!schema.copper.has(layer.key) || f.fn==="NonConductor") return;
      const net=netOf(f.net);
      const at=f.at&&pointKey(f.at), key=at&&padKey(f,at), toe=toes.get(key);
      if (f.t==="flash" && f.use==="pad") {
        const type=layer.key==="Top"?"T":layer.key==="Bottom"?"D":"I";
        const location=JSON.stringify([key,layer.number,net.number]);
        if (!surfacePads.has(location)) surfacePads.set(location,{at,net,type,layer,key});
      }
      if (toe) {appendRefs(toe,"C",layer,first,end);return;}
      if (f.use==="via") {appendRefs(viaSubnet(net,at),"C",layer,first,end);return;}
      const plane=f.t==="pour"||f.t==="region";
      const sub=plane ? (net.plane??=subnet(net,"PLN S E 0")) : (net.trace??=subnet(net,"TRC"));
      // Negative clear-polarity pour holes are geometrical clearances, not conductive features.
      appendRefs(sub,"C",layer,first,plane?first+1:end);
    }
    function hole(hit,layer,first,end) {
      if (end===first || hit.backdrill) return;
      const at=pointKey(hit.at), key=padKey(hit,at);
      if (!hit.via) drilledPads.add(key);
      if (!hit.plated) return;
      const net=netOf(hit.net), toe=toes.get(key);
      const sub=toe||(hit.via?viaSubnet(net,at):(net.trace??=subnet(net,"TRC")));
      appendRefs(sub,"H",layer,first,end);
      const backdrill=hit.via&&backdrills.get(at);
      const top=hit.span[0]===0&&backdrill!=="top";
      const bottom=hit.span[1]===model.stack.length-1&&backdrill!=="bottom";
      // CADNET points describe contacts accessible in the finished board.
      // Buried holes remain linked to their copper in eda/data.
      if (!top && !bottom) return;
      const type=top&&bottom?"B":top?"T":"D";
      holePoints.push({at,net,type,layer,via:hit.via,drill:hit.d});
    }
    function cadPoint({at,net,type,layer,via,drill}) {
      const radius=drill>0?xy.dimension(drill/2):"0.002";
      const top=type!=="D"&&maskFilms.T.every(points=>points.has(at));
      const bottom=type!=="T"&&maskFilms.D.every(points=>points.has(at));
      const exposure=type==="I"?"e":type==="B"&&top!==bottom?(top?"s":"p"):top||bottom?"e":"c";
      const uid=(type==="B"||type==="I")&&featureIds.get(layer);
      return [net.number,radius,at,type,via?"m":"e",exposure,
        ...(via?["v"]:[]),...(uid?["ld="+uid]:[])].join(" ");
    }
    function write(files,root) {
      const layers=schema.layers.map(l=>l.name);
      const netList=[...nets.values()];
      netNames(netList);
      const points=[...[...surfacePads.values()].filter(pad=>!drilledPads.has(pad.key)),...holePoints];
      files.set(root+"eda/data",text([xy.units,"LYR "+layers.join(" "),
        ...netList.flatMap(n=>["NET "+n.name,...n.subnets.flatMap(s=>["SNT "+s.label,...s.refs])]),
        ...[...packages.values()].flatMap(p=>p.record)]));
      for (const [side,list] of Object.entries(cmps)) {
        files.set(root+"layers/comp_+_"+(side==="T"?"top":"bot")+"/components",
          text([xy.units,"@0 .no_pop",...(variantLists.size?["@1 .comp_variant_list"]:[]),
            ...[...variantLists].map(([names,i])=>"&"+i+" "+names),...list.flatMap(c=>c.row)]));
      }
      files.set(root+"netlists/cadnet/netlist",text([xy.units,"H optimize n",
        ...netList.map(n=>"$"+n.number+" "+n.name),"# Netlist points",...points.map(cadPoint)]));
      const components=[...cmps.T,...cmps.B];
      assembly(assemblyModel,components,files,root,model.doc);
      return {components:components.length,nets:nets.size-1,netPoints:points.length,packages:packages.size,
        variants:components.length?assemblyModel.rows.length:0};
    }
    return {graphic,hole,write};
  }
  return Object.freeze({stackup,electrical,variants});
})();
