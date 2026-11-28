"use strict";
// Document views (app/project/doc-views.js): a non-document tab (the Rules and Constraints Editor) over a pane's canvas,
// with its tab in the document strip, or in its pane's strip while split; choosing a document in that pane
// shows the canvas again; closing the second pane moves its view to the first; × closes it.
const assert = require("node:assert/strict");
const {loadDOM} = require("../integration/integration.cjs");
(async () => {
  const {parseHTML} = await loadDOM();
  const {window, document} = parseHTML('<html><body><div id="editor-area"><div id="document-tabs"><div class="document-tab" data-tab="sch">S</div><div class="document-tab" data-tab="pcb">B</div></div>' +
    '<div id="canvas-stage"><canvas id="c1"></canvas></div><div id="canvas-stage-2"><canvas id="c2"></canvas></div></div></body></html>');
  Object.assign(globalThis, {window, document});
  let ps = [{canvas: document.getElementById("c1"), active: true}];
  const listeners = {};
  globalThis.AtriumNavHost = {panes: () => ps, canvas: () => ps.find(p => p.active).canvas};
  require("../../app/editor/nav-common.js");
  globalThis.AtriumNavCommon.ready = f => f({on: (ev, fn) => { (listeners[ev] ||= []).push(fn); }});
  require("../../app/project/doc-views.js");
  const V = globalThis.AtriumDocViews;
  let closed = 0, mounted = 0;
  const box = V.open("rules", {title: "Rules and Constraints", mount: el => { mounted++; el.append(document.createElement("dialog")); }, onClose: () => { closed++; }});
  assert.equal(box.parentElement.id, "canvas-stage", "over the active pane's canvas");
  const tab = document.querySelector('#document-tabs .view-tab[data-view="rules"]');
  assert.ok(tab && tab.getAttribute("aria-selected") === "true" && !box.hidden);
  const icon = tab.querySelector("svg.icon"), use = icon.firstElementChild;
  assert.equal(icon.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.equal(use.namespaceURI, icon.namespaceURI);
  assert.equal(use.getAttribute("href"), "#i-book");
  assert.ok(document.querySelector('[data-tab="pcb"]').classList.contains("is-under-view"));
  V.open("rules", {mount: () => { mounted++; }});
  assert.equal(mounted, 1, "an open view is shown, not mounted again");
  // A document tab in its pane shows the canvas; the view's tab stays.
  document.querySelector('[data-tab="pcb"]').dispatchEvent(new window.Event("click", {bubbles: true}));
  assert.ok(box.hidden && tab.isConnected && tab.getAttribute("aria-selected") === "false");
  tab.dispatchEvent(new window.Event("click", {bubbles: true}));
  assert.equal(box.hidden, false);
  // A document chosen elsewhere (the Explorer, a shortcut) does the same.
  listeners.document.forEach(f => f()); assert.ok(box.hidden); V.show("rules");
  // Split: the view's tab moves to its pane's strip; the other pane is untouched.
  ps = [{canvas: document.getElementById("c1"), active: false}, {canvas: document.getElementById("c2"), active: true}];
  for (const [k, id] of [[0, "canvas-stage"], [1, "canvas-stage-2"]]) { const s = document.createElement("div"); s.className = "pane-tabs"; s.dataset.pane = String(k); const x = document.createElement("button"); x.className = "pane-close"; s.append(x); document.getElementById(id).prepend(s); }
  V.decorate();
  assert.equal(tab.parentElement.dataset.pane, "0", "in the first pane's strip");
  assert.equal(tab.nextSibling.className, "pane-close", "before the pane's close button");
  assert.equal(document.body.classList.contains("document-view-active"), false, "the active pane still displays a document");
  V.hide("rules");
  const second = V.open("compare", {title: "Compare"});
  assert.equal(second.parentElement.id, "canvas-stage-2", "a view opens in the active pane");
  assert.equal(document.querySelector('.view-tab[data-view="compare"]').parentElement.dataset.pane, "1");
  // The second pane closes: its view moves to the first, over the canvas there.
  ps = [{canvas: document.getElementById("c1"), active: true}];
  for (const s of document.querySelectorAll(".pane-tabs")) s.remove();
  V.decorate();
  assert.equal(second.parentElement.id, "canvas-stage");
  assert.ok(document.body.classList.contains("document-view-active"), "the moved view immediately hides board-only controls");
  assert.equal(document.querySelector('.view-tab[data-view="compare"]').parentElement.id, "document-tabs");
  // A project switch asks every view; one that keeps its work keeps the project.
  assert.equal(V.mayDiscard(), true, "views without work to lose let a switch go");
  let keep = true, asked = 0, kept = 0;
  V.open("editor", {title: "Editor", mayDiscard: () => { asked++; return !keep; }, keep: () => { kept++; }});
  V.open("other", {title: "Other", mayDiscard: () => true, keep: () => { kept++; }});
  assert.equal(V.mayDiscard(), false);
  assert.equal(kept, 2, "a refusal tells every view the switch stopped");
  keep = false;
  assert.equal(V.mayDiscard(), true);
  assert.equal(asked, 2);
  V.keep(); assert.equal(kept, 4);
  V.close("other");
  V.close("editor");
  // × closes the view and runs its clean-up.
  tab.querySelector(".view-tab-close").dispatchEvent(new window.Event("click", {bubbles: true}));
  assert.ok(!V.isOpen("rules") && !tab.isConnected && !box.isConnected && closed === 1);
  console.log("doc-views ok");
})().catch(e => { console.error(e); process.exitCode = 1; });
