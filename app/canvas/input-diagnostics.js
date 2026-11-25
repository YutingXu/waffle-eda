"use strict";
// Help › Troubleshooting › Input Diagnostics: what this computer's mouse, trackpad, touch display or pen
// sends, for a bug report about touch or pointer behaviour. A small panel that stays open beside the
// canvas (not modal), so the user can touch, click and scroll while it lists the latest 20 events:
//   host   the macOS app's AppKit events: NSEvent type and subtype, the source it was classified as
//          (mouse or trackpad, touch, pen) and where it went (WebKit, the touch scheme, dropped);
//   page   the pointer events the canvas saw: pointerType, trusted or forwarded by the host, and whether
//          the touch scheme (canvas-input.js) took them, with the editor's drag at that moment.
// Nothing is sent anywhere: the text stays in the panel until the user copies it.
globalThis.AtriumInputDiagnostics = (() => {
  const LIMIT = 20;
  let open = null;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const pad = (s, n) => String(s).padEnd(n) + " ";

  // One row per event; repeated moves and wheel steps of the same kind fold into a count.
  function pageRecorder() {
    const rows = [];
    return {rows, trace(e, taken, pane) {
      if (!pane && !(e.target instanceof HTMLCanvasElement)) return;
      const host = e.pointerId >= 1e6 && !e.isTrusted, drag = globalThis.AtriumNavHost?.drag?.()?.kind || "";
      const row = {type: e.type, pointer: e.pointerType || "", from: host ? "host touch" : e.isTrusted ? "WebKit" : "page", taken: !!taken, drag, count: 1};
      const last = rows.at(-1);
      if (last && last.type === row.type && last.pointer === row.pointer && last.from === row.from && last.taken === row.taken) {
        last.count++; last.drag = drag || last.drag; return;
      }
      rows.push(row); if (rows.length > LIMIT) rows.shift();
    }};
  }
  function text(host, page) {
    const out = ["Waffle input diagnostics (" + new Date().toISOString() + ")", navigator.userAgent];
    if (host) {
      out.push("", "macOS " + host.os + ". Screens: " + (host.screens || []).map(s => s.name + (s.touch ? " (touch display)" : s.touch === false ? " (no touch)" : "")).join(", "));
      out.push("", "Host events (newest last)");
      for (const r of host.rows || []) out.push("  " + pad(r.event + (r.count > 1 ? " ×" + r.count : ""), 28) + pad(r.source, 26) + pad("→ " + r.route, 30) + r.detail);
      if (!host.rows?.length) out.push("  none yet");
    } else out.push("", "Host events: not available in this browser (the macOS app lists them).");
    out.push("", "Canvas pointer events (newest last; taken = the touch scheme handled it)");
    for (const r of page) out.push("  " + pad(r.type + (r.count > 1 ? " ×" + r.count : ""), 22) + pad(r.pointer || "-", 8) + pad(r.from, 12) + pad(r.taken ? "taken" : "not taken", 11) + (r.drag ? "drag " + r.drag : ""));
    if (!page.length) out.push("  none yet: touch, click or drag on a sheet or board");
    return out.join("\n");
  }
  function show() {
    if (open?.isConnected) { open.querySelector("textarea")?.focus(); return open; }
    const d = el("dialog", null, "input-diagnostics-dialog"), title = el("h2", "Input Diagnostics");
    const detail = el("p", "Touch, click, drag and scroll on a sheet or board while this stays open. It lists the latest 20 events and where each went. Nothing leaves this computer until you copy it.");
    const log = el("textarea", null, "diagnostics-log ui-field"), foot = el("div", null, "work-actions");
    log.readOnly = true; log.rows = 18; log.wrap = "off"; log.setAttribute("aria-label", "Input events");
    log.style.cssText = "font:var(--fs-11)/1.35 var(--mono);inline-size:min(880px,calc(100vw - 48px));white-space:pre";
    const page = pageRecorder(), bridge = globalThis.AtriumHost?.inputDiagnostics;
    let host = null, timer = 0, frozen = false;
    const button = (label, run, variant) => { const b = el("button", label); b.type = "button"; b.onclick = run; if (variant) b.dataset.variant = variant; return b; };
    const pause = button("Pause", () => { frozen = !frozen; pause.textContent = frozen ? "Resume" : "Pause"; });
    const copy = button("Copy", async () => {
      try { await navigator.clipboard.writeText(log.value); } catch { log.focus(); log.select(); document.execCommand?.("copy"); }
      globalThis.AtriumNavHost?.info?.("Input diagnostics copied");
    });
    const close = button("Close", () => d.close(), "primary");
    foot.append(pause, copy, close);
    d.append(title, detail, log, foot);
    globalThis.AtriumShell?.adoptDialog?.(d, {title, body: [detail, log], actions: foot, initialFocus: close});
    // Bottom right, clear of the canvas centre; the editor stays usable underneath.
    d.style.cssText = "position:fixed;inset:auto 16px 16px auto;margin:0;z-index:50";
    const paint = () => { if (!frozen) log.value = text(host, page.rows); };
    const poll = async () => {
      if (!d.isConnected) return;
      if (bridge && !frozen) { try { host = await bridge(); } catch { host = null; } }
      paint(); timer = setTimeout(poll, 250);
    };
    globalThis.__waffleInputTrace = page.trace;
    d.onclose = () => { clearTimeout(timer); if (globalThis.__waffleInputTrace === page.trace) delete globalThis.__waffleInputTrace; d.remove(); open = null; };
    document.body.append(d); d.show(); open = d; poll();
    return d;
  }
  globalThis.AtriumNavHost?.registerAction?.("input-diagnostics", show);
  return {show, text};
})();
