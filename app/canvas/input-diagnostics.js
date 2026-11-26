"use strict";
// Help › Troubleshooting › Input Diagnostics: what this computer's mouse, trackpad, touch display or pen
// sends. A small panel that stays open beside the
// canvas (not modal), so the user can touch, click and scroll while it lists the latest 20 events:
//   host   the macOS app's AppKit events: NSEvent type and subtype, the source it was classified as
//          (mouse or trackpad, touch, pen) and where it went (WebKit, the touch scheme, dropped);
//   page   the pointer events the canvas saw: pointerType, trusted or forwarded by the host, and whether
//          the touch scheme (canvas-input.js) took them.
// The share action opens the standard report preview.
globalThis.AtriumInputDiagnostics = (() => {
  const LIMIT = 20;
  let open = null;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const pad = (s, n) => String(s).padEnd(n) + " ";
  const known = (value, values) => values.includes(value) ? value : "other";
  const counted = n => Number.isSafeInteger(n) && n > 1 ? " ×" + Math.min(n, 1000) : "";
  const POINTER_EVENTS = ["pointerdown", "pointerup", "pointermove", "pointercancel", "pointerleave",
    "pointerout", "pointerenter", "lostpointercapture", "wheel"];
  const POINTER_TYPES = ["", "mouse", "touch", "pen"];
  const PAGE_SOURCES = ["host touch", "WebKit", "page"];
  const HOST_EVENTS = ["leftMouseDown", "leftMouseDragged", "leftMouseUp", "mouseMoved", "rightMouseDown", "otherMouseDown",
    "scrollWheel", "scrollWheel momentum", "pinch", "rotate", "tabletProximity", "WebKit touch recognizers",
    "NSTouch began", "NSTouch moved", "NSTouch ended", "NSTouch cancelled"];
  const HOST_SOURCES = ["host", "mouse or trackpad", "pen or tablet", "touch", "touch (direct)", "touch (mouse subtype)",
    "touch (emulated mouse)", "trackpad or Magic Mouse", "precise wheel", "mouse wheel", "trackpad"];
  const HOST_ROUTES = ["-", "WebKit", "WebKit wheel", "WebKit gesture", "WebKit (not on a canvas)", "deciding",
    "touch scheme", "dropped: fingers already on the canvas", "dropped: a finger never hovers"];

  // One row per event; repeated moves and wheel steps of the same kind fold into a count.
  function pageRecorder() {
    const rows = [];
    return {rows, trace(e, taken, pane) {
      if (!pane && !(e.target instanceof HTMLCanvasElement)) return;
      const host = e.pointerId >= 1e6 && !e.isTrusted;
      const row = {type: known(e.type, POINTER_EVENTS), pointer: known(e.pointerType || "", POINTER_TYPES),
        from: host ? "host touch" : e.isTrusted ? "WebKit" : "page", taken: !!taken, count: 1};
      const last = rows.at(-1);
      if (last && last.type === row.type && last.pointer === row.pointer && last.from === row.from && last.taken === row.taken) {
        last.count = Math.min(last.count + 1, 1000); return;
      }
      rows.push(row); if (rows.length > LIMIT) rows.shift();
    }};
  }
  function text(host, page) {
    const out = ["Waffle input diagnostics"];
    if (host) {
      out.push("", "Host events (newest last)");
      const rows = Array.isArray(host.rows) ? host.rows.slice(-LIMIT) : [];
      for (const r of rows) out.push("  " + pad(known(r?.event, HOST_EVENTS) + counted(r?.count), 28) +
        pad(known(r?.source, HOST_SOURCES), 26) + "→ " + known(r?.route, HOST_ROUTES));
      if (!rows.length) out.push("  none yet");
    } else out.push("", "Host events: not available in this browser (the macOS app lists them).");
    out.push("", "Canvas pointer events (newest last; taken = the touch scheme handled it)");
    for (const r of page.slice(-LIMIT)) out.push("  " + pad(known(r?.type, POINTER_EVENTS) + counted(r?.count), 22) +
      pad(known(r?.pointer || "", POINTER_TYPES) || "-", 8) + pad(known(r?.from, PAGE_SOURCES), 12) + (r?.taken === true ? "taken" : "not taken"));
    if (!page.length) out.push("  none yet: touch, click or drag on a sheet or board");
    return out.join("\n");
  }
  function show() {
    if (open?.open) { open.querySelector("textarea")?.focus(); return open; }
    const d = el("dialog", null, "input-diagnostics-dialog"), title = el("h2", "Input Diagnostics");
    const detail = el("p", "Touch, click, drag and scroll on a sheet or board to see the latest 20 events and how they were handled.");
    const log = el("textarea", null, "diagnostics-log ui-field"), foot = el("div", null, "work-actions");
    log.readOnly = true; log.rows = 18; log.wrap = "off"; log.setAttribute("aria-label", "Input events");
    log.style.cssText = "font:var(--fs-11)/1.35 var(--mono);inline-size:min(880px,calc(100vw - 48px));white-space:pre";
    const page = pageRecorder(), bridge = globalThis.AtriumHost?.inputDiagnostics;
    let host = null, timer = 0, fetching = false, frozen = false, stopped = false;
    const button = (label, run, variant) => { const b = el("button", label); b.type = "button"; b.onclick = run; if (variant) b.dataset.variant = variant; return b; };
    const pause = button("Pause", () => {
      frozen = !frozen;
      pause.textContent = frozen ? "Resume" : "Pause";
      clearTimeout(timer);
      if (!frozen) poll();
    });
    const share = button("Preview shareable report…", () => {
      closePanel();
      globalThis.AtriumNavHost?.act?.("crash-diagnostics");
    });
    const close = button("Close", closePanel, "primary");
    foot.append(pause, share, close);
    d.append(title, detail, log, foot);
    globalThis.AtriumShell?.adoptDialog?.(d, {title, body: [detail, log], actions: foot, initialFocus: close});
    // Bottom right, clear of the canvas centre; the editor stays usable underneath.
    d.style.cssText = "position:fixed;inset:auto 16px 16px auto;margin:0;z-index:50";
    /** @param {"start" | "read"} [operation] */
    const poll = async (operation = "read") => {
      if (stopped || frozen || fetching || !d.open) return;
      fetching = true;
      try { if (bridge) host = await bridge(operation); } catch { host = null; }
      finally { fetching = false; }
      if (stopped || frozen || !d.open) return;
      log.value = text(host, page.rows);
      timer = setTimeout(poll, 250);
    };
    async function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      if (globalThis.__waffleInputTrace === page.trace) delete globalThis.__waffleInputTrace;
      try { await bridge?.("stop"); } catch { /* older or closed host */ }
    }
    function closePanel() {
      stop();
      d.close();
    }
    globalThis.__waffleInputTrace = page.trace;
    d.addEventListener("beforetoggle", event => { if (event.newState === "closed") stop(); });
    d.onclose = () => { stop(); d.remove(); if (open === d) open = null; };
    document.body.append(d); d.show(); open = d; poll("start");
    return d;
  }
  globalThis.AtriumNavHost?.registerAction?.("input-diagnostics", show);
  return {show, text};
})();
