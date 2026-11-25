"use strict";
// Project rows are instances, including repeated channels. An unexpanded branch only allocates its own row.
globalThis.AtriumProjectTree = (() => {
  const key = (...parts) => JSON.stringify(parts);
  const direction = {input:"Input", output:"Output", bidirectional:"Bidirectional", unspecified:"Unspecified"};
  const scopeName = s => s.charAt(0).toUpperCase() + s.slice(1);
  let panelState;
  function connectionLabel(project) {
    const H = globalThis.AtriumHierarchy, view = panelState?.project === project ? panelState : null;
    const setting = view?.setting ?? H?.scopeSetting(project) ?? "global";
    const complete = view?.complete ?? (globalThis.AtriumNavHost?.folderProject?.()?.completeFor("schematic-connections") !== false);
    const effective = view?.effective ?? (setting === "automatic" && complete ? H.effectiveScope(project, setting) : setting);
    const value = setting !== "automatic" ? scopeName(setting) : complete ? "Automatic → " + scopeName(effective) : "Automatic";
    return globalThis.AtriumI18n?.t("project.connection_scope", {value}) || "Connections: " + value;
  }
  function structureChanged(project, revision, stamp, previous) {
    if (previous?.project !== project || previous.store !== globalThis.AtriumUndoStore || !Atrium.sameDocumentMetadata(project.documents, previous.documents)) return true;
    if (stamp != null && previous.stamp != null) return stamp !== previous.stamp;
    return revision !== previous.revision;
  }
  // The previous render holds the scope before the checkpoint. Only a local edit of this
  // project can trigger a review; replacing a project, importing, undoing or redoing cannot.
  function reviewScope(project, revision, step) {
    const H = globalThis.AtriumHierarchy, previous = panelState;
    if (!step || previous?.project !== project || !previous.complete || previous.setting !== "automatic" || H.scopeSetting(project) !== "automatic" ||
        globalThis.AtriumProjectConnections?.deciding()) return false;
    const stamp = globalThis.AtriumUndoStore?.hierarchyVersion?.(project);
    if (!structureChanged(project, revision, stamp, previous)) return false;
    const from = previous.effective, to = H.effectiveScope(project, "automatic");
    if (from === to) return false;
    // Holding the old scope is part of the originating checkpoint, including for Save
    // or a second edit before a decision. The existing Automatic rule must exist here.
    project.rules = H.withScope(project.rules, from);
    const offer = m => m.review(globalThis.AtriumNavHost, {project, revision, step, from, to});
    if (globalThis.AtriumProjectConnections) offer(globalThis.AtriumProjectConnections);
    else globalThis.AtriumLazy.need("AtriumProjectConnections").then(offer, e => globalThis.AtriumNavHost?.info(e.message));
    return true;
  }
  function syncPanel(container, icon, project, id, select, revision, refs) {
    const H = globalThis.AtriumHierarchy, store = globalThis.AtriumUndoStore, previous = panelState;
    const stamp = store?.hierarchyVersion?.(project) ?? null, changed = structureChanged(project, revision, stamp, previous);
    const setting = H?.scopeSetting(project) || "global";
    const effective = setting !== "automatic" ? setting : changed || previous.setting !== setting ? H.effectiveScope(project, setting) : previous.effective;
    const complete = setting !== "automatic" || globalThis.AtriumNavHost?.folderProject?.()?.completeFor("schematic-connections") !== false;
    const documents = refs?.documents || refs || project.documents, documentsChanged = previous?.project !== project || !Atrium.sameDocumentMetadata(documents, previous?.refs);
    panelState = {project, revision, stamp, store, setting, effective, complete,
      documents:changed ? Atrium.documentMetadata(project.documents) : previous.documents,
      refs:documentsChanged ? Atrium.documentMetadata(documents) : previous.refs};
    show(container, icon, {project, documents, more:refs?.more, id, select, effective, changed, documentsChanged});
  }
  function model(project, documents = project.documents) {
    const hierarchy = globalThis.AtriumHierarchy;
    // A manifest member supplies its name and identity before its body is read.
    const owners = documents === project.documents ? project :
      {...project, documents:documents.map(doc => doc.items ? doc : {...doc,items:[]})};
    const {roots, instances} = owners === project ? hierarchy.instancesCached(project) : hierarchy.instances(owners);
    const first = new Map(), ports = new Map();
    for (const inst of instances) if (!first.has(inst.doc)) {
      first.set(inst.doc, inst);
      ports.set(inst.doc, inst.doc.items.filter(i => hierarchy.sourceType(i) === "port"));
    }
    function children(parent) {
      const list = [], groups = new Map();
      // Separate symbols can instantiate the same channel sheet, interleaved with
      // other sheets. Group within this parent occurrence, never across parents.
      for (const inst of parent.children) {
        if (!groups.has(inst.doc)) groups.set(inst.doc, []);
        groups.get(inst.doc).push(inst);
      }
      for (const group of groups.values()) {
        const inst = group[0], row = sheet(inst);
        if (group.length > 1) {
          row.key = first.get(inst.doc) === inst ? key("doc", inst.doc.id) : key("repeat", parent.id, inst.doc.id);
          row.channels = group.length;
          row.defaultOpen = false;
          row.children = () => group.map(ch => sheet(ch, true));
        }
        list.push(row);
      }
      for (const item of ports.get(parent.doc)) {
        const io = Object.hasOwn(direction, item.io) ? item.io : "unspecified";
        list.push({key:key("port", parent.id, item.id), doc:parent.doc, inst:parent, item, io,
          label:item.text || "Unnamed port", title:(item.text || "Unnamed port") + " · " + direction[io] + " port"});
      }
      return list;
    }
    function sheet(inst, channel = false) {
      const doc = inst.doc, firstSheet = !channel && first.get(doc) === inst;
      const channelName = inst.channel?.label || inst.channelLabel || inst.symbol?.name || doc.name;
      return {key:firstSheet ? key("doc", doc.id) : key("instance", inst.id), doc, inst,
        label:channel ? channelName : doc.name, title:inst.symbol ? doc.name + " · " + (channel ? channelName : inst.symbol.name) : "",
        children:inst.children.length || ports.get(doc).length ? () => children(inst) : null,
        defaultOpen:!channel && !!inst.children.length};
    }
    const other = owners.documents.filter(d => d.kind !== "schematic").map(doc => ({key:key("doc", doc.id), doc, label:doc.name}));
    const board = other.findIndex(r => r.doc.kind === "pcb");
    other.splice(board < 0 ? other.length : board, 0, ...roots.map(inst => sheet(inst)));
    return other;
  }
  function visible(roots, expansion) {
    const out = [];
    function visit(rows, depth) {
      rows.forEach((row, i) => {
        const open = !!row.children && (expansion.get(row.key) ?? !!row.defaultOpen);
        out.push({...row, depth, pos:i + 1, size:rows.length, open});
        if (open) visit(row.children(), depth + 1);
      });
    }
    visit(roots, 0);
    return out;
  }
  const documentRows = new Map(), expansion = new Map(), occurrence = new Map();
  const rowKeys = new WeakMap();
  let explorer, documentIcon, explorerState, explorerId, selectFromExplorer, currentRow, moreDocuments;
  function show(container, icon, {project, documents = project.documents, more, id, select, effective, changed, documentsChanged}) {
    if (!explorer) {explorer = container; explorer.addEventListener("keydown", keydown);}
    documentIcon = icon; selectFromExplorer = select;
    const previous = explorerState, hierarchical = effective === "hierarchical";
    if (previous?.project !== project) {expansion.clear(); occurrence.clear();}
    const channels = globalThis.AtriumMultichannel;
    const rebuild = previous?.project !== project || previous.effective !== effective || documentsChanged ||
      hierarchical && (changed || previous.channels !== channels);
    if (rebuild) {
      clearTreeExit();
      const roots = hierarchical ? model(project, documents) : documents.map(doc => ({key:key("doc", doc.id), doc, label:doc.name}));
      explorerState = {project, effective, channels, roots};
      const motion = documentsChanged && previous?.project === project && globalThis.AtriumSpatialMotion;
      if (motion) {
        const viewport = explorer.closest(".panel-body") || explorer;
        motion.layout(explorer, ':scope > [role="treeitem"]', row => rowKeys.get(row), renderExplorer, {viewport});
      } else renderExplorer();
    }
    if (moreDocuments !== more) {moreDocuments?.remove(); moreDocuments = more;}
    if (more && explorer.lastElementChild !== more) explorer.append(more);
    if (rebuild || explorerId !== id) showCurrent(id);
  }
  function renderExplorer() {
    const rows = visible(explorerState.roots, expansion);
    const focused = document.activeElement, keep = new Set();
    let next = explorer.firstElementChild;
    for (const r of rows) {
      keep.add(r.key);
      let entry = documentRows.get(r.key);
      if (!entry) {
        const row = document.createElement("button"), label = document.createElement("span"), {svg, use} = documentIcon();
        row.type = "button"; row.className = "nav-row doc-row ui-project-row"; row.setAttribute("role", "treeitem"); row.setAttribute("aria-current", "false");
        label.className = "tree-label"; svg.classList.add("tree-icon");
        row.append(svg, label);
        rowKeys.set(row, r.key);
        entry = {row, label, use}; documentRows.set(r.key, entry);
        row.onclick = event => activateRow(entry, event);
      }
      const {row, label, use} = entry;
      entry.data = r;
      if (row === next) next = row.nextElementSibling;
      else explorer.insertBefore(row, next);
      function attr(name, value) {
        if (value == null) {if (row.hasAttribute(name)) row.removeAttribute(name);}
        else if (row.getAttribute(name) !== String(value)) row.setAttribute(name, String(value));
      }
      attr("data-doc", r.doc.id); attr("data-kind", r.doc.kind); attr("data-depth", r.depth);
      attr("data-instance", r.inst?.id); attr("data-port", r.item?.id); attr("data-io", r.io);
      attr("aria-level", r.depth + 1); attr("aria-posinset", r.pos); attr("aria-setsize", r.size); attr("aria-expanded", r.children ? !!r.open : null);
      attr("data-tooltip", r.doc.missing ? "Document unavailable" : r.title || null);
      attr("data-missing", r.doc.missing ? "true" : null);
      attr("aria-label", r.item ? r.title : null);
      row.classList.toggle("doc-child", r.depth > 0);
      const depth = String(r.depth + 2);
      if (row.style.getPropertyValue("--project-row-depth") !== depth) row.style.setProperty("--project-row-depth", depth);
      if (label.textContent !== r.label) label.textContent = r.label;
      const icon = "#i-" + (r.doc.kind === "pcb" ? "board" : r.doc.kind === "drawing" ? "drawing" : "schematic");
      if (use.getAttribute("href") !== icon) use.setAttribute("href", icon);
      if (r.children && !entry.toggle) {
        const toggle = document.createElement("i"); toggle.dataset.treeToggle = ""; toggle.setAttribute("aria-hidden", "true");
        const {svg, use} = documentIcon();
        svg.classList.add("tree-chevron"); use.setAttribute("href", "#i-chevron"); toggle.append(svg);
        row.prepend(toggle); entry.toggle = toggle;
      } else if (!r.children && entry.toggle) {entry.toggle.remove(); entry.toggle = null;}
      if (r.item) {
        if (!entry.arrow) {entry.arrow = document.createElement("i"); entry.arrow.className = "doc-port-io"; entry.arrow.setAttribute("aria-hidden", "true"); row.insertBefore(entry.arrow, label);}
        const arrow = {input:"→", output:"←", bidirectional:"↔", unspecified:"◇"}[r.io];
        if (entry.arrow.textContent !== arrow) entry.arrow.textContent = arrow;
      } else if (entry.arrow) {entry.arrow.remove(); entry.arrow = null;}
      if (r.channels) {
        if (!entry.badge) {entry.badge = document.createElement("small"); entry.badge.className = "doc-channels"; row.insertBefore(entry.badge, row.querySelector(".collab-badges"));}
        const count = "×" + r.channels;
        if (entry.badge.textContent !== count) entry.badge.textContent = count;
      } else if (entry.badge) {entry.badge.remove(); entry.badge = null;}
    }
    for (const [k, entry] of documentRows) if (!keep.has(k)) {
      entry.row.onclick = null;
      entry.data = null;
      entry.row.remove(); documentRows.delete(k);
    }
    if (focused && explorer.contains(focused) && document.activeElement !== focused) focused.focus({preventScroll:true});
  }
  function showCurrent(id) {
    explorerId = id;
    let first, chosen;
    for (const row of explorer.children) if (row.dataset.doc === id && !row.hasAttribute("data-port")) {
      first ||= row;
      if (row.dataset.instance === occurrence.get(id) && !row.querySelector(".doc-channels")) {chosen = row; break;}
    }
    chosen ||= first;
    if (currentRow === chosen) return;
    currentRow?.setAttribute("aria-current", "false");
    chosen?.setAttribute("aria-current", "true"); currentRow = chosen;
  }
  let treeExit = null;
  function clearTreeExit() {
    if (!treeExit) return;
    globalThis.AtriumMotionUI?.cancel(treeExit);
    treeExit.remove();
    treeExit = null;
  }
  function toggleRow(entry) {
    const collapse = entry.data.open, motion = globalThis.AtriumMotionUI;
    const update = () => { expansion.set(entry.data.key, !collapse); renderExplorer(); showCurrent(explorerId); };
    clearTreeExit();
    if (!motion?.enabled()) { update(); return; }
    const scroll = explorer.closest(".panel-body") || explorer;
    const bounds = scroll.getBoundingClientRect(), before = new Map();
    for (const node of explorer.children) {
      if (!node.matches('[role="treeitem"]')) continue;
      const at = node.getBoundingClientRect();
      if (at.top >= bounds.bottom) break;
      if (at.bottom > bounds.top && at.top < bounds.bottom) before.set(node,at);
    }
    const animate = {duration:"base",curve:"decelerate"};
    if (motion.moves()) motion.flip(before.keys(),update,animate);
    else update();
    if (!collapse) {
      const after = explorer.getBoundingClientRect();
      for (const node of explorer.children) {
        if (before.has(node) || !node.matches('[role="treeitem"]')) continue;
        const at = node.getBoundingClientRect();
        if (at.top >= bounds.bottom) break;
        if (at.top >= bounds.top && at.top < after.bottom)
          motion.enter(node,{...animate,from:{opacity:0}});
      }
      return;
    }
    const layer = document.createElement("div");
    layer.className = "tree-exit-layer";
    layer.inert = true;
    layer.setAttribute("aria-hidden","true");
    Object.assign(layer.style,{top:bounds.top + "px",left:bounds.left + "px",width:bounds.width + "px",height:bounds.height + "px"});
    for (const [node,at] of before) if (!node.isConnected) {
      const copy = node.cloneNode(true);
      for (const name of ["id","role","data-doc","data-instance","data-port","aria-current","aria-expanded"])
        copy.removeAttribute(name);
      Object.assign(copy.style,{top:(at.top - bounds.top) + "px",left:(at.left - bounds.left) + "px",width:at.width + "px",height:at.height + "px"});
      layer.append(copy);
    }
    if (!layer.childElementCount) return;
    treeExit = layer;
    document.body.append(layer);
    motion.exit(layer,{...animate,to:{opacity:0},done:() => { layer.remove(); if (treeExit === layer) treeExit = null; }});
  }
  // Key handlers run on the tree before the shell's roving-focus handler (Up/Down, Home/End and parent navigation).
  function keydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const r = event.target.closest("[role=treeitem]");
    if (!r || !r.hasAttribute("aria-expanded")) return;
    const open = r.getAttribute("aria-expanded") === "true";
    if (event.key === "ArrowLeft" && open || event.key === "ArrowRight" && !open) {
      r.querySelector("[data-tree-toggle]").click();
      event.preventDefault(); event.stopPropagation();
    }
  }
  function activateRow(entry, event) {
    const {data:r, row} = entry, host = globalThis.AtriumNavHost;
    if (event.target.closest("[data-tree-toggle]") || r.channels) {toggleRow(entry); return;}
    if (r.inst) occurrence.set(r.doc.id, r.inst.id);
    if (r.item) {
      const project = host.project();
      const jump = preview => {
        if (host.project() !== project || !r.doc.items.includes(r.item)) return;
        preview.jump({doc:r.doc, item:r.item, entry:null, instance:r.inst, name:r.item.text, kind:"port", io:r.io});
      };
      if (globalThis.AtriumConnectionPreview) jump(globalThis.AtriumConnectionPreview);
      else if (globalThis.AtriumLazy.modules().includes("AtriumConnectionPreview")) globalThis.AtriumLazy.need("AtriumConnectionPreview").then(jump, e => host.info(e.message));
      else {host.selectDocument(r.doc.id); host.select([r.item.id]); host.zoomTo([r.item.x - 3, r.item.y - 3, r.item.x + 3, r.item.y + 3]);}
    } else {
      const project = host.project();
      const activated = () => {
        if (host.project() !== project || host.currentId() !== r.doc.id) return;
        showCurrent(r.doc.id);
        if (r.inst) {
          const setInstance = preview => {
            if (host.project() === project && host.currentId() === r.doc.id && occurrence.get(r.doc.id) === r.inst.id)
              preview.activateInstance(r.doc.id, r.inst.id);
          };
          if (globalThis.AtriumConnectionPreview) setInstance(globalThis.AtriumConnectionPreview);
          else if (r.inst.parent && globalThis.AtriumLazy.modules().includes("AtriumConnectionPreview"))
            globalThis.AtriumLazy.need("AtriumConnectionPreview").then(setInstance, e => host.info(e.message));
        }
        if (row.isConnected && !document.body.classList.contains("hide-left")) row.focus({preventScroll:true});
      };
      const pending = selectFromExplorer?.(r.doc.id);
      if (pending?.then) pending.then(activated, e => host.info(e.message)); else activated();
    }
  }
  return {model, visible, direction, show, syncPanel, reviewScope, connectionLabel};
})();
