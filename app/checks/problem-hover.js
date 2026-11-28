"use strict";
// Problem hover card: what a problem marker is, next to the marker, on sheets and boards.
//
// Rest the pointer on a marker (ERC and live checks: sch-markers.js; DRC: drc-markers.js; Design
// Insights: insights-ui.js; the badge for problems kept on the other document: checks-cross.js) and,
// after a short pause, a small AtriumTooltip-style card (docs/ui-library.md › Hover cards) shows the
// severity, the check's title, one line on what is wrong and the objects involved. A marker that stands
// for several problems (the count beside it) lists them all. Two small actions: Show in Messages
// (Problems) and, for a DRC violation with an automatic fix, Fix… (the DRC fix popover).
//   - The card never covers the marker or the objects it is about; it closes when the pointer leaves
//     the marker (a short grace lets it move into the card), on any camera change, on Escape, on a press
//     elsewhere and on an edit. It never takes the keyboard focus and never appears during a drag, a
//     route or a placement (any tool but Select).
//   - Touch: a tap on a marker shows the same card (the tap still selects, as before).
//   - The status-bar line and the Violation inspector on a click stay as they were.
// Loaded with checks.js (lazy, app/lazy.js AtriumChecks); nothing runs until a canvas is hovered.
globalThis.AtriumProblemHover = (() => {
  const G = globalThis, doc = G.document;
  if (!doc?.body) return Object.freeze({over: () => false});
  const hover = G.AtriumCanvasHover;
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = AtriumI18n.define({
    "problems.hover.fatal": "Fatal",
    "problems.hover.error": "Error",
    "problems.hover.warning": "Warning",
    "problems.hover.hint": "Hint",
    "problems.hover.waived": "Waived",
    "problems.hover.tip": "Tip",
    "problems.hover.advice": "Advice",
    "problems.hover.after_compile": "{severity} after Compile",
    "problems.hover.many": "{count} problems here",
    "problems.hover.more": "{count} more",
    "problems.hover.board": "On the board",
    "problems.hover.sheet": "On the schematic",
    "problems.hover.messages": "Show in Messages",
    "problems.hover.fix": "Fix…",
    "problems.hover.rule": "rule {name}"
  });
  const DWELL = 350, LEAVE = 220, SLOP = 4, GAP = 8, LIST = 6;
  const TONE = {fatal: "danger", error: "danger", warning: "warning", hint: "insight", waived: ""};
  let host = null, card = null, shown = null, frame = 0, last = null, tap = null;
  const motion = () => G.AtriumMotion?.ui || G.AtriumMotionUI;
  const caption = () => parseFloat(getComputedStyle(doc.documentElement).getPropertyValue("--window-caption-height")) || 0;
  const paneOf = canvas => host?.panes?.().find(p => p.canvas === canvas) || null;
  const busy = canvas => { try { return !host.allowsHover?.(canvas) || host.tool?.() !== "select" || !!host.drag?.() || !!host.liveRoute?.(); } catch { return true; } };
  const unit = () => { try { return host.units?.() || "mm"; } catch { return "mm"; } };

  // ---------------------------------------------------------------- what is under the pointer
  // {pane, d, entries: [{severity, word, title, text, objects, raw, kind}], at (world), radius (px), boxes (world)}.
  function find(pane, x, y) {
    const d = host.docById?.(pane.docId) || host.doc?.();
    if (!d || (d.kind !== "schematic" && d.kind !== "pcb")) return null;
    const P = G.AtriumProblemMarks, defs = host.defs(), scale = P.scaleOf(pane.view), z = P.size(scale, d.kind);
    const out = {pane, d, entries: [], at: null, radius: P.hit(z.screen * 1.2), boxes: []};
    const S = G.AtriumSchMarkers, M = G.AtriumDRCMarkers, V = G.AtriumDRCView, I = G.AtriumInsightsUI, X = G.AtriumChecksCross;
    if (d.kind === "schematic" && S?.groupAt) {
      const g = S.groupAt(pane, x, y);
      if (g) { out.at = g.at; for (const v of g.members) out.entries.push(fromCheck(d, defs, v, out.boxes)); }
    }
    if (!out.at && d.kind === "pcb" && V) {
      const g = V.groupAt ? V.groupAt(pane, x, y) :
        M?.groupAt?.(host, pane, V.violations(d.id), x, y, V.waived?.(d.id));
      if (g?.at) return g.members.length ? {
        ...out, at: g.at, entries: g.members.map(fromDRC),
        // Picking and hover arbitration do not need card placement geometry.
        get boxes() { return g.boxes ?? g.members.map(v => safe(() => M.box(d, defs, v))).filter(Boolean); }
      } : null;
    }
    if (!out.at && I?.markerAt && I.enabled?.() && !I.expandOnHover?.()) {
      const boardGroup = d.kind === "pcb" && I.groupAt;
      const g = boardGroup ? I.groupAt(pane, x, y) : null;
      const ins = boardGroup ? g?.rep : I.markerAt(pane, x, y);
      if (ins && I.cardFor?.() !== ins) {
        if (g?.coarse && g.members.length > 1) return fromInsightGroup(out, defs, g);
        out.at = I._markAt ? I._markAt(ins, P.size(scale, d.kind, "hint").r) : ins.at;
        out.entries.push({...insightEntry(ins), objects: insightObjects(d, defs, ins, out.boxes)});
      }
    }
    if (!out.at && X?.badgeAt) {
      const badge = safe(() => X.badgeAt(host, pane, x, y));
      if (badge) {
        const p = P.badgeDetail(badge.at, scale, d.kind);
        out.at = p.at; out.radius = p.radius;
        const where = t(d.kind === "schematic" ? "problems.hover.board" : "problems.hover.sheet");
        for (const {raw, labels} of badge.entries || badge.problems.map(v => ({raw:v, labels:[badge.label]})))
          out.entries.push({...describeCheck(raw), objects: labels, where, raw, kind: "cross"});
      }
    }
    return out.at && out.entries.length ? out : null;
  }
  function safe(fn) { try { return fn(); } catch { return null; } }
  const word = s => ({fatal: t("problems.hover.fatal"), error: t("problems.hover.error"), warning: t("problems.hover.warning"),
    hint: t("problems.hover.hint"), waived: t("problems.hover.waived")})[s] || s;
  const words = v => v.hint ? t("problems.hover.after_compile", {severity: word(v.hint)}) : word(v.severity);
  function describeCheck(v) {
    const K = G.AtriumChecks, title = safe(() => K.title(v.check)) || v.check;
    let text = String(v.text || "");
    // The unified text starts with the rule's or check's name; the card's title already says it.
    for (const lead of [v.ruleName, title]) if (lead && text.startsWith(lead + ": ")) { text = text.slice(lead.length + 2); break; }
    return {severity: v.waiver ? "waived" : v.severity, word: v.waiver ? word("waived") : words(v), title, text};
  }
  // Designators and net names for the objects of a problem; their world boxes go to `boxes`.
  function names(d, defs, ids, boxes, items = d.items) {
    const out = [];
    if (!ids.length) return out;
    const want = new Set(ids);
    for (const item of items) {
      if (!want.has(item.id)) continue;
      const b = objectBox(d, defs, item);
      if (b) boxes.push(b);
      const name = item.ref || (item.kind === "netlabel" || item.kind === "port" || item.kind === "power" ? item.text : "") || item.net || "";
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }
  // An object's own box: a label's text box on a sheet (its item box is only its anchor), else its geometry.
  function objectBox(d, defs, item) {
    const look = G.AtriumSchAppearance;
    if (d.kind === "schematic" && (item.kind === "netlabel" || item.kind === "label") && look?.labelBox) {
      const b = safe(() => look.labelBox(look.displayItem?.(d, item) || item));
      if (b) return b;
    }
    return G.AtriumNavCommon?.itemBox?.(d, defs, item);
  }
  function fromCheck(d, defs, v, boxes) {
    const objects = names(d, defs, v.objects.filter(o => o.doc == null || o.doc === d.id).map(o => o.id), boxes);
    if (v.subject?.net && !objects.includes(v.subject.net)) objects.push(v.subject.net);
    return {...describeCheck(v), objects, raw: v, kind: "check"};
  }
  function fromDRC(v) {
    const M = G.AtriumDRCMarkers, R = G.AtriumRules, info = M.describe(v, unit());
    const title = R?.types?.[v.type]?.title || v.typeTitle || v.ruleName || v.type;
    // value: the measured and required values (never shortened); text: the line as a whole.
    const value = /required/.test(info.measured) ? info.measured.replace(/^Measured\s+/, "") : "";
    const text = [info.measured || info.detail || "", v.ruleName && v.ruleName !== title ? t("problems.hover.rule", {name: v.ruleName}) : ""].filter(Boolean).join(" · ");
    const severity = M.severity(v);
    return {severity, word: word(severity), title, text, value, note: value ? text.slice(info.measured.length).replace(/^ · /, "") : text, objects: info.objects.map(M.shortObject), raw: v, kind: "drc"};
  }
  const insightEntry = x => ({severity: "hint", word: t(x.severity === "advice" ? "problems.hover.advice" : "problems.hover.tip"),
    title: x.title || x.check, text: x.message || "", raw: x, kind: "insight"});
  function insightObjects(d, defs, x, boxes, items) {
    const objects = names(d, defs, x.objects || [], boxes, items);
    if (x.net && !objects.includes(x.net)) objects.push(x.net);
    if (x.line) boxes.push([Math.min(x.line[0][0], x.line[1][0]), Math.min(x.line[0][1], x.line[1][1]), Math.max(x.line[0][0], x.line[1][0]), Math.max(x.line[0][1], x.line[1][1])]);
    return objects;
  }
  function fromInsightGroup(out, defs, group) {
    const {d, boxes} = out, members = [group.rep, ...group.members.filter(x => x !== group.rep)];
    let objects;
    function resolve() {
      if (!objects) {
        const byId = new Map(), items = members.map(x => {
          const row = [];
          for (const id of new Set(x.objects || [])) {
            if (!byId.has(id)) byId.set(id, []);
            byId.get(id).push(row);
          }
          return row;
        });
        if (byId.size) for (const item of d.items) byId.get(item.id)?.forEach(row => row.push(item));
        objects = members.map((x, i) => insightObjects(d, defs, x, boxes, items[i]));
      }
      return objects;
    }
    const entries = members.map((x, i) => {
      const row = insightEntry(x);
      return {...row, value:row.word, note:row.text, get objects() { return resolve()[i]; }};
    });
    return {...out, at:group.at, radius:group.reach, entries, get boxes() { resolve(); return boxes; }};
  }
  // A check pass that finishes during the hover pause replaces its finding objects: an insight or a
  // check-store finding is the same one while its key is (a key names the objects, not the measured
  // value). Identity decides whether a pending or shown card still stands for what is under the
  // pointer; the wording is only the card's content, always taken from the current finding.
  const sameEntry = (a, b) => a.raw === b.raw || a.kind === b.kind && a.raw?.key != null && a.raw.key === b.raw?.key;
  const same = (a, b) => !!a && !!b && a.pane.canvas === b.pane.canvas && a.d === b.d &&
    a.entries.length === b.entries.length && a.entries.every((e, i) => sameEntry(e, b.entries[i]));
  const wording = hit => JSON.stringify(hit.entries.map(e => [e.severity, e.word, e.title, e.text, e.value]));

  // ---------------------------------------------------------------- the card
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function dot(severity) { const s = el("span", "ui-dot"); const tone = TONE[severity]; if (tone) s.dataset.tone = tone; s.setAttribute("aria-hidden", "true"); return s; }
  function ensureCard() {
    if (card) return card;
    card = el("div", "ui-tooltip is-card problem-hover");
    card.id = "waffle-problem-card";
    card.setAttribute("role", "tooltip");
    card.dataset.interactive = "";
    card.hidden = true;
    if (typeof card.showPopover === "function") card.popover = "manual";
    // A press on the card keeps the focus where it was (the canvas); its buttons still click.
    card.addEventListener("mousedown", e => e.preventDefault());
    card.addEventListener("pointerenter", () => hover.stay("problem"));
    card.addEventListener("pointerleave", e => { if (e.pointerType !== "touch") settleLeave(); });
    doc.body.append(card);
    return card;
  }
  function action(label, fn) {
    const b = el("button", "ui-button", label);
    b.type = "button"; b.dataset.size = "sm"; b.dataset.variant = "quiet"; b.tabIndex = -1;
    b.addEventListener("click", e => { e.stopPropagation(); fn(b); });
    return b;
  }
  function fill(hit) {
    const list = hit.entries, first = list[0], many = list.length > 1;
    const head = el("div", "ui-tooltip-head"), worst = many ? list.reduce((a, e) => rank(e) < rank(a) ? e : a, first) : first;
    head.append(dot(worst.severity), el("strong", null, many ? t("problems.hover.many", {count: list.length}) : first.title), el("span", "ui-tooltip-meta", many ? worst.word : first.word));
    const parts = [head];
    if (!many) {
      if (first.text) parts.push(el("div", "ui-tooltip-detail", first.text));
    } else {
      const ul = el("ul", "ui-tooltip-list");
      for (const e of list.slice(0, LIST)) {
        // Line 1: the title and the values, never shortened; line 2: the rest, wrapping to two lines at most.
        const li = el("li"), head = el("span", "ui-tooltip-row");
        head.append(el("strong", null, e.title));
        if (e.value) head.append(el("span", "ui-tooltip-value", e.value));
        li.append(dot(e.severity), head);
        const note = e.value ? e.note : e.text;
        if (note) { const n = el("span", "ui-tooltip-detail", note); n.title = note; li.append(n); }
        ul.append(li);
      }
      if (list.length > LIST) ul.append(el("li", "ui-tooltip-detail", t("problems.hover.more", {count: list.length - LIST})));
      parts.push(ul);
    }
    // The objects, less those the one line already names.
    const objects = [...new Set(list.flatMap(e => e.objects))].filter(o => many || !first.text.includes(o)).slice(0, 6);
    const where = first.where;
    if (objects.length || where) parts.push(el("div", "ui-tooltip-detail ui-tooltip-objects", [where, objects.join(", ")].filter(Boolean).join(" · ")));
    const actions = el("div", "ui-tooltip-actions");
    const fixable = !many && first.kind === "drc" && safe(() => G.AtriumDRCFixes?.hasFix?.(first.raw));
    if (fixable) actions.append(action(t("problems.hover.fix"), b => {
      const r = b.getBoundingClientRect();
      hide(true);
      G.AtriumDRCFixes.offer(host, first.raw, {x: r.left, y: r.bottom});
    }));
    actions.append(action(t("problems.hover.messages"), () => {
      hide(true);
      // The problem itself, selected, in view and focused in Messages (the first of a stacked marker).
      const ctx = host.messageContext?.(), raw = first.raw;
      G.AtriumLazy?.need?.("AtriumMessages").then(() => {
        const M = G.AtriumMessages;
        if (!M?.revealProblem?.(raw, ctx)) M?.open?.(ctx, {view: "problems", domain: null, fab: false, waived: false});
      }, e => host.info?.(e.message));
    }));
    parts.push(actions);
    card.replaceChildren(...parts);
    card.dataset.severity = worst.severity;
    card.toggleAttribute("data-wide", many);
  }
  const RANK = {fatal: 0, error: 1, warning: 2, hint: 3, waived: 4}, rank = e => RANK[e.severity] ?? 5;

  // Screen rectangles (client px): the marker, and the objects it is about.
  function screenBox(pane, world) {
    const b = pane.canvas.getBoundingClientRect(), pts = [[world[0], world[1]], [world[2], world[1]], [world[2], world[3]], [world[0], world[3]]].map(p => pane.view.worldToScreen(p));
    const xs = pts.map(p => p[0] + b.left), ys = pts.map(p => p[1] + b.top);
    return {left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys)};
  }
  const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  // Where the card goes: beside the marker and its objects, never over either. An object too large to
  // keep clear of (a pour, a long track at high zoom) only keeps the marker clear.
  function position(hit, w, h) {
    const c = hit.pane.canvas.getBoundingClientRect(), s = hit.pane.view.worldToScreen(hit.at), r = hit.radius;
    const mx = c.left + s[0], my = c.top + s[1], mark = {left: mx - r, top: my - r, right: mx + r, bottom: my + r};
    const area = {left: Math.max(c.left, 0) + 4, top: Math.max(c.top, caption()) + 4, right: Math.min(c.right, G.innerWidth) - 4, bottom: Math.min(c.bottom, G.innerHeight) - 4};
    const objects = hit.boxes.map(b => screenBox(hit.pane, b)).filter(o => meets(o, area) && o.right - o.left < (area.right - area.left) * .6 && o.bottom - o.top < (area.bottom - area.top) * .6);
    const around = objects.reduce((u, o) => ({left: Math.min(u.left, o.left), top: Math.min(u.top, o.top), right: Math.max(u.right, o.right), bottom: Math.max(u.bottom, o.bottom)}), mark);
    // Beside everything first, then beside the marker where no object is, then clear of the marker only.
    const align = {horizontal: [mark.left - 4, mark.right + 4 - w], vertical: [mark.top - 4, mark.bottom + 4 - h]};
    const order = ["right", "bottom", "left", "top"];
    const sideOf = {right: 0, bottom: 1, left: 2, top: 3};
    const blocked = (rect, avoid) => avoid.some(o => meets(rect, {left: o.left - 2, top: o.top - 2, right: o.right + 2, bottom: o.bottom + 2}));
    for (const [edge, avoid] of [[around, [mark, ...objects]], [mark, [mark, ...objects]], [mark, [mark]]]) {
      const place = hover.firstFit(mark, w, h, area, {
        gap: GAP, order, align, edge, major: "align", clear: rect => !blocked(rect, avoid)
      });
      if (place) return {left: place.left, top: place.top, side: sideOf[place.side]};
    }
    return null;
  }
  function show(hit) {
    ensureCard();
    const refresh = !card.hidden && same(shown, hit);
    fill(hit);
    card.hidden = false;
    if (card.popover === "manual" && !card.matches(":popover-open")) card.showPopover();
    const place = position(hit, card.offsetWidth, card.offsetHeight);
    if (!place) { hide(true); return false; }
    card.style.left = Math.round(place.left) + "px";
    card.style.top = Math.round(place.top) + "px";
    shown = hit;
    const fx = motion();
    if (!refresh && fx) {
      const offset = ["translateX(-2px)", "translateY(-2px)", "translateX(2px)", "translateY(2px)"][place.side];
      const from = {opacity: 0};
      if (fx.moves?.("pointer")) from.transform = offset;
      fx.enter(card, {from, duration: 150, intent: "pointer"});
    }
    return true;
  }
  function conceal() {
    if (shown || !card) return;
    if (card.popover === "manual" && card.matches(":popover-open")) card.hidePopover();
    card.hidden = true;
    hover.release("problem");
  }
  function hide(instant = false) {
    hover.stay("problem");
    hover.cancel("problem");
    if (!card || card.hidden || !shown && !instant) return;
    shown = null;
    const fx = motion();
    if (!instant && fx) fx.exit(card, {to: {opacity: 0}, duration: 100, intent: "pointer", done: conceal});
    else { fx?.cancel?.(card); conceal(); }
  }
  function settleLeave() {
    if (shown) hover.leave("problem", LEAVE, () => { if (!card.matches(":hover")) hide(); });
  }

  // ---------------------------------------------------------------- pointer
  function check() {
    frame = 0;
    const e = last;
    if (!e || !host || !hover.valid(e.scope)) return;
    const pane = paneOf(e.canvas);
    if (!pane || busy(e.canvas)) { hide(true); return; }
    const hit = find(pane, e.x, e.y);
    if (!hit) { hover.cancel("problem"); settleLeave(); return; }
    // The same finding with new wording (a pass finished while the card was open): refresh it in place.
    if (same(shown, hit)) { hover.stay("problem"); if (wording(shown) !== wording(hit)) show(hit); return; }
    if (same(hover.pending("problem"), hit)) return;
    if (shown) hide(true);
    hover.queue("problem", e.canvas, DWELL, hit, () => {
      if (last?.canvas !== e.canvas || busy(e.canvas)) return;
      const now = find(pane, last.x, last.y);
      if (same(now, hit)) hover.show("problem", e.canvas, () => show(now));
    });
  }
  function move(e) {
    if (!host) return;
    if (card && !card.hidden && card.contains(e.target)) { hover.stay("problem"); return; }
    if (e.pointerType === "touch") return;
    if (e.target?.tagName !== "CANVAS" || e.buttons) {
      last = null; hover.cancel("problem");
      if (e.buttons) hide(true); else settleLeave();
      return;
    }
    if (last && last.canvas === e.target && Math.hypot(last.x - e.clientX, last.y - e.clientY) < 1) return;
    const scope = hover.locate(e.target);
    if (!scope) { last = null; hover.cancel("problem"); settleLeave(); return; }
    last = {canvas: e.target, x: e.clientX, y: e.clientY, scope};
    if (!frame) frame = G.requestAnimationFrame ? requestAnimationFrame(check) : setTimeout(check, 16);
  }
  function down(e) {
    if (card && !card.hidden && card.contains(e.target)) return;
    hide(true);
    last = null;
    const scope = e.pointerType === "touch" && e.isPrimary && hover.locate(e.target);
    tap = scope ? {id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, scope} : null;
  }
  function up(e) {
    const t0 = tap; tap = null;
    if (!t0 || e.pointerId !== t0.id || Math.hypot(e.clientX - t0.x, e.clientY - t0.y) > SLOP * 3 || e.timeStamp - t0.at > 600) return;
    // After the tap's own handling (the marker is chosen, as before).
    const {canvas} = t0.scope;
    hover.queue("problem", canvas, 0, null, () => {
      if (!hover.valid(t0.scope, true)) return;
      const pane = paneOf(canvas);
      if (!pane || host.tool?.() !== "select" || host.drag?.()) return;
      const hit = find(pane, t0.x, t0.y);
      if (hit) hover.show("problem", canvas, () => show(hit), {touch: true});
    }, {touch: true});
  }
  // The hover owner consults marker priority before presenting a card for the object underneath.
  function over(canvas, x, y) {
    const pane = host && paneOf(canvas);
    return !!(pane && safe(() => find(pane, x, y)));
  }

  function attach(h) {
    if (host === h) return;
    host = h;
    hover.register("problem", {
      hide: () => hide(true),
      contains: target => card?.contains(target),
      over,
      reset(reason) {
        last = null;
        // A marker press can activate the pane between the replayed down and up.
        if (reason !== "document" || !tap || tap.scope.canvas !== host.canvas() || !hover.valid(tap.scope, true)) tap = null;
      }
    });
    doc.addEventListener("pointermove", move, {capture: true, passive: true});
    doc.addEventListener("pointerdown", down, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointerout", e => { if (e.pointerType !== "touch" && e.target?.tagName === "CANVAS" && !card?.contains(e.relatedTarget)) { last = null; hover.cancel("problem"); settleLeave(); } }, {capture: true, passive: true});
    doc.addEventListener("keydown", e => {
      if (e.key !== "Escape" && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) hide(true);
    }, true);
  }
  G.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({over, hide: () => hide(true), shown: () => !!shown, _find: find});
})();
