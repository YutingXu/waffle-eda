"use strict";

// Physical table rows live in the same native schematic as the drawing owner.
// Their IDs include that owner, so two tables can retain the same local axis IDs.
globalThis.AtriumTableFormat = (() => {
  const F = globalThis.AtriumFormat2, T = globalThis.AtriumTableData;
  const lists = Object.freeze({tableRow:"rows",tableColumn:"columns",tableCell:"cells",tableMerge:"merges"});
  const cache = new WeakMap(), verified = new WeakMap();
  const has = item => item?.widget?.type === "table" && item.widget.state?.tableVersion === 1;
  const physicalId = (tableId,kind,id) => tableId + "/table/" + kind.slice(5).toLowerCase() + "/" + encodeURIComponent(id);
  function children(file) {
    let tables = cache.get(file);
    if (tables) return tables;
    tables = new Map();
    for (const record of file.records()) {
      if (!Object.hasOwn(lists,record.kind)) continue;
      if (!verified.has(record)) {
        if (typeof record.tableId !== "string" || typeof record.localId !== "string" ||
            record.id !== physicalId(record.tableId,record.kind,record.localId))
          throw new F.FormatError("invalid-model","A table record has an invalid owner or stable ID.");
        verified.set(record,Object.keys(record).length);
      }
      let children=tables.get(record.tableId);
      if (!children) {
        if (file.get(record.tableId)?.kind !== "notebookTable")
          throw new F.FormatError("invalid-model","A table record has an invalid owner or stable ID.");
        tables.set(record.tableId,children=new Map());
      }
      children.set(record.id,record);
    }
    cache.set(file,tables);
    return tables;
  }
  function sameUnordered(value,record) {
    if(!record)return false;
    const keys=Object.keys(value);
    return (verified.get(record)??Object.keys(record).length)===keys.length+3 &&
      keys.every(key=>key==="id" || T.equal(value[key],record[key]));
  }
  function pack(item, previous, rank, delta=false) {
    const parts = [], changedCells = [];
    let surviving=0;
    const prefix=item.id+"/table/cell/";
    const state = item.widget.state;
    const diffCells=delta && previous;
    if(diffCells){
      T.validateNativeCells(state,id=>previous.get(prefix+id),(cell,prior)=>{
        if(prior)surviving++;
        if(!sameUnordered(cell,prior)){
          const {id:localId,...body}=cell, id=prior?.id ?? prefix+localId;
          const row={kind:"tableCell",id,localId,tableId:item.id,...body};
          if(!T.equal(row,prior))changedCells.push(row);
        }
      });
    }else T.validate(state);
    const {rows,columns,cells,merges,...settings} = state;
    for (const [kind,list] of Object.entries(lists)) {
      if(kind==="tableCell" && diffCells){
        for(const cell of changedCells)parts.push(cell);
        continue;
      }
      const ordered = kind === "tableRow" || kind === "tableColumn";
      const prefix=item.id+"/table/"+kind.slice(5).toLowerCase()+"/";
      const group = [];
      for(const value of state[list]){
        const id=prefix+(kind==="tableCell"?value.id:encodeURIComponent(value.id));
        const prior=delta && previous?.get(id);
        if(prior)surviving++;
        if(!ordered && sameUnordered(value,prior))continue;
        const {id:localId, ...body} = value;
        group.push({kind,id,localId,tableId:item.id,...body});
      }
      if (ordered) rank(group,previous ?? new Map());
      for(const row of group)if(!delta || !T.equal(row,previous?.get(row.id)))parts.push(row);
    }
    const remove=[];
    if(delta && previous && surviving!==previous.size){
      const retained=new Set();
      for(const [kind,list] of Object.entries(lists))for(const value of state[list])
        retained.add(physicalId(item.id,kind,value.id));
      for(const id of previous.keys())if(!retained.has(id))remove.push(id);
    }
    return {item:{...item,widget:{...item.widget,state:settings}},parts,remove};
  }
  function project(item, entries, compare) {
    const state = {...item.widget.state,rows:[],columns:[],cells:[],merges:[]};
    for (const record of entries?.values() ?? []) state[lists[record.kind]].push(record);
    const originalCells=state.cells;
    for (const list of Object.values(lists)) {
      if (list === "rows" || list === "columns") state[list].sort(compare);
      state[list] = state[list].map(({kind,id,tableId,order,localId,...value}) => ({id:localId,...value}));
    }
    let cursor=0;
    T.validateNativeCells(state,()=>originalCells[cursor++]);
    return {...item,widget:{...item.widget,state}};
  }
  function editCell(file,{id:tableId,before,after}) {
    const cell=after||before;
    if(!cell || typeof tableId!=="string" || file.get(tableId)?.kind!=="notebookTable" || before && after &&
      (before.id!==after.id || before.rowId!==after.rowId || before.columnId!==after.columnId))return null;
    const {id:localId,rowId,columnId,...body}=cell,kind="tableCell";
    if(typeof rowId!=="string" || typeof columnId!=="string" || localId!==T.cellId(rowId,columnId) ||
      file.get(physicalId(tableId,"tableRow",rowId))?.kind!=="tableRow" ||
      file.get(physicalId(tableId,"tableColumn",columnId))?.kind!=="tableColumn")return null;
    const id=physicalId(tableId,kind,localId), old=file.get(id);
    if(before ? (!old || old.kind!==kind || old.localId!==localId || old.tableId!==tableId ||
      !sameUnordered(before,old)) : old)return null;
    if(!after)return {remove:id};
    if(!before){
      const prefix=physicalId(tableId,kind,"");
      // Physical cell IDs share an ordered prefix. Count its range without visiting their payloads.
      if(file.countRange(prefix,prefix.slice(0,-1)+"0")>=T.limits.cells)return null;
    }
    if(["kind","tableId","localId","order","__proto__","constructor","prototype"].some(key=>Object.hasOwn(body,key)) ||
      body.content===undefined&&body.style===undefined || body.content!==undefined&&!T.contentOK(body.content) ||
      body.style!==undefined&&!T.styleOK(body.style))return null;
    return {put:{kind,id,localId,tableId,rowId,columnId,...body}};
  }
  return Object.freeze({has,lists,physicalId,children,pack,project,editCell});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumTableFormat;
