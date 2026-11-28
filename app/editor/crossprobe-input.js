"use strict";
// Admit canvas shortcuts immediately. The geometry and menus load on the first gesture.
AtriumNavCommon.ready(host => {
  const C = AtriumNavCommon;
  C.menuItem("tools", "cross-probe", "Cross Probe", {after:"drc", separator:true});
  C.menuItem("tools", "cross-select", "Cross Select Mode", {after:"cross-probe", checkable:true});
  const enabled = C.crossSelectEnabled();
  C.setChecked("cross-select", enabled);
  const onCanvas = e => e.target?.tagName === "CANVAS" && !!e.target.closest?.("#editor-panes");
  const load = () => AtriumLazy.need("AtriumCrossProbe");
  const failed = error => host.info(error.message);
  function use(hit, run, valid = () => true) {
    const owner = host.doc();
    const probe = globalThis.AtriumCrossProbe;
    if (probe) { run(probe); return; }
    load().then(X => {
      if (host.doc() === owner && (!hit?.doc || host.docById(hit.doc.id) === hit.doc) && valid()) run(X);
    }, failed);
  }
  if (enabled) load().catch(failed);

  document.addEventListener("dblclick", e => {
    if (e.defaultPrevented || !onCanvas(e) || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const hit = host.hit(e.target, e.clientX, e.clientY);
    use(hit, X => X.doubleClick(hit));
  });

  // Alt+click highlights the net in place; Alt+drag still pans.
  let alt = null, menuRequest = 0;
  document.addEventListener("pointerdown", e => {
    alt = onCanvas(e) && e.altKey && e.button === 0 ? {x:e.clientX, y:e.clientY, c:e.target} : null;
    menuRequest++;
    globalThis.AtriumCrossProbe?.closeMenuIfOutside(e.target);
  }, true);
  document.addEventListener("pointerup", e => {
    const a = alt; alt = null;
    if (a && e.altKey && Math.hypot(e.clientX - a.x, e.clientY - a.y) < 4) {
      const hit = host.hit(a.c, a.x, a.y);
      use(hit, X => X.highlightHit(hit));
    }
  }, true);

  // The editor ends any route or tool before the select-mode context menu opens.
  document.addEventListener("contextmenu", e => {
    if (!onCanvas(e) || (e.ctrlKey && e.button === 0) || host.tool() !== "select") return;
    const {clientX, clientY, target: returnFocus} = e, request = ++menuRequest;
    const hit = host.hit(returnFocus, clientX, clientY);
    if (hit?.item && !host.selection().includes(hit.item.id) && hit.doc.id === host.currentId())
      host.select([hit.item.id], null, {afterMenu:!!globalThis.AtriumCrossProbe && !!globalThis.AtriumContextMenu});
    use(hit, X => X.openMenu(clientX, clientY, {
      target: hit?.item ? X.targetAt(hit.doc, host.defs(), hit.item, hit.point) : null,
      returnFocus, hit, clientX, clientY, pointer:true
    }), () => menuRequest === request && returnFocus.isConnected && host.tool() === "select");
  });
});
