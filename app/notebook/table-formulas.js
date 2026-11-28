"use strict";

// Excel addresses are bound to authored axes. Task 36 owns expression parsing,
// quantities, comparisons, diagnostics and evaluation of the dependency graph.
globalThis.AtriumTableFormulas = (() => {
  const G=globalThis,T=G.AtriumTableData,graph=()=>G.AtriumCalculationGraph;
  const address=/^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,5})$/;
  // Consume a net field (the calculation lexer's spelling, including quoted and
  // digit-led net names), quoted text and qualified design names before an A1 token.
  const tokens=new RegExp("(?:"+G.AtriumCalculationIntent.netField+")|"+/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:[\p{L}_][\p{L}\p{N}_]*\.)*[\p{L}_][\p{L}\p{N}_]*::)?[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)+|\$?[A-Za-z_][A-Za-z_0-9]*\$?\d*|<>/u.source,"giu");
  const failed=(code,message,span)=>({ok:false,diagnostic:{code,message,span}});
  function axis(s,token) {
    const m=address.exec(token);
    if (!m) return null;
    const ci=[...m[2].toUpperCase()].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1,ri=Number(m[4])-1;
    return {rowId:s.rows[ri]?.id ?? null,columnId:s.columns[ci]?.id ?? null,absoluteRow:!!m[3],absoluteColumn:!!m[1]};
  }
  function label(s,ref) {
    const ix=T.index(s),r=ix.rows.get(ref.rowId),c=ix.columns.get(ref.columnId);
    if (r===undefined || c===undefined) return "#REF!";
    return (ref.absoluteColumn?"$":"")+T.letters(c)+(ref.absoluteRow?"$":"")+(r+1);
  }
  function isCellReference(source,start,end) {
    if (/^\s*\(/.test(source.slice(end))) return false;
    const name=source.slice(start,end);
    return !(/^E(?:3|6|12|24|48|96|192)$/.test(name) && /(?:^|[^\w.])(?:in|nearest)\s+$/.test(source.slice(0,start)));
  }
  function formulaReferences({source,references}) {
    const bindings=[];
    for (const ref of references) {
      const [start,end]=ref.span;
      if (ref.type==="cell" && !isCellReference(source,start,end)) continue;
      // Older formulas bound only the suffix, sometimes to a different sheet.
      if (ref.type==="design" && source.slice(start-2,start)==="::") {
        const prefix=/(?:^|[^\p{L}\p{N}_.:])((?:[\p{L}_][\p{L}\p{N}_]*\.)*[\p{L}_][\p{L}\p{N}_]*::)$/u.exec(source.slice(0,start));
        if (prefix) {
          const begin=start-prefix[1].length;
          while (bindings.length && bindings.at(-1).span[1]>begin) bindings.pop();
          bindings.push({type:"design",name:source.slice(begin,end),span:[begin,end]});
          continue;
        }
      }
      bindings.push(ref);
    }
    return bindings;
  }
  function scan(s,source,{resolveDesign}={}) {
    if (typeof source!=="string" || !source.startsWith("=") || source.length>T.limits.text) throw Error("Enter a bounded formula beginning with =.");
    const references=[];
    for (const match of source.matchAll(tokens)) {
      const name=match[0],start=match.index,end=start+name.length;
      if (/['"]/.test(name[0]) || /[\w$.]/.test(source[start-1] || "") || /[\w$.]/.test(source[end] || "")) continue;
      const next=axis(s,name);
      if (next && isCellReference(source,start,end)) references.push({type:"cell",span:[start,end],...next});
      else if (name.includes(".")) {
        const target=resolveDesign?.(name);
        references.push({type:"design",name,span:[start,end],...(target?{target}:{})});
      }
    }
    return {kind:"formula",source,references};
  }
  function spelling(s,content,shift) {
    let cursor=0,out="";
    for (const ref of formulaReferences(content)) {
      out+=content.source.slice(cursor,ref.span[0]);
      if (ref.type==="design") out+=content.source.slice(...ref.span);
      else {
        let next=ref;
        if (shift) {
          const ix=T.index(s),ri=ix.rows.get(ref.rowId),ci=ix.columns.get(ref.columnId);
          next={...ref,rowId:s.rows[ri+(ref.absoluteRow?0:shift.row)]?.id,columnId:s.columns[ci+(ref.absoluteColumn?0:shift.column)]?.id};
        }
        out+=label(s,next);
      }
      cursor=ref.span[1];
    }
    return out+content.source.slice(cursor);
  }
  function copyTo(s,content,from,to) {
    const ix=T.index(s),source=spelling(s,content,{row:ix.rows.get(to.rowId)-ix.rows.get(from.rowId),column:ix.columns.get(to.columnId)-ix.columns.get(from.columnId)});
    return scan(s,source,{resolveDesign:name=>content.references.find(r=>r.type==="design"&&r.name===name)?.target});
  }
  function fillDown(s,{rows,columns}) {
    const changes=[];
    for(const columnId of columns){
      const from={rowId:rows[0],columnId},cell=T.get(s,from.rowId,columnId);
      const content=cell?.content??null,style=cell?.style??null;
      for(let i=1;i<rows.length;i++){
        const rowId=rows[i];
        T.assertEditable(s,rowId,columnId);
        changes.push({rowId,columnId,content:content?.kind==="formula"?copyTo(s,content,from,{rowId,columnId}):content,style});
      }
    }
    return T.batch(s,changes);
  }
  function lower(s,formula) {
    const refs=[],map=[[0,1]],watched=[],original=formula.source;
    let source="(",cursor=1;
    function plain(end) {
      const fragment=original.slice(cursor,end);
      source+=fragment.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<>/g,token=>token==="<>"?"!=":token);
      for(let i=cursor;i<end;i++)map.push([i,i+1]);
    }
    function reference(ref,span) {
      const name="tablecell"+refs.length,at=source.length;
      source+=name;for(let i=0;i<name.length;i++)map.push(span);
      refs.push({name,span:[at,source.length],original:span,...(ref.type==="design"?{design:ref}:ref.range?{range:ref.range}:{axis:ref})});
    }
    const bindings=formulaReferences(formula);
    for (let i=0;i<bindings.length;i++) {
      const r=bindings[i],n=bindings[i+1];plain(r.span[0]);
      if (r.type==="cell" && n?.type==="cell" && /^\s*:\s*$/.test(original.slice(r.span[1],n.span[0]))) {
        let range;
        try { range=T.range(s,r,n); } catch {return failed("broken-reference","A range endpoint was removed.",[r.span[0],n.span[1]]);}
        if(range.rows.length*range.columns.length>T.limits.range) return failed("limit","This range exceeds the table calculation limit.",[r.span[0],n.span[1]]);
        const span=[r.span[0],n.span[1]],cells=[];
        for(const rowId of range.rows)for(const columnId of range.columns) {
          watched.push([rowId,columnId]);
          if(T.get(s,rowId,columnId)?.content)cells.push([rowId,columnId]);
        }
        reference({range:cells},span);
        cursor=n.span[1];i++;
      } else {if(r.type==="cell")watched.push([r.rowId,r.columnId]);reference(r,r.span);cursor=r.span[1];}
    }
    plain(original.length);source+=")";map.push([original.length,original.length]);
    const origin=span=>[map[span[0]]?.[0]??1,map[Math.max(span[0],span[1]-1)]?.[1]??original.length];
    return {ok:true,source,refs,origin,watched};
  }
  // Reports retain the values and design inputs for the revision they represent.
  // Share untouched buckets so changing one result does not copy the whole cache.
  function snapshot(buckets=new Array(64)) {
    const owned=new Set();
    function bucket(key) {
      let hash=0;
      for(let i=0;i<key.length;i++)hash=(hash*31+key.charCodeAt(i))|0;
      return hash&63;
    }
    function writable(i) {
      if(!owned.has(i)){buckets[i]=new Map(buckets[i]);owned.add(i);}
      return buckets[i];
    }
    return {
      get:key=>buckets[bucket(key)]?.get(key),
      set:(key,value)=>writable(bucket(key)).set(key,value),
      delete:key=>{const i=bucket(key);if(buckets[i]?.has(key))writable(i).delete(key);},
      fork(){owned.clear();return snapshot(buckets.slice());}
    };
  }
  const position=(r,c)=>JSON.stringify([r,c]);
  function sameAxes(a,b) {
    const same=(left,right)=>left===right || left.length===right.length &&
      left.every((value,i)=>value.id===right[i].id && value.unit===right[i].unit);
    return same(a.rows,b.rows)&&same(a.columns,b.columns);
  }
  function engine({project,doc,item,design,store,authority}={}) {
    const formulas=new Map(),linked=new Set(),unbound=new Set(),dynamic=new Set();
    const watchedBy=new Map(),watches=new Map(),compiled=new Map();
    let last,stats={visited:0,evaluated:0,cyclic:0},inputs=snapshot();
    const sheet=doc?.id??"sheet",table=item?.id??"table",context={documentId:sheet,instanceId:null};
    const model=()=>design ??= project && G.AtriumCalculationDesign?.create(project,store,authority);
    function removeWatches(k) {
      for(const watched of watches.get(k)||[]){
        const users=watchedBy.get(watched);
        users.delete(k);
        if(!users.size)watchedBy.delete(watched);
      }
      watches.delete(k);
      compiled.delete(k);
    }
    function keepWatches(k,list) {
      watches.set(k,list);
      for(const watched of list){
        if(!watchedBy.has(watched))watchedBy.set(watched,new Set());
        watchedBy.get(watched).add(k);
      }
    }
    function readDesign(k,cell,revision) {
      const api=model();
      if(!api)return;
      api.sync(revision);
      const pins=cell?.content ? formulaReferences(cell.content).filter(r=>r.type==="design") : [];
      const references=pins.map(r=>({
        id:r.span[0],name:r.name,span:r.span,target:r.target || api.resolveName(context,r.name)?.binding
      }));
      api.trackInputs(k,context,references);
      if(references.length){
        linked.add(k);
        if(pins.some(r=>!r.target))unbound.add(k);else unbound.delete(k);
        inputs.set(k,api.readInputs(k));
      } else {
        linked.delete(k);unbound.delete(k);inputs.delete(k);
      }
    }
    function sync(s,revision,readContent,axesChanged) {
      const dirty=new Set(),rebind=new Set(),recompile=new Set();
      if(!last || last.s.cells!==s.cells){
        const edits=last ? T.changedCells(last.s,s) : s.cells;
        for(const edit of edits){
          const {before,after}=last?edit:{after:edit};
          if(T.equal(before?.content,after?.content))continue;
          const {rowId,columnId}=after||before,k=position(rowId,columnId);
          if(last)dirty.add(k);
          if(Boolean(before?.content)!==Boolean(after?.content))
            for(const user of watchedBy.get(k)||[])recompile.add(user);
          if(after?.content?.kind==="formula"){
            formulas.set(k,after);dirty.add(k);recompile.add(k);
          } else if(formulas.delete(k))recompile.add(k);
          if(after?.content && !["literal","formula"].includes(after.content.kind))dynamic.add(k);
          else dynamic.delete(k);
          if(linked.has(k) || after?.content?.references?.some(r=>r.type==="design"))rebind.add(k);
        }
      }
      if(axesChanged)for(const k of formulas.keys()){dirty.add(k);recompile.add(k);}
      if(last && last.readContent!==readContent)for(const k of dynamic)dirty.add(k);
      if(last?.revision!==revision && linked.size){
        model()?.sync(revision);
        for(const k of model()?.takeInputChanges()||[]){
          inputs.set(k,model().readInputs(k));dirty.add(k);recompile.add(k);
        }
        for(const k of unbound)rebind.add(k);
      }
      for(const k of rebind){
        const previous=inputs.get(k);
        readDesign(k,formulas.get(k),revision);
        if(!T.equal(previous,inputs.get(k))){dirty.add(k);recompile.add(k);}
      }
      for(const k of dirty)for(const user of watchedBy.get(k)||[])dirty.add(user);
      for(const k of recompile)removeWatches(k);
      return dirty;
    }
    function nodeFor(s,k,linkedInputs,readContent,active) {
      if(active && compiled.has(k))return compiled.get(k);
      const [rowId,columnId]=JSON.parse(k),cell=T.get(s,rowId,columnId),content=cell?.content;
      if(!content)return null;
      const unit=s.columns[T.index(s).columns.get(columnId)]?.unit||null;
      const formula=content.kind==="formula",tableLiteral=content.kind==="literal";
      let source=tableLiteral?content.text:"",references=[],watch=[],failure,origin;
      if(formula){
        const translated=lower(s,content);
        if(!translated.ok)failure=translated;
        else{
          source=translated.source;origin=translated.origin;
          watch=translated.watched.filter(a=>a.every(Boolean)).map(([r,c])=>position(r,c));
          const designRefs=new Map(linkedInputs.get(k)?.map(r=>[r.id,r]));
          references=translated.refs.map(ref=>{
            const base={name:ref.name,span:ref.span,target:null};
            if(ref.range)return {...base,range:ref.range.map(([r,c])=>position(r,c))};
            if(ref.design){
              const linked=designRefs.get(ref.design.span[0]);
              return linked?.target ? {...linked,...base,target:linked.target} : {...base,diagnostic:{
                code:"unbound",message:"Choose a design field for "+ref.design.name+"."
              }};
            }
            const {rowId,columnId}=ref.axis,ix=T.index(s);
            if(!ix.rows.has(rowId)||!ix.columns.has(columnId))return {...base,diagnostic:{code:"broken-reference",message:"A referenced cell was removed."}};
            if(!T.get(s,rowId,columnId)?.content)return {...base,field:{raw:"0",sourceId:ref.name}};
            return {...base,dependency:position(rowId,columnId),target:T.target(sheet,table,rowId,columnId)};
          });
        }
      } else if(tableLiteral){
        if(unit && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(source.trim()))source+=" "+unit;
      } else {
        const raw=readContent?.(content);
        if(raw==null)failure=failed("type","This cell has no numeric value.",[0,0]);else source=String(raw);
      }
      const node={key:k,documentId:sheet,blockId:table,label:T.label(s,rowId,columnId),source,references,
        languageVersion:1,displayUnit:unit,failure,origin,tableLiteral,deferErrors:formula};
      if(active&&formula){keepWatches(k,new Set(watch));compiled.set(k,node);}
      return node;
    }
    function compute(s,options={}) {
      const {revision=0,readContent,lazy=false}=options;
      const axesChanged=last && !sameAxes(last.s,s),dirty=sync(s,revision,readContent,axesChanged);
      const values=axesChanged? snapshot() : last?.values.fork()??snapshot(),linkedInputs=inputs.fork();
      for(const k of dirty)values.delete(k);
      const receipt={s,revision,values,readContent};last=receipt;
      const counters={visited:0,evaluated:0,cyclic:0};stats=counters;
      function evaluate(roots) {
        const pending=new Set(roots),nodes=new Map(),known=[];
        for(const k of pending){
          const cached=values.get(k);
          if(cached){known.push([k,cached]);continue;}
          const node=nodeFor(s,k,linkedInputs,readContent,last===receipt);
          if(!node)continue;
          if(node.failure){
            const row={result:node.failure,inputs:[]};values.set(k,row);known.push([k,row]);continue;
          }
          nodes.set(k,node);
          if(nodes.size>graph().maxNodes)return false;
          for(const ref of node.references){
            if(ref.dependency)pending.add(ref.dependency);
            for(const dependency of ref.range||[])pending.add(dependency);
          }
        }
        if(!nodes.size)return true;
        const run=graph().run({nodes:[...nodes.values()],known,roots});
        for(const [k,row] of run.changed){
          const origin=nodes.get(k).origin,diagnostic=row.result?.diagnostic;
          if(diagnostic&&origin)row.visible={...row.result,diagnostic:{...diagnostic,span:origin(diagnostic.span)}};
          values.set(k,row);
        }
        for(const key of Object.keys(counters))counters[key]+=run.stats[key];
        return true;
      }
      if(!lazy && formulas.size<=4096)evaluate([...dirty].filter(k=>formulas.has(k)));
      return {get stats(){return {...counters};},value:(r,c)=>{
        const k=position(r,c);
        if(!values.get(k) && !evaluate([k]))values.set(k,{result:failed("limit","This formula has too many calculation dependencies.",[0,0]),inputs:[]});
        const row=values.get(k);
        return row?.visible??row?.result;
      },bind:source=>scan(s,source,{resolveDesign:name=>{
        const api=model();api?.sync(revision);
        return api?.resolveName(context,name)?.binding;
      }})};
    }
    return {compute,get stats(){return {...stats};}};
  }
  const pools=new WeakMap();
  function report(project,doc,item,options={},state=item.widget.state) {
    const host=options.host || (G.AtriumNavHost?.project?.()===project ? G.AtriumNavHost : null);
    const store=options.store ?? (host ? G.AtriumUndoStore : null),revision=options.revision ?? host?.revision?.() ?? 0;
    const context={...options,revision};
    if(options.authority)return engine({project,doc,item,store,authority:options.authority}).compute(state,context);
    let pool=pools.get(project);
    if(!pool)pools.set(project,pool=new Map());
    const key=JSON.stringify([doc.id,item.id]);let entry=pool.get(key);
    if(!entry || entry.store!==store){
      if(pool.size>=64)pool.delete(pool.keys().next().value);
      entry={store,engine:engine({project,doc,item,store})};pool.set(key,entry);
    }
    return entry.engine.compute(state,context);
  }
  return Object.freeze({scan,lower,spelling,copyTo,fillDown,engine,report});
})();
if (typeof module!=="undefined") module.exports=globalThis.AtriumTableFormulas;
