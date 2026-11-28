"use strict";

(() => {
  const G = globalThis, T = G.AtriumTableData;
  const own = (value, key) => Object.hasOwn(value, key);
  const fail = (message, code = "invalid_arguments") => {
    throw Object.assign(Error(message), {code});
  };
  const id = () => G.Atrium.id();

  function sheet(project, documentId, edit = false) {
    const doc = project.documents.find(candidate => candidate.id === documentId);
    if (doc?.kind !== "schematic") fail("Choose an available schematic.", "not_found");
    if (edit && (project.atriumCompat?.readOnly || doc.atriumCompat?.readOnly))
      fail("This schematic is read-only.", "read_only");
    return doc;
  }

  function table(args, context, edit = false, legacy = false) {
    const doc = sheet(context.project, args.documentId, edit);
    const item = doc.items.find(candidate => candidate.id === args.itemId);
    if (item?.kind !== "textframe" || item.widget?.type !== "table" || !legacy && !T.isItem(item))
      fail("Choose an available full table.", "not_found");
    return {doc, item, state:item.widget.state, project:context.project};
  }

  function entry(hit) {
    const {doc, item, state} = hit;
    return {documentId:doc.id, itemId:item.id, title:item.text || "Table", full:T.isItem(item),
      rowCount:state.rows.length, columnCount:state.columns.length};
  }

  function select(state, args) {
    const start = {rowId:args.rowId, columnId:args.columnId};
    const end = {rowId:args.endRowId ?? start.rowId, columnId:args.endColumnId ?? start.columnId};
    const range = T.range(state, start, end);
    if (range.rows.length * range.columns.length > T.limits.range)
      fail("Choose a range of at most " + T.limits.range + " cells.", "resource_limit");
    return {start, end, ...range};
  }

  function commit(hit, next, result = {}) {
    const {doc, item, state, project} = hit;
    if(state===next)return {result,ops:[]};
    if(!T.changedFrom(next,state)){
      T.validateView(next);
      if(T.equal(state,next))return {result,ops:[]};
    }
    const ops = [{op:"set", target:"item", document:doc.id, id:item.id, path:["widget", "state"], before:state, after:next}];
    if (T.is(state)) {
      const snapshot = {numericExpressions:project.numericExpressions};
      T.clearReplacedNumericTargets(snapshot, doc.id, item, state, next);
      if (snapshot.numericExpressions !== project.numericExpressions) ops.push({
        op:"set", target:"project", path:["numericExpressions"], before:project.numericExpressions,
        ...(own(snapshot,"numericExpressions") ? {after:snapshot.numericExpressions} : {})
      });
    }
    return {result, ops};
  }

  function results(hit, context) {
    return G.AtriumTableVisual.values(hit.project, hit.doc, hit.item, {revision:context.revision,
      formulaReport:()=>context.services.tableFormulas(hit.doc.id,hit.item.id)});
  }

  function portableLink(value) {
    if (!/^(?:https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?|mailto:[^\s?]+(?:\?[^\s]*)?)$/i.test(value))
      fail("Enter a valid HTTP, HTTPS or mail link.");
    return value;
  }

  function cellContent(hit, value, bind) {
    if (value === null) return null;
    switch (value.kind) {
      case "literal": return {kind:"literal", text:value.text};
      case "formula": return bind(value.source);
      case "field": {
        const field = G.AtriumNoteFields.resolve(hit.project, hit.doc, value.expression);
        return {kind:"field", expression:value.expression, ...(field.binding ? {binding:field.binding} : {})};
      }
      case "calculation": return {kind:"calculation", documentId:value.documentId, blockId:value.blockId,
        ...(value.instanceId ? {instanceId:value.instanceId} : {})};
      case "math": return {kind:"math", tex:value.tex};
      case "rich": return {kind:"rich", richText:value.richText};
      case "link": return {kind:"link", label:value.label, ...(value.url ?
        {url:portableLink(value.url)} : {target:value.target})};
      case "image": return {kind:"image", assetRef:value.assetRef, alt:value.alt ?? ""};
      default: fail("Choose a supported cell content type.");
    }
  }

  function updateAxis(hit, args) {
    const {state} = hit, {axis, action, axisId, beforeId = null, count = 1, attributes} = args;
    const values = state[axis], lookup = T.index(state)[axis];
    const indexOf = key => {
      if (!lookup.has(key)) fail("The selected table axis was removed.", "not_found");
      return lookup.get(key);
    };
    if (action === "insert") return T.axis(state, axis, beforeId === null ? values.length : indexOf(beforeId), count, true, id);
    const at = indexOf(axisId);
    if (action === "remove") {
      if (axis === "rows" && values.slice(at, at + count).some(row => row.object || row.queryEmpty))
        fail("Remove live query rows using the query commands.", "read_only");
      return T.axis(state, axis, at, count, false);
    }
    if (action === "move") {
      if (beforeId === axisId) return state;
      const rows = values.slice();
      rows.splice(at, 1);
      const to = beforeId === null ? values.length : indexOf(beforeId);
      rows.splice(to - Number(to > at), 0, values[at]);
      return {...state, [axis]:rows};
    }
    if (!attributes || !Object.keys(attributes).length) fail("Provide attributes for the selected row or column.");
    const allowed = axis === "rows" ? ["heightNm"] : ["title", "widthNm", "unit", "filter", "sortDirection"];
    const next = {...values[at]};
    for (const [key, value] of Object.entries(attributes)) {
      if (!allowed.includes(key) || key === "title" && value === null) fail("The attribute is unavailable on this axis.");
      if (key === "unit" && value && !G.AtriumCalculationCore.units(value)) fail("Choose a known quantity unit.");
      if (value === null) delete next[key]; else next[key] = value;
    }
    return {...state, [axis]:values.map((value,i) => i === at ? next : value)};
  }

  async function queryResult(hit,context,state) {
    const outcome = await G.AtriumTableQuery.refresh(state, {project:hit.project, revision:context.revision,
      signal:context.signal, isCurrent:context.isCurrent,queryEnabled:() => context.services.enabled("query")});
    if (context.isCurrent?.() === false) fail("The project changed while reading the query.", "stale_source");
    return outcome;
  }
  async function materialize(hit, context, state) {
    const outcome = await queryResult(hit,context,state);
    if (!outcome.complete) return {result:{complete:false, diagnostic:outcome.diagnostic}, ops:[]};
    return commit(hit, outcome.state, {complete:true, count:outcome.count, removed:outcome.removed});
  }

  function input(args, context) {
    const X = G.AtriumTableExchange;
    if (args.format !== "html") return X.tsv(args.data, args.format === "csv" ? "," : "\t");
    const projection = context.services.native?.tableImport ?? X.html(args.data);
    if (!projection) fail("Choose an HTML document containing a table.");
    return projection;
  }

  G.AtriumButter.register("tables", {
    list(args, context) {
      const doc = sheet(context.project,args.documentId);
      return {tables:doc.items.filter(item => item.kind === "textframe" && item.widget?.type === "table")
        .map(item => entry({doc,item,state:item.widget.state}))};
    },
    describe(args, context) {
      const hit = table(args,context), {state} = hit, rowOffset = args.rowOffset ?? 0, columnOffset = args.columnOffset ?? 0;
      const allRows = args.visible ? T.presentationRows(state,results(hit,context)) : state.rows;
      const rows = allRows.slice(rowOffset,rowOffset+(args.rowLimit ?? 50));
      const columns = state.columns.slice(columnOffset,columnOffset+(args.columnLimit ?? 24));
      const cells = [];
      for (const row of rows) for (const column of columns) {
        const cell = T.get(state,row.id,column.id);
        if (cell) cells.push(cell);
      }
      const rowIds = new Set(rows.map(row => row.id)), columnIds = new Set(columns.map(column => column.id));
      return {...entry(hit), rowOffset, columnOffset, visibleRowCount:allRows.length, rows, columns, cells,
        merges:state.merges.filter(merge => merge.rows.some(r => rowIds.has(r)) && merge.columns.some(c => columnIds.has(c))),
        headerRows:state.headerRows, headerColumns:state.headerColumns, banded:state.banded, query:state.query ?? null};
    },
    create(args, context) {
      const doc = sheet(context.project,args.documentId,true);
      const item = G.AtriumSheetWidgets.make("table",[args.x,args.y]);
      item.widget.state = T.create(args.rows,args.columns,id);
      if (args.title) {
        item.text = args.title;
        item.widget.fallback = {type:"text",text:args.title};
      }
      return {result:{itemId:item.id},ops:[{op:"add",target:"item",document:doc.id,value:item}]};
    },
    upgrade(args, context) {
      const hit = table(args,context,true,true);
      return commit(hit,T.upgrade(hit.item).widget.state,{itemId:hit.item.id});
    },
    "edit-cells"(args, context) {
      const hit = table(args, context, true);
      let report;
      const bind=source=>(report??=context.services.tableFormulas(hit.doc.id,hit.item.id)).bind(source);
      const updates = args.cells.map(cell => {
        T.assertEditable(hit.state,cell.rowId,cell.columnId);
        if (!own(cell,"content") && !own(cell,"style")) fail("Provide cell content or formatting.");
        return {rowId:cell.rowId,columnId:cell.columnId,
          ...(own(cell,"content") ? {content:cellContent(hit,cell.content,bind)} : {}),
          ...(own(cell,"style") ? {style:cell.style} : {})};
      });
      if (new Set(updates.map(row => T.cellId(row.rowId,row.columnId))).size !== updates.length)
        fail("An edit may address a given cell only once.");
      return commit(hit,T.batch(hit.state,updates),{cells:updates.length});
    },
    "edit-axis"(args, context) {
      const hit = table(args,context,true);
      const next = updateAxis(hit,args);
      return commit(hit,next,{rowCount:next.rows.length,columnCount:next.columns.length});
    },
    configure(args, context) {
      const hit = table(args,context,true);
      const {headerRows = hit.state.headerRows, headerColumns = hit.state.headerColumns, banded = hit.state.banded} = args;
      return commit(hit,{...hit.state,headerRows,headerColumns,banded});
    },
    merge(args, context) {
      const hit = table(args,context,true), area = select(hit.state,args);
      if (args.action === "merge") for (const rowId of area.rows) for (const columnId of area.columns)
        T.assertEditable(hit.state,rowId,columnId);
      return commit(hit,args.action === "merge" ? T.join(hit.state,area.start,area.end,id) :
        T.split(hit.state,args.rowId,args.columnId));
    },
    fill(args, context) {
      const hit = table(args,context,true), range = select(hit.state,args);
      if (range.rows.length < 2) fail("Include the source row and one or more rows below it.");
      return commit(hit,G.AtriumTableFormulas.fillDown(hit.state,range),{cells:(range.rows.length-1)*range.columns.length});
    },
    evaluate(args, context) {
      const hit = table(args,context), area = select(hit.state,args);
      const report = context.services.tableFormulas(hit.doc.id,hit.item.id);
      return {cells:area.rows.flatMap(rowId => area.columns.map(columnId => ({
        rowId,columnId,address:T.label(hit.state,rowId,columnId),value:report.value(rowId,columnId) ?? null
      }))),stats:report.stats};
    },
    async "bind-query"(args, context) {
      const hit = table(args,context,true);
      if (!!args.source === !!args.savedQueryId) fail("Choose an authored query or a saved query ID.");
      const result = await G.AtriumTableQuery.author(hit.state,{project:hit.project,documentId:args.queryDocumentId,
        source:args.source,savedQueryId:args.savedQueryId,fields:args.fields,revision:context.revision,
        signal:context.signal,isCurrent:context.isCurrent,queryEnabled:() => context.services.enabled("query")});
      if (!result.ok) return {result:{complete:false, diagnostic:result.diagnostics[0]},ops:[]};
      return materialize(hit,context,{...hit.state,query:result.query});
    },
    "refresh-query"(args, context) {
      const hit = table(args,context,true);
      if (!hit.state.query) fail("Bind a design query before refreshing.");
      return materialize(hit,context,hit.state);
    },
    async "clear-removed"(args, context) {
      const hit = table(args,context,true);
      const outcome=hit.state.query && await queryResult(hit,context,hit.state);
      const state=outcome?.complete ? outcome.state : hit.state;
      const cleared=G.AtriumTableQuery.clearRemoved(state);
      return commit(hit,cleared===state?hit.state:cleared);
    },
    "unbind-query"(args, context) {
      const hit = table(args,context,true), {query, ...state} = hit.state;
      if (!query) return {result:{},ops:[]};
      state.rows = state.rows.map(({object,removed,queryEmpty,...row}) => row);
      return commit(hit,state);
    },
    import(args, context) {
      const hit = table(args,context,true), area = select(hit.state,args), parsed = input(args,context);
      const next = G.AtriumTableExchange.paste(hit.state,area.start,parsed,id);
      return commit(hit,next,{rows:parsed.rows.length,notice:parsed.notice});
    },
    export(args, context) {
      const hit = table(args,context), area = args.rowId && args.columnId ? select(hit.state,args) : null;
      if (!!args.rowId !== !!args.columnId) fail("Supply both axes for a selected range.");
      if (!area && hit.state.rows.length * hit.state.columns.length > T.limits.range)
        fail("Choose a smaller export range.", "resource_limit");
      const rendered = G.AtriumTableExchange.render(hit.state,area,results(hit,context),{csvOnly:args.format === "csv"});
      const data = args.format === "csv" ? rendered : args.format === "html" ? rendered.html : rendered.text;
      if (new TextEncoder().encode(data).length > 2 * 1024 * 1024) fail("Choose a smaller export range.", "resource_limit");
      return {format:args.format,data};
    },
    compare(args, context) {
      const before = table(args,context), after = table({documentId:args.otherDocumentId,itemId:args.otherItemId},context);
      const differences = T.compareTables(before.item,after.item);
      return {total:differences.length, differences:differences.slice(args.offset ?? 0,(args.offset ?? 0)+(args.limit ?? 100))};
    }
  });
})();
