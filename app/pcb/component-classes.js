"use strict";
// Component classes: named groups of board components, as Altium's component classes.
//
// Stored on the board document, outside doc.items:
//   doc.componentClasses = {ClassName: [designator, ...]}     user-defined classes
// Generated on the fly (never stored), merged by name with the user classes:
//   sheet      one class per schematic sheet, named after the sheet, holding the board parts
//              linked to its parts (part.link, or the schematic link before "@" for channels)
//   room       one class per room, named after the room (rooms.js membership)
//   parameter  the ComponentClass parameter of a part (board part, linked schematic part or
//              its library definition); a comma or semicolon separated value names several
//
// Rules scope them with InComponentClass('Name') (rules.js "componentclass" scope): clearance,
// DFA spacing, placement and room membership (rooms.js room.componentClass) all match on the
// component designator. The selection filter and Find Similar use classesOf().
//
// Model functions are DOM-free. install(host) adds Design → Classes… and the selection filter.
globalThis.AtriumComponentClasses = (() => {
  const A = () => globalThis.Atrium;
  const MAX_CLASSES = 2048, MAX_MEMBERS = 20000, MAX_NAME = 200;
  const PARAM = /^component[ _]?class$/i;
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = v => typeof v === "string";
  // One collator (localeCompare with options builds one per call: ~10x slower over a board's designators).
  const collator = typeof Intl === "object" && Intl.Collator ? new Intl.Collator(undefined, {numeric: true}) : null;
  const natural = collator ? (a, b) => collator.compare(String(a), String(b)) : (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true});
  const validName = s => str(s) && !!s.trim() && s === s.trim() && s.length <= MAX_NAME && !/[\u0000-\u001f']/.test(s);

  // ------------------------------------------------------------------ model
  function validate(cc, invalid = () => { throw Error("This file is not a supported Waffle project."); }) {
    if (!obj(cc)) invalid();
    const names = Object.keys(cc);
    if (names.length > MAX_CLASSES) invalid();
    for (const n of names) {
      const v = cc[n];
      if (!validName(n) || !Array.isArray(v) || v.length > MAX_MEMBERS || !v.every(r => str(r) && r.length <= 200)) invalid();
    }
    return cc;
  }
  const parts = doc => (doc?.items || []).filter(i => i.kind === "part" && str(i.ref) && i.ref);
  const linkKey = l => str(l) ? l.split("@")[0] : "";
  function paramClasses(...sources) {
    const out = [];
    for (const s of sources) {
      if (!obj(s)) continue;
      for (const [k, v] of Object.entries(s)) if (PARAM.test(k) && (str(v) || typeof v === "number"))
        for (const name of String(v).split(/[,;]/).map(x => x.trim()).filter(Boolean)) if (validName(name)) out.push(name);
    }
    return out;
  }
  // Every class on the board: [{name, source:"user"|"sheet"|"room"|"parameter", members:[ref]}]
  // sorted by name. o.rooms === false leaves room classes out (rooms.js asks that way, so a room
  // scoped by a class never depends on itself). o.auto === false gives the user classes only.
  function list(doc, project, o = {}) {
    if (!doc || doc.kind !== "pcb") return [];
    const out = [], defs = o.defs || new Map((project?.library || []).map(d => [d.id, d]));
    const refs = new Set(parts(doc).map(p => p.ref));
    for (const [name, members] of Object.entries(obj(doc.componentClasses) ? doc.componentClasses : {}))
      out.push({name, source: "user", members: [...new Set(members)].sort(natural)});
    if (o.auto === false) return out.sort((a, b) => natural(a.name, b.name));
    // Schematic parts by link: their sheet and their parameters.
    const sheetOf = new Map(), schPart = new Map();
    for (const d of project?.documents || []) if (d.kind === "schematic") for (const p of d.items) if (p.kind === "part" && str(p.link)) {
      if (!sheetOf.has(p.link)) sheetOf.set(p.link, d.name); if (!schPart.has(p.link)) schPart.set(p.link, p);
    }
    const sheets = new Map(), params = new Map();
    for (const p of parts(doc)) {
      const key = linkKey(p.link), sheet = sheetOf.get(key);
      if (sheet) { if (!sheets.has(sheet)) sheets.set(sheet, new Set()); sheets.get(sheet).add(p.ref); }
      const sp = schPart.get(key);
      for (const name of new Set(paramClasses(defs.get(p.def)?.parameters, sp ? defs.get(sp.def)?.parameters : null, sp?.parameters, p.parameters))) {
        if (!params.has(name)) params.set(name, new Set()); params.get(name).add(p.ref);
      }
    }
    // o.order === false: members unordered (map() and names() only test membership).
    const sorted = s => o.order === false ? [...s] : [...s].sort(natural);
    for (const [name, s] of sheets) out.push({name, source: "sheet", members: sorted(s)});
    for (const [name, s] of params) out.push({name, source: "parameter", members: sorted(s)});
    const R = globalThis.AtriumRooms;
    if (o.rooms !== false && R) {
      const roomClasses = new Map(), rooms = R.list(doc);
      for (const room of rooms) if (room.componentClass) roomClasses.set(room.componentClass, new Set());
      for (const group of out) {
        const members = roomClasses.get(group.name);
        if (members) for (const ref of group.members) members.add(ref);
      }
      for (const room of rooms) {
        let m = [];
        try { m = R.members(doc, room, roomClasses.get(room.componentClass)).map(p => p.ref).filter(r => refs.has(r)); } catch { m = []; }
        out.push({name: room.name, source: "room", members: sorted(new Set(m))});
      }
    }
    return out.sort((a, b) => natural(a.name, b.name) || a.source.localeCompare(b.source));
  }
  // Name -> Set of designators (classes of one name from several sources are merged).
  function map(doc, project, o = {}) {
    const m = new Map();
    for (const c of list(doc, project, {...o, order: false})) { if (!m.has(c.name)) m.set(c.name, new Set()); for (const r of c.members) m.get(c.name).add(r); }
    return m;
  }
  const names = (doc, project, o) => [...map(doc, project, o).keys()];
  const has = (doc, project, name, ref, o) => !!map(doc, project, o).get(name)?.has(ref);
  function classesOf(doc, project, ref, o) {
    const out = [];
    for (const [name, s] of map(doc, project, o)) if (s.has(ref)) out.push(name);
    return out;
  }
  // Edits (user classes only). All return the board's class store.
  function store(doc) { if (!obj(doc.componentClasses)) doc.componentClasses = {}; return doc.componentClasses; }
  function tidy(doc) { if (obj(doc.componentClasses) && !Object.keys(doc.componentClasses).length) delete doc.componentClasses; return doc.componentClasses || {}; }
  function set(doc, name, refs) {
    if (doc?.kind !== "pcb") throw Error("Component classes belong to a board layout.");
    if (!validName(name)) throw Error("Give a class name of 1 to " + MAX_NAME + " characters, without quotes.");
    const s = store(doc), have = new Set(parts(doc).map(p => p.ref)), list = [...new Set((refs || []).map(String))];
    const unknown = list.filter(r => !have.has(r));
    if (unknown.length) throw Error("This board has no component " + unknown.slice(0, 5).join(", ") + ".");
    if (!Object.hasOwn(s, name) && Object.keys(s).length >= MAX_CLASSES) throw Error("A board holds at most " + MAX_CLASSES + " component classes.");
    s[name] = list.sort(natural);
    return s;
  }
  function add(doc, name, refs) { const cur = obj(doc.componentClasses) && doc.componentClasses[name] || []; return set(doc, name, [...cur, ...refs]); }
  function removeMembers(doc, name, refs) { const drop = new Set(refs); return set(doc, name, (doc.componentClasses?.[name] || []).filter(r => !drop.has(r))); }
  function remove(doc, name) {
    if (!obj(doc.componentClasses) || !Object.hasOwn(doc.componentClasses, name)) throw Error("No user-defined component class " + name + ".");
    delete doc.componentClasses[name]; return tidy(doc);
  }
  const mentionsClass = scope => scope?.languageVersion === 1 && /\bclass\b/i.test(scope.source);
  const hasClassScopes = project => project?.rules?.list?.some(r => mentionsClass(r.scope) || mentionsClass(r.scope2));
  function renameRuleScope(scope, from, to, boardId) {
    if (!mentionsClass(scope)) return scope;
    // @ts-ignore Node loads the public parser only for a real name-bearing native scope.
    if (!globalThis.AtriumDesignQuery && typeof require === "function") require("../checks/design-query.js");
    const parsed = globalThis.AtriumDesignQuery.parse(scope.source), spans = [];
    if (!parsed.ok) return scope;
    function collect(node) {
      if (!node) return;
      if (node.type === "relation" && node.family === "componentclass" && node.name === from) {
        const [start,end] = node.nameSpan;
        const bound = scope.bindings?.find(b => b.span[0] === start && b.span[1] === end);
        if (!bound?.target?.docId || bound.target.docId === boardId) spans.push(node.nameSpan);
      }
      if (node.arg) collect(node.arg);
      if (node.args) node.args.forEach(collect);
    }
    collect(parsed.ast);
    if (!spans.length) return scope;
    const name = JSON.stringify(to);
    let source = "", offset = 0;
    for (const [start,end] of spans) {
      source += scope.source.slice(offset,start) + name;
      offset = end;
    }
    source += scope.source.slice(offset);
    const edited = {...scope,source};
    if (scope.bindings) edited.bindings = scope.bindings.map(binding => {
      const [a,b] = binding.span;
      let shift = 0;
      for (const [start,end] of spans) {
        if (end <= a) shift += name.length - (end - start);
        else if (b <= start) break;
        else if (a === start && b === end) return {...binding,name:to,span:[a+shift,a+shift+name.length]};
        else throw Error("Rebind the overlapping rule reference before renaming this component class.");
      }
      return shift ? {...binding,span:[a+shift,b+shift]} : binding;
    });
    return globalThis.AtriumDesignQueryRecord.copy(edited);
  }
  function rename(doc, from, to, project = globalThis.AtriumSignals?.projectOf?.(doc)) {
    if (!validName(to)) throw Error("Give a class name of 1 to " + MAX_NAME + " characters, without quotes.");
    const s = store(doc);
    if (!Object.hasOwn(s, from)) throw Error("No user-defined component class " + from + ".");
    if (from !== to && Object.hasOwn(s, to)) throw Error("A class named " + to + " already exists.");
    if (from === to) return s;
    const book = project?.rules;
    if (hasClassScopes(project)) {
      // @ts-ignore CommonJS consumers can request component classes independently of the rule editor.
      if (!globalThis.AtriumProjectRules && typeof require === "function") for (const name of ["checks/rules","checks/project-rules"]) require("../"+name+".js");
      const P = globalThis.AtriumProjectRules;
      if (!P) throw Error("Load design rules before renaming a class used by the project.");
      const updated = new Map();
      for (const rule of book.list) {
        if (P.isErc(rule.type) || rule.where === "schematic" || !P.appliesToBoard(rule,doc.id)) continue;
        const first = renameRuleScope(rule.scope,from,to,doc.id), second = renameRuleScope(rule.scope2,from,to,doc.id);
        if (first !== rule.scope || second !== rule.scope2) updated.set(rule,{
          ...(first !== rule.scope ? {scope:first} : {}), ...(second !== rule.scope2 ? {scope2:second} : {})
        });
      }
      if (updated.size) P.edit(project,b => {
        b.list = b.list.flatMap((row,index) => {
          const patch = updated.get(book.list[index]);
          if (!patch) return [row];
          const changed = {...row,...patch};
          const shared = project.documents.some(d => d.kind === "pcb" && d.id !== doc.id && P.appliesToBoard(row,d.id));
          if (!shared) return [changed];
          const others = row.boards ? {...row,boards:row.boards.filter(id => id !== doc.id)} :
            {...row,exceptBoards:[...(row.exceptBoards || []),doc.id]};
          const local = {...changed,id:A().id(),boards:[doc.id]};
          delete local.exceptBoards;
          return [others,local];
        });
      });
    }
    const v = s[from]; delete s[from]; s[to] = v;
    for (const room of doc.rooms || []) if (room.componentClass === from) room.componentClass = to;
    return s;
  }
  // Designators renamed by annotation keep their class membership.
  function renameRefs(doc, mapping) {
    if (!obj(doc.componentClasses)) return;
    for (const k of Object.keys(doc.componentClasses)) doc.componentClasses[k] = doc.componentClasses[k].map(r => mapping[r] ?? r);
  }

  // ------------------------------------------------------------------ headless (MCP run_command component_classes)
  function headless(project, a = {}) {
    const doc = (a.document_id != null ? project.documents.find(d => d.id === a.document_id || d.name === a.document_id) : project.documents.find(d => d.kind === "pcb"));
    if (!doc) throw Error(a.document_id != null ? "The project has no document " + a.document_id + "." : "The project has no PCB layout.");
    if (doc.kind !== "pcb") throw Error("Choose a PCB document.");
    const op = a.op || "list";
    const rows = () => list(doc, project).map(c => ({name: c.name, source: c.source, members: c.members}));
    if (op === "list") return {document_id: doc.id, classes: rows()};
    if (op === "set") set(doc, a.name, a.designators || []);
    else if (op === "add") add(doc, a.name, a.designators || []);
    else if (op === "remove_members") removeMembers(doc, a.name, a.designators || []);
    else if (op === "delete") remove(doc, a.name);
    else if (op === "rename") rename(doc, a.name, a.new_name, project);
    else throw Error("Unknown component class operation " + op + ".");
    tidy(doc);
    return {document_id: doc.id, op, classes: rows()};
  }

  // ------------------------------------------------------------------ selection filter (pcb-edit.js)
  // One class narrows what can be selected on the board: its components and their pads.
  let H = null, filterClass = "", filterCache = null;
  function filterIds() {
    const doc = H?.doc?.();
    if (!filterClass || doc?.kind !== "pcb") return null;
    if (filterCache && filterCache.doc === doc && filterCache.items === doc.items && filterCache.n === doc.items.length && filterCache.cls === filterClass) return filterCache.ids;
    const refs = map(doc, H.project()).get(filterClass) || new Set();
    filterCache = {doc, items: doc.items, n: doc.items.length, cls: filterClass, ids: new Set(parts(doc).filter(p => refs.has(p.ref)).map(p => p.id))};
    return filterCache.ids;
  }
  // Parts outside the class are not selectable; other objects are unaffected.
  function allows(item) {
    if (item?.kind !== "part") return true;
    const ids = filterIds();
    return !ids || ids.has(item.id);
  }
  const filterValue = () => filterClass;
  function setFilter(name) { filterClass = name || ""; filterCache = null; }
  function filterControl(host, parent, changed) {
    H = H || host;
    const doc = host.doc?.();
    if (doc?.kind !== "pcb" || typeof document === "undefined") return null;
    const all = names(doc, host.project());
    if (!all.length && !filterClass) return null;
    const values = [["", "Any component class"], ...all];
    if (filterClass && !all.includes(filterClass)) values.push([filterClass, filterClass + " (not on this board)"]);
    const sel = host.field(parent, "Class", filterClass, name => {
      setFilter(name); changed?.();
    }, {values, allowEmpty:true});
    sel.setAttribute("aria-label", "Component class filter");
    sel.dataset.selectionKind = "component-class";
    return sel;
  }

  // ------------------------------------------------------------------ dialog (Design → Classes…)
  // The stylesheet loads with the first dialog (lazy.js loads scripts only for this module).
  function ensureCss() {
    if (typeof document === "undefined" || !document.head || document.querySelector?.('link[href="pcb/component-classes.css"]')) return;
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "pcb/component-classes.css"; document.head.append(l);
  }
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, click, cls) { const b = el("button", text, cls); b.classList.add("ui-button"); if (cls?.includes("is-primary")) b.dataset.variant = "primary"; b.type = "button"; b.onclick = click; return b; }
  const SOURCE = {user: "User-defined", sheet: "Sheet", room: "Room", parameter: "Parameter ComponentClass"};
  function open(host) {
    H = H || host; ensureCss();
    const doc = host.doc();
    if (doc?.kind !== "pcb") { host.info("Open a board layout to edit its component classes."); return null; }
    const d = el("dialog", null, "ui-dialog work-dialog cc-dialog"); d.setAttribute("aria-label", "Component Classes");
    const head = el("h2", "Component Classes", "ui-dialog-title");
    const help = el("p", "Group components to scope rules with InComponentClass('Name'). Sheet, room and ComponentClass parameter classes are generated; user classes are stored with the board.", "cc-help");
    const body = el("div", null, "cc-body ui-dialog-body"), side = el("div", null, "ui-list cc-list"), pane = el("div", null, "cc-pane");
    side.setAttribute("role", "listbox"); side.setAttribute("aria-label", "Component classes");
    body.append(side, pane);
    const status = el("p", null, "cc-status"); status.setAttribute("role", "status");
    let current = null;
    const say = t => { status.textContent = t || ""; };
    const safe = fn => (...a) => { try { say(""); fn(...a); } catch (e) { say(e.message); } };
    const allRefs = () => parts(host.doc()).map(p => p.ref).sort(natural);
    function paint() {
      const rows = list(host.doc(), host.project());
      side.replaceChildren();
      if (current && !rows.some(r => r.name === current.name && r.source === current.source)) current = null;
      current = current || rows[0] || null;
      for (const c of rows) {
        // A library list row (.ui-row[role=option]): the class and where it comes from.
        const b = el("button", null, "ui-row cc-item"), text = el("span", null, "ui-row-text"); b.type = "button"; b.onclick = () => { current = c; paint(); };
        b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(current === c || current?.name === c.name && current?.source === c.source));
        text.append(el("span", c.name, "ui-row-title"), el("span", SOURCE[c.source] + " · " + c.members.length, "ui-row-detail")); b.append(text);
        side.append(b);
      }
      if (!rows.length) side.append(el("p", "No classes yet. Add one below.", "ui-empty cc-empty"));
      paintPane(rows.find(r => r.name === current?.name && r.source === current?.source) || null);
    }
    function paintPane(c) {
      pane.replaceChildren();
      if (!c) return;
      pane.append(el("h3", c.name), el("code", "InComponentClass('" + c.name + "')", "cc-query"));
      const user = c.source === "user";
      if (!user) pane.append(el("p", SOURCE[c.source] + " class: generated, read only. Make a user class to edit its members.", "cc-help"));
      const grid = el("div", null, "cc-members"), members = new Set(c.members);
      for (const ref of user ? allRefs() : c.members) {
        const l = el("label", null, "cc-member"), box = el("input", null, "ui-checkbox"); box.type = "checkbox"; box.checked = members.has(ref); box.disabled = !user;
        box.onchange = safe(() => { host.edit(() => box.checked ? add(host.doc(), c.name, [ref]) : removeMembers(host.doc(), c.name, [ref])); paint(); });
        l.append(box, document.createTextNode(" " + ref)); grid.append(l);
      }
      pane.append(grid);
      const tools = el("div", null, "cc-tools");
      if (user) {
        tools.append(button("Add selected components", safe(() => {
          const sel = new Set(host.selection()), refs = parts(host.doc()).filter(p => sel.has(p.id)).map(p => p.ref);
          if (!refs.length) throw Error("Select components on the board first.");
          host.edit(() => add(host.doc(), c.name, refs)); paint();
        })), button("Rename…", safe(() => {
          const to = globalThis.prompt?.("Rename component class", c.name); if (to == null || to === c.name) return;
          const doc = host.doc(), project = host.project(), value = to.trim();
          const commit = () => {
            if (host.doc() !== doc || host.project() !== project) return;
            host.edit(() => rename(doc,c.name,value,project)); current = {name:value,source:"user"}; paint();
          };
          if (hasClassScopes(project) && (!globalThis.AtriumProjectRules || !globalThis.AtriumDesignQuery) && globalThis.AtriumLazy)
            globalThis.AtriumLazy.need("AtriumRules").then(commit).catch(e => say(e.message));
          else commit();
        })), button("Delete", safe(() => { host.edit(() => remove(host.doc(), c.name)); current = null; paint(); })));
      } else tools.append(button("Copy as user class", safe(() => {
        let name = c.name + " copy", n = 2; const taken = new Set(names(host.doc(), host.project()));
        while (taken.has(name)) name = c.name + " copy " + n++;
        host.edit(() => set(host.doc(), name, c.members)); current = {name, source: "user"}; paint();
      })));
      tools.append(button("Select members", () => {
        const refs = new Set(c.members); host.select(parts(host.doc()).filter(p => refs.has(p.ref)).map(p => p.id)); say(c.members.length + " components selected.");
      }));
      pane.append(tools);
    }
    const addRow = el("div", null, "cc-add"), input = el("input", null, "ui-field"); input.placeholder = "New class name"; input.setAttribute("aria-label", "New class name");
    const create = safe(() => {
      const name = input.value.trim();
      if (names(host.doc(), host.project()).includes(name)) throw Error("A class named " + name + " already exists.");
      const sel = new Set(host.selection()), refs = parts(host.doc()).filter(p => sel.has(p.id)).map(p => p.ref);
      host.edit(() => set(host.doc(), name, refs)); input.value = ""; current = {name, source: "user"}; paint();
      say(refs.length ? "Created " + name + " with the " + refs.length + " selected components." : "Created " + name + ". Tick its members.");
    });
    input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); create(); } };
    addRow.append(input, button("Add class", create));
    const foot = el("div", null, "work-actions ui-dialog-actions"), done = button("Done", () => d.close(), "is-primary");
    const rules = button("Rules…", () => { d.close(); host.act?.("rules"); });
    foot.append(rules, done);
    d.append(head, help, body, addRow, status, foot);
    document.body.append(d); d.addEventListener("close", () => { d.remove(); host.redraw?.(); }, {once: true});
    paint(); globalThis.AtriumShell?.adoptDialog?.(d, {initialFocus: input}); d.showModal(); input.focus();
    return d;
  }

  // ------------------------------------------------------------------ install
  let installed = false;
  function install(host) {
    H = host;
    host.registerAction("component-classes", () => open(host));
    if (installed) return;
    installed = true;
    globalThis.AtriumNavCommon?.menuItem?.("design", "component-classes", "Classes…", {after: "constraints", scope: "pcb"});
  }
  const boot = () => globalThis.AtriumNavCommon?.ready?.(install);
  if (globalThis.AtriumNavCommon) boot(); else if (globalThis.document?.addEventListener) document.addEventListener("DOMContentLoaded", boot, {once: true});

  return Object.freeze({validate, list, map, names, has, classesOf, set, add, removeMembers, remove, rename, renameRefs, headless,
    allows, setFilter, filterValue, filterControl, open, install, paramClasses});
})();
