"use strict";

globalThis.AtriumRevisionReview = (() => {
  const missing = Symbol("absent");
  const none = new Set();
  const kinds = {part:"Component", track:"Track", wire:"Wire", via:"Via", pad:"Pad", netlabel:"Net label", label:"Text", junction:"Junction", graphic:"Graphic"};
  const titles = {ref:"Designator", value:"Value", angle:"Rotation", def:"Library definition", link:"Component link", text:"Text", name:"Name", net:"Net", layer:"Layer", fromLayer:"Start layer", toLayer:"End layer", width:"Width", diameter:"Diameter", drill:"Drill", w:"Width", h:"Height", grid:"Grid", size:"Size", shape:"Shape", footprint:"Footprint", symbol:"Symbol", prefix:"Designator prefix", clearance:"Copper clearance", trackWidth:"Track width", viaDrill:"Via drill", defaults:"Board defaults", nets:"Net overrides", sourceName:"Source file", min:"Minimum", max:"Maximum"};
  const lengths = new Set(["diameter","drill","w","h","width","grid","clearance","trackWidth","viaDrill","thickness","r"]);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const title = key => Object.hasOwn(titles,key) ? titles[key] : key.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/^./,c=>c.toUpperCase());
  const get = (obj,key) => Object.hasOwn(obj,key) ? obj[key] : missing;
  const keyOf = (...parts) => JSON.stringify(parts);
  const position = obj => [obj.x,obj.y];
  const isPoint = v => Array.isArray(v) && v.length===2 && v.every(n=>typeof n==="number");
  const coordinate = v => "(" + v.join(", ") + ") mm";
  Object.assign(titles,{pcbDrawing:"Source PCB artwork",schRestored:"Restored sheet appearance",schDrawing:"Sheet appearance",frame:"Template primitives",sourceSha256:"Source SHA-256"});
  function countRecords(records){
    if(!object(records))return 0;
    let count=0;
    for(const key in records)if(Object.hasOwn(records,key))count++;
    return count;
  }
  function counted(n,label){return n+" "+label+(n===1?"":"s");}
  // A source hash identifies the original binary. Its read-only display caches
  // can contain megabytes of coordinates and should never enter report rows.
  function documentMetadata(doc){
    if(doc.kind==="pcb" && (object(doc.pcbDrawing)||Object.hasOwn(doc,"sourcePourSignature"))){
      const metadata={...doc};
      delete metadata.sourcePourSignature;
      if(object(doc.pcbDrawing)){
        const drawing=doc.pcbDrawing;
        metadata.pcbDrawing=counted(Array.isArray(drawing.pours)?drawing.pours.length:0,"pour region")+" · "+counted(countRecords(drawing.annotations),"annotated component");
      }
      return metadata;
    }
    if(doc.kind==="schematic" && (object(doc.schRestored)||Array.isArray(doc.schDrawing?.frame))){
      const metadata={...doc};
      if(object(doc.schRestored))metadata.schRestored=counted(countRecords(doc.schRestored.items),"object")+" · "+counted(countRecords(doc.schRestored.definitions),"symbol definition");
      if(Array.isArray(doc.schDrawing?.frame))metadata.schDrawing={...doc.schDrawing,frame:doc.schDrawing.frame.length};
      return metadata;
    }
    return doc;
  }
  function same(a,b) {
    if(a===b)return true;
    // Working geometry can retain more digits than its canonical .waffle file.
    if(typeof a==="number" && typeof b==="number")return Atrium.projectNumber(a)===Atrium.projectNumber(b);
    if(Array.isArray(a)){
      if(!Array.isArray(b)||a.length!==b.length)return false;
      for(let i=0;i<a.length;i++)if(!same(a[i],b[i]))return false;
      return true;
    }
    if(!object(a)||!object(b))return false;
    for(const k in a)if(Object.hasOwn(a,k)&&(!Object.hasOwn(b,k)||!same(a[k],b[k])))return false;
    for(const k in b)if(Object.hasOwn(b,k)&&!Object.hasOwn(a,k))return false;
    return true;
  }
  function show(v,key,defs){
    if(v===missing)return "Absent";
    if(v===null)return "null";
    if(v==="")return "Empty";
    if(key==="def" && defs.has(v))return defs.get(v)+" ("+v+")";
    if(typeof v==="number")return v+(lengths.has(key)?" mm":key==="angle"?"°":"");
    if(isPoint(v) && ["point","position","size"].includes(key))return coordinate(v);
    return typeof v==="object" ? JSON.stringify(v) : String(v);
  }
  function sourceRules(lines) {
    const counts=new Map();
    return (lines||[]).map(line=>{
      const props=Object.create(null);
      for(const e of line.split("|")){const n=e.indexOf("=");if(n>0)props[e.slice(0,n).toUpperCase()]=e.slice(n+1);}
      const key=props.UNIQUEID ? keyOf("id",props.UNIQUEID) : keyOf("rule",props.RULEKIND||"",props.NAME||"");
      const index=counts.get(key)||0;counts.set(key,index+1);
      return {key:keyOf(key,index),name:props.NAME||props.RULEKIND||"Source rule",props,line};
    });
  }
  // Only project-level records need a general index. Ordered objects and library
  // entries are compared directly in their owning collections below.
  function metadata(project) {
    const rows=new Map(),orders=new Map();
    function add(key,area,name,data,skip=none,doc=null,item=null){
      rows.set(key,{key,area,name,data,skip,doc:doc?.id||null,docName:doc?.name||"",item});
    }
    add(keyOf("project"),"Project",project.name,project,new Set(["documents","library","layoutBlocks","rules","format","version"]));
    function addRules(doc,rules){if(rules)add(keyOf("rules",doc?.id||null),"Rules","Design rules",rules,new Set(["format","version","units"]),doc);}
    addRules(null,project.rules);
    for(const doc of project.documents){
      const area=doc.kind==="pcb"?"PCB":"Schematic";
      add(keyOf("document",doc.id),area,doc.name,documentMetadata(doc),new Set(["id","items","rules","sourceRules"]),doc);
      const order=[];
      for(const rule of sourceRules(doc.sourceRules)){
        const id=keyOf("sourceRule",doc.id,rule.key);order.push(id);add(id,"Rules",rule.name,rule.props,none,doc);rows.get(id).sourceLine=rule.line;
      }
      orders.set(keyOf("source rules order",doc.id),{area:"Rules",name:"Source rule order",keys:order,doc:doc.id,docName:doc.name});
    }
    orders.set(keyOf("document order"),{area:"Project",name:"Document order",keys:project.documents.map(v=>keyOf("document",v.id))});
    const counts=new Map(),blockOrder=[];
    for(const b of project.layoutBlocks||[]){
      const k=b.id?keyOf("id",b.id):keyOf("name",b.name),n=counts.get(k)||0;counts.set(k,n+1);
      const id=keyOf("block",k,n);blockOrder.push(id);add(id,"Blocks",b.name,b,identitySkip);
    }
    orders.set(keyOf("block order"),{area:"Blocks",name:"Block order",keys:blockOrder});
    return {rows,orders};
  }
  const identitySkip=new Set(["id"]);
  function memberName(data,doc){
    if(!doc)return data.name;
    const kind=kinds[data.kind]||data.kind;
    return data.ref || (data.kind==="netlabel"?data.text:kind+(data.net?" · "+data.net:"")) || kind;
  }
  class Member {
    constructor(data,doc){
      this.data=data;this.doc=doc?.id||null;this.docName=doc?.name||"";
      this.area=doc?(doc.kind==="pcb"?"PCB":"Schematic"):"Library";
    }
    // These values can already be obtained from the underlying object. Keep
    // a single stable key on the row when displaying or paging both sides.
    get key(){return keyOf(this.doc?"item":"definition",this.data.id);}
    get name(){return memberName(this.data,this.doc);}
    get item(){return this.doc?this.data.id:null;}
    get skip(){return identitySkip;}
  }
  function metadataChanged(a,b){
    if(a.data===b.data)return false;
    for(const k of Object.keys(a.data))if(!a.skip.has(k)&&(!Object.hasOwn(b.data,k)||!same(a.data[k],b.data[k])))return true;
    for(const k of Object.keys(b.data))if(!b.skip.has(k)&&!Object.hasOwn(a.data,k))return true;
    return false;
  }
  function compact(entry){
    if(!entry || !entry.skip.has("items") && !entry.skip.has("documents"))return entry;
    const data={};
    for(const k of Object.keys(entry.data))if(k==="id"||!entry.skip.has(k))Object.defineProperty(data,k,{value:entry.data[k],enumerable:true});
    return {...entry,data};
  }
  function *compareSteps(baseline,current,options={}){/*diff-engine*/
    yield* Atrium.validationSteps(baseline);
    const rows=[],oldDefs=new Map(),newDefs=new Map(),result={rows,oldDefs,newDefs};
    if(baseline===current)return result;
    yield* Atrium.validationSteps(current);
    // With options.match the engine's matching (id, designator, net + geometry, geometry) rewrites the
    // baseline's ids to the current ones, so re-imported or copied objects pair up row by row.
    if(options.match&&globalThis.AtriumDiff)baseline=AtriumDiff.remap(baseline,current,{matching:options.matching});
    const oldDocs=new Map(baseline.documents.map(d=>[d.id,d])),newDocs=new Map(current.documents.map(d=>[d.id,d]));
    if(!current.documents.some(d=>oldDocs.has(d.id)))throw Error("These projects share no document IDs. Choose a saved revision of this design.");
    const repeatedNames=new Map();
    function displayName(entry){
      const name=entry.name;
      if(!entry.data.kind || entry.data.ref || !entry.data.net || entry.data.kind==="netlabel")return name;
      const found=repeatedNames.get(name);
      if(found!==undefined)return found;
      if(repeatedNames.size<1024)repeatedNames.set(name,name);
      return name;
    }
    function emit(previous,next){
      const source=next||previous,status=!previous?"Added":!next?"Removed":"Changed";
      const name=displayName(source),oldName=previous?(previous===source?name:displayName(previous)):"";
      const row={key:source.key,area:source.area,name,oldName,document:source.doc,documentName:source.docName||"",status,locate:next?.item||null,previous,next};
      rows.push(row);return row;
    }
    const old=metadata(baseline),now=metadata(current);
    for(const [key,b] of old.rows){
      const n=now.rows.get(key);
      if(!n || b.sourceLine!==n.sourceLine || metadataChanged(b,n))emit(compact(b),compact(n));
    }
    for(const [key,n] of now.rows)if(!old.rows.has(key))emit(null,compact(n));
    for(const [key,order] of old.orders){
      const to=now.orders.get(key);if(!to||same(order.keys,to.keys))continue;
      const leftSet=new Set(order.keys),rightSet=new Set(to.keys);
      const left=order.keys.filter(id=>rightSet.has(id)),right=to.keys.filter(id=>leftSet.has(id));
      if(same(left,right))continue;
      const entry=(o,keys,index)=>({key,area:o.area,name:o.name,doc:o.doc,docName:o.docName,data:{order:keys.map(id=>{
        const found=index.rows.get(id);return found.name+" ("+(found.data.id||id)+")";
      })},skip:none});
      emit(entry(order,left,old),entry(to,right,now));
    }

    // Project-wide IDs allow an item to move between sheets. Only objects
    // missing from their original collection need this cross-sheet lookup.
    const pending=new Map(),libraryRows=new Map();
    const multipleDocs=oldDocs.size>1 || newDocs.size>1;
    function pair(left,right,bDoc,aDoc){
      if(!bDoc && !aDoc){
        if(left===right)return;
        // Native terminal row identities can differ between equivalent library files.
        left=Atrium.definitionGeometry(left);
        right=Atrium.definitionGeometry(right);
      }
      if(left && right && bDoc?.id===aDoc?.id && same(left,right))return;
      const row=emit(left?new Member(left,bDoc):null,right?new Member(right,aDoc):null);
      if(!aDoc && right)libraryRows.set(right.id,row);
    }
    function exclusive(data,doc,added){
      if(doc && multipleDocs){
        const prior=pending.get(data.id);
        if(!prior){pending.set(data.id,{data,doc,added});return;}
        pending.delete(data.id);
        if(added)pair(prior.data,data,prior.doc,doc);
        else pair(data,prior.data,doc,prior.doc);
      }else if(added)pair(null,data,null,doc);
      else pair(data,null,doc,null);
    }
    function *collection(left,right,bDoc,aDoc){
      if(left===right)return;
      let start=0,leftEnd=left.length,rightEnd=right.length;
      const limit=Math.min(leftEnd,rightEnd);
      // A normal field edit needs just a linear read, with no per-item entry,
      // serialized key, order array, or lookup table for unchanged objects.
      while(start<limit && left[start].id===right[start].id){
        pair(left[start],right[start],bDoc,aDoc);
        if(++start%128===0)yield;
      }
      while(leftEnd>start && rightEnd>start && left[leftEnd-1].id===right[rightEnd-1].id){
        leftEnd--;rightEnd--;if(leftEnd%128===0)yield;
      }
      if(start===leftEnd || start===rightEnd){
        for(let i=start;i<leftEnd;i++){exclusive(left[i],bDoc,false);if(i%128===0)yield;}
        for(let i=start;i<rightEnd;i++){exclusive(right[i],aDoc,true);if(i%128===0)yield;}
      }else{
        const positions=new Map();
        for(let i=start;i<leftEnd;i++){positions.set(left[i].id,i);if(i%128===0)yield;}
        let last=-1,reordered=false;
        for(let j=start;j<rightEnd;j++){
          const data=right[j],i=positions.get(data.id);
          if(i===undefined)exclusive(data,aDoc,true);
          else{
            pair(left[i],data,bDoc,aDoc);
            if(i<last)reordered=true;
            last=i;positions.set(data.id,-1-i);
          }
          if(j%128===0)yield;
        }
        for(let i=start;i<leftEnd;i++){if(positions.get(left[i].id)>=0)exclusive(left[i],bDoc,false);if(i%128===0)yield;}
        if(reordered){
          // Save just displaced positions. Added, removed and transferred IDs
          // are excluded before numbering the common drawing order.
          const key=aDoc?keyOf("draw order",aDoc.id):keyOf("library order");
          const name=aDoc?"Drawing order":"Library order";
          const entry=doc=>({key,area:doc?(doc.kind==="pcb"?"PCB":"Schematic"):"Library",name,doc:doc?.id,docName:doc?.name,data:{},skip:none});
          const changes=emit(entry(bDoc),entry(aDoc)).order=[];
          let j=start,n=start;
          for(let i=start;i<leftEnd;i++){
            if(i%128===0)yield;
            if(positions.get(left[i].id)>=0)continue;
            while(!positions.has(right[j].id)){if(++j%128===0)yield;}
            const b=left[i],a=right[j++];n++;
            if(a.id!==b.id)changes.push([n,memberName(b,bDoc)+" ("+b.id+")",memberName(a,aDoc)+" ("+a.id+")"]);
          }
        }
      }
      for(let i=leftEnd,j=rightEnd;i<left.length;i++,j++){pair(left[i],right[j],bDoc,aDoc);if(i%128===0)yield;}
    }
    for(const doc of baseline.documents){const to=newDocs.get(doc.id);yield* collection(doc.items,to?.items||[],doc,to);}
    for(const doc of current.documents)if(!oldDocs.has(doc.id))yield* collection([],doc.items,null,doc);
    let pendingCount=0;
    for(const {data,doc,added} of pending.values()){
      if(added)pair(null,data,null,doc);else pair(data,null,doc,null);
      if(++pendingCount%128===0)yield;
    }
    yield* collection(baseline.library,current.library,null,null);
    if(libraryRows.size){
      let n=0;
      findPlacements:for(const doc of current.documents)for(const item of doc.items){
        if(item.kind==="part" && libraryRows.has(item.def)){
          libraryRows.get(item.def).locate=item.id;libraryRows.delete(item.def);if(!libraryRows.size)break findPlacements;
        }
        if(++n%128===0)yield;
      }
    }
    // Field rendering resolves assignment names, without retaining old
    // symbols, pads or entire revision trees after comparison.
    function *attachGeometry(side,library,names){
      const used=new Map();
      for(let i=0;i<rows.length;i++){
        const e=rows[i][side];
        if(e?.doc && e.data.kind==="part")used.set(e.data.def,null);
        if(i%128===0)yield;
      }
      for(let i=0;i<library.length;i++){
        const def=library[i];names.set(def.id,def.name);
        if(used.has(def.id))used.set(def.id,def);
        if(i%128===0)yield;
      }
      if(used.size)for(let i=0;i<rows.length;i++){
        const e=rows[i][side];
        if(e?.doc && e.data.kind==="part")e.geometry=Atrium.geometries(used.get(e.data.def),e.area==="PCB"?"pcb":"schematic");
        if(i%128===0)yield;
      }
    }
    if(rows.length){yield* attachGeometry("previous",baseline.library,oldDefs);yield* attachGeometry("next",current.library,newDefs);}
    return result;
  }
  // IDs identify documents, parts and blocks. A pad or symbol pin has only a
  // designator. Match repeated numbers by occurrence and vertices by position in the path.
  function numbered(list,field){
    const by=new Map(),counts=new Map();
    for(const v of list){
      const n=String(v[field]??""),i=(counts.get(n)||0)+1;counts.set(n,i);
      by.set(keyOf(n,i),{name:n+(i>1?" #"+i:""),value:v});
    }
    return by;
  }
  function *fields(result,row){
    if(row.order){
      for(const [n,before,after] of row.order)yield {label:"Order · "+n,before,after};
      return;
    }
    const b=row.previous,a=row.next;
    function value(label,key,before,after){return {label,before:show(before,key,result.oldDefs),after:show(after,key,result.newDefs)};}
    if(a && b && a.doc!==b.doc)yield value("Document","",b.docName||missing,a.docName||missing);
    function *walk(label,key,left,right){
      if(left===right)return;
      if(isPoint(left)&&isPoint(right) && ["point","size"].includes(key)){
        if(!same(left,right))yield value(label,key,left,right);return;
      }
      const l=left===missing?undefined:left,r=right===missing?undefined:right;
      if((object(l)||left===missing)&&(object(r)||right===missing)){
        const x=l||Object.create(null),y=r||Object.create(null);
        if(!Object.keys(x).length&&!Object.keys(y).length){if(left===missing||right===missing)yield value(label,key,left,right);return;}
        yield* properties(x,y,label,none);return;
      }
      if((Array.isArray(l)||left===missing)&&(Array.isArray(r)||right===missing)){
        const x=l||[],y=r||[];
        if(!x.length&&!y.length){if(left===missing||right===missing)yield value(label,key,left,right);return;}
        const idKey=(key==="pads"||key==="pins")?"number":(key==="items"||key==="library")?"id":null;
        if(idKey && [...x,...y].every(v=>object(v)&&Object.hasOwn(v,idKey))){
          const xx=numbered(x,idKey),yy=numbered(y,idKey);
          const itemTitle={pads:"Pad",pins:"Pin",items:"Object",library:"Entry"}[key];
          for(const id of new Set([...xx.keys(),...yy.keys()])){
            const from=xx.get(id),to=yy.get(id);
            yield* walk(label+" · "+itemTitle+" "+((to||from).name||"(unnumbered)"),"",from?.value??missing,to?.value??missing);
          }
          // Stacking order can matter for shapes and overlapping footprint features.
          const leftOrder=[...xx.keys()].filter(id=>yy.has(id)),rightOrder=[...yy.keys()].filter(id=>xx.has(id));
          if(!same(leftOrder,rightOrder))yield value(label+" · Order","",leftOrder.map(id=>xx.get(id).name),rightOrder.map(id=>yy.get(id).name));
          return;
        }
        for(let i=0;i<Math.max(x.length,y.length);i++){
          const v=i<x.length?x[i]:missing,w=i<y.length?y[i]:missing;
          const point=key==="points"||key==="outline";
          if(point&&(isPoint(v)||isPoint(w))){if(!same(v,w))yield value(label+" · Vertex "+(i+1),"point",v,w);}
          else yield* walk(label+" · "+(i+1),"",v,w);
        }
        return;
      }
      yield value(label,key,left,right);
    }
    function *properties(x,y,parent,skip){
      const validXY=v=>typeof v.x==="number" && typeof v.y==="number" || !Object.hasOwn(v,"x")&&!Object.hasOwn(v,"y");
      const xy=(Object.hasOwn(x,"x")||Object.hasOwn(y,"x")) && validXY(x) && validXY(y);
      const label=k=>parent?parent+" · "+k:k;
      if(xy && (x.x!==y.x || x.y!==y.y)){const p=Object.hasOwn(x,"x")?position(x):missing,q=Object.hasOwn(y,"x")?position(y):missing;yield value(label("Position"),"position",p,q);}
      const keys=[];
      for(const key in x){
        if(!Object.hasOwn(x,key)||skip.has(key)||xy&&(key==="x"||key==="y"))continue;
        if(!Object.hasOwn(y,key)||!same(x[key],y[key]))keys.push(key);
      }
      for(const key in y)if(Object.hasOwn(y,key)&&!Object.hasOwn(x,key)&&!skip.has(key)&&!(xy&&(key==="x"||key==="y")))keys.push(key);
      keys.sort();
      for(const key of keys){
        const left=get(x,key),right=get(y,key);
        if(key==="pinNets"&&(left===missing||object(left))&&(right===missing||object(right))){
          const old=left===missing?{}:left,now=right===missing?{}:right;
          const numbers=[...new Set([...Object.keys(old),...Object.keys(now)])].sort();
          for(const n of numbers)if(get(old,n)!==get(now,n))yield value(label("Pin "+n+" net"),"net",get(old,n),get(now,n));
          if(!numbers.length&&left!==right&&(left===missing||right===missing))yield value(label("Pin nets"),key,left,right);
        }else yield* walk(label(title(key)),key,left,right);
      }
    }
    if(b?.sourceLine!==undefined && a?.sourceLine!==undefined && b.sourceLine!==a.sourceLine && same(b.data,a.data))yield value("Source record","",b.sourceLine,a.sourceLine);
    yield* properties(b?.data||{},a?.data||{},"",(a||b).skip);
  }
  const includes=(s,q)=>s.toLowerCase().includes(q);
  // Refining a query can only remove results. One cached subset per report
  // avoids indexing every field or reformatting rows already ruled out.
  const previousSearch=new WeakMap();
  function *filterSteps(result,area="",status="",query="",documentId=""){
    const q=query.trim().toLowerCase();
    if(!q && !area && !status && !documentId)return result.rows;
    const last=previousSearch.get(result);
    const narrower=last && q.includes(last.q) && (!last.area || area===last.area) && (!last.status || status===last.status) && (!last.documentId||documentId===last.documentId);
    if(narrower && q===last.q && area===last.area && status===last.status && documentId===last.documentId)return last.matches;
    const candidates=narrower?last.matches:result.rows;
    const matches=[];let count=0;
    for(const row of candidates){
      if(++count%32===0)yield;
      if(area&&row.area!==area||status&&row.status!==status||documentId&&row.document!==documentId)continue;
      if(!q || includes(row.name,q)||includes(row.oldName,q)||includes(row.documentName,q)||includes(row.area,q)||includes(row.status,q)||includes(row.previous?.data.id||row.next?.data.id||"",q)){
        matches.push(row);continue;
      }
      for(const f of fields(result,row)){
        if(++count%32===0)yield;
        if(includes(f.label,q)||includes(f.before,q)||includes(f.after,q)){matches.push(row);break;}
      }
    }
    const found=matches.length===candidates.length?candidates:matches;
    previousSearch.set(result,{q,area,status,documentId,matches:found});
    return found;
  }
  function finish(steps){let step;do{step=steps.next();}while(!step.done);return step.value;}
  const compare=(baseline,current,options)=>finish(compareSteps(baseline,current,options));
  const findRows=(result,area,status,query,documentId)=>finish(filterSteps(result,area,status,query,documentId));
  // Share the MCP comparison with the dialog, giving input and painting a
  // turn between batches. Cancelled work cannot publish an obsolete filter.
  async function runInSlices(steps,active){
    while(active()){
      const deadline=performance.now()+5;
      do{const step=steps.next();if(step.done)return step.value;}while(performance.now()<deadline);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return null;
  }
  const compareAsync=(baseline,current,active=()=>true,options)=>runInSlices(compareSteps(baseline,current,options),active);
  const findRowsAsync=(result,area,status,query,active=()=>true,documentId="")=>runInSlices(filterSteps(result,area,status,query,documentId),active);
  const open=ctx=>AtriumRevisionPanel.open(ctx);
  return {compare,compareAsync,fields,findRows,findRowsAsync,open};
})();
