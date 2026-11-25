"use strict";
// Assertion pointers belong to the ordinary rule book. The calculation worker
// never publishes a finding or mutates a rule.
globalThis.AtriumCalculationChecks = (() => {
  const G = globalThis, TYPE = "ercCalculationAssertion", CHECK = "calculationAssertion";
  const LEVEL = {fatal: "Fatal", error: "Error", warning: "Warning", hint: "Warning"};
  const typeLabels = [["resistor", "calculations.rules.resistor"], ["capacitor", "calculations.rules.capacitor"],
    ["inductor", "calculations.rules.inductor"]];
  const keyOf = (object, assertion) => JSON.stringify([object, assertion]);
  const sameScope = (r, docId) => r.origin.sheet === docId && r.sheets?.length === 1 && r.sheets[0] === docId;
  const AtriumI18n = G.AtriumI18n || {define: literal => (key, a) => literal[key].replace(/\{(\w+)\}/g, (s, k) => a?.[k] ?? s)};
  const t = AtriumI18n.define({
    "calculations.rules.title": "Calculations",
    "calculations.rules.defaults": "Default part tolerances",
    "calculations.rules.defaults_help": "Used when a bound part has no tolerance. Leave a field blank to keep the tolerance unknown.",
    "calculations.rules.resistor": "Resistors (%)",
    "calculations.rules.capacitor": "Capacitors (%)",
    "calculations.rules.inductor": "Inductors (%)",
    "calculations.rules.empty": "No calculation assertions.",
    "calculations.rules.enabled": "Enable {predicate}",
    "calculations.rules.level": "Severity for {predicate}",
    "calculations.rules.enabled_header": "Enabled",
    "calculations.rules.predicate_header": "Predicate",
    "calculations.rules.severity_header": "Severity",
    "calculations.rules.edit_header": "Source",
    "calculations.rules.edit": "Edit predicate…",
    "calculations.rules.assertion": "Calculation assertion",
    "calculations.rules.missing": "The source assertion is missing.",
    "calculations.rules.unavailable": "The assertion could not be evaluated.",
    "calculations.rules.failed": "Fail. Measured {actual}. Required {required}.",
    "calculations.rules.possible": "May violate. Measured {actual}. Required {required}.",
    "calculations.rules.incomplete": "Incomplete. {reason}",
    "calculations.rules.scope_version": "This assertion uses unsupported rule scope version {version}.",
    "calculations.rules.range": "{min} to {max}",
    "calculations.rules.less": "less than {value}",
    "calculations.rules.no_more": "at most {value}",
    "calculations.rules.more": "greater than {value}",
    "calculations.rules.at_least": "at least {value}",
    "calculations.rules.differs": "different from {value}"
  });

  function sourceItems(project) {
    const list = [];
    for (const doc of project?.documents || []) {
      if (doc.kind !== "schematic") continue;
      for (const item of doc.items || []) {
        if (!G.AtriumCalculationRecords?.isBlock(item)) continue;
        const block = G.AtriumCalculationRecords.read(item);
        for (const clause of block.assertions || []) list.push({doc, item, clause});
      }
    }
    return list;
  }

  function syncRules(project) {
    const before = project.rules?.list || [], previous = before.filter(r => r.type === TYPE);
    const authored = sourceItems(project);
    if (!authored.length && !previous.length) return false;
    const old = new Map(previous.map(r => [keyOf(r.origin.object, r.origin.assertion), r]));
    const desired = new Map();
    for (const {doc, item, clause} of authored) {
      const key = keyOf(item.id, clause.id);
      if (desired.has(key)) throw Error("Calculation assertions need unique IDs.");
      const found = old.get(key);
      if (found && sameScope(found, doc.id)) { desired.set(key, found); continue; }
      const origin = {kind: "calculation", sheet: doc.id, object: item.id, assertion: clause.id};
      const entry = found || {id: G.Atrium.id(), type: TYPE, name: t("calculations.rules.assertion"), enabled: true, severity: "error", priority: 1, scope: G.AtriumDesignQueryRecord.selector("all")};
      desired.set(key, {...entry, where: "schematic", sheets: [doc.id], origin});
    }
    if (desired.size === previous.length && previous.every(r => desired.get(keyOf(r.origin.object, r.origin.assertion)) === r)) return false;
    const rules = G.AtriumProjectRules;
    if (!rules) throw Error("Load the project rule book before editing calculation assertions.");
    rules.edit(project, book => { book.list = [...book.list.filter(r => r.type !== TYPE), ...desired.values()]; });
    return true;
  }

  function quantity(value, dims, tag) {
    if (!Number.isFinite(value)) return "—";
    return G.AtriumCalculationCore?.format?.({kind: "quantity", value, dimensions: dims, tag}) ?? String(value);
  }
  function range(q, limits, operator) {
    if (!limits) return "—";
    const dims = q.assertion?.dimensions || q.dimensions, tag = q.tag;
    const min = quantity(limits.min, dims, tag), max = quantity(limits.max, dims, tag);
    const operators = {"<": "calculations.rules.less", "<=": "calculations.rules.no_more", ">": "calculations.rules.more",
      ">=": "calculations.rules.at_least", "!=": "calculations.rules.differs"};
    return limits.min !== limits.max ? t("calculations.rules.range", {min, max})
      : operators[operator] ? t(operators[operator], {value: min}) : min;
  }

  function scopeDiagnostic(rule) {
    if (rule?.type !== TYPE || rule.enabled === false || rule.severity === "off" || !G.AtriumDesignQueryRecord?.isFuture(rule.scope)) return null;
    return {code:"language-version", message:t("calculations.rules.scope_version",{version:rule.scope.languageVersion}),
      span:[0,rule.scope.source.length], side:"scope", ruleId:rule.id, documentId:rule.origin.sheet, objectId:rule.origin.object};
  }

  function findings(project, snapshot, time) {
    if (!snapshot) return [];
    const pointers = new Map(sourceItems(project).map(s => [keyOf(s.item.id, s.clause.id), s])), byRule = new Map();
    for (const r of project.rules?.list || []) {
      if (r.type !== TYPE || r.enabled === false || r.severity === "off") continue;
      byRule.set(keyOf(r.origin.object, r.origin.assertion), r);
    }
    const out = [];
    for (const {documentId, blockId, instanceId, assertions} of snapshot.records) {
      for (const {id, result, inputs} of assertions) {
        const key = keyOf(blockId, id), r = byRule.get(key), source = pointers.get(key);
        if (!r || !source || source.doc.id !== documentId || r.origin.sheet !== documentId) continue;
        const scopeIssue = scopeDiagnostic(r), a = scopeIssue ? null : result?.assertion, status = a?.status || "incomplete";
        if (status === "pass") continue;
        const severity = scopeIssue ? "error" : r.severity || "error", reason = scopeIssue?.message || result?.diagnostic?.message || t("calculations.rules.unavailable");
        const condition = status === "incomplete" ? t("calculations.rules.incomplete", {reason})
          : t(status === "may-violate" ? "calculations.rules.possible" : "calculations.rules.failed",
            {actual: range(result, a.actual), required: range(result, a.required, a.operator)});
        const warnings = scopeIssue ? [] : result?.warnings || [];
        const span = (!scopeIssue && result?.diagnostic?.span) || [0, source.clause.source.length];
        const detail = {status, assertionId: id, instanceId, span, actual: a?.actual, required: a?.required, dimensions: a?.dimensions,
          unit: scopeIssue ? undefined : result?.unit, warnings, inputs: scopeIssue ? [] : (inputs || []).map(p => p.target).filter(Boolean)};
        if (scopeIssue) detail.scopeDiagnostic = scopeIssue;
        const predicate = JSON.stringify([source.clause.source, (source.clause.bindings || []).map(b => [b.name, b.target])]);
        const meaning = G.AtriumChecks?.hash?.(predicate);
        out.push({class: LEVEL[severity] || "Error", source: "Compiler", check: CHECK, severity, ruleId: r.id, ruleName: r.name,
          origin: r.origin, objectId: blockId, documentId, document: source.doc.name, point: [source.item.x, source.item.y],
          sig: JSON.stringify([r.id, blockId, id, instanceId]), meaning, detail, time,
          text: condition + (warnings.length ? " " + warnings.join(". ") + "." : "")});
      }
    }
    return out;
  }

  async function focus(host, addr) {
    const sheet = G.AtriumCalculationSheet || await G.AtriumLazy?.need("AtriumCalculationSheet");
    return sheet?.focusAssertion(host, addr);
  }

  function node(tag, text) { return AtriumNavCommon.el(tag, text); }

  function render(root, {project, rules, defaults, documentId, onChange, onEdit, showDefaults = true}) {
    const sources = new Map(sourceItems(project).map(s => [keyOf(s.item.id, s.clause.id), s]));
    const list = rules.filter(r => r.type === TYPE && (!documentId || r.origin.sheet === documentId));
    if (showDefaults) {
      const section = node("section");
      section.append(node("h3", t("calculations.rules.defaults")), node("p", t("calculations.rules.defaults_help")));
      for (const [kind, label] of typeLabels) {
        const row = node("label"), input = node("input");
        row.className = "work-row";
        input.type = "number"; input.min = "0"; input.step = "any";
        input.value = Number.isFinite(defaults[kind]) ? String(defaults[kind] * 100) : "";
        input.onchange = () => {
          if (input.validity?.badInput || input.validity?.rangeUnderflow) return;
          if (!input.value) delete defaults[kind]; else defaults[kind] = Number(input.value) / 100;
          onChange?.();
        };
        row.append(node("span", t(label)), input);
        section.append(row);
      }
      root.append(section);
    }
    if (!list.length) { root.append(node("p", t("calculations.rules.empty"))); return; }
    for (const doc of project.documents) {
      const entries = list.filter(r => r.origin.sheet === doc.id);
      if (!entries.length) continue;
      const section = node(documentId ? "section" : "details"), table = node("table"), body = node("tbody");
      table.className = "rules-table";
      const header = node("thead"), labels = node("tr");
      for (const key of ["calculations.rules.enabled_header", "calculations.rules.predicate_header", "calculations.rules.severity_header", "calculations.rules.edit_header"]) {
        const label = node("th", t(key));
        label.scope = "col";
        labels.append(label);
      }
      header.append(labels);
      for (const r of entries) {
        const source = sources.get(keyOf(r.origin.object, r.origin.assertion)), predicate = source?.clause.source || t("calculations.rules.missing");
        const tr = node("tr"), enabled = node("input"), level = node("select"), edit = node("button", t("calculations.rules.edit"));
        enabled.type = "checkbox"; enabled.checked = r.enabled !== false;
        enabled.setAttribute("aria-label", t("calculations.rules.enabled", {predicate}));
        enabled.onchange = () => { r.enabled = enabled.checked; onChange?.(); };
        level.setAttribute("aria-label", t("calculations.rules.level", {predicate}));
        for (const [value, label] of [["fatal", "Fatal"], ["error", "Error"], ["warning", "Warning"], ["hint", "Hint"], ["off", "Off"]]) {
          const option = node("option", label);
          option.value = value;
          if ((r.severity || "error") === value) option.setAttribute("selected", "");
          level.append(option);
        }
        level.onchange = () => { r.severity = level.value; onChange?.(); };
        edit.type = "button"; edit.disabled = !source;
        edit.onclick = () => onEdit?.({documentId: doc.id, blockId: r.origin.object, assertionId: r.origin.assertion, edit: true});
        for (const child of [enabled, node("code", predicate), level, edit]) { const cell = node("td"); cell.append(child); tr.append(cell); }
        body.append(tr);
      }
      table.append(header, body); section.append(node(documentId ? "h3" : "summary", doc.name), table); root.append(section);
    }
  }

  return Object.freeze({TYPE, CHECK, syncRules, scopeDiagnostic, findings, focus, render, t});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumCalculationChecks;
