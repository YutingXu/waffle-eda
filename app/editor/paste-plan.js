"use strict";
// The placement transaction is built on paste or duplicate. A trusted Copy still
// captures its clipboard bytes synchronously in edit-selection.js.
globalThis.AtriumPastePlan = (() => {
  const A=Atrium;
  if(!globalThis.AtriumPlacement && typeof require==="function")require("../pcb/placement.js");
  const P=AtriumPlacement;
  function prepare(project,doc,clip,defs){
    if(!clip || clip.kind!==doc.kind)throw Error("Paste into a "+(clip?.kind==="pcb"?"PCB layout":"schematic")+" document.");
    const labs=clip.items.some(i=>A.notebookItemKind?.(i))?globalThis.AtriumLabs?.notebookSignal():null;
    if(labs?.aborted)throw Error("Notebook items are read-only while notebook features are off.");
    const cutIds=clip.cut && clip.doc===doc.id?new Set(clip.items.map(i=>i.id)):null;
    const cutRefs=cutIds?new Set(clip.items.filter(i=>i.kind==="part").map(i=>i.ref.toUpperCase())):null;
    const restore=cutIds && !doc.items.some(i=>cutIds.has(i.id) || i.kind==="part"&&cutRefs.has(i.ref.toUpperCase()));
    const newDefs=[],mapping=new Map(),dynamic=new Map(),nextRef=restore?null:P.refAllocator(project);
    const PCB=doc.kind==="pcb" && globalThis.AtriumPCBAppearance;
    for(const source of clip.library){
      if(!restore&&source.dynamic){dynamic.set(source.id,source);continue;}
      const key=P.definitionKey(source);
      let target=defs.get(source.id);
      const geometry=target && (PCB ? PCB.readDefinition(defs,target.id,doc) : target);
      if(!geometry || P.definitionKey(geometry)!==key){
        target=project.library.find(d=>P.definitionKey(d)===key);
        if(!target){target=A.clone(source);target.id=A.id();newDefs.push(target);}
      }
      mapping.set(source.id,target.id);
    }
    const defsForPreview=newDefs.length||dynamic.size?new Map([...defs,...newDefs.map(d=>[d.id,d])]):defs;
    const groups=new Map(),unions=new Map(),ids=new Map();
    if(!restore)for(const src of clip.items)ids.set(src.id,A.id());
    // A group's kind prefix ("union:", "fence:", "teardrop:", "logo-") stays, so a pasted
    // union is still a union that Break Union can break.
    const regroup=(map,g)=>{if(!map.has(g)){const m=/^([A-Za-z]+[:-])/.exec(String(g));map.set(g,(m?m[1]:"")+A.id());}return map.get(g);};
    const items=clip.items.map(src=>{
      const i=A.clone(src);
      if(i.kind==="part"){
        const source=dynamic.get(i.def);
        if(source){
          const def=A.clone(source);def.id=A.id();
          newDefs.push(def);defsForPreview.set(def.id,def);i.def=def.id;
        }else i.def=mapping.get(i.def);
      }
      if(!restore){
        P.newInstance(i,ids.get(src.id));
        if(i.kind==="textframe"&&i.calculation){
          const R=globalThis.AtriumCalculationRecords;
          if(!R)throw Error("Load calculations before pasting a calculation block.");
          R.copyBindings(i,ids,clip.calculationDoc||clip.doc,doc.id,clip.calculationProject!==R.projectToken(project));
        }
        // Each pasted copy of grouped artwork (a placed logo) becomes its own group.
        if(i.groupId!=null)i.groupId=regroup(groups,i.groupId);
        if(i.unionId!=null)i.unionId=regroup(unions,i.unionId);
        // Pasted teardrops follow their pasted track and pad or via.
        if(i.teardrop){
          if(ids.has(i.teardropTrack))i.teardropTrack=ids.get(i.teardropTrack);
          const a=String(i.teardropAnchor??""),k=a.search(/[:@]/),head=k<0?a:a.slice(0,k);
          if(ids.has(head))i.teardropAnchor=ids.get(head)+(k<0?"":a.slice(k));
        }
        if(i.kind==="part"){
          const prefix=i.ref?.match(/^(.*?)(?:\d+[a-z]?)$/i)?.[1]||defsForPreview.get(i.def)?.prefix||"U";
          i.ref=nextRef(prefix);
        }
      }
      if(i.richText)globalThis.AtriumNotebook?.copyBindings(i,project,doc,clip,ids);
      A.moveItem(i,-clip.origin[0],-clip.origin[1]);
      return i;
    });
    const bounds=A.docBounds({...doc,outline:[],items},defsForPreview);
    const media=globalThis.AtriumClipboardMedia,transfer=media?.binding(clip);
    return {items,defs:defsForPreview,bounds,cancel(){if(transfer)media.cancel(transfer);},commit(at){
      if(labs?.aborted)throw Error("Notebook items are read-only while notebook features are off.");
      if(transfer)media.commit(clip,doc,transfer);
      for(const def of newDefs)project.library.push(def);
      if(newDefs.length&&clip.blobs)for(const k in clip.blobs)(project.blobs||={})[k]||=clip.blobs[k];
      for(const item of items){A.moveItem(item,at[0],at[1]);doc.items.push(item);}
      if(items.some(i=>i.calculation?.primaryAssertionId||i.calculation?.assertions?.length))globalThis.AtriumCalculations.syncRules(project);
      return items.map(i=>i.id);
    }};
  }
  return Object.freeze({prepare});
})();
