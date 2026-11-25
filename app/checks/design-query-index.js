"use strict";
// Per-document query projections. An accepted journal cursor belongs to the exact installed projection.
globalThis.AtriumDesignQueryIndex = (() => {
  const G = globalThis, byProject = new WeakMap(), receipts = new WeakMap();
  const now = () => G.performance?.now?.() ?? Date.now();
  const yieldTask = () => typeof setTimeout === "function" ? new Promise(resolve => setTimeout(resolve,0)) : Promise.resolve();
  const issue = (code,message,source = "") => ({complete:false,diagnostic:{code,message,span:[0,source.length]}});
  const idOf = (r,i = "") => String(r.docId || "") + "\u0000" + String(r.instanceId || "") + "\u0000" + String(r.id ?? i);
  const partKinds = new Set(["resistor","capacitor","inductor","led"]);
  const surrogate = /[\uD800-\uDFFF]/;
  // UTF-8 byte order agrees with scalar value order. UTF-16 only differs across the supplementary boundary.
  function order(a,b) {
    if (a === b) return 0;
    if (!surrogate.test(a) && !surrogate.test(b)) return a < b ? -1 : 1;
    const x = [...a], y = [...b];
    for (let i=0;i<Math.min(x.length,y.length);i++) {
      const delta=x[i].codePointAt(0)-y[i].codePointAt(0);
      if (delta) return delta;
    }
    return x.length-y.length;
  }
  function sortedIds(ids) {
    const list=Array.from(ids);
    return list.some(id=>surrogate.test(id)) ? list.sort(order) : list.sort();
  }
  function afterIndex(ids,id) {
    let low=0,high=ids.length;
    while(low<high) {
      const mid=low+Math.floor((high-low)/2);
      if(order(ids[mid],id)<=0)low=mid+1;
      else high=mid;
    }
    return low;
  }
  function allows(o,doc) {
    const a = o.authority;
    if (!a) return true;
    if (a.projectId && a.projectId !== o.project?.id || a.revoked || a.readProject === false) return false;
    if (a.canReadDocument && !a.canReadDocument(doc.id)) return false;
    return !a.documentIds || (a.documentIds.has?.(doc.id) ?? a.documentIds.includes(doc.id));
  }
  function current(o) {
    if (o.signal?.aborted) return issue("cancelled","The query was cancelled.");
    if (o.authority?.revoked || o.authority?.readProject === false) return issue("denied","Design access is unavailable.");
    if (o.isCurrent && !o.isCurrent(o.revision) || o.getRevision && o.getRevision() !== o.revision) return issue("stale","The design revision changed.");
    return null;
  }
  function partition(project,doc,kind,instanceId,authority) {
    let documents = byProject.get(project);
    if (!documents) byProject.set(project,documents = new WeakMap());
    let views = documents.get(doc);
    if (!views) documents.set(doc,views = new Map());
    const mode = partKinds.has(kind) ? "part" : kind;
    if(authority) {
      const stamp=authority.version ?? authority.revision;
      if(stamp==null)return {mode,instanceId,serial:0,cache:null};
      let privateViews=views.get(authority);
      if(!privateViews)views.set(authority,privateViews=new Map());
      views=privateViews;
      if(views.stamp!==stamp){views.clear();views.stamp=stamp;}
    }
    const key = JSON.stringify([mode,instanceId || ""]);
    let view = views.get(key);
    if (!view) { view = {mode,instanceId,serial:0,cache:null}; views.set(key,view); }
    return view;
  }
  function addKey(m,k,id) {
    let s = m.get(k);
    if (!s) m.set(k,s = new Set());
    s.add(id);
  }
  function createCache({mode,instanceId},docId) {
    const children=mode==="object" || mode==="pin" || mode==="pad";
    return {mode,prefix:idOf({docId,instanceId}),rows:new Map(),postings:new Map(),owners:children ? new Map() : null,
      keys:new Map(),sorted:new Map(),sortedAll:null,
      netMembers:new Map(),netsByOwner:new Map()};
  }
  const exactKeys=new Set(["kind","designator","component.designator","net.name","name","layer","pin.number"]);
  const schematicNetField=key=>["net","net.name","hasnet"].includes(key.toLowerCase());
  function post(cache,id,row,{read,values}) {
    const key=read(row);
    if(key!==undefined)addKey(values,key,id);
    if(key==null)return;
    const keys=cache.keys.get(id);
    if(keys)keys.push(values,key);
    else cache.keys.set(id,[values,key]);
  }
  function insert(cache,row,owner) {
    const id = cache.prefix+String(row.id ?? "");
    const existing=cache.rows.get(id);
    if (existing) throw new Error("Duplicate qualified query identity: " + row.id);
    cache.rows.set(id,row);
    if(cache.owners)addKey(cache.owners,owner,id);
    for(const posting of cache.postings.values())post(cache,id,row,posting);
  }
  function ownedRows(cache,owner) {
    return cache.owners ? cache.owners.get(owner) || [] : [cache.prefix+String(owner ?? "")];
  }
  function deleteKey(map,key,id) {
    const group=map.get(key);
    if(group?.delete(id) && !group.size)map.delete(key);
  }
  function remove(cache,owner) {
    for (const id of ownedRows(cache,owner)) {
      const keys=cache.keys.get(id) || [];
      for(let i=0;i<keys.length;i+=2)deleteKey(keys[i],keys[i+1],id);
      for(const {values} of cache.postings.values())deleteKey(values,null,id);
      cache.keys.delete(id);
      cache.rows.delete(id);
    }
    cache.owners?.delete(owner);
  }
  function itemRows(cache,view,doc,item,ctx) {
    const {mode}=view,owner=item.id;
    const projection = G.AtriumDesignQueryContext;
    if (mode === "net") {
      if(ctx.authority?.canReadItem && !ctx.authority.canReadItem(owner,doc.id))return;
      const names=[];
      for(const name of projection.projectOwner(doc,item,ctx,{nets:true})) {
        names.push(name);
        addKey(cache.netMembers,name,owner);
      }
      if(names.length)cache.netsByOwner.set(owner,names);
      return;
    }
    const kind=projection.placedKind(doc,item), childKind=doc.kind === "pcb" ? "pad" : "pin";
    const parent=mode==="object" || kind===mode || mode==="part" && partKinds.has(kind);
    const children=kind==="part" && (mode==="object" || mode===childKind);
    if(!parent && !children || ctx.authority?.canReadItem && !ctx.authority.canReadItem(owner,doc.id))return;
    for(const row of projection.projectOwner(doc,item,ctx,{parent,terminals:children}))insert(cache,row,owner);
  }
  function createIndex(cache,ctx,version,changed,previous,owner,isCurrent) {
    const raw=G.AtriumDesignQueryContext.raw,empty=new Set();
    // Build a posting only when a plan uses it. Keep its reader so journal edits
    // update the same posting and remove the old key even when an item mutates.
    function posting(name,read) {
      let index=cache.postings.get(name);
      if(!index) {
        index={read,values:new Map()};
        for(const [id,row] of cache.rows)post(cache,id,row,index);
        cache.postings.set(name,index);
      }
      return index.values;
    }
    const exact=(key,plan)=>posting("field:"+key,row=>{
      const input=raw(row,key), value=input && typeof input==="object" ? plan.caseValue(row,key) : input;
      return typeof value==="string" ? value : null;
    });
    function union(groups) {
      if(groups.length===1)return groups[0] ?? empty;
      const ids=new Set();
      for(const rows of groups)for(const id of rows || empty)ids.add(id);
      return ids;
    }
    function selection(plan,spatial) {
      const sources=[],add=(hits=empty,absent=empty)=>sources.push({hits,absent});
      const {kind,indexTerms:terms}=plan;
      if(kind!==cache.mode)add(posting("part-kind",row=>row.kind==="part" ? ctx.partType(row) ?? undefined : row.kind).get(kind));
      if(!plan.customFields)for(const term of terms) {
        const key=term.key?.toLowerCase();
        if(term.type==="exact" && exactKeys.has(key) && ctx.canReadField(key) && !(ctx.derivedNets && schematicNetField(key))) {
          const values=exact(key,plan);
          add(values.get(term.value),values.get(null));
        }
        if(term.type==="range" && kind==="track" && key==="width" && term.unit==="mm") {
          const widths=posting("track-width",row=>Number.isFinite(row.item?.width) ? row.item.width : null);
          const groups=[...widths].filter(([width])=>width==null || plan.rangeAccepts(term,width));
          if(groups.length!==widths.size)add(union(groups.map(([,ids])=>ids)));
        }
        const request=term.type==="relation" && plan.posting(term);
        if(request && ctx.canReadField(request.key)) {
          const values=exact(request.key,plan);
          add(union([...request.values].map(name=>values.get(name))));
        }
        if(term.family==="layer" && !plan.customRelations && ctx.canReadField("layer")) {
          const name=term.target.name,copper=G.AtriumDesignQueryContext.copper(name),groups=[exact("layer",plan).get(name)];
          if(copper!=null)for(const [pair,ids] of posting("layer-span",row=>G.AtriumDesignQueryContext.layerRange(row)?.join(","))) {
            const [a,b]=pair.split(",").map(Number);
            if(a<=copper && copper<=b)groups.push(ids);
          }
          add(union(groups));
        }
      }
      const owners=spatial && plan.spatial(spatial.bounds);
      if(owners!=null) {
        const ids=new Set();
        for(const entry of owners) {
          const key=typeof entry==="string" ? entry : entry.ownerId || entry.id;
          for(const id of ownedRows(cache,key))if(cache.rows.has(id))ids.add(id);
          if(cache.rows.has(key))ids.add(key);
        }
        add(ids);
      }
      const [first,...rest]=sources.sort((a,b)=>a.hits.size-b.hits.size);
      const sorted=first ? sortedIds(rest.length ? [...first.hits].filter(id=>rest.every(s=>s.hits.has(id))) : first.hits) :
        (cache.sortedAll ??= sortedIds(cache.rows.keys()));
      // Missing exact fields cannot match a positive conjunct, but other conjuncts can
      // turn unavailable into false. Evaluate this tail after streaming the ordered hits.
      return function*() {
        for(const id of sorted)yield cache.rows.get(id);
        if(sources.some(s=>!s.hits.size && !s.absent.size))return;
        const seen=new Set();
        for(const {absent} of sources)for(const id of absent) {
          if(seen.has(id) || !sources.every(s=>s.hits.has(id) || s.absent.has(id)))continue;
          seen.add(id);
          yield cache.rows.get(id);
        }
      };
    }
    return {version,previous,changed,owner,isCurrent,derivedNets:ctx.derivedNets,lookup:id=>cache.rows.get(id),prepare(plan,options) {
      return plan.indexTerms.some(t=>t.type==="spatial") ? plan.prepareSpatial(options) : true;
    },candidates(plan) {
      const allowed=plan.indexTerms, spatial=allowed.find(t=>t.type==="spatial");
      const share=!spatial && !plan.customProviders && !allowed.some(t=>t.type==="relation");
      const cacheKey=JSON.stringify([plan.kind,allowed.filter(t=>t.type==="exact" || t.type==="range").map(t=>[t.type,t.key,t.op,t.value])]);
      const cached=share && cache.sorted.get(cacheKey);
      if(cached)return cached();
      const choose=selection(plan,spatial);
      if(share && cache.sorted.size<32)cache.sorted.set(cacheKey,choose);
      return choose();
    },suggestCase(plan) {
      return G.AtriumDesignQuery.caseSuggestions(plan,cache.rows.values());
    }};
  }
  async function documentIndex(project,doc,ctx,plan,o) {
    const denied=current(o) || (!plan.authorized() || !allows(o,doc) ? issue("denied","The requested design scope is unavailable.") : null);
    if(denied)return denied;
    if(o.budget && now()>o.budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
    const view=partition(project,doc,plan.kind,o.instanceId,o.authority),store=o.store || G.AtriumUndoStore;
    const seq=store?.documentVersions?.(doc,project)?.seq;
    const prior=view.job;
    if(prior && prior.seq===seq && prior.revision===o.revision && prior.items===doc.items && prior.count===doc.items?.length &&
        prior.occurrence===ctx.occurrence) {
      const result=await prior.promise;
      const bad=current(o);if(bad)return bad;
      if(!result.diagnostic || !["cancelled","denied","stale","budget"].includes(result.diagnostic.code))return result;
    }
    const job={seq,revision:o.revision,items:doc.items,count:doc.items?.length,occurrence:ctx.occurrence};
    job.promise=buildIndex(project,doc,ctx,plan,o,view,store);
    view.job=job;
    try{return await job.promise;}finally{if(view.job===job)view.job=null;}
  }
  async function buildIndex(project,doc,ctx,plan,o,view,store) {
    const version=store?.documentVersions?.(doc,project), seq=version?.seq;
    const derivedNets = ctx.derivedNets && view.mode==="net";
    const signature=[doc.items,doc.items?.length,project.library,store?.libraryVersion?.(),doc.kind,version?.outer,version?.parameters,
      version?.assembly,ctx.occurrence,derivedNets ? store?.hierarchyVersion?.(project) ?? o.revision : undefined];
    const sameSchema = view.signature && signature[0]===view.signature[0] && signature[2]===view.signature[2] &&
      signature[3]===view.signature[3] && signature[4]===view.signature[4] && signature.slice(5).every((v,i)=>v===view.signature[5+i]);
    if (view.cache && sameSchema && signature[1]===view.signature[1] &&
        (seq != null ? seq===view.seq : o.revision!=null && o.revision===view.revision)) return view.index;
    const serial=++view.serial;
    const delta=!derivedNets && view.cache && sameSchema && seq!=null && store.recordedChanges?.(doc,view.seq);
    const useDelta=!!(delta?.ids && delta.items);
    let cache=useDelta ? view.cache : createCache(view,doc.id);
    let end=now()+6;
    const before=new Set(),changedNets=new Set();
    if (useDelta) {
      for (const id of delta.ids) {
        if(view.mode==="net") {
          for(const name of cache.netsByOwner.get(id) || []) {
            changedNets.add(name);
            const members=cache.netMembers.get(name);members.delete(id);
            if(!members.size)cache.netMembers.delete(name);
          }
          cache.netsByOwner.delete(id);
          continue;
        }
        for (const key of ownedRows(cache,id))if(cache.rows.has(key))before.add(key);
        remove(cache,id);
      }
    }
    const items=useDelta ? delta.items.values() : doc.items || [];
    let scanned=0;
    for (const item of items) {
      itemRows(cache,view,doc,item,ctx);
      if(useDelta && view.mode==="net")for(const name of cache.netsByOwner.get(item.id) || [])changedNets.add(name);
      // Incremental edits are committed atomically before yielding.
      if (!useDelta && (++scanned & 127)===0 && (o.signal?.aborted || now()>=end)) {
        const bad=current(o);
        if(bad || serial!==view.serial)return bad || issue("stale","A newer query replaced this projection.");
        if(o.budget && now()>o.budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
        await (o.yieldTask || yieldTask)();
        const interrupted=current(o);
        if(interrupted || serial!==view.serial)return interrupted || issue("stale","A newer query replaced this projection.");
        end=now()+6;
      }
    }
    if (view.mode==="net") {
      for (const name of useDelta ? changedNets : cache.netMembers.keys()) {
        const row=G.AtriumDesignQueryContext.netSubject(doc,name,o.instanceId);
        if(useDelta) {
          before.add(idOf(row));remove(cache,row.id);
          if(!cache.netMembers.has(name))continue;
        }
        insert(cache,row,row.id);
      }
    }
    const currentRevision=()=>doc.items===signature[0] && doc.items?.length===signature[1] &&
      (seq==null || store.documentVersions(doc,project)?.seq===seq) && signature[3]===store?.libraryVersion?.();
    const bad=current(o) || (!currentRevision() ? issue("stale","The design changed during indexing.") : null);
    if (bad || view.serial!==serial) {
      if(useDelta)view.cache=null;
      return bad || issue("stale","The projection changed.");
    }
    const after=new Set(before);
    if (useDelta) for(const id of delta.ids)for(const key of ownedRows(cache,id))if(cache.rows.has(key))after.add(key);
    if(!useDelta || after.size) {
      cache.sorted.clear();
      cache.sortedAll=null;
    }
    const previous=view.version;
    Object.assign(view,{cache,signature,seq,revision:o.revision,version:serial});
    view.index=createIndex(cache,ctx,serial,useDelta ? after : null,previous,view,()=>serial===view.serial && currentRevision());
    return view.index;
  }
  const stableResults = new WeakMap();
  const localMembership = (plan,derivedNets) => !plan.customProviders && plan.dependencies.every(key =>
    key.startsWith("kind:") || key.startsWith("field:") && (!derivedNets || !schematicNetField(key.slice(6))));
  // A consumer may keep a projected result across revisions if the journal can
  // still certify every field's source. Derived values and occurrences need their own proofs.
  function localProjectionCurrent(project,doc,plan,fields,context,{store = G.AtriumUndoStore} = {}) {
    if (!localMembership(plan,context.derivedNets) || context.authority || context.instanceId || plan.kind === "net" ||
        fields.some(G.AtriumDesignQueryContext.signalField) || context.derivedNets && fields.some(schematicNetField)) return null;
    const before = store?.documentVersions?.(doc,project), items = doc.items, library = project.library;
    if (!before || !Array.isArray(items)) return null;
    const keys = ["floor","items","outer","parameters","library","assembly","project"];
    return () => {
      const live = store.documentVersions(doc,project);
      return !!live && doc.items === items && project.library === library && keys.every(key => live[key] === before[key]);
    };
  }
  async function run(plan,index,o = {}) {
    const maxRows=o.localFilter && !o.authority ? 500001 : o.selection === true ? 50001 : 1000;
    const limit=Math.max(0,Math.min(maxRows,Number.isSafeInteger(o.limit)?o.limit:100));
    const firstPage=Math.max(1,Math.min(limit,o.pageSize ?? limit));
    const budget=o.budget || {remaining:2000000,deadline:now()+30000};
    const access=()=>current(o) || (index.isCurrent?.()===false ? issue("stale","The query projection is out of date.") : null) ||
      (!plan.authorized() || o.fields?.some(k=>!plan.fieldAllowed(k))
      ? issue("denied","The requested design scope is unavailable.") : null);
    const initial=access();
    if(initial)return initial;
    if(now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
    if(index.prepare && plan.indexTerms.some(t=>t.type==="spatial")) {
      const settled=await index.prepare(plan,{signal:o.signal,isCurrent:()=>now()<=budget.deadline && !access()});
      const bad=access();if(bad)return bad;
      if(now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
      if(settled===false)return issue("stale","The physical query inputs changed.",plan.source);
    }
    const reusable=index.owner && !o.authority && localMembership(plan,index.derivedNets);
    let cache,prior,checked=0,unknown=0,firstMissing=null;
    if(reusable) {
      cache=stableResults.get(index.owner);
      if(!cache)stableResults.set(index.owner,cache=new Map());
      prior=cache.get(plan.signature);
    }
    const unchanged=prior && prior.version===index.version;
    const incremental=prior && index.changed && prior.version===index.previous;
    function remember(hits,misses,sorted,missing) {
      const value={version:index.version,hits,misses,sorted,missing};
      if(cache) {
        if(cache.size>=32 && !cache.has(plan.signature))cache.delete(cache.keys().next().value);
        cache.set(plan.signature,value);
      }
      return value;
    }
    const publicRow=row=>plan.projectRow(row,o.fields);
    function finish(hits,rows,absent,missing) {
      const bad=access();
      if(bad)return bad;
      if(missing)return {complete:false,count:hits.size,rows,checked,unknown:absent,diagnostic:missing};
      const result={complete:true,count:hits.size,rows,unknown:absent,checked,snapshotId:o.revision};
      if(plan.measurements.length)result.measurements=plan.measurements;
      if(!hits.size && o.suggestions)result.suggestions=index.suggestCase?.(plan) || [];
      return access() || result;
    }
    const assess=row=>{
      checked++;budget.remaining--;
      return plan.evaluate(row);
    };
    if(unchanged || incremental) {
      let value=prior;
      if(incremental) {
        const updates=[];
        for(const id of index.changed) {
          const row=index.lookup(id);
          const match=row && plan.acceptsKind(row) ? assess(row) : false;
          if(budget.remaining<0)return issue("budget","The query work budget was reached.",plan.source);
          updates.push([id,match]);
          if((updates.length & 63)===0) {
            const bad=access();if(bad)return bad;
            if(now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
          }
        }
        const bad=access();if(bad)return bad;
        if(now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
        // Apply the accepted delta synchronously. Next pages still project
        // live fields, so their order only changes when membership does.
        const {hits,misses,missing}=prior;
        let sorted=prior.sorted;
        for(const [id,match] of updates) {
          const wasHit=hits.has(id), hit=match===true;
          if(wasHit!==hit) {
            if(hit)hits.add(id);
            else hits.delete(id);
            if(sorted && updates.length===1) {
              const at=afterIndex(sorted,id);
              if(hit)sorted.splice(at,0,id);
              else sorted.splice(at-1,1);
            } else sorted=null;
          }
          misses.delete(id);missing.delete(id);
          if(typeof match!=="boolean"){misses.add(id);if(match)missing.set(id,match);}
        }
        value=remember(hits,misses,sorted,missing);
      }
      if(budget.remaining<0 || now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
      if(limit && !value.sorted)value.sorted=sortedIds(value.hits);
      const rows=[];
      if(limit) {
        const at=o.afterId==null ? 0 : afterIndex(value.sorted,o.afterId);
        const end=Math.min(value.sorted.length,at+limit);
        for(let i=at;i<end;i++)rows.push(publicRow(index.lookup(value.sorted[i])));
      }
      const result=finish(value.hits,rows,value.misses.size,value.missing.values().next().value);
      if(result.complete && o.onPage)o.onPage({...result,rows});
      return access() || result;
    }
    const hits=new Set(),misses=new Set(),reasons=new Map(),rows=[];
    let pending=[],published=false,slice=now()+6,scanned=0;
    function publish(complete) {
      if(!o.onPage || !pending.length && !complete)return;
      o.onPage({rows:pending,count:hits.size,complete,snapshotId:o.revision});pending=[];published=true;
    }
    let source;
    if(typeof index.candidates==="function")source=index.candidates(plan);
    else {
      const spatial=plan.indexTerms.find(t=>t.type==="spatial");
      if(spatial)source=index.spatial?.(spatial.bounds);
      source??=typeof index.rows==="function" ? index.rows() : index.rows || index;
      if(Array.isArray(source))source=source.slice().sort((a,b)=>order(idOf(a),idOf(b)));
    }
    for(const row of source || []) {
      if((++scanned & 63)===0 && (o.signal?.aborted || now()>=slice)) {
        const bad=access();if(bad)return bad;
        if(now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
        publish(false);await (o.yieldTask || yieldTask)();
        const interrupted=access();if(interrupted)return interrupted;
        slice=now()+6;
      }
      if(!plan.rowAllowed(row))continue;
      const value=assess(row);
      if(budget.remaining<0)return issue("budget","The query work budget was reached.",plan.source);
      if(typeof value!=="boolean") {
        const key=idOf(row);
        unknown++;if(cache)misses.add(key);
        if(value){firstMissing ||= value;if(cache)reasons.set(key,value);}
      } else if(value) {
        const key=idOf(row);
        if(!hits.has(key)) {
          hits.add(key);
          if(rows.length<limit && (o.afterId==null || order(key,o.afterId)>0)){const ref=publicRow(row);rows.push(ref);pending.push(ref);}
        }
      }
      if(o.onPage && !published && rows.length===firstPage) {
        const bad=access();if(bad)return bad;
        if(now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
        publish(false);
        const interrupted=access();if(interrupted)return interrupted;
      }
    }
    if(budget.remaining<0 || now()>budget.deadline)return issue("budget","The query work budget was reached.",plan.source);
    const result=finish(hits,rows,unknown,firstMissing);
    if(result.complete || result.diagnostic?.code==="measurement")remember(hits,misses,index.owner ? [...hits] : null,reasons);
    if(result.complete)publish(true);
    return access() || result;
  }
  async function runDocument(plan,context,options = {}, existing) {
    const {project,doc} = context;
    const index = existing || await documentIndex(project,doc,context,plan,options);
    if (index.diagnostic) return index;
    options.onIndex?.(index);
    return run(plan,index,options);
  }
  function selection(o,source) {
    if (!o?.project) return issue("project","Provide an authorized project snapshot.",source);
    const bad=current(o); if (bad)return bad;
    const docs=o.project.documents || [], subset=o.documentId == null ? docs : docs.filter(d=>d.id===o.documentId);
    if (!subset.length && o.documentId!=null || subset.some(d=>!allows(o,d))) return issue("denied","The requested document scope is unavailable.",source);
    return {docs:subset};
  }
  function receiptKey(source,o) {
    return JSON.stringify([source,o.revision,o.documentId || "",o.instanceId || ""]);
  }
  function countSnapshot(source,o) {
    const selected=selection(o,source);
    if(!selected.docs)return selected;
    const hit=receipts.get(o.project)?.get(receiptKey(source,o));
    if(!hit || hit.authority!==o.authority || o.revision==null)return issue("incomplete","An exact count for this snapshot is unavailable.",source);
    if(hit.plans.some(p=>!p.authorized()) || o.authority && (o.authority.version ?? o.authority.revision)!==hit.authorityVersion)
      return issue("denied","The requested design scope is unavailable.",source);
    if(o.authority?.canReadItem && hit.authorityVersion==null)return issue("incomplete","A new authorized count is required.",source);
    return {...hit.result};
  }
  async function count(source,o={}) {
    const selected=selection(o,source);
    if(!selected.docs)return selected;
    let total=0;
    const plans=[],budget=o.budget || {remaining:2000000,deadline:now()+30000};
    for (const doc of selected.docs) {
      const ctx=G.AtriumDesignQuery.context(o.project,doc,o);
      const checked=await G.AtriumDesignQuery.prepare(source,ctx);
      if(!checked.ok)return {complete:false,diagnostic:checked.diagnostics[0]};
      plans.push(checked.plan);
      if(o.authority?.canReadField && checked.plan.dependencies.some(k=>k.startsWith("field:") && !o.authority.canReadField(k.slice(6)))) return issue("denied","The requested field is unavailable.",source);
      const result=await runDocument(checked.plan,ctx,{...o,limit:0,budget},o.index);
      if(!result.complete)return result;
      total+=result.count;
    }
    const bad=current(o); if(bad)return bad;
    if(selected.docs.some(d=>!allows(o,d)) || plans.some(p=>!p.authorized()))return issue("denied","The requested design scope is unavailable.",source);
    const result={count:total,complete:true,revision:o.revision};
    if(o.onPlan)for(const [index,plan] of plans.entries())o.onPlan(plan,selected.docs[index].id);
    if(o.revision!=null) {
      let cache=receipts.get(o.project);
      if(!cache)receipts.set(o.project,cache=new Map());
      if(cache.size>=128)cache.delete(cache.keys().next().value);
      cache.set(receiptKey(source,o),{authority:o.authority,authorityVersion:o.authority?.version ?? o.authority?.revision,plans,result});
    }
    return result;
  }
  return Object.freeze({run,runDocument,documentIndex,localProjectionCurrent,count,countSnapshot,order,idOf,
    terminalId:G.AtriumDesignQueryContext.terminalId});
})();
