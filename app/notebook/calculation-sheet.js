"use strict";

globalThis.AtriumCalculationSheet = (() => {
  const G = globalThis, records = () => G.AtriumCalculationRecords, calc = () => G.AtriumCalculations;
  const actions = () => G.AtriumCalculationActions, nextId = () => G.Atrium.id();
  const element = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const button = (text, run) => G.AtriumUI.nativeButton(text,null,null,null,{run});
  const coordinate = p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) < 1e8);
  const label = (parent, title, input) => {
    const l = element("label");
    if (input.matches("input,textarea,select")) input.classList.add("ui-field");
    l.append(element("span",title),input); parent.append(l);
    return input;
  };
  const error = text => { throw Error(text); };
  const frozenTarget = () => error("The sheet or selection changed. Review the current calculation again.");
  const locks = text => error(text || "The sheet is read-only.");
  const live = new WeakMap();

  function recordOf(snapshot, item, documentId, instanceId) {
    if (snapshot?.blockId === item.id && snapshot.documentId === documentId) return snapshot;
    if (!snapshot?.records?.length) return null;
    return records().indexEvaluations(snapshot,instanceId).get(item.id);
  }
  function request(host, doc, item, update) {
    const signal = G.AtriumLabs?.notebookSignal();
    if (signal?.aborted) return null;
    const project = host.project(), revision = host.revision(), instanceId = actions().activeInstance(host,doc);
    const opts = {documentId:doc.id,blockId:item.id,instanceId,revision,host};
    const cached = recordOf(calc().peek(project,opts),item,doc.id,instanceId);
    if (cached) return cached;
    let states = live.get(project);
    if (!states) {
      states = {items:new WeakMap(),pending:new Set()}; live.set(project,states);
      calc().listen(project,revision => {
        if (revision !== undefined) return;
        for (const controller of states.pending) controller.abort();
        states.items = new WeakMap();
        if (host.project() !== project) return;
        const visible = new Set(host.panes?.().map(pane => pane.docId) ?? [host.doc()?.id]);
        for (const doc of project.documents) if (visible.has(doc.id) && doc.kind === "schematic" && doc.items.some(item => item.calculation))
          host.invalidateDocument?.(doc.id,true);
      });
    }
    let instances = states.items.get(item);
    if (!instances) states.items.set(item,instances = new Map());
    const key = instanceId ?? doc.id, other = instances.get(key);
    if (other?.revision === revision && !other.controller.signal.aborted) { if (update && !other.record) other.updates.add(update); return other.record; }
    other?.controller.abort();
    const controller = new AbortController(), state = {revision,controller,updates:new Set(update ? [update] : [])};
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, {once:true});
    instances.set(key,state); states.pending.add(controller);
    const active = () => !controller.signal.aborted && host.project() === project && host.revision() === revision && instances.get(key) === state;
    Promise.resolve(calc().evaluate(project,{...opts,signal:controller.signal})).then(snapshot => {
      if (!active()) return;
      state.record = recordOf(snapshot,item,doc.id,instanceId);
      for (const fn of state.updates) fn(state.record);
      state.updates.clear();
      host.invalidateDocument?.(doc.id,true);
    }, e => {
      if (!active()) return;
      state.record = {result:{ok:false,diagnostic:{message:e.message || "Calculation unavailable"}}};
      for (const fn of state.updates) fn(state.record);
      state.updates.clear();
      host.invalidateDocument?.(doc.id,true);
    }).finally(() => {states.pending.delete(controller); signal?.removeEventListener("abort", stop);});
    return null;
  }
  function draw(ctx, item, o = {}) {
    let evaluated = o.evaluated;
    if (!o.frozen && !evaluated && G.AtriumNavHost && o.doc) evaluated = request(G.AtriumNavHost,o.doc,item);
    return G.AtriumCalculationDisplay.draw(ctx,item,evaluated,o);
  }
  function commit(host, project, doc, label, write, touched) {
    if (host.project() !== project || host.doc() !== doc) frozenTarget();
    if (!actions().writable(project,doc,host)) locks();
    let committed = false;
    host.edit(() => {write(); committed = true;},label,touched);
    if (!committed) locks();
  }
  function insert(host, answer, context) {
    const target = actions().target(answer,context,host);
    if (!target || !coordinate(context.point)) frozenTarget();
    const {doc,project} = target;
    const [x,y] = context.point.map(n => Math.round(n*1e6)/1e6);
    const block = records().backing({id:nextId(),x,y,source:answer.source,bindings:structured(answer.bindings || []),
      assertions:[],...(answer.functions ? {functions:structured(answer.functions)} : {})});
    if (!records().valid(block)) error("The calculation contains an invalid binding.");
    commit(host,project,doc,"Insert calculation",() => {doc.items.push(block); if (block.calculation.primaryAssertionId) calc().syncRules(project);},[block]);
    host.select?.([block.id],block.id);
    return {status:"inserted",blockId:block.id};
  }
  const structured = a => JSON.parse(JSON.stringify(a));
  function modal(title) {
    const dlg = element("dialog",null,"calculation-dialog"), h = element("h2",title);
    dlg.setAttribute("aria-label",title); dlg.append(h);
    return dlg;
  }
  function show(dlg, actions, initialFocus) {
    const previous = document.activeElement, [title, ...body] = [...dlg.children].slice(0,-1);
    G.AtriumUI.openDialog(dlg, {title, body, actions, initialFocus, onClose:() => {
      if (previous?.isConnected) previous.focus();
    }});
  }
  function applyReview(answer, context, host) {
    const initial = actions().target(answer,context,host);
    if (!initial?.selected) frozenTarget();
    let {doc,project} = initial, {item,field} = initial.selected, before = item.value;
    const dlg = modal("Apply calculation to " + item.ref), text = element("p"), snap = element("select");
    for (const v of ["Use calculated value","E3","E6","E12","E24","E48","E96","E192"]) snap.add(new Option(v,v));
    const notice = element("p",null,"calculation-status"); notice.setAttribute("role","status");
    const preview = element("output"); dlg.append(text); label(dlg,"Preferred value",snap); label(dlg,"New Value",preview); dlg.append(notice);
    const footer = element("footer"), cancel = button("Cancel",() => dlg.close());
    let accepted = answer, serial = 0, value;
    const update = () => {
      const n = accepted.result.value / field.scale;
      value = String(n) + " " + field.unit;
      text.textContent = (doc.name || "Sheet") + " · " + item.ref + " · current Value " + before;
      preview.textContent = accepted.result.display === value ? value : accepted.result.display + "  (" + value + ")";
    };
    return new Promise(resolve => {
      let result = {status:"cancelled"};
      const apply = button("Apply value",() => {
        try {
          const trusted = calc().resolvePaletteAnswer(accepted), t = trusted && actions().target(trusted,context,host);
          if (!t?.selected || t.project !== project || t.doc !== doc || t.selected.item.id !== item.id ||
            t.selected.item.value !== before || t.selected.field.unit !== field.unit) frozenTarget();
          if (before === value) { result = {status:"unchanged",itemId:item.id}; dlg.close(); return; }
          commit(host,project,doc,"Apply calculation to " + item.ref,() => {t.selected.item.value = value;},[t.selected.item]);
          result = {status:"applied",itemId:item.id,value}; dlg.close();
        } catch (e) {notice.textContent = e.message; apply.disabled = true; refresh.hidden = false;}
      });
      const refresh = button("Review current selection",async () => {
        const id = ++serial, current = host.doc(), currentProject = host.project(), selection = host.selection();
        const refreshed = {...context,docId:current.id,selection};
        try {
          refreshed.instanceId = actions().activeInstance(host,current);
          const next = await calc().answer({queryId:nextId(),text:answer.source,bindings:answer.bindings,documentId:current.id,
            projectRevision:host.revision(),selection,instanceId:refreshed.instanceId},{project:currentProject,host});
          if (!dlg.open || id !== serial) return;
          const t = next && actions().target(next,refreshed,host);
          if (!t?.selected) error("Select one editable part with a compatible Value.");
          answer = accepted = next; context = refreshed; doc = t.doc; project = t.project;
          ({item,field} = t.selected); before = item.value; snap.selectedIndex = 0;
          dlg.querySelector("h2").textContent = "Apply calculation to " + item.ref;
          update(); notice.textContent = "Review the updated value before applying."; refresh.hidden = true; apply.disabled = false;
        } catch (e) {if (dlg.open && id === serial) notice.textContent = e.message;}
      });
      refresh.hidden = true;
      const changed = () => {
        if (actions().target(accepted,context,host)?.selected?.item === item) return;
        ++serial; refresh.hidden = false; apply.disabled = true;
        notice.textContent = "The design or selection changed. Review the current target and value.";
      };
      const stops = ["change","selection","document","replace"].map(k => host.on?.(k,changed));
      snap.addEventListener("change",async () => {
        const id = ++serial; apply.disabled = true;
        if (!snap.selectedIndex) {accepted = answer; update(); apply.disabled = false; notice.textContent = ""; return;}
        const series = snap.value, input = String(answer.result.value / field.scale) + " " + field.unit;
        try {
          const next = await calc().answer({queryId:nextId(),text:"nearest " + series + " " + input,documentId:doc.id,
            projectRevision:answer.projectRevision,selection:[item.id],instanceId:answer.instanceId},{project,host});
          if (!dlg.open || id !== serial) return;
          if (!next?.result?.ok || !actions().target(next,context,host)?.selected) frozenTarget();
          accepted = next; update(); notice.textContent = series + " preferred value"; apply.disabled = false;
        } catch (e) {if (id === serial && dlg.open) notice.textContent = e.message;}
      });
      dlg.addEventListener("close",() => {++serial; for (const stop of stops) stop?.(); resolve(result);},{once:true});
      apply.classList.add("is-primary");
      footer.append(cancel,refresh,apply); dlg.append(footer); update(); show(dlg,footer,apply); apply.focus();
    });
  }
  function applyPaletteAnswer(answer, action, context = {}, host = context.host || G.AtriumNavHost) {
    const trusted = calc().resolvePaletteAnswer(answer);
    if (!["insert","apply"].includes(action) || !trusted || !actions().eligibleActions(trusted,context,host).includes(action)) frozenTarget();
    return action === "insert" ? insert(host,trusted,context) : applyReview(trusted,context,host);
  }
  function details(parent, host, doc, record, evaluated) {
    parent.replaceChildren();
    const info = records().summary(record,evaluated), output = element("output",info.value);
    output.setAttribute("aria-label","Calculation result"); parent.append(output);
    const result = evaluated?.result;
    if (result?.ok && result.worst && (result.worst.min !== result.worst.max || result.rss === null)) {
      const more = element("details"), header = element("summary","Tolerance");
      const fmt = n => G.AtriumCalculationCore.format({...result,kind:"quantity",preferred:undefined,value:n},record.displayUnit);
      more.append(header,element("p","Worst case: " + fmt(result.worst.min) + " – " + fmt(result.worst.max)),
        element("p",result.rss == null ? "RSS unavailable" : "RSS: ±" + fmt(result.rss) + " (independent inputs, linear approximation)"));
      parent.append(more);
    }
    for (const msg of info.warnings) parent.append(element("p",msg,"calculation-warning"));
    for (const clause of info.states) {
      const line = element("p",clause.label + " · " + clause.source);
      line.dataset.calculationClause = clause.id; line.tabIndex = -1;
      if (clause.warnings.length) line.append(element("small",clause.warnings.join(" · ")));
      parent.append(line);
    }
    const inputs = element("div",null,"calculation-inputs");
    const occurrences = new Map((record.bindings || []).map(b=>[b.span.join(":"),b]));
    for (const input of evaluated?.inputs || []) if (!occurrences.has(input.span.join(":"))) occurrences.set(input.span.join(":"),input);
    for (const b of [...occurrences.values()].sort((a,b)=>a.span[0]-b.span[0])) {
      const field = b.target && G.AtriumNoteFields?.resolve(host.project(),doc,b.name,b.target,{instanceId:b.target.instanceId});
      const box = element("details"), title = element("summary",field?.label || b.name,"ui-disclosure-card"), source = host.docById?.(field?.docId);
      const content = element("div",null,"calculation-input-detail");
      const input = evaluated?.inputs?.find(r => r.id === b.id || r.target?.itemId && r.target.itemId === b.target?.itemId && r.target.field === b.target?.field);
      const defaultTolerance = input?.field?.toleranceSource === "default" ? input.field.tolerance?.relative : null;
      const fragments = field && !field.broken ? [String(field.raw ?? field.text),field.defaultUnit,
        field.tolerance != null ? String(field.tolerance) : defaultTolerance != null ? "±"+defaultTolerance*100+"% (default)" : "Tolerance unknown",
        source?.name] : ["Missing reference", b.name];
      content.append(element("p",fragments.filter(Boolean).join(" · ")));
      if (field && !field.broken) content.append(button("Go to source",() => G.AtriumNoteFields.follow(host,field)));
      title.setAttribute("aria-label","Input " + (field?.label || b.name));
      box.addEventListener("pointerenter",event => {if (event.pointerType === "mouse") box.open = true;});
      box.addEventListener("pointerleave",event => {if (event.pointerType === "mouse" && !box.contains(document.activeElement)) box.open = false;});
      let pressedOpen;
      title.addEventListener("pointerdown",event => {
        if (event.pointerType === "touch" || event.pointerType === "pen") {pressedOpen = box.open; box.open = true;}
      });
      title.addEventListener("pointercancel",() => {
        if (pressedOpen !== undefined) box.open = pressedOpen;
        pressedOpen = undefined;
      });
      title.addEventListener("click",event => {
        if (pressedOpen === undefined) return;
        event.preventDefault(); box.open = !pressedOpen; pressedOpen = undefined;
      });
      title.addEventListener("focus",() => {box.open = true;});
      box.append(title,content); inputs.append(box);
    }
    if (inputs.childElementCount) parent.append(inputs);
  }
  function inspector(parent, item, host = G.AtriumNavHost) {
    const doc = host.doc(), record = records().read(item), readout = element("div",null,"calculation-inspector");
    const refresh = evaluated => {if (readout.isConnected) details(readout,host,doc,record,evaluated);};
    const edit = button("Edit calculation",() => compose(host,item));
    edit.disabled = !actions().writable(host.project(),doc,host) || !!item.locked;
    parent.append(readout,edit);
    refresh(request(host,doc,item,refresh));
  }

  function compose(host = G.AtriumNavHost, existing = null, context = {}) {
    if (G.AtriumLabs?.notebookEnabled() === false) return false;
    const project = host.project(), doc = host.doc(), revision = host.revision(), selection = host.selection();
    const instanceId = context.instanceId ?? actions().activeInstance(host,doc);
    if (!actions().writable(project,doc,host) || existing?.locked) locks();
    const record = existing ? records().read(existing) : {id:nextId(),source:context.source || "",bindings:[],assertions:[]};
    const dlg = modal(existing ? "Edit calculation" : "Place calculation");
    const formula = element("textarea"); formula.rows = 3; formula.value = record.source; formula.spellcheck = false;
    if (record.primaryAssertionId) formula.dataset.calculationClause = record.primaryAssertionId;
    label(dlg,"Expression",formula);
    const selected = selection.map(id => doc.items.find(i => i.id === id)).filter(i => i?.kind === "part");
    const refs = element("div",null,"calculation-inputs"); dlg.append(refs);
    let draftBindings = record.bindings, draftSource = record.source;
    const choices = [];
    for (const part of selected) refs.append(button("Insert " + part.ref,() => {
      const start = formula.selectionStart;
      formula.setRangeText(part.ref,start,formula.selectionEnd,"end");
      choices.push({name:part.ref,span:[start,start+part.ref.length],target:{scope:"item",docId:doc.id,itemId:part.id,field:"value",...(instanceId ? {instanceId} : {})}});
      formula.dispatchEvent(new Event("input")); formula.focus();
    }));
    const units = element("input"); units.value = record.displayUnit || ""; label(dlg,"Display unit (optional)",units);
    const clauses = element("div",null,"calculation-clauses"); dlg.append(clauses);
    const clauseRows = [];
    const add = clause => {
      const row = element("div"), input = element("input"); input.value = clause.source; input.placeholder = "assert Vout = 3.3 V ± 2%";
      input.dataset.calculationClause = clause.id;
      label(row,"Assertion",input);
      const model = {input,clause}; clauseRows.push(model);
      row.append(button("Remove assertion",() => {row.remove(); clauseRows.splice(clauseRows.indexOf(model),1);}));
      clauses.append(row); return input;
    };
    for (const clause of record.assertions || []) if (clause.id !== record.primaryAssertionId) add(clause);
    dlg.append(button("Add assertion",() => add({id:nextId(),source:"",bindings:[]}).focus()));
    const note = element("p",null,"calculation-status"); note.setAttribute("role","status");
    const preview = element("output"); preview.setAttribute("aria-label","Expression preview"); dlg.append(preview,note);
    const inputChoices = element("div",null,"calculation-references"); dlg.append(inputChoices);
    function renderChoices(bound) {
      inputChoices.replaceChildren();
      for (const b of bound.references || bound.bindings || []) {
        const edit = element("details"), title = element("summary",b.name + (b.diagnostic ? " · " + b.diagnostic.message : " · Change reference"));
        const search = element("input",null,"ui-field"); search.type = "search"; search.placeholder = "Find a part or field";
        search.setAttribute("aria-label","Find replacement for " + b.name);
        const list = element("div",null,"calculation-inputs");
        const choose = candidate => {
          const target = candidate.binding || candidate.target;
          if (!target) return;
          for (let n = choices.length-1; n >= 0; n--) if (choices[n].span[0] === b.span[0]) choices.splice(n,1);
          choices.push({span:b.span.slice(),target});
          edit.open = false; previewNow(); formula.focus();
        };
        const matches = () => {
          const items = search.value ? G.AtriumNoteFields?.complete(project,doc,search.value,12,{instanceId}) || [] : b.candidates || [];
          list.replaceChildren(...items.map(c => button(c.label || c.expression,() => choose(c))));
        };
        edit.addEventListener("toggle",() => {if (edit.open) {matches(); search.focus();}});
        search.addEventListener("input",matches);
        edit.append(title,AtriumUI.searchField(search,{type:true}),list); inputChoices.append(edit);
      }
    }
    let ticket = 0, timer, controller;
    const previewNow = () => {
      const seq = ++ticket; clearTimeout(timer); controller?.abort(); preview.textContent = "";
      if (!formula.value.trim()) return;
      controller = new AbortController(); const signal = controller.signal;
      timer = setTimeout(async () => {
        try {
          const source = formula.value;
          const bound = await calc().bindSource(project,{source,previousSource:draftSource,bindings:draftBindings,choices,
            documentId:doc.id,instanceId});
          if (seq !== ticket || !dlg.open) return;
          draftSource = source; draftBindings = bound.bindings || []; renderChoices(bound);
          const a = await calc().answer({queryId:nextId(),text:source,bindings:draftBindings,documentId:doc.id,instanceId,projectRevision:revision,selection},
            {signal,project,host});
          if (seq === ticket && dlg.open) preview.textContent = a?.display || a?.message || a?.diagnostic?.message || "";
        } catch (e) {if (!signal.aborted && seq === ticket && dlg.open) preview.textContent = e.message;}
      },100);
    };
    formula.addEventListener("input",previewNow);
    dlg.addEventListener("close",() => {++ticket; clearTimeout(timer); controller?.abort();},{once:true});
    const check = () => {
      if (!dlg.open || project !== host.project() || doc !== host.doc() || revision !== host.revision() ||
        instanceId !== actions().activeInstance(host,doc) ||
        existing && (!doc.items.includes(existing) || existing.locked)) frozenTarget();
      if (!actions().writable(project,doc,host)) locks();
    };
    const save = button(existing ? "Save calculation" : "Insert calculation",async () => {
      save.disabled = true;
      try {
        check();
        const source = formula.value;
        if (!source.trim()) error("Enter an expression.");
        const bind = async (src, prev, picks) => calc().bindSource(project,{source:src,previousSource:prev.source,bindings:prev.bindings,
          documentId:doc.id,instanceId,choices:picks,pinnedFunctions:record.functions});
        const bound = await bind(source,{source:draftSource,bindings:draftBindings},choices);
        const assertions = [], functions = {...bound.functions};
        for (const {input,clause} of clauseRows) {
          const src = input.value.trim();
          if (!src) error("Enter a predicate or remove the empty assertion.");
          const b = await bind(src,clause,[]);
          Object.assign(functions,b.functions);
          assertions.push({id:clause.id,source:src,bindings:b.bindings || []});
        }
        check();
        const pos = context.point || host.pointer?.() || host.view?.()?.screenToWorld?.([host.canvas().clientWidth/2,host.canvas().clientHeight/2]) || [0,0];
        if (!coordinate(pos)) error("Choose a point on the schematic.");
        const draft = {...record,x:existing?.x ?? Math.round(pos[0]*1e6)/1e6,y:existing?.y ?? Math.round(pos[1]*1e6)/1e6,source,bindings:bound.bindings || [],assertions};
        if (Object.keys(functions).length) draft.functions = functions;
        else if (bound.functions) delete draft.functions;
        if (units.value.trim()) draft.displayUnit = units.value.trim(); else delete draft.displayUnit;
        const item = records().backing(draft,existing || {});
        if (!records().valid(item)) error("The calculation contains an invalid binding or assertion.");
        if (existing && JSON.stringify(item) === JSON.stringify(existing)) {dlg.close(); return;}
        commit(host,project,doc,existing ? "Edit calculation" : "Insert calculation",() => {
          if (existing) Object.assign(existing,item); else doc.items.push(item);
          if (item.calculation.primaryAssertionId || assertions.length || record.assertions?.length) calc().syncRules(project);
        },existing ? [existing] : [item]);
        dlg.close(); host.select?.([item.id],item.id);
      } catch(e) {note.textContent = e.message; save.disabled = false;}
    });
    const footer = element("footer"); footer.append(button("Cancel",() => dlg.close()),save); dlg.append(footer);
    dlg.addEventListener("keydown",e => {if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {e.preventDefault(); save.click();}});
    save.classList.add("is-primary"); save.dataset.uiDefault = "false";
    show(dlg,footer,formula); formula.focus(); previewNow(); return dlg;
  }
  function focusAssertion(host,{documentId,blockId,assertionId,instanceId,span,edit} = {}) {
    const doc = host.docById?.(documentId), item = doc?.items.find(i => i.id === blockId);
    if (!records().isBlock(item)) return false;
    if (host.currentId() !== doc.id) host.selectDocument(doc.id);
    if (instanceId) G.AtriumConnectionPreview?.activateInstance?.(doc.id,instanceId);
    host.select([item.id],item.id);
    host.zoomTo?.([item.x,item.y,item.x+item.w,item.y+item.h]);
    const root = edit ? compose(host,item,{instanceId}) : document.getElementById("inspector");
    const field = [...root?.querySelectorAll("[data-calculation-clause]") || []].find(e => e.dataset.calculationClause === assertionId);
    if (field) {field.focus(); if (Array.isArray(span)) field.setSelectionRange?.(span[0],span[1]);}
    return true;
  }
  return Object.freeze({applyPaletteAnswer,compose,draw,inspector,focusAssertion});
})();
