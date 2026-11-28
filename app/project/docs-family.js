"use strict";
// The documents family: saved views, slides, the datasheet reader
// and visual history share one thumbnail strip, one pager and one presentation mode. Lazy: loaded only
// when a Butter documents feature is on and one of its surfaces opens.
globalThis.AtriumDocsFamily = (() => {
  const G = globalThis, doc = G.document;
  const kit = () => G.AtriumLazy.need("AtriumUIKit");

  // ------------------------------------------------------------------ thumbnail strip
  // items: [{id, label, title, state, ratio, draw(canvas, signal)}]. Only tiles in view draw.
  // Selection follows stable ids through refreshes; arrows move it, Enter or a click picks.
  function strip(K, {label, orientation = "column", onPick, onKey, ratio = "16 / 9", size} = {}) {
    const node = K.el("div", "ui-thumbs docs-strip");
    node.dataset.strip = orientation === "row" ? "row" : "";
    node.setAttribute("role", "group"); node.setAttribute("aria-label", label || "Thumbnails");
    node.style.setProperty("--ui-thumb-ratio", ratio);
    if (size) node.style.setProperty("--ui-thumb-size", size);
    const tiles = new Map(), A = () => G.AtriumHistoryArtwork;
    let watch = null, current = null, items = [], marked = null, tabbable = null;
    function tile(item) {
      let t = tiles.get(item.id);
      const key = [item.label, item.state || "", item.version || ""].join("\u0000");
      if (t && t.key === key) return t;
      const art = doc.createElement("canvas"); art.width = art.height = 1; art.setAttribute("aria-hidden", "true");
      const button = K.thumb({label: item.label, art, state: item.state || (item.draw ? "pending" : undefined), run: () => onPick?.(item.id, "pointer")});
      button.dataset.id = item.id; button.title = item.title || item.label; button.tabIndex = -1;
      if (item.ratio) button.style.setProperty("--ui-thumb-ratio", item.ratio);
      button.addEventListener("contextmenu", event => item.menu?.(event, button));
      if (t) { watch?.forget(t.node); t.node.replaceWith(button); }
      t = {node: button, key, art};
      tiles.set(item.id, t);
      if (item.draw && watch) watch.add(button, async signal => {
        await item.draw(art, signal);
        if (!signal.aborted && art.dataset.ready === "true" && button.dataset.state === "pending") delete button.dataset.state;
      });
      return t;
    }
    function update(next, currentId) {
      items = next; current = currentId ?? current;
      if (!watch && A()) watch = A().watch(node);
      const keep = new Set(items.map(i => i.id));
      for (const [id, t] of tiles) if (!keep.has(id)) { watch?.forget(t.node); t.node.remove(); tiles.delete(id); }
      let prev = null;
      items.forEach((item, i) => {
        const t = tile(item);
        t.index = i;
        if ((prev ? prev.nextSibling : node.firstChild) !== t.node) prev ? prev.after(t.node) : node.prepend(t.node);
        prev = t.node;
      });
      mark();
    }
    function mark() {
      const selected = tiles.get(current)?.node ?? null;
      const focusable = selected || node.firstElementChild;
      if (selected !== marked) {
        marked?.removeAttribute("aria-current");
        selected?.setAttribute("aria-current", "true");
        marked = selected;
      }
      if (focusable !== tabbable) {
        if (tabbable) tabbable.tabIndex = -1;
        if (focusable) focusable.tabIndex = 0;
        tabbable = focusable;
      }
    }
    function select(id, {reveal = true, focus = false} = {}) {
      current = id; mark();
      const t = tiles.get(id);
      if (t && reveal) t.node.scrollIntoView({block: "nearest", inline: "nearest"});
      if (t && focus) t.node.focus({preventScroll: true});
    }
    node.addEventListener("keydown", event => {
      if (onKey?.(event) === true) return;
      const at = tiles.get(current)?.index ?? 0;
      const fwd = orientation === "row" ? "ArrowRight" : "ArrowDown", back = orientation === "row" ? "ArrowLeft" : "ArrowUp";
      let to = null;
      if (event.key === fwd && !event.altKey) to = Math.min(items.length - 1, at + 1);
      else if (event.key === back && !event.altKey) to = Math.max(0, at - 1);
      else if (event.key === "Home") to = 0;
      else if (event.key === "End") to = items.length - 1;
      else if (event.key === "Enter" || event.key === " ") { if (current) onPick?.(current, "key"); event.preventDefault(); return; }
      if (to == null || !items.length) return;
      event.preventDefault();
      const id = items[to].id;
      select(id, {focus: true});
      onPick?.(id, "key");
    });
    const close = () => { watch?.close(); watch = null; tiles.clear(); items = []; node.replaceChildren(); mark(); };
    return {node, update, select, close, tile: id => tiles.get(id)?.node, current: () => current};
  }

  // Draw a document region into a thumbnail canvas through the editor's own renderer.
  function drawRegion(canvas, document, defs, bounds) {
    const A = G.AtriumHistoryArtwork, box = canvas.parentElement?.getBoundingClientRect?.();
    const w = Math.max(48, Math.round(box?.width || 160)), h = Math.max(27, Math.round(box?.height || 90));
    if (!A || !document?.items) return false;
    A.copy(canvas, A.render(document, defs, {w, h}, bounds));
    return true;
  }
  function cameraBounds(camera, viewport) {
    const [cx, cy] = camera.center, s = camera.scale || 1;
    const w = (viewport?.pixelWidth || 960) / s / 2, h = (viewport?.pixelHeight || 540) / s / 2;
    return [cx - w, cy - h, cx + w, cy + h];
  }

  // ------------------------------------------------------------------ presentation mode
  // One mode for slides and saved views. The canvas stays live (pan and zoom inspect the slide);
  // the floating bar steps, shows notes and ends. Keys: → Space Page Down N next; ← Page Up P back;
  // Home/End; a number then Return jumps; Esc ends. Touch: swipe the bar, or tap its arrows.
  let active = null;
  async function present(spec) {
    const K = await kit();
    active?.end("replaced");
    const host = G.AtriumNavHost, root = doc.documentElement;
    const unit = spec.unit || "slide";
    const pager = K.pager({unit, label: spec.label || "Presentation", onStep: d => go(d)});
    const title = K.el("span", "ui-toolbar-title", "Opening…");
    const badge = K.el("span", "ui-badge"); badge.hidden = true;
    const back = K.button("Back to " + unit, {variant: "quiet", size: "sm", run: () => spec.resume?.()}); back.hidden = true;
    const notes = spec.notes ? K.button("Notes", {variant: "quiet", size: "sm", pressed: false, run: () => toggleNotes()}) : null;
    const presenter = spec.presenterWindow ? K.button("Presenter window", {variant: "quiet", size: "sm", run: () => spec.presenterWindow()}) : null;
    const end = K.button("End", {variant: "quiet", size: "sm", run: () => finish("user")});
    end.dataset.tooltipShortcut = "Escape";
    const bar = K.toolbar([pager, title, badge, "|", back, ...(notes ? [notes] : []), ...(presenter ? [presenter] : []), end],
      {label: spec.label || "Presentation", floating: true});
    bar.classList.add("docs-stage-bar");
    const card = K.el("div", "ui-popover docs-notes"); card.hidden = true; card.setAttribute("role", "region"); card.setAttribute("aria-label", "Speaker notes");
    const notesText = K.el("div", "docs-notes-text ui-selectable"), notesMeta = K.statusLine("");
    card.append(notesMeta, notesText);
    doc.body.append(card, bar);
    root.dataset.presenting = spec.kind || "slides";
    const zen = doc.body.classList.contains("dock-zen"); doc.body.classList.add("dock-zen");
    G.dispatchEvent(new Event("resize"));
    let idle = 0, typed = "", typedTimer = 0, moved = false, state = {index: 0, total: 0}, timer = 0;
    const wake = () => { delete bar.dataset.idle; clearTimeout(idle); idle = setTimeout(() => { if (!card.hidden) return; bar.dataset.idle = ""; }, 2600); };
    function toggleNotes(on = card.hidden) {
      card.hidden = !on; notes?.setAttribute("aria-pressed", String(on)); wake();
      clearInterval(timer); if (on) timer = setInterval(paintNotes, 1000);
      paintNotes();
    }
    function paintNotes() {
      if (card.hidden) return;
      const s = state, t = Math.floor((Date.now() - (s.startedAt || Date.now())) / 1000);
      const clock = Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
      notesMeta.querySelector(".ui-status-text").textContent = [clock, s.next ? "Next: " + s.next : "Last " + unit].join(" · ");
      notesText.textContent = s.notes || "No notes for this " + unit + ".";
      notesText.dataset.empty = s.notes ? "false" : "true";
    }
    function update(next) {
      state = {...state, ...next};
      pager.set(state.index ?? 0, state.total ?? 0);
      title.textContent = state.title || "";
      title.title = state.title || "";
      const problem = state.problem;
      badge.hidden = !problem;
      if (problem) { badge.textContent = problem.label; badge.dataset.tone = problem.tone || "warning"; badge.title = problem.text || problem.label; }
      if (presenter) { presenter.disabled = !!state.presenterUnavailable; presenter.title = state.presenterUnavailable || "Show notes and the next " + unit + " in a second window"; }
      moved = false; back.hidden = true;
      paintNotes(); wake();
    }
    async function go(delta) {
      const total = state.total || 0;
      if (!total) return;
      const at = state.index ?? 0;
      const to = delta === -Infinity ? 0 : delta === Infinity ? total - 1 : at + delta;
      if (to < 0 || to >= total || to === at) { wake(); return; }
      await spec.step(to, to - at);
    }
    function keys(event) {
      if (!active || event.defaultPrevented) return;
      const t = event.target;
      if (t?.closest?.("input,textarea,select,[contenteditable=true],dialog[open]") && !bar.contains(t)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      let d = null;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "n", "N"].includes(event.key)) d = 1;
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"].includes(event.key)) d = -1;
      else if (event.key === "Home") d = -Infinity;
      else if (event.key === "End") d = Infinity;
      else if (/^[0-9]$/.test(event.key)) { typed += event.key; clearTimeout(typedTimer); typedTimer = setTimeout(() => { typed = ""; }, 1500); }
      else if (event.key === "Enter" && typed) { const n = Number(typed) - 1; typed = ""; if (n >= 0 && n < state.total) void spec.step(n, n - state.index); }
      else if (event.key === "Escape") { if (!card.hidden) toggleNotes(false); else finish("user"); }
      else return;
      if (bar.contains(t) && (event.key === " " || event.key === "Enter") && t.matches("button")) return;
      event.preventDefault(); event.stopPropagation(); wake();
      if (d != null) void go(d);
    }
    // A camera move after a step offers the way back; the slide stays current.
    const canvas = doc.getElementById("editor-area") || doc.getElementById("canvas");
    const inspect = event => {
      if (bar.contains(event.target) || card.contains(event.target)) return;
      if (event.type === "pointerdown" && event.pointerType === "mouse" && event.button === 0 && !event.shiftKey) return;
      if (!moved && spec.resume) { moved = true; back.hidden = false; }
      wake();
    };
    // Swipe on the bar steps: a quick horizontal stroke of 48 px or more.
    let swipe = null;
    bar.addEventListener("pointerdown", e => { if (e.pointerType !== "mouse") swipe = {x: e.clientX, y: e.clientY, t: e.timeStamp}; });
    bar.addEventListener("pointerup", e => {
      const s = swipe; swipe = null;
      if (!s || e.timeStamp - s.t > 600) return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > 2 * Math.abs(dy)) void go(dx < 0 ? 1 : -1);
    });
    G.addEventListener("keydown", keys, true);
    G.addEventListener("pointermove", wake, {passive: true});
    canvas?.addEventListener("wheel", inspect, {passive: true, capture: true});
    canvas?.addEventListener("pointerdown", inspect, {passive: true, capture: true});
    let done = false;
    function finish(reason) {
      if (done) return; done = true;
      G.removeEventListener("keydown", keys, true); G.removeEventListener("pointermove", wake);
      canvas?.removeEventListener("wheel", inspect, true); canvas?.removeEventListener("pointerdown", inspect, true);
      clearTimeout(idle); clearInterval(timer); clearTimeout(typedTimer);
      bar.remove(); card.remove();
      delete root.dataset.presenting;
      if (!zen) doc.body.classList.remove("dock-zen");
      G.dispatchEvent(new Event("resize"));
      if (active === controller) active = null;
      void spec.end?.(reason);
      host?.canvas?.()?.focus?.();
    }
    const controller = {update, end: finish, bar, notes: card, kind: spec.kind, go, toggleNotes, unmoved: () => { moved = false; back.hidden = true; }};
    active = controller;
    wake();
    host?.canvas?.()?.focus?.({preventScroll: true});
    // Let the canvas take the whole window before the first slide fits its camera.
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    return controller;
  }

  return Object.freeze({strip, drawRegion, cameraBounds, present, active: () => active});
})();
