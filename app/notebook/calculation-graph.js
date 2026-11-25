"use strict";
// The editor sends only dirty nodes and their already-evaluated inputs. The same
// graph kernel runs in the browser worker and against frozen, headless projects.
globalThis.AtriumCalculationGraph = (() => {
  const core = () => globalThis.AtriumCalculationCore;
  const MAX_NODES = 20000, PARSES = 1024;
  const VOLTAGE_DIMENSIONS = [2, 1, -3, -1, 0, 0, 0];
  const parsed = new Map();
  const keyOf = (documentId, blockId, instanceId = null, clauseId = null) => JSON.stringify([documentId, blockId, instanceId, clauseId]);
  const refKey = r => JSON.stringify([r.name, ...r.span]);
  const failed = (code, message, span, extra = {}) => ({ok: false, diagnostic: {code, message, span, ...extra}});

  function parse(source) {
    if (parsed.has(source)) return parsed.get(source);
    const result = core().parse(source);
    if (parsed.size >= PARSES) parsed.delete(parsed.keys().next().value);
    parsed.set(source, result);
    return result;
  }
  function countQueries(source) {
    return /\bcount\s*\(/i.test(source) ? parse(source).queries || [] : [];
  }

  function address(n) {
    const {documentId, blockId, instanceId, clauseId, label} = n;
    return {documentId, blockId, instanceId, clauseId, label};
  }

  // Iterative Kosaraju. Finish order puts dependencies first, and the second
  // traversal separates strongly connected components from their dependants.
  function orderOf(roots, nodes, known) {
    const visited = new Set(), order = [], reverse = new Map(), edges = new Map();
    function visit(key, stack) {
      const n = nodes.get(key);
      if (!n || known.has(key) || visited.has(key)) return;
      const ast = n.languageVersion > 1 ? null : parse(n.source), tokens = ast?.ok ? new Set(ast.references.map(refKey)) : new Set();
      const deps = [...new Set(n.references.filter(r => tokens.has(refKey(r))).flatMap(r => r.range || (r.dependency ? [r.dependency] : []))
        .filter(k => nodes.has(k) && !known.has(k)))];
      visited.add(key);
      edges.set(key, deps);
      for (const dep of deps) {
        if (!reverse.has(dep)) reverse.set(dep, []);
        reverse.get(dep).push(key);
      }
      stack.push({key, deps, index: 0});
    }
    for (const root of roots) {
      const stack = [];
      visit(root, stack);
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.index < top.deps.length) visit(top.deps[top.index++], stack);
        else { order.push(top.key); stack.pop(); }
      }
    }
    return {order, reverse, edges};
  }

  function cyclePath(start, members, edges) {
    const previous = new Map(), queue = [start];
    // Start is intentionally not marked. An edge back to it closes the path.
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i];
      for (const dep of edges.get(key)) {
        if (!members.has(dep) || previous.has(dep)) continue;
        previous.set(dep, key);
        if (dep === start) {
          const path = [start];
          for (let k = key; k !== start; k = previous.get(k)) path.push(k);
          return [start, ...path.reverse()];
        }
        queue.push(dep);
      }
    }
    return [start, start];
  }

  function markCycles({order, reverse, edges}, nodes) {
    const assigned = new Set(), cycles = new Map();
    for (let i = order.length - 1; i >= 0; i--) {
      const start = order[i];
      if (assigned.has(start)) continue;
      const component = new Set([start]), queue = [start];
      assigned.add(start);
      for (let j = 0; j < queue.length; j++) {
        for (const key of reverse.get(queue[j]) || []) {
          if (assigned.has(key)) continue;
          assigned.add(key);
          component.add(key);
          queue.push(key);
        }
      }
      if (component.size === 1 && !edges.get(start).includes(start)) continue;
      const path = cyclePath(start, component, edges).map(k => address(nodes.get(k)));
      const labels = path.map(p => p.label || p.blockId);
      const message = "Circular calculation: " + (labels.length <= 10 ? labels : [...labels.slice(0, 8), "…", labels[labels.length - 1]]).join(" → ");
      for (const key of component) {
        const n = nodes.get(key), ref = n.references.find(r => component.has(r.dependency));
        cycles.set(key, failed("cycle", message,
          ref?.span || [0, n.source.length], {cycle: path}));
      }
    }
    return cycles;
  }

  function evaluateNode(n, values, functions, cycle) {
    if (cycle) return {result: cycle, inputs: []};
    if (n.languageVersion > 1) return {result: failed("language-version", "This calculation uses a newer expression language.", [0, n.source.length]), inputs: []};
    const ast = parse(n.source);
    if (!ast.ok) return {result: ast, inputs: []};
    const refs = new Map(n.references.map(r => [refKey(r), r])), resolved = new Map(), errors = new Map(), inputs = [];
    let problem;
    for (const token of ast.references) {
      const key = refKey(token), r = refs.get(key);
      let value, diagnostic;
      if (!r) diagnostic = failed("unbound", "Choose a design field for " + token.name + ".", token.span);
      else if (r.diagnostic) diagnostic = {ok: false, diagnostic: {...r.diagnostic, span: token.span}};
      else if (Array.isArray(r.range) && n.deferErrors) {
        const items=[];
        if(r.range.length>8192)diagnostic=failed("limit","The selected table range is too large.",token.span);
        else for(const key of r.range){
          const input=values.get(key);
          if(input?.literalText)continue;
          if(!input?.result?.ok){diagnostic=failed("dependency","A quantity in the selected table range is unavailable.",token.span);break;}
          items.push(input.result);
        }
        value={kind:"tableRange",values:items};
      } else if (r.dependency) {
        value = values.get(r.dependency)?.result;
        const cause = value?.diagnostic;
        if (!value?.ok) diagnostic = failed("dependency", "Calculation input " + token.name + " is unavailable.", token.span,
          {target: r.target, cause: cause && {code: cause.code, message: cause.message, span: cause.span}});
      } else if (r.field) {
        const {raw, unit, fieldUnit, sourceId, toleranceLabel, tolerance, toleranceSource} = r.field;
        value = core().parseBoundValue(raw, {unit, fieldUnit, sourceId, label: toleranceLabel, tolerance, toleranceSource});
        if (!value.ok) diagnostic = failed(value.diagnostic.code, value.diagnostic.message, token.span, {target: r.target});
        else if (r.requireVoltage && !VOLTAGE_DIMENSIONS.every((d, i) => d === value.dimensions[i])) {
          diagnostic = failed("voltage-required", "Declare the voltage with a compatible unit for " + token.name + ".", token.span, {target: r.target});
        }
      } else diagnostic = failed("broken-reference", "The design field for " + token.name + " is missing.", token.span, {target: r?.target});
      if (diagnostic) { if (n.deferErrors) errors.set(key,diagnostic.diagnostic); else problem ||= diagnostic; }
      else resolved.set(key, value);
      inputs.push({id: r?.id ?? null, name: token.name, span: token.span, target: r?.target ?? null,
        label: r?.field?.label || r?.label || token.name, field: r?.field ?? null, value: diagnostic ? null : value,
        diagnostic: diagnostic?.diagnostic ?? null});
    }
    if (problem) return {result: problem, inputs};
    const activeFunctions = n.functions ? Object.fromEntries(Object.entries(n.functions)
      .filter(([id, version]) => functions?.[id]?.version === version).map(([id]) => [id, functions[id]])) : functions;
    const result = core().evaluate(ast, {resolve: token => {
      const key=refKey(token),diagnostic=errors.get(key);
      if (diagnostic) { const e=Error(diagnostic.message);e.diagnostic=diagnostic;throw e; }
      return resolved.get(key);
    }, functions: activeFunctions,tableRanges:n.deferErrors===true,displayUnit:n.displayUnit,fieldUnit:n.fieldUnit,countQuery:query=>n.counts?.[query.span[0]]});
    if (n.clauseId != null && result.ok && !result.assertion) {
      return {result: failed("assertion-expected", "Compare quantities in the assertion.", [0, n.source.length]), inputs};
    }
    return {result, inputs};
  }

  function run({nodes: rows, known = [], roots, functions}) {
    if (rows.length > MAX_NODES) throw Error("The requested calculation closure exceeds " + MAX_NODES + " expressions.");
    const nodes = new Map(rows.map(n => [n.key, n])), values = new Map(known);
    const traversal = orderOf(roots, nodes, values), cycles = markCycles(traversal, nodes), changed = [];
    for (const key of traversal.order) {
      const row = evaluateNode(nodes.get(key), values, functions, cycles.get(key));
      if(nodes.get(key).tableLiteral && !row.result.ok && ["unbound","reference","syntax","source","field","unit"].includes(row.result.diagnostic?.code))
        row.literalText=true;
      values.set(key, row);
      changed.push([key, row]);
    }
    return {changed, stats: {visited: traversal.order.length, evaluated: traversal.order.length - cycles.size, cyclic: cycles.size}};
  }

  function task(request) {
    if (request.operation === "parse") {
      const out = parse(request.source);
      if (!out.ok) return out;
      const calls = new Set(), work = [out.ast];
      while (work.length) {
        const node = work.pop();
        if (node.type === "call") { calls.add(node.id); work.push(...node.args); }
        for (const child of [node.child, node.arg, node.left, node.right, node.object]) if (child) work.push(child);
      }
      let atom=out.ast;
      while(atom.type==="unary")atom=atom.arg;
      return {ok:true, name:out.name, references:out.references, queries:out.queries, calls:[...calls], quantityLiteral:!out.name && atom.type==="number"};
    }
    if (request.operation === "extension") return core().evaluateFunction(request.declaration, request.args, {functions: request.functions});
    if (request.operation === "validate-functions") return core().validateFunctions(request.declarations, {functions: request.functions});
    if (request.operation === "graph") return run(request);
    throw Error("Unknown calculation operation.");
  }

  return Object.freeze({keyOf, refKey, failed, run, task, countQueries, maxNodes:MAX_NODES});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumCalculationGraph;
