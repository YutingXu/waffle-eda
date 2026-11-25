"use strict";
// Design Rule Check panel (Tools › Design Rule Check). The rule engine lives in
// rules.js (AtriumRules.drc) so the MCP runner can use it without the UI. This
// panel lists violations grouped by rule, like Altium's Messages panel, locates
// them on the board and exports an HTML report.
globalThis.AtriumDRC = (() => {
  const R=()=>globalThis.AtriumRules;
  // AtriumDRC.run(board, defs, rules?, options?) — same as AtriumRules.drc.
  const run=(doc,defs,rules,options)=>R().drc(doc,defs,rules,options);

  function prepare(rules) {
    const lazy = globalThis.AtriumLazy;
    if (!globalThis.AtriumDesignQuery && lazy?.needsRuleQuery?.(rules, "pcb"))
      return lazy.need("AtriumDesignQuery");
  }

  function batch(doc, defs, rules, options = {}) {
    const result = run(doc, defs, rules, options);
    if (!R().checkSelected(doc,"clearance",options) || !globalThis.AtriumDRCPours) {
      options.onPours?.([]);
      return result;
    }
    const cap = options.limit ?? 2000, pours = options.onPours ? [] : null;
    let byId, count = 0;
    const checked = globalThis.AtriumDRCPours.verify(doc, defs, rules, {...options, onViolation(v) {
      byId ??= new Map(result.rules.map(rule => [rule.id, rule]));
      const rule = byId.get(v.ruleId);
      if (!rule) return;
      count++;
      if (++rule.count > cap) return;
      if (rule.ruleSet) v.ruleSet = rule.ruleSet;
      result.violations.push(v);
      pours?.push(v);
    }});
    if (checked.pending) {
      result.complete = false;
      result.notes.push("Poured clearance checks are waiting for the design rules.");
    }
    if (pours) options.onPours(pours);
    if (count) {
      result.total += count;
      result.notes.push("Poured copper checked against the Clearance rules: " +
        count + " violation" + (count === 1 ? "" : "s") + ".");
    }
    return result;
  }

  function measure(v,unit){
    const f=x=>R().units.format(x,unit,true);
    if(v.required!=null&&v.actual!=null)return (v.what?v.what+" ":"")+f(v.actual)+(v.limit==="max"?" > ":" < ")+f(v.required)+(v.target!=null?" (target "+f(v.target)+")":"");
    if(v.actual!=null)return (v.detail||"")+" "+f(v.actual);
    return v.detail||"";
  }
  // "Clearance Constraint: (0.15mm < 0.2mm) Between Track (Top Layer) GND ↔ Pad U1-3 (Top Layer) VCC"
  function message(v,unit){
    const type=R().types[v.type],detail=measure(v,unit).trim();
    if(!type)return [v.title,detail].filter(Boolean).join(" · ");
    return type.title+" Constraint: ("+detail+") "+v.title;
  }
  function group(result){
    const byRule=new Map(result.rules.map(r=>[r.id,{rule:r,items:[]}]));
    for(const v of result.violations)byRule.get(v.ruleId)?.items.push(v);
    return [...byRule.values()];
  }

  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  // Self-contained HTML report: summary, rules checked, then violations by rule.
  function report(result,{board="Board",project="",unit="mm",rules=null,ruleSet="",date=new Date()}={}){
    const fmt=x=>R().units.format(x,unit,true),describe=r=>{const full=rules?.list.find(x=>x.id===r.id);return full?R().describe(full,unit):r.description;};
    const rows=result.rules.map(r=>"<tr><td>"+(r.ruleSet?"<small>"+esc(r.ruleSet)+" › </small>":"")+esc(describe(r))+"</td><td class=n>"+r.count+"</td></tr>").join("");
    const sections=group(result).filter(g=>g.rule.count).map(g=>"<h2>"+esc(describe(g.rule))+(g.rule.ruleSet?" <small>· rule set "+esc(g.rule.ruleSet)+"</small>":"")+" <small>("+g.rule.count+")</small></h2><table><thead><tr><th>Objects</th><th>Measured</th><th>Location ("+unit+")</th></tr></thead><tbody>"+
      g.items.map(v=>"<tr><td>"+esc(v.title)+"</td><td>"+esc(measure(v,unit).trim())+"</td><td class=n>"+(v.at?esc(fmt(v.at[0])+", "+fmt(v.at[1])):"")+"</td></tr>").join("")+
      "</tbody></table>"+(g.rule.count>g.items.length?"<p>Only the first "+g.items.length+" violations are listed.</p>":"")).join("");
    return "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Design Rule Check · "+esc(board)+"</title><style>"+
      ":root{color-scheme:light dark;--ink:#1d2125;--muted:#5d666e;--line:#d6dadf;--paper:#fff;--soft:#f2f4f6;--bad:#b42318}"+
      "@media (prefers-color-scheme:dark){:root{--ink:#e2e2e2;--muted:#b0b0b0;--line:#474747;--paper:#1f1f1f;--soft:#2b2b2b;--bad:#ff8a80}}"+
      "body{margin:0;padding:24px;font:13px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);background:var(--paper)}"+
      "h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px}small,.meta{color:var(--muted)}table{border-collapse:collapse;width:100%;margin:6px 0}"+
      "th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--soft);font-weight:600}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}"+
      ".total{font-size:15px;margin:12px 0}.total b{color:"+(result.total?"var(--bad)":"inherit")+"}ul{color:var(--muted)}"+
      "</style></head><body><h1>Design Rule Check</h1><p class=meta>"+esc(project?project+" · ":"")+esc(board)+(ruleSet?" · rule set "+esc(ruleSet):"")+" · "+esc(date.toISOString().replace("T"," ").slice(0,19))+" UTC · units "+unit+"</p>"+
      "<p class=total>Rule violations: <b>"+result.total+"</b></p><table><thead><tr><th>Rule</th><th class=n>Count</th></tr></thead><tbody>"+rows+"</tbody></table>"+
      (result.notes.length?"<ul>"+result.notes.map(n=>"<li>"+esc(n)+"</li>").join("")+"</ul>":"")+sections+"</body></html>";
  }
  return {run,batch,prepare,report,message};
})();
