"use strict";
// WebKit probes run in the editor page. Only the harness records observations/screenshots.
// All project reads, Git operations, edits and saves below go through the installed desktop host.
globalThis.__uiProbes = {async run() {
  const h = AtriumNavHost, expected = globalThis.probeInput, results = {};
  const query = selector => document.querySelector(selector);
  const nodes = selector => [...document.querySelectorAll(selector)];
  const post = (op, args = {}) => webkit.messageHandlers.harness.postMessage({op, ...args});
  const check = async (ok, name, detail) => {
    await post("log", {ok: !!ok, name, detail});
    if (!ok) throw Error(name + " · " + JSON.stringify(detail));
  };
  async function until(fn, message, ms = 60000) {
    const at = performance.now();
    while (performance.now() - at < ms) {
      const value = fn();
      if (value) return value;
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error(message + " · " + [query("#status")?.textContent, query(".blame-line")?.textContent,
      query("dialog[open]")?.innerText?.slice(0, 350)].filter(Boolean).join(" · "));
  }
  const action = name => {
    const item = query('.menubar [data-action="' + name + '"]'), menu = item.closest("details");
    if (!menu.open) menu.querySelector(":scope > summary").click();
    const sub = item.closest(".submenu");
    if (sub && !sub.classList.contains("open")) sub.querySelector(":scope > .submenu-trigger").click();
    if (!item.getClientRects().length || document.querySelector("dialog[open]")) throw Error("Menu action is not visible: " + name);
    item.click();
  };
  const button = (selector, text) => nodes(selector).find(n => n.textContent.trim() === text);
  const screenshot = async name => {
    await document.fonts.ready;
    await new Promise(r => setTimeout(r, 450));
    await post("shot", {name});
  };
  const historyState = () => globalThis.AtriumHistoryView?.state();
  const historyCommits = () => nodes(".hv-row[data-type=commit]");
  const subjectsOf = () => historyCommits().map(n => n.querySelector(".ui-row-title")?.textContent);
  const selectCommit = rev => {
    const view = AtriumHistoryView.instance();
    for (let i = 0; i < view.state().items; i++) {
      const key = view.keyOf(i);
      if (key?.startsWith(rev)) { view.select(key); return true; }
    }
    return false;
  };
  const commitFields = () => nodes(".hv-details [data-history-field]").map(row =>
    [row.dataset.historyField, row.querySelector("del")?.textContent, row.querySelector("ins")?.textContent]);
  const commitHashes = () => historyCommits().map(n => n.dataset.key.slice(0, 7));
  const closeHistory = () => AtriumHistoryView.close();
  const hideNames = () => {
    for (const e of nodes(".hv-who, .hv-byline-name, #inspector .blame-who")) e.style.visibility = "hidden";
  };
  const compareHistory = async () => (await until(() => button(".hv-detail-actions button","Compare"), "Find the first-parent Compare")).click();
  const positionsAt = (revisions, field) => {
    const pairs = [];
    for (const rev of revisions) {
      selectCommit(rev);
      const value = commitFields().find(row => row[0] === field);
      if (value) pairs.push(value.slice(1));
    }
    return pairs;
  };
  const sheet = h.project().documents.find(d => d.kind === "schematic");
  const select = ref => {
    h.selectDocument(sheet.id);
    const id = h.doc().items.find(i => i.ref === ref).id;
    h.select([id], id);
  };
  try {
    if (["source", "source-warning", "kicad"].includes(expected.phase)) {
      await check(AtriumHost.historyPath === (expected.name || "maxout_conn.PrjPcb") && !AtriumHost.projectPath && !AtriumHost.baseToken,
        "The original source opens with read-only history and no native save target");
    } else await check(h.project().name === "SNES-Tap", "The native window opened the imported design", h.project().name);
    await AtriumTheme.set({preset: "light"}, {persist: false});
    if (expected.phase === "history") {
      select("J1");
      let at = performance.now();
      action("file-history");
      await until(() => historyState()?.commits === expected.subjects.length && !historyState().more, "Read file history");
      results.fileHistoryMs = Math.round(performance.now() - at);
      const subjects = subjectsOf();
      await check(JSON.stringify(subjects) === JSON.stringify(expected.subjects), "File History exactly matches git log for the saved file", subjects);
      await screenshot("file-history");
      historyCommits().at(-1).click(); await compareHistory();
      await until(() => globalThis.AtriumDiffView?.session()?.metrics.diffDone, "Compare the first native import with its parent");
      const initial = AtriumDiffView.session();
      await check(initial.b.missing && initial.a.project.documents.reduce((n, d) => n + d.items.length, 0) === 210,
        "Previous on the first native version displays an empty parent and the actual 210 imported objects");
      query(".dv-close").click();
      closeHistory();
      if (document.body.classList.contains("hide-right")) h.act("toggle-right");
      const who = await until(() => button("#inspector .blame-show", "Show history"), "Find the Properties history link");
      at = performance.now(); who.click();
      await until(() => !query("#inspector .blame-line")?.textContent.match(/Reading|Searching|Show history/), "Read the last author");
      results.blameMs = Math.round(performance.now() - at);
      const blame = query("#inspector .blame-line").textContent;
      await check(blame.includes(expected.revisions[0]) && blame.includes("by Codex"), "Who changed this identifies the last design change on J1", blame);
      query("#inspector .blame-link").click();
      await until(() => historyState()?.objectHits === expected.revisions.length && commitHashes().length === expected.revisions.length, "Finish J1 history");
      const hashes = commitHashes();
      await check(JSON.stringify(hashes) === JSON.stringify(expected.revisions), "J1 has the three imported design revisions, in Git order", hashes);
      const positions = positionsAt(expected.revisions, "X");
      await check(JSON.stringify(positions) === JSON.stringify([[String(expected.xs[1]), String(expected.xs[2])], [String(expected.xs[0]), String(expected.xs[1])]]),
        "J1's X coordinates agree with the published schematic revisions", positions);
      await screenshot("object-history");
      closeHistory();
      select("C2");
      const comment = await until(() => query('#inspector input[aria-label="Comment"]'), "Find the editable component comment");
      comment.value = "22p"; comment.dispatchEvent(new Event("change", {bubbles:true}));
      await until(() => h.doc().items.find(i => i.ref === "C2").value === "22p", "Apply the unsaved edit");
      const tab = query('#document-tabs [data-tab="' + sheet.id + '"]');
      const box = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", {bubbles:true, cancelable:true, button:2, clientX:box.x + 10, clientY:box.y + 8}));
      const withHead = await until(() => nodes('.nav-menu button, .dv-menu button').find(b => /Compare With HEAD/i.test(b.textContent)), "Find Compare With HEAD");
      at = performance.now(); withHead.click();
      await until(() => globalThis.AtriumDiffView?.session()?.metrics.diffDone, "Compare the working design");
      results.compareMs = Math.round(performance.now() - at);
      const rows = nodes(".dv-row");
      const changes = [];
      for (const row of rows) {
        row.click();
        const value = nodes(".dv-props tr").find(n => ["Value", "Comment"].includes(n.firstChild?.textContent));
        if (value) changes.push([row.textContent, ...[...value.children].slice(1).map(n => n.textContent)]);
      }
      await check(rows.length === 2 && changes.some(([s, b, a]) => s.includes("C1") && b === "10p" && a === "15p")
        && changes.some(([s, b, a]) => s.includes("C2") && b === "10p" && a === "22p"),
        "Compare With HEAD shows both the uncommitted file edit and the separate unsaved inspector edit", changes);
      await screenshot("compare-working");
      action("undo");
      const refresh = await until(() => button(".dv-outdated button", "Refresh comparison"), "Invalidate the edited working side on Undo");
      await check(!query(".dv-row"), "Undo removes the stale comparison before showing updated geometry");
      refresh.click();
      await until(() => globalThis.AtriumDiffView?.session()?.metrics.diffDone, "Compare after Undo");
      await check(nodes(".dv-row").length === 1 && query(".dv-row").textContent.includes("C1"), "After Undo only the disk edit remains", nodes(".dv-row").map(r => r.textContent));
      query(".dv-close").click();
      action("git-merge-driver");
      const setup = await until(() => nodes(".gp-confirm button").find(b => b.textContent === "Set Up" && !b.disabled), "Read the merge driver setup plan");
      setup.click();
      await until(() => query(".gp-confirm .gp-status")?.textContent.startsWith("Done."), "Install the merge driver in this clone");
      query(".gp-confirm").close();
      const shared = h.doc().id;
      const files = await AtriumHost.openRecent({path: expected.sibling});
      const opened = h.openFiles(files);
      const replace = await until(() => nodes(".message-dialog button").find(b => ["Don’t Save", "Replace project"].includes(b.textContent)), "Confirm Open here");
      replace.click(); await opened;
      await check(h.project().name === "SNES-Tap previous" && h.project().documents.some(d => d.id === shared)
        && AtriumHost.projectPath === expected.sibling, "Open here binds a different saved copy with the same document IDs");
      action("undo");
      await until(() => h.project().name === "SNES-Tap", "Undo Open");
      await check(!AtriumHost.projectPath && !AtriumHost.baseToken, "Undo Open detaches the other file and its native write token");
      const saved = h.saveProject();
      const panel = await post("cancelSavePanel");
      await check(panel && await saved === false, "Save asks for a destination after Undo Open and respects cancellation");
    } else if (expected.phase === "source-warning") {
      action("file-history");
      const row = await until(() => historyCommits().find(n => n.querySelector(".ui-row-title")?.textContent === expected.subject),
        "Find the missing-library source commit");
      row.click(); await compareHistory();
      const notice = await until(() => query(".dv-source-notice"), "Show the missing historical library notice in Compare");
      await check(notice.textContent === "1 referenced library unavailable", "File History Compare preserves the historical source library warning");
    } else if (expected.phase === "kicad") {
      const pcb = h.project().documents.find(d => d.kind === "pcb");
      h.selectDocument(pcb.id);
      const part = pcb.items.find(i => i.ref === expected.ref);
      await check(part?.kicadSourceId === expected.sourceId, "The live Lily58 placement retains its Git source identifier");
      h.select([part.id], part.id);
      if (document.body.classList.contains("hide-right")) h.act("toggle-right");
      const who = await until(() => button("#inspector .blame-show", "Show history"), "Find KiCad attribution");
      const at = performance.now(); who.click();
      const credit = await until(() => {
        const text = query("#inspector .blame-line")?.textContent; return text && !/Reading|Searching|Show history/.test(text) && text;
      }, "Read the original KiCad attribution");
      results.blameMs = Math.round(performance.now() - at);
      await check(credit.includes(expected.latest) && credit.includes("by " + expected.author), "The renamed KiCad board credits the actual upstream placement change", credit.replace(expected.author, "the Git author"));
      query("#inspector .blame-link").click();
      await until(() => historyState()?.objectHits > 0 && commitHashes().length, "Finish KiCad object history");
      const latest = commitHashes()[0]; selectCommit(latest);
      const rows = commitFields();
      await check(latest === expected.latest &&
        expected.coordinates.every(row => rows.some(r => r.join() === row.join())), "J10's X and Y match the two original board records", rows.filter(r => r[0] === "X" || r[0] === "Y"));
      await check(!query('.hv-row[data-key="working"]') && !commitHashes().includes(expected.rename), "An unchanged placement receives no working or rename attribution");
      hideNames();
      for (const e of nodes(".hv-row .ui-row-title, .hv-detail-title")) e.textContent = e.textContent.replace(/^(Merge pull request #\d+) from .+$/, "$1");
      await screenshot("kicad-object-history");
      closeHistory();
      const field = await until(() => query('#inspector input[aria-label="Comment"]'), "Find the KiCad placement comment");
      field.value = "Edited J10"; field.dispatchEvent(new Event("change", {bubbles:true}));
      (await until(() => button("#inspector .blame-show", "Show history"), "Recheck the edited placement")).click();
      await until(() => query("#inspector .blame-line")?.textContent.includes("Not committed: Value"), "Show the real uncommitted KiCad edit");
      await check(!AtriumHost.projectPath, "A genuine editor change stays uncommitted and keeps the KiCad source read-only");
      const unknown = pcb.items.find(i => !i.kicadSourceId);
      await check(!!unknown, "The public board contains an item without a retained source identifier");
      h.select([unknown.id], unknown.id);
      (await until(() => button("#inspector .blame-show", "Show history"), "Find ambiguous KiCad member")).click();
      await until(() => query("#inspector .blame-line")?.textContent.includes("Object history is ambiguous"), "Report the uncertain identity");
      await check(!query("#inspector .blame-who"), "An unidentifiable source item receives no invented author");
    } else if (expected.phase === "source") {
      select("J1");
      const at = performance.now();
      action("file-history");
      await until(() => query(".hv-foot")?.textContent.includes(expected.commitCount + " first-parent commits checked"), "Filter all original source commits");
      results.fileHistoryMs = Math.round(performance.now() - at);
      const subjects = subjectsOf();
      await check(JSON.stringify(subjects) === JSON.stringify(expected.subjects), "Source File History matches the five original commits touching the Altium directory", subjects.length);
      // The fixture's public author names are kept out of the shared screenshots.
      hideNames();
      await screenshot("upstream-file-history");
      closeHistory();
      if (document.body.classList.contains("hide-right")) h.act("toggle-right");
      const who = await until(() => button("#inspector .blame-show", "Show history"), "Find source object blame");
      const blameAt = performance.now(); who.click();
      await until(() => !query("#inspector .blame-line")?.textContent.match(/Reading|Searching|Show history/), "Read the original source author");
      results.blameMs = Math.round(performance.now() - blameAt);
      const credit = query("#inspector .blame-line").textContent;
      await check(credit.includes("by " + expected.author) && credit.includes(expected.revisions[0]), "Who changed this matches the public commit and its Git author", expected.revisions[0]);
      query("#inspector .blame-link").click();
      await until(() => historyState()?.objectHits === expected.revisions.length && commitHashes().length === expected.revisions.length, "Finish source object history");
      const ids = commitHashes();
      await check(JSON.stringify(ids) === JSON.stringify(expected.revisions), "Original J1 history includes both additions, the deletion and two modifications", ids);
      const xs = positionsAt(expected.revisions, "X");
      await check(JSON.stringify(xs) === JSON.stringify([[String(expected.xs[1]), String(expected.xs[2])], [String(expected.xs[0]), String(expected.xs[1])]]), "Original commit blobs yield the same two design moves", xs);
      // Omit names from the shared screenshot. The unmodified attribution was checked above.
      hideNames();
      await screenshot("upstream-object-history");
      closeHistory();
      select("C1");
      const comment = await until(() => query('#inspector input[aria-label="Comment"]'), "Find a source component comment");
      comment.value = "18p"; comment.dispatchEvent(new Event("change", {bubbles:true}));
      const pending = await until(() => button("#inspector .blame-show", "Show history"), "Find source attribution after editing");
      pending.click();
      await until(() => query("#inspector .blame-line")?.textContent.includes("Not committed: Value"), "Show the unsaved source value edit");
      await check(!AtriumHost.projectPath, "A source edit appears as uncommitted and keeps the source read-only");
    } else {
      select("C1");
      const at = performance.now();
      action("merge-conflicts");
      await until(() => nodes(".mg-row").length, "Read the three Git stages");
      results.mergeViewMs = Math.round(performance.now() - at);
      await check(nodes(".mg-row").length === 1 && query(".mg-row strong").textContent.includes("C1"), "The merge view lists only the C1 conflict", query(".mg-row").textContent);
      const row = nodes(".mg-dialog tr").find(r => r.firstChild?.textContent === "value");
      const stages = [...(row?.children || [])].slice(1).map(n => n.textContent);
      await check(JSON.stringify(stages) === JSON.stringify(expected.stageValues), "Base, Ours and Theirs match all three Git stage blobs", stages);
      const automatic = nodes(".mg-auto-text").map(n => n.textContent);
      await check(automatic.length === 2 && automatic.some(s => s.includes("C3")) && automatic.some(s => s.includes("C4")),
        "Independent changes to C3 and C4 merged automatically", automatic);
      query(".mg-auto").open = true;
      await screenshot("merge-conflict");
      button(".mg-take-btn", "Take Theirs").click();
      button(".mg-dialog button", "Apply to Editor").click();
      const value = ref => h.project().documents.find(d => d.kind === "schematic").items.find(i => i.ref === ref).value;
      await until(() => ["C1", "C3", "C4"].map(value).join() === "18p,27p,33p", "Apply the chosen resolution");
      await check(await h.saveProject(), "File Save writes the resolved design through the native bridge");
    }
    await post("save", {name:"evidence.json", text:JSON.stringify(results)});
    return results;
  } catch (error) {
    await post("log", {ok:false, name:"Public Git workflow", detail:String(error.message || error)});
  }
}};
