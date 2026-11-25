"use strict";
// The MCAD panel and menu actions (docs/mcad.md). Lazy (AtriumLazy "AtriumMCADPanel"); the
// exchange itself is DOM-free in mcad.js, mcad-idx.js, mcad-idf.js and mcad-step.js.
//
// Actions (File › Import / Export, Window › Panels › MCAD):
//   export-idx-baseline   IDX Baseline…        the board as an IDX SendInformation file (records the baseline)
//   export-idx-changes    IDX Changes…         SendChanges since the baseline
//   export-idx-response   IDX Response…        accepted / rejected answers to the last received file
//   export-idf            IDF 3.0…             .emn and .emp
//   import-idx            MCAD Changes (IDX)…  .idx / .xml (IDX), .emn (IDF): incoming proposals
//   import-enclosure      Enclosure (STEP)…    a reference body in the 3D view, clearance-checked
//   import-step-outline   Board Outline (STEP)… a board edited in MCAD: outline, cutouts, holes as proposals
//   mcad-panel            the panel: pending proposals with Accept / Reject (each one undo step), a canvas
//                         preview on hover, Review in the diff view, the enclosure and its clearance
// Imported files are untrusted: size caps before reading, the safe XML reader, the bounded STEP
// reader; referenced 3D models are never fetched.
globalThis.AtriumMCADPanel = (() => {
  const G = globalThis, MC = () => G.AtriumMCAD, ST = () => G.AtriumMCADStep;
  const t = G.AtriumI18n?.define({ "mcad.export.closed_outline": "Define a closed board outline before exporting to MCAD." }); // i18n-ignore: explicit key
  const MAX_XML = 64 * 1048576, MAX_STEP = 32 * 1048576, EMBED = 2 * 1048576;
  let host = null, panel = null, ui = null, hover = null, clear = null, paintTimer = 0;
  const hasDOM = () => !!G.document?.createElement;
  G.AtriumI18n?.scope?.(".panel-mcad", ["mcad"]); // scripts/i18n-extract.py extracts this file's literals under "mcad"
  const el = (tag, cls, text) => AtriumNavCommon.classedElement(document, tag, cls, text);
  const btn = (text, cls, fn, title) => {
    const b = el("button", cls, text); b.type = "button";
    if (b.classList.contains("mcad-btn")) { b.classList.add("ui-button"); b.dataset.size = "sm"; if (b.classList.contains("mcad-accept")) b.dataset.variant = "primary"; } if (title) b.title = title;
    b.addEventListener("click", e => { e.stopPropagation(); fn(e); });
    return b;
  };
  const say = m => host?.info?.(m);
  const board = () => {
    const p = host.project(), d = host.doc?.();
    if (d?.kind === "pcb") return d;
    const b = G.Atrium?.preferredDocument?.(p, "pcb", host.currentId?.()) || p.documents.find(x => x.kind === "pcb");
    if (!b) throw Error("Open a board layout first.");
    host.selectDocument?.(b.id);
    return b;
  };
  const nowISO = () => new Date().toISOString().slice(0, 19);
  const plural = (n, w) => globalThis.AtriumI18n?.plural?.(n, w) ?? n + " " + (n === 1 ? w : w + "s");
  const motion = () => G.AtriumMotion;
  async function readFile(exts, cap, what) {
    const pick = G.AtriumIO?.pickFile;
    if (!pick) throw Error("This needs a file chooser. From MCP, use import_mcad_changes.");
    const f = await pick(exts);
    if (!f) return null;
    if (f.size > cap) throw Error("The " + what + " is larger than " + Math.round(cap / 1048576) + " MB.");
    const bytes = f.arrayBuffer ? new Uint8Array(await f.arrayBuffer()) : new TextEncoder().encode(await f.text());
    if (bytes.byteLength > cap) throw Error("The " + what + " is larger than " + Math.round(cap / 1048576) + " MB.");
    return {name: String(f.name || what), bytes};
  }

  // ---------------------------------------------------------------- exports
  // A short dialog when an export has nothing to send yet, with the step that would help.
  function notice(title, text, action, label) {
    const d = el("dialog", "work-dialog ui-dialog mcad-dialog"); d.setAttribute("aria-label", title);
    const foot = el("div", "work-actions ui-dialog-actions"), close = btn("Close", "ui-button", () => d.close());
    foot.append(close);
    if (action) {
      const go = btn(label, "ui-button", () => { d.close(); run(action); });
      go.dataset.variant = "primary"; foot.append(go);
    } else close.dataset.variant = "primary";
    const heading = el("h2", null, title), body = el("div");
    body.append(el("p", "fab-hint", text));
    d.append(heading, body, foot);
    G.AtriumShell.openDialog(d, {title: heading, body, actions: foot, initialFocus: close});
    return d;
  }
  const translator = () => G.AtriumLazy.need("AtriumTranslatorClient");
  async function exchange(id, p, d, options) {
    const provenance = G.AtriumImportReports?.provenance();
    const r = await (await translator()).export(id, p, {documentId:d.id, ...options, provenance});
    return {...r.files[0], ...r.details, files:r.files};
  }
  async function exportBaseline() {
    const p = host.project(), d = board(), date = nowISO();
    const previous = MC().peek(d)?.baseline;
    const r = await exchange("idx", p, d, {date, mode:"baseline", captureBaseline:true});
    if (r.problems.length) say("IDX check: " + r.problems[0].message);
    if (!await host.exportFile(r.name, r.text)) return;
    if (host.project() === p && p.documents.includes(d) && MC().peek(d)?.baseline === previous)
      host.edit(() => { MC().store(d).baseline = r.baseline; }, "Export IDX baseline");
    say("Exported " + r.name + " · " + plural(r.stats.parts, "component") + ", " + plural(r.stats.holes, "hole") + ", " + plural(r.stats.keepouts, "keep-out") + ". Later changes go out with File › Export › IDX Changes….");
    schedule();
  }
  async function exportChanges() {
    const p = host.project(), d = board();
    if (!MC().peek(d)?.baseline) { notice("Export IDX Changes", "Changes are sent relative to an IDX baseline, and this board has none yet. Export the baseline first and send it to MCAD.", exportBaseline, "Export Baseline…"); return; }
    const previous = MC().peek(d).baseline;
    const date = nowISO(), r = await exchange("idx", p, d, {date, mode:"changes", captureBaseline:true});
    if (!r.stats.added && !r.stats.changed && !r.stats.removed) { notice("Export IDX Changes", "Nothing changed since the last IDX baseline or change set.", null); return; }
    if (!await host.exportFile(r.name, r.text)) return;
    if (host.project() === p && p.documents.includes(d) && MC().peek(d)?.baseline === previous)
      host.edit(() => { MC().store(d).baseline = r.baseline; }, "Export IDX changes");
    say("Exported " + r.name + " · " + r.stats.changed + " changed, " + r.stats.added + " added, " + r.stats.removed + " removed.");
    schedule();
  }
  async function exportResponse() {
    const p = host.project(), d = board();
    if (!(MC().peek(d)?.inbox || []).some(x => (x.status === "accepted" || x.status === "rejected") && x.ident?.number)) {
      notice("Export IDX Response", "A response answers a file received from MCAD. Import its changes, accept or reject them in the MCAD panel, then export the response.", importChanges, "Import MCAD Changes…");
      return;
    }
    const r = await exchange("idx", p, d, {date:nowISO(), mode:"response"});
    if (await host.exportFile(r.name, r.text)) say("Exported " + r.name + " · " + r.stats.accepted + " accepted, " + r.stats.rejected + " rejected" + (r.stats.file ? " (answers " + r.stats.file + ")" : "") + ".");
  }
  async function exportIDF() {
    const p = host.project(), d = board(), r = await exchange("idf", p, d, {date:new Date().toISOString()});
    const [emn, emp] = r.files;
    if (!await host.exportFile(emn.name, emn.text)) return;
    if (!await host.exportFile(emp.name, emp.text)) return;
    say("Exported " + emn.name + " and " + emp.name + " · " + plural(r.stats.parts, "component") + ", " + plural(r.stats.packages, "package") + ".");
  }

  // ---------------------------------------------------------------- imports
  function receive(design, file, source) {
    const p = host.project(), d = board();
    let r = null;
    host.edit(() => { r = MC().receive(p, d, design, {file, at: nowISO(), source}); }, "Receive MCAD changes (" + file + ")");
    const n = r.proposals.filter(x => x.status === "pending").length;
    toggle(true);
    if (design.kind === "response") say(file + ": MCAD answered " + design.responses.filter(x => x.accepted).length + " accepted, " + design.responses.filter(x => !x.accepted).length + " rejected.");
    else say(file + ": " + (n ? plural(n, "proposal") + " to review in the MCAD panel" : "the board already matches") + ".");
    return r;
  }
  const target = () => ({board:board(), project:host.project()});
  async function importChanges() {
    const selected = target(), f = await readFile([".idx", ".xml", ".emn", ".idf", ".brd"], MAX_XML, "MCAD file");
    if (!f) return;
    const r = await (await translator()).import([f]);
    await adoptTranslation(r, [f], {target:selected});
  }
  async function importStepOutline() {
    const selected = target(), f = await readFile([".step", ".stp"], MAX_STEP, "STEP file");
    if (!f) return;
    say("Reading " + f.name + "…");
    const r = await (await translator()).import([f], {translator:"step", mode:"outline"});
    await adoptTranslation(r, [f], {target:selected});
  }
  function storedEnclosure(d) {
    const e = MC().peek(d)?.enclosure;
    if (!e) return null;
    if (e.text) return {name:e.name, bytes:new TextEncoder().encode(e.text)};
    const entry = (G.AtriumImportReports?.provenance() || []).findLast(p => p.enclosure?.documentId === d.id && p.enclosure.digest === e.digest);
    return entry?.files?.find(f => (f.path || f.name) === entry.enclosure.file) || null;
  }
  async function adoptTranslation(result, files, options = {}) {
    if (options.target && (host.project() !== options.target.project || (host.doc && host.doc() !== options.target.board) || !host.project().documents.includes(options.target.board))) return null;
    const d = board(), source = result.provenance.files[0], {design, mesh} = result.provenance.mechanical, name = source.name;
    let value;
    if (design) value = receive(design, name, result.report.translator);
    else if (mesh) {
      const txt = new TextDecoder().decode(source.bytes), prev = MC().peek(d)?.enclosure;
      const enc = ST().enclosure(mesh, {name, digest:ST().digest(txt), offset:prev?.offset, rz:prev?.rz});
      enc.bytes = source.bytes.byteLength;
      ST().attach(d, enc);
      if (!options.fromStore) {
        result.provenance.enclosure = {documentId:d.id, digest:enc.digest, file:source.path || name};
        host.edit(() => {
          MC().store(d).enclosure = {name, digest:enc.digest, bytes:enc.bytes, offset:enc.offset, rz:enc.rz, gap:prev?.gap ?? 1};
        }, "Import enclosure " + name);
      }
      refresh3D();
      toggle(true);
      runClearance();
      say("Enclosure " + name + " · " + plural(enc.triangles, "triangle") + (enc.bytes > EMBED ? " · select the source again after reopening" : "") + ".");
      value = enc;
    } else throw Error("The translation contains no mechanical reference or proposals.");
    if (!options.fromStore) await G.AtriumNavHost.showImportReport(result, [d.id], result.provenance.files.map(f => f.name));
    return value;
  }
  async function importEnclosure(fromStore) {
    const selected = target(), f = fromStore ? storedEnclosure(selected.board) : await readFile([".step", ".stp"], MAX_STEP, "enclosure STEP");
    if (!f) return null;
    say("Reading the enclosure " + f.name + "…");
    const r = await (await translator()).import([f], {translator:"step"});
    return adoptTranslation(r, [f], {fromStore, target:selected});
  }

  // ---------------------------------------------------------------- enclosure clearance
  let clearRun = null;
  function runClearance() {
    const d = board(), enc = ST()?.current(d);
    if (!enc) { clear = null; schedule(); return null; }
    const gap = +(MC().peek(d)?.enclosure?.gap ?? 1);
    try { clear = {doc: d.id, ...ST().clearance(host.project(), d, enc, {gap})}; }
    catch (e) { clear = {doc: d.id, error: e.message, findings: [], stats: {}}; }
    flagged.clear(); for (const f of clear.findings) flagged.add(f.id);
    refresh3D(true);
    schedule();
    return clear;
  }
  const flagged = new Set();
  function refresh3D(colorsOnly) {
    for (const v of G.Atrium3D?.viewers?.values?.() || []) { if (v.closed) continue; if (colorsOnly) v.recolor?.(); else v.refold?.(); }
  }

  // ---------------------------------------------------------------- decisions
  function decide(id, ok, comment) {
    const p = host.project(), d = board(), x = MC().find(d, id);
    if (!x || x.status !== "pending") return;
    try {
      host.edit(() => ok ? MC().accept(p, d, id) : MC().reject(p, d, id, comment), (ok ? "Accept" : "Reject") + " MCAD change: " + x.label);
      if (ok && x.kind === "place") { const part = d.items.find(i => i.id === x.key); if (part) motion()?.settle?.(d, [part]); }
      if (clear) runClearance();
    } catch (e) { say(e.message); }
    hover = null; host.invalidate?.(); schedule();
  }
  function decideAll(ok) {
    const p = host.project(), d = board(), list = MC().pending(d);
    if (!list.length) return;
    const errors = [];
    host.edit(() => { for (const x of list) { try { if (ok) MC().accept(p, d, x.id); else MC().reject(p, d, x.id); } catch (e) { errors.push(x.label + ": " + e.message); } } },
      (ok ? "Accept " : "Reject ") + plural(list.length, "MCAD change"));
    say((ok ? "Accepted " : "Rejected ") + plural(list.length - errors.length, "MCAD change") + (errors.length ? " · " + errors[0] : "") + ". File › Export › IDX Response… sends the answer.");
    if (clear) runClearance();
    schedule();
  }
  async function review() {
    const p = host.project(), d = board(), revision = host.revision?.(), pv = MC().preview(p, d);
    if (!G.AtriumGit) await G.AtriumLazy.need("AtriumGitPicker");
    await G.AtriumGit.compare({project: p, label: "Working design"}, {project: pv.project, label: "With MCAD proposals"}, {
      doc: d.id, active: () => host.project() === p && p.documents.includes(d) && host.revision?.() === revision
    });
  }

  // ---------------------------------------------------------------- canvas preview
  function colour(name, fb) { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; } catch { return fb; } }
  function boxOf(d, id) { try { const it = d.items.find(i => i.id === id); return it ? G.AtriumNavCommon?.itemBox?.(d, host.defs?.(), it) : null; } catch { return null; } }
  function render(d) {
    if (!d || d.kind !== "pcb") return null;
    const list = hover ? [hover] : [];
    const marks = clear && clear.doc === d.id ? clear.findings : [];
    if (!list.length && !marks.length) return null;
    const acc = colour("--accent", "#3794ff"), warn = colour("--warning", "#cca700"), bad = colour("--error", "#f0706a"), ok = colour("--success", "#89d185");
    return {overlay: (ctx, {scale}) => {
      const px = 1 / (scale || 1), poly = (P, close = true) => { ctx.beginPath(); P.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); if (close) ctx.closePath(); };
      ctx.save(); ctx.lineWidth = 1.5 * px;
      for (const x of list) {
        const a = x.after, b = x.before;
        ctx.setLineDash([4 * px, 3 * px]);
        if (x.kind === "place" && b && a) {
          const box = boxOf(d, x.key);
          ctx.strokeStyle = warn;
          if (box) { ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]); const w = box[2] - box[0], h = box[3] - box[1], dx = a.x - b.x, dy = a.y - b.y;
            ctx.setLineDash([]); ctx.strokeStyle = acc; ctx.save(); ctx.translate(box[0] + dx + w / 2, box[1] + dy + h / 2); ctx.rotate((a.angle - b.angle) * Math.PI / 180); ctx.strokeRect(-w / 2, -h / 2, w, h); ctx.restore(); }
          ctx.setLineDash([]); ctx.strokeStyle = acc; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(a.x, a.y); ctx.stroke();
        } else if (x.kind === "outline" && a) {
          ctx.strokeStyle = acc; poly(a.outline); ctx.stroke(); for (const c of a.cutouts || []) { poly(c); ctx.stroke(); }
        } else if ((x.kind === "hole-add" || x.kind === "hole-change") && a) {
          ctx.strokeStyle = x.kind === "hole-add" ? ok : acc; ctx.beginPath(); ctx.arc(a.x, a.y, a.d / 2, 0, 2 * Math.PI); ctx.stroke();
        } else if ((x.kind === "keepout-add" || x.kind === "keepout-change") && a) {
          ctx.strokeStyle = x.kind === "keepout-add" ? ok : acc; ctx.fillStyle = ctx.strokeStyle; poly(a.points); ctx.globalAlpha = .12; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
        } else if (b && (x.kind === "hole-remove" || x.kind === "keepout-remove")) {
          ctx.strokeStyle = bad; if (b.points) poly(b.points); else { ctx.beginPath(); ctx.arc(b.x, b.y, b.d / 2, 0, 2 * Math.PI); } ctx.stroke();
        }
      }
      ctx.setLineDash([]); ctx.strokeStyle = bad;
      for (const f of marks) { const box = boxOf(d, f.id); if (box) { const m = 0.6; ctx.strokeRect(box[0] - m, box[1] - m, box[2] - box[0] + 2 * m, box[3] - box[1] + 2 * m); } }
      ctx.restore();
    }};
  }
  function locate(x) {
    const a = x.after || x.before;
    if (!a) return;
    const pts = a.outline || a.points || [[a.x - (a.d || 2), a.y - (a.d || 2)], [a.x + (a.d || 2), a.y + (a.d || 2)]];
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]), m = 2;
    host.zoomTo?.([Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m]);
    if (x.key && x.kind === "place") host.select?.([x.key]);
  }

  // ---------------------------------------------------------------- panel
  function build() {
    if (!hasDOM()) return false;
    const side = document.getElementById("properties") || document.body;
    panel = el("section", "panel panel-mcad"); panel.hidden = true; panel.setAttribute("aria-labelledby", "mcad-heading");
    const head = el("header", "pane-heading"), h2 = el("h2", null, "MCAD"); h2.id = "mcad-heading";
    const close = btn("×", "ui-close mcad-close", () => toggle(false), "Close MCAD"); close.setAttribute("aria-label", "Close MCAD");
    head.append(h2, close);
    const status = el("p", "mcad-status"); status.setAttribute("role", "status");
    const tools = el("div", "mcad-tools");
    tools.append(btn("Import…", "mcad-btn", () => run(importChanges), "Import MCAD changes (IDX or IDF)"), btn("Baseline", "mcad-btn", () => run(exportBaseline), "Export an IDX baseline"),
      btn("Changes", "mcad-btn", () => run(exportChanges), "Export IDX changes since the baseline"), btn("Respond", "mcad-btn", () => run(exportResponse), "Export the IDX response to the last received file"));
    const list = el("div", "mcad-list pane-scroll"); list.setAttribute("role", "list"); list.setAttribute("aria-label", "Incoming MCAD proposals");
    const bulk = el("div", "mcad-bulk");
    bulk.append(btn("Accept All", "mcad-btn mcad-accept", () => decideAll(true)), btn("Reject All", "mcad-btn", () => decideAll(false)), btn("Review…", "mcad-btn", () => run(review), "Compare the board with every pending proposal applied (Review Changes)"));
    const decided = el("details", "mcad-decided"); decided.append(el("summary", null, "Decided")); const decidedList = el("div", "mcad-list"); decided.append(decidedList);
    const encBox = el("div", "mcad-enclosure");
    panel.append(head, status, tools, list, bulk, decided, encBox);
    side.append(panel);
    ui = {status, list, bulk, decided, decidedList, encBox};
    const spec = {id: "mcad", title: "MCAD", element: panel, area: "right", action: "mcad-panel"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    return true;
  }
  const KIND = {place: "Component", outline: "Board", "hole-add": "Hole", "hole-change": "Hole", "hole-remove": "Hole", "keepout-add": "Keep-out", "keepout-change": "Keep-out", "keepout-remove": "Keep-out", info: "Note"};
  function row(x, live) {
    const r = el("div", "mcad-row is-" + x.status); r.setAttribute("role", "listitem"); r.title = x.label + (x.ident?.number ? " · " + (x.ident.scope ? x.ident.scope + " " : "") + x.ident.number : "");
    const text = el("span", "mcad-text");
    text.append(el("span", "mcad-label", x.label), el("span", "mcad-meta", [KIND[x.kind] || x.kind, x.source?.toUpperCase(), x.status !== "pending" ? x.status : "", x.comment || ""].filter(Boolean).join(" · ")));
    r.append(el("span", "mcad-dot"), text);
    if (live) {
      r.append(btn("Accept", "mcad-btn mcad-accept", () => fade(r, () => decide(x.id, true)), "Apply this change (one undo step)"), btn("Reject", "mcad-btn", () => fade(r, () => decide(x.id, false)), "Keep the board as it is; the response says rejected"));
      r.onpointerenter = () => { hover = x; host.invalidate?.(); };
      r.onpointerleave = () => { if (hover === x) { hover = null; host.invalidate?.(); } };
    }
    r.onclick = () => locate(x);
    return r;
  }
  // Accepted or rejected rows fade out with the motion system's timing before the list repaints.
  function fade(r, then) {
    const Mo = motion();
    if (!Mo?.animate || !Mo.enabled?.()) { then(); return; }
    r.style.pointerEvents = "none";
    let once = false;
    const go = () => { if (!once) { once = true; then(); } };
    Mo.animate({duration: "fast", ease: "accelerate", step: k => { r.style.opacity = String(1 - k); }, done: go});
    setTimeout(go, Mo.duration("fast") + 40); // the decision never waits on a frame that does not come (hidden page)
  }
  function paintEnclosure(d) {
    const box = ui.encBox, e = MC().peek(d)?.enclosure, enc = ST()?.current(d);
    box.replaceChildren(el("h3", "mcad-sub", "Enclosure"));
    if (!e) { box.append(el("p", "mcad-note", "No enclosure. File › Import › Enclosure (STEP)… shows one in the 3D view and checks clearance.")); box.append(btn("Import Enclosure…", "mcad-btn", () => run(() => importEnclosure()))); return; }
    box.append(el("p", "mcad-note", e.name + (enc ? " · " + plural(enc.triangles, "triangle") : storedEnclosure(d) ? " · stored, not loaded" : " · import it again to view")));
    if (!enc && storedEnclosure(d)) box.append(btn("Load", "mcad-btn", () => run(() => importEnclosure(true))));
    const num = (label, key, idx, step) => {
      const l = el("label", "mcad-field"), i = el("input", "ui-field"); i.type = "number"; i.dataset.numericUnit = key === "rz" ? "deg" : "mm"; i.step = String(step);
      const cur = idx == null ? e[key] ?? (key === "gap" ? 1 : 0) : (e[key] || [0, 0, 0])[idx];
      i.value = String(cur); i.setAttribute("aria-label", label);
      i.onchange = () => {
        const v = +i.value; if (!Number.isFinite(v)) return;
        host.edit(() => { const m = MC().store(d).enclosure; if (idx == null) m[key] = v; else { m[key] = (m[key] || [0, 0, 0]).slice(); m[key][idx] = v; } }, "Place enclosure");
        const cur2 = MC().peek(d).enclosure; if (enc) { ST().place(enc, {offset: cur2.offset, rz: cur2.rz}); refresh3D(); runClearance(); }
      };
      l.append(el("span", null, label), i); return l;
    };
    const grid = el("div", "mcad-grid");
    grid.append(num("X", "offset", 0, 0.1), num("Y", "offset", 1, 0.1), num("Z", "offset", 2, 0.1), num("Turn", "rz", null, 1), num("Clearance", "gap", null, 0.1));
    box.append(grid);
    if (enc) {
      box.append(btn("Check Clearance", "mcad-btn", () => runClearance()));
      if (clear?.doc === d.id) {
        if (clear.error) box.append(el("p", "mcad-note is-bad", clear.error));
        else {
          box.append(el("p", "mcad-note" + (clear.findings.length ? " is-bad" : ""), clear.findings.length ? plural(clear.findings.length, "component") + " too close to the enclosure (" + clear.gap + " mm)" : "Every component clears the enclosure by " + clear.gap + " mm · " + clear.stats.ms + " ms"));
          const l = el("div", "mcad-list");
          for (const f of clear.findings.slice(0, 50)) { const r = el("div", "mcad-row is-bad"); r.append(el("span", "mcad-dot"), el("span", "mcad-label", f.ref + " · " + (f.kind === "collision" ? "collides" : f.distance + " mm"))); r.onclick = () => host.select?.([f.id]); l.append(r); }
          box.append(l);
        }
      }
      // Outline and keep-outs from a section or a horizontal face.
      const row2 = el("div", "mcad-derive"), mode = el("select", "ui-field"), level = el("select", "ui-field"), inset = el("input", "ui-field");
      mode.setAttribute("aria-label", "Derive from"); mode.add(new Option("Section", "section")); mode.add(new Option("Face", "face"));
      level.setAttribute("aria-label", "Height");
      for (const lv of ST().levels(enc).slice(0, 24)) level.add(new Option("z " + lv.z + " mm · " + (lv.up ? "up" : "down") + " · " + lv.area + " mm²", lv.z + "|" + (lv.up ? 1 : 0)));
      level.add(new Option("Section 0.5 mm above the board", "auto|1"));
      level.value = "auto|1";
      inset.type="number";inset.dataset.numericUnit="mm";inset.step = "0.1"; inset.value = "0.5"; inset.setAttribute("aria-label", "Inset");
      row2.append(mode, level, inset, btn("Derive", "mcad-btn", () => run(() => {
        const [zs, up] = level.value.split("|"), m = mode.value;
        const des = ST().derive(host.project(), d, enc, {mode: m, z: zs === "auto" ? undefined : +zs, up: up === "1", inset: +inset.value || 0});
        receive(des, e.name + " (" + (m === "face" ? "face" : "section") + ")", "enclosure");
      }), "Propose a board outline and keep-outs from the enclosure at that height"));
      box.append(row2);
    }
  }
  function paint() {
    clearTimeout(paintTimer); paintTimer = 0;
    if (!panel || panel.hidden || !host) return;
    let d;
    try { d = board(); } catch { ui.status.textContent = "Open a board layout to exchange it with MCAD."; ui.list.replaceChildren(); return; }
    const p = host.project(), s = MC().status(p, d), m = MC().peek(d) || {};
    const ch = s.changes_since_baseline;
    ui.status.textContent = (s.baseline ? "Baseline " + s.baseline.sequence + (s.baseline.at ? " · " + s.baseline.at.replace("T", " ") : "") + (ch ? " · " + (ch.added + ch.changed + ch.removed) + " changed since" : "") : "No IDX baseline yet") +
      " · " + plural(s.inbox.pending, "pending proposal");
    const inbox = m.inbox || [], live = inbox.filter(x => x.status === "pending"), done = inbox.filter(x => x.status !== "pending").slice(-200).reverse();
    ui.list.replaceChildren(...(live.length ? live.map(x => row(x, true)) : [el("p", "mcad-note", "No pending MCAD proposals. Import an IDX or IDF file from MCAD, or derive the outline from an enclosure.")]));
    ui.bulk.hidden = !live.length;
    ui.decided.hidden = !done.length;
    ui.decided.querySelector("summary").textContent = "Decided and notes (" + done.length + ")";
    ui.decidedList.replaceChildren(...done.map(x => row(x, false)));
    paintEnclosure(d);
  }
  function schedule() { if (!panel || panel.hidden || paintTimer) return; paintTimer = setTimeout(paint, 60); }
  function toggle(show) {
    if (!panel && !build()) return false;
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on) document.body.classList.remove("hide-right");
    G.AtriumNavCommon?.setChecked?.("mcad-panel", on);
    if (on) paint(); else { hover = null; host?.invalidate?.(); }
    // A stored enclosure loads with the panel.
    if (on) { try { const d = board(); if (!ST()?.current(d) && storedEnclosure(d)) run(() => importEnclosure(true)); } catch { /* no board */ } }
    return on;
  }
  function run(fn) {
    Promise.resolve().then(fn).catch(e => say(e.code === "mcad-outline-required" && t ? t("mcad.export.closed_outline") : e.message));
  }

  function attach(h) {
    host = h;
    const reg = (id, fn) => h.registerAction?.(id, () => run(fn));
    reg("export-idx-baseline", exportBaseline); reg("export-idx-changes", exportChanges); reg("export-idx-response", exportResponse); reg("export-idf", exportIDF);
    reg("import-idx", importChanges); reg("import-enclosure", () => importEnclosure()); reg("import-step-outline", importStepOutline);
    h.registerAction?.("mcad-panel", () => toggle());
    h.addRenderer?.(render);
    h.on?.("change", schedule); h.on?.("document", schedule);
  }
  if (hasDOM()) G.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({attach, toggle, isOpen: () => !!panel && !panel.hidden, flagged: id => flagged.has(id), runClearance, receive, adoptTranslation, importEnclosure, clearance: () => clear});
})();
