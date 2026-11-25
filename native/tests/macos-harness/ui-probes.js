"use strict";
// WebKit UI probes (ui.sh). Runs in the app page inside the real WKWebView; input comes from real
// AppKit events sent by ui-probes.swift (post "mouse"/"key"), so WebKit itself produces the DOM
// events. Each check prints PASS/FAIL through the harness. Test-only.
globalThis.__uiProbes = (() => {
  const post = (op, a = {}) => webkit.messageHandlers.harness.postMessage({op, ...a});
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function until(ms, f) {const end = Date.now() + ms; while (Date.now() < end) {try {const v = await f(); if (v) return v;} catch {} await wait(50);} return null;}
  let passed = 0, failed = 0;
  const failures = [];
  function log(ok, name, detail) {
    if (ok) passed++; else {failed++; failures.push(name);}
    return post("log", {ok: !!ok, name, detail: detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail)});
  }
  const note = text => post("note", {text});
  const rect = el => el.getBoundingClientRect();
  const center = el => {const r = rect(el); return [r.left + r.width / 2, r.top + r.height / 2];};
  const mouse = (x, y, o = {}) => post("mouse", {x, y, button: o.button || "left", mods: o.mods || [], kind: o.kind || "click", clicks: o.clicks || 1});
  const clickEl = (el, o) => {const [x, y] = center(el); return mouse(x, y, o);};
  const key = (k, mods = []) => post("key", {key: k, mods});
  const shot = name => post("shot", {name});
  const host = () => globalThis.AtriumNavHost;
  const act = a => window.dispatchEvent(new CustomEvent("atrium-command", {detail: a}));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const onScreen = r => r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  const topAt = (x, y) => document.elementFromPoint(x, y);
  const status = () => document.getElementById("status")?.textContent || "";

  // Page errors while the probes run.
  const errors = [];
  addEventListener("error", e => errors.push("error: " + e.message + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno));
  addEventListener("unhandledrejection", e => errors.push("rejection: " + (e.reason?.message || e.reason)));
  {const ce = console.error; console.error = (...a) => {errors.push("console.error: " + a.map(String).join(" ").slice(0, 200)); ce.apply(console, a);};}
  // Which events reached the page, and how (isTrusted, button, modifiers).
  const seen = [];
  for (const t of ["pointerdown", "mousedown", "contextmenu", "keydown", "pointermove", "pointerover"]) document.addEventListener(t, e => {
    seen.push({type: t, trusted: e.isTrusted, button: e.button, key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey,
      target: (e.target?.tagName || "") + (e.target?.className && typeof e.target.className === "string" ? "." + e.target.className.split(" ")[0] : "")});
    if (seen.length > 50) seen.shift();
  }, true);
  const lastSeen = type => [...seen].reverse().find(s => s.type === type);

  async function cleanup() {
    for (const d of document.querySelectorAll("dialog[open]")) try {d.close();} catch {}
    for (const m of document.querySelectorAll(".work-menu[open]")) m.open = false;
    globalThis.AtriumContextMenu?.close?.(false);
    globalThis.AtriumActiveBar?.close?.(false);
    document.querySelectorAll("body > .nav-menu").forEach(n => n.remove());
    await wait(60);
  }
  async function toKind(kind) {
    if (host().doc().kind === kind) return true;
    const tab = [...document.querySelectorAll("#document-tabs [data-tab]")].find(t => t.dataset.kind === kind);
    if (tab) await clickEl(tab);
    return !!await until(3000, () => host().doc().kind === kind);
  }
  async function focusCanvas() {
    const c = host().canvas(); c.focus(); await wait(30); return c;
  }

  // ------------------------------------------------------------------ boot and support
  async function onboarding(sp) {
    const visit = async selector => {
      const control = await until(3000, () => sp.querySelector(selector));
      control.scrollIntoView({block: "nearest"});
      await wait(80);
      await clickEl(control);
    };
    const head = id => '[data-step="' + id + '"] .wl-head';
    const choice = (id, value) => '[data-step="' + id + '"] label:has(input[value="' + value + '"])';
    await visit(head("units"));
    await visit(head("mouse"));
    log(AtriumWelcome.state().done.units && !AtriumWelcome.state().done.mouse, "opening the next step accepts only the defaults reviewed");
    const mouseHead = rect(sp.querySelector(head("mouse"))), column = rect(sp.querySelector(".sp-right"));
    log(mouseHead.top >= column.top - 1 && mouseHead.bottom < column.bottom, "the expanded heading scrolls into the setup column");
    for (const val of ["zoom", "altium"]) {
      if (AtriumWelcome.state().open !== "mouse") await visit(head("mouse"));
      await visit(choice("mouse", val));
      log(AtriumWelcome.state().done.mouse && AtriumWelcome.value("mouse") === val, "the wheel choice alone completes Mouse and navigation: " + val);
      const moved = await until(2000, () => AtriumWelcome.state().open === "motion");
      await wait(400);
      const next = rect(sp.querySelector(head("motion"))), col = rect(sp.querySelector(".sp-right"));
      log(moved && next.top >= col.top - 1 && next.bottom <= col.bottom, "a click on the wheel choice opens Animations and scrolls it into view: " + val);
    }
    await visit(head("theme"));
    await visit(choice("theme", "ember"));
    await visit(head("motion"));
    const events = [], panel = sp.querySelector(".wl-panel");
    const obs = new MutationObserver(rs => events.push(...rs.map(r => r.attributeName)));
    obs.observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme", "data-theme-id", "data-theme-fading"]});
    for (const val of ["full", "reduce", "off", "system"]) {
      await visit(choice("motion", val));
      log(AtriumTheme.get().motion === val && AtriumTheme.effectivePreset() === "ember" && panel.isConnected, "the preview applies " + val + " in place and retains Ember");
    }
    obs.disconnect();
    log(events.length === 0, "the four animation choices never reapply the window palette", events);
    const toggle = '.wl-step[data-step="motion"] .wl-preview button', inspector = sp.querySelector(".wl-motion-stage .wl-mock-side");
    await visit(toggle); const closed = inspector.hidden;
    await visit(toggle); log(closed && !inspector.hidden, "the preview opens and closes the miniature Properties panel");
    await visit(".wl-finish button");
    log(sp.open && !sp.querySelector(".wl-panel") && host().isStarter(), "finishing setup stays on the home screen");
  }
  async function boot(testSetup) {
    const ok = await until(20000, () => globalThis.AtriumNavHost && document.querySelector("dialog.sp-dialog[open]"));
    log(ok, "app boots in WKWebView and the start page opens");
    note("window " + JSON.stringify({...await post("focusWindow"), page: document.visibilityState, focus: document.hasFocus()}));
    await wait(300);
    const sp = document.querySelector("dialog.sp-dialog[open]");
    if (sp) {
      log(host().isStarter() && !host().isDirty() && host().project().documents.every(d => !d.items.length), "fresh launch has an empty workspace");
      if (testSetup) {
        await clickEl(sp.querySelector("[data-start-action=customise]"));
        await onboarding(sp);
      }
      const demo = sp.querySelector("[data-start-action=demo]");
      await clickEl(demo);
      log(await until(3000, () => !sp.open && host().project().name === "Sensor interface" && !host().isDirty()), "Try the Demo opens the Sensor interface project");
    }
    await cleanup();
    const sup = {
      colorMix: CSS.supports("color", "color-mix(in srgb, red 50%, blue)"),
      colorMixNoSpace: CSS.supports("color", "color-mix(red 50%, blue)"),
      colorMixOklab: CSS.supports("color", "color-mix(in oklab, red 50%, transparent)"),
      has: CSS.supports("selector(:has(a))"),
      where: CSS.supports("selector(:where(a))"),
      focusVisible: CSS.supports("selector(:focus-visible)"),
      dialog: typeof HTMLDialogElement === "function" && "showModal" in HTMLDialogElement.prototype,
      mask: CSS.supports("mask", "url(x.svg) center/16px no-repeat"),
      webkitMask: CSS.supports("-webkit-mask", "url(x.svg) center/16px no-repeat"),
      sticky: CSS.supports("position", "sticky"),
      scrollbarGutter: CSS.supports("scrollbar-gutter", "stable"),
      inset: CSS.supports("inset", "0"),
      nesting: CSS.supports("selector(&)"),
      popover: "popover" in HTMLElement.prototype,
    };
    note("UA " + navigator.userAgent);
    note("support " + JSON.stringify(sup));
    log(sup.colorMix && sup.has && sup.dialog && (sup.mask || sup.webkitMask) && sup.sticky, "WebKit supports color-mix(), :has(), <dialog>, CSS masks and position: sticky", sup);
    return ok;
  }

  // ------------------------------------------------------------------ CSS parse and colour audit
  let mixRules = [];
  async function css() {
    const sources = await post("cssSources");
    const r = await globalThis.__cssAudit.run(sources);
    mixRules = r.mixRules;
    await post("save", {name: "css-audit-webkit.json", text: JSON.stringify(r, null, 1)});
    note("CSS audit in WebKit: " + r.rules + " rules, " + r.declarations + " declarations, " + r.mixes + " color-mix() expressions, " + r.tokens + " root tokens; themes " + JSON.stringify(r.themes));
    log(Object.values(r.themes).every(t => t.checked > 0) && ["dark", "light", "hc", "classic"].every(t => r.themes[t].applied === t), "every theme applies (dark, light, high contrast, classic)", r.themes);
    const tokenFails = r.invalid.filter(x => x.kind === "token");
    log(!tokenFails.length, "every colour token computes in every theme", tokenFails.slice(0, 12));
    // color-mix() expressions written against element-scoped variables only compute in their own
    // element; the Chrome comparison in ui.sh separates those from WebKit gaps.
    note("color-mix() expressions that do not compute on a bare element (scoped variables; compared with Chrome in ui.sh): " + r.invalid.filter(x => x.kind === "mix").length);
    note("dropped by WebKit's parser before the Chrome comparison: " + r.droppedRules.length + " rules, " + r.dropped.length + " declarations");
  }
  // The rendered result of color-mix() tints in each theme: the rules that use color-mix() outside
  // a token (from the parsed app stylesheets), checked on the elements they style in the dialogs
  // and panels that hold them. A value WebKit could not compute would leave no colour.
  async function tints() {
    if (!mixRules.length) mixRules = globalThis.__cssAudit.parseAll(await post("cssSources")).mixRules;
    await toKind("pcb"); await cleanup();
    const out = {}, strip = sel => sel.replace(/::?(before|after|placeholder|-webkit-[a-z-]+)\b/g, "").replace(/:(hover|focus-visible|focus|active|focus-within)\b/g, "") || "*";
    for (const theme of ["dark", "light", "hc"]) {
      act("theme-" + theme); await wait(200);
      const bad = [], matched = new Set();
      let checked = 0;
      for (const a of ["constraints", "bom", "navigator-panel"]) {
        await cleanup(); act(a); await wait(900);
        for (const r of mixRules) {
          let els; try {els = [...document.querySelectorAll(strip(r.selector))].filter(visible).slice(0, 3);} catch {continue;}
          for (const el of els) {
            matched.add(r.selector); checked++;
            const got = getComputedStyle(el).getPropertyValue(r.prop);
            if (!got || (/^background/.test(r.prop) && /rgba\(0, 0, 0, 0\)|transparent/.test(got) && !/:hover/.test(r.selector))) bad.push({sel: r.selector.slice(0, 80), p: r.prop, got});
          }
        }
        if (theme !== "dark" || a !== "navigator-panel") await shot("tints-" + a + "-" + theme);
        if (a === "navigator-panel") act(a);
      }
      out[theme] = {rules: mixRules.length, matched: matched.size, checked, bad: bad.slice(0, 6)};
    }
    act("theme-dark"); await wait(150); await cleanup();
    log(Object.values(out).every(t => !t.bad.length && t.checked > 0), "color-mix() tints render in dark, light and high contrast (Constraint Manager, BOM, Navigator)", out);
  }

  // ------------------------------------------------------------------ menus and submenus
  const topMenus = () => [...document.querySelectorAll(".work-menu")].filter(m => visible(m.querySelector("summary")));
  async function openTop(menu) {
    if (!menu.open) await clickEl(menu.querySelector("summary"));
    return !!await until(1500, () => menu.open && visible(menu.querySelector(":scope > .menu-items")));
  }
  async function menus(kind) {
    await toKind(kind); await cleanup();
    const bad = [], done = [];
    let firstShot = true;
    for (const menu of topMenus()) {
      const name = menu.querySelector("summary").textContent.trim();
      if (!await openTop(menu)) {bad.push(name + ": does not open on click"); continue;}
      const list = menu.querySelector(":scope > .menu-items");
      if (!onScreen(rect(list))) bad.push(name + ": menu off screen " + JSON.stringify(rect(list)));
      const subs = [...list.children].filter(n => n.classList.contains("submenu") && !n.hidden && visible(n));
      for (const sub of subs) {
        const trig = sub.querySelector(":scope > .submenu-trigger"), label = name + " › " + trig.textContent.trim();
        const items = sub.querySelector(":scope > .menu-items");
        // Keyboard: Right opens and focuses the first item; Left closes and returns to the trigger.
        if (!menu.open) await openTop(menu);
        trig.focus(); await key("ArrowRight");
        const opened = await until(800, () => sub.classList.contains("open") && items.contains(document.activeElement));
        const r = rect(items), first = document.activeElement, fr = first ? rect(first) : null;
        const hitFirst = fr && items.contains(topAt(fr.left + fr.width / 2, fr.top + fr.height / 2));
        if (!opened) bad.push(label + ": ArrowRight did not open (focus " + document.activeElement?.textContent?.trim().slice(0, 30) + ")");
        else {
          if (!onScreen(r)) bad.push(label + ": submenu off screen " + JSON.stringify({l: r.left, r: r.right, t: r.top, b: r.bottom}));
          if (!hitFirst) bad.push(label + ": first item covered by " + topAt(fr.left + fr.width / 2, fr.top + fr.height / 2)?.className);
          if (firstShot && kind === "pcb") {firstShot = false; await shot("menu-submenu-" + kind);}
          await key("ArrowDown");
          if (!items.contains(document.activeElement)) bad.push(label + ": ArrowDown left the submenu");
        }
        await key("ArrowLeft");
        if (!await until(600, () => !sub.classList.contains("open") && document.activeElement === trig)) bad.push(label + ": ArrowLeft did not close and refocus the trigger");
        await key("Enter");
        if (!await until(600, () => sub.classList.contains("open") && items.contains(document.activeElement))) bad.push(label + ": Enter did not open");
        await key("Escape");
        if (!await until(600, () => !sub.classList.contains("open") && document.activeElement === trig && menu.open)) bad.push(label + ": Escape did not close only the submenu");
        // Mouse: hovering the trigger shows the submenu.
        // An occluded WKWebView drops plain NSEvent mouseMoved. As in the wire-end probes,
        // a drag without a pressed button delivers a trusted hover move to the same point.
        await mouse(...center(trig), {kind: "drag"});
        if (!await until(600, () => visible(items) && onScreen(rect(items)))) bad.push(label + ": hover did not show the submenu " + JSON.stringify({trigHover: trig.matches(":hover"), subHover: sub.matches(":hover"), move: lastSeen("pointermove")}));
        done.push(label);
      }
      // Escape closes the top menu and focus returns to its title.
      list.querySelector('[role^="menuitem"]:not([disabled])')?.focus();
      await key("Escape");
      if (!await until(600, () => !menu.open)) bad.push(name + ": Escape did not close the menu");
    }
    log(!bad.length && done.length > 0, kind + " menus: every submenu opens with Right/Enter/hover, closes with Left/Escape (" + done.length + " submenus)", bad.length ? bad : done.join(", "));
    // ArrowDown on a menu title opens it on the first item; ArrowRight moves to the next menu.
    await cleanup();
    const [m1, m2] = topMenus();
    m1.querySelector("summary").focus(); await key("ArrowDown");
    const downOk = await until(800, () => m1.open && m1.querySelector(".menu-items").contains(document.activeElement));
    await key("ArrowRight");
    const rightOk = await until(800, () => m2.open && !m1.open);
    log(downOk && rightOk, kind + " menu bar: ArrowDown opens on the first item, ArrowRight moves to the next menu", {downOk, rightOk, focus: document.activeElement?.textContent?.trim().slice(0, 40)});
    await key("Escape"); await cleanup();
  }

  // ------------------------------------------------------------------ canvas objects
  // A screen point on the canvas where the editor's hit test finds this item.
  function pointOn(item) {
    const h = host(), c = h.canvas(), b = rect(c), v = h.view(), NC = globalThis.AtriumNavCommon;
    const box = NC?.itemBox?.(h.doc(), h.defs(), item);
    if (!box) return null;
    const tryAt = (wx, wy) => {
      const s = v.worldToScreen([wx, wy]), x = b.left + s[0], y = b.top + s[1];
      if (x < b.left + 4 || y < b.top + 4 || x > b.right - 4 || y > b.bottom - 4) return null;
      if (topAt(x, y) !== c) return null;
      return h.hit(c, x, y)?.item?.id === item.id ? [x, y] : null;
    };
    const [x0, y0, x1, y1] = box;
    let p = tryAt((x0 + x1) / 2, (y0 + y1) / 2);
    for (let n = 1; !p && n <= 8; n++) for (let i = 0; !p && i <= n; i++) for (let j = 0; !p && j <= n; j++) p = tryAt(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * j / n);
    return p;
  }
  function emptyPoint() {
    const h = host(), c = h.canvas(), b = rect(c);
    for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
      const x = b.left + b.width * i / 12, y = b.top + b.height * j / 12;
      if (topAt(x, y) === c && !h.hit(c, x, y)?.item) return [x, y];
    }
    return null;
  }
  // A point on copper (pcb) or a wire (schematic) that belongs to a net.
  function netPoint() {
    const h = host(), c = h.canvas(), X = globalThis.AtriumCrossProbe;
    const kinds = h.doc().kind === "pcb" ? ["track", "via", "part"] : ["wire", "part"];
    for (const k of kinds) for (const it of h.doc().items.filter(i => i.kind === k).slice(0, 40)) {
      const p = pointOn(it); if (!p) continue;
      const hit = h.hit(c, ...p), net = hit?.item && X?.targetAt?.(hit.doc, h.defs(), hit.item, hit.point)?.net;
      if (net) return {p, net, kind: k};
    }
    return null;
  }
  async function fitView() {act("fit"); await wait(250);}

  // ------------------------------------------------------------------ context menus
  const ctxMenu = () => [...document.querySelectorAll(":is(body, .nav-menu-portal) > .nav-menu[role=menu]")].at(-1) || null;
  async function contextMenus(kind) {
    await toKind(kind); await cleanup(); await fitView();
    const h = host(), d = h.doc(), types = new Map();
    const kindOf = it => ({part: "part", track: "track", arc: "track", via: "via", pad: "via", polygon: "pour", region: "region", fill: "region", keepout: "region", room: "room",
      wire: "wire", bus: "wire", netlabel: "wire", power: "wire", port: "wire"})[it.kind];
    for (const it of d.items) {
      if (!kindOf(it)) continue;
      if (!types.has(it.kind)) types.set(it.kind, []);
      types.get(it.kind).push(it);
    }
    note(kind + " document item kinds: " + JSON.stringify(Object.fromEntries(Object.entries(d.items.reduce((a, i) => (a[i.kind] = (a[i.kind] || 0) + 1, a), {})))));
    const results = [];
    let shotDone = false;
    for (const [t, candidates] of [...types, ["canvas", null]]) {
      await cleanup();
      // A via at a track endpoint can sit entirely behind another selectable object.
      let p = null;
      if (candidates) { for (const item of candidates) {p = pointOn(item); if (p) break;} }
      else {h.select([]); p = emptyPoint();}
      if (!p) {results.push({t, ok: false, why: "no clickable point"}); continue;}
      await post("nativeMenus");
      await mouse(...p, {button: "right"});
      const m = await until(2000, ctxMenu);
      const native = await post("nativeMenus");
      const ev = lastSeen("contextmenu");
      if (!m) {results.push({t, ok: false, why: "no menu", native, ev}); continue;}
      const head = m.querySelector(".nav-menu-head")?.textContent || "";
      const r = rect(m), focusIn = m.contains(document.activeElement);
      const entries = [...m.querySelectorAll(":scope > .nav-menu-item, :scope > .nav-sub > .nav-menu-item")].map(b => b.textContent.replace(/\s+/g, " ").trim()).slice(0, 30);
      if (t === "canvas") {
        const rows = m.querySelectorAll(":scope > button:not(:disabled)");
        const hovered = rows[2];
        // A hidden WKWebView receives hover through the harness's drag-without-press route.
        if (hovered) await mouse(...center(hovered), {kind:"drag"});
        log(!!hovered && document.activeElement === hovered, kind + " canvas menu highlight follows the pointer");
      }
      let subOk = null;
      const subWrap = m.querySelector(":scope > .nav-sub");
      if (subWrap) {
        subWrap.firstChild.focus(); await key("ArrowRight");
        const inner = subWrap.lastChild;
        subOk = !!await until(600, () => subWrap.classList.contains("open") && inner.contains(document.activeElement) && onScreen(rect(inner)));
        if (subOk && !shotDone && kind === "pcb") {shotDone = true; await shot("context-menu-" + t + "-submenu");}
        await key("ArrowLeft");
        subOk = subOk && !!await until(600, () => !subWrap.classList.contains("open") && document.activeElement === subWrap.firstChild);
      }
      await key("ArrowDown");
      const moved = m.contains(document.activeElement);
      await key("Escape");
      const closed = !!await until(800, () => !document.body.contains(m));
      const correctContext = t !== "canvas" || head === (kind === "pcb" ? "Board" : "Sheet");
      const ok = correctContext && !native.length && onScreen(r) && focusIn && moved && closed && subOk !== false && entries.length > 0;
      results.push({t, ok, head, entries: entries.length, sub: subOk, native, closed, trusted: ev?.trusted});
    }
    const bad = results.filter(r => !r.ok);
    log(!bad.length && results.length > 1, kind + " right-click menus for " + results.map(r => r.t).join(", "), bad.length ? bad : results.map(r => r.t + ": " + r.head + " (" + r.entries + ")").join("; "));
    await cleanup();
    await mouse(...emptyPoint(), {button:"right"});
    const pointerMenu = await until(2000, ctxMenu);
    // Exercise a secondary-click focus loss with no new focus target.
    if (pointerMenu?.contains(document.activeElement)) document.activeElement.blur();
    const keptFocus = !!pointerMenu && !!await until(600, () => pointerMenu.contains(document.activeElement));
    await key("Escape");
    const dismissed = !!pointerMenu && !!await until(800, () => !pointerMenu.isConnected);
    log(keptFocus && dismissed, kind + " canvas menu survives targetless focus loss and Escape still closes it");

    // Shift+F10 opens the menu for the selection from the keyboard.
    await cleanup();
    const part = d.items.find(i => i.kind === "part");
    if (part) {
      h.select([part.id]); await focusCanvas(); await key("F10", ["shift"]);
      const m = await until(1500, ctxMenu);
      log(!!m, kind + " Shift+F10 opens the context menu for the selection", m ? m.querySelector(".nav-menu-head")?.textContent : {key: lastSeen("keydown"), active: document.activeElement?.tagName, sel: h.selection().length});
      await key("Escape"); h.select([]);
    }
    await cleanup();
  }

  // ------------------------------------------------------------------ closed dialogs
  async function dialogs() {
    await cleanup();
    act("whats-new");
    const d = await until(4000, () => document.querySelector("dialog.whats-new[open]"));
    if (!d) {log(false, "What's New opens"); return;}
    const r = rect(d), at = [r.left + r.width / 2, r.top + 30];
    const closeBtn = [...d.querySelectorAll(".ui-dialog-actions button")].find(b => b.textContent.trim() === "Close");
    await clickEl(closeBtn);
    await until(1500, () => !d.isConnected || !d.open);
    // Closed dialogs (those kept in the DOM) take no space and no clicks.
    const stillShown = [...document.querySelectorAll("dialog:not([open])")].filter(x => getComputedStyle(x).display !== "none").map(x => x.className || x.id);
    await mouse(...at);
    const pd = lastSeen("pointerdown");
    const target = topAt(...at);
    log(!stillShown.length && !target?.closest?.("dialog") && pd && !/DIALOG/.test(pd.target), "closed dialogs are display:none and do not catch clicks",
      {closedDialogs: document.querySelectorAll("dialog:not([open])").length, stillShown, clickTarget: pd?.target, elementAt: target?.tagName + "." + target?.className});
    // Open and close a few module dialogs (kept in the DOM) and check again.
    for (const a of ["shortcuts", "rules", "preferences"]) {act(a); await wait(500); await cleanup();}
    const showingClosed = () => [...document.querySelectorAll("dialog:not([open])")].filter(x => getComputedStyle(x).display !== "none" || rect(x).width > 0).map(x => x.className);
    // Closed dialogs opt into a discrete display transition. Check their settled geometry.
    await until(1500, () => showingClosed().length === 0);
    const after = showingClosed();
    log(!after.length, "dialogs closed after use stay hidden (" + document.querySelectorAll("dialog:not([open])").length + " closed dialogs in the DOM)", after);
    await key("Escape"); await cleanup();
  }

  // ------------------------------------------------------------------ sticky dialog footers
  async function sticky() {
    await cleanup();
    const S = globalThis.AtriumShell;
    const body = Array.from({length: 60}, (_, i) => {const p = document.createElement("p"); p.textContent = "Row " + (i + 1) + " of a long form."; return p;});
    const d = S.dialog({title: "Sticky footer probe", body, actions: [{label: "Cancel"}, {label: "OK", primary: true}]});
    const f = d.matches("dialog:modal.ui-dialog") && d.querySelector(":scope > .ui-dialog-actions:last-child");
    if (!f) {log(false, "sticky footer probe dialog opens"); return;}
    const check = () => {
      const dr = rect(d), fr = rect(f), ok = f.querySelector("button[data-variant=primary]"), [x, y] = center(ok), bs = parseFloat(getComputedStyle(d).borderBottomWidth) || 0;
      return {pos: getComputedStyle(f).position, scrolls: d.scrollHeight > d.clientHeight + 10, gap: Math.round((dr.bottom - bs - fr.bottom) * 10) / 10,
        okOnTop: topAt(x, y) === ok || ok.contains(topAt(x, y)), inside: fr.top >= dr.top && fr.bottom <= dr.bottom + 0.5};
    };
    d.scrollTop = 0; await wait(80); const top = check();
    d.scrollTop = d.scrollHeight / 2; await wait(80); const mid = check();
    await shot("sticky-footer-scrolled");
    d.scrollTop = d.scrollHeight; await wait(80); const end = check();
    // Content under the footer: nothing paints over the buttons and no row shows below them.
    const good = c => c.pos === "sticky" && c.scrolls && c.okOnTop && c.inside && c.gap >= -0.5 && c.gap <= 17;
    log(good(top) && good(mid) && good(end), "shell dialog footer stays at the bottom while the form scrolls", {top, mid, end});
    await clickEl(f.querySelector("button[data-variant=primary]"));
    log(!!await until(1500, () => !d.isConnected), "a real click on the sticky OK button closes the dialog");
    // A module dialog with a long form.
    for (const [a, selector] of [["rules", ".rules-window"], ["fab-outputs", ".fab-dialog"], ["preferences", ".prf-dialog"], ["constraints", ".cm-dialog"]]) {
      await cleanup(); act(a);
      const m = await until(4000, () => document.querySelector("dialog[open]" + selector));
      const ft = m?.querySelector(":scope > .ui-dialog-actions:last-child");
      if (!m || !ft || m.scrollHeight <= m.clientHeight + 10) {note("sticky: " + a + " " + (!m ? "opened no dialog" : !ft ? "has its own footer layout" : "does not scroll at this size")); continue;}
      m.scrollTop = 0; await wait(80);
      const dr = rect(m), fr = rect(ft), b = [...ft.querySelectorAll("button")].filter(visible).at(-1), [x, y] = b ? center(b) : [0, 0];
      log(getComputedStyle(ft).position === "sticky" && fr.bottom <= dr.bottom + 0.5 && dr.bottom - fr.bottom <= 18 && (!b || b.contains(topAt(x, y))),
        "sticky footer in the " + a + " dialog", {gap: dr.bottom - fr.bottom, top: topAt(x, y)?.textContent?.slice(0, 20)});
      await shot("sticky-" + a);
      break;
    }
    await cleanup();
  }

  // ------------------------------------------------------------------ mask close icon
  async function maskIcon() {
    await toKind("pcb"); await cleanup();
    const out = {}, root = document.documentElement;
    async function settledTheme(theme) {
      act("theme-" + theme);
      // During a theme transition the mask's foreground and background are interpolating.
      return until(1500, () => root.dataset.theme === theme && !root.hasAttribute("data-theme-fading"));
    }
    for (const theme of ["dark", "light", "hc"]) {
      if (!await settledTheme(theme)) {out[theme] = {error: "Theme did not settle"}; continue;}
      // The panel's own × (a floating or lone panel), or its dock tab's × when the Filter panel shares a
      // tab group (dock.css hides a heading that holds only the title and the close button there).
      const closeBtn = () => [document.querySelector(".query-close"), document.querySelector('.dock-tab-wrap.is-active > .dock-tab-close[data-dock-close="filter"]')].find(visible);
      if (!closeBtn()) {act("query-panel"); await until(3000, closeBtn);}
      const b = closeBtn();
      if (!b) {out[theme] = {error: "Filter panel close button not shown"}; continue;}
      await until(600, () => +getComputedStyle(b).opacity === 1);
      const cs = getComputedStyle(b, "::before"), [x, y] = center(b);
      const px = await post("pixels", {x: x - 9, y: y - 9, w: 18, h: 18});
      out[theme] = px.error ? {error: px.error} : {mask: /url\(/.test(cs.maskImage) || /url\(/.test(cs.webkitMaskImage),
        share: Math.round(px.share * 100) / 100, colours: px.colours};
    }
    await settledTheme("dark");
    await shot("filter-panel-close-icon");
    // An X glyph covers a fraction of its box; a solid square (no mask) covers all of it.
    const ok = Object.values(out).every(o => !o.error && o.mask && o.share > 0.04 && o.share < 0.5);
    log(ok, "CSS mask close icon draws an X in dark, light and high contrast", out);
    act("query-panel"); await wait(100);
  }

  // ------------------------------------------------------------------ Filter panel
  async function filterPanel() {
    await toKind("pcb"); await cleanup(); await fitView();
    const Q = globalThis.AtriumQuery;
    const panel = () => document.querySelector(".panel-query");
    if (!visible(panel())) {
      // Open it from the menus with real clicks: View/Window › … or the palette action.
      act("query-panel");
    }
    const p = await until(3000, () => visible(panel()) && panel());
    if (!p) {log(false, "Filter panel opens"); return;}
    const input = p.querySelector(".query-input");
    await clickEl(input);
    input.value = "";
    for (const ch of "IsVia") await key(ch, ch !== ch.toLowerCase() ? ["shift"] : []);
    const typed = input.value;
    await key("Enter");
    const applied = await until(2000, () => Q?.applied?.());
    const count = p.querySelector(".query-count")?.textContent || "";
    await shot("filter-panel");
    const r = rect(p);
    log(typed === "IsVia" && !!applied && onScreen(r), "Filter panel: typing IsVia and Enter applies the filter", {typed, count, applied: !!applied, err: p.querySelector(".query-error")?.textContent});
    await focusCanvas(); await key("c", ["shift"]);
    log(!!await until(1500, () => !Q.applied?.()), "Shift+C clears the filter", status());
    act("query-panel"); await wait(100);
  }

  // ------------------------------------------------------------------ Navigator
  async function navigator_() {
    await toKind("pcb"); await cleanup();
    act("navigator-panel");
    const p = await until(3000, () => [...document.querySelectorAll(".navp-row")].filter(n => !n.hidden && visible(n)).length > 3 && document.querySelector(".navp-row:not([hidden])").closest("section"));
    if (!p) {log(false, "Navigator opens with rows"); return;}
    const rows = [...document.querySelectorAll(".navp-row")].filter(n => !n.hidden && visible(n));
    const netRow = rows.find(n => n.dataset.type === "net") || null;
    const groups = rows.filter(n => n.dataset.type === "group").map(n => n.textContent.trim().slice(0, 20));
    note("navigator row types: " + [...new Set(rows.map(n => n.dataset.type))].join(", "));
    let picked = null;
    if (!netRow) {
      // Expand the Nets group with a real click.
      const g = rows.find(n => n.dataset.type === "group" && /^Nets/i.test(n.textContent.trim()));
      if (g) {await clickEl(g); await wait(200);}
    }
    const row = [...document.querySelectorAll(".navp-row")].find(n => !n.hidden && visible(n) && n.dataset.type === "net");
    if (row) {
      if (!row.contains(topAt(...center(row)))) {row.scrollIntoView({block: "center"}); await wait(150);}
      const fresh = [...document.querySelectorAll(".navp-row")].find(n => !n.hidden && n.textContent === row.textContent) || row;
      await clickEl(fresh);
      picked = await until(1500, () => host().highlight());
      if (!picked) note("navigator click: " + JSON.stringify({status: status(), at: topAt(...center(row))?.className, type: row.dataset.type, text: row.textContent}));
    }
    await shot("navigator");
    // Keyboard: ArrowDown moves the active row.
    const sc = document.querySelector(".navp-row")?.parentElement?.parentElement;
    sc?.focus(); const before = document.getElementById("navp-active")?.textContent;
    await key("ArrowDown"); const afterRow = document.getElementById("navp-active")?.textContent;
    log(!!row && !!picked && before !== afterRow, "Navigator: a real click on a net row highlights it; ArrowDown moves the active row",
      {groups, row: row?.textContent?.trim().slice(0, 30), highlight: host().highlight(), before, afterRow});
    await key("Escape");
    act("navigator-panel"); await wait(100);
    host().setHighlight(""); globalThis.AtriumQuery?.clear?.(true);
  }

  // ------------------------------------------------------------------ net highlight clicks
  async function netHighlight() {
    const out = {};
    for (const kind of ["pcb", "schematic"]) {
      await toKind(kind); await cleanup(); await fitView();
      const h = host(), t = netPoint();
      if (!t) {out[kind] = {error: "no net under any object"}; continue;}
      const cases = kind === "pcb" ? [["cmd"], ["ctrl"], ["alt"]] : [["alt"]];
      for (const mods of cases) {
        h.setHighlight(""); await post("nativeMenus");
        await mouse(...t.p, {mods});
        const lit = await until(1200, () => h.highlight());
        const native = await post("nativeMenus"), menuOpen = !!ctxMenu();
        const pd = lastSeen("pointerdown");
        out[kind + " " + mods.join("+") + "+click"] = {ok: lit === t.net && !native.length && !menuOpen, net: t.net, lit, native, menuOpen, event: pd && {button: pd.button, ctrl: pd.ctrl, meta: pd.meta, alt: pd.alt, trusted: pd.trusted}};
        if (menuOpen) {await key("Escape"); await cleanup();}
      }
      if (kind === "pcb" && h.highlight()) {
        await shot("net-highlight-pcb");
        // A plain click on empty canvas clears it (Altium).
        const e = emptyPoint(); if (e) await mouse(...e);
        out["pcb empty click clears"] = {ok: !h.highlight()};
      }
      h.setHighlight("");
    }
    const bad = Object.entries(out).filter(([, v]) => !v.ok);
    log(!bad.length, "Ctrl/⌘+click and Alt+click highlight the net under the pointer (no native or page context menu)", out);
  }

  // ------------------------------------------------------------------ Shift+W / Shift+V
  async function choosers() {
    await toKind("pcb"); await cleanup(); await fitView();
    const h = host();
    // Start a route on a pad (a pin with a net).
    let start = null;
    for (const it of h.doc().items.filter(i => i.kind === "part").slice(0, 20)) {
      const p = pointOn(it); if (!p) continue;
      const hit = h.hit(h.canvas(), ...p), net = hit?.item && globalThis.AtriumCrossProbe?.targetAt?.(hit.doc, h.defs(), hit.item, hit.point)?.net;
      if (net) {start = p; break;}
    }
    const t = netPoint();
    if (!start && t) start = t.p;
    if (!start) {log(false, "a point to start routing from"); return;}
    await focusCanvas();
    act("route"); await wait(150);
    if (h.tool() !== "route") {h.setTool("route"); await wait(100);}
    await mouse(...start);
    await mouse(start[0] + 30, start[1] + 4, {kind: "move"});
    const routing = await until(1500, () => h.routeTool());
    const out = {tool: h.tool(), routing: !!routing};
    for (const [k, label] of [["w", "Track Width"], ["v", "Via Size"]]) {
      await key(k, ["shift"]);
      const m = await until(1500, () => document.querySelector('body > .nav-menu[aria-label="' + label + '"]'));
      const items = m ? [...m.querySelectorAll(".nav-menu-item")] : [];
      const focusIn = !!m && m.contains(document.activeElement);
      if (m && label === "Track Width") await shot("shift-w-chooser");
      let nav = null;
      if (m && items.length > 1) {const a = document.activeElement; await key("ArrowDown"); nav = document.activeElement !== a && m.contains(document.activeElement);}
      const shown = m ? onScreen(rect(m)) : false;
      if (m) await key("Escape");
      const closed = !!m && !!await until(800, () => !m.isConnected);
      out[label] = {menu: !!m, items: items.map(b => b.textContent.trim()).slice(0, 5), focusIn, nav, closed, onScreen: shown, status: m ? "" : status()};
    }
    // Pick with a number key.
    await key("w", ["shift"]);
    const m = await until(1500, () => document.querySelector('body > .nav-menu[aria-label="Track Width"]'));
    if (m) await key("1");
    out.numberPick = !!m && !!await until(800, () => !m.isConnected) && status();
    const ok = out.routing && ["Track Width", "Via Size"].every(l => out[l].menu && out[l].focusIn && out[l].closed && out[l].onScreen && out[l].nav !== false);
    log(ok, "Shift+W and Shift+V open the width and via choosers while routing; arrows, Escape and number keys work", out);
    await key("Escape"); await key("Escape"); h.setTool("select"); await cleanup();
  }

  // ------------------------------------------------------------------ Place › Power Port
  async function powerPort() {
    await toKind("schematic"); await cleanup(); await fitView();
    const h = host();
    const menu = name => topMenus().find(m => m.querySelector("summary").textContent.trim() === name);
    const place = menu("Place"), edit = menu("Edit");
    const sub = place?.querySelector("#sub-place-power"), trigger = sub?.querySelector(".submenu-trigger");
    const gnd = sub?.querySelector(':scope > .menu-items [data-power-net="GND"]');
    if (!trigger || !gnd) {log(false, "Place › Power Port has a GND command in the schematic"); return;}
    const opened = () => trigger.getAttribute("aria-expanded") === "true" && visible(gnd);
    const hit = el => el.contains(topAt(...center(el)));
    for (const input of ["hover", "click", "keyboard"]) {
      await cleanup();
      if (!await openTop(place) || !hit(trigger)) {log(false, "Place › Power Port trigger is reachable by " + input); continue;}
      const keyboard = input === "keyboard";
      if (keyboard) {
        trigger.focus(); await key("ArrowRight");
      } else {
        await mouse(...center(trigger), {kind: "move"});
        if (input === "click") {
          const hoverOpened = !!await until(800, opened);
          await clickEl(trigger); const firstClick = opened();
          await clickEl(trigger); const secondClick = !opened();
          await clickEl(trigger);
          log(hoverOpened && firstClick && secondClick, "Power Port stays open on the first click after hover and closes on the second", {hoverOpened, firstClick, secondClick});
        }
      }
      const ready = !!await until(1000, () => opened() && hit(gnd) && (!keyboard || document.activeElement === gnd));
      if (!ready) {log(false, "Power Port opens its GND item by " + input); continue;}
      if (input === "hover") await shot("power-port-submenu");
      const before = JSON.stringify(h.doc().items), ids = new Set(h.doc().items.map(i => i.id));
      if (keyboard) await key("Enter"); else await clickEl(gnd);
      const armed = !!await until(1500, () => h.tool() === "sch-place" && globalThis.AtriumSchObjects?.floating()?.mode === "power" && !place.open);
      const point = armed && emptyPoint();
      if (point) await mouse(...point);
      const added = point && await until(1500, () => h.doc().items.find(i => !ids.has(i.id) && i.kind === "power"));
      const placed = added?.text === "GND" && added.style === "gnd" && h.doc().items.length === ids.size + 1;
      if (placed && input === "hover") await shot("power-port-placed");
      if (keyboard) await key("Escape"); else if (point) await mouse(...point, {button: "right"});
      const stopped = h.tool() === "select";
      if (added) {
        if (keyboard) await key("z", ["ctrl"]);
        else if (edit && await openTop(edit)) await clickEl(edit.querySelector('[data-action="undo"]'));
      }
      const undone = !!added && !!await until(1500, () => JSON.stringify(h.doc().items) === before);
      log(placed && stopped && undone, "Place › Power Port by " + input + " places one GND port and undoes exactly", {armed, net:added?.text, style:added?.style, stopped, undone});
    }
    await cleanup();
  }

  // ------------------------------------------------------------------ What's New links
  async function whatsNew() {
    await toKind("pcb"); await cleanup();
    const results = [];
    for (let i = 0; i < 20; i++) {
      await cleanup();
      act("whats-new");
      const d = await until(4000, () => document.querySelector("dialog.whats-new[open]"));
      if (!d) {results.push({i, ok: false, why: "dialog"}); break;}
      if (i === 0) await shot("whats-new");
      const links = [...d.querySelectorAll(".whats-new-go")];
      if (i >= links.length) {const kb = [...d.querySelectorAll(".ui-dialog-actions button")].find(b => /Keyboard/.test(b.textContent)); if (kb) {await clickEl(kb); const s = await until(3000, () => document.querySelectorAll("dialog[open]").length && !d.isConnected); results.push({link: "Keyboard Shortcuts", ok: !!s});} break;}
      const link = links[i], label = link.textContent, errs = errors.length, st = status();
      const dialogsBefore = document.querySelectorAll("dialog").length;
      // The list scrolls inside the dialog at this window size; a user scrolls to the link.
      const below = !onScreen(rect(link)) || !link.contains(topAt(...center(link)));
      if (below) link.scrollIntoView({block: "center"});
      await wait(50);
      await clickEl(link);
      const closed = await until(1500, () => !d.isConnected || !d.open);
      await wait(700);
      const changed = status() !== st || document.querySelectorAll("dialog[open]").length > 0 || document.querySelectorAll("dialog").length !== dialogsBefore
        || [...document.querySelectorAll("[aria-checked=true],[aria-pressed=true]")].length >= 0;
      results.push({link: label, ok: !!closed && errors.length === errs && changed, scrolled: below, status: status().slice(0, 60), errors: errors.slice(errs)});
      await key("Escape"); await cleanup();
      if (host().doc().kind !== "pcb") await toKind("pcb");
      act("view-2d"); // 3D Layout leaves the 3D view up
    }
    const bad = results.filter(r => !r.ok);
    log(!bad.length && results.length > 5, "Help › What's New: each link closes the dialog and runs its command (" + results.length + " links)", bad.length ? bad : results.map(r => r.link).join(", "));
    await cleanup();
  }

  // ------------------------------------------------------------------ theme screenshots
  async function themeShots() {
    for (const kind of ["pcb", "schematic"]) for (const theme of ["dark", "light", "hc"]) {
      await toKind(kind); await cleanup(); act("theme-" + theme); await wait(200);
      if (kind === "pcb") {
        const view = topMenus().find(m => /^View$/.test(m.querySelector("summary").textContent.trim()));
        if (view && await openTop(view)) {
          const sub = [...view.querySelectorAll(".submenu")].find(s => visible(s));
          if (sub) {sub.querySelector(".submenu-trigger").focus(); await key("ArrowRight");}
        }
      } else {
        const it = host().doc().items.find(i => i.kind === "part"), p = it && pointOn(it);
        if (p) {await mouse(...p, {button: "right"}); await until(1500, ctxMenu);}
      }
      await shot("theme-" + theme + "-" + kind);
      await key("Escape"); await key("Escape"); await cleanup();
    }
    act("theme-dark"); await wait(100);
  }

  // ------------------------------------------------------------------ camera and mouse (camera.js, editor.js)
  function gridFrames(){
    const c=document.createElement("canvas");c.style.cssText="position:fixed;left:-400px;top:0;width:240px;height:180px";document.body.append(c);
    const ref=c.cloneNode();document.body.append(ref);
    try{
      const v=AtriumCanvas.create(c),expected=AtriumCanvas.create(ref),g=c.getContext("2d"),defs=new Map();
      for(const kind of ["schematic","pcb"]){
        const d={id:"grid-"+kind,kind,grid:1,items:[],outline:[]},opts={grid:true,origin:false};
        v.restoreCamera({...v.camera(),cx:50,cy:kind==="pcb"?50:-50,scale:10});
        // Exercise the expensive-frame cache even on an otherwise empty document.
        v.render(d,defs,{...opts,overlay:[()=>{const stop=performance.now()+6;while(performance.now()<stop){}}]});
        let ok=true;
        for(const factor of [1.31,1.12,.73]){
          v.zoom(factor,[63,37]);v.moving();v.render(d,defs,opts);
          const moving=g.getImageData(0,0,c.width,c.height).data;
          expected.restoreCamera(v.camera());expected.render(d,defs,opts);
          const exact=ref.getContext("2d").getImageData(0,0,ref.width,ref.height).data;
          ok&&=moving.every((x,i)=>x===exact[i]);
        }
        log(ok,kind+" grid pixels match the exact camera while zooming in and out");
      }
    }finally{c.remove();ref.remove();}
  }
  function touchCamera(c,v){
    const r=rect(c),at=[r.width*.37,r.height*.4];
    function contact(type,id,x,y){c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:"touch",clientX:r.left+x,clientY:r.top+y}));}
    function gesture(type,scale,x,y){const e=new Event(type,{bubbles:true,cancelable:true});Object.assign(e,{scale,clientX:r.left+x,clientY:r.top+y});c.dispatchEvent(e);}
    const close=(a,b)=>Math.abs(a-b)<1e-6,near=(a,b)=>close(a[0],b[0])&&close(a[1],b[1]),before=JSON.stringify([host().doc().items,host().selection()]);
    const start=v.camera(),grab=v.screenToWorld(at);
    contact("pointerdown",101,...at);contact("pointermove",101,at[0]+14,at[1]+7);
    const pan=near(v.worldToScreen(grab),[at[0]+14,at[1]+7])&&v.scale()===start.scale;
    contact("pointerdown",102,at[0]+74,at[1]+7);
    const mid=[at[0]+44,at[1]+7],anchor=v.screenToWorld(mid);
    gesture("gesturestart",1,...mid);
    contact("pointermove",101,at[0]+4,at[1]+17);contact("pointermove",102,at[0]+94,at[1]+17);
    gesture("gesturechange",1.5,at[0]+49,at[1]+17);
    c.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-4,clientX:r.left+mid[0],clientY:r.top+mid[1]}));
    const pinch=close(v.scale(),start.scale*1.5)&&near(v.worldToScreen(anchor),[at[0]+49,at[1]+17]);
    contact("pointerup",102,at[0]+94,at[1]+17);gesture("gestureend",1.5,at[0]+49,at[1]+17);
    const last=v.screenToWorld([at[0]+4,at[1]+17]);contact("pointermove",101,at[0]+1,at[1]+26);
    const resume=near(v.worldToScreen(last),[at[0]+1,at[1]+26]);contact("pointercancel",101,at[0]+1,at[1]+26);
    const track=v.camera(),pt=v.screenToWorld(at);gesture("gesturestart",1,...at);
    gesture("gesturechange",1.25,at[0]+2,at[1]-3);gesture("gestureend",1.25,at[0]+2,at[1]-3);
    const web=close(v.scale(),track.scale*1.25)&&near(v.worldToScreen(pt),[at[0]+2,at[1]-3]);
    log(pan&&pinch&&resume&&web&&before===JSON.stringify([host().doc().items,host().selection()]),"Direct touch pans, pinches once at the moving midpoint and resumes panning; trackpad pinch keeps its anchor",{pan,pinch,resume,web});
    v.restoreCamera(start);host().redraw();
  }
  async function camera() {
    await toKind("pcb"); await cleanup(); await fitView();
    const h = host(), c = h.canvas(), r = rect(c), cam = () => h.view().camera(), out = {};
    if (!globalThis.AtriumCamera) await globalThis.AtriumLazy.need("AtriumCamera");
    globalThis.AtriumCamera.setPref("camera.animate", false);
    const x = r.left + r.width * .45, y = r.top + r.height * .5;
    // Right-drag pans; no page or native menu.
    let a = cam(); await post("nativeMenus");
    await mouse(x, y, {button: "right", kind: "down"});
    const steps=[];
    for (let k = 1; k <= 4; k++){
      await mouse(x + 20 * k, y + 5 * k, {button: "right", kind: "drag"});
      const dr=rect(c),s=cam(),dx=(a.cx-s.cx)*s.scale,dy=(a.cy-s.cy)*s.scale;
      steps.push(Math.abs(dx-20*k)<1.1&&Math.abs(dy-5*k)<1.1&&Math.abs(dr.left-r.left)<.01&&Math.abs(dr.top-r.top)<.01);
    }
    await mouse(x + 80, y + 20, {button: "right", kind: "up"}); await wait(150);
    out.rightDrag = {ok: steps.every(Boolean) && Math.abs((a.cx-cam().cx)*cam().scale-80)<1.1 && !ctxMenu(), steps, menu: !!ctxMenu(), native: await post("nativeMenus")};
    await cleanup();
    // A still right click opens the page menu on release.
    a = cam(); await mouse(x, y, {button: "right"}); const m = await until(1500, () => ctxMenu());
    out.rightClick = {ok: !!m && Math.abs(cam().cx - a.cx) < 1e-9, menu: !!m, native: await post("nativeMenus")};
    await key("Escape"); await cleanup();
    // Wheels: the Altium preset scrolls, a horizontal (side or tilt) wheel pans sideways, Ctrl zooms.
    for (const preset of ["altium", "zoom"]) {
      globalThis.AtriumCamera.setPref("mouse.wheel", preset);
      a = cam(); await post("wheel", {x, y, dx: 0, dy: -3}); const b = cam();
      await post("wheel", {x, y, dx: -3, dy: 0}); const s = cam();
      out["wheel " + preset] = {ok: (preset === "altium" ? b.scale === a.scale && b.cy !== a.cy : b.scale !== a.scale) && s.cx !== b.cx && s.cy === b.cy && s.scale === b.scale,
        notch: [a.cy !== b.cy, a.scale !== b.scale], side: [s.cx !== b.cx, s.cy === b.cy, s.scale === b.scale]};
    }
    globalThis.AtriumCamera.setPref("mouse.wheel", "zoom");
    // Thumb buttons step the view history and never navigate the page.
    await fitView(); globalThis.AtriumCamera.settle();
    const v = h.view(), f = v.camera(); v.restoreCamera({...f, cx: f.cx + 900 / f.scale}); h.redraw(); globalThis.AtriumCamera.settle();
    const url = location.href, far = cam().cx;
    await post("other", {x, y, button: 3}); await wait(250); const back = cam().cx;
    await post("other", {x, y, button: 4}); await wait(250);
    out.thumbButtons = {ok: Math.abs(back - f.cx) < 1e-6 && Math.abs(cam().cx - far) < 1e-6 && location.href === url, back: Math.abs(back - f.cx) < 1e-6, forward: Math.abs(cam().cx - far) < 1e-6, url: location.href === url,
      event: lastSeen("pointerdown") && {button: lastSeen("pointerdown").button, trusted: lastSeen("pointerdown").trusted}};
    globalThis.AtriumCamera.setPref("camera.animate", true);
    touchCamera(c,h.view());gridFrames();
    const bad = Object.entries(out).filter(([, v]) => !v.ok);
    log(!bad.length, "Mouse: right-drag pans, a still right click opens the menu, side wheel pans, Altium wheel preset, thumb buttons step the view history", out);
  }
  async function view3DControls() {
    await toKind("pcb"); await cleanup();
    const h = host(), view = topMenus().find(m => m.querySelector("summary").textContent.trim() === "View");
    if (!view || !await openTop(view)) {log(false, "View menu opens for the 3D walkthrough"); return;}
    const entry = view.querySelector('[data-action="view-3d"]');
    await clickEl(entry);
    const v = await until(5000, () => [...(globalThis.Atrium3D?.viewers.values() || [])][0]);
    if (!v?.R) {log(false, "3D opens with a WebGL viewer"); return;}
    const c = v.canvas, cam = () => v.camera(), same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
    const r = rect(c), x = Math.round(r.left + r.width*.43), y = Math.round(r.top + r.height*.42);
    const records = [];
    const record = e => records.push({type:e.type, trusted:e.isTrusted, blocked:e.defaultPrevented, cancelable:e.cancelable,
      ...(e.type==="wheel" ? {x:e.deltaX,y:e.deltaY,mode:e.deltaMode,legacy:e.wheelDeltaY,ctrl:e.ctrlKey} : {scale:e.scale})});
    const types = ["wheel", "gesturestart", "gesturechange", "gestureend"];
    for (const type of types) c.addEventListener(type,record);
    try {
      const openingFocus = document.activeElement === c;
      await key("0"); await until(900, () => cam().pitch === 90);
      await key("9"); const bottom = !!await until(900, () => cam().pitch === -90);
      await key("f"); const flipped = !!await until(900, () => cam().pitch === 90);
      let a = cam(); await key("ArrowLeft");
      log(openingFocus && bottom && flipped && cam().yaw-a.yaw===15, "3D menu entry focuses the viewport and native keys change the view");
      const orbitBefore = cam();
      await post("path",{button:"left",points:[[x,y],[x+9,y],[x+25,y+8]],ms:30});
      const orbited = cam();
      await post("path",{button:"right",points:[[x,y],[x+9,y],[x+25,y+8]],ms:30});
      const panned = cam();
      log(orbitBefore.yaw!==orbited.yaw && same(orbitBefore.target,orbited.target) && orbited.yaw===panned.yaw && !same(orbited.target,panned.target) && !ctxMenu(),
        "3D uses primary drag to orbit and secondary drag to pan", {orbit:orbited.yaw-orbitBefore.yaw,pan:panned.target.map((n,i)=>n-orbited.target[i])});

      const offset = await wheelOffset(x,y), sendWheels = settings => post("wheels",{x,y,ox:offset[0],oy:offset[1],count:1,ms:40,...settings});
      a = cam(); await sendWheels({dx:-7,dy:-11,pixels:true});
      const precision = cam(), scroll = records.at(-1);
      await sendWheels({dx:0,dy:1,pixels:false});
      const detent = cam(), notch = records.at(-1);
      log(a.dist===precision.dist && !same(a.target,precision.target) && scroll?.trusted && scroll.blocked && scroll.x && scroll.y &&
        detent.dist!==precision.dist && notch?.trusted && notch.blocked,
        "3D pans with AppKit precision scroll and zooms with a notched wheel", {scroll,notch});
      records.length=0; a = cam();
      for (const finish of ["end","cancel"]) {
        for (const phase of ["begin","change"]) {
          const n = records.length;
          await post("magnify",{phase,amount:phase==="change"?.25:0,x,y});
          await until(1000,()=>records.length>n);
        }
        await sendWheels({dx:0,dy:-8,pixels:true,ctrl:true});
        const n = records.length;
        await post("magnify",{phase:finish,amount:0,x,y});
        await until(1000,()=>records.length>n);
      }
      const zooms = records.filter(e=>e.type!=="wheel"), suppressed = records.filter(e=>e.type==="wheel");
      const ratio = cam().dist/a.dist;
      a=cam(); await sendWheels({dx:0,dy:-8,pixels:true,ctrl:true});
      const afterCancel = cam().dist/a.dist, nextWheel = records.at(-1);
      log(Math.abs(ratio-.8**2)<1e-6 && zooms.map(e=>e.type).join(",")==="gesturestart,gesturechange,gestureend,gesturestart,gesturechange,gestureend" &&
        zooms.every(e=>e.trusted && (!e.cancelable || e.blocked)) && suppressed.length>=2 && suppressed.every(e=>e.ctrl && e.trusted && e.blocked) && nextWheel?.type==="wheel" && nextWheel.ctrl && Math.abs(afterCancel-Math.exp(nextWheel.y*.01))<1e-6,
        "3D applies each native gesture once, suppresses concurrent Ctrl-wheel, and accepts input after cancel",
        {ratio,afterCancel,events:zooms.map(e=>[e.type,e.scale,e.trusted,e.blocked,e.cancelable])});

      const point = (type,id,dx=0,dy=0) => c.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:"touch",pointerId:id,clientX:x+dx,clientY:y+dy}));
      const selection = h.selection();
      a=cam(); point("pointerdown",81); point("pointermove",81,20,8);
      const one=cam(); point("pointerdown",82,60,8); point("pointermove",82,80,8);
      const pinch=cam(); point("pointerup",82,80,8); const lifted=cam();
      point("pointermove",81,34,11); const resumed=cam(); point("lostpointercapture",81);
      point("pointermove",81,40,16);
      log(a.yaw===one.yaw && a.dist===one.dist && !same(a.target,one.target) && Math.abs(pinch.dist/one.dist-2/3)<1e-6 && same(pinch,lifted) &&
        resumed.dist===lifted.dist && !same(lifted.target,resumed.target) && same(resumed,cam()) && same(h.selection(),selection),
        "3D touch PointerEvents pan, pinch, resume after release and stop at capture loss in WebKit");
      await key("2");
      log(!!await until(900,()=>!Atrium3D.isOpen() && document.activeElement===h.canvas()), "3D exits to the focused 2D viewport");
    }finally{
      for(const type of types)c.removeEventListener(type,record);
      if (Atrium3D.isOpen()) v.close();
      await cleanup();
    }
  }
  async function nativePinch(){
    const h=host(),active=h.canvas(),oldTool=h.tool(),split=h.panes().length>1;
    if(!split)h.openSplit("right",null,{focus:false});
    const p=h.panes().find(p=>!p.active),events=[],types=["gesturestart","gesturechange","gestureend"];
    const record=e=>events.push([e.type,e.isTrusted,e.target===p.canvas]);
    for(const type of types)window.addEventListener(type,record,true);
    const camera=p.view.camera();
    try{
      active.focus();h.setTool("pan");globalThis.AtriumCamera?.takeCamera?.(p.view);
      const b=rect(p.canvas),x=Math.round(b.left+b.width*.45),y=Math.round(b.top+b.height*.48);
      const at=[x-b.left,y-b.top],anchor=p.view.screenToWorld(at);
      for(const finish of ["end","cancel"]){
        for(const phase of ["begin","change",finish]){
          const n=events.length;
          await post("magnify",{phase,amount:phase==="change"?.25:0,x,y});
          await until(900,()=>events.length>n);
        }
      }
      const screen=p.view.worldToScreen(anchor);
      log(events.length===6&&events.every(([type,trusted,hit],n)=>type===types[n%3]&&trusted&&hit)&&
        Math.abs(p.view.scale()/camera.scale-1.25**2)<1e-6&&Math.hypot(screen[0]-at[0],screen[1]-at[1])<.01&&
        h.canvas()===active&&document.activeElement===active&&h.tool()==="pan",
        "Native trackpad magnification zooms the other pane around its anchor and preserves Pan and editing focus",events);
    }finally{
      for(const type of types)window.removeEventListener(type,record,true);
      p.view.restoreCamera(camera);if(!split)h.act("split-close");h.setTool(oldTool);h.redraw();
    }
  }
  async function schematicEditing(){
    const h=host(),previous=h.project(),previousId=h.currentId(),p=Atrium.project("Wire grip probe"),d=p.documents[0];
    const tip=[10,-15],tap=[16,-15],far=[24,-15],destination=[18,-23];
    const w=(id,...points)=>({kind:"wire",id,points}),label=(id,at)=>({kind:"netlabel",id,x:at[0],y:at[1],text:id});
    d.grid=1;d.items=[w("editable",tip,far),w("tap",tap,[16,-12]),w("target",[10,-23],[24,-23]),label("OLD",tip),label("DEST",[24,-23])];
    await h.replaceProject(p,{force:true,dirty:false});h.selectDocument(d.id);
    const c=h.canvas(),v=h.view(),r=rect(c),camera={...v.camera(),cx:17,cy:-18,scale:Math.min(14,r.width/31,r.height/28)};
    v.restoreCamera(camera);h.redraw();await wait(150);
    const at=point=>{const s=v.worldToScreen(point);return [r.left+s[0],r.top+s[1]];};
    const input=(kind,point)=>mouse(...at(point),{kind});
    const editable=()=>h.doc().items.find(i=>i.id==="editable"),initial=JSON.stringify(editable().points);
    try{
      h.select(["editable"]);await input("down",tip);await input("drag",destination);await input("up",destination);
      const moved=JSON.stringify(editable().points),nets=Atrium.connectivity(h.doc(),h.defs()).byWire;
      const reconnected=Atrium.same(editable().points[0],destination)&&Atrium.same(editable().points.at(-1),far)&&nets.get("tap")==="DEST"&&nets.get("editable")==="DEST";
      act("undo");const restored=JSON.stringify(editable().points)===initial;act("redo");const redone=JSON.stringify(editable().points)===moved;
      log(reconnected&&restored&&redone,"Dragging a selected wire end off a label reconnects to the target wire and undoes in one step",{reconnected,restored,redone,moved});
      act("undo");
      h.edit(()=>{const old=h.doc().items.find(i=>i.id==="OLD");[old.x,old.y]=far;});
      h.select(["editable"]);await input("down",far);await input("drag",destination);await input("up",destination);
      const tail=Atrium.connectivity(h.doc(),h.defs()).byWire,old=h.doc().items.find(i=>i.id==="OLD");
      log(Atrium.same(editable().points[0],tip)&&Atrium.same(editable().points.at(-1),destination)&&
        tail.get("editable")==="DEST"&&tail.get("tap")==="DEST"&&Atrium.same([old.x,old.y],far),
        "The opposite wire end also takes precedence over its net label and preserves the interior branch");
      act("undo");act("undo");h.select(["editable"]);
      await input("down",tip);await input("drag",destination);await key("Escape");await input("up",destination);
      log(JSON.stringify(editable().points)===initial,"Escape during endpoint drag restores the wire");
      h.select([]);c.focus();const count=()=>h.doc().items.filter(i=>i.kind==="wire").length,before=count();
      // WebKit drops plain mouse moves in a window that is not key (the harness window never is); a
      // drag event with no button down is delivered as a trusted hover move (buttons 0).
      for(const x of [12,20]){await input("drag",[x,-15]);await key("w",["ctrl"]);await input("drag",[x,-23]);await input("click",[x,-23]);}
      const added=h.doc().items.filter(i=>i.kind==="wire").slice(before);
      log(count()===before+2&&[12,20].every((x,n)=>Atrium.same(added[n]?.points[0]||[],[x,-15])&&Atrium.same(added[n].points.at(-1),[x,-23])),
        "Control-W starts a fresh wire at the pointer, including while the Wire tool is active",added.map(i=>i.points));
      await key("Escape");act("select");h.select([]);
      const source=[7,-26],end=[27,-10];await input("down",source);await input("drag",end);
      const mid=v.worldToScreen([17,-26]),ratio=c.width/r.width,px=Math.round(mid[0]*ratio),py=Math.round(mid[1]*ratio);
      const blueEdge=()=>{const a=c.getContext("2d").getImageData(px-4,py-4,9,9).data;for(let n=0;n<a.length;n+=4)if(a[n]<60 && a[n+1]>65 && a[n+2]>130 && a[n+2]>a[n+1]+30)return true;return false;};
      const visible=!!await until(1200,blueEdge);await input("up",end);
      log(visible&&h.selection().includes("editable"),"The selection marquee has a continuous visible edge and selects the enclosed wire",{visible,selection:h.selection()});
      // A joint of two wires dragged directly (nothing selected first) keeps both wires on it.
      await key("Escape");h.select([]);h.edit(()=>h.doc().items.push(w("j1",[27,-7],[31,-7]),w("j2",[31,-7],[31,-5])));
      await input("down",[31,-7]);await input("drag",[30,-9]);await input("up",[30,-9]);
      const j=id=>h.doc().items.find(i=>i.id===id).points,jn=Atrium.connectivity(h.doc(),h.defs()).byWire;
      log(Atrium.same(j("j1").at(-1),[30,-9])&&Atrium.same(j("j2")[0],[30,-9])&&jn.get("j1")===jn.get("j2"),"Dragging a wire joint directly moves both wire ends together",{j1:j("j1"),j2:j("j2")});
    }finally{await h.replaceProject(previous,{force:true,dirty:false});h.selectDocument(previousId);}
  }
  // Right-click on every kind of surface: the Projects panel and tabs open the app's
  // project or document menu; everything else opens no menu at all. WebKit's own menu (Reload, Back,
  // Inspect…) never shows. Then Close Project from the panel: Cancel keeps unsaved edits, Don't Save
  // returns to Home with an empty workspace, and the demo comes back for the next probes.
  async function surfaces() {
    await cleanup();
    await toKind("pcb");
    const app = sel => [...document.querySelectorAll(sel)].find(visible);
    const panelBody = document.querySelector(".panel-projects .panel-body");
    const spots = [
      ["project in the panel", app(".project-tree > summary"), "project"],
      ["Projects panel background", panelBody, "project", el => {const r = rect(el); return [r.left + r.width / 2, r.bottom - 3];}],
      ["empty left pane", app("#navigator"), "project", el => {const r = rect(el); return [r.left + r.width / 2, r.bottom - 12];}],
      ["document row", app("#documents [data-doc]"), "document"], ["document tab", app("#document-tabs [data-tab]"), "tab"],
      ["app icon", app(".appbar .brand"), null], ["search", app(".nav-command-centre"), null], ["quick access", app(".quick-access .command-link"), null],
      ["status bar", app("#status") || app(".statusbar"), null], ["panel heading", app("#properties .pane-heading"), null],
      ["Properties panel", app("#inspector"), null], ["active bar", app("#tools"), null, el => {const r = rect(el), y = r.top + r.height / 2; for (let x = r.right - 2; x > r.left; x -= 2) {const t = document.elementFromPoint(x, y); if (t && el.contains(t) && !t.closest(".tool")) return [x, y];} return center(el);}], ["layer tabs", app("#layer-tabs") || app(".layer-bar"), null]
    ];
    const results = [];
    for (const [name, target, menu, where] of spots) {
      await cleanup();
      if (!target) {results.push({name, ok: menu === null, why: "not shown"}); continue;}
      await post("nativeMenus");
      const p = where ? where(target) : center(target);
      await mouse(...p, {button: "right"});
      const m = menu ? await until(2000, ctxMenu) : (await wait(400), ctxMenu());
      const native = (await post("nativeMenus")).filter(Boolean);
      const entries = m ? [...m.querySelectorAll(".nav-menu-item")].map(b => b.textContent.replace(/\s+/g, " ").trim()) : [];
      const want = menu === "project" ? ["Validate Project", "Add Existing to Project…", "Save Project As…", "Close Project", "Project Options…"]
        : menu === "document" ? ["Open Document", "Rename Document…", "Save Project"]
        : menu === "tab" ? ["Close", "Close Others", "Close Documents to the Right", "Close Documents to the Left", "Close All", "Close Saved Documents", "Open Document", "Rename Document…"] : [];
      const ok = !native.length && (menu ? want.every(w => entries.some(e => e.startsWith(w))) : !m);
      results.push({name, ok, native, entries: entries.length, missing: want.filter(w => !entries.some(e => e.startsWith(w)))});
      if (m) {await key("Escape"); await until(800, () => !document.body.contains(m));}
    }
    const bad = results.filter(r => !r.ok);
    log(!bad.length, "every surface opens the app's menu or none, never WebKit's", bad.length ? bad : results.map(r => r.name + ":" + r.entries).join(", "));
    // The tab menu's Close Others with a real mouse click: the clicked tab is left; the documents stay in the project.
    {
      await cleanup();
      if (host().isDirty()) await host().replaceProject(host().project(), {force: true, dirty: false}); // the demo, saved: no prompt
      const tabs = () => [...document.querySelectorAll("#document-tabs [data-tab]")].filter(t => !t.hidden), count = host().project().documents.length;
      const tab = tabs()[0];
      await post("nativeMenus");
      await mouse(...center(tab), {button: "right"});
      const m = await until(2000, ctxMenu); await wait(400); await shot("tab-menu");
      const item = m && [...m.querySelectorAll(".nav-menu-item")].find(b => b.querySelector("span")?.textContent === "Close Others");
      if (item) await clickEl(item);
      const left = await until(2000, () => tabs().length === 1 && tabs());
      const native = (await post("nativeMenus")).filter(Boolean);
      log(!!item && !!left && left[0] === tab && host().project().documents.length === count && !native.length,
        "a mouse click on the tab menu's Close Others leaves the clicked tab; the documents stay in the project", {left: tabs().map(t => t.textContent), native});
      for (const d of host().project().documents) globalThis.AtriumVSKeys?.show?.(d.id);
    }
    // Close Project from the Projects panel.
    const h = host(), name = h.project().name;
    const closeFromPanel = async () => {
      await cleanup();
      await mouse(...center(app(".project-tree > summary")), {button: "right"});
      const m = await until(2000, ctxMenu);
      await wait(400); // the menu scales in: click once it has settled
      const item = m && [...m.querySelectorAll(".nav-menu-item")].find(b => b.textContent.trim().startsWith("Close Project"));
      // A real mouse click on the item (WebKit must not close the menu on the press).
      if (item) await clickEl(item);
      return !!item;
    };
    h.edit(() => { h.project().name = name + " (edited)"; });

    let opened = await closeFromPanel();
    let ask = await until(2000, () => [...document.querySelectorAll("dialog.close-project-dialog[open]")].at(-1));
    const buttons = ask ? [...ask.querySelectorAll("button")].map(b => b.textContent) : [];
    if (ask) {await wait(300); await clickEl([...ask.querySelectorAll("button")].find(b => b.textContent === "Cancel"));}
    await wait(300);
    log(opened && ask && ["Cancel", "Don’t Save", "Save"].every(b => buttons.includes(b)) && !h.isStarter() && h.isDirty(),
      "a mouse click on Close Project with unsaved edits asks first; Cancel keeps the project", buttons);
    opened = await closeFromPanel();
    ask = await until(2000, () => [...document.querySelectorAll("dialog.close-project-dialog[open]")].at(-1));
    if (ask) {await wait(300); await clickEl([...ask.querySelectorAll("button")].find(b => b.textContent === "Don’t Save"));}
    const sp = await until(4000, () => document.querySelector("dialog.sp-dialog[open]"));
    log(opened && !!sp && h.isStarter() && !h.isDirty() && h.project().documents.every(d => !d.items.length) && document.title === "Waffle",
      "Don't Save closes the project and returns to Home with an empty workspace", {starter: h.isStarter(), title: document.title});
    if (sp) {
      await wait(300); await clickEl(sp.querySelector("[data-start-action=demo]"));
      await until(3000, () => !sp.open && !h.isStarter());
    }
    await cleanup();
  }
  // Escape dismisses every transient surface (dialogs, the component library, floating panels) and gives
  // the keyboard back to the canvas; docked panels stay open but return focus to the canvas.
  async function escapeAll(){
    const h=host(),out={};
    const state=()=>({dialogs:[...document.querySelectorAll("dialog[open]")].filter(visible).map(d=>d.id||d.className),
      floats:[...document.querySelectorAll(".vc-panel,.dock-float")].filter(visible).map(e=>e.className),focus:document.activeElement===h.canvas()});
    for(const kind of ["schematic","pcb"]){
      await toKind(kind);await cleanup();
      for(const a of ["library","library-panel","nets-panel","messages","find-replace","command-palette","preferences","shortcuts","rules","bom",...(kind==="pcb"?["view-config","stackup"]:[])]){
        (await focusCanvas());act(a);await wait(500);const opened=state();
        await key("Escape");await wait(250);const after=state();
        const library=a==="library-panel"&&visible(document.querySelector(".panel-library"));
        out[kind+" "+a]={ok:!after.dialogs.length&&!after.floats.length&&after.focus&&!library,opened,after};
        await cleanup();
      }
    }
    const bad=Object.entries(out).filter(([,v])=>!v.ok);
    log(!bad.length,"Escape closes dialogs, the component library and floating panels and returns focus to the canvas",bad.length?Object.fromEntries(bad):Object.keys(out));
  }
  // Continuous right-drag pan and wheel zoom at a real input rate (8 ms AppKit events) on the board (GPU and
  // 2D renderers) and a sheet of UI_PROJECT (else the demo): the view follows the pointer 1:1 on every event
  // and animation frame, never moves back and opens no menu. Shots: pan-<mode>-gesture is taken mid-drag,
  // pan-<mode>-rest after the exact frame at the same camera (the two should match).
  async function panPath(){
    const h=host(),P=globalThis.AtriumPrefs||await globalThis.AtriumLazy.need("AtriumPrefs"),renderer=P.get?.("display.renderer");
    if(globalThis.__uiProject){await h.replaceProject(Atrium.validate(JSON.parse(globalThis.__uiProject)),{force:true,dirty:false});}
    globalThis.AtriumCamera?.setPref?.("camera.animate",false);
    for(const [kind,mode] of [["pcb","auto"],["pcb","2d"],["schematic","2d"]]){
      P.set("display.renderer",mode);await toKind(kind);await cleanup();act("fit");h.redraw();
      if(mode==="auto")await until(6000,()=>globalThis.AtriumCanvasGPU?.stats?.()?.acc?.frames>0);await wait(800);
      const c=h.canvas(),r=rect(c),v=h.view(),x=Math.round(r.left+r.width*.3),y=Math.round(r.top+r.height*.45);
      const start=v.camera(),grab=v.screenToWorld([x-r.left,y-r.top]);
      const events=[],frames=[];let on=true;
      const rec=e=>{if(e.type!=="pointermove"||!e.isTrusted)return;const s=v.worldToScreen(grab);events.push(Math.hypot(s[0]-(e.clientX-r.left),s[1]-(e.clientY-r.top)));};
      window.addEventListener("pointermove",rec);
      const tick=t=>{if(!on)return;const s=v.worldToScreen(grab);frames.push([t,s[0],s[1]]);requestAnimationFrame(tick);};requestAnimationFrame(tick);
      const pts=[];for(let k=0;k<=90;k++)pts.push([x+k*4,y+Math.round(k*1.5)]);
      await post("nativeMenus");
      await post("path",{button:"right",points:pts.slice(0,46),ms:8,up:false});await frame2();await shot("pan-"+kind+"-"+mode+"-gesture");
      await wait(600);await shot("pan-"+kind+"-"+mode+"-rest");
      const t0=frames.length;
      await post("path",{button:"right",points:pts.slice(45),ms:8,down:false});
      await wait(400);on=false;window.removeEventListener("pointermove",rec);
      const end=v.worldToScreen(grab),last=pts.at(-1);
      let back=0;for(let n=1;n<frames.length;n++)if(frames[n][1]<frames[n-1][1]-.01||frames[n][2]<frames[n-1][2]-.01)back++;
      const dt=frames.slice(t0+1).map((f,n)=>f[0]-frames[t0+n][0]).sort((a,b)=>a-b);
      const out={events:events.length,maxErr:+Math.max(0,...events).toFixed(3),frames:frames.length,back,endErr:+Math.hypot(end[0]-(last[0]-r.left),end[1]-(last[1]-r.top)).toFixed(3),
        menu:!!ctxMenu(),native:await post("nativeMenus"),dtP50:+dt[dt.length>>1]?.toFixed(1),dtMax:+dt.at(-1)?.toFixed(1)};
      log(out.events>60&&out.maxErr<.5&&!out.back&&out.endErr<.5&&!out.menu&&!out.native.length,"Continuous right-drag pans 1:1 on every event and frame with no snap-back: "+kind+" "+mode+(globalThis.__uiProject?" on UI_PROJECT":""),out);
      // Notched-wheel zoom at the pointer: the point under the pointer stays put.
      const anchor=v.screenToWorld([x-r.left,y-r.top]),z0=v.scale(),o=await wheelOffset(x,y);
      await post("wheels",{x,y,ox:o[0],oy:o[1],dx:0,dy:2,count:4,ms:40});
      const za=v.worldToScreen(anchor);
      log(Math.hypot(za[0]-(x-r.left),za[1]-(y-r.top))<.5&&Math.abs(Math.log(v.scale()/z0))>.2,"Notched wheel zoom keeps the point under the pointer: "+kind+" "+mode,{za,ratio:v.scale()/z0});
      v.restoreCamera(start);h.redraw();
    }
    P.set("display.renderer",renderer||"auto");
  }
  // Continuous pinch zoom (Control + trackpad pixel scroll, 8 ms apart) on the board (GPU and 2D) and a sheet:
  // the point under the pointer stays put on every frame, frames keep coming, and the zoom-gesture shot
  // (zoom-<mode>-gesture) matches the exact frame at the same camera taken after it settles (zoom-<mode>-rest).
  const frame2=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  // Where a harness scroll event lands relative to where it was sent (see "wheels" in ui-probes.swift).
  async function wheelOffset(x,y){
    let got=null;const take=e=>{got??=[e.clientX,e.clientY];e.preventDefault();e.stopImmediatePropagation();};
    window.addEventListener("wheel",take,{capture:true,passive:false});
    try{await post("wheels",{x,y,dx:0,dy:-1,count:1,ms:30,pixels:true});await until(500,()=>got);}finally{window.removeEventListener("wheel",take,{capture:true});}
    return got?[x-got[0],y-got[1]]:[0,0];
  }
  async function wheelNotch() {
    const h=host(), C=await AtriumLazy.need("AtriumCamera"), classify=window.__waffleIsWheelNotch;
    const mode=document.documentElement.getAttribute("data-motion"), animation=C.cfg["camera.animate"], preset=C.cfg["mouse.wheel"], zoomAt=C.cfg["mouse.zoomAt"];
    try {
      document.documentElement.setAttribute("data-motion","full");
      C.setPref("camera.animate",true); C.setPref("mouse.wheel","zoom"); C.setPref("mouse.zoomAt","pointer");
      for (const kind of ["pcb","schematic"]) {
        await toKind(kind); await cleanup();
        const c=h.canvas(), v=h.view(), r=rect(c), x=Math.round(r.left+r.width*.45), y=Math.round(r.top+r.height*.45);
        const [ox,oy]=await wheelOffset(x,y);
        const events=[], seen=new WeakSet();
        const originalZoom=v.zoom, scales=[];
        v.zoom=(...args)=>{originalZoom(...args); scales.push(v.scale());};
        window.__waffleIsWheelNotch=e=>{
          const detent=classify(e);
          if(!seen.has(e)) {
            seen.add(e);
            const at=[e.clientX-r.left,e.clientY-r.top];
            const record={detent, trusted:e.isTrusted, mode:e.deltaMode, delta:e.deltaY, legacy:e.wheelDeltaY, at, world:v.screenToWorld(at)};
            events.push(record);
            queueMicrotask(()=>{record.scaleAfterDispatch=v.scale();});
          }
          return detent;
        };
        const send=async (pixels,dy)=>{
          const n=events.length;
          await post("wheels",{x,y,ox,oy,pixels,dy,dx:0,count:1,ms:35});
          await until(500,()=>events.length>n);
          return events[n];
        };
        try {
          const before=v.camera(), pixel=await send(true,40), after=v.camera();
          const line=await send(false,1);
          const factor=Math.exp(-line?.delta*.008);
          await until(500,()=>Math.abs(v.scale()/after.scale-factor)<1e-6);
          const rest=v.scale(), end=line&&v.worldToScreen(line.world);
          const anchorError=end ? Math.hypot(end[0]-line.at[0],end[1]-line.at[1]) : Infinity;
          const panPixels=(before.cy-after.cy)*after.scale;
          log(pixel?.trusted && line?.trusted && pixel.mode===line.mode && pixel.delta===line.delta && pixel.legacy===line.legacy &&
            !pixel.detent && line.detent && after.scale===before.scale && Math.abs(panPixels+pixel.delta)<.01 && line.scaleAfterDispatch===after.scale &&
            scales.length>0 && (document.visibilityState!=="visible" || scales.length>1) &&
            Math.abs(rest/after.scale-factor)<1e-6 && anchorError<.5,
            "Trusted AppKit line and precise 40 px wheels stay distinct in WebKit on "+kind,{panPixels,anchorError,frames:scales.length,rest,pixel,line});
        } finally { v.zoom=originalZoom; }
      }
    } finally {
      window.__waffleIsWheelNotch=classify;
      C.setPref("camera.animate",animation); C.setPref("mouse.wheel",preset); C.setPref("mouse.zoomAt",zoomAt);
      if(mode===null)document.documentElement.removeAttribute("data-motion");
      else document.documentElement.setAttribute("data-motion",mode);
    }
  }
  async function zoomPath(){
    const h=host(),P=globalThis.AtriumPrefs||await globalThis.AtriumLazy.need("AtriumPrefs"),renderer=P.get?.("display.renderer");
    if(globalThis.__uiProject&&!h.project().documents.some(d=>d.sourceName))await h.replaceProject(Atrium.validate(JSON.parse(globalThis.__uiProject)),{force:true,dirty:false});
    globalThis.AtriumCamera?.setPref?.("camera.animate",false);
    for(const [kind,mode] of [["pcb","auto"],["pcb","2d"],["schematic","2d"]]){
      P.set("display.renderer",mode);await toKind(kind);await cleanup();act("fit");h.redraw();
      if(mode==="auto")await until(6000,()=>globalThis.AtriumCanvasGPU?.stats?.()?.acc?.frames>0);await wait(800);
      const c=h.canvas(),r=rect(c),v=h.view(),x=Math.round(r.left+r.width*.45),y=Math.round(r.top+r.height*.5);
      const start=v.camera(),grab=v.screenToWorld([x-r.left,y-r.top]),frames=[];let on=true;
      const tick=t=>{if(!on)return;const s=v.worldToScreen(grab);frames.push([t,Math.hypot(s[0]-(x-r.left),s[1]-(y-r.top)),v.scale()]);requestAnimationFrame(tick);};requestAnimationFrame(tick);
      const o=await wheelOffset(x,y),W=a=>post("wheels",{x,y,ox:o[0],oy:o[1],dx:0,count:30,ms:8,pixels:true,ctrl:true,...a});
      const s0=v.scale();await W({dy:-4});const s1=v.scale();await frame2();await shot("zoom-"+kind+"-"+mode+"-gesture");
      await wait(600);const s2=v.scale();await shot("zoom-"+kind+"-"+mode+"-rest");note("zoom scales "+[s0,s1,s2,v.scale(),o].join(" "));
      await W({dy:-4});await W({dy:4,count:60});
      await wait(300);on=false;
      const dt=frames.slice(1).map((f,n)=>f[0]-frames[n][0]).sort((a,b)=>a-b),zooms=new Set(frames.map(f=>f[2])).size;
      const out={frames:frames.length,zooms,maxErr:+Math.max(...frames.map(f=>f[1])).toFixed(3),dtP50:+dt[dt.length>>1].toFixed(1),dtP90:+dt[Math.floor(dt.length*.9)].toFixed(1),dtMax:+dt.at(-1).toFixed(1),ratio:v.scale()/start.scale};
      log(out.maxErr<.5&&zooms>20&&Math.abs(out.ratio-1)<1e-6,"Continuous pinch zoom keeps the point under the pointer on every frame: "+kind+" "+mode+(globalThis.__uiProject?" on UI_PROJECT":""),out);
      v.restoreCamera(start);h.redraw();
    }
    P.set("display.renderer",renderer||"auto");
  }
  // Two-finger trackpad scrolling (pixel scroll events, no modifier) pans by exactly the scrolled distance with
  // either wheel preset, on boards and sheets; it never zooms. Pinch is covered by native-pinch and zoom-path.
  async function trackpad(){
    const h=host();globalThis.AtriumCamera?.setPref?.("camera.animate",false);
    const out={};
    for(const kind of ["pcb","schematic"])for(const preset of ["zoom","altium"]){
      await toKind(kind);await cleanup();act("fit");await wait(300);globalThis.AtriumCamera?.setPref?.("mouse.wheel",preset);
      const c=h.canvas(),r=rect(c),v=h.view(),x=Math.round(r.left+r.width*.5),y=Math.round(r.top+r.height*.5),o=await wheelOffset(x,y);
      const seen=[];const rec=e=>seen.push([e.deltaX,e.deltaY,e.deltaMode]);window.addEventListener("wheel",rec,true);
      const a=v.camera();await post("wheels",{x,y,ox:o[0],oy:o[1],dx:-3,dy:-5,count:12,ms:8,pixels:true});await wait(100);
      window.removeEventListener("wheel",rec,true);
      const b=v.camera(),sx=seen.reduce((t,e)=>t+e[0],0),sy=seen.reduce((t,e)=>t+e[1],0);
      const moved=[(a.cx-b.cx)*b.scale,(a.cy-b.cy)*b.scale];
      out[kind+" "+preset]={ok:b.scale===a.scale&&seen.length===12&&Math.abs(moved[0]+sx)<.01&&Math.abs(moved[1]+sy)<.01,moved,scrolled:[sx,sy],modes:[...new Set(seen.map(e=>e[2]))]};
    }
    globalThis.AtriumCamera?.setPref?.("mouse.wheel","zoom");
    const bad=Object.entries(out).filter(([,v])=>!v.ok);
    log(!bad.length,"Two-finger trackpad scrolling pans by the scrolled distance and never zooms (both wheel presets, boards and sheets)",bad.length?Object.fromEntries(bad):out);
  }
  // Negation overlines in WebKit: \RESET (single "\" negation, on by default), R\E\S\E\T\ (per character, both
  // modes) and \\RESET (a literal backslash), on net labels and a port, with Preferences › Schematic › General ›
  // Single "\" negation on and then off. Screenshots: negation-on, negation-off.
  async function negation() {
    await cleanup();
    const h = host(), previous = h.project(), previousId = h.currentId(), P = await AtriumLazy.need("AtriumPrefs"), was = P.get("schematic.singleNegation");
    try {
      const p = Atrium.project("Negation", []), s = p.documents.find(d => d.kind === "schematic");
      [["\\RESET", 0], ["R\\E\\S\\E\\T\\", -6], ["\\\\RESET", -12], ["\\CS_FLASH", -18]].forEach(([text, y]) => s.items.push({id: Atrium.id(), kind: "netlabel", x: 0, y, text}));
      s.items.push({id: Atrium.id(), kind: "port", x: 30, y: 0, text: "\\IRQ", io: "input"}, {id: Atrium.id(), kind: "offsheet", x: 30, y: -10, text: "\\OE"});
      await h.replaceProject(p, {force: true, dirty: false}); h.selectDocument(s.id); await wait(200);
      h.act("fit-objects"); await wait(400);
      P.set("schematic.singleNegation", true); await wait(400); await shot("negation-on");
      const on = AtriumSchAppearance.negation("\\RESET");
      P.set("schematic.singleNegation", false); await wait(400); await shot("negation-off");
      const off = AtriumSchAppearance.negation("\\RESET");
      log(on.all && on.text === "RESET" && !off.bars && off.text === "\\RESET" && !h.isDirty(),
        "the Single \\ negation preference redraws the sheet without touching the design (screenshots negation-on, negation-off)", {on, off});
    } finally {P.set("schematic.singleNegation", was); await h.replaceProject(previous, {force: true, dirty: false}); h.selectDocument(previousId);}
  }
  async function groupIdentity() {
    await AtriumLazy.need("AtriumGroupLibraryUI");
    const local = AtriumGroupLocal, core = AtriumGroupLibrary;
    log(!!globalThis.crypto?.subtle && !!globalThis.indexedDB, "The desktop file origin exposes Web Crypto and IndexedDB");
    const member = await local.member("Fixture reviewer"), info = {id: "native-" + Atrium.id(), name: "Native fixtures"};
    log(!member.localOnly && member.privateKey?.extractable === false, "The desktop profile supplies a non-exportable member key");
    const record = await local.edit(info, async group => {
      const revision = await group.propose({id: "fixture", name: "Bench part", symbol: {pins: [], shapes: []}}, {author: member, note: "First revision"});
      await group.decide(group.preview(revision.key), "approved", member);
      return revision;
    });
    const group = await local.open(info.id), archive = await core.readArchive(core.archive(group));
    log(!member.localOnly && member.privateKey.extractable === false && archive.events.get(record.key)?.author.id === member.id &&
      group.identityStatus(record).status === "known" && group.library().defs.length === 1,
      "The desktop webview stores a non-exportable signing key, approves a revision and verifies its portable history");
  }
  async function shortcutCaps() {
    await focusCanvas();
    act("command-palette");
    const prefix = 'dialog.nav-palette[open] ';
    const nativeKey = (scope, key) => document.querySelector(scope +
      '.ui-shortcut-cap[data-native-shortcut="' + key + '"][data-native-rendered] .native-shortcut-ink');
    const run = prefix + 'button[aria-keyshortcuts="Enter"] ';
    const actions = prefix + 'button[aria-haspopup="menu"] ';
    const ready = await until(3500, () => nativeKey(run,"⏎") && nativeKey(actions,"⌘") && nativeKey(actions,"K"));
    const arrow = nativeKey(run,"⏎"), caps = [...document.querySelectorAll(actions + ".ui-shortcut-cap")];
    const size = arrow?.closest(".ui-shortcut-cap")?.getBoundingClientRect();
    const mask = arrow && (getComputedStyle(arrow).maskImage || getComputedStyle(arrow).webkitMaskImage);
    log(!!ready && size?.height === 20 && mask?.includes("data:image/png") &&
      arrow.closest(".ui-shortcut").querySelector(".shortcut-spoken").textContent === "Return" &&
      caps.map(cap=>cap.dataset.nativeShortcut).join() === "⌘,K",
      "Native palette draws AppKit Return and separate Command and K caps", {mask:mask?.slice(0,28),height:size?.height});
    const offsets = ["⌘","K"].map(k => {
      const ink = nativeKey(actions, k)?.getBoundingClientRect(), cap = nativeKey(actions, k)?.closest(".ui-shortcut-cap")?.getBoundingClientRect();
      return ink && cap ? [ink.x + ink.width / 2 - (cap.x + cap.width / 2), ink.y + ink.height / 2 - (cap.y + cap.height / 2)].map(v => Math.round(v * 100) / 100) : null;
    });
    log(offsets.every(o => o && Math.abs(o[0]) <= 0.5 && Math.abs(o[1]) <= 0.5),
      "Native keycap glyphs are centred in their caps", {offsets});
    await key("Escape");
    act("preferences");
    const unitScope = 'dialog.prf-dialog[open] #prf-general-units-help ';
    const unit = await until(3500, () => nativeKey(unitScope,"Q"));
    const height = unit?.closest(".ui-shortcut-cap")?.getBoundingClientRect().height;
    log(height === 16 && unit.closest(".ui-shortcut").dataset.variant === "inline-keycap",
      "Native unit help draws the actual Q glyph inside a 16 px inline cap", {height});
    await cleanup();
  }
  // Touch input in the real WKWebView host (main.swift EditorWebView, DirectTouchRecognizer). A touch display
  // (macOS 27) hands direct touches to gesture recognizers and emulates a mouse from one finger; other digitisers
  // send a mouse stream with NSEvent subtype touch. Each one-finger drag on blank canvas must pan 1:1 and draw no
  // selection box; a real mouse drag (subtype 0, a button down) must still box-select. Sheet and board, Select tool.
  async function touchBridge(){
    const h=host(),out={},bad=[];
    globalThis.AtriumCamera?.setPref?.("camera.animate",false);
    const pointers=[];document.addEventListener("pointerdown",e=>pointers.push(e.pointerType+(e.isTrusted?"":"*")),true);
    async function run(name,send,expect,keep){
      // keep: a part stays selected; the gesture (on blank canvas) must not change the selection.
      const part=keep?h.doc().items.find(i=>i.kind==="part"):null;
      h.select(part?[part.id]:[]);await wait(60);
      const at=emptyPoint();if(!at){bad.push(name+": no empty point");return;}
      const [x,y]=at,v=h.view(),before=v.camera(),kinds=new Set();pointers.length=0;
      const poll=setInterval(()=>{const d=h.drag();if(d)kinds.add(d.kind+(d.moved?"+":""));},4);
      const reply=await send(x,y);await wait(150);clearInterval(poll);
      const after=v.camera(),moved=[+((before.cx-after.cx)*after.scale).toFixed(2),+((before.cy-after.cy)*after.scale).toFixed(2)];
      const row={view:await post("hitView",{x,y}),moved,zoom:+(after.scale/before.scale).toFixed(3),drags:[...kinds],selection:h.selection().length,pointers:[...pointers],reply};
      if(part&&emptyHitsPart(x,y,part))bad.push(name+" blank point is on the kept part");
      out[name]=row;
      if(keep&&JSON.stringify(row.selectionIds=h.selection())!==JSON.stringify(part?[part.id]:[]))bad.push(name+" selection changed");
      const box=row.drags.some(d=>d.startsWith("box"));
      if(expect==="pan"&&(box||Math.abs(moved[0]-72)>1.5||Math.abs(moved[1]-24)>1.5||Math.abs(row.zoom-1)>.001))bad.push(name);
      if(expect==="box"&&(!row.drags.includes("box+")||Math.hypot(...moved)>.01))bad.push(name);
      if(expect==="zoom"&&(box||Math.abs(row.zoom-2)>.03))bad.push(name);
      if(row.view!=="EditorWebView")bad.push(name+" hit view "+row.view);
      if(reply&&typeof reply==="object"&&reply.decision!=="page")bad.push(name+" decision "+reply.decision);
      v.restoreCamera(before);h.redraw();await wait(60);
    }
    const line=(x,y)=>{const p=[];for(let k=0;k<=12;k++)p.push([x+k*6,y+k*2]);return p;};
    const drag=(subtype,touchDisplay)=>(x,y)=>post("subtypePath",{points:line(x,y),subtype,touchDisplay,ms:12});
    const emptyHitsPart=(x,y,part)=>h.hit(h.canvas(),x,y)?.item?.id===part.id;
    const fingers=(emulate,o={})=>(x,y)=>post("directTouches",{frames:line(x,y).map(p=>[[0,...p]]),emulate,ms:12,...o});
    const spread=(o={})=>(x,y)=>{const f=[];for(let k=0;k<=10;k++)f.push([[1,x-30-k*3,y],[2,x+30+k*3,y]]);return post("directTouches",{frames:f,ms:12,...o});};
    for(const kind of ["schematic","pcb"]){
      await toKind(kind);await cleanup();act("fit");h.setTool("select");await wait(300);
      await run(kind+" real mouse drag",drag(0,false),"box");
      await run(kind+" mouse subtype touch",drag(3,false),"pan");
      await run(kind+" touch display emulated mouse",drag(0,true),"pan");
      await run(kind+" direct touch",fingers(false),"pan");
      await run(kind+" direct touch with emulated mouse",fingers(true),"pan");
      await run(kind+" direct two-finger spread",spread(),"zoom");
      // The hardware (macOS 27.2 touch display): WebKit's own recognizers also turn the fingers into DOM mouse
      // and gesture events, at the same time and place, in either order.
      await run(kind+" direct touch with WebKit mouse, touch first",fingers(false,{webkit:true}),"pan",true);
      await run(kind+" direct touch with WebKit mouse, mouse first",fingers(false,{webkit:true,mouseFirst:true}),"pan",true);
      await run(kind+" direct two-finger spread with WebKit pinch",spread({webkit:true}),"zoom",true);
      await run(kind+" real mouse drag after touch",async(x,y)=>{await wait(400);return drag(0,false)(x,y);},"box");
      await run(kind+" tablet pen drag",drag(1,false),"report");
    }
    // A finger on chrome: the page declines, the recognizer fails and the held emulated click reaches WebKit.
    const tab=[...document.querySelectorAll("#document-tabs [data-tab]")].find(t=>t.dataset.kind==="schematic"&&visible(t));
    if(tab){
      await toKind("pcb");pointers.length=0;const [x,y]=center(tab);
      const r=await post("directTouches",{frames:[[[0,x,y]]],emulate:true,ms:12});await wait(300);
      out["chrome tap"]={reply:r,pointers:[...pointers],kind:h.doc().kind};
      if(r?.decision!=="declined"||h.doc().kind!=="schematic")bad.push("chrome tap");
    }
    const diag=await post("inputDiagnostics");
    const routes=new Set((diag?.rows||[]).map(r=>r.route));
    out.diagnostics={routes:[...routes],sources:[...new Set((diag?.rows||[]).map(r=>r.source))]};
    note("touch bridge "+JSON.stringify(out));
    log(!bad.length,"Touch display fingers, emulated mouse and subtype-touch mouse streams pan 1:1 with no selection box; two fingers zoom; a real mouse drag still box-selects; a finger on chrome still clicks (sheet and board)",bad.length?{bad,out}:out);
    // Help › Troubleshooting › Input Diagnostics lists the host's events and what the touch scheme took.
    act("input-diagnostics");
    const panel=await until(4000,()=>document.querySelector("dialog.input-diagnostics-dialog[open]"));
    if(panel){const at=emptyPoint();if(at)await fingers(false)(...at);}
    const textOk=await until(3000,()=>{const t=panel?.querySelector("textarea")?.value||"";return /Host events/.test(t)&&/touch scheme/.test(t)&&/taken/.test(t)&&t;});
    log(!!panel&&!!textOk&&!document.querySelector("dialog[open]:modal"),"Input Diagnostics opens beside the canvas (not modal) and lists host events, their routes and what the touch scheme took",(textOk||panel?.querySelector("textarea")?.value||"no panel").slice(0,1200));
    panel?.close();
    // Harness mouse events carry no physical button state, so within the host's half-second after a finger
    // they would read as that finger's emulated mouse: let it pass before the next probe clicks.
    await wait(700);
  }
  async function step(name, f) {
    try {await f();} catch (e) {log(false, name + " probe ran", String(e?.stack || e).slice(0, 400));}
  }
  // Every top-level menu title renders with the same font: size, weight, letter-spacing and glyph box,
  // idle, hovered and open, in light and dark (beta: "File" looked smaller than "Edit").
  async function menuTitles() {
    await toKind("pcb"); await cleanup();
    const metrics = () => [...document.querySelectorAll(".menubar .work-menu > summary")].filter(visible).map(s => {
      const c = getComputedStyle(s), r = document.createRange(); r.selectNodeContents(s);
      const g = r.getBoundingClientRect(), ctx = document.createElement("canvas").getContext("2d");
      ctx.font = c.fontWeight + " " + c.fontSize + " " + c.fontFamily;
      const t = ctx.measureText("Hx");
      return {name: s.textContent.trim(), font: [c.fontSize, c.fontWeight, c.letterSpacing, c.fontFamily, c.fontStretch, c.transform, c.zoom, c.webkitTextSizeAdjust || ""].join("|"),
        glyph: [g.height, t.actualBoundingBoxAscent.toFixed(2), (ctx.measureText(s.textContent).width / s.textContent.length).toFixed(2)], width: Math.round(g.width * 100) / 100,
        left: rect(s).left, scale: rect(s).height / (s.offsetHeight || 1)};
    });
    const out = {}, scaled = await post("ink-raster-scale", {scale: 2});
    for (const theme of ["light", "dark"]) {
      act("theme-" + theme); await wait(250);
      const file = document.querySelector('.work-menu[data-menu="file"]');
      const states = {idle: metrics()};
      const [x, y] = center(file.querySelector("summary"));
      await mouse(x, y, {kind: "move"}); await wait(120); states.hover = metrics();
      await shot("menu-titles-hover-" + theme);
      const opened = await openTop(file);
      log(opened, "File stays open for the menu-title measurement (" + theme + ")");
      await wait(120); states.open = metrics();
      if (opened) {
        await shot("menu-titles-open-" + theme);
        await key("Escape");
        await until(1000, () => !file.open);
      }
      await cleanup();
      out[theme] = states;
      for (const [state, list] of Object.entries(states)) {
        const fonts = new Set(list.map(m => m.font)), glyphs = new Set(list.map(m => m.glyph[0] + "/" + m.glyph[1])), scaled = list.filter(m => Math.abs(m.scale - 1) > .001);
        // The same pixel phase for every title: WebKit rounds the boxes in ui/whole-pixels.js (no calc-size()).
        const phase = new Set(list.map(m => (((m.left % 1) + 1) % 1).toFixed(3)));
        log(list.length > 5 && fonts.size === 1 && glyphs.size === 1 && !scaled.length && phase.size === 1, "every top-level menu title renders with identical font metrics on the same pixel phase (" + theme + ", " + state + ")", {fonts: [...fonts], glyphs: [...glyphs], scaled, phase: [...phase]});
      }
    }
    note("menu titles (" + (scaled ? "2x" : "1x") + " shots) " + JSON.stringify(out.light.idle.map(m => [m.name, m.font.split("|").slice(0, 3).join(" "), m.glyph, m.left, m.width])));
    if (scaled) await post("ink-raster-scale", {scale: 0});
    act("theme-dark"); await wait(150); await cleanup();
  }
  // WebKit has no calc-size(), so ui/whole-pixels.js rounds content-sized chrome up instead: menu titles,
  // document tabs, dock tabs and context menus have whole-pixel edges, so every label after the first
  // starts on a whole pixel, and no label is cut short.
  async function wholePixelChrome() {
    await toKind("pcb"); await cleanup();
    act("nets-panel"); await wait(300);
    const tab = [...document.querySelectorAll("#document-tabs [data-tab]")].find(visible);
    await mouse(...center(tab), {button: "right"});
    const menu = await until(2000, ctxMenu); await wait(200);
    const families = [".menubar .work-menu > summary", "#document-tabs .document-tab", ".dock-tab-wrap", ".dock-tab", ".nav-menu"];
    const found = families.map(sel => [...document.querySelectorAll(sel)].filter(visible).map(el => {
      const r = rect(el), label = el.matches(".document-tab") ? el.querySelector("span") : el;
      return {sel, name: el.textContent.trim().slice(0, 24), x: r.left, width: r.width, cut: !el.matches(".nav-menu") && label.scrollWidth > label.clientWidth};
    }));
    const all = found.flat(), bad = all.filter(m => !Number.isInteger(m.x) || !Number.isInteger(m.width) || m.cut);
    const calcSize = CSS.supports("inline-size", "calc-size(max-content, size)");
    log(!!menu && found.every(list => list.length) && !bad.length, "menu titles, document and dock tabs and context menus sit on whole pixels with full labels" +
      (calcSize ? " (calc-size)" : " (rounded by AtriumWholePixels)"), bad.length ? bad : {measured: all.length, rounder: !!globalThis.AtriumWholePixels});
    if (menu) {await key("Escape"); await until(800, () => !document.body.contains(menu));}
    act("nets-panel"); await cleanup();
  }
  async function dockPanels() {
    await toKind("pcb"); await cleanup();
    const dock = await AtriumLazy.need("AtriumDock");
    const right = document.getElementById("properties");
    const strip = () => right.querySelector(".dock-tabs:not([hidden])");
    const button = () => strip()?.querySelector(".dock-tab-more");
    const tabs = () => [...strip().querySelectorAll(".dock-tab")];
    const menuNames = () => [...document.querySelectorAll(".menubar .work-menu > summary")].filter(visible).map(el => el.textContent.trim());
    const edge = rect(document.getElementById("workbench")).right, names = menuNames();
    log(rect(right).right === edge && !document.querySelector(".panel-rail") && names[0] === "File" && names.at(-1) === "Help",
      "Properties reaches the window edge and the app menus end after Help", names);
    const initial = AtriumTheme.get(), opened = [];
    try {
      const more = await until(2000, () => visible(button()) && button());
      const bounds = more && rect(more);
      log(!!bounds && bounds.width === 24 && bounds.height === 24 && rect(strip()).right - bounds.right === 4,
        "the dock ends in a 24 px Panels button before any tabs overflow", bounds);
      if (!more) return;
      for (const [id, action] of [["nets","nets-panel"],["messages","messages"],["pcb-list","pcb-list"],["library","library-panel"],["filter","query-panel"]]) {
        if (dock.panels().some(p => p.id === id && p.open)) continue;
        act(action);
        if (await until(3000, () => dock.panels().some(p => p.id === id && p.open))) opened.push(id);
      }
      dock.reveal("nets");
      for (const [preset,density] of [["light","default"],["dark","default"],["light","comfortable"]]) {
        AtriumTheme.set({preset,density,followSystem:false,motion:"off"},{persist:false});
        const tag = preset + "-" + density;
        await wait(150);
        const shown = tabs().filter(visible), hidden = tabs().filter(t => !visible(t)).map(t => t.textContent.trim());
        const stripEnd = rect(button()).left;
        const clipped = shown.filter(t => t.scrollWidth > t.clientWidth || rect(t.parentElement).right > stripEnd).map(t => t.textContent.trim());
        log(hidden.length > 0 && !clipped.length && shown.some(t => t.dataset.dockTab === "nets" && t.getAttribute("aria-selected") === "true"),
          "visible dock tabs retain full labels and the active tab stays in view (" + tag + ")", {hidden,clipped});
        await mouse(Math.round(innerWidth / 2), Math.round(innerHeight / 2), {kind:"move"});
        await shot("dock-tabs-" + tag);
        await clickEl(button());
        const menu = await until(2000, () => visible(ctxMenu()) && ctxMenu());
        if (!menu) {log(false, "Panels button opens the shared menu (" + tag + ")"); continue;}
        await wait(100);
        const entries = [...menu.querySelectorAll(":scope > :is(hr,[role^=menuitem])")].map(el => ({
          label:el.tagName === "HR" ? "-" : el.textContent.trim(), checked:el.getAttribute("aria-checked"), role:el.getAttribute("role"),
          x:el.firstElementChild ? rect(el.firstElementChild).left - rect(el).left : null
        }));
        const overflow = entries.slice(0,hidden.length + 1).map(r => r.label);
        const labels = entries.filter(r => r.role);
        const checked = labels.filter(r => r.checked === "true").map(r => r.label);
        log(JSON.stringify(overflow) === JSON.stringify([...hidden,"-"]) && checked.includes("Nets") &&
          labels.some(r => r.checked === "false") && new Set(labels.map(r => r.x)).size === 1 && Number.isInteger(rect(menu).left) && Number.isInteger(rect(menu).width),
          "the dock menu starts with the hidden tabs and aligns checked and unchecked labels (" + tag + ")", entries);
        await shot("dock-menu-" + tag);
        await key("Escape");
        await until(800, () => !visible(menu));
      }
    } finally {
      await cleanup();
      for (const id of opened) {dock.reveal(id); await wait(30); dock.toggle(id);}
      dock.reveal("properties");
      AtriumTheme.set({preset:initial.preset,density:initial.density,followSystem:initial.followSystem,motion:initial.motion},{persist:false});
    }
  }
  const PROBES = [
    ["css", css], ["menu-titles", menuTitles], ["whole-pixels", wholePixelChrome], ["dock-panels", dockPanels], ["menus", async () => {for (const k of ["pcb", "schematic"]) await menus(k);}],
    ["context", async () => {for (const k of ["pcb", "schematic"]) await contextMenus(k);}], ["surfaces", surfaces], ["negation", negation], ["group-identity", groupIdentity],
    ["dialogs", dialogs], ["shortcut-caps", shortcutCaps], ["sticky", sticky], ["tints", tints], ["mask", maskIcon], ["filter", filterPanel], ["navigator", navigator_],
    ["highlight", netHighlight], ["camera", camera], ["view3d",view3DControls], ["native-pinch",nativePinch], ["pan-path",panPath], ["zoom-path",zoomPath], ["trackpad",trackpad], ["touch-bridge",touchBridge], ["wheel-notch",wheelNotch], ["schematic-edit",schematicEditing], ["escape",escapeAll], ["choosers", choosers], ["power", powerPort], ["whatsnew", whatsNew], ["themes", themeShots]];
  async function run(only = "") {
    const want = new Set(String(only).split(",").map(s => s.trim()).filter(Boolean));
    if (!await boot(!want.size || want.has("onboarding"))) return {passed, failed};
    for (const [name, f] of PROBES) if (!want.size || want.has(name)) await step(name, f);
    log(!errors.length, "no page errors while the probes ran", errors.slice(0, 15));
    return {passed, failed, failures};
  }
  return {run, log, mouse, key, until, pointOn, netPoint, emptyPoint, seen};
})();
