"use strict";
// DRC waivers: violations a reviewer has accepted, saved with the board (doc.drcWaivers).
//
// Since the unified checks (docs/design/unified-rules-and-checks.md §2.5) this is the board-side alias
// of app/waivers.js (AtriumWaivers), which holds the model; the API below is unchanged.
// Context menu on a DRC marker › Waive… stores a waiver: the rule (type and name), the IDs of the
// objects, an optional note, a signature of each object and, for a measured violation, the value
// waived. It holds while the value is no worse ("while-not-worse"; one of an unmeasured violation holds
// "until-changed": while its objects keep their signature).
// A waived violation is hidden from the board markers and the violation counts; Messages lists it in
// a collapsible "Waived (N)" group, and DRC reports and exports keep it, marked waived. A waiver that
// no longer holds is never removed behind the user's back: it turns stale (the violation shows
// again) until the user keeps, re-waives or removes it ("Ignore Until Next Check" stays the
// session-only alternative).
//
// Headless API (pure; no DOM):
//   add(doc, violation, {note, holds}) -> waiver (call inside edit() for undo)
//   remove(doc, id | [ids])       -> number removed
//   list(doc)                     -> waivers, each with current (objects unchanged), holds and state
//   split(doc, violations)        -> {active, waived:[{violation, waiver}]}
//   stale(doc, violations?)       -> waivers that no longer hold; prune(doc, violations?) removes them (explicitly)
//   canWaive(violation)           -> true when the violation names an object
//   reportSection(waived, unit)   -> HTML section for a DRC report
globalThis.AtriumDRCWaivers = (() => {
  const W = () => globalThis.AtriumWaivers, NOTE = 500;
  const ids = v => [...new Set([v?.id, v?.otherId].filter(x => typeof x === "string" && x))].sort();
  const signature = item => W().signature(item, "pcb");
  function canWaive(v) {return !!v && !!v.type && ids(v).length > 0;}
  const all = doc => Array.isArray(doc?.drcWaivers) ? doc.drcWaivers.filter(w => W().validBoard(w)) : [];
  const scope = doc => ({documents:[doc]});
  function add(doc, v, {note = "", holds} = {}) {
    if (!doc || doc.kind !== "pcb") throw Error("Waivers belong to a PCB layout.");
    if (!canWaive(v)) throw Error("This violation names no object, so it cannot be waived. Ignore Until Next Check hides it for this session.");
    return W().waive(scope(doc), v, {note, holds, doc});
  }
  function remove(doc, which) {return Array.isArray(doc?.drcWaivers) ? W().remove(scope(doc), which) : 0;}
  // Each waiver as saved, plus current (every object unchanged), holds and state (holds / stale / unused
  // against the given violations; without them, only what the objects say).
  function list(doc, violations) {
    const P = scope(doc), m = W().match(P, violations || [], {doc}), recs = new Map(m.records.map(r => [r.id, r]));
    return all(doc).map(w => {
      const r = recs.get(w.id), current = w.objects.every(id => doc.items.some(i => i.id === id && signature(i) === w.geometry[id]));
      // type and rule: what the MCP drc_waivers tool has always listed (the rule type, from the check id).
      return {...w, type:String(w.check || "").replace(/^layout\./, ""), rule:w.rule ?? "", current, holds:r?.holds || "until-changed", state:m.states.get(w.id) || "stale"};
    });
  }
  // Violations that name a waived object are matched; the rest stay active without being looked at again.
  function split(doc, violations) {
    const ws = all(doc);
    if (!ws.length) return {active:violations, waived:[]};
    const named = new Set(ws.flatMap(w => w.objects)), candidates = violations.filter(v => canWaive(v) && (named.has(v.id) || named.has(v.otherId)));
    if (!candidates.length) return {active:violations, waived:[]};
    const m = W().match(scope(doc), candidates, {doc}), hit = new Map(m.waived.map(x => [x.violation, x.waiver]));
    const active = [], waived = [];
    for (const v of violations) { const w = hit.get(v); if (w) waived.push({violation:v, waiver:w}); else active.push(v); }
    return {active, waived};
  }
  function stale(doc, violations) {
    if (!all(doc).length) return [];
    const m = W().match(scope(doc), violations || [], {doc}), gone = new Set(m.stale.map(r => r.id));
    return all(doc).filter(w => gone.has(w.id));
  }
  // Removes stale and malformed waivers: only on an explicit request (Remove Stale Waivers), never after an edit.
  function prune(doc, violations) {
    if (!Array.isArray(doc?.drcWaivers)) return [];
    const bad = new Set(stale(doc, violations).map(w => w.id)), gone = doc.drcWaivers.filter(w => !W().validBoard(w) || bad.has(w.id));
    if (gone.length) {doc.drcWaivers = doc.drcWaivers.filter(w => !gone.includes(w)); if (!doc.drcWaivers.length) delete doc.drcWaivers;}
    return gone;
  }
  // A result without its waived violations (counts per rule and the total follow), plus the waived list.
  function apply(doc, result) {
    const {active, waived} = split(doc, result.violations || []);
    if (!waived.length) return {result, waived};
    const less = new Map();
    for (const {violation:v} of waived) less.set(v.ruleId, (less.get(v.ruleId) || 0) + 1);
    const rules = (result.rules || []).map(r => less.has(r.id) ? {...r, count:Math.max(0, r.count - less.get(r.id))} : r);
    return {result:{...result, violations:active, rules, total:Math.max(0, (result.total ?? active.length + waived.length) - waived.length), waived:waived.length}, waived};
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"})[c]);
  function reportSection(waived, unit = "mm") {
    if (!waived.length) return "";
    const fmt = x => (Math.round(x * 1000) / 1000).toFixed(3);
    const at = v => v.at ? fmt(unit === "mil" ? v.at[0] / .0254 : v.at[0]) + ", " + fmt(unit === "mil" ? v.at[1] / .0254 : v.at[1]) : "";
    return "<h2>Waived violations <small>(" + waived.length + ")</small></h2><p class=meta>Accepted by a reviewer and saved with the board; not counted above. A waiver holds while the measured value is no worse (or, for an unmeasured one, while its objects are unchanged).</p>" +
      "<table><thead><tr><th>Rule</th><th>Objects</th><th>Note</th><th>Waived</th><th>Location (" + unit + ")</th></tr></thead><tbody>" +
      waived.map(({violation:v, waiver:w}) => "<tr><td>" + esc(v.ruleName || v.type) + " <small>(waived)</small></td><td>" + esc(v.title) + "</td><td>" + esc(w.note) + "</td><td>" + esc(w.created) +
        "</td><td class=n>" + esc(at(v)) + "</td></tr>").join("") + "</tbody></table>";
  }

  // ------------------------------------------------------------------ UI (editor only)
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  // Waive… on a marker: a note, then one undoable edit.
  function waiveDialog(host, v, done) {
    const doc = host.doc();
    if (!canWaive(v)) {host.info("This violation names no object, so it cannot be waived. Ignore Until Next Check hides it for this session."); return null;}
    const S = globalThis.AtriumShell, R = globalThis.AtriumRules;
    const rule = (v.ruleName || R?.types?.[v.type]?.title || v.type);
    const commit = note => {
      try {host.edit(() => add(doc, v, {note}));} catch (e) {host.info(e.message); return false;}
      done?.();
      host.info("Waived: " + rule + ". Saved with the board; listed under Waived in Messages. It holds while the value is no worse; otherwise it is listed for review.");
      return true;
    };
    if (!S?.dialog || typeof document === "undefined") return commit("");
    const label = el("label", "Note (optional)", "drc-waive-label"), note = el("textarea", null, "drc-waive-note");
    note.rows = 3; note.maxLength = NOTE; note.placeholder = "Why this violation is acceptable, e.g. checked with the fab";
    label.append(note);
    return S.dialog({title:"Waive Violation", className:"drc-waive-dialog", body:[
      el("p", rule + " · " + (v.title || "")), label,
      el("p", "The waiver is saved with the board. The violation leaves the markers and counts and is listed under Waived in Messages and in DRC reports. It holds while the measured value is no worse; if it gets worse or its objects are deleted, the waiver turns stale and is listed for review. It is never removed without you.", "side-note")],
      actions:[{label:"Cancel"}, {label:"Waive", primary:true, run:() => commit(note.value.trim())}]});
  }
  // DRC Waivers…: every waiver on the board with its state; Keep (re-baseline) for a stale one, Remove, Remove Stale.
  function manage(host, done) {
    const doc = host.doc(), S = globalThis.AtriumShell, V = globalThis.AtriumDRCView;
    if (doc.kind !== "pcb") {host.info("Open a PCB layout to see its DRC waivers."); return null;}
    const shownNow = (V?.violations?.(doc.id) || []).concat((V?.waived?.(doc.id) || []));
    const rows = list(doc, shownNow), staleRows = rows.filter(w => w.state === "stale");
    if (!S?.dialog || typeof document === "undefined") {host.info(rows.length + " DRC waiver" + (rows.length === 1 ? "" : "s") + " on this board" + (staleRows.length ? ", " + staleRows.length + " to review." : ".")); return null;}
    const body = [];
    const STATE = {holds:"holds", stale:"stale: review it", unused:"unused (the violation is gone)"};
    if (!rows.length) body.push(el("p", "No violations are waived on this board. Right-click a DRC marker and choose Waive… to accept one."));
    else {
      const ul = el("ul", null, "drc-waiver-list");
      for (const w of rows) {
        const li = el("li", null, "drc-waiver"), text = el("span", (w.rule || globalThis.AtriumChecks?.title?.(w.check) || w.check) + " · " + (w.title || w.objects.join(", ")) + (w.note ? " · " + w.note : "") + " (" + STATE[w.state] + ")");
        li.dataset.state = w.state;
        if (w.state === "stale") {
          const k = el("button", "Keep"); k.type = "button"; k.title = "Waive it again at today's value";
          k.onclick = () => {
            const v = shownNow.find(x => { const u = globalThis.AtriumChecks?.fromDRC?.(x, doc.id); return !!u && (u.key === w.key || u.keys?.includes(w.key)); });
            try {host.edit(() => W().keep(scope(doc), w.id, v));} catch (e) {host.info(e.message); return;}
            li.dataset.state = "holds"; k.remove(); done?.(); host.info("Waiver kept at today's value.");
          };
          li.append(text, k);
        } else li.append(text);
        const b = el("button", "Remove"); b.type = "button";
        b.onclick = () => {host.edit(() => remove(doc, w.id)); li.remove(); done?.(); host.info("Waiver removed: the violation is checked again.");};
        li.append(b); ul.append(li);
      }
      body.push(ul);
    }
    return S.dialog({title:"DRC Waivers", className:"drc-waivers-dialog", body, actions:[
      ...(staleRows.length ? [{label:"Remove Stale (" + staleRows.length + ")", run:() => {host.edit(() => remove(doc, staleRows.map(w => w.id))); done?.(); host.info("Stale waivers removed.");}}] : []),
      ...(rows.length ? [{label:"Remove All", run:() => {host.edit(() => remove(doc, rows.map(w => w.id))); done?.(); host.info("All DRC waivers removed.");}}] : []),
      {label:"Close", primary:true}]});
  }

  return Object.freeze({add, remove, list, split, apply, stale, prune, canWaive, reportSection, signature, waiveDialog, manage});
})();
