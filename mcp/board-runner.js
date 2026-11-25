"use strict";

// Retain at most one pair of indexed revisions in a long-lived JS context.
let comparison, lastFilter, lastFields, categoryCache;
function clearComparison() {
  comparison = lastFilter = lastFields = categoryCache = undefined;
}

function compareGitHead(request) {
  if (!comparison) throw Error("Reload the saved comparison.");
  const {section, offset, limit, key, area, status, query} = request.options;
  const window = (items, total) => ({section, items, total, next_offset:offset+limit<total ? offset+limit : null});
  if (section === "fields") {
    const items = [];
    if (!lastFields || lastFields.row.key !== key) {
      const row = comparison.rows.find(row => row.key === key);
      if (!row) throw Error("The change key is absent from this comparison.");
      let total = 0;
      for (const field of AtriumRevisionReview.fields(comparison, row)) {
        if (total >= offset && items.length < limit) items.push(field);
        total++;
      }
      lastFields = {row, total, index:0, iterator:null};
      return window(items, total);
    }
    const cursor = lastFields;
    if (offset >= cursor.total) return window(items, cursor.total);
    if (!cursor.iterator || offset < cursor.index) {
      cursor.index = 0;
      cursor.iterator = AtriumRevisionReview.fields(comparison, cursor.row);
    }
    const end = Math.min(cursor.total, offset+limit);
    while (cursor.index < end) {
      const field = cursor.iterator.next().value;
      if (cursor.index++ >= offset) items.push(field);
    }
    if (cursor.index === cursor.total) cursor.iterator = null;
    return window(items, cursor.total);
  }
  let rows = comparison.rows;
  if (area || status || query) {
    if (!lastFilter || lastFilter.area !== area || lastFilter.status !== status || lastFilter.query !== query) {
      categoryCache = undefined;
      lastFilter = {area, status, query, rows:AtriumRevisionReview.findRows(comparison, area, status, query)};
    }
    rows = lastFilter.rows;
  }
  if (section === "categories") {
    if (!categoryCache || categoryCache.rows !== rows) {
      const counts = new Map();
      for (const row of rows) {
        if (!counts.has(row.area)) counts.set(row.area, {area:row.area, Added:0, Changed:0, Removed:0});
        counts.get(row.area)[row.status]++;
      }
      categoryCache = {rows, categories:[...counts.values()].sort((a,b) => a.area.localeCompare(b.area))};
    }
    const {categories} = categoryCache;
    return window(categories.slice(offset, offset+limit), categories.length);
  }
  const items = rows.slice(offset, offset+limit).map(row => ({
    key:row.key, area:row.area, status:row.status, name:row.name, previous_name:row.oldName,
    document_id:row.document || null, document_name:row.documentName, locate_id:row.locate,
  }));
  return window(items, rows.length);
}

globalThis.AtriumBoardReport = function(requestText, committed, saved) {
  const request = JSON.parse(requestText);
  const {tool, document, library, projectRules} = request;
  if(tool==="load_git_comparison"){
    clearComparison();
    const baseline = JSON.parse(committed);
    comparison = AtriumRevisionReview.compare(baseline, request.identical ? baseline : JSON.parse(saved));
    return "null";
  }
  if(tool==="clear_git_comparison"){clearComparison();return "null";}
  if(tool==="compare_git_head")return JSON.stringify(compareGitHead(request));
  if(document.kind!=="pcb")throw Error("Choose a PCB layout.");
  if(tool === "list_source_rules"){
    const lines=AtriumAltiumRules.validate(document.sourceRules||[]);
    return JSON.stringify({rules:lines.map((line,source_index)=>({source_index,...AtriumAltiumRules.describe(line)}))});
  }
  Atrium.validate({format:"atrium",version:1,name:"Inspection",documents:[document],library});
  const definitions = new Map(library.map(d=>[d.id,d]));
  if(tool === "board_connectivity")return JSON.stringify(AtriumConnectivity.inspect(document,definitions));
  if(tool === "check_board_rules"){
    // The board's rules: its view of the project rule book (project-rules.js).
    const rules=projectRules ? AtriumProjectRules.forBoard({documents:[document],rules:projectRules},document,projectRules) : AtriumRules.defaults();
    return JSON.stringify({...AtriumRules.check(document,definitions,rules),
      rules_source:projectRules?"project":"defaults"});
  }
  throw Error("Unknown board inspection.");
};

if(typeof module!=="undefined" && typeof require==="function" && require.main===module){
  try{
    if(Number(process.versions.node.split(".")[0])<18)throw Error("Node.js 18 or later is required.");
    require("../app/core/model.js");require("../app/pcb/pcb-draw.js");require("../app/checks/altium-rules.js");require("../app/checks/net-intent.js");require("../app/checks/rules.js");require("../app/checks/project-rules.js");require("../app/core/signals.js");require("../app/schematic/blocks.js");
    require("../app/checks/connectivity.js");require("../app/history/revision-review.js");
    const fs = require("node:fs");
    const {readFrame, writeExact} = require("./pipe-frames.js");
    if (process.argv[2] === "--stdio") {
      let frame;
      while ((frame = readFrame("Incomplete design inspection request."))) {
        const args = [];
        for (let i=0; i<3; i++) if (frame.lengths[i]) args.push(frame.slots[i]);
        let line;
        try { line = '{"result":' + AtriumBoardReport(...args) + '}\n'; }
        catch (error) { line = JSON.stringify({error:error.message || String(error)}) + "\n"; }
        // Snapshot parsing and indexing can leave an entire board in temporary
        // storage. Release it once before this process goes idle between pages.
        if (frame.large) {
          args.length = 0;
          global.gc?.();
        }
        writeExact(line);
      }
    } else {
      process.stdout.write(AtriumBoardReport(fs.readFileSync(0,"utf8")));
    }
  }catch(error){process.stderr.write(error?.message||String(error));process.exitCode=1;}
}
