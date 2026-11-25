"use strict";
// Library panel actions for folder libraries and library imports (library-sources.js):
//   addFolder(ctx, o)      Add library folder…: a folder you choose (File System Access in Chromium; a folder
//                          snapshot elsewhere, read again with Rescan). Waffle only reads it.
//   importFiles(ctx, o)    Import library files…: KiCad .kicad_sym/.kicad_mod and Altium SchLib/PcbLib, paired
//                          into complete components inside the chosen files, reviewed before they join the project.
//   getKiCad(ctx, o)       Get KiCad libraries…: on request only, downloads the official kicad-symbols and
//                          kicad-footprints archives into this app's storage (outside every project and repository).
//   folderDetail(ctx, host, lib, o), restore()
// No hover pop-ups; Esc closes every dialog (AtriumLibrary.ui.dialog).
globalThis.AtriumLibrarySourcesUI = (() => {
  const S = () => globalThis.AtriumLibrarySources, L = () => globalThis.AtriumLibrary;
  const ui = () => L().ui;
  const n = (k, one, many = one + "s") => k.toLocaleString("en") + " " + (k === 1 ? one : many);
  // The official KiCad libraries (CC-BY-SA 4.0 with the KiCad libraries exception), as GitLab archives.
  // The request carries no cookies, no referrer and no custom headers.
  const KICAD = Object.freeze({id: "kicad-official", name: "KiCad libraries", root: "gitlab.com/kicad/libraries", licence: "CC-BY-SA-4.0 WITH KiCad-libraries-exception",
    licenceUrl: "https://www.kicad.org/libraries/license/",
    archives: {symbols: "https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-symbols/repository/archive.zip?sha=master",
      footprints: "https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-footprints/repository/archive.zip?sha=master"}, maxBytes: 512 << 20});
  const status = (ctx, text) => ctx?.info?.(text);
  // Plain counts for people; the read/parsed/timing detail stays in lib.stats for tests and MCP.
  const summary = (lib, stats) => n(lib.defs.length, "component") + (stats ? " from " + n(stats.listed, "file") + (stats.read ? "" : " · no changes") : "");

  // ------------------------------------------------------------------ folders
  // Source names are available synchronously. Only a selected source or a project link
  // needs its persisted catalogue. A directory listing is reserved for Add and Rescan.
  function restore(ids = []) {
    for (const id of new Set(ids)) S().openMetadata(id)?.catch(() => {});
  }
  function pickFolder() {
    return new Promise(resolve => {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.webkitdirectory = true; input.setAttribute("webkitdirectory", "");
      input.hidden = true;
      input.onchange = () => { resolve([...(input.files || [])]); input.remove(); };
      input.addEventListener("cancel", () => { resolve(null); input.remove(); });
      document.body.append(input); input.click();
    });
  }
  async function chooseFolder(writable = false) {
    const host = globalThis.AtriumHost;
    if (host?.chooseLibraryFolder) {
      const picked = await host.chooseLibraryFolder(writable ? "write" : "read");
      if (!picked) return null;
      const {grant, name} = picked, id = S().hid("native-folder", grant);
      return {rec: {id, name, kind: "native", root: name, grant, writable}, provider: S().providers.nativeFolder(grant, writable)};
    }
    if (typeof globalThis.showDirectoryPicker === "function") {
      const handle = await showDirectoryPicker({id: "atrium-library", mode: writable ? "readwrite" : "read"});
      const id = S().hid("directory", handle.name, Date.now());
      await S().db.set("handles", id, handle);
      return {rec: {id, name: handle.name, kind: "directory", root: handle.name, writable}, provider: S().providers.directoryHandle(handle)};
    }
    if (writable) throw Error("Saving to a folder is unavailable here.");
    const files = await pickFolder();
    if (!files?.length) return null;
    const top = String(files[0].webkitRelativePath || files[0].name).split("/")[0] || "Library folder";
    return {rec: {id: S().hid("files", top, Date.now()), name: top, kind: "files", root: top}, provider: S().providers.fileList(files)};
  }
  async function addFolder(ctx, o = {}) {
    try {
      const picked = await chooseFolder();
      if (!picked) return null;
      S().addFolder(picked.rec);
      return await scanWithProgress(ctx, picked.rec, picked.provider, o);
    } catch (e) { if (e?.name !== "AbortError") status(ctx, e.message); return null; }
  }
  async function scanWithProgress(ctx, rec, provider, o = {}) {
    try {
      const scan = S().scan(rec, {provider});
      o.started?.(S().library(rec.id)?.id || rec.libraryId || rec.id);
      const r = await scan;
      if (!r) { status(ctx, rec.name + ": nothing to index."); return null; }
      status(ctx, rec.name + ": " + summary(r.library, r.stats) + (r.library.report.errors.length ? " · " + n(r.library.report.errors.length, "file") + " could not be read" : ""));
      o.done?.(r.library.id);
      return r.library;
    } catch (e) {
      status(ctx, e?.name === "AbortError" ? "Library indexing stopped." : rec.name + " — " + e.message);
      return null;
    }
  }
  function sourceNotice(host, lib, focusStop = false) {
    const U = ui(), el = U.el, scan = lib.scan;
    if (scan) {
      host.append(el("span", scan.phase === "list" ? "Reading library folder…" : scan.phase === "prepare" ? "Preparing component search…" :
        "Indexing " + lib.name + "… " + scan.done.toLocaleString("en") + " of " + scan.total.toLocaleString("en") + " files"));
      if (scan.total && scan.phase === "read") {
        const bar = el("progress"); bar.max = scan.total; bar.value = scan.done;
        bar.setAttribute("aria-label", "Library indexing progress"); host.append(bar);
      }
      const stop = U.button("Stop indexing", () => S().cancelScan(lib.folder), "lib-mini");
      host.append(stop);
      if (focusStop) stop.focus();
    } else if (lib.scanError) host.append(el("span", lib.scanError));
    if (lib.folder === KICAD.id) host.append(kiCadCredit());
    host.hidden = !host.children.length;
  }
  function kiCadCredit() {
    const el = ui().el, line = el("span", null, "lib-credit");
    const link = el("a", "CC-BY-SA 4.0 with the KiCad libraries exception");
    link.href = KICAD.licenceUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.onclick = e => {
      if (globalThis.AtriumHost?.openKiCadLicence) {
        e.preventDefault();
        globalThis.AtriumHost.openKiCadLicence();
      }
    };
    line.append(el("span", "KiCad library contributors · "), link);
    return line;
  }
  async function rescan(ctx, lib, o = {}) {
    const rec = S().folders().find(f => f.id === lib.folder);
    if (!rec) return null;
    if (rec.kind === "files") {
      const files = await pickFolder();
      if (!files?.length) return null;
      return scanWithProgress(ctx, rec, S().providers.fileList(files), o);
    }
    if (rec.kind === "directory") {
      const h = await S().db.get("handles", rec.id);
      if (h?.requestPermission && (await h.requestPermission({mode: "read"})) !== "granted") { status(ctx, "Waffle may not read " + rec.name + "."); return null; }
      if (h) return scanWithProgress(ctx, rec, null, o);
    }
    return scanWithProgress(ctx, rec, null, o);
  }
  function folderDetail(ctx, host, lib, o = {}) {
    const el = ui().el, rec = S().folders().find(f => f.id === lib.folder), r = lib.report || {};
    const box = el("div", null, "lib-folder");
    const facts = el("dl", null, "lib-facts"), add = (k, v) => { if (v !== "" && v != null) facts.append(el("dt", k), el("dd", String(v))); };
    add("Folder", rec?.root || lib.path || "—");
    add("Components", lib.defs.length.toLocaleString("en"));
    if (r.paired || r.symbolOnly || r.footprintOnly) add("Paired", n(r.paired || 0, "symbol") + " with footprints · " + (r.symbolOnly || 0) + " symbol only · " + n(r.footprintOnly || 0, "footprint") + " only");
    if (lib.stats) add("Last scan", summary(lib, lib.stats));
    if (lib.offline) add("Files", "Not read in this session. Rescan to read the folder again.");
    box.append(facts);
    if (lib.attribution && !lib.scan) {
      const licences = el("details"); licences.append(el("summary", "Downloaded licence notices"));
      for (const [kind, a] of Object.entries(lib.attribution)) {
        licences.append(el("strong", "KiCad " + kind), el("pre", a.licenceText));
      }
      box.append(licences);
    }
    if (r.tableMissing?.length && !lib.scan) {
      const d = el("details"); d.append(el("summary", "Library table entries outside this folder or missing"));
      const ul = el("ul"); for (const x of r.tableMissing) ul.append(el("li", x.table + " · " + x.nickname));
      d.append(ul); box.append(d);
    }
    if (r.errors?.length && !lib.scan) {
      const d = el("details"); d.append(el("summary", n(r.errors.length, "file") + " could not be read"));
      const ul = el("ul"); for (const x of r.errors.slice(0, 50)) ul.append(el("li", x.file + " — " + x.message)); d.append(ul); box.append(d);
    }
    if (r.unmatched?.length && !lib.scan) {
      const d = el("details"); d.append(el("summary", n(r.unmatched.length, "symbol") + (r.unmatched.length === 1 ? " names a footprint" : " name footprints") + " not in this folder"));
      const ul = el("ul"); for (const x of r.unmatched.slice(0, 50)) ul.append(el("li", x.symbol + " → " + x.footprint)); d.append(ul); box.append(d);
    }
    const acts = el("div", null, "lib-detail-actions");
    if (!lib.scan) acts.append(ui().button(rec?.kind === "zip" ? "Download again…" : "Rescan", () => (rec?.kind === "zip" ? getKiCad(ctx, o) : rescan(ctx, lib, o)), "lib-mini"),
      ui().button("Remove folder", () => S().removeFolder(lib.folder).then(() => { status(ctx, lib.name + " removed from the Library panel. Its files were not touched."); o.done?.(null); }), "lib-mini"));
    box.append(acts);
    host.append(box);
  }

  function saveToFolder(ctx, def, done) {
    const U = ui(), d = U.dialog("Save to folder", "lib-small"), select = U.el("select"), abort = new AbortController();
    d.addEventListener("close", () => abort.abort());
    const owner = ctx.currentProject ? ctx.currentProject() : ctx.project, revision = ctx.revision?.();
    const currentProject = () => d.open && (!ctx.currentProject || ctx.currentProject() === owner) &&
      revision === ctx.revision?.() && owner.library.find(x => x.id === def.id) === def;
    select.setAttribute("aria-label", "Library folder");
    const writable = S().folders().filter(f => f.writable || f.kind === "directory");
    for (const f of writable) select.add(new Option(f.name, f.id));
    select.add(new Option("Choose a folder…", "@new"));
    const foot = U.el("div", null, "lib-actions"), message = U.el("p", "", "fe-note");
    message.setAttribute("role", "status");
    const go = U.button("Save", async () => {
      go.disabled = true;
      try {
        let rec = writable.find(f => f.id === select.value), provider;
        if (!rec) {
          const picked = await chooseFolder(true);
          if (!picked) return;
          ({rec, provider} = picked); S().addFolder(rec);
        } else if (rec.kind === "directory") {
          const handle = await S().db.get("handles", rec.id);
          if (!handle || (handle.requestPermission && await handle.requestPermission({mode: "readwrite"}) !== "granted")) {
            throw Error("Choose a folder Waffle may write to.");
          }
          rec = {...rec, writable: true}; S().addFolder(rec);
          provider = S().providers.directoryHandle(handle);
        }
        if (!d.open) return;
        const current = S().library(rec.id);
        const lib = !provider && current && !current.scan && !current.offline ? current :
          (await S().scan(rec, {provider, signal: abort.signal})).library;
        if (!d.open) return;
        if (!currentProject()) throw Error("The project changed. Reopen Save to folder from the current component.");
        const saved = await S().save(lib, def, owner, currentProject);
        d.close(); status(ctx, def.name + " saved in " + rec.name + " · revision " + saved.rev); done?.();
      } catch (e) { if (e?.name !== "AbortError") message.textContent = e.message; }
      finally { go.disabled = false; }
    }, "lib-primary");
    foot.append(U.button("Cancel", () => d.close()), go);
    d.append(U.label("Library folder", select), message, foot); U.show(d);
    return d;
  }

  async function modelFolders() {
    const M = globalThis.AtriumKiCadModels || await globalThis.AtriumLazy.need("AtriumKiCadModels");
    const U = ui(), d = U.dialog("KiCad 3D model folders", "lib-small");
    const body = U.el("div", null, "lib-diff"), list = U.el("ul");
    const variable = U.el("input");
    variable.placeholder = "For example, KICAD10_3DMODEL_DIR";
    variable.spellcheck = false;
    const message = U.el("p", "", "fe-note");
    message.setAttribute("role", "status");
    const render = () => {
      list.replaceChildren();
      for (const [key, f] of M.list()) {
        const li = U.el("li", (key === "*" ? "All versions" : key) + " · " + f.name + " ");
        li.append(U.button("Remove", async () => { await M.remove(key); render(); }, "lib-mini")); list.append(li);
      }
    };
    body.append(U.el("p", "Choose the folder that contains the KiCad .3dshapes folders. Leave the variable blank to use it for all versions."),
      U.label("KiCad path variable (optional)", variable), list, message);
    const foot = U.el("div", null, "lib-actions");
    foot.append(U.button("Done", () => d.close()), U.button("Choose folder…", async () => {
      try { if (await M.choose(variable.value.trim().toUpperCase() || "*")) render(); message.textContent = ""; }
      catch (e) { if (e?.name !== "AbortError") message.textContent = e.message; }
    }, "lib-primary"));
    d.append(body, foot); U.show(d); render();
  }

  // ------------------------------------------------------------------ import (pairing review)
  function pickFiles(accept) {
    return new Promise(resolve => {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.accept = accept; input.hidden = true;
      input.onchange = () => { resolve([...(input.files || [])]); input.remove(); };
      input.addEventListener("cancel", () => { resolve(null); input.remove(); });
      document.body.append(input); input.click();
    });
  }
  // Files [{name, path?, bytes}] -> {library, report} with KiCad and Altium pairs each inside their own files.
  async function pairFiles(files, project) {
    const kicad = files.filter(f => /\.kicad_(sym|mod)$/i.test(f.name)), altium = files.filter(f => /\.(schlib|pcblib)$/i.test(f.name));
    const client = globalThis.AtriumTranslatorClient || await AtriumLazy.need("AtriumTranslatorClient");
    const projection = globalThis.AtriumTranslatorProvenance || await AtriumLazy.need("AtriumTranslatorProvenance");
    const existing = projection.toLegacy({documents:[],library:project.library.map(d => ({id:d.id,...(d.source ? {source:d.source} : {})}))},
      globalThis.AtriumImportReports?.provenance()).library;
    const out = {library:[],translations:[],report:{components:0,paired:0,symbolOnly:0,footprintOnly:0,mismatches:[],unmatched:[],ambiguous:[],notes:[]}};
    for (const [translator,group] of [["kicad",kicad],["altium",altium]]) {
      if (!group.length) continue;
      // Full desktop paths are used only to look up installation-held licence notices.
      // The decoder receives the selected bytes and portable relative names.
      const exact = group.map(f => ({name:f.name,bytes:f.bytes,...(f.path && !/^(?:[\\/]|[a-z]:)/i.test(f.path) ? {path:f.path} : {})}));
      const result = await client.import(exact,{translator,role:"library",existing});
      const summary = result.provenance.pairing;
      if (!summary) throw Error("The library import did not return its pairing report.");
      if (translator === "kicad") {
        const credits = new Map();
        for (const [i,f] of group.entries()) {
          const path = String(f.path || f.name).replace(/\\/g,"/"), dir = path.slice(0,path.lastIndexOf("/"));
          const kind = /\.kicad_sym$/i.test(f.name) ? "symbols" : "footprints";
          const credit = S().installationCredit(dir,f.name,kind);
          if (credit) credits.set(result.provenance.files[i].sha256,credit);
        }
        for (const row of result.provenance.fields || []) if (row.type === "library" && row.values.source) {
          const src = row.values.source, fp = src.kind === "kicad-footprint" ? src : src.footprint;
          row.values.source = L().portableSource({source:src},{symbols:credits.get(src.sha256),footprints:credits.get(fp?.sha256)});
        }
      }
      out.library.push(...result.model.library);
      out.translations.push(result);
      for (const k of ["components","paired","symbolOnly","footprintOnly"]) out.report[k] += summary[k] || 0;
      for (const k of ["mismatches","unmatched","ambiguous","notes"]) out.report[k].push(...(summary[k] || []));
    }
    return out;
  }
  async function importFiles(ctx, o = {}) {
    const owner = ctx.currentProject ? ctx.currentProject() : ctx.project, revision = ctx.revision?.();
    const picked = o.files || await pickFiles(".kicad_sym,.kicad_mod,.SchLib,.schlib,.PcbLib,.pcblib");
    if (!picked?.length) return null;
    const files = [];
    for (const f of picked) {
      const bytes = typeof f.bytes === "function" ? await f.bytes() : f.bytes || new Uint8Array(await f.arrayBuffer());
      files.push({name: f.name, path: f.webkitRelativePath || f.path || f.name, bytes});
    }
    let result;
    try { result = await pairFiles(files, owner); } catch (e) { status(ctx, e.message); return null; }
    if (ctx.currentProject && ctx.currentProject() !== owner || revision !== ctx.revision?.()) { status(ctx, "The project changed. Reopen Import library files."); return null; }
    return review(ctx, result, o);
  }
  // The pairing report as a table; nothing joins the project until Add.
  function review(ctx, {library, report, translations = []}, o = {}) {
    const U = ui(), el = U.el, d = U.dialog("Import library components", "lib-small lib-import");
    const owner = ctx.currentProject ? ctx.currentProject() : ctx.project, revision = ctx.revision?.();
    const body = el("div", null, "lib-diff");
    body.append(el("p", n(library.length, "component") + ": " + report.paired + " paired, " + report.symbolOnly + " symbol only, " + report.footprintOnly + " footprint only. Every component starts as a draft.", "fe-note"));
    const notes = el("ul"); for (const t of report.notes) notes.append(el("li", t)); body.append(notes);
    const table = el("table", null, "lib-import-table"), head = el("tr");
    for (const t of ["", "Component", "Symbol", "Footprint", "Pins / pads"]) head.append(el("th", t));
    const thead = el("thead"); thead.append(head); table.append(thead);
    const tbody = el("tbody"), checks = [];
    const mismatch = new Map(report.mismatches.map(m => [m.name, m]));
    for (const def of library.slice(0, 2000)) {
      const tr = el("tr"), box = el("input"); box.type = "checkbox"; box.checked = true; box.setAttribute("aria-label", "Add " + def.name); checks.push([box, def]);
      const c0 = el("td"); c0.append(box);
      const m = mismatch.get(def.name), pins = def.symbol?.pins?.length || 0, pads = def.footprint?.pads?.length || 0;
      const fit = el("td", (pins || "–") + " / " + (pads || "–") + (m ? " · " + [m.noPad.length ? "pins without pads " + m.noPad.join(", ") : "", m.noPin.length ? "pads without pins " + m.noPin.join(", ") : ""].filter(Boolean).join("; ") : ""));
      if (m) fit.className = "lib-warning";
      tr.append(c0, el("td", def.name), el("td", def.symbol ? "yes" : "—"), el("td", def.footprint?.name || (def.footprintName ? def.footprintName + " (not found)" : "—")), fit);
      tbody.append(tr);
    }
    table.append(tbody); body.append(table);
    if (library.length > 2000) body.append(el("p", (library.length - 2000) + " more are added with the first 2,000.", "fe-note"));
    const foot = el("div", null, "lib-actions"), addBtn = U.button("Add " + n(library.length, "component"), null, "lib-primary");
    const chosen = () => [...checks.filter(([b]) => b.checked).map(([, def]) => def), ...library.slice(2000)];
    for (const [b] of checks) b.onchange = () => { addBtn.textContent = "Add " + n(chosen().length, "component"); addBtn.disabled = !chosen().length; };
    addBtn.onclick = async () => {
      const defs = chosen(), project = ctx.currentProject ? ctx.currentProject() : ctx.project;
      try {
        if (owner !== project || revision !== ctx.revision?.()) throw Error("The project changed. Reopen Import library files.");
        ctx.edit(() => { for (const def of defs) { project.library.push(def); globalThis.AtriumLibraryStore?.hoist(project, def); } });
        status(ctx, n(defs.length, "component") + " added to the project library as drafts.");
        d.close(); o.done?.("project");
        const h = globalThis.AtriumNavHost, session = h?.fileSession?.(), selected = new Set(defs.map(def => def.id));
        for (const result of translations) if (result.model.library.some(def => selected.has(def.id))) {
          if (session !== h?.fileSession?.() || (ctx.currentProject && ctx.currentProject() !== owner)) break;
          const original = result.provenance;
          const provenance = {...original,fields:original.fields.filter(row => row.type === "library" && selected.has(row.id)),
            files:original.files.map(f => ({...f,library:f.library.filter(id => selected.has(id))}))};
          if (original.bodies) provenance.bodies = original.bodies.filter(row => row.type === "library" && selected.has(row.id));
          const total = result.model.library.length, added = result.model.library.filter(def => selected.has(def.id)).length;
          const report = added === total ? result.report : {...result.report,notes:[...result.report.notes,"Added " + added + " of " + total + " translated library entries from this selection."]};
          await h?.showImportReport?.({...result,provenance,report},[],original.files.map(f => f.name));
        }
      } catch (e) { status(ctx, e.message); }
    };
    if (!library.length) addBtn.disabled = true;
    foot.append(U.button("Cancel", () => d.close()), addBtn);
    d.append(body, foot); U.show(d);
    return d;
  }

  // ------------------------------------------------------------------ KiCad download (explicit request only)
  async function download(url, onProgress, signal) {
    const res = await fetch(url, {credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "follow", signal});
    if (!res.ok) throw Error("The download failed (HTTP " + res.status + ").");
    const total = +res.headers.get("content-length") || 0;
    if (total > KICAD.maxBytes) throw Error("The archive is larger than expected.");
    if (!res.body?.getReader) { const b = new Uint8Array(await res.arrayBuffer()); if (b.length > KICAD.maxBytes) throw Error("The archive is larger than expected."); return b; }
    const reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      got += value.length;
      if (got > KICAD.maxBytes) { reader.cancel(); throw Error("The archive is larger than expected."); }
      parts.push(value); onProgress?.(got, total);
    }
    const out = new Uint8Array(got);
    let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  function getKiCad(ctx, o = {}) {
    const U = ui(), el = U.el, d = U.dialog("Get KiCad libraries", "lib-small");
    const body = el("div", null, "lib-diff");
    body.append(el("p", "Waffle can download the official KiCad symbol and footprint libraries (kicad-symbols and kicad-footprints, about 60 MB) from gitlab.com and show them as a folder library in the Library panel."),
      kiCadCredit(), el("p", "You can use the libraries in your designs without licensing the design files under CC-BY-SA. The licence and attribution apply when you share the library parts themselves."),
      el("p", "Waffle stores the downloads and their licence notices outside your projects. The download sends no account or project information.", "fe-note"));
    const progress = el("p", "", "fe-note"); progress.setAttribute("role", "status");
    body.append(progress);
    const foot = el("div", null, "lib-actions"), abort = new AbortController();
    const go = U.button("Download", null, "lib-primary");
    let indexing = false;
    d.addEventListener("close", () => { if (!indexing) abort.abort(); });
    go.onclick = async () => {
      go.disabled = true;
      try {
        const zips = {};
        for (const [key, url] of Object.entries(KICAD.archives)) {
          zips[key] = await download(url, (got, total) => { progress.textContent = "Downloading kicad-" + key + "… " + (got / 1e6).toFixed(1) + (total ? " of " + (total / 1e6).toFixed(1) : "") + " MB"; }, abort.signal);
        }
        const blobs = Object.fromEntries(Object.entries(zips).map(([k, b]) => [k, new Blob([b], {type: "application/zip"})]));
        const rec = {id: KICAD.id, name: KICAD.name, kind: "zip", root: KICAD.root, libraryId: KICAD.id};
        const provider = S().providers.archiveProvider(blobs);
        S().addFolder(rec);
        const scan = S().scan(rec, {provider});
        o.started?.(rec.id);
        indexing = true; d.close();
        const r = await scan;
        const kept = await S().db.set("archives", KICAD.id, {blobs, notices: r.library.attribution});
        status(ctx, KICAD.name + ": " + summary(r.library, r.stats) + (kept ? "" : " · available for this session"));
        o.done?.(r.library.id);
      } catch (e) {
        if (indexing) {
          status(ctx, e?.name === "AbortError" ? "Library indexing stopped." : e.message);
          return;
        }
        if (e?.name === "AbortError") return;
        progress.textContent = e.message; progress.className = "lib-error"; go.disabled = false;
      }
    };
    foot.append(U.button("Cancel", () => d.close()), go);
    d.append(body, foot); U.show(d);
    return d;
  }
  return Object.freeze({KICAD, restore, addFolder, rescan, folderDetail, sourceNotice, saveToFolder, modelFolders, importFiles, pairFiles, review, getKiCad, download});
})();
