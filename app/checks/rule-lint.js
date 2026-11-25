"use strict";
// Logical hints for the Rules document. A proof is an empty intersection over all possible
// objects. Board enumeration supplies examples and coverage, never a proof of priority.
globalThis.AtriumRuleLint = (() => {
  const R = () => globalThis.AtriumRules;
  const all = (...xs) => ({and:xs}), any = (...xs) => ({or:xs}), not = x => ({not:x});
  const yes = all(), no = any(), equal = (key, value) => ({key, value});
  const flag = key => equal(key, true);
  const inverse = {"<":">=", "<=":">", ">":"<=", ">=":"<"};
  const fieldKey = (side, key, dimension) => JSON.stringify([side, key, dimension]);
  // Missing fields satisfy neither a predicate nor its negation. Keep the two
  // determinate outcomes separate so a priority proof cannot cover unknown rows.
  const known = (expr, present = yes) => ({true:all(present, expr), false:all(present, not(expr))});
  const spanKey = span => span.join(":");

  function comparison(side, fact) {
    if (!fact?.key) return null;
    const {op, fieldType, quantity:q, value} = fact;
    const dimension = q && [Array.from(q.dimensions), q.tag || ""];
    const key = fieldKey(side, fact.key, dimension || fieldType);
    const present = flag(key + ":present");
    if (q && Number.isFinite(q.value)) {
      const edge = op => ({key, op, bound:q.value});
      if (op === "=" || op === "!=") {
        // Equality in the shared quantity evaluator is inclusive. Its exact
        // complement gains no fabricated endpoints from the proof engine.
        const eq = all(flag(key + ":equal:" + q.value), edge(">="), edge("<="));
        return known(op === "=" ? eq : not(eq), present);
      }
      if (Object.hasOwn(inverse, op)) return known(edge(op), present);
    }
    if ((fieldType === "text" && typeof value === "string" || fieldType === "boolean" && typeof value === "boolean") &&
        (op === "=" || op === "!=")) {
      const eq = equal(key, value);
      return known(op === "=" ? eq : not(eq), present);
    }
    return null;
  }
  function predicate(side, node, facts) {
    if (node.type === "and" || node.type === "or") {
      const children = node.args.map(child => predicate(side, child, facts));
      if (children.some(child => !child)) return null;
      const and = node.type === "and";
      return {true:(and ? all : any)(...children.map(child => child.true)),
        false:(and ? any : all)(...children.map(child => child.false))};
    }
    if (node.type === "not") {
      const child = predicate(side, node.arg, facts);
      return child && {true:child.false, false:child.true};
    }
    if (node.type === "compare") return comparison(side, facts.get(spanKey(node.span)));
    if (node.type === "boolean") {
      const literal = node.field.toLowerCase();
      if (literal === "true" || literal === "false") return known(literal === "true" ? yes : no);
    }
    // Membership, geometry and other evaluated predicates stay opaque unless
    // the effective plan provides exact facts. A bounding box is never a fact.
    return null;
  }
  function expression(plan, scope, side) {
    if (!plan) return null;
    if (R().kit.allScope(scope)) return yes;
    if (!plan.kind || plan.dependencies?.some(key => key.startsWith("rule:") || key.startsWith("geometry:"))) return null;
    // A concrete kind narrows the consumer domain. Some kinds overlap, so do
    // not make distinct kinds mutually exclusive or compare native record.kind.
    const kind = plan.kind === "object" ? yes : flag(JSON.stringify([side,"kind",plan.kind]));
    if (plan.ast === null) return kind;
    if (!plan.ast) return null;
    const facts = new Map((plan.comparisons || []).map(fact => [spanKey(fact.span), fact]));
    const result = predicate(side, plan.ast, facts);
    return result && all(kind, result.true);
  }
  function scope(r) {
    const a = expression(r.scopePlan, r.scope, "a");
    if (!a) return null;
    if (r.scope2) {
      const b = expression(r.scope2Plan, r.scope2, "b");
      return b && any(all(a, b), all(expression(r.scope2Plan, r.scope2, "a"), expression(r.scopePlan, r.scope, "b")));
    }
    if (r.type === "fanoutControl" && r.package !== "default") return all(a, equal("aPackage", r.package));
    return a;
  }

  function restrict(state, p, negated) {
    const domain = state.get(p.key) || {};
    let update;
    if (p.op) {
      const op = negated ? inverse[p.op] : p.op;
      const lower = op[0] === ">", strict = op.length === 1;
      const end = lower ? (strict ? "loOpen" : "loClosed") : (strict ? "hiOpen" : "hiClosed");
      const old = domain[end];
      if (old !== undefined && (lower ? old >= p.bound : old <= p.bound)) return state;
      update = {...domain, [end]:p.bound};
      // A strict predicate and the opposing inclusive predicate cannot overlap
      // at ordered thresholds. Two inclusive predicates can overlap within the
      // shared relative tolerance, so never infer separation from their bounds.
      if (update.loOpen >= Math.min(update.hiOpen ?? Infinity, update.hiClosed ?? Infinity) ||
          update.hiOpen <= Math.max(update.loOpen ?? -Infinity, update.loClosed ?? -Infinity)) return null;
    } else if (negated) {
      if (domain.value === p.value) return null;
      if (domain.value !== undefined || domain.except?.has(p.value)) return state;
      update = {except:new Set(domain.except).add(p.value)};
    } else {
      if (domain.value === p.value) return state;
      if (domain.value !== undefined || domain.except?.has(p.value)) return null;
      update = {value:p.value};
    }
    return new Map(state).set(p.key, update);
  }
  // Bounded DNF search. Negations are distributed lazily. An exhausted search is
  // unknown (no hint), never an empty result. This also bounds untrusted query expansion.
  const exhausted = Symbol();
  function impossible(expr, budget) {
    let steps = 1024;
    function solve(x, inverted, states) {
      if (--steps < 0 || (budget.left -= states.length + 1) < 0) throw exhausted;
      if (x.not) return solve(x.not, !inverted, states);
      const xs = x.and || x.or;
      if (!xs) return states.map(s => restrict(s, x, inverted)).filter(Boolean);
      if (!!x.and !== inverted) {
        for (const child of xs) { states = solve(child, inverted, states); if (!states.length) break; }
        return states;
      }
      const out = [];
      for (const child of xs) {
        for (const s of solve(child, inverted, states)) { if (out.length >= 96) throw exhausted; out.push(s); }
      }
      return out;
    }
    try { return !solve(expr, false, [new Map()]).length; }
    catch (e) { if (e !== exhausted) throw e; budget.limited = true; return false; }
  }

  // These rule families use first(), either() or the symmetric pair resolver. Other
  // checks can have additional selectors (e.g. aggressor/victim, per-package matrices)
  // or accumulate findings from every rule. Do not infer priority for those checks.
  const ordered = new Set(("clearance short width viaStyle holeSize annularRing routingLayers routingPriority routingCorners fanoutControl " +
    "solderMask pasteMask polygonConnect holeToHole silkToMask silkToSilk boardOutlineClearance diffPairsRouting unrouted").split(" "));
  const titles = {impossible:"Impossible scope", shadow:"Priority shadow", limits:"Contradictory limits", empty:"No board matches"};
  function explainImpossible(r) {
    return [r.scope, r.scope2].filter(Boolean).map(s => R().scopeQuery(s)).join(" / ") +
      " has incompatible conditions. No object assignment satisfies this scope under the current rules.";
  }
  const subjectResult = (r, side, subject) => R().kit.allScope(r[side]) ? true : r[side + "Plan"]?.test?.(subject) ?? null;
  function localCoverage(rows, lists, project, board, add, budget) {
    const tested = new Map(), scopeSides = ["scope", "scope2"];
    const xSignal = plan => plan.dependencies?.some(k => k === "relation:xsignal" || k === "relation:xsignalclass");
    let paths, comparisons = 1200000;
    for (const r of rows) for (const [index, side] of scopeSides.entries()) {
      if (R().kit.allScope(r[side])) continue;
      const plan = r[side + "Plan"];
      if (!plan?.test) continue;
      if (!tested.has(plan)) {
        let groups = lists;
        if (xSignal(plan)) {
          paths ??= globalThis.AtriumSignals?.model(project, board)?.paths();
          if (!paths) { tested.set(plan, false); continue; }
          groups = [...lists, paths.map(x => ({xSignal:x.name,net:x.nets?.[0]}))];
        }
        let empty = true;
        outer: for (const group of groups) for (const subject of group) {
          if (--comparisons < 0) { budget.limited = true; empty = false; break outer; }
          if (plan.test(subject) !== false) { empty = false; break outer; }
        }
        tested.set(plan, empty);
      }
      if (tested.get(plan)) add("empty", r, (r.scope2 ? (index ? "Second" : "First") + " scope " : "") +
        R().scopeQuery(r[side]) + " matches no object on " + board.name + ".");
    }
  }
  function schematicProofs(set, rows, project, add, budget) {
    if (!project || !rows.length) return;
    const scoped = globalThis.AtriumERC?.scopedRules(project, {...set,list:rows});
    if (!scoped) return;
    const incomplete = new Set(scoped.diagnostics.map(d => d.ruleId));
    const byId = new Map(rows.map(r => [r.id,r]));
    for (const group of scoped.byType.values()) for (const entry of group) {
      if (!entry.sheets.size || incomplete.has(entry.id)) continue;
      const r = byId.get(entry.id);
      if ([...entry.sheets.values()].every(plan => {
        const expr = expression(plan, r.scope, "a");
        return expr && budget.left > 0 && impossible(expr,budget);
      })) add("impossible", r, explainImpossible(r));
    }
  }
  function analyze(set, {board, project, defs = new Map(), geometry} = {}) {
    const rules = R(), projectRules = globalThis.AtriumProjectRules, hints = [];
    const active = set.list.filter(r => rules.ruleActive(set, r));
    const layout = [], schematic = [];
    for (const r of active) {
      if (projectRules?.isErc(r.type)) schematic.push(r);
      else if (Object.hasOwn(rules.types,r.type) && r.where !== "schematic" &&
          (!board || !projectRules || projectRules.appliesToBoard(r,board.id))) layout.push(r);
    }
    const budget = {left:150000, limited:false}, peers = new Map(), seen = new Set();
    const add = (kind, r, explanation, others = []) => {
      const h = {kind, title:titles[kind], rule:r.id, related:others.map(o => o.id), explanation};
      const key = JSON.stringify([kind, r.id, explanation]);
      if (!seen.has(key)) { seen.add(key); hints.push(h); }
    };
    schematicProofs(set, schematic, project, add, budget);
    if (!layout.length) return {hints, limited:budget.limited};
    const layoutSet = {...set,list:layout};
    const compiled = rules.kit.compile(layoutSet,{doc:board ?? null,project,defs,explicit:true});
    const rows = Object.values(compiled.byType).flat().sort((a,b) => a.priority - b.priority), eligible = [];
    for (const r of rows) {
      const expr = scope(r), prev = peers.get(r.type) || [];
      if (expr && budget.left > 0 && impossible(expr, budget)) {
        add("impossible", r, explainImpossible(r));
        continue;
      }
      eligible.push(r);
      if (expr && ordered.has(r.type) && (board || !r.boards && !r.exceptBoards)) {
        const higher = prev.filter(p => p.r.priority < r.priority);
        const cover = higher.find(p => budget.left > 0 && impossible(all(expr, not(p.expr)), budget));
        let winners = cover ? [cover] : [];
        const candidates = higher.slice(0,16);
        if (!cover && candidates.length < higher.length) budget.limited = true;
        if (!cover && candidates.length > 1 && budget.left > 0 && impossible(all(expr, not(any(...candidates.map(p => p.expr)))), budget)) {
          winners = candidates.slice();
          for (const p of candidates) {
            const without = winners.filter(x => x !== p);
            if (impossible(all(expr, not(any(...without.map(x => x.expr)))), budget)) winners = without;
          }
        }
        if (winners.length) {
          const names = winners.map(({r:p}) => p.name + " (priority " + p.priority + ")");
          const reason = names.length === 1 ? names[0] + " covers" : names.slice(0,-1).join(", ") + " and " + names.at(-1) + " together cover";
          add("shadow", r, reason + " every match of this priority-" + r.priority + " rule.", winners.map(p => p.r));
        }
        prev.push({r, expr}); peers.set(r.type, prev);
      }
      const check = (values, where) => {
        for (const range of rules.types[r.type]?.ranges || []) {
          const min = range[0], max = range.at(-1);
          if (values[min] != null && values[max] != null && values[min] > values[max] + rules.kit.EPS) {
            const fields = rules.types[r.type].fields, label = k => fields.find(f => f.key === k).label;
            add("limits", r, where + label(min) + " (" + values[min] + ") exceeds " + label(max) + " (" + values[max] + ").");
          }
        }
      };
      check(r, "");
      if (r.type === "diffPairsRouting") for (const [layer, row] of Object.entries(r.layers || {})) check({...r, ...row}, layer + " · ");
    }
    if (board) {
      const scoped = eligible.filter(r => [r.scope, r.scope2].some(s => !rules.kit.allScope(s)));
      // With overlapping limits throughout both books, no geometry is needed.
      function envelope(type, min, max) {
        let lower=-Infinity, upper=Infinity;
        for (const r of compiled.byType[type]) if (!r.impedanceProfile) {
          for (const row of [r,...Object.values(r.layers || {})]) {
            if (row[min] != null) lower=Math.max(lower,row[min]);
            if (row[max] != null) upper=Math.min(upper,row[max]);
          }
        }
        return {lower,upper};
      }
      const disjoint=(a,b)=>a.lower>b.upper || b.lower>a.upper;
      const possibleJoint=disjoint(envelope("viaStyle","holeMin","holeMax"),envelope("holeSize","min","max")) ||
        disjoint(envelope("width","min","max"),envelope("diffPairsRouting","widthMin","widthMax"));
      if (scoped.length || possibleJoint) {
        const geo = geometry || rules.kit.extract(board, defs);
        if (scoped.length) {
          // A name mentioned only by an unused class is not a board object.
          const lists = rules.kit.scopeObjects(board, defs, null, geo);
          localCoverage(scoped, lists, project, board, add, budget);
        }
        if (possibleJoint) jointLimits(compiled, geo, add);
      }
    }
    return {hints, limited:budget.limited};
  }
  function jointLimits(compiled, geo, add) {
    // Only independent checks apply together. Compare their winning rules on the
    // same actual feature, with the same lookup objects as DRC. Profiles can replace
    // these numeric ranges per rigid-flex region, so leave profiled comparisons open.
    const seen = new Set(), eps = R().kit.EPS;
    const priority = new Map(compiled.set.list.map(r => [r.id,r.priority]));
    const incomplete = new Map();
    for (const d of compiled.diagnostics) {
      incomplete.set(d.type, Math.min(incomplete.get(d.type) ?? Infinity, priority.get(d.ruleId) ?? -Infinity));
    }
    function winner(type, subject) {
      const rule = compiled.first(type,subject);
      if (!rule || (incomplete.get(type) ?? Infinity) <= rule.priority) return null;
      // The runtime's true-only matcher skips indeterminate subjects. An
      // earlier indeterminate scope cannot certify this rule as the winner.
      for (const candidate of compiled.byType[type]) {
        if (candidate === rule) return rule;
        if (subjectResult(candidate,"scope",subject) !== false) break;
      }
      return null;
    }
    function compare(a, ar, b, br, measure, example) {
      if (!a || !b || a.impedanceProfile || b.impedanceProfile) return;
      for (const [loRule, lo, hiRule, hi] of [[a,ar[0],b,br[1]],[b,br[0],a,ar[1]]]) {
        if (lo == null || hi == null || lo <= hi + 2*eps) continue;
        const key = JSON.stringify([loRule.id,hiRule.id,measure,lo,hi]);
        if (seen.has(key)) continue;
        seen.add(key);
        add("limits", loRule, example + " must satisfy both rules. " + loRule.name + " requires " + measure +
          " of at least " + lo + " mm and " + hiRule.name + " permits at most " + hi + " mm.", [hiRule]);
      }
    }
    if (compiled.byType.viaStyle.length && compiled.byType.holeSize.length) {
      const holes = new Map(geo.holes.map(h => [h.item,h]));
      for (const v of geo.vias) {
        const hole=holes.get(v.item); if (!hole) continue;
        const a=winner("viaStyle",v), b=winner("holeSize",hole);
        compare(a,[a?.holeMin,a?.holeMax],b,[b?.min,b?.max],"a hole diameter","Via " + (v.net || v.id));
      }
    }
    if (compiled.byType.width.length && compiled.byType.diffPairsRouting.length && compiled.pairs.size) for (const t of geo.tracks) {
      const pair = compiled.pairOfNet.get(t.net); if (!pair || !(t.width > 0) || t.points.length < 2) continue;
      const layer = t.item.layer || "Top", idx = R().kit.copperIndex(layer);
      const a = winner("width",t), b = winner("diffPairsRouting",{net:pair.positive, pair:pair.name, layer, span:idx == null ? null : [idx,idx]});
      const row = {...b, ...b?.layers?.[layer]};
      compare(a,[a?.min,a?.max],b,[row.widthMin,row.widthMax],"a track width",t.net + " on " + layer);
    }
  }
  return {analyze};
})();
