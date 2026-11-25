"use strict";

globalThis.AtriumDropData = (() => {
  const G = globalThis;
  const reject = message => {throw Object.assign(Error(message),{code:"invalid_payload"});};

  function table(item, bytes) {
    const W = G.AtriumWidgetCatalogue, T = G.AtriumTableData, state = item.widget?.state;
    if (item.widget?.type !== "table" || !W.valid(item)) reject("Choose a regular schematic table.");
    const modern = T.is(state), limits = modern ? T.limits : W.limits;
    if (!bytes.length || bytes.length > G.AtriumDrop.limits.csv) reject("The CSV exceeds the table size limit.");
    let text;
    try {text = new TextDecoder("utf-8",{fatal:true}).decode(bytes);} catch {reject("Choose a UTF-8 CSV file.");}
    if (text.includes("\u0000")) reject("The CSV contains invalid text.");
    let data;
    try {
      data = G.AtriumTableExchange.tsv(text,",",{strict:true,rows:limits.rows+1,columns:limits.columns,
        text:modern ? limits.text : 2048,cells:bytes.length+1}).rows;
    } catch(error) {reject(error.message);}
    const [header,...input] = data.map(row=>row.map(cell=>cell.text));
    if (!header?.length || !input.length || header.some(label => !label.trim() || label.length>512) ||
        new Set(header).size !== header.length || input.some(row=>row.length !== header.length))
      reject("The CSV needs unique column names and matching values on every row.");
    if (modern) return appendSparse(state,header,input);
    return appendLegacy(item,header,input);
  }

  function checkHeaders(columns,header) {
    if (columns.length !== header.length || !columns.every((column,i)=>column.title===header[i]))
      reject("The CSV headers must match the receiving table.");
  }

  function appendSparse(state,header,input) {
    const T = G.AtriumTableData;
    const empty = !state.cells.length && !state.merges.length && !state.query && !state.headerRows && !state.headerColumns;
    let next = state;
    if (empty) {
      // An unused table takes the CSV headings. Keep any existing axes in the used rectangle.
      next = {...state,rows:state.rows.slice(0,input.length),columns:header.map((title,index)=>({
        ...(state.columns[index] ?? {id:G.Atrium.id()}),title}))};
    } else checkHeaders(state.columns,header);
    const start = empty ? 0 : state.rows.length, extra = start + input.length - next.rows.length;
    try {
      if (extra) next = T.axis(next,"rows",next.rows.length,extra,true);
      const cells = [];
      for (const [r,record] of input.entries()) for (const [c,text] of record.entries()) {
        if (text) cells.push({rowId:next.rows[start+r].id,columnId:next.columns[c].id,content:{kind:"literal",text}});
      }
      next = T.validate(T.batch(next,cells));
    } catch(error) {reject(error.message);}
    return {state:next,rows:input.length,columns:header.length};
  }

  function appendLegacy(item,header,input) {
    const W = G.AtriumWidgetCatalogue, state = item.widget.state;
    const hasRows = state.rows.some(row => Object.keys(row).length > 1);
    if (hasRows) checkHeaders(state.columns,header);
    const columns = hasRows ? state.columns : header.map(title=>({id:G.Atrium.id().replace(/-/g,""),title}));
    const rows = hasRows ? [...state.rows] : [];
    for (const record of input) {
      const row = {id:G.Atrium.id()};
      for (const [i, column] of columns.entries()) row[W.keyFor(column.id)] = {kind:"literal", text:record[i]};
      rows.push(row);
    }
    const next = {...state,columns,rows};
    if (!W.valid({...item,widget:{...item.widget,state:next}})) reject("The combined values exceed the durable table size limit.");
    return {state:next, rows:input.length, columns:columns.length};
  }

  function model(current,name,text) {
    // Model bytes are accepted only after the normal STEP reader validates them.
    const out = {file:name,stepText:text,offset:current?.offset||[0,0,0],rotation:current?.rotation||[0,0,0]};
    return out;
  }
  return Object.freeze({table,model});
})();
