"use strict";
// Links in Properties: the stored links that start at the selected object, the references
// that point at it (with what would break if it were deleted) and, with nothing selected,
// every stored link in the project with its health. A picker chooses a native record or an
// explicit net or pin anchor. Broken links show their reason and rebind in one Undo step
globalThis.AtriumLinksUI = (() => {
  const G = globalThis, B = G.AtriumButter, U = G.AtriumIntelUI, K = G.AtriumUIKit;
  const host = () => G.AtriumNavHost;
  const P = "butter.links.";
  const read = async (id, args = {}) => (await B.run(P + id, args, {mode:"read"})).result;
  const apply = (id, args) => G.AtriumButterEditor.apply(P + id, args);
  const PAGE = 20;
  const REASONS = {
    "missing-object":"The target was deleted or is not in this project.",
    "missing-source":"The object this link starts from is gone.",
    "missing-project":"The target is in another project that is not open.",
    "missing-fragment":"The datasheet page no longer exists.",
    "missing-document":"The target's document is not in this project.",
    "missing-frame":"The slide frame no longer exists.",
    "ambiguous":"More than one object has this identity.",
    "ambiguous-source":"More than one object claims to be the source.",
    partial:"Part of the project is still loading, so this link could not be checked.",
    "invalid-link":"The stored address is not a valid Waffle link."
  };
  const kindName = kind => ({part:"Component", schematic:"Sheet", pcb:"Board", savedQuery:"Saved query", savedView:"Saved view",
    datasheet:"Datasheet", calculation:"Calculation", note:"Note", comment:"Comment", commit:"Git commit", rule:"Rule", net:"Net", pin:"Pin"}[kind] ??
    (kind ? kind[0].toUpperCase() + kind.slice(1) : "Object"));
  const id = value => G.AtriumLinkRecord?.id(value);
  let section = null, version = 0, includeGit = false, shown = PAGE;

  function label(target) {
    if (!target) return "Unknown";
    if (target.label) return target.label;
    if (target.documentId && target.objectId) return U.describe({documentId:target.documentId, id:target.objectId}).label;
    const project = host().project();
    return project.documents.find(d => d.id === target.objectId)?.name ?? kindName(target.kind);
  }
  function probeTarget(t) {
    if (t.documentId && t.documentId !== t.objectId) return U.probe({documentId:t.documentId, id:t.objectId}, {focus:false});
    return U.probe({url:G.AtriumLinks.format({projectId:host().project().id, objectId:t.objectId})});
  }

  // ------------------------------------------------------------------ Properties section
  // The section matches the inspector's own disclosures and stays open unless the user closes it.
  let closed = false;
  async function inspect(inspector) {
    if (!U.enabled("links")) return;
    const h = host(), project = h.project(), selection = h.selection();
    const subject = selection.length === 1 ? selection[0] : null;
    const token = ++version;
    const details = K.el("details", "inspector-disclosure intel-links"), summary = K.el("summary", null, "Links");
    const collapse = K.el("div", "ui-collapse"), content = K.el("div", "ui-collapse-content"), body = K.el("div", "inspector-disclosure-body");
    summary.dataset.t = "Links";
    content.append(body); collapse.append(content); details.append(summary, collapse);
    details.open = !closed;
    details.addEventListener("toggle", () => { if (details.isConnected) closed = !details.open; });
    body.setAttribute("aria-busy", "true");
    section = details;
    // Two inspector mutations can each start a placement before the first lands: the newest wins.
    inspector.querySelector(":scope > .intel-links")?.remove();
    inspector.append(details);
    const done = (...nodes) => { if (token !== version || !details.isConnected) return; body.append(...nodes.filter(Boolean)); body.removeAttribute("aria-busy"); };
    if (!G.AtriumLinksDesktop) await G.AtriumLazy.need("AtriumLinksDesktop");
    if (selection.length > 1) return done(K.empty({text:"Select one object to see its links."}));
    if (!id(project.id)) return done(K.empty({text:"Save the project to give its objects link addresses."}));
    if (subject && !id(subject)) return done(K.empty({text:"This object has no saved identity yet. It gets one when the project is saved."}));
    try {
      if (subject) {
        const actions = [K.button("Copy link", {variant:"quiet", size:"sm", run:() => apply("copy-link", {objectId:subject}).catch(error => h.info(error.message))}),
          K.iconButton("plus", "Add link from this object…", {run:() => addLink(subject)})];
        done(await outgoing(project, subject, actions), await incoming(project, subject));
      } else done(await projectLinks(project));
    } catch (error) { done(K.notice({tone:"danger", text:error.message})); }
  }
  async function linkRow(record, {showSource = false} = {}) {
    let status;
    try { status = await read("status", {recordId:record.id}); } catch (error) { status = {status:"partial", message:error.message}; }
    const broken = status.status !== "found";
    const target = status.target ?? record.target;
    const where = target.documentId && host().project().documents.find(d => d.id === target.documentId)?.name;
    const title = showSource ? label(record.source) + " → " + (record.label ?? label(target)) : record.label ?? label(target);
    const detail = broken ? REASONS[status.status] ?? "This link cannot be resolved." : [kindName(target.kind), where].filter(Boolean).join(" · ");
    const actions = broken ? [K.button("Inspect…", {variant:"quiet", size:"sm", run:() => inspectBroken(record, status)})] :
      [U.more("Link actions", [{label:"Open", run:() => probeTarget(target)}, {label:"Copy link", run:() => copyAddress(target)},
        {label:"Rebind…", run:() => rebind(record)}, "-", {label:"Remove…", run:() => removeLink(record)}])];
    const row = K.row({title, detail, state:broken ? "broken" : undefined, actions, role:"listitem",
      meta:broken ? K.badge(status.status === "partial" ? "Not checked" : "Broken", status.status === "partial" ? "warning" : "danger") : undefined});
    if (!broken) { row.tabIndex = 0; row.addEventListener("click", event => { if (!event.target.closest("button")) probeTarget(target); }); }
    return row;
  }
  async function outgoing(project, subject, actions) {
    const records = Object.values(project.links ?? {}).filter(r => r.source?.objectId === subject);
    const rows = [];
    for (const r of records) rows.push(await linkRow(r));
    return K.section("Links from here", {quiet:true, level:4, actions:[K.count(records.length), ...actions]},
      rows.length ? K.list(rows, {role:"list"}) : K.empty({text:"No stored links start here."}));
  }
  async function incoming(project, subject) {
    const url = G.AtriumLinks.format({projectId:project.id, objectId:subject});
    const page = await read("backlinks", {url, offset:0, limit:shown, ...(includeGit ? {includeGit:true} : {})});
    const groups = new Map();
    for (const edge of page.rows) {
      const kind = kindName(edge.source.kind);
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(edge);
    }
    const out = K.section("Referenced by", {quiet:true, level:4, actions:[K.count(page.total)],
      note:page.total ? "Deleting this object leaves " + (page.total === 1 ? "this reference" : "these " + page.total + " references") + " broken." : undefined});
    if (!page.complete) out.append(K.statusLine("Checking the rest of the project…", {busy:true}));
    if (!page.total) out.append(K.empty({text:page.complete ? "Nothing links here." : "Nothing found so far."}));
    for (const [kind, edges] of groups) {
      const rows = edges.map(edge => {
        const source = edge.source, isCommit = source.kind === "commit";
        const where = source.documentId && host().project().documents.find(d => d.id === source.documentId)?.name;
        const row = K.row({title:isCommit ? edge.label ?? source.objectId.slice(0, 8) : label(source), detail:[where ?? kind, edge.field].filter(Boolean).join(" · "),
          run:isCommit ? undefined : () => probeTarget(source)});
        return row;
      });
      out.append(K.list(rows, {role:"list", label:kind}));
    }
    if (page.total > page.rows.length) out.append(K.button("Show " + Math.min(PAGE, page.total - page.rows.length) + " more", {variant:"quiet", size:"sm",
      run:() => { shown += PAGE; refresh(); }}));
    if (G.AtriumHost?.gitQuery) out.append(K.checkbox("Include Git commits", {checked:includeGit, onChange:on => { includeGit = on; refresh(); }}));
    if (includeGit && page.git?.status === "unavailable") out.append(K.el("p", "ui-section-note", "Git history is unavailable for this project."));
    return out;
  }
  async function projectLinks() {
    const page = await read("list", {offset:0, limit:shown});
    const rows = [];
    for (const r of page.rows) rows.push(await linkRow(r, {showSource:true}));
    const out = K.section("Links in this project", {quiet:true, level:4, actions:[K.count(page.total)]},
      rows.length ? K.list(rows, {role:"list"}) : K.empty({text:"No stored links yet. Select an object and choose Add link."}));
    if (page.total > rows.length) out.append(K.button("Show more", {variant:"quiet", size:"sm", run:() => { shown += PAGE; refresh(); }}));
    return out;
  }
  function refresh() {
    const inspector = G.document.getElementById("inspector");
    inspector?.querySelector(":scope > .intel-links")?.remove(); // the inspector watch puts a fresh one back
  }

  async function copyAddress(target) {
    const links = G.AtriumLinksDesktop ?? await G.AtriumLazy.need("AtriumLinksDesktop");
    await links.copyTarget({...target, projectId:host().project().id});
  }

  // ------------------------------------------------------------------ target picker
  // Every native record the project can address, with its kind, label and document. A net
  // can be linked through an explicit anchor that keeps a durable address.
  function candidates() {
    const h = host(), project = h.project(), out = [], seen = new Map();
    const add = row => { out.push(row); seen.set(row.objectId, (seen.get(row.objectId) ?? 0) + 1); };
    for (const doc of project.documents) {
      if (id(doc.id)) add({objectId:doc.id, kind:doc.kind, label:doc.name, document:"Document"});
      if (!Array.isArray(doc.items)) { out.push({objectId:doc.id + ":unloaded", kind:doc.kind, label:doc.name, document:"Not loaded", unavailable:true}); continue; }
      const nets = new Map();
      for (const item of doc.items) {
        if (id(item.id) && (item.ref || item.name || item.text || item.kind === "via" || item.kind === "track"))
          add({objectId:item.id, kind:item.kind, label:U.describe({documentId:doc.id, id:item.id}).label, document:doc.name, documentId:doc.id});
        if (item.net && id(item.id) && !nets.has(item.net)) nets.set(item.net, item.id);
      }
      for (const [net, ownerId] of nets) out.push({anchor:{documentId:doc.id, ownerId, kind:"net"}, kind:"net", label:net, document:doc.name, objectId:"net:" + doc.id + ":" + net});
    }
    for (const q of project.savedQueries ?? []) add({objectId:q.id, kind:"savedQuery", label:q.name, document:"Project"});
    for (const row of out) row.duplicate = (seen.get(row.objectId) ?? 0) > 1;
    return out;
  }
  async function pick(title, {exclude} = {}) {
    const all = candidates().filter(c => c.objectId !== exclude);
    let chosen = null, active = 0, shownRows = [];
    const search = K.search({placeholder:"Find an object, document or net", label:"Find target"});
    const list = K.list([], {label:"Targets"});
    list.tabIndex = 0;
    const paint = () => {
      const q = search.input.value.trim().toLowerCase();
      shownRows = all.filter(c => !q || (c.label + " " + kindName(c.kind) + " " + c.document).toLowerCase().includes(q)).slice(0, 200);
      active = Math.min(active, Math.max(0, shownRows.length - 1));
      search.setCount(q ? shownRows.length + " of " + all.length : "");
      list.replaceChildren(...shownRows.map((c, i) => {
        const meta = K.el("span", "intel-row-badges");
        if (c.duplicate) meta.append(K.badge("Duplicate identity", "warning"));
        if (c.anchor) meta.append(K.badge("Creates anchor"));
        if (c.unavailable) meta.append(K.badge("Not loaded"));
        const row = K.row({title:c.label, detail:kindName(c.kind) + " · " + c.document, meta, selected:i === active});
        if (c.unavailable || c.duplicate) row.setAttribute("aria-disabled", "true");
        row.addEventListener("click", () => { active = i; paint(); });
        row.addEventListener("dblclick", () => { if (!row.hasAttribute("aria-disabled")) dialog.querySelector(".is-primary")?.click(); });
        return row;
      }));
      if (!shownRows.length) list.append(K.empty({text:"No target matches."}));
    };
    search.input.addEventListener("input", () => { active = 0; paint(); });
    const keys = event => {
      const step = {ArrowDown:1, ArrowUp:-1}[event.key];
      if (step) { event.preventDefault(); active = Math.max(0, Math.min(shownRows.length - 1, active + step)); paint(); list.querySelector("[aria-selected=true]")?.scrollIntoView({block:"nearest"}); }
    };
    search.input.addEventListener("keydown", keys); list.addEventListener("keydown", keys);
    const message = K.el("div");
    const box = K.el("div", "intel-picker");
    box.append(search, list, message);
    const dialog = G.AtriumShell.dialog({title, body:[box], actions:[{label:"Cancel"}, {label:"Choose", primary:true, run:async () => {
      const c = shownRows[active];
      if (!c || c.unavailable || c.duplicate) { message.replaceChildren(K.notice({tone:"warning", text:c?.duplicate ?
        "This identity is not unique, so a link to it would be ambiguous. Choose another target." : "Choose a loaded target."})); return false; }
      if (c.anchor) {
        const receipt = await apply("anchor", c.anchor);
        if (receipt.result.status !== "found") { message.replaceChildren(K.notice({tone:"danger", text:REASONS[receipt.result.status] ?? "No anchor."})); return false; }
        chosen = {url:receipt.result.url, label:c.label};
      } else chosen = {url:G.AtriumLinks.format({projectId:host().project().id, objectId:c.objectId}), label:c.label};
    }}]});
    paint();
    search.input.focus();
    await dialog.done;
    return chosen;
  }
  async function addLink(sourceId) {
    const target = await pick("Link to…", {exclude:sourceId});
    if (!target) return;
    try { await apply("create", {sourceId, url:target.url, label:target.label}); host().info("Linked to " + target.label + " · Undo removes it"); }
    catch (error) { host().info(error.message); }
    refresh();
  }
  async function rebind(record) {
    const target = await pick("Rebind link to…", {exclude:record.source.objectId});
    if (!target) return;
    try { await apply("rebind", {recordId:record.id, url:target.url}); host().info("Link now points to " + target.label + " · Undo restores it"); }
    catch (error) { host().info(error.message); }
    refresh();
  }
  async function removeLink(record) {
    const d = G.AtriumShell.dialog({title:"Remove link?", body:[K.el("p", null, "The stored link to " + (record.label ?? label(record.target)) + " is removed. Undo restores it.")],
      actions:[{label:"Cancel", focus:true}, {label:"Remove", variant:"danger", default:false, run:async () => { await apply("remove", {recordId:record.id}); }}]});
    if (await d.done === "Remove") refresh();
  }
  async function inspectBroken(record, status) {
    const address = K.el("code", "ui-code intel-link-address ui-selectable", G.AtriumLinks.format(record.target));
    const body = [K.propRow("Reason", REASONS[status.status] ?? status.status), K.propRow("Address", address, {stacked:true}),
      K.propRow("Last label", record.label ?? "None")];
    if (status.candidates?.length) body.push(K.section("Candidates", {quiet:true, level:4}, K.list(status.candidates.map(c =>
      K.row({title:c.label ?? c.objectId, detail:kindName(c.kind)})), {role:"list"})));
    body.push(K.el("p", "ui-section-note", status.status === "missing-source" ? "The source is gone, so this link can only be removed." :
      "Choose a replacement to keep the link, or remove it. Either is one Undo step."));
    const actions = [{label:"Cancel"}, {label:"Remove link", variant:"danger", default:false}];
    if (status.status !== "missing-source") actions.push({label:"Choose replacement…", primary:true});
    const d = G.AtriumShell.dialog({title:"Broken link", body, actions});
    const done = await d.done;
    if (done === "Remove link") { await apply("remove", {recordId:record.id}); refresh(); }
    else if (done === "Choose replacement…") rebind(record);
  }

  // ------------------------------------------------------------------ open a pasted link
  async function openPrompt() {
    const field = K.field({label:"Waffle link", placeholder:"waffle://…"});
    const message = K.el("div");
    const d = G.AtriumShell.dialog({title:"Open link", body:[K.propRow("Link", field), message], actions:[{label:"Cancel"}, {label:"Open", primary:true, run:async () => {
      const result = await U.probe({url:field.value.trim()}, {focus:true});
      if (result.status === "found") { reveal(result); return; }
      message.replaceChildren(K.notice({tone:result.status === "partial" ? "warning" : "danger", text:U.openMessage(result.status)}));
      return false;
    }}]});
    field.focus();
    await d.done;
  }
  // Metadata with no place on the canvas opens where it lives.
  function reveal(result) {
    const t = result.target;
    if (t?.kind === "savedQuery" && U.enabled("query")) {
      const q = host().project().savedQueries?.find(r => r.id === t.objectId);
      if (q) U.open("query", {source:q.query.source});
    } else if (t && !t.documentId && !["comment", "slide", "savedView"].includes(t.kind)) host().info(kindName(t.kind) + " " + label(t) + " has no place on the canvas.");
  }

  function sync(on) { if (!on) G.document.getElementById("inspector")?.querySelector(":scope > .intel-links")?.remove(); }
  return Object.freeze({inspect, openPrompt, pick, sync, refresh, open:() => openPrompt()});
})();
