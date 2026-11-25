"use strict";

globalThis.AtriumEditSelection = (() => {
  const A=Atrium;
  const locked=i=>globalThis.AtriumLabs?.notebookEnabled()===false && !!A.notebookItemKind(i);
  function originOf(item,doc){
    if(item.kind==="imageMarkup"){
      const image=doc?.items.find(i=>i.kind==="image"&&i.id===item.imageId);
      return image?[image.x,image.y]:[0,0];
    }
    return item.points?item.points[0]:[item.x,item.y];
  }
  // blobs: project.blobs; the 3D models the copied parts use travel with them.
  function capture(doc,defs,ids,cut=false,blobs=null,project=globalThis.AtriumNavHost?.project?.()){
    const items=doc.items.filter(i=>ids.has(i.id) && !locked(i)).map(i=>A.clone(i));
    if(!items.length)return null;
    const PCB=doc.kind==="pcb" && globalThis.AtriumPCBAppearance;
    const used=new Set(items.filter(i=>i.kind==="part").map(i=>i.def)),library=[...used].map(id=>A.clone(PCB?PCB.readDefinition(defs,id,doc):defs.get(id))),b={};
    if(blobs)for(const d of library)for(const m of [d.model3d,d.footprint?.model3d])if(blobs[m?.sha256])b[m.sha256]=blobs[m.sha256];
    const owner=project&&items.some(i=>i.calculation)?{calculationProject:globalThis.AtriumCalculationRecords?.projectToken(project),calculationDoc:doc.id}:{};
    const source=globalThis.AtriumNotebook?.clipboardSource(doc,items,project);
    return {kind:doc.kind,doc:doc.id,cut,origin:originOf(items[0],doc).slice(),items,library,...owner,...source,...(Object.keys(b).length?{blobs:b}:{})};
  }
  function planner(){
    // @ts-ignore CommonJS loads the planner on first placement.
    if(!globalThis.AtriumPastePlan && typeof require==="function")require("./paste-plan.js");
    return globalThis.AtriumPastePlan;
  }
  function demand(clip) {
    const needed=[];
    if(!planner())needed.push("AtriumPastePlan");
    if(globalThis.AtriumLabs?.notebookEnabled()!==false && !globalThis.AtriumNotebook && clip.items.some(i=>i.richText))needed.push("AtriumNotebook");
    return needed.length?globalThis.AtriumLazy?.need(needed):null;
  }
  const prepare=(project,doc,clip,defs)=>planner().prepare(project,doc,clip,defs);
  // Snapshot only moving geometry. Reuse the snapshot through every pointer frame.
  function translation(doc,defs,objects,{frameOnly=false,query=null,existingOnly=false}={}){
    const S=globalThis.AtriumSchObjects;
    if(!frameOnly && doc.kind==="schematic" && objects.some(i=>S?.isFrame(i))){
      const moved=new Set(objects);
      for(const item of objects)if(S.isFrame(item)){
        for(const member of S.frameContents(doc,item,defs,query?.(S.frameBounds(item))))moved.add(member);
      }
      objects=[...moved];
    }
    if(globalThis.AtriumLabs?.notebookEnabled()===false)objects=objects.filter(i=>!locked(i));
    const owned=objects.map(item=>({item,points:item.points,arc:item.arc,x:item.x,y:item.y,regionShape:item.regionShape}));
    const attachments=doc.kind==="schematic" ? A.schematicAttachments(doc,defs,
      objects.flatMap(item=>{
        if(item.kind==="part")return A.pins(item,defs.get(item.def),doc.kind).map(pin=>pin.at);
        if(item.kind==="sheetsymbol"&&S)return (item.entries||[]).map(entry=>S.entryPoint(item,entry));
        return [];
      }),new Set(objects.map(i=>i.id)),{query,existingOnly}) : null;
    return {
      get affected(){return [...objects,...(attachments?.affected || [])];},
      apply(dx,dy){
        for(const v of owned)A.moveItem(v.item,dx,dy,v);
        if(!attachments)return objects;
        /** @param {Point} at */
        const move=([x,y])=>[x+dx,y+dy];
        const changed=attachments.apply(dx||dy ? move : ()=>null);
        return changed && [...objects,...changed];
      },
      finish(){return !existingOnly && !!attachments?.finish();}
    };
  }
  return {capture,demand,prepare,translation,originOf};
})();
