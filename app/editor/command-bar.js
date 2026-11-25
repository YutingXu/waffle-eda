"use strict";
// AtriumCommandBar: a one-line command line for typed coordinates, as in the Allegro PCB Editor's console
// (x 10 20, ix 5, iy -2), and Done / Cancel for the current command. Lazy (lazy.js).
//
//   command-bar     Edit › Coordinate Entry…; X in the Allegro-like preset, ⌘L while placing in Modern (Mac)
//   escape-done     Done (Allegro F6): end the current command, keeping what it made, and return to Select
//   escape-cancel   Cancel (Allegro F8/F9): discard the unfinished route or placement, return to Select
//
// Points go through the editor's own paths, so they snap and commit exactly like a click there: the
// keyboard cursor moves to the point (cursor-step when it is on screen, centerOn when it is not) and
// place-at-pointer clicks the active tool. Relative entries (ix, iy, ixy) start from the last point picked,
// by a click or by an entry. Coordinates are in the display unit unless they carry one (10mil, 0.5mm), and
// on a board with an origin they are relative to it, like the status bar.
globalThis.AtriumCommandBar = (() => {
  const G = globalThis, host = () => G.AtriumNavHost;
  let bar = null, input = null, note = null, last = null, history = [], at = 0;

  // Typed commands, with the Allegro names Allegro users type at its console.
  const WORDS = {"done": "escape-done", "cancel": "escape-cancel", "oops": "oops", "add connect": "route", "route": "route", "slide": "drag-object",
    "move": "move-object", "delete": "delete-pick", "show element": "toggle-right", "show measure": "measure", "measure": "measure", "zoom fit": "fit",
    "zoom in": "zoom-in", "zoom out": "zoom-out", "grid toggle": "grid", "undo": "undo", "redo": "redo", "add via": "via", "redraw": "redraw"};

  // "x 10 20" | "10, 20" → {op:"x", v:[x, y]}; "ix 5" | "iy -2" | "ixy 1 2" → {op:"i", v:[dx, dy]}; a word → {op:"cmd"}.
  function parse(text, unit = "mm") {
    const U = G.Atrium?.units, src = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!src) return {error: "Type x X Y, ix DX, iy DY or a command."};
    if (Object.hasOwn(WORDS, src)) return {op: "cmd", action: WORDS[src]};
    const parts = src.split(/[\s,;]+/).filter(Boolean);
    const num = s => U ? U.parse(s, unit) : Number(s);
    let op = parts[0], args = parts.slice(1);
    if (/^[-+.\d]/.test(op)) { args = parts; op = "x"; }
    const v = args.map(num);
    if (!v.every(Number.isFinite)) return {error: "“" + args.join(" ") + "” is not a coordinate."};
    if (op === "x" && v.length === 2) return {op: "x", v};
    if (op === "ix" && v.length === 1) return {op: "i", v: [v[0], 0]};
    if (op === "iy" && v.length === 1) return {op: "i", v: [0, v[0]]};
    if (op === "ixy" && v.length === 2) return {op: "i", v};
    if (["x", "ix", "iy", "ixy"].includes(op)) return {error: op === "x" || op === "ixy" ? op + " takes two values: " + op + " X Y." : op + " takes one value: " + op + " D."};
    return {error: "Unknown command “" + src + "”. Try x X Y, ix DX, iy DY, done, oops or cancel; the command palette has everything else."};
  }
  // Split two coordinate expressions only at their top-level separator. Function
  // arguments and quoted design names go untouched to the notebook evaluator.
  async function parseExpressions(text, unit="mm", options={}) {
    const direct=parse(text,unit);
    if (!direct.error) return direct;
    const match=/^\s*(?:(ixy|ix|iy|x)\s+)?([\s\S]*?)\s*$/i.exec(text);
    const op=(match[1] || "x").toLowerCase(), body=match[2], base=text.indexOf(body,match[1]?text.toLowerCase().indexOf(op)+op.length:0);
    if (!body || !match[1] && !/[,;]/.test(body)) return direct;
    let depth=0,quote=false,start=0;
    const args=[];
    for (let i=0;i<body.length;i++) {
      const c=body[i];
      if (quote) {if(c==="\\")i++;else if(c==='"')quote=false;continue;}
      if(c==='"'){quote=true;continue;}
      if(c==="(")depth++;
      else if(c===")")depth--;
      else if(depth===0 && (c==="," || c===";")) {args.push([body.slice(start,i),base+start]);start=i+1;}
    }
    args.push([body.slice(start),base+start]);
    if(args.length!==(op==="ix" || op==="iy" ? 1:2))return {error:"Separate the two coordinate expressions with a comma.",span:[base,text.length]};
    const ui=G.AtriumNumericFields || await G.AtriumLazy.need("AtriumNumericFields");
    const values=await Promise.all(args.map(([v])=>ui.evaluate(v,{unit,storageUnit:"mm",nanometres:true},options)));
    for(const [i,v] of values.entries())if(!v.ok)return {error:v.diagnostic.message,span:v.diagnostic.span.map(p=>args[i][1]+p)};
    const v=values.map(row=>row.value);
    return {op:op==="x"?"x":"i",v:op==="ix"?[v[0],0]:op==="iy"?[0,v[0]]:v};
  }
  // User coordinates (board origin, Y up on boards with an origin) ↔ world.
  const BS = () => G.AtriumBoardShape;
  const toWorld = (d, p) => d?.kind === "pcb" && BS()?.fromUser ? BS().fromUser(d, p) : p;
  const toUser = (d, p) => d?.kind === "pcb" && BS()?.toUser ? BS().toUser(d, p) : p;
  const active = h => !["select", "pan"].includes(h.tool?.() || "select");
  const routing = h => /^route/.test(h.tool?.() || "") || !!h.liveRoute?.();

  // Move the keyboard cursor to a world point and click the active tool there.
  function pick(world) {
    const h = host(), d = h.doc(), v = h.view?.(), c = h.canvas?.(), cur = h.pointer?.();
    const s = v?.worldToScreen?.(world), on = !!(s && c && s[0] >= 0 && s[1] >= 0 && s[0] <= c.clientWidth && s[1] <= c.clientHeight);
    if (on && cur && d.grid > 0) h.executeKey("cursor-step", [(v.flipped?.() ? -1 : 1) * (world[0] - cur[0]) / d.grid, (world[1] - cur[1]) / d.grid]);
    else h.centerOn(world);
    const placed = active(h);
    if (placed) h.executeKey("place-at-pointer");
    last = h.pointer?.() || world;
    return placed;
  }
  // Run one line; returns the message shown under the field.
  function run(text) {
    const h = host();
    if (!h) return "The editor is not ready.";
    return execute(parse(text,h.units?.() || "mm"),h);
  }
  function execute(r,h) {
    const d=h.doc(),unit=h.units?.() || "mm",U=G.Atrium?.units;
    if (r.error) return r.error;
    if (r.op === "cmd") {
      if (r.action === "escape-done") { done(); return "Done."; }
      if (r.action === "escape-cancel") { cancel(); return "Cancelled."; }
      if (r.action === "oops") { h.executeKey(routing(h) ? "route-back" : "undo"); return "Oops: the last step is undone."; }
      if (r.action === "redraw") { h.redraw?.(); return "Waffle redraws continuously; nothing to refresh."; }
      h.executeKey(r.action); return "";
    }
    let user;
    if (r.op === "x") user = r.v;
    else {
      const from = last || h.pointer?.();
      if (!from) return "Click or enter a point first; ix and iy are relative to the last one.";
      const u = toUser(d, from); user = [u[0] + r.v[0], u[1] + r.v[1]];
    }
    const placed = pick(toWorld(d, user)), fmt = n => U ? U.format(n, unit) : String(n);
    const where = fmt(user[0]) + ", " + fmt(user[1]);
    return placed ? "Picked " + where + "." : "Moved the cursor to " + where + ". Start a command (route, place…) to pick there.";
  }

  // Done: end the current command, keeping what it made. Escape ends one stage at a time (a route, then the tool).
  function done() {
    const h = host();
    for (let i = 0; i < 4 && h && active(h); i++) h.executeKey("escape");
  }
  // Cancel: retract the unfinished route click by click, then leave the tool (placement and drags are discarded).
  function cancel() {
    const h = host();
    if (!h) return;
    if (routing(h)) for (let i = 0; i < 256 && (h.liveRoute?.() || i < 64); i++) h.executeKey("route-back");
    for (let i = 0; i < 4 && active(h); i++) h.executeKey("escape");
  }

  function build() {
    const el = (t, c, x) => AtriumNavCommon.classedElement(document, t, c, x);
    bar = el("dialog", "cmdbar"); bar.setAttribute("aria-label", "Coordinate entry");
    const form = el("form", "cmdbar-form"), label = el("label", "cmdbar-label", "Command");
    input = el("input", "cmdbar-input ui-field"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.id = "cmdbar-input";
    input.placeholder = "x X Y · ix DX · iy DY · done · oops · cancel"; label.htmlFor = input.id;
    note = el("p", "cmdbar-note"); note.setAttribute("role", "status"); note.setAttribute("aria-live", "polite");
    const close = el("button", "cmdbar-close ui-button", "Close"); close.type = "button"; close.dataset.size = "sm"; close.onclick = () => hide();
    form.append(label, input, close); bar.append(form, note);
    AtriumShell.adoptDialog(bar, {body:[form, note]});
    let timer,controller;
    const stop=()=>{clearTimeout(timer);controller?.abort();controller=null;};
    async function interpret(apply) {
      stop();const h=host(),text=input.value,job=controller=new AbortController();
      try {
        const result=await parseExpressions(text,h.units?.() || "mm",{host:h,project:h.project?.(),signal:job.signal});
        if(job.signal.aborted || !bar.open || input.value!==text)return;
        if(result.error) {
          input.setAttribute("aria-invalid","true");const span=result.span || [0,text.length];
          input.dataset.errorStart=String(span[0]);input.dataset.errorEnd=String(span[1]);
          note.textContent=result.error+" ("+(span[0]+1)+"–"+Math.max(span[0]+1,span[1])+")";return;
        }
        input.removeAttribute("aria-invalid");delete input.dataset.errorStart;delete input.dataset.errorEnd;
        if(!apply){note.textContent=result.v?.map(v=>G.Atrium.units.format(v,h.units?.() || "mm")).join(", ") || "";return;}
        if(text){history=[...history.filter(v=>v!==text),text].slice(-30);at=history.length;}
        note.textContent=execute(result,h) || "";input.value="";if(bar.open)input.focus();
      } catch(err){if(err.name!=="AbortError")note.textContent=err.message;}
    }
    bar.addEventListener("close",stop);
    input.addEventListener("input",()=>{stop();if(input.value.trim() && G.AtriumNumericFields?.presentationEnabled())timer=setTimeout(()=>interpret(false),60);else note.textContent="";});
    form.onsubmit=e=>{e.preventDefault();interpret(true);};
    bar.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); }
    });
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault(); at = Math.max(0, Math.min(history.length, at + (e.key === "ArrowUp" ? -1 : 1))); input.value = history[at] || "";
      }
    });
    (host()?.canvas?.()?.parentElement || document.body).append(bar);
  }
  // Opened while a tool is active, the field starts with "x " selected: type over it with "ix 5", or press End and add the values.
  function show() {
    if (typeof document === "undefined") return null;
    if (!bar) build();
    if (!bar.isConnected) (host()?.canvas?.()?.parentElement || document.body).append(bar);
    if (!bar.open) bar.show();
    const h = host();
    if (!input.value && h && active(h)) input.value = "x ";
    input.focus(); input.select();
    return bar;
  }
  function hide() { if (bar?.open) bar.close(); host()?.canvas?.()?.focus?.(); }
  function attach(h) {
    h.registerAction("command-bar", () => show());
    h.registerAction("escape-done", done);
    h.registerAction("escape-cancel", cancel);
    // ix / iy start from the last click on the canvas as well as from the last entry.
    if (typeof document !== "undefined") document.addEventListener("pointerup", e => { const c = host()?.canvas?.(); if (c && e.target === c && e.button === 0) last = host()?.pointer?.() || last; }, true);
    G.AtriumNavCommon?.menuItem?.("edit", "command-bar", "Coordinate Entry…", {after: "goto-location"});
  }
  if (typeof document !== "undefined") { if (G.AtriumNavHost) attach(G.AtriumNavHost); else G.AtriumNavCommon?.ready?.(attach); }
  return Object.freeze({parse, parseExpressions, run, done, cancel, show, hide, attach, isOpen: () => !!bar?.open, WORDS});
})();
