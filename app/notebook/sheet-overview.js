"use strict";
// A read-only document view. Hidden tabs only remember that the project changed.
globalThis.AtriumSheetOverview = (() => {
  const G = globalThis, id = "sheet-overview", V = G.AtriumDocViews, M = G.AtriumSheetOverviewModel;
  const pageSize = 12, svgNS = "http://www.w3.org/2000/svg";
  const arrows = new Set(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End"]);
  const t = G.AtriumI18n.define({
    "overview.title":"Sheet Overview",
    "overview.diagram":"Sheet diagram",
    "overview.keyboard":"Use the arrow keys to move between sheets and Enter to open a sheet. Tab moves to the connections.",
    "overview.sheet.one":"{count} sheet",
    "overview.sheet.many":"{count} sheets",
    "overview.loaded.one":"{count} loaded sheet",
    "overview.loaded.many":"{count} loaded sheets",
    "overview.loadSheets":"Load all sheets",
    "overview.loading":"Loading sheets…",
    "overview.noneLoaded":"No connections between the loaded sheets.",
    "overview.noSheetsLoaded":"No schematic sheets are loaded.",
    "overview.readOnly":"Read-only",
    "overview.hierarchy":"Sheet hierarchy",
    "overview.connections":"Connections",
    "overview.filter":"Filter connections",
    "overview.range":"{from}–{to} of {count}",
    "overview.previous":"Previous connections",
    "overview.next":"Next connections",
    "overview.none":"No connections between sheets.",
    "overview.noMatch":"No matching connections.",
    "overview.noSheets":"This project has no schematic sheets.",
    "overview.failed":"Could not draw the sheet overview.",
    "overview.openSheet":"Open {sheet}",
    "overview.openConnection":"Jump to {name} on {sheet}",
    "overview.channelCount":"{count} channels"
  });

  function el(tag, cls, value) { return AtriumNavCommon.classedElement(document, tag, cls, value); }
  function svg(tag, attrs = {}) {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  }
  function button(cls, label) {
    const b = el("button", cls);
    b.type = "button";
    b.setAttribute("aria-label", label);
    return b;
  }
  function shortInstance(node, target) {
    const inst = target?.instance || node.instances[0];
    return inst.label && inst.label !== node.doc.name ? node.doc.name + " · " + inst.label : node.doc.name;
  }
  function sheetButton(node, host) {
    const inst = node.instances[0], repeats = node.instances.length;
    const title = shortInstance(node);
    const name = repeats > 1 ? node.doc.name + ", " + t("overview.channelCount", {count:repeats}) : title;
    const b = button("sheet-overview-node", t("overview.openSheet", {sheet:name}));
    b.title = name;
    b.style.left = node.x + "px";
    b.style.top = node.y + "px";
    const label = el("span", "sheet-overview-node-name", node.doc.name);
    const detail = repeats > 1 ? inst.label && inst.channel ? inst.label + "–" + node.instances.at(-1).label : t("overview.channelCount", {count:repeats}) :
      inst.label !== node.doc.name ? inst.label : "";
    const words = el("span", "sheet-overview-node-words");
    words.append(label);
    if (detail) words.append(el("small", null, detail));
    b.append(G.AtriumNavCommon.icon("schematic"), words);
    if (repeats > 1) b.append(el("span", "sheet-overview-repeat", "×" + repeats));
    if (host.currentId() === node.doc.id) b.setAttribute("aria-current", "true");
    return b;
  }

  function mount(box, h) {
    box.classList.add("sheet-overview");
    const bar = el("div", "sheet-overview-bar"), projectName = el("strong"), count = el("span");
    const legend = el("span", "sheet-overview-legend", t("overview.hierarchy"));
    const readonly = el("span", "sheet-overview-readonly", t("overview.readOnly"));
    const loadSheets = button("sheet-overview-load ui-button", t("overview.loadSheets")), loading = el("span");
    loadSheets.textContent = t("overview.loadSheets"); loadSheets.hidden = true;
    loading.setAttribute("role", "status"); loading.hidden = true;
    bar.append(projectName, count, loadSheets, loading, legend, readonly);
    const session = h.folderProject?.(), purpose = "schematic-connections";
    const partial = () => session?.completeFor(purpose) === false;
    let loadRequest;
    loadSheets.onclick = async () => {
      if (loadRequest || !partial()) return;
      const request = loadRequest = new AbortController();
      loadSheets.disabled = true;
      loading.hidden = false; loading.textContent = t("overview.loading");
      try {
        await session.requireClosure({purpose, signal:request.signal});
        loading.hidden = true;
      } catch (error) {
        if (!request.signal.aborted) loading.textContent = error.message;
      } finally {
        loadRequest = null; loadSheets.disabled = false; dirty = true; schedule();
        if (box.isConnected && !box.hidden && !partial()) viewport.focus({preventScroll:true});
      }
    };

    const body = el("div", "sheet-overview-body"), viewport = el("div", "sheet-overview-viewport");
    const paper = el("div", "sheet-overview-paper"), drawing = svg("svg", {class:"sheet-overview-wires", "aria-hidden":"true"});
    const hierarchy = svg("g"), electric = svg("g"), chips = el("div", "sheet-overview-chips"), sheets = el("div");
    drawing.append(hierarchy, electric);
    paper.append(drawing, chips, sheets);
    const emptySheets = el("p", "sheet-overview-empty", t("overview.noSheets"));
    emptySheets.setAttribute("role", "status");
    const keyboard = el("p", "visually-hidden", t("overview.keyboard"));
    keyboard.id = "sheet-overview-keyboard";
    viewport.setAttribute("role", "group");
    viewport.setAttribute("aria-label", t("overview.diagram"));
    viewport.setAttribute("aria-describedby", keyboard.id);
    viewport.tabIndex = -1;
    viewport.append(keyboard, paper, emptySheets);

    const aside = el("section", "sheet-overview-aside"), heading = el("h2", null, t("overview.connections"));
    heading.id = "sheet-overview-list-heading";
    aside.setAttribute("aria-labelledby", heading.id);
    const search = el("input", "sheet-overview-search");
    search.type = "search";
    search.placeholder = t("overview.filter");
    search.setAttribute("aria-label", search.placeholder);
    const list = el("ul", "sheet-overview-list"), empty = el("p", "sheet-overview-empty"), footer = el("div", "sheet-overview-pages");
    const previous = button("sheet-overview-prev ui-button", t("overview.previous")), next = button("sheet-overview-next ui-button", t("overview.next"));
    previous.title = t("overview.previous"); next.title = t("overview.next");
    previous.append(G.AtriumNavCommon.icon("chevron")); next.append(G.AtriumNavCommon.icon("chevron"));
    const range = el("span"); range.setAttribute("role", "status");
    footer.append(previous, range, next);
    aside.append(heading, search, list, empty, footer);
    body.append(viewport, aside);
    box.append(bar, body);

    let compiled, data, filtered = [], page = 0, dirty = true, frame = 0, chosen = null, linksDoc;
    const nodeButtons = new Map(), branches = new Map(), wireEls = new Map();

    function jumpSheet(node) {
      V.hide(id);
      G.AtriumCamera.jump(node.doc.id, () => {
        G.AtriumConnectionPreview.activateInstance(node.doc.id, node.instances.length === 1 ? node.instances[0].id : null);
        h.canvas()?.focus({preventScroll:true});
      });
    }
    function target(link) {
      return h.currentId() === link.to.doc.id && link.from.doc.id !== link.to.doc.id ? link.a : link.b;
    }
    function jumpLink(link) {
      V.hide(id);
      G.AtriumConnectionPreview.jump(target(link));
    }
    function emphasize(link, on) {
      for (const n of wireEls.get(link) || []) n.classList.toggle("is-emphasized", on);
    }
    function markLink(b, link) {
      b.addEventListener("pointerenter", () => emphasize(link, true));
      b.addEventListener("pointerleave", () => emphasize(link, false));
      b.addEventListener("focus", () => emphasize(link, true));
      b.addEventListener("blur", () => emphasize(link, false));
      b.addEventListener("click", () => jumpLink(link));
    }
    function linkLabel(link) {
      const terminal = target(link), node = terminal === link.a ? link.from : link.to;
      return t("overview.openConnection", {name:link.name, sheet:shortInstance(node, terminal)});
    }

    function connections() {
      linksDoc = h.currentId();
      const first = page * pageSize, current = filtered.slice(first, first + pageSize);
      empty.hidden = !!current.length;
      list.hidden = !current.length;
      empty.textContent = search.value.trim() ? t("overview.noMatch") : t(incomplete ? "overview.noneLoaded" : "overview.none");
      search.disabled = !data?.links.length;
      range.textContent = current.length ? t("overview.range", {from:first+1, to:first+current.length, count:filtered.length}) : "";
      footer.hidden = filtered.length <= pageSize;
      previous.disabled = page === 0;
      next.disabled = first + current.length >= filtered.length;

      const items = document.createDocumentFragment(), pairs = new Map();
      for (const link of current) {
        const li = el("li"), b = button("sheet-overview-connection", linkLabel(link));
        const path = shortInstance(link.from, link.a) + " ↔ " + shortInstance(link.to, link.b);
        b.title = link.name + " · " + path;
        b.append(el("strong", null, link.name), el("small", null, path));
        markLink(b, link); li.append(b); items.append(li);
        if (!pairs.has(link.pair)) pairs.set(link.pair, []);
        pairs.get(link.pair).push(link);
      }
      list.replaceChildren(items);
      list.scrollTop = 0;
      electric.replaceChildren(); chips.replaceChildren(); wireEls.clear();
      const occupied = [], lanes = [];
      let extra = 0;
      for (const group of pairs.values()) {
        // A heavily used sheet pair shares one line. All its individual signal
        // names remain reachable on this page or through the connection filter.
        const bundled = group.length > 3;
        for (const [k, link] of (bundled ? group.slice(0,1) : group).entries()) {
          const members = bundled ? group : [link], offset = bundled ? 0 : (k - (group.length-1)/2) * 27;
          const route = trace(link, offset, lanes);
          const path = svg("path", {class:"sheet-overview-wire" + (link.bus || bundled ? " sheet-overview-bus" : ""), d:route.d});
          const hit = svg("path", {class:"sheet-overview-wire-hit", d:route.d});
          markLink(hit, link); electric.append(path, hit);
          const chip = button("sheet-overview-wire-label", linkLabel(link));
          chip.tabIndex = -1; // the native connection list provides the same jumps in reading order
          chip.append(el("span", null, link.name));
          if (bundled) chip.append(el("small", null, "+" + (members.length-1)));
          chip.title = members.map(m => m.name).join(" · ");
          const half = Math.min(60, 15 + link.name.length * 4 + (bundled ? 16 : 0));
          let slot = labelSlot(route, half, occupied);
          if (!slot) {
            // Keep the name and its jump available when several wires occupy
            // the same short gutter. A leader attaches the label below the map.
            extra += 28;
            slot = {x:route.x, y:data.height+extra-14};
            electric.prepend(svg("path", {class:"sheet-overview-label-leader", d:`M${route.x} ${route.y}V${slot.y}`}));
          }
          chip.style.left = slot.x + "px"; chip.style.top = slot.y + "px";
          markLink(chip, link); chips.append(chip);
          for (const member of members) wireEls.set(member, [path, chip]);
        }
      }
      if (data) paper.style.setProperty("--overview-height", data.height+extra+"px");
    }

    function trace(link, offset, lanes) {
      let best, overlaps = Infinity;
      for (const lane of [0,16,-16,32,-32,48,-48]) {
        const route = M.wire(link.from, link.to, offset, false, lane);
        const count = lanes.filter(old => Math.abs(old.x-route.x) < 13 &&
          Math.min(old.y1,old.y2) < Math.max(route.y1,route.y2) && Math.max(old.y1,old.y2) > Math.min(route.y1,route.y2)).length;
        if (count < overlaps) {best = route; overlaps = count;}
        if (!count) break;
      }
      lanes.push(best);
      return best;
    }

    function labelSlot(route, half, occupied) {
      const min = Math.min(route.y1, route.y2), max = Math.max(route.y1, route.y2);
      for (const shift of [0, -28, 28, -56, 56]) {
        const x = route.x, y = route.y + shift;
        if (y < min || y > max || occupied.some(r => Math.abs(r.x - x) < r.half + half && Math.abs(r.y - y) < 25)) continue;
        // A long net can cross intermediate columns. Keep its label clear of sheet boxes.
        if (data.nodes.some(n => x+half > n.x && x-half < n.x+M.width && y+12 > n.y && y-12 < n.y+M.height)) continue;
        const box = {x,y,half}; occupied.push(box); return box;
      }
      return null;
    }

    function filter(reset) {
      const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      filtered = (data?.links || []).filter(link => {
        if (!words.length) return true;
        const names = [link.name, shortInstance(link.from, link.a), shortInstance(link.to, link.b), ...link.nets].join(" ").toLowerCase();
        return words.every(word => names.includes(word));
      });
      page = reset ? 0 : Math.min(page, Math.max(0, Math.ceil(filtered.length/pageSize)-1));
      connections();
    }
    search.addEventListener("input", () => filter(true));
    const turn = (step, from, other) => {
      page += step; connections();
      if (from.disabled) other.focus();
    };
    previous.addEventListener("click", () => turn(-1, previous, next));
    next.addEventListener("click", () => turn(1, next, previous));

    function visibleSheets() {
      if (!data?.nodes.length) return;
      const margin = 100, left = viewport.scrollLeft - margin, right = viewport.scrollLeft + viewport.clientWidth + margin;
      const top = viewport.scrollTop - margin, bottom = viewport.scrollTop + viewport.clientHeight + margin;
      const shown = data.nodes.filter(n => n.x+M.width > left && n.x < right && n.y+M.height > top && n.y < bottom);
      if (chosen && !shown.includes(chosen) && nodeButtons.get(chosen) === document.activeElement) shown.push(chosen);
      if (!shown.includes(chosen)) chosen = shown[0];
      const keep = new Set(shown);
      for (const [node, b] of nodeButtons) if (!keep.has(node)) {
        b.remove(); nodeButtons.delete(node); branches.get(node)?.remove(); branches.delete(node);
      }
      let before = null;
      for (let i = shown.length-1; i >= 0; i--) {
        const node = shown[i];
        let b = nodeButtons.get(node);
        if (!b) {
          b = sheetButton(node, h); nodeButtons.set(node, b);
          b.addEventListener("click", () => jumpSheet(node));
          b.addEventListener("focus", () => {chosen = node; updateTabStop();});
          b.addEventListener("keydown", e => {
            if (!arrows.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            const nextNode = M.adjacent(data.nodes, node, e.key);
            if (nextNode) focusSheet(nextNode);
          });
          sheets.insertBefore(b, before);
          if (node.parent) {
            const edge = svg("path", {class:"sheet-overview-branch", d:M.wire(node.parent, node, 0, true).d});
            branches.set(node, edge); hierarchy.append(edge);
          }
        }
        before = b;
      }
      updateTabStop();
    }
    function updateTabStop() {
      for (const [node, b] of nodeButtons) b.tabIndex = node === chosen ? 0 : -1;
    }
    function focusSheet(node) {
      if (!node) {viewport.focus({preventScroll:true}); return;}
      chosen = node;
      if (node.x < viewport.scrollLeft || node.x + M.width > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = node.x - 20;
      if (node.y < viewport.scrollTop || node.y + M.height > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = node.y - 20;
      visibleSheets(); nodeButtons.get(node)?.focus({preventScroll:true});
    }

    let incomplete = false;
    function paint() {
      frame = 0;
      if (box.hidden || !box.isConnected) return;
      const wasIncomplete = incomplete;
      incomplete = partial();
      loadSheets.hidden = !incomplete;
      if (!incomplete) loading.hidden = true;
      if (dirty) {
        dirty = false;
        try {
          const next = G.AtriumHierarchy.compileCached(h.project(), {defs:h.defs()});
          if (next !== compiled || wasIncomplete !== incomplete) {
            const focused = nodeButtons.get(chosen) === document.activeElement, old = chosen?.instances[0].id;
            data = M.build(next, G.AtriumSheetConnections.index(next).nets); compiled = next;
            projectName.textContent = h.project().name;
            count.textContent = t(incomplete ? (data.sheetCount === 1 ? "overview.loaded.one" : "overview.loaded.many") :
              (data.sheetCount === 1 ? "overview.sheet.one" : "overview.sheet.many"), {count:data.sheetCount});
            legend.hidden = !data.hierarchical;
            paper.hidden = !data.nodes.length;
            emptySheets.hidden = !!data.nodes.length; emptySheets.textContent = t(incomplete ? "overview.noSheetsLoaded" : "overview.noSheets");
            paper.style.setProperty("--overview-width", data.width+"px");
            paper.style.setProperty("--overview-height", data.height+"px");
            paper.style.setProperty("--overview-node-width", M.width+"px");
            paper.style.setProperty("--overview-node-height", M.height+"px");
            drawing.setAttribute("width", data.width); drawing.setAttribute("height", data.height);
            sheets.replaceChildren(); hierarchy.replaceChildren(); nodeButtons.clear(); branches.clear();
            chosen = data.nodes.find(n => n.instances[0].id === old) || data.nodes[0];
            filter(false);
            if (focused) focusSheet(chosen);
          }
        } catch (error) {
          compiled = data = null; chosen = null;
          paper.hidden = true; emptySheets.hidden = false; emptySheets.textContent = t("overview.failed");
          count.textContent = ""; legend.hidden = true;
          filter(true); h.info(error.message);
        }
      }
      if (linksDoc !== h.currentId()) connections();
      for (const [node, b] of nodeButtons) {
        if (node.doc.id === h.currentId()) b.setAttribute("aria-current", "true");
        else b.removeAttribute("aria-current");
      }
      visibleSheets();
    }
    function schedule() {
      if (!frame && !box.hidden) frame = requestAnimationFrame(paint);
    }
    viewport.addEventListener("scroll", schedule, {passive:true});
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    const showing = new MutationObserver(() => {
      if (box.hidden) return;
      cancelAnimationFrame(frame);
      paint();
      if (document.activeElement?.getAttribute("aria-controls") !== box.id) focusSheet(chosen);
    });
    showing.observe(box, {attributes:true, attributeFilter:["hidden"]});
    const changed = () => {dirty = true; schedule();};
    const change = h.on("change", changed), owner = h.on("folder-owner", changed);
    const replace = h.on("replace", () => V.close(id));
    box.addEventListener("keydown", e => {
      if (e.key === "Escape") {e.preventDefault(); V.hide(id);}
      e.stopPropagation();
    });
    return () => {loadRequest?.abort(); cancelAnimationFrame(frame); resize.disconnect(); showing.disconnect(); change(); owner(); replace();};
  }

  function open(host) {
    let close = () => {};
    V.open(id, {title:t("overview.title"), icon:"schematic", onClose:() => close(), mount:box => {close = mount(box, host);}});
  }
  G.AtriumNavCommon.ready(h => h.registerAction(id, () => open(h)));
  return Object.freeze({open});
})();
