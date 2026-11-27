"use strict";

// Import reports and source bytes belong to the open file session. Undo can return to a
// previous session with the same document IDs. Closing a report tab only closes its view.
globalThis.AtriumImportReports = (() => {
  const t=globalThis.AtriumI18n?.define({
    "import_report.compare_with_original": "Compare with original",
    "import_report.reimport_original": "Re-import original…"
  });
  globalThis.AtriumI18n?.scope(".import-report-actions","import_report");
  const sessions = new WeakMap(), visible = new Map(), sourceRows = new WeakMap();
  let next = 0, host, cachedSnapshot;
  const fileGrants = new WeakMap();
  const views = () => globalThis.AtriumDocViews;
  const state = () => sessions.get(host?.fileSession?.());
  const records = () => state()?.all || [];
  const empty = () => ({all:[], byDocument:new Map(), ruleRows:new Map(), ruleOwners:new Map()});
  function restore(session, value) {
    if (value) sessions.set(session, value);
    else sessions.delete(session);
  }
  const node = (tag, text) => AtriumNavCommon.el(tag, text);
  const label = name => String(name || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, x => x.toUpperCase());
  const term = kind => ({part: "Component", parts: "Components", netlabel: "Net label", sheetsymbol: "Sheet symbol", pad: "Pad", via: "Via", track: "Track"}[kind] || label(kind));
  const statuses = ["kept", "approximated", "dropped"];
  // Source bookkeeping with no Waffle meaning (translators.js notApplicable): shown apart from the losses,
  // in a quiet column only when the report has any. Older reports have no such count.
  const inapplicable = group => group.notApplicable || 0;
  const statusLabel = status => status === "notApplicable" ? "Not applicable" : label(status);
  const standaloneRules = entry => entry?.report?.translator === "altium-rules";
  function recent(id) {
    const store=state(), entry=store?.byDocument.get(id), scope=store?.ruleOwners.get(id);
    if (scope && standaloneRules(entry) && entry.scopeId!==scope) return store.all.find(e=>e.scopeId===scope) || entry;
    return entry || null;
  }
  function indexDocuments(byDocument, entry) {
    for (const id of entry.documents) {
      if (!standaloneRules(entry) || !byDocument.has(id) || standaloneRules(byDocument.get(id))) byDocument.set(id, entry);
    }
  }
  function remember(session, result, documents, names, options = {}) {
    const old = sessions.get(session) || empty(), byDocument = new Map(old.byDocument);
    if (!documents.length) documents = [host.currentId()];
    const originalFiles = result.files || [];
    for (const [i, f] of (result.provenance?.files || []).entries()) {
      if (originalFiles[i]?.name === f.name) fileGrants.set(f, originalFiles[i]);
    }
    const entry = {id: "import-report-" + ++next, scopeId:globalThis.AtriumUUID.next(), documents: [...new Set(documents)], names,
      report: result.report, provenance: result.provenance, adopted:options.adopt !== false};
    indexDocuments(byDocument,entry);
    sessions.set(session, {...old, all:[...old.all, entry], byDocument});
    if(entry.adopted && entry.provenance?.files?.length)session.folder?.markSidecarsDirty?.();
    return entry;
  }
  function referenceText(r) {
    const s = r.source || {};
    const where = [s.file, s.object].filter(v => v != null && v !== "").join(" · ");
    return statusLabel(r.status) + " · " + where + (r.count > 1 ? " × " + r.count : "") + (r.reason ? " — " + r.reason : "");
  }
  function appendBatch(parent, entries, format, size = 40) {
    const list = node("ul"), more = node("button", "Show more");
    more.type = "button";
    globalThis.AtriumUI?.button(more, "secondary");
    const iterator = entries[Symbol.iterator]();
    let next = iterator.next();
    const append = () => {
      for (let i = 0; i < size && !next.done; i++) {
        list.append(node("li", format(next.value)));
        next = iterator.next();
      }
      more.hidden = next.done;
    };
    more.onclick = append;
    parent.append(list, more);
    append();
  }
  let referenceRows = 0;
  function render(box, entry) {
    const {report, names} = entry, totals = {kept: 0, approximated: 0, dropped: 0, notApplicable: 0};
    const quiet = report.kinds.some(inapplicable), shown = quiet ? [...statuses, "notApplicable"] : statuses;
    box.classList.add("import-report");
    const content = node("article");
    content.tabIndex = 0;
    content.setAttribute("aria-label", "Import fidelity report");
    const heading = node("h2", "Import Report"), format = globalThis.AtriumTranslatorRegistry.get(report.translator);
    content.append(heading, node("p", [format?.label || label(report.translator), names.join(", ")].filter(Boolean).join(" · ")));
    if (entry.adopted && ["altium","kicad"].includes(report.translator) && entry.provenance?.files?.length) {
      const actions=node("div"); actions.className="import-report-actions";
      for (const [id,title] of [["compare",t("import_report.compare_with_original")],["open",t("import_report.reimport_original")]]) {
        const button=node("button",title);button.type="button";globalThis.AtriumUI?.button(button,"secondary");
        button.onclick=async()=>{button.disabled=true;try{
          const archive=await globalThis.AtriumLazy.need("AtriumProjectArchiveUI");await archive.useOriginal(entry,id,{host});
        }catch(e){host.info(e.message);}finally{button.disabled=false;}};
        actions.append(button);
      }content.append(actions);
    }
    const warnings = node("section"), table = node("table"), head = node("thead"), columns = node("tr"), body = node("tbody");
    table.append(node("caption", "Translation by object kind"));
    // Fixed layout keeps column widths independent of the reference lists shown below a row.
    const cols = node("colgroup");
    for (const kind of ["kind", ...shown.map(() => "count"), "refs"]) { const col = node("col"); col.className = "import-report-col-" + kind; cols.append(col); }
    table.append(cols);
    if (quiet) table.classList.add("import-report-has-inapplicable");
    for (const name of ["Object kind", ...shown.map(statusLabel), "Source references"]) {
      const h = node("th", name); h.scope = "col"; if (name === "Not applicable") h.className = "import-report-inapplicable"; columns.append(h);
    }
    head.append(columns); table.append(head, body);
    for (const group of report.kinds) {
      const row = node("tr"), title = node("th", term(group.kind)); title.scope = "row"; row.append(title);
      for (const status of shown) {
        const count = group[status] || 0, cell = node("td", String(count));
        totals[status] += count;
        if (status === "notApplicable") cell.className = "import-report-inapplicable";
        else if (count && status !== "kept") cell.className = "import-report-warning";
        row.append(cell);
      }
      const refs = node("td");
      row.append(refs); body.append(row);
      if (group.references.length) {
        // The list opens in a full-width row below so the columns keep their widths.
        const details = node("details"), summary = node("summary", "Show references");
        const expansion = node("tr"), cell = node("td");
        expansion.className = "import-report-references"; expansion.hidden = true;
        cell.colSpan = shown.length + 2; cell.id = "import-report-refs-" + (++referenceRows);
        cell.setAttribute("aria-label", term(group.kind) + " source references");
        summary.setAttribute("aria-label", "Show " + term(group.kind) + " source references");
        summary.setAttribute("aria-controls", cell.id);
        details.append(summary);
        details.ontoggle = () => {
          if (details.open && !cell.childElementCount) appendBatch(cell, globalThis.AtriumTranslatorRegistry.references(group), referenceText);
          expansion.hidden = !details.open;
        };
        refs.append(details); expansion.append(cell); body.append(expansion);
      } else refs.textContent = "—";
    }
    if (totals.approximated || totals.dropped) {
      warnings.className = "import-report-warnings";
      warnings.append(node("h3", "Objects to review"), node("p", [
        totals.approximated ? totals.approximated + " approximated" : "",
        totals.dropped ? totals.dropped + " dropped" : ""
      ].filter(Boolean).join(" · ") + ". Expand source references to locate affected objects."));
      content.append(warnings);
    }
    if (totals.notApplicable) {
      const quietNote = node("p", totals.notApplicable + " source records have no meaning in Waffle, such as Altium identifiers and containers. They are not losses; the original file keeps them.");
      quietNote.className = "import-report-inapplicable"; content.append(quietNote);
    }
    if (report.notes?.length) {
      const notes = node("section");
      notes.append(node("h3", "Translator notes"));
      appendBatch(notes, report.notes, n => typeof n === "string" ? n : n.message || n.reason, 8);
      content.append(notes);
    }
    content.append(table); box.append(content);
  }
  function show(entry) {
    if (!entry) { host?.info?.("This document has no import report."); return; }
    if (!visible.has(entry.id)) visible.set(entry.id, {session:host.fileSession()});
    // The tab names the design without its extension so it fits; the tooltip keeps the file name.
    const name = entry.names[0] || "Design";
    const view = views().open(entry.id, {title: "Import Report · " + name.replace(/\.[A-Za-z0-9]{2,8}$/, ""), tip: "Import Report · " + name, icon: "book",
      mount: box => render(box, entry), onClose: () => visible.delete(entry.id)});
    view.querySelector("article")?.focus({preventScroll: true});
    return view;
  }
  function setSourceRules(doc, rows, source) {
    const session = host.fileSession();
    let owner;
    if (source) {
      const {file,bytes,sha256} = source, name = file.name;
      owner = records().find(e=>standaloneRules(e) && e.documents.includes(doc.id) &&
        e.provenance.files.some(f=>f.name===name && f.sha256===sha256));
      if (!owner) {
        const group = {kind:"source rule record",kept:rows.length,approximated:0,dropped:0,references:[]};
        owner = remember(session,{report:{translator:"altium-rules",kinds:[group]},files:[file],
          provenance:{files:[{name,sha256,bytes,documents:[doc.id]}]}},[doc.id],[name]);
      }
    }
    const store = state() || empty(), ruleRows = new Map(store.ruleRows), ruleOwners = new Map(store.ruleOwners);
    ruleRows.set(doc.id, rows.slice());
    if (owner) ruleOwners.set(doc.id,owner.scopeId);
    sessions.set(session, {...store, ruleRows, ruleOwners});
    session.folder?.markSidecarsDirty?.();
  }
  function provenance() {
    const store = state();
    if (!store) return [];
    const groups = store.all.filter(r=>r.adopted).flatMap(r=>{
      const source=globalThis.AtriumImportSidecars?.exportProvenance(r) ?? r.provenance;
      return r.binding?[r.binding,source]:[source];
    });
    if (store.ruleRows.size) groups.unshift({fields:[...store.ruleRows].map(([id, sourceRules]) => ({type:"document", id, values:{sourceRules}}))});
    return groups;
  }
  const kicadHistoryItems = new WeakMap();
  function kicadHistoryScope(session, sourceName) {
    // Only the import that opened this file can attest to its original objects.
    // A later import or a discarded report cannot lend its provenance to this history.
    const scopeId = session?.imported?.id;
    const entry = scopeId && sessions.get(session)?.all.find(entry => entry.adopted && entry.scopeId === scopeId);
    const provenance = entry?.provenance;
    if (!provenance) return null;
    const files = provenance.files || [], selected = files.filter(file => file.name === sourceName);
    if (selected.length !== 1) return null;
    const members = /\.kicad_pro$/i.test(sourceName) ? files.filter(file => /\.kicad_(pcb|sch)$/i.test(file.name)) : selected;
    const declared = new Set(entry.documents);
    const documents = new Set(members.flatMap(file => (file.documents || []).filter(id => declared.has(id))));
    if (!documents.size) return null;
    let index = kicadHistoryItems.get(provenance);
    if (!index) {
      const items = new Map(), seen = new Set(), firstOwner = new Map(), repeated = new Map();
      for (const row of provenance.fields || []) if (row.type === "item") {
        const id = row.values?.kicadSourceId;
        if (typeof id === "string" && id) {
          if (firstOwner.has(id)) {
            if (!repeated.has(id)) repeated.set(id, new Set([firstOwner.get(id)]));
            repeated.get(id).add(row.id);
          } else firstOwner.set(id, row.id);
          items.set(row.id, seen.has(row.id) ? null : row.values);
        } else if (items.has(row.id)) items.set(row.id, null);
        seen.add(row.id);
      }
      index = {items, repeated};
      kicadHistoryItems.set(provenance, index);
    }
    return {documents, ...index};
  }
  function retained() {
    const s = state();
    return (s?.all || []).filter(e=>e.adopted).map(e=>{
      const ruleRows=[...s.ruleRows].filter(([id])=>(s.ruleOwners.get(id) ?? s.byDocument.get(id)?.scopeId)===e.scopeId);
      return ruleRows.length || e.ruleRows ? {...e,ruleRows} : e;
    });
  }
  function installRetained(session, entries) {
    const old=sessions.get(session), s={...empty(),loadedRetained:true};
    if(old?.loadedRetained)return;
    const present=new Set((old?.all || []).map(e=>e.scopeId));
    for (const entry of [...entries.filter(e=>!present.has(e.scopeId)),...(old?.all || [])]) {
      s.all.push(entry);
      indexDocuments(s.byDocument,entry);
      for (const [id,rows] of entry.ruleRows || []) {s.ruleRows.set(id,rows);s.ruleOwners.set(id,entry.scopeId);}
    }
    for(const [id,rules] of old?.ruleRows || [])s.ruleRows.set(id,rules);
    for(const [id,scope] of old?.ruleOwners || [])s.ruleOwners.set(id,scope);
    restore(session,s);
  }
  function discard(scopeId) {
    const old=state(), row=old?.all.find(e=>e.scopeId===scopeId);
    if (!row) throw Error("The selected import is no longer available.");
    host.edit(()=>{
      if(state()!==old)throw Error("The import data changed. Review it again.");
      const all=old.all.filter(e=>e!==row), byDocument=new Map(),ruleRows=new Map(old.ruleRows),ruleOwners=new Map(old.ruleOwners);
      for(const e of all)indexDocuments(byDocument,e);
      for(const id of row.documents)if((ruleOwners.get(id) ?? old.byDocument.get(id)?.scopeId)===row.scopeId) {
        ruleRows.delete(id);ruleOwners.delete(id);
      }
      restore(host.fileSession(),{...old,all,byDocument,ruleRows,ruleOwners});
    },"Discard import data");
    return !state()?.all.some(e=>e.scopeId===scopeId);
  }
  async function withOriginals(groups, signal, documentId) {
    const rows=retained().filter(e=>e.index && (!documentId||e.documents.includes(documentId)));
    if(!rows.length)return groups;
    const archive=await globalThis.AtriumLazy.need("AtriumProjectArchiveUI"), mapped=new Map();
    for(const e of rows) {
      const group=groups.find(g=>g===e.provenance||g.precision?.scopeId===e.scopeId);
      if(!group)continue;
      const files=await archive.originalFiles(e.index,{host,signal});
      mapped.set(group,{...group,files:files.map((f,i)=>({...e.provenance.files[i],...f}))});
    }
    return groups.map(g=>mapped.get(g)||g);
  }
  function needsProjection() { const s = state(); return !!s && (!!s.ruleRows.size || s.all.some(r => r.adopted)); }
  const projectedVersions = new WeakMap();
  const storageVersion = doc => projectedVersions.get(doc);
  async function snapshot(model) {
    const current = state(), revision = host.revision();
    const previous = cachedSnapshot?.model === model && cachedSnapshot.state === current ? cachedSnapshot : null;
    if (previous?.revision === revision) return previous.copy;
    const groups = provenance(), projection = await globalThis.AtriumLazy.need("AtriumTranslatorProvenance");
    // The edit journal certifies each unchanged document. A recovery write projects only
    // the other documents and gives the existing incremental writer stable immutable items.
    const journal = globalThis.AtriumUndoStore, documents = new Map(), changed = [];
    let libraryVersion;
    for (const doc of model.documents) {
      const version = journal?.documentVersions(doc, model), old = previous?.documents.get(doc);
      libraryVersion ||= version;
      if (version && old?.version && ["floor","items","outer","pours"].every(k => version[k] === old.version[k])) {
        documents.set(doc, old);
      } else {
        changed.push(doc);
        documents.set(doc, {version});
      }
    }
    const sameLibrary = libraryVersion && previous?.libraryVersion &&
      libraryVersion.floor === previous.libraryVersion.floor && libraryVersion.library === previous.libraryVersion.library;
    const draft = projection.toLegacy({...model, documents:changed, library:sameLibrary ? [] : model.library}, groups);
    changed.forEach((doc,i) => {
      const item = documents.get(doc);
      item.copy = draft.documents[i];
      // Once detached, this snapshot object never changes. The save cache can reuse its
      // already-encoded items even if the editable original has since advanced.
      projectedVersions.set(item.copy,{floor:0, items:0});
    });
    draft.documents = model.documents.map(d => documents.get(d).copy);
    if (sameLibrary) draft.library = previous.library;
    cachedSnapshot = {model, state:current, revision, copy:draft, documents, libraryVersion, library:draft.library};
    return draft;
  }
  function documentFields(provenance, id) {
    if (!provenance) return;
    let rows = sourceRows.get(provenance);
    if (!rows) {
      rows = new Map();
      for (const f of provenance.fields || []) if (f.type === "document") rows.set(f.id, f.values);
      sourceRows.set(provenance, rows);
    }
    return rows.get(id);
  }
  function sourceDocument(doc) {
    const store = state(), rows = store?.ruleRows.get(doc.id);
    for (let i = (store?.all.length || 0) - 1; i >= 0; --i) {
      const entry = store.all[i];
      if (!entry.adopted || !entry.documents.includes(doc.id)) continue;
      const raw = documentFields(entry.provenance, doc.id), binding = documentFields(entry.binding, doc.id);
      if (raw || binding) return Object.assign(Object.create(doc), raw, binding, rows && {sourceRules:rows});
    }
    return rows ? Object.assign(Object.create(doc), {sourceRules:rows}) : doc;
  }
  // Saved 1.x revisions still carry source-record fields. Compare their editable structure
  // with the working copy so that moving provenance out of the model creates no design changes.
  async function comparison(model) {
    if (!records().length || model === host.project() || !model?.documents?.some(d => d.sourceName || d.sourceRules || d.kicadUuid) &&
        !model?.library?.some(d => d.sourceName || d.source)) return model;
    const [projection] = await globalThis.AtriumLazy.need(["AtriumTranslatorProvenance", "AtriumSignals"]);
    return projection.separate(Atrium.clone(model), {});
  }
  async function restoreAppearance(project, doc, ctx) {
    const original = await ctx.pickFile([".SchDoc"]);
    if (!original || !ctx.current()) return;
    const [client, projection, appearance] = await globalThis.AtriumLazy.need(["AtriumTranslatorClient", "AtriumTranslatorProvenance", "AtriumSchAppearance"]);
    const imported = await client.import([{name:original.name, bytes:new Uint8Array(await original.arrayBuffer())}], {translator:"altium"});
    if (!ctx.current()) throw Error("The design changed while reading the SchDoc. Choose the original again.");
    const current = projection.toLegacy(project, provenance()), sheet = current.documents.find(d => d.id === doc.id);
    const source = projection.toLegacy(imported.model, imported.provenance);
    const plan = appearance.planRestore(sheet, current.library, source), items = Object.create(null);
    for (const item of sheet.items) {
      const key = appearance.sourceKey(item);
      if (key && Object.hasOwn(plan.appearance.items, key)) items[item.id] = plan.appearance.items[key];
    }
    ctx.edit(() => {doc.schRestored = {...plan.appearance, items};});
    ctx.info("Restored sheet appearance · " + plan.matched + " matched objects" +
      (plan.custom ? " · " + plan.custom + " custom symbol placements kept" : ""));
  }
  async function bindSource(project, doc, binding) {
    const entry = recent(doc.id), revision = host.revision();
    if (!entry) throw Error("Reopen the imported project before linking its source.");
    const [projection, copy] = await globalThis.AtriumLazy.need(["AtriumTranslatorProvenance", "AtriumSourceCopy"]);
    if (host.project() !== project || host.revision() !== revision) throw Error("The source review is stale. Choose the original again.");
    const check = projection.toLegacy(project, provenance()).documents.find(d => d.id === doc.id);
    copy.applyBinding(check, binding);
    const values = {sourceSha256: check.sourceSha256};
    if (binding.sourceRules) values.sourceRules = binding.sourceRules;
    const fields = [{type: "document", id: doc.id, values}, ...binding.identities.map(({id, ...v}) => ({type: "item", id, values: v}))];
    host.edit(() => {
      const old = state(), bound = {...entry, binding:{fields:[...(entry.binding?.fields || []), ...fields]}};
      const byDocument = new Map(old.byDocument);
      for (const id of entry.documents) if (byDocument.get(id) === entry) byDocument.set(id, bound);
      sessions.set(host.fileSession(), {...old, all:old.all.map(r => r === entry ? bound : r), byDocument});
    }, "Link Altium source");
    host.fileSession().folder?.markSidecarsDirty?.();
  }
  // Reports › Import Report, the project's ⋯ menu and the import notice: the document's report, with
  // its boards' source rules and Restore source appearance…, never Properties. A design without a retained
  // report (an older import) gets its translator notes and rules in an Import details sheet.
  async function openDocument(id = host.currentId()) {
    await host.folderProject?.()?.ensureImportReports?.();
    const entry = recent(id), project = host.project(), doc = project.documents.find(d => d.id === id) || host.doc();
    if (entry) {
      const view = show(entry);
      const article = view?.querySelector?.("article"), tab = visible.get(entry.id);
      if (article && (tab.documentId !== doc?.id || tab.entry !== entry)) {
        tab.documentId = doc?.id;
        tab.entry = entry;
        tab.syncAppearance = null;
        article.querySelector(".import-report-details")?.remove();
        const extras = details(project, doc, entry, tab);
        if (extras.length) {
          const more = node("section"); more.className = "import-report-details"; more.append(...extras); article.append(more);
        }
      }
      return view;
    }
    const extras = details(project, doc, entry);
    const messages = [...new Set(project.importNotes?.length ? project.importNotes : doc?.notes || [])];
    if (!messages.length && !extras.length) { host.info("This document has no import report."); return null; }
    const files = await globalThis.AtriumLazy.need("AtriumEditorFiles");
    files.report(messages, "Import details", extras);
    return null;
  }
  function available(id = host?.currentId?.()) {
    const project = host?.project?.(), doc = project?.documents.find(d => d.id === id);
    return !!(recent(id) || project?.importNotes?.length || doc?.notes?.length || doc?.sourceName || doc?.sourceRules?.length ||
      project?.documents.some(b => b.kind === "pcb" && b.sourceRules?.length) || !state()?.loadedRetained && host?.folderProject?.()?.hasImportIndexes?.());
  }
  function details(project, doc, entry, tab) {
    const out = [], boards = project.documents.filter(b => b.kind === "pcb").map(b => sourceDocument(b)).filter(b => b.sourceRules?.length);
    for (const b of boards) out.push(ruleSection(b, globalThis.AtriumRules));
    const source = doc?.kind === "schematic" && sourceDocument(doc), appearance = globalThis.AtriumSchAppearance;
    if (source && appearance?.eligible(doc, {source, includeRestored:!!tab})) {
      const documentId = doc.id, origin = {source:{sourceName:source.sourceName, sourceSha256:source.sourceSha256}};
      const restore = node("button", "Restore source appearance…"); restore.type = "button"; globalThis.AtriumUI?.button(restore, "secondary");
      const target = () => {
        const live = host.doc();
        return live?.id === documentId && appearance.eligible(live, origin) ? live : null;
      };
      restore.onclick = async () => {
        const live = target();
        if (!live) return;
        const at = host.revision(); restore.disabled = true;
        const ctx = {pickFile:globalThis.AtriumIO.pickFile, current:() => host.doc() === live && host.revision() === at, edit:fn => host.edit(fn, undefined, []), info:text => host.info(text)};
        try {
          if (entry) await restoreAppearance(host.project(), live, ctx);
          else { await globalThis.AtriumLazy.need("AtriumImport"); await appearance.restore(live, host.project(), ctx); }
        } catch (error) { host.info(error.message); } finally { restore.disabled = false; }
      };
      const row = node("div"); row.className = "import-report-actions"; row.append(restore); out.push(row);
      if (tab) {
        tab.syncAppearance = () => {
          const hidden = !target();
          if (row.hidden !== hidden) row.hidden = hidden;
        };
        tab.syncAppearance();
      }
    }
    return out;
  }
  // A board's source design rules: what Waffle supports, partly supports or keeps only as source.
  function ruleSection(board,rules){
    const text=(tag,value)=>{const element=document.createElement(tag);element.textContent=value;return element;};
    const section=document.createElement("details");
    section.append(text("summary",board.name+" · "+board.sourceRules.length+" Altium design rules"));
    const populate=()=>{
      if(!section.open||section.childElementCount>1)return;
      if(!rules){AtriumLazy.need("AtriumRules").then(r=>{rules=r;populate();});return;}
      const rows=rules.sourceReport(board.sourceRules,board),limited=rows.filter(r=>r.status!=="supported");
      const partial=limited.filter(r=>r.status==="partial").length;
      section.append(text("p",(rows.length-limited.length)+" supported · "+partial+" partially supported · "+(limited.length-partial)+" source only"));
      let cursor=0;
      const more=text("button","Show more rules");more.type="button";
      globalThis.AtriumUI?.button(more,"secondary");
      function next(){
        more.remove();
        const end=Math.min(cursor+40,limited.length);
        for(;cursor<end;cursor++){
          const r=limited[cursor],details=document.createElement("details");
          details.append(text("summary",r.name+" · "+(r.status==="partial"?"Partially supported":"Source only")));
          details.ontoggle=()=>{
            if(!details.open||details.childElementCount>1)return;
            const raw=text("pre",r.text);raw.style.whiteSpace="pre-wrap";raw.style.overflowWrap="anywhere";
            details.append(text("p",r.kind+" · "+(r.enabled?"Enabled":"Disabled")+" · Priority "+r.priority),
              text("p","Scope 1: "+(r.scope||"All")+" · Scope 2: "+(r.scope2||"All")),text("p",r.reason),raw);
          };
          section.append(details);
        }
        if(cursor<limited.length)section.append(more);
      }
      more.onclick=next;next();
    };
    section.ontoggle=populate;
    return section;
  }

  function attach(h) {
    if (host === h) return;
    host = h;
    const sync = () => {
      if (cachedSnapshot && cachedSnapshot.model !== h.project()) cachedSnapshot = null;
      for (const [id, tab] of visible) {
        if (tab.session !== h.fileSession() || !records().some(r => r.id === id)) views().close(id);
        else tab.syncAppearance?.();
      }
    };
    h.on("replace", sync);
    h.on("change", sync);
    h.on("document", sync);
    h.registerAction("import-report", () => openDocument());
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({remember, show, recent, available, retained, installRetained, discard, withOriginals, selectedFile:f=>fileGrants.get(f), capture:state, restore, setSourceRules, needsProjection, snapshot, storageVersion, openDocument, sourceDocument, comparison, restoreAppearance, bindSource, provenance, kicadHistoryScope, attach});
})();
