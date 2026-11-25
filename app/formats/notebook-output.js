"use strict";
// Inspect only selected sheets at an output boundary. Plain prints do not request the maths
// font or notebook typefaces. Workers use these same module keys with the headless registry.
globalThis.AtriumNotebookOutput = (() => {
  const globals={math:"AtriumMath","rich-text":"AtriumRichText",calculations:"AtriumCalculations","calculation-display":"AtriumCalculationDisplay",
    "sheet-widgets":"AtriumSheetWidgets","table-visual":"AtriumTableVisual","note-fields":"AtriumNoteFields",calculators:"AtriumCalc","review-comments":"AtriumReviewComments",
    "review-notes-model":"AtriumMarkup"};
  function widgetRoots(widget, needed) {
    needed.add("sheet-widgets");
    const {type,state} = widget;
    if (type === "calculator") needed.add("calculators");
    const rows = Array.isArray(state?.rows) ? state.rows : [];
    if (type === "todo" && rows.some(row => row?.threadId)) needed.add("review-notes-model");
    if(type==="table" && state?.tableVersion===1)needed.add("table-visual");
    const cells = type==="table" && state?.tableVersion===1 ? state.cells.map(c=>c.content) : type === "table" ? rows.flatMap(row => row ? Object.values(row) : []) :
      type === "power-budget" && Array.isArray(state?.sources) ? state.sources.map(row => row?.input) : [];
    for (const cell of cells) {
      if (cell?.kind === "calculation") needed.add("calculations");
      if (cell?.kind === "field") needed.add("note-fields");
      if (cell?.kind === "rich") needed.add("rich-text");
      if (cell?.kind === "math" || cell?.richText?.blocks?.some(b=>b.runs?.some(r=>r.type==="math"))) needed.add("math");
    }
  }
  function selectedModules(project, documentIds, foreign) {
    const selected = Array.isArray(documentIds) ? new Set(documentIds) : null;
    const notesModule = foreign ? "notebook" : "rich-text";
    let math = false, notes = false, calculations = false;
    const widgetModules = new Set();
    for (const doc of project.documents) {
      if (doc.kind !== "schematic" || selected && !selected.has(doc.id)) continue;
      for (const item of doc.items) {
        if (item.kind === "calculation" || item.kind === "textframe" && item.calculation?.languageVersion === 1) {
          calculations = true;
          if (!foreign) math = true;
          continue;
        }
        if (item.kind !== "textframe") continue;
        if ((!foreign || item.widget?.state?.tableVersion===1) && item.widget?.type) widgetRoots(item.widget, widgetModules);
        if (!foreign && (item.sticky?.colour || item.callout?.anchor || item.ink?.path)) widgetModules.add("review-notes-model");
        if (item.math === true) math = true;
        const blocks = item.richText?.blocks;
        if (Array.isArray(blocks)) {
          notes = true;
          if (!math) math = blocks.some(block => Array.isArray(block?.runs) && block.runs.some(run => run?.type === "math"));
        }
        if (foreign && (item.widget || item.calculation || item.sticky || item.callout)) notes = true;
      }
    }
    const needed=[];
    if (math) needed.push("math");
    if (notes) needed.push(notesModule);
    if (calculations) {
      needed.push("calculations");
      if (!foreign) needed.push("calculation-display");
    }
    if (notes || calculations || widgetModules.has("calculations")) widgetModules.delete("note-fields");
    return [...new Set([...needed,...widgetModules])];
  }
  function roots(project, documentIds) {
    return selectedModules(project,documentIds,false);
  }
  function foreign(project, options={}) {
    if (options.pageMode === "frames") {
      const modules = new Set(selectedModules(project,undefined,true));
      if (modules.has("calculations")) modules.add("notebook");
      if (project.documents.some(doc=>doc.kind==="schematic" && doc.items.some(item=>item.widget))) {
        modules.add("notebook");
        modules.add("sheet-widgets");
      }
      return [...modules];
    }
    const single=options.scope!=="project" && options.scope!=="documents" && (options.documentId || options.document_id);
    return selectedModules(project,single ? [single] : undefined,true);
  }
  function job(project, outputs) {
    const modules = new Set();
    for (const output of outputs) {
      if (output.enabled === false) continue;
      const needed = output.kind === "pdf" ? roots(project,output.options?.documents) :
        output.kind === "kicad" && output.options?.sheets !== false ? foreign(project) : [];
      for (const key of needed) modules.add(key);
    }
    if (modules.has("rich-text")) modules.delete("notebook"); // the renderer loads the field reader itself
    return [...modules];
  }
  function prepare(project, ids, resolveAsset) {
    const wanted = roots(project,ids);
    const fonts = () => wanted.includes("rich-text") ? globalThis.AtriumNotebookFonts?.prepareAssets?.(project,ids,resolveAsset) || null : null;
    const modules = wanted.map(key => globals[key]).filter(key => !globalThis[key]);
    if (!modules.length) return fonts();
    if (!globalThis.AtriumLazy?.need) throw Error("The selected sheets need notebook rendering modules.");
    return AtriumLazy.need(modules).then(fonts);
  }
  return Object.freeze({roots,foreign,job,prepare});
})();
