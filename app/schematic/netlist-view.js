"use strict";
// Design > Netlist. Only visible text chunks need token DOM. Hidden tabs do no work.
globalThis.AtriumNetlistView = (() => {
  const G = globalThis, V = () => G.AtriumDocViews, T = () => G.AtriumNetlistText;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const viewId = "netlist", navigable = new Set(["part","pin","net","signal","tag"]);
  function probe(h, data, t) {
    const C = G.AtriumNavCommon, A = G.Atrium, defs = h.defs(), current = h.doc();
    const docs = [current,...h.project().documents.filter(d => d !== current)].filter(d => d.kind === "schematic" || d.id === data.board);
    const netNames = t.role === "signal" ? data.signals.netsOfSignal(t.value) :
      t.role === "tag" ? data.signals.netsOfTag(t.value) : new Set(t.role === "net" ? [t.value] : []);
    for (const doc of docs) {
      const ids = new Set(); let box = null, highlight = netNames.size === 1 ? [...netNames][0] : "";
      const include = item => { if (!ids.has(item.id)) { ids.add(item.id); box = C.union(box,C.itemBox(doc,defs,item)); } };
      if (t.role === "pin" || t.role === "part") {
        const ref = (t.ref || t.value).trim().toUpperCase();
        const parts = doc.kind === "pcb" ? doc.items.filter(i => i.kind === "part" && String(i.ref || "").trim().toUpperCase() === ref) :
          (data.origins.get(ref) || []).filter(x => x.doc === doc).map(x => x.part);
        for (const p of parts) {
          if (t.role !== "pin") { include(p); continue; }
          const pin = A.pins(p,defs.get(p.def),doc.kind).find(x => String(x.number) === t.value);
          if (!pin) continue;
          ids.add(p.id); box = C.union(box,[pin.at[0]-1,pin.at[1]-1,pin.at[0]+1,pin.at[1]+1]);
          highlight = t.net || G.AtriumCrossProbe.pinNet(doc,defs,p,t.value); break;
        }
      } else if (netNames.size) {
        if (netNames.size === 1) {
          const hit = G.AtriumCrossProbe.netObjects(doc,defs,highlight);
          for (const id of hit.ids) ids.add(id); box = hit.box;
        }
        if (doc.kind === "pcb") {
          for (const item of doc.items) {
            if (netNames.has(item.net)) include(item);
            if (item.kind === "part" && (Object.values(item.pinNets || {}).some(n => netNames.has(n)) ||
              defs.get(item.def)?.footprint?.pads?.some(p => netNames.has(item.pinNets?.[p.number] ?? p.net)))) include(item);
          }
        } else {
          // Keep the physical channel and root net names. The canvas draws the underlying
          // logical sheet; its local names need not equal these compiled names.
          for (const net of data.hierarchy?.nets || []) if (netNames.has(net.name)) {
            for (const p of net.pins) if (p.doc === doc) include(p.part);
            for (const g of net.local) if (g.inst.doc === doc) {
              for (const w of g.net.wires) include(w);
              for (const s of g.net.sources) include(s.item);
            }
          }
        }
      }
      if (!box && !ids.size) continue;
      V().hide(viewId);
      if (h.currentId() !== doc.id) h.selectDocument(doc.id);
      h.select([...ids]); h.setHighlight(highlight || ""); if (box) h.zoomTo(box);
      h.canvas()?.focus(); h.info("Cross-probe · " + (t.ref ? t.ref+"." : "") + t.value + " · " + doc.name); return true;
    }
    h.info("No placed objects match " + t.value + "."); return false;
  }
  function open(h) {
    if (V().isOpen(viewId)) { V().show(viewId); return; }
    let clean = () => {};
    V().open(viewId,{title:"Netlist",icon:"book",onClose:() => clean(),mount(box) {
      box.classList.add("netlist-document");
      const toolbar = el("div",null,"netlist-tools"), heading = el("h2","Netlist"), source = el("span"), pick = el("select", null, "ui-field");
      pick.setAttribute("aria-label","PCB document for netlist"); const check = el("button","Check text","ui-button"), copy = el("button","Copy text","ui-button");
      toolbar.append(heading,source,pick,check,copy);
      const details = el("details",null,"netlist-diagnostics");
      const viewport = el("pre",null,"netlist-source"), code = el("code"), status = el("p",null,"netlist-status");
      viewport.tabIndex = 0; viewport.setAttribute("aria-label","Read-only project netlist"); viewport.append(code);
      const help = el("p","Scroll to a section, then press Tab to reach its first visible reference. Enter opens the selected object in the design.","visually-hidden");
      help.id = "netlist-keyboard-help"; viewport.setAttribute("aria-describedby",help.id);
      status.setAttribute("role","status"); details.hidden = true; box.append(toolbar,details,help,viewport,status);
      const localCache = new WeakMap(), targets = new WeakMap(), runs = new WeakMap();
      let data = null, dirty = true, chosen = null, frame = 0, groups = [];
      const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => {
        for (const e of entries) if (e.isIntersecting) {
          observer.unobserve(e.target);
          const run=runs.get(e.target);
          if (run) { e.target.replaceChildren(); appendTokens(e.target,run.line,run.tokens,run.start,run.end); runs.delete(e.target); }
          else color(e.target);
        }
      },{root:viewport,rootMargin:"160px"}) : null;
      function appendTokens(row,line,tokens,start,end) {
        let pos=start;
        for (const t of tokens) {
          if (pos !== t.start) row.append(line.slice(pos,t.start));
          const token=el("span",t.raw,"nt-"+t.role);
          if (navigable.has(t.role)) {
            token.setAttribute("role","link"); token.tabIndex=0; targets.set(token,t);
            token.setAttribute("aria-label","Show "+t.role+" "+(t.ref ? t.ref+"." : "")+t.value);
          }
          row.append(token); pos=t.end;
        }
        if (pos<end) row.append(line.slice(pos,end));
      }
      function color(node) {
        const lines=node.textContent.split("\n"), frag=document.createDocumentFragment(), start=Number(node.dataset.start);
        lines.pop(); // each rendered chunk ends in LF
        for (const [k,line] of lines.entries()) {
          const row=el("span",null,"netlist-row"); row.dataset.line=String(start+k);
          const {tokens}=T().readLine(line,Infinity);
          if (!observer || tokens.length<=240) appendTokens(row,line,tokens,0,line.length);
          else {
            // A large ground net may span many horizontal screens. Keep all its text
            // selectable and materialize links only where the reader has scrolled.
            for (let i=0;i<tokens.length;i+=120) {
              const part=tokens.slice(i,i+120), lo=i ? tokens[i].start : 0, hi=tokens[i+120]?.start ?? line.length;
              const span=el("span",line.slice(lo,hi)); row.append(span);
              runs.set(span,{line,tokens:part,start:lo,end:hi}); observer.observe(span);
            }
          }
          frag.append(row,"\n");
        }
        node.replaceChildren(frag);
      }
      function unwatch(node) {
        observer?.unobserve(node);
        for (const child of node.querySelectorAll(".netlist-row > span")) if (runs.has(child)) observer?.unobserve(child);
      }
      function paintText(text) {
        const lines = text.split("\n"); lines.pop();
        const fresh = [];
        for (let a=0; a<lines.length; a+=48) {
          const raw=lines.slice(a,a+48).join("\n")+"\n", prev=groups[fresh.length];
          if (prev?.raw === raw) { fresh.push(prev); continue; }
          const node=el("span",raw); node.dataset.start=String(a+1);
          if (prev) { unwatch(prev.node); prev.node.replaceWith(node); } else code.append(node);
          fresh.push({raw,node});
          if (observer) observer.observe(node); else color(node);
        }
        for (const old of groups.slice(fresh.length)) { unwatch(old.node); old.node.remove(); }
        groups=fresh;
      }
      function local(doc, build) {
        const v = G.AtriumUndoStore?.documentVersions(doc,h.project()), old = localCache.get(doc);
        if (v && old && old.floor===v.floor && old.items===v.items && old.outer===v.outer && old.library===v.library && old.project===v.project) return old.local;
        const l=build(); if (v) localCache.set(doc,{...v,local:l}); return l;
      }
      function render() {
        frame=0; if (!dirty || box.hidden || !box.isConnected) return; dirty=false;
        const layouts=T().boards(h.project());
        if (!layouts.some(d => d.id===chosen)) chosen=layouts[0]?.id ?? null;
        try {
          const next=T().compile(h.project(),{board:chosen,defs:h.defs(),navigation:true,local});
          if (!data || next.text !== data.text) {
            const focused = document.activeElement, linkFocused = targets.has(focused);
            paintText(next.text); details.hidden=true;
            if (linkFocused && !focused.isConnected) viewport.focus({preventScroll:true});
          }
          data=next; pick.replaceChildren(...layouts.map(d => new Option(d.name,d.id))); pick.hidden=layouts.length<2;
          if (chosen) pick.value=chosen;
          source.textContent=data.source==="schematic" ? "Compiled schematics" : layouts.find(d => d.id===chosen)?.name || "PCB";
          status.textContent="Read-only · "+Object.entries(data.counts).map(([k,n])=>n+" "+(n===1?k.slice(0,-1):k)).join(" · ");
          if (data.issues.length) status.textContent+=" · "+data.issues.length+" extraction notes";
        } catch(e) { data=null; groups=[]; observer?.disconnect(); code.replaceChildren(); details.hidden=true; status.textContent=e.message; }
      }
      function schedule() { if (!frame && dirty && !box.hidden) frame=requestAnimationFrame(render); }
      function change() { dirty=true; schedule(); }
      check.onclick=() => {
        if (!data) return;
        const result=T().validate(data.text,{matrix:G.AtriumERC.settings(h.project()).matrix});
        const summary=el("summary",result.errors+" errors · "+result.warnings+" warnings"+(data.issues.length?" · "+data.issues.length+" extraction notes":""));
        const list=el("ul");
        for (const d of result.diagnostics) list.append(el("li","Line "+d.line+", column "+d.column+" · "+d.message));
        for (const issue of data.issues) list.append(el("li",issue));
        details.replaceChildren(summary,list); details.open=!!list.children.length; details.hidden=false;
      };
      copy.onclick=async() => {
        if (!data) return;
        try { await navigator.clipboard.writeText(data.text); h.info("Netlist copied."); }
        catch { const r=document.createRange();r.selectNodeContents(code);const s=getSelection();s.removeAllRanges();s.addRange(r);h.info("Netlist selected. Use Copy to copy the text."); }
      };
      pick.onchange=()=>{chosen=pick.value; change();};
      code.onclick=e=>{const t=targets.get(e.target); if (data && t && getSelection()?.isCollapsed !== false) probe(h,data,t);};
      box.onkeydown=e=>{
        if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.target === viewport) {
          const bounds = viewport.getBoundingClientRect();
          const visible = [...code.querySelectorAll("[role=link]")].find(link => [...link.getClientRects()].some(r =>
            r.top >= bounds.top && r.bottom <= bounds.bottom && r.left < bounds.right && r.right > bounds.left));
          if (visible) {e.preventDefault(); visible.focus({preventScroll:true});}
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==="a" && viewport.contains(e.target)) {
          e.preventDefault();
          const range=document.createRange();range.selectNodeContents(code);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        }
        if (e.key==="Escape") {e.preventDefault();V().hide(viewId);}
        if (e.key==="Enter" && targets.has(e.target)) {e.preventDefault();if(data)probe(h,data,targets.get(e.target));}
        e.stopPropagation();
      };
      function focusSource() {
        if (!box.hidden && box.isConnected && document.activeElement?.getAttribute("aria-controls") !== box.id) viewport.focus({preventScroll:true});
      }
      const shown=new MutationObserver(()=>{schedule();focusSource();});
      shown.observe(box,{attributes:true,attributeFilter:["hidden"]});
      const unsub=h.on("change",change), replaced=h.on("replace",()=>V().close(viewId));
      clean=()=>{cancelAnimationFrame(frame);shown.disconnect();observer?.disconnect();unsub();replaced();};
      requestAnimationFrame(focusSource);
    }});
  }
  G.AtriumNavCommon?.ready?.(h=>h.registerAction("netlist-view",()=>open(h)));
  return Object.freeze({open,probe});
})();
