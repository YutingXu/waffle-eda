"use strict";

globalThis.AtriumSchObjectInspector = (() => {
  // Net name fields complete as they are typed, in the project's style (naming.js; Tab takes the suggestion).
  const complete = (input, kind, c) => { if (input) globalThis.AtriumLazy?.need?.("AtriumNaming").then(N => N.attach(input, {kind, project: () => c.project()}), () => {}); };
  function ioField(s, item, c, field) {
    const {IO, offsheetIO} = globalThis.AtriumSchObjects;
    const off = Atrium.isOffsheet(item);
    field(s, "I/O type", offsheetIO(item.io), value => c.edit(() => {
      if (off && value === "unspecified") delete item.io;
      else {
        // Promote only on an explicit edit. Preserve the original record and its artwork.
        if (off) item.kind = "offsheet";
        item.io = value;
      }
    }), {options:IO.map(v => [v, v[0].toUpperCase() + v.slice(1)])});
  }
  const el=(...args)=>globalThis.AtriumSchObjects.toolHost.el(...args);
  // A property row (docs/ui-library.md › Property rows). A check is a switch; a unit suffix in the label,
  // as in "Width (mm)", moves from the caption into the field. The label stays the field's name.
  function defaultField(parent, label, value, update, opt = {}) {
    if (opt.check) return AtriumNavCommon.appendSwitchRow(parent, label, !!value, update);
    const m = / \(([^()]{1,4})\)$/.exec(label), l = el("label", null, "ui-prop-row"); l.append(el("span", m ? label.slice(0, m.index) : label));
    let input;
    if (opt.options) {input = el("select", null, "ui-field"); for (const [v, t] of opt.options) input.add(new Option(t, v)); input.value = value;}
    else if (opt.area) {input = el("textarea", null, "ui-field"); input.rows = 4; input.value = value ?? "";}
    else {input = el("input", null, "ui-field"); input.type = "text"; input.value = value ?? "";}
    input.setAttribute("aria-label", label);
    input.onchange = () => update(input.value);
    l.append(m && !opt.options ? AtriumNavCommon.measure(input, m[1]) : input); parent.append(l); return input;
  }
  // Web links. Altium's component Links are parameter pairs ComponentLink<N>URL and
  // ComponentLink<N>Description, and HelpURL is the part's help page; datasheet and supplier links
  // are ordinary parameters with an http(s) value. The parameters stay the record and export as
  // they are: Links lists them, labelled by their description or name, and opens each one in the
  // system browser. A schematic text's url (Altium's hyperlinked text) opens on Cmd/Ctrl+click.
  // Only http and https without credentials open, as for every external link (shell.js).
  function webURL(raw) {
    if (typeof raw !== "string" || raw.length > 2048 || !/^\s*https?:\/\//i.test(raw)) return "";
    try {const u = new URL(raw.trim()); return /^https?:$/.test(u.protocol) && u.hostname && !u.username && !u.password ? u.href : "";} catch {return "";}
  }
  function openURL(url) {
    const href = webURL(url), H = globalThis.AtriumHost;
    if (!href) return false;
    if (H?.openURL) Promise.resolve(H.openURL(href)).catch(() => {});
    else if (!H) globalThis.open?.(href, "_blank", "noopener,noreferrer");
    return true;
  }
  function linksOf(...bags) {
    const rows = bags.flatMap(bag => !bag || typeof bag !== "object" ? [] : Array.isArray(bag) ? bag.map(r => [r?.name, r?.value]) :
      Object.entries(bag).map(([k, v]) => [k, v && typeof v === "object" ? v.value : v])).filter(([k]) => typeof k === "string");
    const key = k => k.replace(/[\s_]+/g, "").toUpperCase(), titles = new Map(), out = [], seen = new Set();
    for (const [k, v] of rows) {
      const n = /^COMPONENTLINK(\d+)DESCRIPTION$/.exec(key(k))?.[1];
      if (n && typeof v === "string" && v.trim() && !titles.has(n)) titles.set(n, v.trim());
    }
    for (const [k, v] of rows) {
      const url = webURL(v), n = /^COMPONENTLINK(\d+)URL$/.exec(key(k))?.[1];
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({name: k, url, title: n ? titles.get(n) || "Link " + n : key(k) === "HELPURL" ? "Help" : k, order: n ? +n : key(k) === "HELPURL" ? 1e6 : 2e6});
    }
    // Altium's Links first, by number, then Help, then the other parameters by name: the same order
    // however the parameters are stored.
    return out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)).map(({order, ...link}) => link);
  }
  // A real text link (a[href]): shell.js opens it in the system browser on click, Enter or tap.
  function linkRow(el, {title, url, name = ""}) {
    const row = /** @type {HTMLAnchorElement} */ (el("a", null, "ui-row part-link")), text = el("span", null, "ui-row-text");
    const host = new URL(url).host, titleRow = el("span", null, "ui-row-title");
    row.href = url; row.title = url;
    row.setAttribute("aria-label", title + " (" + host + ")");
    titleRow.append(title, externalGlyph());
    text.append(titleRow, el("span", host + (name && name !== title ? " · " + name : ""), "ui-row-detail"));
    row.append(text);
    return row;
  }
  // An arrow leaving a box: the page opens outside Waffle.
  function externalGlyph() {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), path = document.createElementNS(ns, "path");
    svg.setAttribute("class", "icon"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    path.setAttribute("d", "M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4");
    svg.append(path); return svg;
  }
  // A part's links: its own and its library parameters, then on the other side of the design
  // the linked part's (a board footprint shows the links of its schematic symbol, as in Altium).
  function partLinks(panel, part, def, c, {el}) {
    const defs = c.defs?.(), other = [];
    for (const d of c.project()?.documents || []) if (d !== c.doc() && part.link)
      for (const i of d.items) if (i.kind === "part" && i.link === part.link) other.push(i.parameters, defs?.get(i.def)?.parameters);
    const links = linksOf(part.parameters, def?.parameters, ...other);
    if (!links.length) return;
    const s = el("section", null, "inspect-section"), list = el("div", null, "ui-list");
    list.setAttribute("role", "list"); list.setAttribute("aria-label", "Links");
    for (const link of links) list.append(linkRow(el, link));
    s.append(el("h3", "Links"), list); panel.append(s);
  }
  globalThis.document?.addEventListener?.("click", followText, true);
  globalThis.document?.addEventListener?.("contextmenu", e => {if (e.ctrlKey || e.metaKey) followText(e);}, true);
  function followText(e) {
    const h = globalThis.AtriumNavHost;
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0 && e.type !== "contextmenu" || e.target !== h?.canvas?.() || h.doc?.()?.kind !== "schematic" ||
      h.tool?.() && h.tool() !== "select") return;
    const r = e.target.getBoundingClientRect(), item = h.hitAt?.(h.view().screenToWorld([e.clientX - r.left, e.clientY - r.top]));
    if (item?.richText || !openURL(item?.url)) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }
  // c: {edit, info, project(), doc(), units:{parse,value,unit}, selectDocument, choose}
  function inspector(s, item, c, {el, button, field = defaultField, descend, grid}) {
    const A = globalThis.Atrium;
    const {POWER_TITLES, IO, SIDES, reflow, repeatOf, command, fitSymbol, make, entryWires} = globalThis.AtriumSchObjects;
    const edit = fn => c.edit(fn), project = c.project();
    const len = (label, key, obj = item, min = 0) => {const input=field(s, label + " (" + c.unit() + ")", A.units.value(obj[key], c.unit()), v => {
      const n = A.units.parse(v, c.unit()); if (!(n > min)) {c.info("Enter a length such as 0.25mm or 10mil."); return;} edit(() => {if (obj.widget && globalThis.AtriumSheetWidgets) {const [w,h]=AtriumSheetWidgets.size(obj.widget.type,key==="w"?n:obj.w,key==="h"?n:obj.h);obj.w=w;obj.h=h;} else if (obj.kind === "sheetsymbol") {const wires = entryWires(c.doc(), c.defs?.(), obj); obj[key]=n; reflow(obj); wires.apply(); wires.finish();} else obj[key]=n;});
    });
      globalThis.AtriumLazy?.numericField?.(input,{unit:c.unit(),storageUnit:"mm",nanometres:true,min:min+1e-6,
        locals:()=>globalThis.AtriumNumericFields.geometryLocals(item,c.doc().id),
        target:obj===item?{scope:"item",documentId:c.doc().id,itemId:item.id,path:[key]}:undefined});return input;
    };
    switch (item.kind) {
      case "power":
        complete(field(s, "Net", item.text, v => v.trim() && edit(() => {
          const f = globalThis.AtriumSchPlace?.powerStyleFor, was = f?.(item.text) || "gnd", now = f?.(v);
          item.text = v.trim();
          if (now && now !== item.style && item.style === was) {const down = x => ["gnd", "signal", "earth"].includes(x) ? 3 : 1; if (item.direction === down(was)) item.direction = down(now); item.style = now;}
        })), "power", c);
        field(s, "Style", item.style, v => edit(() => {item.style = v;}), {options:Object.entries(POWER_TITLES)});
        field(s, "Rotation (°)", String(item.direction), v => edit(() => {item.direction = +v;}), {options:[["0", "0° · Right"], ["1", "90° · Up"], ["2", "180° · Left"], ["3", "270° · Down"]]});
        field(s, "Show net name", item.showName !== false, v => edit(() => {item.showName = v;}), {check:true});
        break;
      case "port": case "offsheet":
        complete(field(s, "Name", item.text, v => v.trim() && edit(() => {item.text = v.trim();})), item.kind, c);
        ioField(s, item, c, field);
        if (item.kind === "port") {
          field(s, "Width (" + c.unit() + ")", item.width ? A.units.value(item.width, c.unit()) : "", v => edit(() => {const n = A.units.parse(v, c.unit()); if (n > 0) item.width = n; else delete item.width;}));
        }
        field(s, "Rotation (°)", String((A.offsheetAngle(item) % 360 + 360) % 360), v => edit(() => {item.angle = +v + (item.schPaint?.offSheet ? (item.schPaint.direction || 0) * 90 : 0);}), {options:["0", "90", "180", "270"].map(a => [a, a + "°"])});
        break;
      case "sheetsymbol": {
        field(s, "Designator", item.name, v => v.trim() && edit(() => {item.name = v.trim();}));
        const sheets = project.documents.filter(d => d.kind === "schematic" && d.id !== c.doc().id);
        field(s, "Child sheet", item.sheet, v => edit(() => {item.sheet = v;}), {options:[["", "— None —"], ...sheets.map(d => [d.id, d.name])]});
        len("Width", "w"); len("Height", "h");
        const rep = repeatOf(item);
        if (rep) s.append(el("p", "Repeats " + (Math.abs(rep.to - rep.from) + 1) + " channels: " + rep.name + rep.from + " … " + rep.name + rep.to + ".", "side-note"));
        const child = project.documents.find(d => d.id === item.sheet);
        const actions = el("div", null, "inspect-actions");
        if (child) actions.append(button("Open " + child.name, () => descend(item, null, c)), button("Sync entries", () => command("sch-sync-entries", {...c, selected:() => item})));
        if (item.entries.length) actions.append(button("Fit to entries", () => edit(() => fitSymbol(item, {snug:true, doc:c.doc(), defs:c.defs?.()}))));
        else actions.append(button("Create child sheet", () => {
          const d = A.sheet("schematic", item.name.replace(/^U_/, "") || "Sheet");
          item.entries.forEach((e, n) => d.items.push(make("port", [0, n * grid * 2], {text:e.name, io:e.io})));
          edit(() => {c.project().documents.push(d); item.sheet = d.id;});
        }));
        s.append(actions);
        const list = el("div", null, "sch-entries");
        for (const e of item.entries) {
          const r = el("div", null, "sch-entry-row");
          const name = el("input"); name.value = e.name; name.setAttribute("aria-label", "Entry name"); name.onchange = () => name.value.trim() && edit(() => {e.name = name.value.trim();});
          const io = el("select"); for (const v of IO) io.add(new Option(v, v)); io.value = e.io; io.setAttribute("aria-label", "Entry I/O type"); io.onchange = () => edit(() => {e.io = io.value;});
          const side = el("select"); for (const v of SIDES) side.add(new Option(v, v)); side.value = e.side; side.setAttribute("aria-label", "Entry side"); side.onchange = () => edit(() => {e.side = side.value;});
          r.append(name, io, side, button("×", () => edit(() => {item.entries = item.entries.filter(x => x !== e);}), "sch-entry-remove"));
          list.append(r);
        }
        if (item.entries.length) {s.append(el("h4", "Sheet entries", "sch-subhead")); s.append(list);}
        break;
      }
      case "textframe":
        if (globalThis.AtriumSchObjects.isFrame(item)) {
          const name = field(s, "Name", item.text, v => {
            if (v.trim() && v.length <= 300) edit(() => {item.text = v.trim();});
            else {name.value = item.text; c.info("Enter a frame name of 1 to 300 characters.");}
          });
          name.maxLength = 300;
          len("Width", "w"); len("Height", "h");
          s.append(el("p", "Drag the border to move the frame and its contents. Ctrl-drag (⌘-drag on Mac) moves just the frame.", "side-note"));
          break;
        }
        if (item.widget) {
          s.append(button("Edit widget",()=>globalThis.AtriumLazy.need("AtriumSheetWidgetEditor").then(ui=>ui.open(item.id),e=>c.info(e.message))));
          len("Width","w"); len("Height","h"); break;
        }
        if (item.math === true) {
          s.append(button("Edit equation", () => globalThis.AtriumSchObjects.dblclick(item, [item.x,item.y], c))); break;
        }
        if (item.calculation) {
          globalThis.AtriumLazy?.appendOnLoad("AtriumCalculationSheet",s,(ui,target) => ui.inspector(target,item),c.info);
          break;
        }
        if(item.richText) s.append(button("Edit rich text",()=>globalThis.AtriumLazy.need("AtriumRichText").then(m=>m.edit(item))));
        else field(s, "Text", item.text, v => edit(() => {item.text = v;}), {area:true});
        len("Width", "w"); len("Height", "h");
        field(s, "Note style", !!item.note, v => edit(() => {if (v) item.note = true; else delete item.note;}), {check:true});
        field(s, "Border", item.border !== false, v => edit(() => {if (v) delete item.border; else item.border = false;}), {check:true});
        break;
      case "image":
        len("Width", "w"); len("Height", "h");
        if (item.asset) s.append(button("Edit image…", () => AtriumLazy.need("AtriumNotebookImageUI").then(ui => ui.edit(item)).catch(e => c.info(e.message))));
        break;
    }
  }
  // A part's Links (sheet and board), then on the sheet its Parameters grid: name, value,
  // visible-on-sheet. Writes part.parameters, which the BOM reads over the library parameters.
  function partParameters(panel, part, def, c, {el, button}) {
    partLinks(panel, part, def, c, {el});
    if (c.doc()?.kind !== "schematic") return;
    const s = el("section", null, "inspect-section sch-params"); s.append(el("h3", "Parameters")); panel.append(s);
    const own = part.parameters || {}, lib = def?.parameters || {};
    const entries=bag=>Array.isArray(bag)?bag.map(r=>/** @type {[string,any]} */([r.name,r])):Object.entries(bag);
    const tableOf=bag=>new Map(entries(bag)), ownRows=tableOf(own),libRows=tableOf(lib);
    const names=[...new Set([...libRows.keys(),...ownRows.keys()])].filter(k=>typeof k==="string" && !/^(DESIGNATOR|COMMENT)$/i.test(k));
    const raw=v=>v && typeof v==="object"?v.value ?? "":v ?? "";
    function setValue(k,v) {
      const prev=ownRows.get(k),next=prev && typeof prev==="object"?{...prev,value:v}:v;
      if(Array.isArray(part.parameters))part.parameters=prev?part.parameters.map(r=>r===prev?next:r):[...part.parameters,{name:k,value:v}];
      else part.parameters={...part.parameters,[k]:next};
    }
    const table = el("div", null, "sch-param-grid");
    table.append(el("span", "Show", "sch-param-head"), el("span", "Name", "sch-param-head"), el("span", "Value", "sch-param-head"), el("span", ""));
    for (const k of names) {
      const show = el("input"); show.type = "checkbox"; show.checked = part.paramShow?.[k] === true; show.setAttribute("aria-label", "Show " + k + " on the sheet");
      show.onchange = () => c.edit(() => {
        part.paramShow = {...part.paramShow}; if (show.checked) part.paramShow[k] = true; else delete part.paramShow[k];
        if (show.checked && !ownRows.has(k)) setValue(k,String(raw(libRows.get(k))));
        if (!Object.keys(part.paramShow).length) delete part.paramShow;
      });
      const value = el("input"); value.value = String(raw(ownRows.has(k)?ownRows.get(k):libRows.get(k))); value.setAttribute("aria-label", k + " value");
      if (!ownRows.has(k)) value.classList.add("sch-param-inherited");
      value.onchange = () => c.edit(() => {setValue(k,value.value);});
      const metadata=ownRows.get(k), declared=metadata?.unit || libRows.get(k)?.unit;
      if(declared || /^(?:power(?: rating)?|rated power|voltage(?: rating)?|rated voltage|tolerance|tcr|tempco|temperature coefficient)$/i.test(k)) {
        const schema={kind:"part",field:k,item:part,definition:def,documentId:c.doc().id},
          path=metadata && typeof metadata==="object" ? ["parameters",metadata.id?{id:metadata.id}:k,"value"]:["parameters",k];
        globalThis.AtriumLazy?.numericField?.(value,{unit:declared || undefined,textValue:true,declaration:schema,
          target:{scope:"item",documentId:c.doc().id,itemId:part.id,path},optional:true});
      }
      const remove = button("×", () => c.edit(() => {
        const p=Array.isArray(part.parameters)?part.parameters.filter(r=>r.name!==k):{...part.parameters};
        if(!Array.isArray(p))delete p[k];if(Object.keys(p).length)part.parameters=p;else delete part.parameters;
        if (part.paramShow) {delete part.paramShow[k]; if (!Object.keys(part.paramShow).length) delete part.paramShow;}
      }), "sch-entry-remove");
      remove.title=libRows.has(k)?"Revert to the library value":"Remove parameter";remove.disabled=!ownRows.has(k);
      const name=el("span",k,"sch-param-name"),decl=ownRows.get(k)?.unit || libRows.get(k)?.unit;
      const unit=button(decl || "Unit…",async()=>{
        const ui=await globalThis.AtriumLazy.need("AtriumQueryFieldUI"),project=c.project();
        const field=globalThis.AtriumQueryFields.describe(project,{kind:"part",field:k,item:part,definition:def,documentId:c.doc().id});
        if(field.source==="builtin"){c.info?.(k+" uses "+(field.unit || "the component family’s unit")+".");return;}
        ui.editor(unit,field,{project:c.project,host:globalThis.AtriumNavHost,edit:globalThis.AtriumNavHost?.edit || c.edit});
      },"sch-param-unit");
      unit.setAttribute("aria-label","Unit for "+k);
      const heading=el("div",null,"sch-param-identity");
      heading.append(name,unit);
      table.append(show,heading,value,remove);
    }
    s.append(table);
    const add = el("div", null, "sch-param-add");
    const nameIn = el("input"); nameIn.placeholder = "Name (e.g. MPN)"; nameIn.setAttribute("aria-label", "New parameter name");
    const valueIn = el("input"); valueIn.placeholder = "Value"; valueIn.setAttribute("aria-label", "New parameter value");
    const quick = el("select"); quick.setAttribute("aria-label", "Common parameters");
    quick.add(new Option("Common…", "")); for (const n of ["MPN", "Manufacturer", "Supplier", "Supplier Part Number", "Description", "Tolerance", "Voltage", "Power", "DNP"]) quick.add(new Option(n, n));
    quick.onchange = () => {if (quick.value) {nameIn.value = quick.value; valueIn.focus();} quick.value = "";};
    add.append(quick, nameIn, valueIn, button("Add", () => {
      const k = nameIn.value.trim(); if (!k) {nameIn.focus(); return;}
      c.edit(() => {setValue(k,valueIn.value);});
    }));
    s.append(add);
  }

  // Signal directive fields (signals.js §7): the net this item names becomes (part of) a signal, with a
  // polarity for a differential leg, and tags that follow the signal across series parts. Live on the board.
  function directives(s, item, c, {el, field = defaultField}) {
    if (item.url != null) {
      s.append(el("h4", "Link", "sch-subhead"));
      field(s, "URL", item.url, v => c.edit(() => {if (v.trim()) item.url = v.trim(); else delete item.url;}));
      if (webURL(item.url)) s.append(linkRow(el, {title: "Open link", url: webURL(item.url)}));
    }
    if (item.kind === "label" || item.kind === "textframe") return;
    // The editor's Text field of a net label, above these fields (once a lazily built fragment is in place).
    if (item.kind === "netlabel") Promise.resolve().then(() => complete(s.querySelector?.('input[aria-label="Text"]') || s.ownerDocument?.getElementById?.("inspector")?.querySelector?.('input[aria-label="Text"]'), "netlabel", c));
    if (item.kind === "netlabel" && Atrium.isOffsheet(item)) ioField(s, item, c, field);
    s.append(el("h4", "Signal", "sch-subhead"));
    const edit = fn => c.edit(fn), set = (k, v) => edit(() => {if (v == null || v === "") delete item[k]; else item[k] = v;});
    field(s, "Signal", item.signal || "", v => set("signal", v.trim()));
    field(s, "Polarity", item.polarity === 1 ? "1" : item.polarity === -1 ? "-1" : "", v => set("polarity", v ? +v : null), {options: [["", "Auto"], ["1", "+ (positive)"], ["-1", "− (negative)"]]});
    field(s, "Tags", (item.tags || []).join(", "), v => {const t = [...new Set(String(v).split(",").map(x => x.trim()).filter(Boolean))]; set("tags", t.length ? t : null);});
    if (item.netClass) field(s, "Net class", item.netClass, v => set("netClass", v.trim()));
    if (item.diffPair) field(s, "Differential pair", item.diffPair, v => set("diffPair", v.trim()));
  }

  return {inspector, partParameters, directives, linksOf, webURL};
})();
