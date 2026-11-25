"use strict";

// A 1.x text frame keeps the expression readable in earlier releases. All callers see the
// canonical calculation shape through read(). Derived quantities never enter the sheet.
globalThis.AtriumCalculationRecords = (() => {
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const text = (s, max) => typeof s === "string" && s.length <= max;
  const id = s => text(s, 512) && s.length > 0;
  const isBlock = i => !!i && (i.kind === "calculation" || i.kind === "textframe" && Object.hasOwn(i, "calculation"));
  const metaKeys = ["languageVersion", "bindings", "assertions", "primaryAssertionId", "name", "displayUnit", "functions", "tolerance"];
  function metadata(record) {
    const out = {languageVersion: 1, bindings: [], assertions: []};
    for (const key of metaKeys) if (record[key] !== undefined) out[key] = record[key];
    return out;
  }
  function read(i) {
    if (!isBlock(i)) return null;
    if (i.kind === "calculation") return i;
    const record = {kind:"calculation", id:i.id, x:i.x, y:i.y, source:i.text, ...metadata(i.calculation || {})};
    if (record.primaryAssertionId && Array.isArray(record.assertions)) record.assertions = [{id:record.primaryAssertionId,source:record.source,bindings:record.bindings},...record.assertions];
    return record;
  }
  function references(item) {
    const record = read(item);
    if (!record || record.languageVersion !== 1) return [];
    const rows = [{source:record.source, bindings:record.bindings || [], field:"calculation"}];
    for (const clause of record.assertions || []) {
      if (clause.id !== record.primaryAssertionId)
        rows.push({source:clause.source, bindings:clause.bindings || [], field:"assertion"});
    }
    return rows;
  }
  function backing(record, style = {}) {
    const m = metadata(record);
    if (record.primaryAssertionId) m.assertions = m.assertions.filter(a => a.id !== record.primaryAssertionId);
    if (/^\s*assert\b/u.test(record.source)) m.primaryAssertionId ||= globalThis.Atrium.id();
    else delete m.primaryAssertionId;
    return {...style, kind:"textframe", id:record.id, x:record.x, y:record.y,
      w:style.w ?? 58, h:style.h ?? (16 + 5 * (record.assertions?.length || 0)),
      text:record.source, calculation:m};
  }
  function validBindings(list, source) {
    const ids = new Set();
    return Array.isArray(list) && list.length <= 2048 && list.every(b => {
      if (!plain(b) || !id(b.id) || ids.has(b.id) || !text(b.name, 512) || !Array.isArray(b.span) ||
        b.span.length !== 2 || !b.span.every(Number.isSafeInteger)) return false;
      const [start,end] = b.span;
      ids.add(b.id);
      return start >= 0 && end > start && end <= source.length && (b.target == null || plain(b.target));
    });
  }
  function valid(i, lenient = false) {
    if (!isBlock(i)) return false;
    if (i.kind === "textframe" && (!plain(i.calculation) || i.role != null || i.math ||
      ["widget","richText","sticky","callout","reviewChecklist","ink","sketch"].some(k => i[k] != null))) return false;
    const m = i.kind === "textframe" ? i.calculation : metadata(i), r = read(i);
    if (lenient && m.languageVersion > 1) return true;
    if (m.languageVersion !== 1 || !text(r.source, 16384) || !r.source.trim() || !validBindings(m.bindings || [],r.source) ||
      m.name != null && !text(m.name, 256) || m.displayUnit != null && !text(m.displayUnit, 128) ||
      !lenient && Object.keys(m).some(key => !metaKeys.includes(key))) return false;
    if (m.functions != null && (!plain(m.functions) || Object.keys(m.functions).length > 256 ||
      !Object.entries(m.functions).every(([k,v]) => id(k) && id(v)))) return false;
    if (m.primaryAssertionId != null && (!id(m.primaryAssertionId) || !/^\s*assert\b/u.test(r.source))) return false;
    const seen = new Set(m.primaryAssertionId ? [m.primaryAssertionId] : []);
    return Array.isArray(m.assertions || []) && (m.assertions || []).length <= 256 && (m.assertions || []).every(c => {
      if (!plain(c) || !id(c.id) || seen.has(c.id) || !text(c.source, 16384) || !c.source.trim() || !validBindings(c.bindings || [],c.source)) return false;
      seen.add(c.id);
      return true;
    });
  }
  function summary(record, evaluated) {
    const result = evaluated?.result, assertions = evaluated?.assertions || [];
    const value = result?.ok ? result.display : result?.diagnostic?.message || "Loading input";
    const label = s => ({pass:"Pass", fail:"Fail", "may-violate":"May violate", disabled:"Disabled", pending:"Pending"})[s] || "Incomplete";
    const states = (record.assertions || []).map(clause => {
      const checked = assertions.find(a => a.id === clause.id);
      const outcome = checked?.result;
      const status = checked?.status || outcome?.assertion?.status || (checked?.enabled === false ? "disabled" : "incomplete");
      return {id:clause.id,source:clause.source,status,label:label(status),warnings:outcome?.warnings || [],diagnostic:outcome?.diagnostic};
    });
    return {source:record.source,value,warnings:result?.warnings || [],states};
  }
  function exportText(record, evaluated) {
    const s = summary(record, evaluated);
    const lines = [s.source + "  =  " + s.value, ...s.warnings];
    for (const a of s.states) lines.push(a.label + " · " + a.source, ...a.warnings, ...(a.diagnostic ? [a.diagnostic.message] : []));
    return lines.join("\n");
  }
  function indexEvaluations(snapshot, instanceId) {
    const grouped = new Map(), index = new Map();
    for (const r of snapshot?.records || []) {
      if (instanceId != null && r.instanceId !== instanceId && !(r.instanceId == null && instanceId === r.documentId)) continue;
      let group = grouped.get(r.blockId);
      if (!group) grouped.set(r.blockId,group = []);
      group.push(r);
    }
    for (const [id,group] of grouped) index.set(id,group.length === 1 ? group[0] : {
      blockId:id,instances:group,result:{ok:false,diagnostic:{code:"instance",message:"Choose a sheet instance."}}
    });
    return index;
  }
  function frozen(project, doc, revision, instanceId) {
    if (!doc?.items?.some(isBlock)) return new Map();
    const snapshot = globalThis.AtriumCalculations?.evaluateSnapshot?.(project, {documentId:doc.id, revision, instanceId});
    return indexEvaluations(snapshot,instanceId);
  }
  const scopeKey = (documentId, instanceId) => JSON.stringify([documentId,instanceId ?? null]);
  function forOutput(project, revision, cache = new Map()) {
    const references = new Map();
    function sheet(doc, instanceId) {
      const key = scopeKey(doc.id,instanceId);
      if (!cache.has(key)) cache.set(key,frozen(project,doc,revision,instanceId));
      return cache.get(key);
    }
    function lookup({documentId,blockId,instanceId}) {
      let record = cache.get(scopeKey(documentId,instanceId))?.get(blockId) ?? cache.get(scopeKey(documentId))?.get(blockId);
      if (!record) {
        const key = JSON.stringify([documentId,blockId]);
        if (!references.has(key)) {
          const snapshot = globalThis.AtriumCalculations?.evaluateSnapshot?.(project,{documentId,blockId,revision});
          references.set(key,indexEvaluations(snapshot).get(blockId));
        }
        record = references.get(key);
      }
      if (!record || instanceId == null) return record;
      return (record.instances || [record]).find(r => (r.instanceId ?? r.documentId) === instanceId) || null;
    }
    return {sheet,lookup};
  }
  function frozenProject(project, revision, instanceId) {
    if (!project?.documents?.some(d => d.kind === "schematic" && d.items?.some(isBlock))) return new Map();
    return indexEvaluations(globalThis.AtriumCalculations?.evaluateSnapshot?.(project,{revision,instanceId}),instanceId);
  }
  function staticOutput(record, evaluated, format) {
    evaluated ||= {result:{ok:false,diagnostic:{code:"unavailable",message:"Calculation unavailable"}}};
    const status = evaluated?.result?.ok ? "static" : "incomplete";
    const detail = status === "incomplete" ? "; " + (evaluated?.result?.diagnostic?.message || "calculation unavailable") : "";
    return {text:exportText(record,evaluated), fidelity:{blockId:record.id,format,conversion:"static text",status,
      loss:["live binding", ...(record.assertions?.length ? ["live assertion"] : [])]},
      message:"Calculation " + record.id + " exported as static text to " + format + "; live bindings lost" + detail + "."};
  }
  const projects = new WeakMap();
  function projectToken(project) {
    if (!projects.has(project)) projects.set(project,globalThis.Atrium.id());
    return projects.get(project);
  }
  function copyBindings(item, ids, from, to, crossProject) {
    const fields = globalThis.AtriumNoteFields;
    const docIds = new Map(from ? [[from,to]] : []), newId = () => globalThis.Atrium.id();
    const remap = b => {
      const target = b.target;
      if (!target) return {...b,id:newId()};
      // The sheet ID of an external reference must be retained when copying within a project.
      const local = target.itemId && ids.has(target.itemId);
      const maps = {docIds:local ? docIds : new Map(),itemIds:ids,signalIds:new Map(),instanceIds:new Map()};
      if (!fields?.remap) throw Error("Load the calculation field resolver before copying bound inputs.");
      return {...b,id:newId(),target:fields.remap(target,maps,crossProject)};
    };
    item.calculation.bindings = (item.calculation.bindings || []).map(remap);
    if (item.calculation.primaryAssertionId) item.calculation.primaryAssertionId = newId();
    item.calculation.assertions = (item.calculation.assertions || []).map(c => ({...c,id:newId(),bindings:(c.bindings || []).map(remap)}));
  }
  function moveBindings(project, from, to, moved, instances = new Map()) {
    const ids = new Set(Array.from(moved,id => typeof id === "string" ? id : id.id)), touched = [];
    for (const doc of project.documents) for (const item of doc.items) {
      if (!isBlock(item)) continue;
      const m = item.kind === "textframe" ? item.calculation : item;
      let changed = false;
      for (const source of [m,...(m.assertions || [])]) for (const b of source.bindings || []) {
        const next = globalThis.AtriumNoteFields.rebaseTarget(b.target, from, to, ids, instances);
        if (next) {Object.assign(b.target, next); changed = true;}
      }
      if (changed) touched.push({doc,items:[item]});
    }
    return touched;
  }
  function evaluatedValue(row) {
    if (row?.instances) return row.instances.map(r => ({instanceId:r.instanceId,value:evaluatedValue(r)}));
    function value(r) {
      if (!r?.ok) return r?.diagnostic || {code:"unavailable",message:"Calculation unavailable"};
      return {value:r.value,dimensions:r.dimensions,unit:r.unit,display:r.display,worst:r.worst,rss:r.rss,
        warnings:r.warnings,assertion:r.assertion?.status};
    }
    return {value:value(row?.result),assertions:(row?.assertions || []).map(a => ({id:a.id,value:value(a.result),enabled:a.enabled}))};
  }
  function compareSides(beforeItem, beforeEval, afterItem, afterEval) {
    const a = read(beforeItem), b = read(afterItem), same = (x,y) => JSON.stringify(x) === JSON.stringify(y);
    if (!a || !b) return [];
    const fields = ["source",...metaKeys].filter(key => !same(a[key],b[key]));
    const before = evaluatedValue(beforeEval), after = evaluatedValue(afterEval);
    if (fields.length) return [{kind:"formula",text:"Calculation formula changed",before:{source:a.source,assertions:a.assertions,result:before},
      after:{source:b.source,assertions:b.assertions,result:after},fields}];
    if (!same(before,after)) return [{kind:"result",text:"Calculation result changed with its inputs",before,after,fields:["result"]}];
    return [];
  }
  const descriptor = {
    matches:isBlock,
    moveBindings,
    prepare(project,context) {
      return {evaluations:frozenProject(project,context.revision,context.instanceId)};
    },
    describe(project,doc,item,context) {
      const record = read(item);
      const evaluation = (context.evaluations || frozen(project,doc,context.revision,context.instanceId)).get(item.id);
      return {label:record.name || "Calculation",text:exportText(record,evaluation),fields:record.bindings,evaluation,source:record.source};
    },
    compare:(a,ad,b,bd) => compareSides(a,ad?.evaluation,b,bd?.evaluation)
  };
  globalThis.AtriumNotebook?.register("calculation",descriptor);
  return Object.freeze({isBlock,read,references,backing,valid,summary,exportText,indexEvaluations,frozen,scopeKey,forOutput,frozenProject,staticOutput,projectToken,copyBindings,moveBindings,compareSides,descriptor});
})();
