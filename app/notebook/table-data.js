"use strict";

// Sparse Butter tables. Axis IDs are authored once. A cell is identified by its
// two axes, including when two collaborators fill the same empty cell offline.
globalThis.AtriumTableData = (() => {
  const G=globalThis, feature="notebook.table.v1", version="2.1";
  const limits=Object.freeze({rows:8192,columns:256,cells:32768,merges:1024,text:16384,range:8192});
  const indexes=new WeakMap(), axisIndexes=new WeakMap(), cellIndexes=new WeakMap(), mergeIndexes=new WeakMap();
  const cellVersions=new WeakMap(), kinds=new WeakMap(), hashed=new Map(), encoder=new TextEncoder();
  const cellIdentities=new WeakMap();
  const validatedViews=new WeakSet();
  const reservedKeys=["kind","localId","tableId","order","__proto__","constructor","prototype"];
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
  const obj=v=>v!==null && typeof v==="object" && !Array.isArray(v);
  const short=(s,max)=>typeof s==="string" && s.length<=max;
  const idOK=s=>typeof s==="string" && /^[\x21-\x7e]{1,128}$/.test(s);
  const positive=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
  const copy=v=>JSON.parse(JSON.stringify(v));
  const is=s=>s?.tableVersion===1;
  const isItem=item=>item?.kind==="textframe" && item.widget?.type==="table" && is(item.widget.state);
  const savedQueryScope=scope=>obj(scope) && own(scope,"savedQueryId") && idOK(scope.savedQueryId) &&
    Object.keys(scope).length===1;
  const themes=new Set(["paper","text","muted","accent","line","header","band","transparent"]);
  const color=c=>themes.has(c)||typeof c==="string"&&/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c);
  const fail=message=>{throw Error(message);};
  function cellId(rowId,columnId) {
    const key=JSON.stringify([rowId,columnId]);
    if (hashed.has(key)) return hashed.get(key);
    const hash="v"+G.AtriumSourceFile.sha256(encoder.encode(key));
    if (hashed.size>=32768) hashed.delete(hashed.keys().next().value);
    hashed.set(key,hash);return hash;
  }
  const position=(rowId,columnId)=>JSON.stringify([rowId,columnId]);
  function axisIndex(axis) {
    let lookup=axisIndexes.get(axis);
    if(!lookup){lookup=new Map(axis.map((value,i)=>[value.id,i]));axisIndexes.set(axis,lookup);}
    return lookup;
  }
  function cellIndex(cells) {
    let lookup=cellIndexes.get(cells);
    if(!lookup){
      lookup={cells:new Map(),byId:new Map()};
      cells.forEach((cell,i)=>{lookup.cells.set(position(cell.rowId,cell.columnId),i);lookup.byId.set(cell.id,i);});
      cellIndexes.set(cells,lookup);
    }
    return lookup;
  }
  function index(s) {
    let value=indexes.get(s);
    if(value)return value;
    value={rows:axisIndex(s.rows),columns:axisIndex(s.columns),
      get cells(){return cellIndex(s.cells).cells;},get byId(){return cellIndex(s.cells).byId;}};
    indexes.set(s,value);
    return value;
  }
  function cellVersion(cells) {
    let version=cellVersions.get(cells);
    if(!version){version={id:{}};cellVersions.set(cells,version);}
    return version;
  }
  function recordCells(previous,next,changes,offset) {
    cellVersions.set(next,{id:{},parent:cellVersion(previous).id,changes,offset});
    const known=kinds.get(previous);
    if(known){
      const counts=new Map(known);
      for(const {before,after} of changes){
        for(const [cell,delta] of [[before,-1],[after,1]])if(cell?.content){
          const k=cell.content.kind,count=(counts.get(k)||0)+delta;
          if(count)counts.set(k,count);else counts.delete(k);
        }
      }
      kinds.set(next,counts);
    }
  }
  function contentKinds(s) {
    let counts=kinds.get(s.cells);
    if(!counts){
      counts=new Map();
      for(const {content} of s.cells)if(content)counts.set(content.kind,(counts.get(content.kind)||0)+1);
      kinds.set(s.cells,counts);
    }
    return counts;
  }
  function changedFrom(next,prior) {
    return next.rows===prior.rows && next.columns===prior.columns && next.merges===prior.merges &&
      next.headerRows===prior.headerRows && next.headerColumns===prior.headerColumns &&
      next.banded===prior.banded && next.query===prior.query &&
      cellVersions.get(next.cells)?.parent===cellVersion(prior.cells).id;
  }
  function recentCellEdit(state) {
    const changes=cellVersions.get(state.cells)?.changes;
    if(changes?.length!==1)return null;
    const edit=changes[0],{before,after}=edit;
    if(!after)return before && !state.cells.includes(before)?edit:null;
    if(!before)return state.cells.at(-1)===after?edit:null;
    if(get(state,after.rowId,after.columnId)!==after)return null;
    const {content:oldContent,style:oldStyle,...oldFields}=before,{content,style,...fields}=after;
    return (content===oldContent || content===undefined || contentOK(content)) &&
      (style===oldStyle || style===undefined || styleOK(style)) && (content!==undefined || style!==undefined) &&
      equal(oldFields,fields) ? edit : null;
  }
  function cellTransition(prior,next) {
    const version=cellVersions.get(next?.cells);
    if(!Number.isInteger(version?.offset) || !prior || !changedFrom(next,prior))return null;
    const beforeKeys=Object.keys(prior),afterKeys=Object.keys(next);
    if(beforeKeys.length!==afterKeys.length || beforeKeys.some((key,i)=>key!==afterKeys[i] || key!=="cells" && prior[key]!==next[key]))return null;
    const edit=version.changes[0];
    return edit && {offset:version.offset,...edit};
  }
  function cellUndoScope(doc,item,prior,next) {
    return {doc,items:[item],...(cellTransition(prior,next) && {tableCell:{item,prior,next}})};
  }
  function replayCell(s,offset,before,after) {
    const cells=s.cells.slice();
    cells.splice(offset,before?1:0,...(after?[after]:[]));
    if(before&&after && cellIndexes.has(s.cells))cellIndexes.set(cells,cellIndex(s.cells));
    recordCells(s.cells,cells,[{before:before?s.cells[offset]:undefined,after}],offset);
    const state={...s,cells};
    if(validatedViews.has(s))validatedViews.add(state);
    return state;
  }
  function changedCells(prior,next) {
    if(prior.cells===next.cells)return [];
    const version=cellVersions.get(next.cells);
    if(version?.parent===cellVersion(prior.cells).id)return version.changes;
    const lookup=cellIndex(prior.cells).byId,retained=new Set(),changes=[];
    for(const after of next.cells){
      const before=prior.cells[lookup.get(after.id)];
      retained.add(after.id);
      if(before!==after && !equal(before,after))changes.push({before,after});
    }
    if(retained.size!==prior.cells.length || changes.some(c=>!c.before))
      for(const before of prior.cells)if(!retained.has(before.id))changes.push({before});
    return changes;
  }
  function styleOK(v) {
    if(!obj(v))return false;
    return Object.entries(v).every(([k,x])=>{
      if(["fill","color"].includes(k))return color(x);
      if(k==="align")return ["left","center","right"].includes(x);
      if(k==="vertical")return ["top","middle","bottom"].includes(x);
      if(k==="bold"||k==="italic"||k==="wrap")return typeof x==="boolean";
      if(k==="borders")return obj(x)&&Object.entries(x).every(([edge,stroke])=>
        ["top","right","bottom","left"].includes(edge)&&color(stroke));
      return false;
    });
  }
  const refOK=r=>obj(r)&&/^[0-9a-f]{64}$/.test(r.sha256)&&
    ["image/jpeg","image/png","image/webp","image/heic","image/svg+xml"].includes(r.mediaType)&&positive(r.byteLength,128*1048576);
  function contentOK(v) {
    if(!obj(v))return false;
    switch(v.kind){
      case "literal": return short(v.text,limits.text);
      case "field": return short(v.expression,512)&&(!v.binding||obj(v.binding));
      case "calculation": return idOK(v.documentId)&&idOK(v.blockId)&&(!v.instanceId||idOK(v.instanceId));
      case "formula": {
        if (!short(v.source,limits.text)||!v.source.startsWith("=")||!Array.isArray(v.references)||v.references.length>limits.range) return false;
        let end=1;
        return v.references.every(r=>{
          if(!obj(r)||!Array.isArray(r.span)||r.span.length!==2||!r.span.every(Number.isSafeInteger)||
             r.span[0]<end||r.span[1]<=r.span[0]||r.span[1]>v.source.length)return false;
          end=r.span[1];
          return r.type==="design" ? short(r.name,512) && (!r.target||obj(r.target)) :
            r.type==="cell" && (r.rowId===null||idOK(r.rowId)) && (r.columnId===null||idOK(r.columnId)) &&
              typeof r.absoluteColumn==="boolean" && typeof r.absoluteRow==="boolean";
        });
      }
      case "math": return short(v.tex,4096);
      case "link": return short(v.label,2048) && (typeof v.url==="string" && /^(?:https?:\/\/|mailto:)/i.test(v.url) && short(v.url,4096) ||
        obj(v.target) && idOK(v.target.documentId) && idOK(v.target.itemId));
      case "rich": {
        if (!G.AtriumNotebook && typeof importScripts==="function") importScripts("../notebook/notebook.js");
        if (!G.AtriumNotebook && typeof require==="function") require("./notebook.js");
        return !!G.AtriumNotebook?.validate(v.richText);
      }
      case "image": return refOK(v.assetRef)&&short(v.alt??"",2048);
      default: return false;
    }
  }
  function validate(s) { return validateNativeCells(s); }
  function validateNativeCells(s, previousCell, visitCell) {
    if(!is(s)||!Array.isArray(s.rows)||!positive(s.rows.length,limits.rows)||!Array.isArray(s.columns)||!positive(s.columns.length,limits.columns)||
        !Array.isArray(s.cells)||s.cells.length>limits.cells||!Array.isArray(s.merges)||s.merges.length>limits.merges)fail("Invalid table dimensions.");
    if(s.query!=null){
      const q=s.query,record=q?.scope;
      if(!obj(q)||!idOK(q.documentId)||!savedQueryScope(record) &&
        (!obj(record)||record.languageVersion!==1||!short(record.source,16384)||
        Object.keys(record).some(k=>!["languageVersion","source","bindings"].includes(k))||
        record.bindings!==undefined&&(!Array.isArray(record.bindings)||record.bindings.length>1024))||
        !Array.isArray(q.fields)||!q.fields.length||q.fields.length>32||q.fields.some(f=>!obj(f)||!idOK(f.columnId)||!short(f.field,128)||!f.field)||
        new Set(q.fields.map(f=>f.columnId)).size!==q.fields.length||
        q.fields.some(f=>!s.columns.some(c=>c?.id===f.columnId)))fail("Invalid live table query or field columns.");
    }
    const ids=new Set();
    function identity(v,hashedCell=false){
      if(!obj(v)||!hashedCell&&!idOK(v.id)||ids.has(v.id))fail("Invalid or duplicate table record ID.");
      for(const key of reservedKeys)if(own(v,key))fail("Invalid or duplicate table record ID.");
      ids.add(v.id);
    }
    for(const r of s.rows){identity(r);
      if(r.object!==undefined && (!obj(r.object)||!idOK(r.object.documentId)||!idOK(r.object.itemId)||!short(r.object.kind,64)) ||
         r.removed!==undefined && (typeof r.removed!=="boolean"||!r.object) || r.queryEmpty!==undefined && typeof r.queryEmpty!=="boolean")fail("Invalid query row identity.");
      if(r.heightNm!==undefined&&!positive(r.heightNm,1000000000))fail("Invalid table row height.");}
    ids.clear();
    for(const c of s.columns){
      identity(c);
      if(!short(c.title,512)||c.filter!==undefined&&!short(c.filter,256)||c.sortDirection!==undefined&&!["asc","desc"].includes(c.sortDirection)||c.widthNm!==undefined&&!positive(c.widthNm,1000000000)||c.unit!==undefined&&!short(c.unit,128))fail("Invalid table column.");
    }
    if(!Number.isInteger(s.headerRows)||s.headerRows<0||s.headerRows>s.rows.length||
       !Number.isInteger(s.headerColumns)||s.headerColumns<0||s.headerColumns>s.columns.length||typeof s.banded!=="boolean")fail("Invalid table headers.");
    ids.clear();
    const ix=index(s);
    for(const c of s.cells){
      identity(c,true);
      const {id,rowId,columnId}=c;
      if(typeof id!=="string" || !ix.rows.has(rowId)||!ix.columns.has(columnId))fail("Invalid table cell.");
      const prior=previousCell?.(id);
      // Reuse a coordinate proof only for that exact ID and axes. Incoming content
      // and style always go through validation, even when the native row is unchanged.
      const holder=prior?.localId===id && prior.rowId===rowId && prior.columnId===columnId ? prior : c;
      const proof=cellIdentities.get(holder);
      const proven=proof?.id===id && proof.rowId===rowId && proof.columnId===columnId;
      if(!proven && id!==cellId(rowId,columnId)||
        c.content!==undefined&&!contentOK(c.content)||c.style!==undefined&&!styleOK(c.style))fail("Invalid table cell.");
      if(!proven)cellIdentities.set(holder,{id,rowId,columnId});
      visitCell?.(c,prior);
    }
    ids.clear();
    const coveredRows=new Map();let spans=0;
    for(const merge of s.merges){
      identity(merge);
      if(!Array.isArray(merge.rows)||!Array.isArray(merge.columns)||!merge.rows.length||!merge.columns.length||
          merge.rows.length*merge.columns.length<2||merge.rows.length*merge.columns.length>limits.range)fail("Invalid merged range.");
      for(const [axes,map] of [[merge.rows,ix.rows],[merge.columns,ix.columns]]){
        const first=map.get(axes[0]);
        if(first===undefined||axes.some((k,n)=>map.get(k)!==first+n))fail("Merged cells must form one rectangle.");
      }
      if((spans+=merge.rows.length)>limits.cells*2)fail("This table has too many merged row intervals.");
      const first=ix.columns.get(merge.columns[0]),last=ix.columns.get(merge.columns.at(-1));
      for(const r of merge.rows){if(!coveredRows.has(r))coveredRows.set(r,[]);coveredRows.get(r).push([first,last]);}
    }
    for(const row of coveredRows.values()){
      row.sort((a,b)=>a[0]-b[0]);for(let i=1;i<row.length;i++)if(row[i][0]<=row[i-1][1])fail("Merged ranges overlap.");
    }
    validatedViews.add(s);
    return s;
  }
  const validateView=s=>validatedViews.has(s)?s:validate(s);
  function create(rows=4,columns=3,makeId=()=>G.Atrium.id()){
    if(!positive(rows,limits.rows)||!positive(columns,limits.columns))fail("Invalid table dimensions.");
    return {tableVersion:1,rows:Array.from({length:rows},()=>({id:makeId()})),
      columns:Array.from({length:columns},(_,n)=>({id:makeId(),title:letters(n)})),cells:[],merges:[],headerRows:0,headerColumns:0,banded:false};
  }
  function upgrade(item) {
    if(item?.widget?.type!=="table")fail("Choose a table widget.");
    if(isItem(item))return item;
    const old=item.widget.state, next={tableVersion:1,rows:old.rows.map(r=>({id:r.id})),columns:old.columns.map(c=>({id:c.id,title:c.title})),
      cells:[],merges:[],headerRows:0,headerColumns:0,banded:false};
    if(!next.rows.length)next.rows.push({id:G.Atrium.id()});
    if(!next.columns.length)next.columns.push({id:G.Atrium.id(),title:"A"});
    for(const r of old.rows)for(const c of old.columns){
      const v=r["c_"+c.id.replace(/-/g,"")];
      if(v)next.cells.push({id:cellId(r.id,c.id),rowId:r.id,columnId:c.id,content:copy(v)});
    }
    return {...item,widget:{...item.widget,state:validate(next)}};
  }
  function get(s,rowId,columnId){return s.cells[index(s).cells.get(position(rowId,columnId))];}
  function assertEditable(s,rowId,columnId,allowCovered=false) {
    const axes=index(s),row=s.rows[axes.rows.get(rowId)];
    if(!row || !axes.columns.has(columnId))
      throw Object.assign(Error("The selected cell was removed."),{code:"not_found"});
    if(row.removed || row.queryEmpty || row.object && s.query?.fields.some(field=>field.columnId===columnId))
      throw Object.assign(Error("This cell comes from the live query."),{code:"read_only"});
    const merge=merged(s,rowId,columnId);
    if(!allowCovered && merge && (merge.rows[0]!==rowId || merge.columns[0]!==columnId))
      throw Object.assign(Error("Choose the first cell of the merged range."),{code:"invalid_arguments"});
  }
  function change(s,rowId,columnId,patch) {
    const ix=index(s);
    if(!ix.rows.has(rowId)||!ix.columns.has(columnId))fail("This cell no longer exists.");
    const at=ix.cells.get(position(rowId,columnId)),previous=s.cells[at],next={...previous,id:previous?.id||cellId(rowId,columnId),rowId,columnId};
    if(own(patch,"content")){
      if(patch.content==null||patch.content.kind==="literal"&&patch.content.text==="")delete next.content;
      else if(contentOK(patch.content))next.content=patch.content;
      else fail("Invalid cell content.");
    }
    if(own(patch,"style")){
      if(patch.style==null||!Object.keys(patch.style).length)delete next.style;
      else if(styleOK(patch.style))next.style=patch.style;
      else fail("Invalid cell formatting.");
    }
    if(previous&&equal(next,previous)||!previous&&!next.content&&!next.style)return s;
    const cells=s.cells.slice();
    if(!next.content&&!next.style)cells.splice(at,1);
    else if(previous){cells[at]=next;cellIndexes.set(cells,cellIndex(s.cells));}
    else {if(cells.length>=limits.cells)fail("The table has reached its stored cell limit.");cells.push(next);}
    recordCells(s.cells,cells,[{before:previous,after:next.content||next.style?next:undefined}],at??s.cells.length);
    const state={...s,cells};
    if(validatedViews.has(s))validatedViews.add(state);
    return state;
  }
  function batch(s,changes) {
    if(!changes.length)return s;
    if(changes.length===1){
      const {rowId,columnId,content,style}=changes[0];
      return change(s,rowId,columnId,{...(content!==undefined?{content}:{}),...(style!==undefined?{style}:{})});
    }
    const ix=index(s),cells=new Map(s.cells.map(c=>[position(c.rowId,c.columnId),c]));
    const originals=new Map();
    for(const {rowId,columnId,content,style} of changes) {
      if(!ix.rows.has(rowId)||!ix.columns.has(columnId))fail("The selected cell was removed.");
      if(content!=null&&!contentOK(content)||style!=null&&!styleOK(style))fail("Invalid cell contents or formatting.");
      const key=position(rowId,columnId),previous=cells.get(key),next={...previous,id:previous?.id||cellId(rowId,columnId),rowId,columnId};
      if(!originals.has(key))originals.set(key,previous);
      if(content!==undefined) { if(content===null||content.kind==="literal"&&!content.text)delete next.content;else next.content=content; }
      if(style!==undefined) { if(style===null||!Object.keys(style).length)delete next.style;else next.style=style; }
      if(!equal(previous,next)){
        if(next.content||next.style)cells.set(key,next);else cells.delete(key);
      }
    }
    if(cells.size>limits.cells)fail("The table has reached its stored cell limit.");
    const edits=[];
    for(const [key,before] of originals){
      const after=cells.get(key);
      if(!equal(before,after))edits.push({before,after});
    }
    if(!edits.length)return s;
    const next=[...cells.values()];
    recordCells(s.cells,next,edits);
    const state={...s,cells:next};
    if(validatedViews.has(s))validatedViews.add(state);
    return state;
  }
  function axis(s,kind,at,count,insert,makeId=()=>G.Atrium.id()) {
    if(!["rows","columns"].includes(kind)||!Number.isInteger(at)||at<0||at>s[kind].length||!positive(count,limits[kind]))fail("Invalid table axis.");
    const items=s[kind].slice(),key=kind==="rows"?"rowId":"columnId";
    if(insert && items.length+count>limits[kind]||!insert&&(at+count>items.length||count===items.length))fail("The table needs at least one axis within its size limit.");
    const added=insert?Array.from({length:count},(_,n)=>kind==="rows"?{id:makeId()}:{id:makeId(),title:letters(at+n)}):[];
    const deleted=new Set(items.splice(at,insert?0:count,...added).map(x=>x.id)),other=kind==="rows"?"columns":"rows";
    const merges=s.merges.map(m=>{
      const old=m[kind],first=s[kind].findIndex(v=>v.id===old[0]), axes=old.filter(id=>!deleted.has(id));
      if(insert&&at>first&&at<first+old.length)axes.splice(at-first,0,...added.map(x=>x.id));
      return {...m,[kind]:axes};
    }).filter(m=>m[kind].length*m[other].length>1);
    const header=kind==="rows"?"headerRows":"headerColumns";
    const next={...s,[kind]:items,[header]:Math.min(s[header],items.length),cells:s.cells.filter(c=>!deleted.has(c[key])),merges};
    if(kind==="columns"&&s.query){const fields=s.query.fields.filter(f=>!deleted.has(f.columnId));if(fields.length)next.query={...s.query,fields};else delete next.query;}
    return validate(next);
  }
  function equal(a,b) {
    if(a===b)return true;
    if(!a||!b||typeof a!=="object"||typeof b!=="object"||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(k=>own(b,k)&&equal(a[k],b[k]));
  }
  function compareTables(a,b) {
    const before=a.widget.state,after=b.widget.state,out=[],left=new Map(before.cells.map(c=>[c.id,c])),right=new Map(after.cells.map(c=>[c.id,c]));
    for(const id of new Set([...left.keys(),...right.keys()])) {
      const old=left.get(id),next=right.get(id);
      if(equal(old,next))continue;
      const cell=next||old,name=label(next?after:before,cell.rowId,cell.columnId);
      out.push({id:cell.id,kind:"content",before:old??null,after:next??null,text:"Table cell "+name+" changed",fields:["cells",cell.rowId,cell.columnId]});
    }
    for(const name of ["rows","columns","merges","headerRows","headerColumns","banded","query"])
      if(!equal(before[name],after[name]))out.push({kind:"content",before:before[name]??null,after:after[name]??null,
        text:"Table "+name+" changed",fields:[name]});
    return out;
  }
  function letters(n){
    let out="";
    for(n++;n>0;n=Math.floor((n-1)/26))out=String.fromCharCode(65+(n-1)%26)+out;
    return out;
  }
  function label(s,rowId,columnId){
    const ix=index(s),r=ix.rows.get(rowId),c=ix.columns.get(columnId);
    return r===undefined||c===undefined?"#REF!":letters(c)+(r+1);
  }
  function range(s,start,end=start){
    const ix=index(s), r1=ix.rows.get(start.rowId),r2=ix.rows.get(end.rowId),c1=ix.columns.get(start.columnId),c2=ix.columns.get(end.columnId);
    if([r1,r2,c1,c2].includes(undefined))fail("The selected cell was removed.");
    const rows=s.rows.slice(Math.min(r1,r2),Math.max(r1,r2)+1).map(r=>r.id);
    const columns=s.columns.slice(Math.min(c1,c2),Math.max(c1,c2)+1).map(c=>c.id);
    return {rows,columns};
  }
  function merged(s,rowId,columnId){
    if(!s.merges.length)return undefined;
    let map=mergeIndexes.get(s);
    if(!map){
      map=new Map();const ix=index(s);
      for(const m of s.merges)for(const rid of m.rows){
        if(!map.has(rid))map.set(rid,[]);
        map.get(rid).push({first:ix.columns.get(m.columns[0]),last:ix.columns.get(m.columns.at(-1)),merge:m});
      }
      for(const ranges of map.values())ranges.sort((a,b)=>a.first-b.first);
      mergeIndexes.set(s,map);
    }
    const ranges=map.get(rowId)||[],c=index(s).columns.get(columnId);
    let lo=0,hi=ranges.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(ranges[mid].last<c)lo=mid+1;else hi=mid;}
    return ranges[lo]?.first<=c ? ranges[lo].merge : undefined;
  }
  function presentationRows(s,value) {
    const sorts=s.columns.filter(c=>c.sortDirection),filters=s.columns.filter(c=>c.filter);
    if(!sorts.length&&!filters.length)return s.rows;
    const to=new Map(),indices=index(s).rows;
    for(const m of s.merges)if(m.rows.length>1){
      const first=indices.get(m.rows[0]),last=indices.get(m.rows.at(-1));
      to.set(first,Math.max(to.get(first)??first,last));
    }
    const front=[],body=[],collator=new Intl.Collator(undefined,{numeric:true,sensitivity:"base"});
    for(let r=0;r<s.rows.length;){
      const start=r;let end=to.get(start)??start;
      for(;r<=end;r++)end=Math.max(end,to.get(r)??r);
      const group=s.rows.slice(start,end+1);
      if(start<s.headerRows)front.push(...group);
      else if(filters.every(c=>group.some(row=>String(value(row.id,c.id)).toLocaleLowerCase().includes(c.filter.toLocaleLowerCase()))))body.push(group);
    }
    if(sorts.length)body.sort((a,b)=>{
      for(const c of sorts){const order=collator.compare(String(value(a[0].id,c.id)),String(value(b[0].id,c.id)));if(order)return c.sortDirection==="desc"?-order:order;}
      return 0;
    });
    return [...front,...body.flat()];
  }
  function join(s,start,end,makeId=()=>G.Atrium.id()){
    const rect=range(s,start,end);
    return validate({...s,merges:[...s.merges,{id:makeId(),...rect}]});
  }
  function split(s,rowId,columnId){
    const hit=merged(s,rowId,columnId);
    return hit?{...s,merges:s.merges.filter(m=>m!==hit)}:s;
  }
  function target(documentId,itemId,rowId,columnId) {return {scope:"item",documentId,itemId,path:["cells",rowId,columnId,"value"]};}
  function resolveTarget(project,t) {
    if(!Array.isArray(t?.path)||t.path.length!==4||t.path[0]!=="cells"||t.path[3]!=="value")return null;
    const doc=project.documents.find(d=>d.id===t.documentId),item=doc?.items.find(i=>i.id===t.itemId);
    if(!isItem(item))return null;
    const s=item.widget.state, [,rowId,columnId]=t.path,ix=index(s);
    if(!ix.rows.has(rowId)||!ix.columns.has(columnId))return null;
    return {doc,item,rowId,columnId,cell:get(s,rowId,columnId)??null,label:label(s,rowId,columnId)};
  }
  function readTarget(project,t,readFormula) {
    const resolved=resolveTarget(project,t);if(!resolved)return null;
    const content=resolved.cell?.content;
    const value=content?.kind==="formula" ? readFormula?.(resolved) ?? null : content?.kind==="literal" ? content.text : null;
    return {...resolved,content:content??null,value};
  }
  function writeTarget(project,t,content) {
    const resolved=resolveTarget(project,t);
    if(!resolved)fail("The addressed table cell was removed.");
    return change(resolved.item.widget.state,resolved.rowId,resolved.columnId,{content});
  }
  const numericRegistrations=new WeakMap();
  function matchesNumeric(t) {
    return t?.scope==="item" && Array.isArray(t.path) && t.path.length===4 && t.path[0]==="cells" && t.path[3]==="value" &&
      idOK(t.documentId) && idOK(t.itemId) && idOK(t.path[1]) && idOK(t.path[2]);
  }
  function numericCell(project,t) {
    if(!matchesNumeric(t))return null;
    const resolved=readTarget(project,t);
    if(!resolved)return null;
    const {item,rowId,columnId,content}=resolved,s=item.widget.state,axes=index(s),row=s.rows[axes.rows.get(rowId)];
    if(row.removed||row.queryEmpty||row.object&&s.query?.fields.some(f=>f.columnId===columnId)||content&&content.kind!=="literal")return null;
    if(content){const raw=content.text.trim();if(raw && !(G.AtriumCalculationCore?.parseBoundValue(raw)?.ok ?? Number.isFinite(Number(raw))))return null;}
    return {...resolved,unit:s.columns[axes.columns.get(columnId)].unit||""};
  }
  function registerNumericFields(api) {
    if(!api?.registerTargetResolver)return null;
    if(numericRegistrations.has(api))return numericRegistrations.get(api);
    const release=api.registerTargetResolver("table-cell",{matches:matchesNumeric,resolve(project,t) {
      const initial=numericCell(project,t);if(!initial)return null;
      const {doc,item:owner,unit}=initial;
      function current(){
        const cell=numericCell(project,t);
        return cell?.item===owner && cell.unit===unit ? cell : null;
      }
      const nextState = value => current() && (value === null || Number.isFinite(value)) ?
        writeTarget(project,t,value === null ? null : {kind:"literal",text:String(value)}) : null;
      return {doc,owner,unit,read:()=>current()?.value??null,write(value) {
        const state = nextState(value);
        if (!state) return false;
        if(state!==owner.widget.state)owner.widget={...owner.widget,state};
        return true;
      }, plan(value) {
        const next = nextState(value), prior = owner.widget.state;
        if (!next) fail("The addressed table cell changed or is unavailable.");
        return next === prior ? [] : [{op:"set",target:"item",document:doc.id,id:owner.id,
          path:["widget","state","cells"],before:prior.cells,after:next.cells}];
      }};
    }});
    const unregister=()=>{release?.();numericRegistrations.delete(api);};
    numericRegistrations.set(api,unregister);return unregister;
  }
  function clearReplacedNumericTargets(project,documentId,item,prior,next) {
    const saved=project.numericExpressions;
    if(!Array.isArray(saved)||!saved.length)return;
    // This is authored data. Cleanup runs inside the sheet edit even on a cold
    // open, before the optional numeric-control service has been requested.
    const retained=saved.filter(entry=>{
      const t=entry?.target;
      if(!matchesNumeric(t)||t.documentId!==documentId||t.itemId!==item.id)return true;
      const [,rowId,columnId]=t.path,before=index(prior),after=index(next);
      const row=next.rows[after.rows.get(rowId)],column=next.columns[after.columns.get(columnId)];
      const oldColumn=prior.columns[before.columns.get(columnId)];
      if(!before.rows.has(rowId)||!row||row.removed||row.queryEmpty||!oldColumn||!column)return false;
      if((oldColumn.unit||"")!==(column.unit||""))return false;
      if(row.object&&next.query?.fields.some(f=>f.columnId===columnId))return false;
      return equal(get(prior,rowId,columnId)?.content,get(next,rowId,columnId)?.content);
    });
    if(retained.length===saved.length)return;
    if(retained.length)project.numericExpressions=retained;
    else delete project.numericExpressions;
  }
  if(G.AtriumNumericFields?.registerTargetResolver)registerNumericFields(G.AtriumNumericFields);
  return Object.freeze({feature,version,limits,is,isItem,create,upgrade,validate,validateNativeCells,index,axisIndex,get,change,cellId,savedQueryScope,
    letters,label,range,merged,join,split,target,resolveTarget,readTarget,writeTarget,contentOK,styleOK,refOK,batch,axis,compareTables,presentationRows,equal,
    changedFrom,changedCells,recentCellEdit,cellTransition,cellUndoScope,replayCell,contentKinds,assertEditable,validateView,registerNumericFields,clearReplacedNumericTargets});
})();
if(typeof module!=="undefined")module.exports=globalThis.AtriumTableData;
