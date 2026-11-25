"use strict";
// The ODB++ output card in File › Release (butter.odb).
// The card is the existing Fabrication output card (release-ui.js): switch, title, state chip, preview,
// file list and summary ("Design 8.1 · 15 layers · 1 step"). This module adds three lines under the
// summary, all library status lines so nothing becomes a box inside the card:
//   - while it runs: the indeterminate progress row with elapsed time (board and panel archives);
//   - when it cannot run: why (no PCB, no closed board shape, ODB++ turned off, worker unavailable)
//     with the one action that fixes it;
//   - after it runs: what the archive approximated, a Fidelity report… button, and the receipt
//     (SHA-256 and size) that Release records.
globalThis.AtriumODBCard = (() => {
  const G = globalThis;
  let K = null;
  const ready = G.AtriumLazy.need("AtriumUIKit").then(kit => { K = kit; return kit; });
  const plural = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);
  const size = n => n == null ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
  const timers = new WeakMap();

  function slot(entry) {
    let n = entry.node.querySelector(":scope > .odb-lines");
    if (!n) {
      n = document.createElement("div");
      n.className = "odb-lines";
      entry.summary.after(n);
    }
    return n;
  }
  function stop(entry) { clearInterval(timers.get(entry)); timers.delete(entry); }

  // Generation in progress. The output worker reports start and done only, so the bar is indeterminate
  // and the value counts elapsed seconds once the wait passes a second.
  function busy(entry, {panel} = {}) {
    if (!K) return;
    stop(entry);
    const row = K.progress({label:panel ? "Writing the panel archive" : "Writing the ODB++ archive"}), started = performance.now();
    slot(entry).replaceChildren(row);
    timers.set(entry, setInterval(() => {
      const s = Math.floor((performance.now() - started) / 1000);
      if (s >= 1) row.set(null, s + " s");
    }, 500));
  }

  // Why the archive could not be written, and the one action that fixes it.
  function problem(row, project) {
    const text = [row.message, ...(row.warnings || [])].join(" ");
    const board = project?.documents?.find(d => d.kind === "pcb");
    if (/disabled in Experimental features|Enable ODB\+\+ output/i.test(text))
      return {key:"disabled", text:"ODB++ is turned off in Experimental features.", action:["Experimental features…", "labs"]};
    if (!board || /no PCB layout/i.test(text))
      return {key:"no-board", text:"This project has no PCB. ODB++ needs a board or a panel.", action:["Add PCB…", "add-pcb"]};
    if (/closed board shape|board outline|board shape|profile cutout/i.test(text))
      return {key:"no-outline", text:row.message || "Define a closed board shape before exporting ODB++.", action:["Board shape…", "board-shape"]};
    if (/worker|No worker/i.test(text))
      return {key:"worker", text:"The output worker is unavailable. Other outputs are unaffected.", action:["Try again", "retry"]};
    if (row.status === "error" || row.status === "failed") return {key:"error", text:row.message || "ODB++ output failed."};
    return null;
  }

  function line(text, tone, actions = []) {
    const n = K.statusLine(text, {tone});
    for (const a of actions) n.append(a);
    return n;
  }

  // The translator's fidelity report: kept, approximated and dropped counts by object kind.
  function totals(report) {
    const t = {kept:0, approximated:0, dropped:0, kinds:[]};
    for (const k of report?.kinds ?? []) {
      t.kept += k.kept; t.approximated += k.approximated; t.dropped += k.dropped;
      if (k.approximated || k.dropped) t.kinds.push(k);
    }
    return t;
  }
  const kindName = kind => String(kind || "").replace(/^./, c => c.toUpperCase());

  function reportDialog(report, label) {
    const table = document.createElement("table");
    table.className = "ui-table";
    const head = table.createTHead().insertRow();
    for (const name of ["Object kind", "Kept", "Approximated", "Dropped"]) { const th = document.createElement("th"); th.textContent = name; head.append(th); }
    const body = table.createTBody();
    for (const k of report.kinds ?? []) {
      const tr = body.insertRow();
      const th = document.createElement("th"); th.scope = "row"; th.textContent = kindName(k.kind); tr.append(th);
      for (const key of ["kept", "approximated", "dropped"]) {
        const td = tr.insertCell(); td.className = "is-number"; td.textContent = String(k[key]);
        if (key !== "kept" && k[key]) td.dataset.state = key === "dropped" ? "error" : "stale";
      }
    }
    const notes = (report.notes ?? []).slice(0, 12).map(n => {
      const p = document.createElement("p"); p.className = "ui-section-note"; p.textContent = typeof n === "string" ? n : n.message || n.reason || ""; return p;
    });
    const reasons = (report.kinds ?? []).flatMap(k => (k.references ?? []).filter(r => r.status !== "kept" && r.reason).slice(0, 1)
      .map(r => K.propRow(kindName(k.kind), r.reason)));
    const sections = [K.section("By object kind", {quiet:true}, table)];
    if (reasons.length) sections.push(K.section("Approximations", {}, ...reasons));
    if (notes.length) sections.push(K.section("Translator notes", {}, ...notes));
    const d = G.AtriumShell.dialog({title:"Fidelity report", label:"ODB++ fidelity report", className:"odb-report",
      body:[K.statusLine(label), ...sections], actions:[{label:"Close", primary:true, default:true}]});
    d.showModal();
    return d;
  }

  // After a run: the reason it could not run, or fidelity and receipt.
  function fill(entry, row, {project, act, retry} = {}) {
    if (!K) { ready.then(() => fill(entry, row, {project, act, retry})); return; }
    stop(entry);
    const lines = [], issue = row.status === "ok" || row.status === "warning" ? null : problem(row, project);
    if (issue) {
      const [label, action] = issue.action ?? [];
      const button = label && K.button(label, {variant:"quiet", size:"sm", run:() => action === "retry" ? retry?.() : act?.(action)});
      lines.push(line(issue.text, issue.key === "error" || issue.key === "worker" ? "danger" : "warning", button ? [button] : []));
      entry.node.dataset.odb = issue.key;
      entry.summary.textContent = ""; // the line below says it once, with its fix
    } else if (row.status === "ok" || row.status === "warning") {
      delete entry.node.dataset.odb;
      // The archive is binary: say what it holds instead of drawing its bytes as text.
      if (entry.thumb) entry.thumb.replaceChildren(K.empty({text:(row.summary || "ODB++ Design 8.1") + ". Open the archive in your CAM viewer to inspect it.", centred:true}));
      const report = row.translationReports?.[0], t = totals(report);
      if (report) {
        const open = K.button("Fidelity report…", {variant:"quiet", size:"sm",
          run:() => reportDialog(report, row.summary || "ODB++ Design 8.1")});
        const text = t.approximated || t.dropped
          ? [t.approximated && plural(t.approximated, "approximation"), t.dropped && t.dropped + " dropped"].filter(Boolean).join(" · ") +
            ": " + t.kinds.map(k => kindName(k.kind).toLowerCase()).join(", ")
          : "Everything kept";
        lines.push(line(text, t.dropped ? "warning" : t.approximated ? "info" : "success", [open]));
      }
      const archive = (row.files || []).find(f => typeof f === "object" && /\.tgz$/i.test(f.name));
      if (archive?.sha256) {
        const code = document.createElement("code");
        code.className = "ui-code ui-selectable";
        code.textContent = archive.sha256.slice(0, 12) + "…";
        code.title = "SHA-256 " + archive.sha256;
        const receipt = K.statusLine("Receipt · " + size(archive.bytes));
        receipt.append(code);
        lines.push(receipt);
      }
    }
    slot(entry).replaceChildren(...lines);
  }

  function clear(entry) { stop(entry); entry.node.querySelector(":scope > .odb-lines")?.remove(); }

  return Object.freeze({ready, busy, fill, clear, problem, reportDialog});
})();
