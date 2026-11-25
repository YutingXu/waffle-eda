"use strict";

// Loaded on the first direct touch. The pointer controller owns all gesture recognition,
// capture and replay. This module supplies the target, feedback and modifier choices.
globalThis.AtriumTouchPrecision = (() => {
  const radius = 22;
  const t = AtriumI18n.define({
    "touch.add":"Add", "touch.copy":"Copy", "touch.free":"Free", "touch.lock":"Lock", "touch.snap":"Snap",
    "touch.controls":"Touch editing modifiers", "touch.shift":"Shift, add to selection",
    "touch.ctrl":"Ctrl, duplicate by dragging", "touch.alt":"Alt, ignore snapping", "touch.hold":"Lock touch modifiers across edits"
  });
  AtriumI18n.scope(".touch-modifiers,.touch-loupe","touch");
  const controls = [
    ["shiftKey", "Shift", "touch.add", "touch.shift"],
    ["ctrlKey", "Ctrl", "touch.copy", "touch.ctrl"],
    ["altKey", "Alt", "touch.free", "touch.alt"],
    ["lock", "", "touch.lock", "touch.hold"]
  ];
  const modifiers = {shiftKey:false, ctrlKey:false, altKey:false};
  let locked = false, bar, lens, owner, edit, frame = 0, field, focusFrame = 0, fieldDialog, focusAnchor, focusHeight;
  const host = () => globalThis.AtriumNavHost;
  const surface = c => globalThis.AtriumCanvasInput?.surface(c)?.input;
  const container = c => c.closest(".fe-centre,.split-pane") || c.parentElement;
  const free = c => edit?.canvas === c && (modifiers.altKey || edit.altKey);
  const snapPoint = (c, p) => {
    if (free(c)) return p;
    const input = surface(c);
    if (input) return input.precision?.point?.(p) || p;
    const h = host(), drag = h.drag();
    return drag?.touchPoint || drag?.copy?.at || h.snapAt(p);
  };
  const project = (c, p) => surface(c)?.screen(p) || host().view().worldToScreen(p);

  function sync() {
    globalThis.AtriumCanvasInput?.setModifiers(modifiers);
    if (bar) for (const b of bar.children)
      b.setAttribute("aria-pressed", String(b.dataset.key === "lock" ? locked : modifiers[b.dataset.key]));
  }
  function clearKeys() {
    modifiers.shiftKey = modifiers.ctrlKey = modifiers.altKey = false;
    sync();
  }
  function showBar(c) {
    document.documentElement.classList.add("touch-controls");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "touch-modifiers";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", t("touch.controls"));
      for (const [key, shortcut, name, label] of controls) {
        const b = AtriumNavCommon.elWithAttributes("button", null, "ui-choice ui-choice-tinted",
          {type:"button", "data-key":key, "data-size":"touch", title:t(label), "aria-label":t(label)});
        if (shortcut) b.append(AtriumShortcut.render(shortcut, {variant:"inline"}));
        else {
          const glyph = document.createElementNS("http://www.w3.org/2000/svg","svg");
          glyph.setAttribute("viewBox","0 0 24 24"); glyph.setAttribute("aria-hidden","true");
          glyph.innerHTML = '<path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z"/>';
          b.append(glyph);
        }
        b.append(document.createTextNode(t(name)));
        b.onclick = () => {
          if (key === "lock") locked = !locked;
          else modifiers[key] = !modifiers[key];
          sync();
        };
        bar.append(b);
      }
      sync();
    }
    const box = container(c);
    if (bar.parentNode !== box) { box.classList.add("touch-surface"); box.append(bar); }
    bar.hidden = false; owner = c;
  }

  // Search only the contact's spatial cell. A selected grip wins over nearby artwork.
  // Square hit areas retain their full 44 × 44 logical points at every zoom and rotation.
  function hit(d) {
    const c = d.canvas, p = d.world;
    showBar(c);
    const h = host(), input = surface(c);
    if (!input && h.canvas() !== c) return;
    const worldToScreen = input?.screen || h.view().worldToScreen;
    const from = worldToScreen(p);
    let best, bestRank = Infinity, bestDist = Infinity;
    function consider(at, item, rank = 0) {
      if (!at || !at.every(Number.isFinite)) return;
      const s = worldToScreen(at), dx = s[0] - from[0], dy = s[1] - from[1], dist = dx*dx + dy*dy;
      if (Math.abs(dx) > radius || Math.abs(dy) > radius || rank > bestRank || rank === bestRank && dist >= bestDist) return;
      best = {item, at}; bestRank = rank; bestDist = dist;
    }
    if (input) {
      if (d.tool === "select") input.precision?.grips?.(p, consider);
    } else {
      globalThis.AtriumPCBDraw?.touchGrips?.(p,consider);
      if (d.tool === "select") {
        const v = h.view(), tol = Math.SQRT2 * radius / v.scale(), ids = h.selection();
        for (const item of v.query(h.doc(), h.defs(), [p[0]-tol,p[1]-tol,p[0]+tol,p[1]+tol])) {
          const selected = ids.length === 1 && ids[0] === item.id;
          // Grips belong to the selection only, so what a finger grabs never depends on what lies nearby.
          if (!h.selectable(item) || !selected) continue;
          const rank = selected ? 0 : 1;
          if (selected) for (const g of globalThis.AtriumSchObjects?.grips(item) || []) consider(g.at, item, rank);
          if (item.kind === "wire" || item.kind === "track") {
            consider(item.points[0], item, rank); consider(item.points.at(-1), item, rank);
          } else if (Number.isFinite(item.x) && !["sheetsymbol", "textframe", "image"].includes(item.kind)) {
            // A normal hit on the object's interior keeps its original pointer offset.
            if (!d.item) consider([item.x,item.y], item, rank);
          }
        }
      }
    }
    if (best) { d.anchor = best.at; if (best.item) d.item = best.item; d.edit = true; }
  }

  // Capture and prepare once, only after the drag threshold. Release commits the normal
  // paste plan, including fresh references and ids. Cancellation has no project writes.
  function duplicate(h, start) {
    const doc = h.doc(), project = h.project(), ids = new Set(h.selection());
    const signal = globalThis.AtriumLabs?.notebookSignal();
    let copy, plan, at, released = false;
    const current = () => !signal?.aborted && h.doc() === doc && h.project() === project;
    const requested = () => current() && (released || h.drag()?.copy === gesture);
    function place() {
      if (!plan || !current()) return;
      let placed;
      h.edit(() => { placed = plan.commit(at); });
      h.select(placed);
    }
    const gesture = {
      get plan() { return plan; }, get at() { return at; },
      move(p) {
        if (!copy) {
          copy = AtriumEditSelection.capture(doc, h.defs(), ids, false, project.blobs);
          if (!copy) return;
          const prepare = () => { plan = AtriumEditSelection.prepare(project, doc, copy, h.defs()); };
          const pending = AtriumEditSelection.demand(copy);
          if (pending) pending.then(() => {
            if (!requested()) return;
            prepare();
            if (released) place(); else h.redrawOverlay();
          }).catch(error => { if (requested()) h.info(error.message); });
          else prepare();
        }
        const target = p.map((v,k) => copy.origin[k] + v - start[k]);
        at = free(h.canvas()) ? target : target.map(v => Atrium.snap(v,doc.grid));
      },
      commit() { if (!released) { released = true; place(); } }
    };
    return gesture;
  }

  function makeLens() {
    const n = document.createElement("div"), marker = document.createElement("i");
    marker.className = "touch-snap-point"; marker.setAttribute("aria-hidden", "true");
    n.className = "touch-loupe"; n.setAttribute("aria-hidden", "true");
    const sample = document.createElement("canvas"), cross = document.createElement("i"), label = document.createElement("span");
    n.append(sample, cross, label);
    return {n, sample, label, marker};
  }
  function paint() {
    frame = 0;
    if (!edit || !edit.canvas.isConnected) { hideLens(); return; }
    const c = edit.canvas, r = c.getBoundingClientRect(), box = container(c), b = box.getBoundingClientRect();
    if (!(r.width && r.height && c.width && c.height)) return;
    const at = project(c, snapPoint(c, edit.editPoint || edit.world));
    lens ||= makeLens();
    if (lens.n.parentNode !== box) box.append(lens.marker,lens.n);
    lens.marker.hidden = !!free(c);
    lens.marker.style.left = (r.left-b.left+at[0])+"px";
    lens.marker.style.top = (r.top-b.top+at[1])+"px";
    const side = 88, zoom = 2.5, dpr = Math.min(devicePixelRatio || 1, 3), backing = Math.round(side*dpr);
    if (lens.sample.width !== backing) lens.sample.width = lens.sample.height = backing;
    const ctx = lens.sample.getContext("2d");
    const w = side / zoom, sx = c.width/r.width, sy = c.height/r.height;
    ctx.clearRect(0,0,backing,backing);
    ctx.drawImage(c,(at[0]-w/2)*sx,(at[1]-w/2)*sy,w*sx,w*sy,0,0,backing,backing);
    const x = Math.max(1,Math.min(b.width-side-1,edit.clientX-b.left-side/2));
    let y = edit.clientY-b.top-side-24;
    if (y<0) y = edit.clientY-b.top+28;
    lens.n.style.transform = "translate("+x+"px,"+Math.max(0,Math.min(b.height-side,y))+"px)";
    lens.label.textContent = t(free(c) ? "touch.free" : "touch.snap");
    lens.n.hidden = false;
  }
  function hideLens() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0; edit = null;
    if (lens) lens.n.hidden = lens.marker.hidden = true;
  }
  function editing(d) {
    if (d.pointerType !== "touch") return;
    if (d.phase === "end" || d.phase === "cancel") {
      hideLens(); if (!locked) clearKeys(); return;
    }
    edit = d;
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function textual(n) {
    return !!n?.matches?.('textarea,[contenteditable=""],[contenteditable="true"],input:not([type]),input:is([type=text],[type=search],[type=number],[type=email],[type=url],[type=tel],[type=password])');
  }
  function resetViewport() {
    document.body.classList.remove("touch-keyboard");
    document.body.style.removeProperty("--touch-viewport-bottom");
    if (fieldDialog) {
      fieldDialog.classList.remove("touch-keyboard-dialog"); fieldDialog.style.removeProperty("--touch-dialog-top");
      fieldDialog = null;
    }
  }
  function caretRect(n) {
    const sel = document.getSelection();
    if (n.isContentEditable && sel?.rangeCount && n.contains(sel.focusNode)) {
      const range = document.createRange(); range.setStart(sel.focusNode,sel.focusOffset); range.collapse(true);
      const r = range.getBoundingClientRect(); if (r.height) return r;
    }
    return n.getBoundingClientRect();
  }
  function keepCanvasVisible(top,bottom) {
    if (!focusAnchor) return;
    const {pane,world} = focusAnchor, c=pane.canvas, h=host();
    if (!c.isConnected || pane.docId !== h.currentId() || c !== h.canvas()) return;
    const b=c.getBoundingClientRect(), low=Math.max(top,b.top)+12, high=Math.min(bottom,b.bottom)-12;
    if (high<=low) return;
    pane.view.resized(b);
    const y=b.top+pane.view.worldToScreen(world)[1], dy=Math.max(low,Math.min(high,y))-y;
    if (Math.abs(dy)>.5) { pane.view.pan(0,dy); h.redraw(); }
  }
  function reveal() {
    focusFrame = 0;
    const vv = window.visualViewport;
    if (!vv || !field?.isConnected || document.activeElement !== field) return;
    const r = caretRect(field), kb = navigator.virtualKeyboard?.boundingRect;
    // Windows can overlay the layout viewport. A floating keyboard affects only its own columns.
    const covered = kb?.height > 0 && kb.right >= r.left && kb.left <= r.right;
    const bottom = Math.min(vv.offsetTop + vv.height, covered ? kb.top : Infinity);
    const layoutHeight = document.documentElement.clientHeight || innerHeight;
    if (Math.abs(vv.scale-1) > .02 || Math.max(layoutHeight,focusHeight)-bottom < 48) { resetViewport(); return; }
    document.body.style.setProperty("--touch-viewport-bottom", bottom+"px");
    document.body.classList.add("touch-keyboard");
    const dlg = field.closest("dialog[open]");
    // These dialogs already lay themselves out from visualViewport on resize.
    if (dlg && !dlg.matches(".nav-palette,[data-math-editor]")) {
      fieldDialog = dlg; dlg.style.setProperty("--touch-dialog-top", vv.offsetTop+4+"px");
      dlg.classList.add("touch-keyboard-dialog");
    }
    keepCanvasVisible(vv.offsetTop,bottom);
    const caret = caretRect(field);
    if (caret.bottom > bottom-8 || caret.top < vv.offsetTop+8) field.scrollIntoView({block:"center", inline:"nearest", behavior:"instant"});
  }
  function queueReveal() { if (!focusFrame) focusFrame = requestAnimationFrame(reveal); }
  function unwatch() {
    if (focusFrame) cancelAnimationFrame(focusFrame);
    focusFrame = 0; field = focusAnchor = null;
    navigator.virtualKeyboard?.removeEventListener("geometrychange",queueReveal);
    window.visualViewport?.removeEventListener("resize", queueReveal);
    window.visualViewport?.removeEventListener("scroll", queueReveal);
    resetViewport();
  }
  function watch(n) {
    unwatch();
    if (!textual(n) || !window.visualViewport) return;
    field = n; focusHeight = document.documentElement.clientHeight || innerHeight;
    const holder = n.closest(".split-pane"), pane = holder && host()?.panes().find(p=>p.canvas.parentNode===holder && p.active);
    if (pane) {
      const r=caretRect(n), b=pane.canvas.getBoundingClientRect();
      focusAnchor={pane,world:pane.view.screenToWorld([(r.left+r.right)/2-b.left,r.bottom-b.top])};
    }
    navigator.virtualKeyboard?.addEventListener("geometrychange",queueReveal);
    window.visualViewport.addEventListener("resize",queueReveal);
    window.visualViewport.addEventListener("scroll",queueReveal);
    queueReveal();
  }
  const disappear = () => { hideLens(); if (!locked) clearKeys(); };
  const labs = globalThis.AtriumLabs;
  let subscriptions = [];
  function attach(enabled) {
    if (!enabled) {
      for (const off of subscriptions) off();
      subscriptions = [];
      locked = false; disappear(); unwatch();
      if (bar) bar.hidden = true;
      document.documentElement.classList.remove("touch-controls");
      return;
    }
    const signal = labs?.notebookSignal();
    const root = document.documentElement;
    root.classList.add("touch-controls");
    document.addEventListener("waffle-touch-hit", e => hit(e.detail), {signal});
    document.addEventListener("waffle-touch-edit", e => editing(e.detail), {signal});
    document.addEventListener("focusin", e => { if (textual(e.target)) watch(e.target); }, {signal});
    document.addEventListener("focusout", e => { if (field === e.target) unwatch(); }, {signal});
    document.addEventListener("pointerdown", e => {
      if (e.pointerType === "touch") root.classList.add("touch-controls");
      else if (e.pointerType === "mouse") root.classList.remove("touch-controls");
      if (bar && !locked && e.pointerType !== "touch" && !bar.contains(e.target)) {
        bar.hidden = true; clearKeys();
      }
    }, {capture:true,signal});
    addEventListener("blur",disappear,{signal});
    if (host()) subscriptions = ["document","replace","panes"].map(name => host().on(name, () => {
      disappear();
      if (bar && (!owner?.isConnected || owner !== host().canvas())) bar.hidden = true;
    })).filter(Boolean);
    if (textual(document.activeElement)) watch(document.activeElement);
  }
  if (labs?.notebookEnabled() !== false) attach(true);
  labs?.onChange(attach);
  return {free, duplicate};
})();
