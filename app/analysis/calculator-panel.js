"use strict";
globalThis.AtriumCalculatorPanel = (() => {
  const G = globalThis, C = G.AtriumCalc, Context = G.AtriumCalculatorContext, U = G.Atrium.units;
  const specs = new Map(C.list().map(c => [c.id,c])), calculations = new Map();
  let host, root, controls, observer, listeners = [], job, reader, ruleLoad;
  let current = "track_width", manual = {}, edits = {}, pinned = false, held, live, shown, manualPick = false;
  let formKey, formTarget, outputKey, boardRead, reviewed;
  try {
    const prefs = JSON.parse(localStorage.getItem("atrium-calculators") || "{}");
    if (specs.has(prefs.current)) current = prefs.current;
    if (prefs.values && typeof prefs.values === "object") manual = prefs.values;
  } catch { /* Optional workspace preferences. */ }
  function save() { try { localStorage.setItem("atrium-calculators",JSON.stringify({current,values:manual})); } catch {} }
  function el(tag, text, cls, attrs = {}) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,v);
    return node;
  }
  function build() {
    root = el("section",null,"panel panel-calc",{"aria-labelledby":"calc-heading",tabindex:"-1"});
    const head = el("header",null,"pane-heading calc-head"), heading = el("h2","Calculators",null,{id:"calc-heading"});
    const close = el("button","×","calc-icon",{type:"button","aria-label":"Close Calculators"});
    close.onclick = () => toggle(false);
    head.append(heading,close);
    const tools = el("div",null,"calc-tools"), picker = el("select",null,"calc-pick ui-field",{"aria-label":"Calculator"});
    const groups = new Map();
    for (const c of specs.values()) {
      if (!groups.has(c.group)) { const group = el("optgroup",null,null,{label:c.group}); groups.set(c.group,group); picker.append(group); }
      groups.get(c.group).append(el("option",c.title,null,{value:c.id}));
    }
    const pin = el("button","Pin","calc-button ui-button",{type:"button","aria-label":"Pin calculator","aria-pressed":"false"});
    picker.onchange = () => { current = picker.value; manualPick = true; save(); render(); };
    pin.onclick = () => {
      pinned = !pinned; held = pinned ? shown : null; manualPick = false;
      pin.setAttribute("aria-pressed",String(pinned)); pin.textContent = pinned ? "Pinned" : "Pin";
      // A selection may have changed between the last frame and this click.
      if (pinned) render(); else refresh(true,true);
    };
    tools.append(picker,pin);
    const scroll = el("div",null,"calc-body pane-scroll"), source = el("p",null,"calc-board"),
      out = el("div",null,"calc-out",{"aria-live":"polite"}), proposal = el("div",null,"calc-proposal"),
      summary = el("span"), apply = el("button","Apply","calc-button ui-button",{type:"button"}),
      form = el("form",null,"calc-form"), notes = el("details",null,"calc-notes");
    proposal.append(summary,apply); proposal.hidden = true;
    form.onsubmit = e => e.preventDefault();
    scroll.append(source,out,proposal,form,notes); root.append(head,tools,scroll);
    root.addEventListener("keydown",e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); toggle(false); }
    });
    controls = {picker,pin,source,out,proposal,summary,apply,form,notes};
  }
  function active() {
    if (!root?.isConnected || root.hidden || root.classList.contains("dock-inactive") || document.hidden) return false;
    const side = root.closest("#properties") ? "right" : root.closest("#navigator") ? "left" : null;
    return !side || !document.body.classList.contains("hide-" + side);
  }
  function stopListening() {
    for (const off of listeners) off();
    listeners = []; job?.cancel(); job = null;
    reader = null; boardRead = null; reviewed = null; outputKey = null;
    if (controls) controls.proposal.hidden = true;
  }
  function queue() {
    if (!active()) return;
    job?.cancel();
    if (host.stageEdit) job = host.stageEdit("rules","calculators",() => { job = null; if (active()) refresh(); });
    else { const id = requestAnimationFrame(() => { job = null; if (active()) refresh(); }); job = {cancel:() => cancelAnimationFrame(id)}; }
  }
  function visibility() {
    if (!active()) { if (listeners.length) stopListening(); return; }
    if (listeners.length) return;
    reader = Context.createReader(host);
    const subscribe = (type,fn) => listeners.push(host.on(type,fn));
    for (const type of ["selection","highlight","change","replace","document"]) subscribe(type,queue);
    if (G.AtriumCollabLock?.on) listeners.push(G.AtriumCollabLock.on(event => {
      if (active() && shown && (!event?.doc || event.doc === shown.doc.id || event.doc === shown.board?.id)) compute();
    }));
    refresh(true);
  }
  function sameTarget(a,b) { return !!a && !!b && a.project === b.project && a.doc === b.doc && a.selection === b.selection; }
  function refresh(fresh = false, follow = false) {
    if (!reader) return;
    const next = reader.read({fresh,preferNet:host.highlightSelected()}), changed = !sameTarget(live,next);
    if (next === live && !fresh && !follow) return;
    if (live?.project !== next.project) { held = null; edits = {}; calculations.clear(); }
    if (!pinned && changed) { edits = {}; manualPick = false; }
    live = next;
    if (pinned && (!held || sameTarget(held,next))) held = next;
    shown = pinned ? held : live;
    if (!pinned && !manualPick && shown.facts?.id && (changed || follow || !shown.facts.fields[current])) current = shown.facts.id;
    render();
    if (shown.needsRuleQuery && !G.AtriumDesignQuery && !ruleLoad) {
      ruleLoad = G.AtriumLazy.need("AtriumDesignQuery").then(() => {
        if (active()) refresh(true,true);
      },error => {if (active()) host.info(error.message);}).finally(() => {ruleLoad=null;});
    }
  }
  function boardCtx(view) {
    if (!view.board) return {};
    if (boardRead?.view !== view) {
      const stack = G.AtriumStackup.get(view.board,view.defs);
      boardRead = {view,ctx:{doc:view.board,defs:view.defs,stack,signature:JSON.stringify(stack.layers)}};
    }
    return boardRead.ctx;
  }
  function inputsFor(view) {
    return {...manual[current],...view.facts?.fields[current],...edits[current]};
  }
  function inputText(f,value,unit) {
    if (value == null || value === "") return "";
    return f.unit === "mm" && typeof value === "number" ? String(U.value(value,unit,8)) : typeof value === "number" ? String(+value.toPrecision(7)) : String(value);
  }
  function paintFields(c,layers,unit) {
    const {form,notes} = controls;
    form.replaceChildren();
    for (const f of c.inputs) {
      const id = "calc-" + c.id + "-" + f.key, row = el("label",null,"calc-row",{for:id});
      row.append(el("span",f.label,"calc-label"));
      let input;
      if (f.kind === "choice") {
        input = el("select",null,"ui-field",{id});
        const layerField = ["impedance","via_current"].includes(c.id) && ["layer","from","to"].includes(f.key);
        const source = layerField ? [["",layers.length ? "Default" : "No board"],...layers.map(l => [l.key,l.name || l.key])] : f.choices;
        for (const [value,title] of source) input.append(el("option",title,null,{value}));
        input.disabled = layerField && !layers.length;
      } else {
        const engineering = c.id === "eseries" && f.key === "value";
        input = el("input",null,"ui-field",{id,type:"text",inputmode:engineering ? "text" : "decimal",autocomplete:"off",spellcheck:"false"});
        input.placeholder = inputText(f,f.default,unit);
        const physical=f.key==="rise" && f.unit==="°C"?"Δ°C":f.unit==="oz"?"oz/ft²":f.unit==="W/m·K"?"W/m/K":f.unit;
        const display=physical==="mm"?unit:physical;
        G.AtriumLazy?.numericField?.(input,{unit:display,storageUnit:physical,nanometres:physical==="mm",
          min:f.min,max:f.max,optional:true,
          // This panel updates its calculator immediately on plain native edits.
          nativeInput:raw=>!raw.trim() || Number.isFinite(Number(raw)) || f.unit==="mm" && Number.isFinite(U.parse(raw.replace(",","."),unit))});
      }
      input.dataset.key = f.key;
      input.addEventListener(f.kind === "choice" ? "change" : "input",() => {
        const bound = shown.facts?.fields[current], local = !!bound && Object.hasOwn(bound,f.key);
        const store = local ? (edits[current] ||= {}) : (manual[current] ||= {});
        if (!input.value.trim()) {
          if (local) store[f.key] = ""; else delete store[f.key];
        }
        else if (f.unit === "mm") {
          const mm = U.parse(input.value.replace(",","."),unit);
          store[f.key] = Number.isFinite(mm) ? mm : input.value; // Keep partial text visible while typing.
        } else store[f.key] = input.value;
        input.dataset.value = inputText(f,store[f.key],unit);
        if (!local) save();
        compute();
      });
      row.append(input,el("span",f.unit === "mm" ? unit : f.unit || "","calc-unit")); form.append(row);
    }
    notes.replaceChildren(el("summary","Formula and assumptions"),el("pre",c.formula.join("\n"),"calc-formula"));
    for (const [title,items] of [[null,c.assumptions],["Sources",c.sources]]) {
      if (title) notes.append(el("h3",title));
      const list = el("ul"); for (const line of items) list.append(el("li",line)); notes.append(list);
    }
  }
  function render() {
    if (!shown) return;
    const c = specs.get(current), ctx = c.group === "PCB" ? boardCtx(shown) : {}, unit = host.units(), fields = inputsFor(shown);
    const layers = ctx.stack?.layers.filter(G.AtriumStackup.isCopper) || [];
    const key = JSON.stringify([current,unit,layers.map(l => [l.key,l.name])]);
    controls.picker.value = current;
    if (key !== formKey) { formKey = key; paintFields(c,layers,unit); }
    const targetChanged = !sameTarget(formTarget,shown);
    formTarget = shown;
    for (const f of c.inputs) {
      const input = controls.form.querySelector('[data-key="' + f.key + '"]');
      const text = inputText(f,fields[f.key] ?? (f.kind === "choice" ? f.default : null),unit);
      if (input.value !== text && (document.activeElement !== input || targetChanged || input.dataset.value !== text)) input.value = text;
      input.dataset.value = text;
      input.dataset.selection = shown.selection;
      if (f.kind === "number" && f.key === "vref" && fields.vref === 0) { input.value = ""; input.placeholder = "Enter Vref"; }
    }
    const board = shown.board, matched = shown.facts?.fields[current];
    let source = matched ? shown.facts.label : "Manual inputs";
    if (board && ["impedance","via_current","track_width","current_capacity","track_resistance"].includes(current)) {
      source += " · " + (board.name || "Board") + (ctx.stack?.derived ? " (default stack)" : "");
    }
    controls.source.textContent = source;
    compute();
  }
  function evaluate(view) {
    const usesStack = ["impedance","via_current","track_width","current_capacity"].includes(current);
    const ctx = usesStack ? boardCtx(view) : {}, inputs = inputsFor(view);
    const selectedTrack = current === "impedance" ? view.facts?.fields.track_resistance : null;
    const key = JSON.stringify([current,inputs,selectedTrack,ctx.signature]);
    if (calculations.has(key)) return calculations.get(key);
    const result = C.calculate(current,inputs,ctx);
    if (selectedTrack) {
      const physical = C.calculate("track_resistance",selectedTrack);
      result.rows.push(physical.rows[0],physical.rows[1]);
    }
    if (calculations.size >= 12) calculations.delete(calculations.keys().next().value);
    calculations.set(key,result);
    return result;
  }
  function compute() {
    let result, error;
    try {
      const missing = Object.keys(shown.facts?.fields[current] || {}).find(key => edits[current]?.[key] === "");
      if (missing) throw Error("Enter " + specs.get(current).inputs.find(f => f.key === missing).label.toLowerCase() + ".");
      result = evaluate(shown);
    } catch (e) { error = e.message; }
    const unit = host.units(), output = JSON.stringify([unit,result?.rows,result?.warnings,error]);
    if (output !== outputKey) {
      outputKey = output; controls.out.replaceChildren();
      if (error) controls.out.append(el("p",error,"calc-error"));
      else {
        const table = el("table",null,"calc-results");
        for (const r of result.rows) {
          const tr = el("tr",null,r.primary ? "primary" : null);
          const text = r.unit === "mm" && unit === "mil" ? U.value(r.value,unit,4) + " mil" : r.text;
          tr.append(el("th",r.label,null,{scope:"row"}),el("td",text)); table.append(tr);
        }
        controls.out.append(table);
        for (const w of result.warnings) controls.out.append(el("p",w,"calc-warn"));
      }
    }
    reviewed = result && sameTarget(shown,live) && Context.plan(shown,current,result) || null;
    controls.proposal.hidden = !reviewed;
    if (reviewed) {
      const offered = reviewed, signature = inputSignature();
      controls.summary.textContent = offered.text;
      controls.apply.onclick = () => applyReviewed(offered,signature);
    } else controls.apply.onclick = null;
  }
  // Autofill and a focus transition can change a visible control before its input event.
  function inputSignature() { return JSON.stringify(Array.from(controls.form.elements,f => f.value)); }
  function applyReviewed(offered,signature) {
    if (offered !== reviewed || !active() || !reader) return;
    try {
      if (signature !== inputSignature()) {
        controls.proposal.hidden = true; reviewed = null;
        host.info("The inputs changed. Review the updated result.");
        return;
      }
      const now = reader.read({fresh:true,preferNet:host.highlightSelected()});
      if (!sameTarget(now,shown) || JSON.stringify(now.facts) !== JSON.stringify(shown.facts)) throw Error("The selection or design changed. Review the updated result.");
      const next = Context.plan(now,current,evaluate(now));
      if (!next || !G.AtriumProposal.equal(next,offered)) throw Error("The design changed. Review the updated result.");
      const count = G.AtriumProposal.applyChecked(now.project,offered.proposal,{validate:G.Atrium.validate,
        edit:(fn,_label,touched,scope) => host.edit(fn,"Apply calculator result",() => {
          const scopes = touched();
          return scopes?.length ? scopes : [{doc:host.docById(offered.owner)}];
        },scope)});
      if (count) { edits = {}; host.info("Calculator result applied"); }
    } catch (e) { host.info(e.message); }
    refresh(true);
  }
  function toggle(show) {
    if (!root) build();
    const on = show ?? !active();
    root.hidden = !on;
    if (on) {
      if (!root.isConnected) (document.getElementById("properties") || document.body).append(root);
      if (G.AtriumDock) G.AtriumDock.reveal("calculators"); else document.body.classList.remove("hide-right");
      if (!observer) {
        observer = new MutationObserver(visibility);
        observer.observe(root,{attributes:true,attributeFilter:["class","hidden"]});
        observer.observe(document.body,{attributes:true,attributeFilter:["class"]});
        document.addEventListener("visibilitychange",visibility);
      }
      visibility(); controls.picker.focus({preventScroll:true});
    } else {
      stopListening(); observer?.disconnect(); observer = null;
      document.removeEventListener("visibilitychange",visibility); host.canvas()?.focus();
      live = shown = held = formTarget = null; edits = {}; calculations.clear();
    }
    G.AtriumNavCommon?.setChecked("calculators",on);
    return on;
  }
  function open(id) {
    toggle(true);
    if (specs.has(id)) { current = id; manualPick = true; render(); }
    return root;
  }
  G.AtriumNavCommon?.ready(h => { host = h; h.registerAction("calculators",() => toggle()); });
  return {open,toggle};
})();
