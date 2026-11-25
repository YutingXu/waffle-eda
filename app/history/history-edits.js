"use strict";
// One preview freezes the fields that the user is about to restore. Applying it later checks
// each original value again. Newer writes, deleted owners and peer-owned fields survive.
globalThis.AtriumHistoryEdits = (() => {
  const own = (o,k) => o != null && Object.hasOwn(o,k);
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const equal = (a,b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const byId = rows => new Map(rows.map(v => [v.id,v]));
  const keyed = a => Array.isArray(a) && a.every(x => object(x) && typeof x.id === "string") && new Set(a.map(x => x.id)).size === a.length;
  const id = value => ({id:value});
  const prefix = (a,b) => a.length <= b.length && a.every((s,i) => typeof s === "string" ? s === b[i] : s.id === b[i]?.id);
  const tableData = () => globalThis.AtriumTableData;
  const tableStatePath = path => path[0] === "documents" && path[2] === "items" &&
    path[4] === "widget" && path[5] === "state";
  const cellAddress = cell => ({id:cell.id,rowId:cell.rowId,columnId:cell.columnId});
  const sameCellPosition = (cell,address) => cell?.rowId===address.rowId && cell?.columnId===address.columnId;
  function cellPath(old,next) {
    const source=cellAddress(old||next);
    if (old && next && !sameCellPosition(next,source)) source.destination=cellAddress(next);
    return source;
  }
  function cellAt(table,address) {
    const indexed=tableData().get(table,address.rowId,address.columnId);
    if (sameCellPosition(indexed,address)) return indexed;
    return table.cells.find(cell=>sameCellPosition(cell,address));
  }
  function conflicts(changed,path) {
    if (prefix(changed,path) || prefix(path,changed)) return true;
    const cell=path[6]==="cells" && path[7];
    if (!cell?.rowId || !cell.columnId || !tableStatePath(path) ||
        changed.length!==8 || !prefix(path.slice(0,6),changed)) return false;
    // A row/column removed and recreated at the same address has a new owner.
    // A change to one of its properties is independent of the cell itself.
    const key=changed[7]?.id;
    return changed[6]==="rows" && (key===cell.rowId || key===cell.destination?.rowId) ||
      changed[6]==="columns" && (key===cell.columnId || key===cell.destination?.columnId);
  }

  function tableChanges(before,after) {
    const T=tableData();
    if (!T?.is(before) || !T.is(after) || !Array.isArray(before.cells) || !Array.isArray(after.cells)) return null;
    if (before.cells===after.cells) return [];
    const change=T.cellTransition?.(before,after);
    if (change?.before && change.after) return [change];
    const reverse=T.cellTransition?.(after,before);
    if (reverse?.before && reverse.after) return [{before:reverse.after,after:reverse.before}];
    // A detached legacy snapshot may have no transition proof. Match in place
    // when all IDs still line up, and retain the ordered differ for structure.
    if (before.cells.length!==after.cells.length) return null;
    const out=[];
    for (let i=0;i<before.cells.length;i++) {
      const old=before.cells[i], next=after.cells[i];
      if (typeof old?.id!=="string" || old.id!==next?.id) return null;
      if (!T.equal(old,next)) out.push({before:old,after:next});
    }
    return out;
  }
  function walk(before, after, path, emit) {
    if (before === after) return;
    if (object(before) && object(after)) {
      const delta=path.length===6 && tableStatePath(path) ? tableChanges(before,after) : null;
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (k === "cells" && delta) {
          for (const {before:old,after:next} of delta) walk(old,next,[...path,k,cellPath(old,next)],emit);
        } else walk(before[k], after[k], [...path,k], emit);
      }
    } else if (keyed(before) && keyed(after)) {
      const a = byId(before), b = byId(after);
      const address = path.length===7 && path[6]==="cells" && tableStatePath(path) ? cellPath : (old,next)=>id((old||next).id);
      for (const [k,v] of a) if (!b.has(k)) emit([...path,address(v)], v, undefined);
      let prev;
      for (let i=0;i<after.length;i++) {
        const item=after[i], key=item.id, old=a.get(key), here=[...path,address(old,item)];
        if (old) walk(old,item,here,emit);
        else emit(here,undefined,item,{prev,next:after[i+1]?.id});
        prev=key;
      }
      const was=before.map(x=>x.id).filter(k=>b.has(k)), next=after.map(x=>x.id).filter(k=>a.has(k));
      if (!equal(was,next)) emit(path,was,after.map(x=>x.id),{order:true});
    } else if (!equal(before,after)) emit(path,before,after);
  }
  function changedPaths(records) {
    const paths=[];
    for (const r of records || []) {
      if (r.t === "r") { paths.push([]); continue; }
      const n=r.node, path=n.doc ? ["documents",id(n.doc.ref.id)] : [];
      if (n.path) path.push(...n.path.split("."));
      if (r.t === "k") paths.push([...path,r.key]);
      else if (r.t === "s") {
        for (const [,item] of [...r.removed,...r.inserted]) paths.push(item?.id ? [...path,id(item.id)] : path);
      } else if (r.t === "e" && r.ref?.id) {
        const edit=globalThis.AtriumUndoStore?.tableCellEdit?.(r), owner=[...path,id(r.ref.id)];
        if (edit?.before || edit?.after) {
          const before=edit.before ?? undefined, after=edit.after ?? undefined;
          walk(before,after,[...owner,"widget","state","cells",cellAddress(after||before)],p=>paths.push(p));
        } else {
          const {before,after}=r;
          if (typeof before==="string" && typeof after==="string") {
            walk(JSON.parse(before),JSON.parse(after),owner,p=>paths.push(p));
          } else paths.push(path);
        }
      } else paths.push(path);
    }
    return paths;
  }
  function plan(before,after,peerRecords=[]) {
    const ops=[], protectedPaths=changedPaths(peerRecords);
    let preserved=0;
    walk(before,after,[],(path,a,b,extra) => {
      if (!path.length || path[0] === "units") return;
      if (protectedPaths.some(p => conflicts(p,path))) {preserved++; return;}
      ops.push({path,before:clone(a),after:clone(b),...extra});
    });
    return {ops,preserved};
  }
  function at(value, path, indexed=false) {
    let table;
    for (const step of path) {
      if (typeof step === "string") {
        table=indexed && step==="cells" && tableData()?.is(value) ? value : null;
        value=own(value,step)?value[step]:undefined;
      } else {
        if (table && step.rowId && step.columnId) {
          const cell=cellAt(table,step);
          value=cell?.id===step.id ? cell : undefined;
        } else value=Array.isArray(value)?value.find(v=>v?.id===step.id):undefined;
        table=null;
      }
      if (value === undefined) break;
    }
    return value;
  }
  function ready(project, op) {
    if (!op.path.length || at(project,op.path.slice(0,-1),true) == null) return false;
    const path=op.path, cell=path[7];
    if (path.length===8 && path[6]==="cells" && tableStatePath(path) && cell?.rowId && cell.columnId && op.before===undefined) {
      const table=at(project,path.slice(0,6));
      // In an insertion, absence must hold for both the durable ID and
      // position. An index miss alone cannot prove an address is empty.
      if (table?.cells?.some(row=>row.id===cell.id || sameCellPosition(row,cell))) return false;
    }
    const value=at(project,path,true);
    if (!op.order) return equal(value,op.before);
    if (!Array.isArray(value)) return false;
    const keys=new Set(op.before);
    return equal(value.map(i=>i.id).filter(k=>keys.has(k)),op.before);
  }
  function cellAxesAvailable(project, op, ops) {
    const path=op.path, cell=path[7];
    if (!cell?.rowId || !cell.columnId || !tableStatePath(path)) return true;
    const tablePath=path.slice(0,6), table=at(project,tablePath);
    const ix=tableData()?.is(table) && tableData().index(table);
    if (!ix) return true;
    // The selected snapshot may restore a missing axis along with the cell.
    // If the axis was removed after review and is outside the plan, keep it removed.
    const available=(axis,key)=>table[axis][ix[axis].get(key)]?.id===key ||
      table[axis].some(row=>row.id===key) || ops.some(other=>
        other.path.length===8 && other.path[6]===axis && other.path[7]?.id===key &&
        other.before===undefined && other.after!==undefined && prefix(tablePath,other.path));
    if (!available("rows",cell.rowId) || !available("columns",cell.columnId)) return false;
    const destination=cell.destination;
    if (!destination) return true;
    if (!available("rows",destination.rowId) || !available("columns",destination.columnId)) return false;
    const occupant=table.cells.find(row=>row.id!==cell.id && sameCellPosition(row,destination));
    return !occupant || ops.some(other=>other.path.length===8 && other.path[6]==="cells" &&
      other.path[7]?.id===occupant.id && other.after===undefined && prefix(tablePath,other.path));
  }
  function put(project, op) {
    const part=op.path.at(-1), owner=at(project,op.path.slice(0,-1));
    if (op.order) {
      const list=at(project,op.path), records=byId(list), keys=new Set(op.after);
      const ordered=op.after.filter(key=>records.has(key)).map(key=>records.get(key));
      let i=0; for (let j=0;j<list.length;j++) if (keys.has(list[j].id)) list[j]=ordered[i++];
    } else if (typeof part === "string") {
      if (op.after === undefined) delete owner[part];
      else Object.defineProperty(owner,part,{value:clone(op.after),enumerable:true,configurable:true,writable:true});
    } else {
      const i=owner.findIndex(v=>v?.id===part.id);
      if (op.after === undefined) owner.splice(i,1);
      else {
        const prev=owner.findIndex(v=>v?.id===op.prev), next=owner.findIndex(v=>v?.id===op.next);
        owner.splice(prev>=0?prev+1:next>=0?next:owner.length,0,clone(op.after));
      }
    }
  }
  function apply(project, ops, detachTables=false) {
    const detached=new Set();
    for (const op of ops) {
      if (detachTables && op.path.length>6 && tableStatePath(op.path)) {
        const item=at(project,op.path.slice(0,4));
        if (tableData()?.isItem(item) && !detached.has(item)) {
          item.widget={...item.widget,state:clone(item.widget.state)};
          detached.add(item);
        }
      }
      put(project,op);
    }
    return project;
  }
  // A table cell edit only changes its table owner. Keep that owner detached
  // until validation passes, and publish the same immutable update and Undo hint
  // as the table editor. Use the general restore path for other table structure.
  function prepareCells(project, ops) {
    const T=tableData(), owners=new Map();
    if (!T) return null;
    for (const op of ops) {
      const path=op.path, cell=path[7], whole=path.length===8;
      if (!tableStatePath(path) || path[6]!=="cells" || !cell?.rowId || !cell.columnId ||
          (!whole && !["content","style"].includes(path[8]))) return null;
      const doc=at(project,path.slice(0,2)), item=at(doc,path.slice(2,4));
      if (!T.isItem(item)) return null;
      let owner=owners.get(item);
      if (!owner) { owner={doc,cells:new Map()}; owners.set(item,owner); }
      const prior=item.widget.state;
      let draft=owner.cells.get(cell.id);
      if (!draft) {
        const current=cellAt(prior,cell);
        if (whole) {
          if (current?.id===cell.id && op.after===undefined)
            draft={value:cell, remove:true};
          else if (!current && ops.length===1 && op.after) {
            // This optimized insertion must preserve the requested sparse array order.
            const ix=T.index(prior).byId, prev=ix.get(op.prev), next=ix.get(op.next);
            if ((prev===undefined ? next ?? prior.cells.length : prev+1)!==prior.cells.length ||
                op.after.id!==T.cellId(cell.rowId,cell.columnId) ||
                Object.keys(op.after).some(key=>!["id","rowId","columnId","content","style"].includes(key))) return null;
            draft={value:clone(op.after)};
          } else return null;
        } else {
          if (!current || current.id!==cell.id) return null;
          draft={value:clone(current)};
        }
        owner.cells.set(cell.id,draft);
      }
      if (!whole) put(draft.value,{...op,path:path.slice(8)});
    }

    const widgets=new Map(), hints=[];
    for (const [item,{doc,cells}] of owners) {
      const rows=[];
      for (const {value:{rowId,columnId,content,style},remove} of cells.values()) {
        if ((!remove && !content && !style) || (content?.kind==="literal" && !content.text) ||
            (style && !Object.keys(style).length)) return null;
        rows.push({rowId,columnId,content:content ?? null,style:style ?? null});
      }
      const prior=item.widget.state, state=T.batch(prior,rows);
      T.validateView(state);
      const widget={...item.widget,state};
      widgets.set(item,widget);
      hints.push(T.cellUndoScope?.(doc,item,prior,state) || {doc,items:[item]});
    }
    return {hints,apply(){for (const [item,widget] of widgets) item.widget=widget;}};
  }
  function requiredDefinitions(project, trial, refs) {
    const before=byId(project.library), after=byId(trial.library), keep=new Set();
    const {geometries}=globalThis.Atrium;
    for (const doc of trial.documents) for (const item of doc.items) {
      if (item.kind !== "part") continue;
      const live=before.get(item.def), proposed=after.get(item.def);
      if (!geometries(proposed,doc.kind) && geometries(live,doc.kind)) keep.add(item.def);
    }
    // An unopened folder member has no item data in the model. Keep geometry it
    // may still reference until that member is loaded and can be checked above.
    if (refs) {
      const loaded=new Set(project.documents.map(doc=>doc.id));
      const kinds=new Set(refs.filter(doc=>!loaded.has(doc.id)).map(doc=>doc.kind));
      for (const [key,def] of before) for (const kind of ["schematic","pcb"]) {
        if (kinds.has(kind) && geometries(def,kind) && !geometries(after.get(key),kind)) keep.add(key);
      }
    }
    // A generated footprint can keep using its original after a later placement.
    for (const def of [...trial.library,...[...keep].map(key=>before.get(key))]) {
      for (let key=def.mirrorOf; key && !keep.has(key) && before.has(key) && !after.has(key); key=before.get(key).mirrorOf)
        keep.add(key);
    }
    return keep;
  }
  function restore(host, reviewed, label, later=[]) {
    const keep=changedPaths(later),p=host.project(),docs=new Set(),ids=new Set();
    let ops=reviewed.ops.filter(op=>!keep.some(path=>conflicts(path,op.path)) && ready(p,op));
    ops=ops.filter(op=>cellAxesAvailable(p,op,ops));
    const preserved=()=>reviewed.preserved + reviewed.ops.length-ops.length;
    if (!ops.length) return {applied:0,preserved:preserved()};

    let cells;
    try {
      cells=prepareCells(p,ops);
      let trial=cells ? p : apply(clone(p),ops);
      if (!cells && ops.some(op=>op.path[0] === "library")) {
        const required=requiredDefinitions(p,trial,host.documentRefs?.());
        if (required.size) {
          ops=ops.filter(({path:[field,def]})=>field !== "library" || !required.has(def?.id));
          if (!ops.length) return {applied:0,preserved:preserved()};
          trial=apply(clone(p),ops);
        }
      }
      if (!cells) globalThis.Atrium.validate(trial,{normalize:false});
    } catch (error) { throw Error("Restoring this history step would leave the design invalid. "+error.message); }

    const itemScopes=new Map();
    let precise=true;
    for (const op of ops) {
      const [root,d,field,item]=op.path;
      if (root === "documents" && d?.id) {
        docs.add(d.id);
        if (!field) for (const row of op.before?.items || []) ids.add(row.id);
      }
      if (root !== "documents" || !d?.id || field !== "items" || !item?.id) {precise=false;continue;}
      ids.add(item.id);
      if (!itemScopes.has(d.id)) itemScopes.set(d.id,new Set());
      itemScopes.get(d.id).add(item.id);
    }
    const hint=precise ? () => cells?.hints ?? [...itemScopes].map(([did,keys]) => ({doc:host.docById(did),items:[...keys]})) : undefined;
    const changed=host.edit(cells?.apply ?? (()=>apply(p,ops,true)),label,hint,{documents:[...docs],items:[...ids]});
    return {applied:changed === false ? 0 : ops.length,preserved:preserved()};
  }
  // One reviewed restore. Later records and the retained branch stay in the undo store.
  function reviewedRestore(host,undo,request){
    const live=globalThis.AtriumCollabLive;
    if(live?.active())live.flush?.();
    const capture=()=>request.keep&&{history:host.undoSteps().history.slice(),here:undo.mark(request.project,request.mark)};
    const prior=request.markFirst?capture():null;
    const later=undo.sinceReview(request.baseline);
    if(request.stale?.()||!later||!undo.viewState(request.read))return {cancelled:true};
    const line=prior||capture();
    let result;
    try { result=restore(host,request.plan,request.label,later); }
    catch (error) { return {failed:error}; }
    if(result.applied&&live?.active())live.flush?.();
    return {...result,retained:!!(result.applied&&line&&undo.preserveLine(request.anchor,line.history,line.here))};
  }
  return Object.freeze({plan,restore,reviewedRestore});
})();
